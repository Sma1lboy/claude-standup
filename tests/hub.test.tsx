import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MountTarget } from 'claude-code/testing'

import { shortTitle, sourceLabel, turnRepo } from '../hooks/source'
import { withFeedClaim } from '../hooks/feed-claim'
import type { Card, Task } from '../types'
import { DEFAULT_SETTINGS, readSettings, STALE_MS, SUMMARY_GAP_MS, cardKey, looksLikeSecret, newItems, readSummary, replyKey, staleKeys, summaryPrompt, recentFeed, overlapsFeed, feedGapPassed, feedGroups, snapshotOf, parseSummary } from '../hooks/hub'

// Standup end to end against the engine's own test host: one session ("self")
// plus other sessions seeded straight into the shared store.

const NOW = 10_000_000
const SURFACES = ['terminal', 'desktop'] as const

type Calls = {
  submitted: string[]
  focused: (boolean | undefined)[]
  opened: string[]
  status: (string | undefined)[]
  run: string[][]
  models: string[]
  prompts: string[]
  tools: string[]
  commands: string[]
}

type Opts = {
  surfaces?: ('terminal' | 'desktop')[]
  entries?: Record<string, unknown>
  host?: string
  cwd?: string
  repo?: { root: string; remote: string | null; internal: boolean; name: string | null } | null
  messages?: import('claude-code').SessionMessage[]
  git?: (argv: readonly string[], cwd?: string) => { exitCode: number; stdout: string }
  model?: (model: string, prompt: string) => { isAnswered: true; text: string } | { isAnswered: false; reason: 'api-error'; status: number; error: string }
  // What a prompt.submit returns; the default lets every prompt in.
  submit?: (text: string) => { text: string } | { drop: string } | Promise<{ text: string } | { drop: string }>
}

function stub(on: On, opts: Opts = {}) {
  const calls: Calls = { submitted: [], focused: [], opened: [], status: [], run: [], models: [], prompts: [], tools: [], commands: [] }
  const clock = mock.clock(on, { now: NOW })
  // The shared store, as a map the test can read and other "sessions" can write.
  // Tests read the English copy; the settings test switches to Chinese itself.
  const store = new Map<string, unknown>(Object.entries({ settings: { lang: 'en' }, ...opts.entries }))
  on('store.get', ($, e) => ({ value: structuredClone(store.get(e.key)) }))
  on('store.set', ($, e) => {
    store.set(e.key, structuredClone(e.value))
    return { value: undefined }
  })
  on('store.delete', ($, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.env(on, opts.host ? { CLAUDE_CODE_HOST_SESSION_ID: opts.host } : {})
  const session = mock.session(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['desktop'] }))
  on('session.id', () => ({ value: 'self' }))
  on('session.cwd', () => ({ value: opts.cwd ?? '/work/alpha' }))
  on('session.repo', () => ({ value: opts.repo ?? null }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.messages', () => ({ value: opts.messages ?? [{ role: 'user', text: 'ship the login page', toolUses: [] }] }))
  on('command.register', ($, e) => {
    calls.commands.push(e.name)
    return { value: { command: e.name } }
  })
  on('tool.register', ($, e) => {
    calls.tools.push(e.name)
    return { value: { tool: e.name } }
  })
  on('ui.status', ($, e) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  on('ui.open', ($, e) => {
    calls.opened.push(e.id)
    calls.focused.push(e.focus)
    return { value: { isPlaced: true } }
  })
  on('ui.log', () => ({ value: undefined }))
  on('prompt.submit', async ($, e) => {
    calls.submitted.push(e.text)
    return (await opts.submit?.(e.text)) ?? { text: e.text }
  })
  on('process.run', ($, e) => {
    if (e.argv[0] === 'git') return { value: { ...(opts.git?.(e.argv, e.init?.cwd) ?? { exitCode: 128, stdout: '' }), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    calls.run.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('model.complete', ($, e) => {
    calls.models.push(e.model)
    calls.prompts.push(e.prompt)
    const reply = opts.model?.(e.model, e.prompt) ?? { isAnswered: true as const, text: '{"milestones":[],"authorized":[]}' }
    return { value: { ...reply, usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } as never }
  })
  return { calls, clock, session, store }
}

const start = ($: Engine) => $.session.start({ cwd: '/work/alpha', surface: 'terminal', isInteractive: true })

const assign = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: 'mcp__standup__assign_task', tool_use_id: `tu-${Math.random()}`, ...input } as never)

const pane = <S extends (typeof SURFACES)[number]>(surface: S, requestId = 'standup'): MountTarget<S, 'Pane'> =>
  ({
    plugin: 'standup',
    surface,
    component: 'Pane',
    requestId,
    viewport: { columns: 90, rows: 40 },
    props: { title: 'Standup', isFocused: true, bodyColumns: 88, placement: 'dock', scroll: { offset: 0, bodyRows: 40 } },
  }) as MountTarget<S, 'Pane'>

const otherCard = (over: Partial<Card> = {}): Card => ({
  sid: 'other',
  hostId: 'local_other',
  name: 'beta',
  cwd: '/work/beta',
  heartbeat: NOW,
  tasks: [{ id: 't1', kind: 'answer', title: 'Which region should prod use?', createdAt: NOW - 1000 }],
  feed: [],
  ...over,
})

const textOf = (found: unknown) => (found as { text?: string } | undefined)?.text


test('joining opens the hub once without taking focus, even with task auto-open off', async ($, on) => {
  const { calls, clock } = stub(on, { entries: { settings: { lang: 'en', autoOpen: false } } })
  await start($)
  expect(calls.opened).toEqual(['standup'])
  expect(calls.focused).toEqual([undefined])

  // Closing a pane is engine-owned; subsequent hooks must not request another open.
  const ui = await $.ui.mount(pane('desktop'))
  await ui.unmount()
  await clock.advance(6_000)
  await $.turn.complete({ answer: 'Done' } as never)
  await start($)
  expect(calls.opened).toEqual(['standup'])
})

test('openOnStart false leaves the hub closed on join and later polls', async ($, on) => {
  const { calls, clock } = stub(on, { entries: { settings: { lang: 'en', openOnStart: false } } })
  await start($)
  await clock.advance(6_000)
  expect(calls.opened).toEqual([])
})

test('old and missing settings default openOnStart to on', () => {
  expect(DEFAULT_SETTINGS.openOnStart).toBe(true)
  expect(readSettings(undefined).openOnStart).toBe(true)
  expect(readSettings({ lang: 'en', autoOpen: false }).openOnStart).toBe(true)
  expect(readSettings({ openOnStart: false }).openOnStart).toBe(false)
})

test('assign_task puts a task on the panel, on every surface', async ($, on) => {
  const { calls, store } = stub(on)
  await start($)
  expect(calls.tools).toEqual(['assign_task', 'withdraw_task', 'list_tasks'])
  expect(calls.commands).toEqual(['standup', 'standup-settings'])

  const res = await assign($, { kind: 'do', title: 'Add STRIPE_KEY to .env.local', detail: 'The test key from the Stripe dashboard.' })
  expect(String(res.result)).toContain('Assigned task')
  const card = (store.get(cardKey('self'))) as Card
  expect(card.tasks.map(t => t.title)).toEqual(['Add STRIPE_KEY to .env.local'])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: 'Add STRIPE_KEY to .env.local' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /To do 1/ })).toBeDefined()
    await ui.unmount()
  }
  expect(calls.status.at(-1)).toBeUndefined()
})

test('assign_task refuses bad input, duplicates and a sixth open task', async ($, on) => {
  const { store } = stub(on)
  await start($)
  expect((await assign($, { kind: 'pick', title: 'x' })).deny).toContain('kind')
  expect((await assign($, { kind: 'choose', title: 'DB?', options: ['pg'] })).deny).toContain('2 to 4')

  await assign($, { kind: 'do', title: 'Rotate the deploy key' })
  const again = await assign($, { kind: 'do', title: 'rotate the  deploy key!' })
  expect(String(again.result)).toContain('Already assigned')

  for (let i = 0; i < 4; i++) await assign($, { kind: 'do', title: `Task number ${i}` })
  const sixth = await assign($, { kind: 'do', title: 'One too many' })
  expect(sixth.deny).toContain('5 open tasks')
})

test('parallel assign_task calls still respect duplicates and the cap of five', async ($, on) => {
  const { store } = stub(on)
  await start($)
  await Promise.all([assign($, { kind: 'do', title: 'Approve the build' }), assign($, { kind: 'do', title: 'approve the build!' })])
  expect(((store.get(cardKey('self'))) as Card).tasks.length).toBe(1)
  await Promise.all(['a', 'b', 'c', 'd', 'e', 'f'].map(x => assign($, { kind: 'do', title: `Task ${x}` })))
  expect(((store.get(cardKey('self'))) as Card).tasks.length).toBe(5)
})

test('withdraw_task and list_tasks', async ($, on) => {
  const { store } = stub(on)
  await start($)
  await assign($, { kind: 'choose', title: 'Which database?', options: ['Postgres', 'SQLite'] })
  const card = (store.get(cardKey('self'))) as Card
  const id = card.tasks[0]!.id

  const listed = await $.tool.call({ tool: 'mcp__standup__list_tasks', tool_use_id: 'l1' } as never)
  expect(String(listed.result)).toContain('Postgres / SQLite')

  expect((await $.tool.call({ tool: 'mcp__standup__withdraw_task', tool_use_id: 'w0', id: 'nope' } as never)).deny).toContain('No open task')
  const res = await $.tool.call({ tool: 'mcp__standup__withdraw_task', tool_use_id: 'w1', id } as never)
  expect(String(res.result)).toContain(`Withdrew task ${id}`)
  expect(((store.get(cardKey('self'))) as Card).tasks).toEqual([])
})

test("answering another session's task writes its reply key and hides the task", async ($, on) => {
  const { store } = stub(on, { entries: { [cardKey('other')]: otherCard() } })
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: 'Which region should prod use?' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /beta/ })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'expand-other:t1' })
  await ui.input({ key: 'ans-other:t1', text: 'us-east-1' })
  expect(store.get(replyKey('other', 't1'))).toEqual({ answer: 'us-east-1', at: NOW, by: 'self' })
  expect(await ui.find({ type: 'Text', text: 'Which region should prod use?' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing is waiting/ })).toBeDefined()
})

