import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, FeedItem, Reply, HubSettings, Snapshot, Summary, Task, TaskKind } from '../types'
import {
  DEFAULT_SETTINGS,
  HEARTBEAT_MS,
  HUB_PANE,
  MAX_FEED,
  MAX_OPEN_TASKS,
  POLL_MS,
  SETTINGS_KEY,
  SETTINGS_PANE,
  SUMMARY_GAP_MS,
  ackKey,
  cardKey,
  duplicateOf,
  feedGapPassed,
  looksLikeSecret,
  overlapsFeed,
  muteKey,
  newItems,
  openTasks,
  parseSummary,
  readSettings,
  readSummary,
  recentFeed,
  replyKey,
  shortHash,
  snapshotOf,
  staleKeys,
  statusText,
  summaryPrompt,
  t,
  transcriptText,
} from './hub'
import type { FeedRow, OpenTask } from './hub'
import { basename, currentBranch, firstPromptTitle, projectName, shortTitle, promptTitle, turnRepo } from './source'
import { withFeedClaim } from './feed-claim'
import { renderHub, renderSettings } from './panel'
import type { Actions } from './panel'
import {
  ASSIGN_DESCRIPTION,
  ASSIGN_SCHEMA,
  LIST_DESCRIPTION,
  STEERING,
  WITHDRAW_DESCRIPTION,
  WITHDRAW_SCHEMA,
} from './steering'

const snapAtom = atom({ plugin: 'standup', key: 'snap' } as const, null)
const settingsAtom = atom({ plugin: 'standup', key: 'settings' } as const, DEFAULT_SETTINGS)
const errorsAtom = atom({ plugin: 'standup', key: 'errors' } as const, {})
const bandAtom = atom({ plugin: 'standup', key: 'bandOpen' } as const, false)

const TOOL = {
  assign: 'mcp__standup__assign_task',
  withdraw: 'mcp__standup__withdraw_task',
  list: 'mcp__standup__list_tasks',
} as const

const PRUNE_EVERY_MS = 10 * 60_000

// Module state: a reload starts it over, and the lazy join below rebuilds it.
const rt = {
  joining: undefined as Promise<void> | undefined,
  sid: '',
  startHandled: false,
  hostId: undefined as string | undefined,
  seenTasks: undefined as Set<string> | undefined,
  toolsThisTurn: 0,
  summaryDue: false,
  summarizing: false,
  lastPrune: 0,
  seenSessions: '',
  // Replies whose prompt a hook dropped: kept, and tried again once the next turn ends.
  held: new Set<string>(),
  sending: new Set<string>(),
  writes: Promise.resolve() as Promise<unknown>,
}

/** Every hook calls this: /reload-plugins fires no session.start, so the first hook to run joins. */
export function join($: EngineInterface) {
  rt.joining ??= doJoin($).catch(err => {
    rt.joining = undefined
    throw err
  })
  return rt.joining
}

async function doJoin($: EngineInterface) {
  rt.sid = await $.session.id()
  rt.hostId = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) || undefined
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const old = (await $.store.get(cardKey(rt.sid))) as Card | undefined
  const card: Card = {
    sid: rt.sid,
    hostId: rt.hostId,
    cwd,
    name: basename(cwd),
    repo: await projectName($, cwd),
    branch: await currentBranch($, cwd),
    title: promptTitle(old?.title ?? '') || await firstPromptTitle($),
    heartbeat: now,
    tasks: old?.tasks ?? [],
    feed: old?.feed ?? [],
    summary: readSummary(old?.summary),
    summaryAt: old?.summaryAt,
  }
  await $.store.set(cardKey(rt.sid), card)

  await Promise.all([
    $.command.register({ name: 'standup', description: 'Open Standup: what every session needs from you, and what each finished', immediate: true }),
    $.command.register({ name: 'standup-settings', description: 'Standup settings: language, auto-open, divider', immediate: true }),
    $.tool.register({ name: 'assign_task', description: ASSIGN_DESCRIPTION, inputSchema: ASSIGN_SCHEMA, isDeferred: false }),
    $.tool.register({ name: 'withdraw_task', description: WITHDRAW_DESCRIPTION, inputSchema: WITHDRAW_SCHEMA, isDeferred: false }),
    $.tool.register({ name: 'list_tasks', description: LIST_DESCRIPTION, inputSchema: { type: 'object', properties: {} }, isDeferred: false }),
  ])

  $.clock.every(POLL_MS, () => void poll($).catch(err => $.ui.log(`standup: poll failed: ${String(err)}`, { to: 'debug' })))
  $.clock.every(HEARTBEAT_MS, () => void heartbeat($).catch(() => undefined))
  await poll($)
  if (!rt.startHandled) {
    // Decide once at join, including the lazy join after /reload-plugins.
    // Polls and turns must not undo a user's close or a disabled startup setting.
    const settings = await read($, settingsAtom)
    rt.startHandled = true
    if (settings.openOnStart) await showHub($, settings.lang, false)
  }
}

