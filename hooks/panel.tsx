import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { HubSettings } from '../types'
import { DEFAULT_SETTINGS, ago, feedGroups, openTasks, pausedCards, t } from './hub'
import { sourceLabel } from './source'
import type { CopyKey, FeedRow, OpenTask } from './hub'

const snapAtom = atom({ plugin: 'standup', key: 'snap' } as const, null)
const settingsAtom = atom({ plugin: 'standup', key: 'settings' } as const, DEFAULT_SETTINGS)
const errorsAtom = atom({ plugin: 'standup', key: 'errors' } as const, {})
const showAllAtom = atom({ plugin: 'standup', key: 'showAllTasks' } as const, false)

const expandedAtom = atom({ plugin: 'standup', key: 'expandedRows' } as const, {})

// Tasks shown before "+N more", so the summary below stays in view.
const TASKS_SHOWN = 3

// The panel: tasks on top, the feed below. One tree for every surface;
// Claude Code's theme keys only, with claude orange as the one accent.

export type Actions = {
  complete: (task: OpenTask) => Promise<void>
  skip: (task: OpenTask) => Promise<void>
  answer: (task: OpenTask, text: string) => Promise<void>
  choose: (task: OpenTask, option: string) => Promise<void>
  ack: (row: FeedRow) => Promise<void>
  ackAll: (rows: readonly FeedRow[]) => Promise<void>
  mute: (row: FeedRow) => Promise<void>
  jump: (hostId: string) => Promise<void>
  setSettings: (patch: Partial<HubSettings>) => Promise<void>
}

type PaneInput = RenderInput<'Pane'> | RenderInput<'AbovePrompt'>

const LANGS = [
  ['en', 'English'],
  ['zh', '中文'],
] as const

const KIND_KEY: Record<OpenTask['kind'], CopyKey> = { do: 'kindDo', answer: 'kindAnswer', choose: 'kindChoose' }