for (const surface of SURFACES) {
  for (const kind of ['do', 'choose', 'answer'] as const) {
    test(`Skip on ${surface} hides another session's ${kind} task everywhere`, async ($, on) => {
      const task: Task = { id: 't1', kind, title: 'No longer needed task', options: kind === 'choose' ? ['A', 'B'] : undefined, createdAt: NOW }
      const { calls, store } = stub(on, { entries: { [cardKey('other')]: otherCard({ tasks: [task] }) } })
      await start($)
      const ui = await $.ui.mount(pane(surface))
      await ui.press({ key: 'skip-other:t1' })
      expect(store.get(replyKey('other', 't1'))).toEqual({ answer: 'no longer needed', at: NOW, by: 'self', skipped: true })
      expect(calls.submitted).toEqual([])
      expect(await ui.find({ type: 'Text', text: task.title })).toBeUndefined()
      await ui.unmount()
      for (const target of SURFACES) {
        const panel = await $.ui.mount(pane(target))
        expect(await panel.find({ type: 'Text', text: task.title })).toBeUndefined()
        await panel.unmount()
      }
      // Only the owner changes its card; the shared reply hides it meanwhile.
      expect((store.get(cardKey('other')) as Card).tasks).toEqual([task])
    })
  }
}

for (const kind of ['do', 'choose', 'answer'] as const) {
  test(`a skip from another session delivers the skipped line for a ${kind} task once`, async ($, on) => {
    const task: Task = { id: 't1', kind, title: 'No longer needed task', createdAt: NOW }
    const { calls, clock, store } = stub(on, { entries: {
      [cardKey('self')]: otherCard({ sid: 'self', tasks: [task] }),
      [replyKey('self', 't1')]: { answer: 'no longer needed', at: NOW, by: 'other', skipped: true },
    } })
    await start($)
    expect(calls.submitted).toEqual(['The user skipped task t1 (No longer needed task): no longer needed.'])
    expect(store.get(replyKey('self', 't1'))).toBeUndefined()
    expect((store.get(cardKey('self')) as Card).tasks).toEqual([])
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(pane(surface))
      expect(await ui.find({ type: 'Text', text: task.title })).toBeUndefined()
      await ui.unmount()
    }
    await clock.advance(10_000)
    expect(calls.submitted).toHaveLength(1)
  })
}

// `skipped` is optional on `reply:`, so replies stored before Skip existed keep their meaning.
for (const kind of ['do', 'choose', 'answer'] as const) {
  test(`an old-shape reply still delivers as an answer and a new skip as a skip for a ${kind} task`, async ($, on) => {
    const old: Task = { id: 'old', kind, title: 'Old reply task', options: kind === 'choose' ? ['A', 'B'] : undefined, createdAt: NOW }
    const skip: Task = { id: 'new', kind, title: 'Skipped task', options: kind === 'choose' ? ['A', 'B'] : undefined, createdAt: NOW }
    const { calls, store } = stub(on, { entries: {
      [cardKey('self')]: otherCard({ sid: 'self', tasks: [old, skip] }),
      [replyKey('self', 'old')]: { answer: 'A', at: NOW, by: 'other' },
      [replyKey('self', 'new')]: { answer: 'no longer needed', at: NOW, by: 'other', skipped: true },
    } })
    await start($)
    const answered = {
      do: '[Standup] The user marked your task old as done: "Old reply task".',
      choose: '[Standup] The user chose "A" for your task old: "Old reply task".',
      answer: '[Standup] The user answered your task old ("Old reply task"):\nA',
    }[kind]
    expect([...calls.submitted].sort()).toEqual([answered, 'The user skipped task new (Skipped task): no longer needed.'].sort())
    expect(store.get(replyKey('self', 'old'))).toBeUndefined()
    expect(store.get(replyKey('self', 'new'))).toBeUndefined()
    expect((store.get(cardKey('self')) as Card).tasks).toEqual([])
  })
}

test('past three tasks the rest fold into "+N more", so the summary stays in view', async ($, on) => {
  const tasks = [1, 2, 3, 4, 5].map(i => ({ id: `t${i}`, kind: 'do' as const, title: `Task number ${i}`, createdAt: NOW - 1000 + i }))
  stub(on, { entries: { [cardKey('other')]: otherCard({ tasks }) } })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  expect(await ui.find({ type: 'Text', text: 'Task number 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Task number 4' })).toBeUndefined()
  await ui.press({ key: 'more-tasks' })
  expect(await ui.find({ type: 'Text', text: 'Task number 5' })).toBeDefined()
})

test('an answer that looks like a secret is refused', async ($, on) => {
  const { store } = stub(on, { entries: { [cardKey('other')]: otherCard() } })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'expand-other:t1' })
  await ui.input({ key: 'ans-other:t1', text: 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv' })
  expect(store.get(replyKey('other', 't1'))).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /looks like a secret/ })).toBeDefined()

  expect(looksLikeSecret('ghp_0123456789abcdefghijABCDEFGHIJ')).toBe(true)
  expect(looksLikeSecret('AKIAABCDEFGHIJKLMNOP')).toBe(true)
  expect(looksLikeSecret('password: hunter22')).toBe(true)
  expect(looksLikeSecret('Use us-east-1, and keep the staging DB as it is.')).toBe(false)
})

test('a reply for this session reaches the model as a prompt, once', async ($, on) => {
  const task: Task = { id: 'tq', kind: 'choose', title: 'Which database?', options: ['Postgres', 'SQLite'], createdAt: NOW }
  const mine: Card = { ...otherCard({ sid: 'self', name: 'alpha', hostId: undefined }), tasks: [task] }
  const { calls, clock, store } = stub(on, { entries: { [cardKey('self')]: mine, [replyKey('self', 'tq')]: { answer: 'SQLite', at: NOW, by: 'other' } } })
  await start($)
  expect(calls.submitted).toEqual(['[Standup] The user chose "SQLite" for your task tq: "Which database?".'])
  expect(store.get(replyKey('self', 'tq'))).toBeUndefined()
  expect(((store.get(cardKey('self'))) as Card).tasks).toEqual([])
  await clock.advance(10_000)
  expect(calls.submitted.length).toBe(1)
})