/** Read-modify-write of this session's own card, one at a time. */
function mutateCard($: EngineInterface, fn: (card: Card) => Card | Promise<Card>) {
  const run = rt.writes.then(async () => {
    const card = (await $.store.get(cardKey(rt.sid))) as Card | undefined
    if (!card) return
    await $.store.set(cardKey(rt.sid), await fn(card))
  })
  rt.writes = run.catch(() => undefined)
  return run
}

async function heartbeat($: EngineInterface) {
  const now = await $.clock.now()
  await mutateCard($, async card => ({
    ...card, heartbeat: now,
    branch: await currentBranch($, card.cwd),
    title: promptTitle(card.title ?? '') || await firstPromptTitle($),
  }))
}

async function readAll($: EngineInterface) {
  const entries: Record<string, unknown> = {}
  for (const key of await $.store.keys()) entries[key] = await $.store.get(key)
  return entries
}

async function poll($: EngineInterface) {
  const now = await $.clock.now()
  let entries = await readAll($)

  if (now - rt.lastPrune > PRUNE_EVERY_MS) {
    rt.lastPrune = now
    const stale = staleKeys(entries, now)
    for (const key of stale) await $.store.delete(key)
    if (stale.length) entries = await readAll($)
  }

  // Answers other sessions wrote for this one.
  const mine = Object.keys(entries).filter(key => key.startsWith(`reply:${rt.sid}:`))
  if (mine.length) {
    await deliver($, mine.map(key => key.slice(`reply:${rt.sid}:`.length)))
    entries = await readAll($)
  }

  const settings = readSettings(entries[SETTINGS_KEY])
  const snap = snapshotOf(entries, rt.sid)
  const seen = snap.cards.map(c => c.sid).sort().join(',')
  if (seen !== rt.seenSessions) {
    rt.seenSessions = seen
    $.ui.log(`standup: sessions in the store: ${seen}`, { to: 'debug' })
  }
  if (JSON.stringify(await read($, settingsAtom)) !== JSON.stringify(settings)) await update($, settingsAtom, () => settings)
  if (JSON.stringify(await read($, snapAtom)) !== JSON.stringify(snap)) await update($, snapAtom, () => snap)

  const open = openTasks(snap, now)
  $.ui.status(settings.showStatus ? statusText(settings.lang, open.length) : undefined)

  const ids = open.map(task => `${task.sid}:${task.id}`)
  const arrived = rt.seenTasks !== undefined && ids.some(id => !rt.seenTasks!.has(id))
  rt.seenTasks = new Set(ids)
  if (arrived && settings.autoOpen) void showHub($, settings.lang, false).catch(() => undefined)

  const card = snap.cards.find(c => c.sid === rt.sid)
  if (rt.summaryDue && !rt.summarizing && card && now - (card.summaryAt ?? 0) >= SUMMARY_GAP_MS && feedGapPassed(snap.cards, now)) {
    rt.summaryDue = false
    rt.summarizing = true
    void summarize($, card, snap)
      .catch(err => mutateCard($, c => ({ ...c, paused: String(err) })))
      .finally(() => (rt.summarizing = false))
  }
}