export async function renderHub($: EngineInterface, e: PaneInput, act: Actions): Promise<RenderElement> {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  // Mobile has no text field: answers are typed on another surface there.
  const Input = 'Input' in els ? els.Input : undefined
  const snap = await read($, snapAtom)
  const settings = (await read($, settingsAtom)) ?? DEFAULT_SETTINGS
  const errors = (await read($, errorsAtom)) ?? {}
  const showAll = (await read($, showAllAtom)) ?? false
  const expanded = (await read($, expandedAtom)) ?? {}
  const toggleRow = (key: string) => update($, expandedAtom, rows => ({ ...rows, [key]: !rows[key] }))
  const now = await $.clock.now()
  const { lang } = settings
  const tx = (key: CopyKey, vars?: Record<string, string | number>) => t(lang, key, vars)

  const tasks = snap ? openTasks(snap, now) : []
  const groups = snap ? feedGroups(snap) : []
  const feed = groups.flatMap(group => group.rows)
  const paused = snap ? pausedCards(snap, now) : []
  const selfHost = snap?.cards.find(c => c.sid === snap.self)?.hostId
  const header = (label: string, count: number, accent: boolean) => (
    <Text size="heading" weight="semibold">
      {label} <Text weight="regular" color={accent && count > 0 ? 'claude' : 'subtle'}>{count}</Text>
    </Text>
  )

  const taskCard = (task: OpenTask) => {
    const key = `${task.sid}:${task.id}`
    const options = task.options ?? []
    return (
      <Box key={`task-${key}`} flexDirection="column">
        <Box key={`task-line-${key}`} flexDirection="row" gap={1} alignItems="center">
          <Button key={`expand-${key}`} plain label={expanded[key] ? '▾' : '▸'} onPress={() => toggleRow(key)} />
          <Box flexShrink={1} flexGrow={1}><Text wrap="truncate-end"><Text weight="semibold">{task.title}</Text> · {task.project || task.name} · {ago(lang, task.createdAt, now, true)}</Text></Box>
          {task.kind === 'do' ? <Button key={`done-${key}`} plain label={tx('done')} onPress={() => act.complete(task)} /> : null}
          <Button key={`skip-${key}`} plain dimColor label={tx('skip')} onPress={() => act.skip(task)} />
        </Box>
        {expanded[key] ? (
          <Box flexDirection="column" paddingX="sm">
            <Text weight="semibold">{task.title}</Text>
            <Text size="footnote" dimColor>{task.name} · {tx(KIND_KEY[task.kind])}</Text>
            {task.detail ? <Text>{task.detail}</Text> : null}
            {task.hostId && task.hostId !== selfHost ? <Button key={`jump-${key}`} plain label={tx('jump')} onPress={() => act.jump(task.hostId!)} /> : null}
            {task.kind === 'choose' ? <Box flexDirection="row" flexWrap="wrap" gap="sm">{options.map((option, i) => <Button key={`opt-${key}-${i}`} label={option} onPress={() => act.choose(task, option)} />)}</Box> : null}
            {task.kind === 'answer' && Input ? <Input key={`ans-${key}`} placeholder={tx('answerPlaceholder')} submitLabel={tx('send')} onSubmit={(value: string) => value.trim() ? act.answer(task, value) : undefined} /> : null}
          </Box>
        ) : null}
        {errors[key] ? <Text color="error">{errors[key]}</Text> : null}
      </Box>
    )
  }

  const feedCard = (row: FeedRow) => (
    <Box key={`feed-${row.id}`} flexDirection="column">
      <Box key={`feed-line-${row.id}`} flexDirection="row" gap={1} alignItems="center">
        <Button key={`expand-feed-${row.id}`} plain label={expanded[`feed:${row.id}`] ? '▾' : '▸'} onPress={() => toggleRow(`feed:${row.id}`)} />
        <Box flexShrink={1} flexGrow={1}><Text wrap="truncate-end">✓ <Text>{row.text}</Text> · {row.project} · {ago(lang, row.at, now, true)}</Text></Box>
        <Button key={`ok-${row.id}`} plain dimColor label={tx('ok')} onPress={() => act.ack(row)} />
        {settings.muteButton ? <Button key={`mute-${row.id}`} plain dimColor label={tx('noMore')} onPress={() => act.mute(row)} /> : null}
      </Box>
      {expanded[`feed:${row.id}`] ? <Box flexDirection="column" paddingX="sm"><Text>{row.text}</Text><Text size="footnote" dimColor>{row.name}</Text></Box> : null}
    </Box>
  )

  const taskList = (
    <Box flexDirection="column" rowGap={0}>
      {tasks.length === 0 ? <Text dimColor>{tx('nothingWaiting')}</Text> : (showAll ? tasks : tasks.slice(0, TASKS_SHOWN)).map(taskCard)}
      {tasks.length > TASKS_SHOWN ? (
        <Box key="more-tasks-row" flexDirection="row">
          <Button
            key="more-tasks"
            plain
            dimColor
            hover={{ dimColor: false }}
            label={showAll ? tx('fewerTasks') : tx('moreTasks', { n: tasks.length - TASKS_SHOWN })}
            onPress={() => update($, showAllAtom, v => !v)}
          />
        </Box>
      ) : null}
    </Box>
  )

  return (
    <Box flexDirection="column" gap="md">
      <Box flexDirection="column" rowGap="sm">
        {header(tx('needsYou'), tasks.length, true)}
        {settings.divider ? (
          <Box flexDirection="column" height={settings.taskRows} overflow="hidden">
            {taskList}
          </Box>
        ) : (
          taskList
        )}
      </Box>
      {settings.divider ? divider($, e, settings.taskRows) : null}
      <Box flexDirection="column" rowGap="sm">
        <Box key="summary-header" flexDirection="row" justifyContent="space-between" alignItems="center">
          {header(tx('updates'), feed.length, false)}
          {feed.length > 1 ? (
            <Button key="ack-all" plain dimColor hover={{ dimColor: false }} label={tx('okAll')} onPress={() => act.ackAll(feed)} />
          ) : null}
        </Box>
        {paused.map(card => (
          <Text key={`paused-${card.sid}`} color="warning">
            {sourceLabel(card)}: {tx('paused', { reason: card.paused ?? '' })}
          </Text>
        ))}
        <Box flexDirection="column" rowGap={0}>
          {feed.length === 0 ? <Text dimColor>{tx('noUpdates')}</Text> : groups.map(group => (
            <Box key={`project-${group.project}`} flexDirection="column" rowGap={0}>
              <Box flexDirection="row" gap={1}>
                <Button key={`expand-project-${group.project}`} plain label={expanded[`project:${group.project}`] ? '▾' : '▸'} onPress={() => toggleRow(`project:${group.project}`)} />
                <Box flexShrink={1} flexGrow={1}><Text wrap="truncate-end">{group.project}: {group.rows[0]!.text} · {tx('updateCount', { n: group.rows.length })}</Text></Box>
              </Box>
              {expanded[`project:${group.project}`] ? group.rows.map(feedCard) : null}
            </Box>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

/** The drag handle: a Client on the surfaces that have one, nothing elsewhere. */
function divider($: EngineInterface, e: PaneInput, rows: number) {
  if (e.surface !== 'terminal' && e.surface !== 'desktop') return null
  const { Client } = $.ui.resolve({ ...e, surface: e.surface })
  return <Client key="divider" module="./divider.tsx" props={{ rows }} height={1} />
}

export async function renderSettings($: EngineInterface, e: PaneInput, act: Actions): Promise<RenderElement> {
  const { Box, Text, Button } = $.ui.resolve(e)
  const settings = (await read($, settingsAtom)) ?? DEFAULT_SETTINGS
  const tx = (key: CopyKey) => t(settings.lang, key)
  const toggle = (key: 'openOnStart' | 'autoOpen' | 'divider' | 'muteButton' | 'showStatus') => (
    <Box flexDirection="row" gap="sm">
      {([true, false] as const).map(on => (
        <Button key={`toggle-${key}-${on ? 'on' : 'off'}`} variant={settings[key] === on ? 'primary' : 'secondary'} label={on ? tx('on') : tx('off')} onPress={() => act.setSettings({ [key]: on })} />
      ))}
    </Box>
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('language')}</Text>
        <Box flexDirection="row" gap="sm">
          {LANGS.map(([value, label]) => (
            <Button key={`lang-${value}`} variant={settings.lang === value ? 'primary' : 'secondary'} label={label} onPress={() => act.setSettings({ lang: value })} />
          ))}
        </Box>
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('openOnStart')}</Text>
        {toggle('openOnStart')}
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('autoOpen')}</Text>
        {toggle('autoOpen')}
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('divider')}</Text>
        {toggle('divider')}
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('showStatus')}</Text>
        {toggle('showStatus')}
      </Box>
      <Box flexDirection="row" gap={2} alignItems="center">
        <Text>{tx('muteButton')}</Text>
        {toggle('muteButton')}
      </Box>
      <Text dimColor>{tx('settingsNote')}</Text>
    </Box>
  )
}