test('a reply whose prompt a hook drops stays until the next turn ends, then is delivered once', async ($, on) => {
  const task: Task = { id: 'tq', kind: 'answer', title: 'Which region?', createdAt: NOW }
  const mine: Card = { ...otherCard({ sid: 'self', name: 'alpha', hostId: undefined }), tasks: [task] }
  let blocked = true
  const { calls, clock, store } = stub(on, {
    entries: { [cardKey('self')]: mine, [replyKey('self', 'tq')]: { answer: 'us-east-1', at: NOW, by: 'other' } },
    submit: text => (blocked ? { drop: 'blocked by another mod' } : { text }),
  })
  await start($)
  expect(calls.submitted.length).toBe(1)
  expect(store.get(replyKey('self', 'tq'))).toBeDefined()
  expect(((store.get(cardKey('self'))) as Card).tasks.map(x => x.id)).toEqual(['tq'])
  // Not retried on every poll: the drop reason would be shown again each time.
  await clock.advance(10_000)
  expect(calls.submitted.length).toBe(1)

  blocked = false
  await $.turn.complete({ answer: 'Done' } as never)
  await clock.advance(3_000)
  const message = '[Standup] The user answered your task tq ("Which region?"):\nus-east-1'
  expect(calls.submitted).toEqual([message, message])
  expect(store.get(replyKey('self', 'tq'))).toBeUndefined()
  expect(((store.get(cardKey('self'))) as Card).tasks).toEqual([])
  await clock.advance(10_000)
  expect(calls.submitted.length).toBe(2)
})

test('a reply is submitted once even when a poll comes due while its submit is still pending', async ($, on) => {
  const task: Task = { id: 'tq', kind: 'do', title: 'Rotate the key', createdAt: NOW }
  const mine: Card = { ...otherCard({ sid: 'self', name: 'alpha', hostId: undefined }), tasks: [task] }
  // The prompt enters only once the running turn lets it: until then the submit is pending.
  let enter = () => {}
  const entered = new Promise<void>(resolve => (enter = resolve))
  const { calls, clock, store } = stub(on, { entries: { [cardKey('self')]: mine }, submit: async text => (await entered, { text }) })
  await start($)
  store.set(replyKey('self', 'tq'), { answer: '', at: NOW, by: 'other' })
  await clock.advance(3_000)
  await clock.advance(3_000)
  await clock.advance(3_000)
  enter()
  await clock.advance(3_000)
  expect(calls.submitted).toEqual(['[Standup] The user marked your task tq as done: "Rotate the key".'])
})

test('Done on a do-task sends a done message', async ($, on) => {
  const { calls, clock, store } = stub(on)
  await start($)
  await assign($, { kind: 'do', title: 'Approve the App Store build' })
  const id = ((store.get(cardKey('self'))) as Card).tasks[0]!.id
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: `done-self:${id}` })
  await clock.advance(3_000)
  expect(calls.submitted).toEqual([`[Standup] The user marked your task ${id} as done: "Approve the App Store build".`])
})

test("a session gone quiet loses its tasks from the panel but keeps its updates", async ($, on) => {
  const feed = [{ id: 'other:f1', kind: 'milestone' as const, text: 'Login page shipped', at: NOW - STALE_MS * 2 }]
  const { store } = stub(on, { entries: { [cardKey('other')]: otherCard({ heartbeat: NOW - STALE_MS - 1, feed }) } })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: 'Which region should prod use?' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Login page shipped/ })).toBeDefined()
})

test('a turn with tools brings a summary; only new milestones become messages', async ($, on) => {
  let round = 0
  const { calls, clock, store } = stub(on, {
    model: () => {
      round += 1
      return round === 1
        ? { isAnswered: true, text: '{"milestones":["Login page works end to end"],"authorized":["Merged MR !42 (memory: may merge)"]}' }
        : { isAnswered: true, text: '{"milestones":["Login page works end to end","Tests green on CI"],"authorized":["Merged MR !42 (memory: may merge)"]}' }
    },
  })
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/work/alpha/a.ts' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  await clock.settle()
  expect(calls.models).toEqual(['haiku'])

  const ui = await $.ui.mount(pane('terminal'))
  // One message per card, newest first, each naming its project.
  expect(await ui.find({ type: 'Text', text: 'Login page works end to end' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Merged MR !42/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Summary 1/ })).toBeDefined()
  expect(await ui.find({ key: 'expand-project-alpha' })).toBeDefined()

  // Another turn within thirty minutes waits; after that, only the new line is added.
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/work/alpha/b.ts' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  expect(calls.models.length).toBe(1)
  await clock.advance(20 * 60_000)
  expect(calls.models.length).toBe(1)
  await clock.advance(10 * 60_000)
  expect(calls.models.length).toBe(2)
  const card = (store.get(cardKey('self'))) as Card
  expect(card.feed.map(f => f.text)).toEqual(['Login page works end to end', 'Tests green on CI'])
})

test('a turn without tools brings no summary', async ($, on) => {
  const { calls, clock, store } = stub(on)
  await start($)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(6 * 60_000)
  expect(calls.models).toEqual([])
})

test("when Haiku is unavailable the session's own model writes the summary; when both fail the panel says so", async ($, on) => {
  let fail = 'haiku'
  const { calls, clock, store } = stub(on, {
    model: model =>
      fail === 'all' || model === fail
        ? { isAnswered: false, reason: 'api-error', status: 404, error: 'not_found_error' }
        : { isAnswered: true, text: '{"milestones":["Ported the CLI"],"authorized":[]}' },
  })
  await start($)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  expect(calls.models).toEqual(['haiku', 'claude-opus-5-5'])
  expect(((store.get(cardKey('self'))) as Card).feed.map(f => f.text)).toEqual(['Ported the CLI'])

  fail = 'all'
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(SUMMARY_GAP_MS + 3_000)
  const ui = await $.ui.mount(pane('terminal'))
  expect(await ui.find({ type: 'Text', text: /Updates paused: API error 404 not_found_error/ })).toBeDefined()
})

test('OK hides a message everywhere; No more like this, once turned on in settings, also mutes its kind in later summaries', async ($, on) => {
  const feed = [
    { id: 'other:f1', kind: 'milestone' as const, text: 'Bumped lodash', at: NOW - 2000 },
    { id: 'other:f2', kind: 'milestone' as const, text: 'Release 2.0 is out', at: NOW - 1000 },
  ]
  const { calls, clock, store } = stub(on, { entries: { [cardKey('other')]: otherCard({ feed, tasks: [] }) } })
  await start($)
  const ui = await $.ui.mount(pane('terminal'))
  await ui.press({ key: 'expand-project-beta' })
  await ui.press({ key: 'ok-other:f2' })
  expect(store.get('ack:other:f2')).toBe(NOW)
  expect(await ui.find({ type: 'Text', text: /Release 2.0/ })).toBeUndefined()

  // Off by default: the button appears only after the setting is turned on.
  expect(await ui.find({ key: 'mute-other:f1' })).toBeUndefined()
  const settings = await $.ui.mount(pane('terminal', 'standup-settings'))
  await settings.press({ key: 'toggle-muteButton-on' })
  await ui.press({ key: 'mute-other:f1' })
  expect(store.get('mute:other:f1')).toEqual({ text: 'Bumped lodash', at: NOW })
  expect(await ui.find({ type: 'Text', text: /Bumped lodash/ })).toBeUndefined()

  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  await clock.advance(SUMMARY_GAP_MS)
  expect(calls.prompts[0]).toContain('- Bumped lodash')
})

test('Mark all read hides every message at once', async ($, on) => {
  const feed = [1, 2, 3].map(i => ({ id: `other:f${i}`, kind: 'milestone' as const, text: `Outcome ${i}`, at: NOW - i * 1000 }))
  const { store } = stub(on, { entries: { [cardKey('other')]: otherCard({ feed, tasks: [] }) } })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'ack-all' })
  expect(['other:f1', 'other:f2', 'other:f3'].every(id => store.get(`ack:${id}`) === NOW)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /Outcome/ })).toBeUndefined()
})

test('in a plain terminal /standup toggles a band above the prompt instead of a pane', async ($, on) => {
  const { calls } = stub(on, { surfaces: ['terminal'], entries: { settings: { lang: 'en', openOnStart: false }, [cardKey('other')]: otherCard() } })
  // What the engine draws in the band when the panel leaves it alone.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await start($)
  const band = { plugin: 'standup', surface: 'terminal', component: 'AbovePrompt', viewport: { columns: 100, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 96, scroll: { offset: 0, bodyRows: 30 } } } as MountTarget<'terminal', 'AbovePrompt'>
  const run = () => $.command.run({ command: 'standup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)

  const closedBefore = await $.ui.mount(band)
  expect(await closedBefore.find({ type: 'Text', text: 'Which region should prod use?' })).toBeUndefined()
  await closedBefore.unmount()

  expect(String((await run()).text)).toContain('opened')
  const open = await $.ui.mount(band)
  expect(await open.find({ type: 'Text', text: 'Which region should prod use?' })).toBeDefined()
  await open.unmount()
  expect(calls.opened).toEqual([])

  expect(String((await run()).text)).toContain('closed')
  const closed = await $.ui.mount(band)
  expect(await closed.find({ type: 'Text', text: 'Which region should prod use?' })).toBeUndefined()
})

test("the open band keeps another mod's band content above the panel", async ($, on) => {
  stub(on, { surfaces: ['terminal'], entries: { [cardKey('other')]: otherCard() } })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['another mod notice'] }))
  await start($)
  const band = { plugin: 'standup', surface: 'terminal', component: 'AbovePrompt', viewport: { columns: 100, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 96, scroll: { offset: 0, bodyRows: 30 } } } as MountTarget<'terminal', 'AbovePrompt'>
  const ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: 'another mod notice' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Which region should prod use?' })).toBeDefined()
})