/** Hands each answer to the model as a prompt: at once when idle, after the turn when busy. */
async function deliver($: EngineInterface, ids: readonly string[]) {
  const card = (await $.store.get(cardKey(rt.sid))) as Card | undefined
  const answered = new Set<string>()
  for (const id of ids) {
    // Polls can overlap: one whose reply is mid-submit, or already delivered, leaves it alone.
    if (rt.held.has(id) || rt.sending.has(id)) continue
    rt.sending.add(id)
    try {
      const reply = (await $.store.get(replyKey(rt.sid, id))) as Reply | undefined
      if (!reply) continue
      const task = card?.tasks.find(x => x.id === id)
      // Submit first: if it throws, the reply key stays and the next poll tries again.
      // If a hook drops it, the reply and task stay until the next turn ends.
      if (task && 'drop' in (await $.prompt.submit({ text: replyMessage(task, reply) }))) {
        rt.held.add(id)
        continue
      }
      await $.store.delete(replyKey(rt.sid, id))
    } finally {
      rt.sending.delete(id)
    }
    answered.add(id)
  }
  if (answered.size) await mutateCard($, c => ({ ...c, tasks: c.tasks.filter(task => !answered.has(task.id)) }))
}

// ---- the feed ----

async function summarize($: EngineInterface, card: Card, snap: Snapshot) {
  const rows = await $.session.messages()
  const repo = await turnRepo($, card.cwd, rows)
  const prev = readSummary(card.summary)
  const prompt = summaryPrompt(transcriptText(rows), prev, snap.mutes, recentFeed(snap.cards), card.repo)
  const ask = (model: string) => $.model.complete({ model, prompt, maxTokens: 1500, effort: 'low', timeoutMs: 90_000 })
  let reply = await ask('haiku')
  if (!reply.isAnswered && reply.reason === 'api-error') reply = await ask(await $.session.model())

  const now = await $.clock.now()
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `API error ${reply.status ?? ''} ${reply.error ?? ''}`.trim() : reply.reason
    await mutateCard($, c => ({ ...c, paused: why, summaryAt: now }))
    return
  }
  const result = parseSummary(reply.text)
  if (!result) {
    await mutateCard($, c => ({ ...c, paused: 'the summary came back unreadable', summaryAt: now }))
    return
  }
  const summary: Summary = { milestones: result.milestones, authorized: result.authorized }
  const fresh = newItems(prev, summary)
  const item = (kind: FeedItem['kind'], text: string): FeedItem => ({ id: `${rt.sid}:${shortHash(kind + text + now)}`, kind, text, at: now, ...(repo ? { repo } : {}) })
  // Require an explicit association, with both endpoints new in this run.
  const folded = result.merged?.some(pair => fresh.milestones.includes(pair.milestone) && fresh.authorized.includes(pair.authorized)) ?? false
  const candidates = [...fresh.milestones.map(s => item('milestone', s + (folded ? ' (merged on standing permission)' : ''))), ...(folded ? [] : fresh.authorized.map(s => item('authorized', s)))]
  const claimed = await withFeedClaim($, rt.sid, async valid => {
    // Another session may have published while the model was answering.
    const current = snapshotOf(await readAll($), rt.sid)
    const at = await $.clock.now()
    if (!feedGapPassed(current.cards, at)) return false
    const recent = recentFeed(current.cards).filter(row => row.sid !== rt.sid)
    const added = candidates.filter(candidate => !recent.some(row => overlapsFeed(candidate.text.replace(/ \(merged on standing permission\)$/, ''), row.text.replace(/ \(merged on standing permission\)$/, '')))).slice(0, 1)
    let published = false
    await mutateCard($, async c => {
      const publishedAt = await $.clock.now()
      if (!await valid()) return c
      published = true
      return { ...c, summary, summaryAt: publishedAt, paused: undefined, feed: [...c.feed, ...added.map(item => ({ ...item, at: publishedAt }))].slice(-MAX_FEED) }
    })
    return published
  })
  // A competing publication delays this session, without consuming its baseline.
  if (!claimed) {
    rt.summaryDue = true
    // Contention (including a crashed claim) must not cause a model call every poll.
    await mutateCard($, c => ({ ...c, summaryAt: now }))
  }
  await poll($)
}

// ---- actions the panel calls ----