test('terminal startup opens the band once and respects closing it', async ($, on) => {
  const { calls, clock } = stub(on, { surfaces: ['terminal'] })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await start($)
  const band = { plugin: 'standup', surface: 'terminal', component: 'AbovePrompt', viewport: { columns: 100, rows: 40 }, props: { hasSurvey: false, isWorking: false, maxRows: 30, bodyColumns: 96, scroll: { offset: 0, bodyRows: 30 } } } as MountTarget<'terminal', 'AbovePrompt'>
  const ui = await $.ui.mount(band)
  expect(await ui.find({ type: 'Text', text: 'Nothing is waiting on you.' })).toBeDefined()
  const result = await $.command.run({ command: 'standup', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } } as never)
  expect(String(result.text)).toContain('closed')
  await clock.advance(6_000)
  await $.turn.complete({ answer: 'Done' } as never)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  expect(calls.opened).toEqual([])
})

test('settings: language, auto-open and divider sync through the store', async ($, on) => {
  const { calls, clock, store } = stub(on, { entries: { [cardKey('other')]: otherCard({ tasks: [] }) } })
  await start($)
  await $.command.run({ command: 'standup-settings', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 100 } } as never)
  expect(calls.opened).toContain('standup-settings')

  const settings = await $.ui.mount(pane('terminal', 'standup-settings'))
  await settings.press({ key: 'lang-zh' })
  expect(store.get('settings')).toEqual({ lang: 'zh', openOnStart: true, autoOpen: true, divider: false, muteButton: false, showStatus: false, taskRows: 12 })
  expect(await settings.find({ type: 'Text', text: '语言' })).toBeDefined()
  await settings.press({ key: 'toggle-showStatus-on' })
  await settings.press({ key: 'toggle-autoOpen-off' })
  expect(((store.get('settings')) as { autoOpen: boolean }).autoOpen).toBe(false)

  expect(await settings.find({ type: 'Text', text: '会话开始时自动打开' })).toBeDefined()
  await settings.press({ key: 'toggle-openOnStart-off' })
  expect((store.get('settings') as { openOnStart: boolean }).openOnStart).toBe(false)
  await settings.press({ key: 'toggle-openOnStart-on' })
  expect((store.get('settings') as { openOnStart: boolean }).openOnStart).toBe(true)

  // A task arriving from another session does not open the panel now.
  store.set(cardKey('other'), otherCard())
  await clock.advance(3_000)
  expect(calls.opened.filter(id => id === 'standup')).toEqual(['standup'])
  const hub = await $.ui.mount(pane('desktop'))
  expect(await hub.find({ type: 'Text', text: /待办 1/ })).toBeDefined()
  expect(calls.status.at(-1)).toBe('1 个任务等你 · /standup')
})

test('a task from another session opens the panel when auto-open is on', async ($, on) => {
  const { calls, clock, store } = stub(on, { entries: { settings: { lang: 'en', openOnStart: false } } })
  await start($)
  expect(calls.opened).toEqual([])
  store.set(cardKey('other'), otherCard())
  await clock.advance(3_000)
  expect(calls.opened).toEqual(['standup'])
})

test('after /reload-plugins the first hook joins and registers everything', async ($, on) => {
  const { calls, store } = stub(on)
  // No session.start: a reload does not fire it.
  const ui = await $.ui.mount(pane('terminal'))
  await ui.redraw()
  expect(calls.tools).toEqual(['assign_task', 'withdraw_task', 'list_tasks'])
  expect(calls.commands).toEqual(['standup', 'standup-settings'])
  expect((store.get(cardKey('self'))) as Card).toBeDefined()
  expect(calls.opened).toEqual(['standup'])
  expect(calls.focused).toEqual([undefined])
  await ui.redraw()
  expect(calls.opened).toEqual(['standup'])
})

test('the system prompt gains the steering section, last', async ($, on) => {
  const { store } = stub(on)
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  const out = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] })
  expect(out.sections.map(s => s.id)).toEqual(['intro', 'standup:steering'])
  expect(out.sections.at(-1)!.text).toContain('assign_task')
})

test('after a compact the model is told which tasks are still open', async ($, on) => {
  const { session, store } = stub(on)
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }] }))
  await start($)
  await assign($, { kind: 'answer', title: 'What should the bucket be called?' })
  await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
  const rows = session.appended().map(r => JSON.stringify(r.message.content))
  expect(rows.some(r => r.includes('What should the bucket be called?'))).toBe(true)
})

test('Jump opens the desktop session; terminal sessions and this session show no jump', async ($, on) => {
  const { calls, store } = stub(on, {
    host: 'local_self',
    entries: { [cardKey('other')]: otherCard(), [cardKey('term')]: otherCard({ sid: 'term', hostId: undefined, tasks: [{ id: 't9', kind: 'do', title: 'Plug in the YubiKey', createdAt: NOW }] }) },
  })
  await start($)
  const ui = await $.ui.mount(pane('desktop'))
  await ui.press({ key: 'expand-other:t1' })
  await ui.press({ key: 'jump-other:t1' })
  expect(calls.run).toEqual([['open', 'claude://claude.ai/epitaxy/local_other']])
  expect(await ui.find({ key: 'jump-term:t9' })).toBeUndefined()

  // A task this session handed out is already here: nothing to jump to.
  await assign($, { kind: 'do', title: 'Rotate the deploy key' })
  const id = ((store.get(cardKey('self'))) as Card).tasks[0]!.id
  expect(await ui.find({ type: 'Text', text: 'Rotate the deploy key' })).toBeDefined()
  expect(await ui.find({ key: `jump-self:${id}` })).toBeUndefined()
})

test('the divider, when on, drags the task area taller', async ($, on) => {
  const { store } = stub(on, { entries: { settings: { lang: 'en', autoOpen: true, divider: true, taskRows: 10 } } })
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(textOf(await ui.find({ type: 'Text', text: /────/, in: 'divider' }))).toContain('────')
    await ui.unmount()
  }
  const ui = await $.ui.mount(pane('terminal'))
  await ui.pointer({ type: 'down', x: 5, y: 0, button: 'left' })
  await ui.pointer({ type: 'up', x: 5, y: 4, button: 'left' })
  expect(((store.get('settings')) as { taskRows: number }).taskRows).toBe(14)
})

test('old data is pruned after seven days; mutes stay', () => {
  const week = 7 * 24 * 60 * 60_000
  const entries = {
    'card:old': otherCard({ sid: 'old', heartbeat: NOW - week - 1 }),
    'card:new': otherCard({ sid: 'new' }),
    'reply:old:t1': { answer: 'x', at: NOW - week - 1, by: 'a' },
    'ack:x': NOW - week - 1,
    'feed-claim:old': NOW - week - 1,
    'mute:x': { text: 'x', at: NOW - week - 1 },
  }
  expect(staleKeys(entries, NOW)).toEqual(['card:old', 'reply:old:t1', 'ack:x', 'feed-claim:old'])
  expect(newItems({ milestones: ['A done'], authorized: [] }, { milestones: ['a done.', 'B done'], authorized: ['C'] })).toEqual({ milestones: ['B done'], authorized: ['C'] })
})


test('an undefined baseline posts only the newest milestone', () => {
  const next = { milestones: ['First', 'Second', 'Newest'], authorized: ['Old deploy', 'Latest deploy'] }
  expect(newItems(undefined, next)).toEqual({ milestones: ['Newest'], authorized: [] })
  expect(newItems(undefined, { milestones: [], authorized: ['Deploy'] })).toEqual({ milestones: [], authorized: [] })
  expect(newItems(next, next)).toEqual({ milestones: [], authorized: [] })
})

test('each run selects only the newest new item of each kind', () => {
  const prev = { milestones: ['Existing'], authorized: ['Old permission'] }
  const next = { milestones: ['First', 'Newest', 'existing!'], authorized: ['Deploy', 'Publish', 'old permission.'] }
  expect(newItems(prev, next)).toEqual({ milestones: ['Newest'], authorized: ['Publish'] })
  expect(newItems(next, next)).toEqual({ milestones: [], authorized: [] })
})

test('malformed stored summaries are dropped instead of reaching normalize', () => {
  const next = { milestones: ['First', 'Newest'], authorized: ['Deploy'] }
  for (const prev of [null, 42, 'bad', {}, [], { milestones: [], authorized: 'bad' },
    { milestones: [42], authorized: [] }, { milestones: ['Valid', null], authorized: [] },
    { milestones: [], authorized: [{}] }, { milestones: ['   '], authorized: [] }]) {
    expect(readSummary(prev)).toBeUndefined()
    expect(newItems(prev as never, next)).toEqual({ milestones: ['Newest'], authorized: [] })
  }
  expect(readSummary({ milestones: [' Done '], authorized: [] })).toEqual({ milestones: ['Done'], authorized: [] })
})

test('summary runs retain the full baseline and self-heal malformed storage', async ($, on) => {
  let summary = { milestones: ['First', 'Second', 'Newest'], authorized: ['Old deploy', 'Latest deploy'] }
  const { calls, clock, store } = stub(on, {
    entries: { [cardKey('self')]: otherCard({ sid: 'self', tasks: [], summary: { milestones: [42], authorized: [] } as never }) },
    model: () => ({ isAnswered: true, text: JSON.stringify(summary) }),
  })
  await start($)
  expect((store.get(cardKey('self')) as Card).summary).toBeUndefined()
  const run = async () => {
    await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/x' } as never).catch(() => undefined)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
    await clock.advance(SUMMARY_GAP_MS + 3_000)
    await clock.settle()
  }
  await run()
  expect((store.get(cardKey('self')) as Card).summary).toEqual(summary)
  expect((store.get(cardKey('self')) as Card).feed.map(f => f.text)).toEqual(['Newest'])
  expect(calls.prompts[0]).toContain('Previous summary:\n{"milestones":[],"authorized":[]}')
  summary = { milestones: [...summary.milestones, 'Fourth', 'Fifth'], authorized: [...summary.authorized, 'Deploy', 'Publish'] }
  await run()
  expect((store.get(cardKey('self')) as Card).summary).toEqual(summary)
  expect((store.get(cardKey('self')) as Card).feed.map(f => f.text)).toEqual(['Newest', 'Fifth'])
  await run()
  const card = store.get(cardKey('self')) as Card
  expect(card.feed.map(f => f.text)).toEqual(['Newest', 'Fifth'])
  expect(card.paused).toBeUndefined()
})

test('a card in the previous stored shape keeps its baseline, tasks and feed on reload', async ($, on) => {
  const previous = otherCard({
    sid: 'self',
    summary: { milestones: ['Login works'], authorized: ['Deployed with standing permission'] },
    summaryAt: NOW - SUMMARY_GAP_MS - 60_000,
    feed: [{ id: 'self:existing', kind: 'milestone', text: 'Login works', at: NOW - SUMMARY_GAP_MS - 60_000 }],
  })
  const next = { milestones: ['Login works', 'Export works'], authorized: ['Deployed with standing permission', 'Published with standing permission'] }
  const { calls, clock, store } = stub(on, {
    entries: { [cardKey('self')]: previous },
    model: () => ({ isAnswered: true, text: JSON.stringify(next) }),
  })
  await start($)
  const loaded = store.get(cardKey('self')) as Card
  expect(loaded.summary).toEqual(previous.summary)
  expect(loaded.summaryAt).toBe(previous.summaryAt)
  expect(loaded.tasks).toEqual(previous.tasks)
  expect(loaded.feed).toEqual(previous.feed)

  await $.tool.call({ tool: 'Read', tool_use_id: 'old-card', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
  await clock.advance(3_000)
  await clock.settle()
  expect(calls.prompts[0]).toContain(`Previous summary:\n${JSON.stringify(previous.summary)}`)
  const updated = store.get(cardKey('self')) as Card
  expect(updated.summary).toEqual(next)
  expect(updated.tasks).toEqual(previous.tasks)
  expect(updated.feed.map(f => f.text)).toEqual(['Login works', 'Export works'])
  expect(updated.paused).toBeUndefined()
})

test('summary prompt reports the overarching goal and sees the recent shared feed', () => {
  const feed = recentFeed([otherCard({ feed: [{ id: 'f', kind: 'milestone', text: 'Judge page shows author and alias', at: NOW }] })])
  const prompt = summaryPrompt('transcript', undefined, [], feed)
  expect(prompt).toContain("session's single overarching goal")
  expect(prompt).toContain('major stage')
  expect(prompt).toContain('Never put PR or MR numbers in milestone headlines')
  expect(prompt.includes('a release version, a PR or MR number')).toBe(false)
  expect(prompt).toContain('Already reported across all sessions; do not repeat')
  expect(prompt).toContain('Judge page shows author and alias')
})

test('recent feed is bounded and normalized overlap preserves distinct outcomes', () => {
  const feed = Array.from({ length: 70 }, (_, i) => ({ id: String(i), kind: 'milestone' as const, text: `Outcome ${i}`, at: i }))
  expect(recentFeed([otherCard({ feed })]).map(row => row.id)).toEqual(feed.slice(-60).reverse().map(row => row.id))
  expect(overlapsFeed('Judge page shows author and alias, live', 'JUDGE page shows author and alias (!116, !117)')).toBe(true)
  expect(overlapsFeed('评委页面已显示作者和别名', '评委页面已显示作者和别名！')).toBe(true)
  expect(overlapsFeed('Login works', 'CSV export shipped')).toBe(false)
  expect(overlapsFeed('Login works', 'Login broken')).toBe(false)
  expect(overlapsFeed('', '')).toBe(false)
})

const toolTurn = async ($: Engine) => {
  await $.tool.call({ tool: 'Read', tool_use_id: 'summary-read', file_path: '/x' } as never).catch(() => undefined)
  await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
}

test('another session including an acknowledged departed card holds the global gap', async ($, on) => {
  const feed = [{ id: 'f', kind: 'milestone' as const, text: 'Login works', at: NOW }]
  const { calls, clock, store } = stub(on, {
    entries: { [cardKey('other')]: otherCard({ feed, heartbeat: NOW - STALE_MS - 1 }), 'ack:f': NOW },
    model: () => ({ isAnswered: true, text: '{"milestones":["CSV export shipped"],"authorized":[]}' }),
  })
  await start($)
  await toolTurn($)
  await clock.advance(SUMMARY_GAP_MS - 3_000)
  expect(calls.models).toEqual([])
  expect(feedGapPassed([otherCard({ feed })], NOW + SUMMARY_GAP_MS - 1)).toBe(false)
  expect(feedGapPassed([otherCard({ feed })], NOW + SUMMARY_GAP_MS)).toBe(true)
  await clock.advance(3_000)
  await clock.settle()
  expect(calls.models).toEqual(['haiku'])
  expect((store.get(cardKey('self')) as Card).feed.map(row => row.text)).toEqual(['CSV export shipped'])
  expect(calls.prompts[0]).toContain('Login works')
})

test('cross-session overlap is dropped even when the model repeats a read item', async ($, on) => {
  const text = 'Judge page shows author and alias, live'
  const { calls, clock, store } = stub(on, {
    entries: {
      [cardKey('other')]: otherCard({ feed: [{ id: 'f', kind: 'milestone', text, at: NOW - SUMMARY_GAP_MS }] }),
      'ack:f': NOW,
    },
    model: () => ({ isAnswered: true, text: '{"milestones":["Judge page shows author and alias (!116, !117)"],"authorized":[]}' }),
  })
  await start($)
  await toolTurn($)
  await clock.advance(3_000)
  await clock.settle()
  const card = store.get(cardKey('self')) as Card
  expect(card.feed).toEqual([])
  expect(card.summary?.milestones).toEqual(['Judge page shows author and alias (!116, !117)'])
  expect(calls.prompts[0]).toContain(text)
})

test('a publication during model completion defers without consuming the baseline', async ($, on) => {
  const { clock, store } = stub(on, {
    model: () => {
      store.set(cardKey('other'), otherCard({ feed: [{ id: 'f', kind: 'authorized', text: 'Published docs', at: NOW + 3_000 }] }))
      return { isAnswered: true, text: '{"milestones":["Login works"],"authorized":[]}' }
    },
  })
  await start($)
  await toolTurn($)
  await clock.advance(3_000)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).feed).toEqual([])
  expect((store.get(cardKey('self')) as Card).summary).toBeUndefined()
  await clock.advance(SUMMARY_GAP_MS)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).feed.map(row => row.text)).toEqual(['Login works'])
})