export function actions($: EngineInterface): Actions {
  return {
    complete: task => sendReply($, task, ''),
    skip: task => sendReply($, task, 'no longer needed', true),
    answer: async (task, text) => {
      const key = `${task.sid}:${task.id}`
      if (looksLikeSecret(text)) {
        const { lang } = await read($, settingsAtom)
        await update($, errorsAtom, errs => ({ ...errs, [key]: t(lang, 'secretRefused') }))
        return
      }
      await update($, errorsAtom, ({ [key]: _, ...rest }) => rest)
      await sendReply($, task, text.trim())
    },
    choose: (task, option) => sendReply($, task, option),
    ack: async row => {
      await $.store.set(ackKey(row.id), await $.clock.now())
      await poll($)
    },
    ackAll: async rows => {
      const now = await $.clock.now()
      for (const row of rows) await $.store.set(ackKey(row.id), now)
      await poll($)
    },
    mute: async row => {
      const now = await $.clock.now()
      await $.store.set(ackKey(row.id), now)
      await $.store.set(muteKey(row.id), { text: row.text, at: now })
      await poll($)
    },
    jump: async target => {
      await $.process.run(['open', `claude://claude.ai/epitaxy/${target}`])
    },
    setSettings: async patch => {
      const next: HubSettings = { ...(await read($, settingsAtom)), ...patch }
      await $.store.set(SETTINGS_KEY, next)
      await update($, settingsAtom, () => next)
    },
  }
}

async function sendReply($: EngineInterface, task: OpenTask, answer: string, skipped?: true) {
  const value: Reply = { answer, at: await $.clock.now(), by: rt.sid, ...(skipped ? { skipped } : {}) }
  await $.store.set(replyKey(task.sid, task.id), value)
  await poll($)
}

/**
 * In a plain terminal the panel is a band above the prompt: it draws on the terminal's own
 * background, where a docked pane gets the engine's grey. Elsewhere it is a pane.
 * `toggle` (the /standup command) closes an open band; an arriving task only opens it.
 * Returns whether the panel is showing afterwards.
 */
async function showHub($: EngineInterface, lang: HubSettings['lang'], toggle: boolean) {
  const surfaces = await $.session.surfaces()
  const terminalOnly = surfaces.length > 0 && surfaces.every(s => s === 'terminal')
  if (!terminalOnly) {
    await $.ui.open({ id: HUB_PANE, title: t(lang, 'title'), focus: toggle ? true : undefined })
    return true
  }
  const open = toggle ? !(await read($, bandAtom)) : true
  await update($, bandAtom, () => open)
  return open
}