test('global publication claims exclude simultaneous writers and release after errors', async () => {
  const store = new Map<string, unknown>()
  let now = NOW
  const $ = {
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => { store.set(key, value) },
      delete: async (key: string) => { store.delete(key) },
      keys: async () => [...store.keys()],
    },
    clock: { now: async () => now },
  }
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let enter!: () => void
  const entered = new Promise<void>(resolve => { enter = resolve })
  const first = withFeedClaim($, 'a', async () => { enter(); await held; return true })
  await entered
  let secondEntered = false
  expect(await withFeedClaim($, 'b', async () => { secondEntered = true; return true })).toBe(false)
  expect(secondEntered).toBe(false)
  release()
  expect(await first).toBe(true)
  expect(await withFeedClaim($, 'b', async () => true)).toBe(true)
  await withFeedClaim($, 'a', async () => { throw new Error('write failed') }).catch(() => undefined)
  expect([...store.keys()].filter(key => key.startsWith('feed-claim:'))).toEqual([])
  let active = 0
  let maxActive = 0
  const publish = async () => {
    active += 1
    maxActive = Math.max(maxActive, active)
    await Promise.resolve()
    active -= 1
    return true
  }
  await Promise.all(['a', 'b', 'c', 'd'].map(sid => withFeedClaim($, sid, publish)))
  expect(maxActive <= 1).toBe(true)
  expect(await withFeedClaim($, 'a', publish)).toBe(true)
  // A crashed writer holds only one interval; a suspended writer cannot publish after expiry.
  store.set('feed-claim:crashed', NOW)
  expect(await withFeedClaim($, 'b', async () => true)).toBe(false)
  now += SUMMARY_GAP_MS
  expect(await withFeedClaim($, 'b', async valid => {
    now += SUMMARY_GAP_MS
    return valid()
  })).toBe(false)
  expect(await withFeedClaim($, 'b', async () => true)).toBe(true)
})

test('an abandoned claim delays publication without calling the model every poll', async ($, on) => {
  const { calls, clock, store } = stub(on, {
    entries: { 'feed-claim:crashed': NOW },
    model: () => ({ isAnswered: true, text: '{"milestones":["Login works"],"authorized":[]}' }),
  })
  await start($)
  await toolTurn($)
  await clock.advance(3_000)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).summary).toBeUndefined()
  await clock.advance(SUMMARY_GAP_MS - 3_000)
  expect(calls.models).toEqual(['haiku'])
  await clock.advance(3_000)
  await clock.settle()
  expect(calls.models).toEqual(['haiku', 'haiku'])
  expect((store.get(cardKey('self')) as Card).feed.map(row => row.text)).toEqual(['Login works'])
})


test('worktree rows identify repo, branch and prompt on both surfaces; heartbeat refreshes branch', async ($, on) => {
  let branch = 'feature/login'
  const { clock, store } = stub(on, {
    cwd: '/work/product/.claude/worktrees/random-slug',
    repo: { root: '/work/product', remote: 'git@github.com:team/product.git', internal: false, name: null },
    git: () => ({ exitCode: 0, stdout: branch + '\n' }),
  })
  await start($)
  await assign($, { kind: 'do', title: 'Review login' })
  const card = store.get(cardKey('self')) as Card
  expect(card.repo).toBe('product')
  expect(card.branch).toBe('feature/login')
  expect(card.title).toBe('ship the login page')
  store.set(cardKey('self'), { ...card, feed: [{ id: 'source-feed', kind: 'milestone', text: 'Login works', at: NOW }] })
  await clock.advance(3_000)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    await ui.press({ key: `expand-self:${card.tasks[0]!.id}` })
    expect(await ui.find({ type: 'Text', text: /^product · feature\/login · ship the login page/ })).toBeDefined()
    await ui.press({ key: `expand-self:${card.tasks[0]!.id}` })
    await ui.unmount()
  }
  branch = 'fix/login'
  await clock.advance(60_000)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).branch).toBe('fix/login')
})

test('remote-less worktrees use the main root and empty sessions acquire their first prompt later', async ($, on) => {
  const messages: NonNullable<Opts['messages']> = []
  const { clock, store } = stub(on, {
    cwd: '/tmp/random-slug',
    repo: { root: '/work/product', remote: null, internal: false, name: null },
    messages,
    git: () => ({ exitCode: 0, stdout: 'HEAD\n' }),
  })
  await start($)
  expect(sourceLabel(store.get(cardKey('self')) as Card)).toBe('product · HEAD · random-slug')
  messages.push({ role: 'user', text: '  Build\n the dashboard  ', toolUses: [] })
  await clock.advance(60_000)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).title).toBe('Build the dashboard')
  messages.push({ role: 'user', text: 'Second prompt', toolUses: [] })
  await clock.advance(60_000)
  expect((store.get(cardKey('self')) as Card).title).toBe('Build the dashboard')
})

test('host title takes priority and legacy cards still render tasks and feed', async ($, on) => {
  const previous = otherCard({ feed: [{ id: 'old-feed', kind: 'milestone', text: 'Old outcome', at: NOW }] })
  const { store } = stub(on, { entries: { [cardKey('other')]: previous } })
  on('classic.UserPromptSubmit', () => ({}))
  on('classic.SessionStart', () => ({}))
  await $.classic.SessionStart({ source: 'resume', session_title: 'Resumed title' })
  expect((store.get(cardKey('self')) as Card).title).toBe('Resumed title')
  await start($)
  await $.classic.UserPromptSubmit({ prompt: 'Different prompt', session_title: 'Human title' })
  expect((store.get(cardKey('self')) as Card).title).toBe('Human title')
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ key: 'expand-project-beta' })).toBeDefined()
    await ui.press({ key: 'expand-other:t1' })
    expect(await ui.find({ type: 'Text', text: /^beta ·/ })).toBeDefined()
    await ui.press({ key: 'expand-other:t1' })
    await ui.unmount()
  }
  expect(store.get(cardKey('other'))).toEqual(previous)
})

test('non-git sessions survive command failures and shorten titles', async ($, on) => {
  const { store } = stub(on, { messages: [], git: () => { throw new Error('git unavailable') } })
  await start($)
  const card = store.get(cardKey('self')) as Card
  expect(card.branch).toBeUndefined()
  expect(card.repo).toBe('alpha')
  expect(shortTitle('x'.repeat(100))).toBe('x'.repeat(79) + '…')
  expect(summaryPrompt('', undefined, [], [], 'product')).toContain('never a bare !129 or #10')
  expect(summaryPrompt('', undefined, [], [], 'product')).toContain('Session repository (context only, not proof of which repository a PR/MR belongs to): product')
})


test('interleaved projects render contiguous blocks on both surfaces and acknowledgments update them', async ($, on) => {
  const card = (sid: string, repo: string | undefined, name: string, text: string, at: number) => otherCard({
    sid, repo, name, tasks: [],
    feed: [{ id: sid, kind: 'milestone', text, at }],
  })
  const entries = {
    [cardKey('a-old')]: card('a-old', 'A', 'slug-old', 'A older', NOW - 3000),
    [cardKey('b')]: card('b', 'B', 'slug-b', 'B middle', NOW - 2000),
    [cardKey('a-new')]: card('a-new', 'A', 'slug-new', 'A newest', NOW - 1000),
    // Previous-shape cards use their existing name as the project fallback.
    [cardKey('legacy')]: card('legacy', undefined, 'Legacy', 'Legacy oldest', NOW - 4000),
  }
  const { store } = stub(on, { entries })
  expect(feedGroups(snapshotOf(entries, 'self')).map(group => ({ project: group.project, ids: group.rows.map(row => row.id) }))).toEqual([
    { project: 'A', ids: ['a-new', 'a-old'] },
    { project: 'B', ids: ['b'] },
    { project: 'Legacy', ids: ['legacy'] },
  ])
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.findAll({ type: 'Text', text: /^(A|B|Legacy)$/ })).filter(row => row.props.weight === 'semibold').map(textOf)).toEqual([])
    for (const project of ['A', 'B', 'Legacy']) await ui.press({ key: `expand-project-${project}` })
    expect((await ui.findAll({ type: 'Text', text: /^(A newest|A older|B middle|Legacy oldest)$/ })).map(textOf)).toEqual(['A newest', 'A older', 'B middle', 'Legacy oldest'])
    expect(await ui.find({ type: 'Text', text: /Summary 4/ })).toBeDefined()
    for (const project of ['A', 'B', 'Legacy']) await ui.press({ key: `expand-project-${project}` })
    await ui.unmount()
  }
  const terminal = await $.ui.mount(pane('terminal'))
  await terminal.press({ key: 'expand-project-A' })
  await terminal.press({ key: 'ok-a-new' })
  await terminal.press({ key: 'expand-project-A' })
  await terminal.unmount()
  expect(store.get('ack:a-new')).toBeDefined()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.findAll({ type: 'Text', text: /^(A|B|Legacy)$/ })).filter(row => row.props.weight === 'semibold').map(textOf)).toEqual([])
    for (const project of ['A', 'B', 'Legacy']) await ui.press({ key: `expand-project-${project}` })
    expect((await ui.findAll({ type: 'Text', text: /^(A newest|A older|B middle|Legacy oldest)$/ })).map(textOf)).toEqual(['B middle', 'A older', 'Legacy oldest'])
    for (const project of ['A', 'B', 'Legacy']) await ui.press({ key: `expand-project-${project}` })
    await ui.unmount()
  }
  const desktop = await $.ui.mount(pane('desktop'))
  await desktop.press({ key: 'ack-all' })
  await desktop.unmount()
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect((await ui.findAll({ type: 'Text', text: /^(A|B|Legacy)$/ })).filter(row => row.props.weight === 'semibold')).toHaveLength(0)
    expect(await ui.find({ type: 'Text', text: /Summary 0/ })).toBeDefined()
    await ui.unmount()
  }
  expect(['a-new', 'a-old', 'b', 'legacy'].every(id => store.has('ack:' + id))).toBe(true)
})

test('injected user rows and tool results never become titles, including stored polluted titles', async ($, on) => {
  const injected = ['<system-reminder>Worktree path: /tmp/slug</system-reminder>', '<command-name>/clear</command-name>', '<local-command-stdout>done</local-command-stdout>', 'This session is being continued from a previous conversation that ran out of context.']
  const messages: NonNullable<Opts['messages']> = injected.map(text => ({ role: 'user', text, toolUses: [] }))
  messages.push({ role: 'user', text: 'tool output', toolUses: [], toolResults: [{ tool_use_id: 'r', text: 'output', isError: false }] })
  messages.push({ role: 'user', text: 'Fix the judge layout', toolUses: [] })
  const { store } = stub(on, { messages, entries: { [cardKey('self')]: otherCard({ sid: 'self', title: injected[0] }) } })
  on('classic.UserPromptSubmit', () => ({}))
  await start($)
  expect((store.get(cardKey('self')) as Card).title).toBe('Fix the judge layout')
  await $.classic.UserPromptSubmit({ prompt: injected[1]!, session_title: 'Sidebar title' })
  expect((store.get(cardKey('self')) as Card).title).toBe('Sidebar title')
})

test('worktree slug branches are hidden on new and old cards; meaningful long branches retain their tail', async ($, on) => {
  const { store } = stub(on, { git: () => ({ exitCode: 0, stdout: 'claude/random-slug\n' }) })
  await start($)
  expect((store.get(cardKey('self')) as Card).branch).toBeUndefined()
  expect(sourceLabel(otherCard({ repo: 'product', branch: 'claude/old-slug', title: 'Human title' }))).toBe('product · Human title')
  expect(sourceLabel(otherCard({ repo: 'product', branch: 'slug', cwd: '/work/product/.claude/worktrees/slug', title: 'Human title' }))).toBe('product · Human title')
  const branch = 'feature/' + 'long-'.repeat(10) + 'judges-polish'
  expect(sourceLabel(otherCard({ repo: 'product', branch, title: 'Human title' }))).toBe(`product · …${branch.slice(-35)} · Human title`)
})

test('summaries persist the most-edited repository per turn and fold that runs merge into its milestone', async ($, on) => {
  const use = (file_path: string) => ({ tool_use_id: file_path, tool: 'Edit', input: { file_path } })
  const messages: NonNullable<Opts['messages']> = [
    { role: 'user', text: 'Old work', toolUses: [] },
    { role: 'assistant', text: '', toolUses: Array.from({ length: 5 }, () => use('/workspace/old/a.ts')) },
    { role: 'user', text: 'Fix stitching', toolUses: [] },
    { role: 'assistant', text: '', toolUses: [use('auto-director/a.ts'), use('video-bench/a.ts'), use('video-bench/b.ts')] },
    { role: 'user', text: 'result', toolUses: [], toolResults: [{ tool_use_id: 'edit', text: '', isError: false }] },
  ]
  let summary = { milestones: ['Stitching works'], authorized: ['Merged video-bench !140 (memory: may merge)'] }
  const { clock, store } = stub(on, {
    cwd: '/workspace', messages,
    entries: { [cardKey('self')]: otherCard({ sid: 'self', tasks: [], summary: { milestones: [], authorized: [] } }) },
    git: (argv, cwd) => ({ exitCode: argv.includes('--show-toplevel') ? 0 : 128, stdout: cwd?.includes('video-bench') ? '/repos/video-bench\n' : '/repos/auto-director\n' }),
    model: () => ({ isAnswered: true, text: JSON.stringify({ ...summary, merged: [{ milestone: 'Stitching works', authorized: summary.authorized[0] }] }) }),
  })
  await start($)
  const run = async () => {
    await $.tool.call({ tool: 'Read', tool_use_id: 'r', file_path: '/x' } as never).catch(() => undefined)
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 10, isAborted: false, turnId: 'turn' })
    await clock.advance(SUMMARY_GAP_MS + 3_000)
    await clock.settle()
  }
  await run()
  let card = store.get(cardKey('self')) as Card
  expect(card.feed).toHaveLength(1)
  expect(card.feed[0]?.repo).toBe('video-bench')
  expect(card.feed[0]?.text).toBe('Stitching works (merged on standing permission)')
  expect(card.summary).toEqual(summary)
  expect(feedGroups(snapshotOf(Object.fromEntries(store), 'self'))[0]?.project).toBe('video-bench')
  messages.push({ role: 'user', text: 'Now fix discovery', toolUses: [] }, { role: 'assistant', text: '', toolUses: [use('auto-director/a.ts')] })
  summary = { milestones: ['Stitching works', 'Discovery works'], authorized: summary.authorized }
  await run()
  card = store.get(cardKey('self')) as Card
  expect(card.feed.map(row => row.repo)).toEqual(['video-bench', 'auto-director'])
  expect(card.feed[1]?.text).toBe('Discovery works')
  expect(recentFeed([card]).map(row => row.project)).toEqual(['auto-director', 'video-bench'])
})

test('unresolved touched paths fall back to legacy card metadata', async () => {
  let attempts = 0
  const host = { process: { run: async () => { attempts++; throw new Error('not a repository') } } }
  expect(await turnRepo(host as never, '/workspace', [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 'e', tool: 'Edit', input: { file_path: 'missing/file.ts' } }] }])).toBeUndefined()
  expect(attempts).toBe(2)
  const card = otherCard({ repo: 'fallback', feed: [{ id: 'old', kind: 'milestone', text: 'Legacy outcome', at: NOW }] })
  expect(feedGroups(snapshotOf({ [cardKey('other')]: card }, 'self'))[0]?.project).toBe('fallback')
})

test('compact project summaries expand to one-line feed rows, with source behind expansion', async ($, on) => {
  stub(on, { entries: { [cardKey('other')]: otherCard({ tasks: [], repo: 'video-bench', title: 'A very long title '.repeat(12), feed: [{ id: 'compact', kind: 'milestone', text: 'Stitching works', at: NOW }] }) } })
  await start($)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ key: 'feed-compact' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^video-bench: Stitching works/ })).toBeDefined()
    await ui.press({ key: 'expand-project-video-bench' })
    const headline = await ui.find({ type: 'Text', text: /^✓ Stitching works · video-bench ·/ })
    expect(headline?.props.wrap).toBe('truncate-end')
    expect(await ui.find({ key: 'ok-compact' })).toBeDefined()
    expect((await ui.find({ key: 'feed-line-compact' }))?.props.flexDirection).toBe('row')
    const tree = await ui.drawn()
    const find = (node: any): any => node?.props?.key === 'feed-line-compact' ? node : node?.children?.map(find).find(Boolean)
    expect(JSON.stringify(find(tree))).toContain('ok-compact')
    expect(await ui.find({ type: 'Text', text: /^video-bench · A very long/ })).toBeUndefined()
    await ui.press({ key: 'expand-feed-compact' })
    expect(await ui.find({ type: 'Text', text: /^video-bench · A very long/ })).toBeDefined()
    await ui.press({ key: 'expand-feed-compact' })
    await ui.press({ key: 'expand-project-video-bench' })
    await ui.unmount()
  }
})