export const register: Register = on => {
  // The classic host events expose titles; the mods session namespace has no title getter.
  on('classic.SessionStart', async ($, e, next) => {
    await join($)
    if (e.session_title?.trim()) await mutateCard($, card => ({ ...card, title: shortTitle(e.session_title!) }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await join($)
    await mutateCard($, card => ({
      ...card,
      title: shortTitle(e.session_title ?? '') || promptTitle(card.title ?? '') || promptTitle(e.prompt),
    }))
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    await join($)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    void join($).catch(() => undefined)
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'standup:steering', text: STEERING, scope: 'session' as const }] }
  })

  on('command.run', { command: 'standup' }, async ($, e) => {
    await join($)
    const { lang } = await read($, settingsAtom)
    const shown = await showHub($, lang, true)
    return { text: t(lang, shown ? 'opened' : 'closed') }
  })

  on('command.run', { command: 'standup-settings' }, async ($, e) => {
    await join($)
    const { lang } = await read($, settingsAtom)
    await $.ui.open({ id: SETTINGS_PANE, title: t(lang, 'settingsTitle'), focus: true, closeOnEscape: true })
    return { text: t(lang, 'settingsOpened') }
  })

  on('tool.call', { tool: TOOL.assign }, async ($, e) => {
    await join($)
    const input = e as unknown as { kind?: string; title?: string; detail?: string; options?: unknown }
    const kind = input.kind as TaskKind
    const title = String(input.title ?? '').trim()
    if (!['do', 'answer', 'choose'].includes(kind)) return { deny: 'kind must be "do", "answer" or "choose".' }
    if (!title) return { deny: 'title is required.' }
    const options = Array.isArray(input.options) ? input.options.map(String).map(s => s.trim()).filter(Boolean) : []
    if (kind === 'choose' && (options.length < 2 || options.length > 4)) return { deny: 'kind "choose" needs 2 to 4 options.' }

    const now = await $.clock.now()
    const task: Task = {
      id: `t${shortHash(rt.sid + title + now).slice(0, 5)}`,
      kind,
      title,
      ...(input.detail ? { detail: String(input.detail).trim() } : {}),
      ...(kind === 'choose' ? { options } : {}),
      createdAt: now,
    }
    // Checked inside the card's write: parallel calls in one turn would each pass a check made before it.
    let refusal: { result: string } | { deny: string } | undefined
    await mutateCard($, c => {
      const same = duplicateOf(c.tasks, title)
      if (same) refusal = { result: `Already assigned as ${same.id} and still open; not assigned again. The answer will arrive as a message.` }
      else if (c.tasks.length >= MAX_OPEN_TASKS) {
        refusal = { deny: `This session already has ${MAX_OPEN_TASKS} open tasks (${c.tasks.map(x => x.id).join(', ')}). Withdraw one with withdraw_task or wait for answers.` }
      }
      return refusal ? c : { ...c, tasks: [...c.tasks, task] }
    })
    if (refusal) return refusal
    await poll($).catch(() => undefined)
    return { result: `Assigned task ${task.id} to the user in Standup. Do not wait or poll: carry on with work that does not need it, or end your turn. Their answer will arrive as a new message.` }
  })

  on('tool.call', { tool: TOOL.withdraw }, async ($, e) => {
    await join($)
    const id = String((e as unknown as { id?: string }).id ?? '')
    const card = (await $.store.get(cardKey(rt.sid))) as Card
    if (!card.tasks.some(task => task.id === id)) return { deny: `No open task ${id}. Open: ${card.tasks.map(x => x.id).join(', ') || 'none'}.` }
    await mutateCard($, c => ({ ...c, tasks: c.tasks.filter(task => task.id !== id) }))
    await poll($).catch(() => undefined)
    return { result: `Withdrew task ${id}.` }
  })

  on('tool.call', { tool: TOOL.list }, async $ => {
    await join($)
    const card = (await $.store.get(cardKey(rt.sid))) as Card
    return { result: card.tasks.length ? card.tasks.map(taskLine).join('\n') : 'No open tasks.' }
  })

  // Managed plugins may skip session/prompt hooks; ordinary tool calls still join.
  on('tool.call', async ($, e, next) => {
    await join($)
    if (e.agentId === undefined) rt.toolsThisTurn += 1
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    await join($)
    // Recover the first real prompt if it was not yet available at join.
    await heartbeat($)
    if (e.agentId === undefined) {
      if (rt.toolsThisTurn > 0) rt.summaryDue = true
      rt.toolsThisTurn = 0
      rt.held.clear()
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // After a compact, the model has lost the tool results that assigned its tasks: tell it again.
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if ('skip' in result && result.skip !== undefined) return result
    const card = (await $.store.get(cardKey(rt.sid))) as Card | undefined
    if (card?.tasks.length) {
      const text = `[Standup] Tasks you assigned to the user that are still open (answers arrive as messages):\n${card.tasks.map(taskLine).join('\n')}`
      await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    void join($).catch(() => undefined)
    if (e.surface !== 'terminal' || e.props.hasSurvey || !(await read($, bandAtom))) return next(e)
    // Another mod's band content stays, on top: the panel is tall and scrolls, so anything below it would sit out of view.
    const theirs = await next(e)
    const { Box } = $.ui.resolve(e)
    return (
      <Box flexDirection="column" gap="md">
        {theirs}
        {await renderHub($, e, actions($))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: HUB_PANE }, async ($, e) => {
    void join($).catch(() => undefined)
    return renderHub($, e, actions($))
  })

  on('ui.render', { component: 'Pane', requestId: SETTINGS_PANE }, async ($, e) => {
    void join($).catch(() => undefined)
    return renderSettings($, e, actions($))
  })

  // The divider's Client posts the rows it was dragged to.
  on('ui.message', { requestId: HUB_PANE }, async ($, e) => {
    const rows = Number((e.data as { taskRows?: number })?.taskRows)
    if (Number.isFinite(rows)) await actions($).setSettings({ taskRows: Math.max(3, Math.min(60, Math.round(rows))) })
    return {}
  })
}

function taskLine(task: Task) {
  const options = task.options ? ` [${task.options.join(' / ')}]` : ''
  return `- ${task.id} (${task.kind}): ${task.title}${options}`
}

export function replyMessage(task: Task, reply: Reply) {
  if (reply.skipped) return `The user skipped task ${task.id} (${task.title}): no longer needed.`
  if (task.kind === 'do') return `[Standup] The user marked your task ${task.id} as done: "${task.title}".`
  if (task.kind === 'choose') return `[Standup] The user chose "${reply.answer}" for your task ${task.id}: "${task.title}".`
  return `[Standup] The user answered your task ${task.id} ("${task.title}"):\n${reply.answer}`
}