test('folded permission suffix does not bypass cross-session duplicate detection', async ($, on) => {
  const { clock, store } = stub(on, {
    entries: {
      [cardKey('self')]: otherCard({ sid: 'self', tasks: [], summary: { milestones: [], authorized: [] } }),
      [cardKey('other')]: otherCard({ tasks: [], feed: [{ id: 'old', kind: 'milestone', text: 'Login works', at: NOW - SUMMARY_GAP_MS - 1 }] }),
    },
    model: () => ({ isAnswered: true, text: '{"milestones":["Login works"],"authorized":["Merged product #42 (standing permission)"],"merged":[{"milestone":"Login works","authorized":"Merged product #42 (standing permission)"}]}' }),
  })
  await start($)
  await toolTurn($)
  await clock.advance(3_000)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).feed).toEqual([])
})

test('an unrelated merge in the same run never marks the milestone as merged', async ($, on) => {
  const milestone = 'Login prototype works locally; not merged'
  const authorized = 'Merged unrelated documentation PR #99 (standing permission)'
  const { clock, store } = stub(on, {
    entries: { [cardKey('self')]: otherCard({ sid: 'self', tasks: [], summary: { milestones: [], authorized: [] } }) },
    model: () => ({ isAnswered: true, text: JSON.stringify({ milestones: [milestone], authorized: [authorized] }) }),
  })
  await start($)
  await toolTurn($)
  await clock.advance(3_000)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).feed.map(row => row.text)).toEqual([milestone])
})

test('unassociated authorized action remains a candidate when the milestone is already reported', async ($, on) => {
  const milestone = 'Login prototype works locally; not merged'
  const authorized = 'Merged unrelated documentation PR #99 (standing permission)'
  const { clock, store } = stub(on, {
    entries: {
      [cardKey('self')]: otherCard({ sid: 'self', tasks: [], summary: { milestones: [], authorized: [] } }),
      [cardKey('other')]: otherCard({ tasks: [], feed: [{ id: 'reported', kind: 'milestone', text: milestone, at: NOW - SUMMARY_GAP_MS - 1 }] }),
    },
    model: () => ({ isAnswered: true, text: JSON.stringify({ milestones: [milestone], authorized: [authorized], merged: [] }) }),
  })
  await start($)
  await toolTurn($)
  await clock.advance(3_000)
  await clock.settle()
  expect((store.get(cardKey('self')) as Card).feed.map(({ kind, text }) => ({ kind, text }))).toEqual([{ kind: 'authorized', text: authorized }])
})

test('merge associations require valid exact endpoints and old summary responses still parse', () => {
  const summary = { milestones: ['Stitching works'], authorized: ['Merged video-bench !140 (standing permission)'] }
  const pair = { milestone: summary.milestones[0], authorized: summary.authorized[0] }
  expect(parseSummary(JSON.stringify(summary))).toEqual(summary)
  expect(parseSummary(JSON.stringify({ ...summary, merged: [pair] }))).toEqual({ ...summary, merged: [pair] })
  for (const merged of [null, 'bad', {}, [null, 42, 'bad', {}],
    [{ ...pair, milestone: 'Different work' }], [{ ...pair, authorized: 'Merged another PR' }],
    [{ ...pair, milestone: 42 }], [{ ...pair, authorized: null }]]) {
    expect(parseSummary(JSON.stringify({ ...summary, merged }))).toEqual(summary)
  }
  const deploy = { milestones: ['Stitching works'], authorized: ['Deployed video-bench'] }
  expect(parseSummary(JSON.stringify({ ...deploy, merged: [{ milestone: deploy.milestones[0], authorized: deploy.authorized[0] }] }))).toEqual(deploy)
  expect(summaryPrompt('', undefined, [])).toContain('Same session, repository, or summary run is NOT evidence')
})


test('previous settings shape preserves preferences and defaults status to off', () => {
  const previous = { lang: 'en', openOnStart: false, autoOpen: false, divider: true, muteButton: true, taskRows: 8 }
  expect(readSettings(previous)).toEqual({ ...previous, showStatus: false })
  expect(readSettings(undefined).showStatus).toBe(false)
  expect(readSettings({ showStatus: true }).showStatus).toBe(true)
})

test('status count is opt-in and switching it off clears an existing entry', async ($, on) => {
  const { calls, clock } = stub(on, { entries: { [cardKey('other')]: otherCard() } })
  await start($)
  expect(calls.status.every(text => text === undefined)).toBe(true)
  const ui = await $.ui.mount(pane('desktop', 'standup-settings'))
  await ui.press({ key: 'toggle-showStatus-on' })
  await clock.advance(3_000)
  expect(calls.status.at(-1)).toBe('1 task needs you · /standup')
  await ui.press({ key: 'toggle-showStatus-off' })
  await clock.advance(3_000)
  expect(calls.status.at(-1)).toBeUndefined()
})

for (const first of ['tool', 'turn'] as const) {
  test(`a ${first} hook alone joins when session and prompt hooks never fire`, async ($, on) => {
    const messages: NonNullable<Opts['messages']> = []
    const { calls, store } = stub(on, { messages })
    if (first === 'tool') await $.tool.call({ tool: 'Read', tool_use_id: 'lazy', file_path: '/x' } as never).catch(() => undefined)
    else await $.turn.complete({ answer: 'Done' } as never)
    expect((store.get(cardKey('self')) as Card).repo).toBe('alpha')
    expect(calls.tools).toEqual(['assign_task', 'withdraw_task', 'list_tasks'])
    messages.push({ role: 'user', text: 'Fix the dashboard', toolUses: [] })
    await $.turn.complete({ answer: 'Done' } as never)
    expect((store.get(cardKey('self')) as Card).title).toBe('Fix the dashboard')
    expect(calls.tools).toHaveLength(3)
  })
}

for (const surface of SURFACES) {
  test(`compact tasks on ${surface} keep actions inline and reveal full details on expansion`, async ($, on) => {
    const detail = 'Detailed instructions '.repeat(20)
    const task: Task = { id: 'compact', kind: 'do', title: 'Review the build', detail, createdAt: NOW }
    const { store } = stub(on, { entries: { [cardKey('other')]: otherCard({ tasks: [task] }) } })
    await start($)
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: detail })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: /^Review the build · beta ·/ }))?.props.wrap).toBe('truncate-end')
    expect(await ui.find({ key: 'done-other:compact' })).toBeDefined()
    expect(await ui.find({ key: 'skip-other:compact' })).toBeDefined()
    const line = await ui.find({ key: 'task-line-other:compact' })
    expect(line?.props.flexDirection).toBe('row')
    const tree = await ui.drawn()
    const find = (node: any): any => node?.props?.key === 'task-line-other:compact' ? node : node?.children?.map(find).find(Boolean)
    expect(JSON.stringify(find(tree))).toContain('done-other:compact')
    expect(JSON.stringify(find(tree))).toContain('skip-other:compact')
    await ui.press({ key: 'expand-other:compact' })
    expect(await ui.find({ type: 'Text', text: detail })).toBeDefined()
    await ui.press({ key: 'expand-other:compact' })
    await ui.press({ key: 'done-other:compact' })
    expect(store.get(replyKey('other', 'compact'))).toEqual({ answer: '', at: NOW, by: 'self' })
  })
}

for (const surface of SURFACES) {
  test(`expanding a choice on ${surface} reveals working options`, async ($, on) => {
    const task: Task = { id: 'choice', kind: 'choose', title: 'Which region?', options: ['US', 'EU'], createdAt: NOW }
    const { store } = stub(on, { entries: { [cardKey('other')]: otherCard({ tasks: [task] }) } })
    await start($)
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ key: 'opt-other:choice-0' })).toBeUndefined()
    await ui.press({ key: 'expand-other:choice' })
    await ui.press({ key: 'opt-other:choice-1' })
    expect(store.get(replyKey('other', 'choice'))).toEqual({ answer: 'EU', at: NOW, by: 'self' })
  })
}
