# Standup

<p align="center">
  <img src="docs/assets/promo-en.gif" alt="Standup in 46 seconds: six sessions at once, tasks only you can do land in To do, an answer goes back to the session that asked, and the Summary lists what each project got done." />
</p>

<p align="center">
  <a href="./.claude-plugin/plugin.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FSma1lboy%2Fclaude-standup%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&style=flat-square&color=c96442" alt="version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license" /></a>
</p>

<p align="center"><a href="README.zh-CN.md">中文说明</a></p>

A Claude Code mod that puts every session on your machine into one panel. The top half, To do, lists what each agent is waiting on you for. The bottom half, Summary, shows what the agents got done: one compact summary per project, with messages available on expansion.

In managed environments, built-in plugins may skip the classic session/prompt hooks and `prompt.compose`. Steering then falls back to the tool descriptions. Standup also joins and creates its session card on tool calls and turn completion, so these skipped hooks do not prevent registration or updates.

Task counts under the prompt are off by default; enable them in `/standup-settings`. Tasks start as compact rows (expand for details and answers), with three visible before “more”. Updates start as one summary line per project; expand a project to read and acknowledge its rows.

## Install

Needs Claude Code 2.1.299 or newer.

At the prompt of a terminal session:

```
/plugin install standup --marketplace Sma1lboy/claude-standup
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```bash
claude plugin install standup --marketplace Sma1lboy/claude-standup
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Sma1lboy/claude-standup`, then Add plugin.

Working on the mod itself? Add your clone as a local marketplace instead (`claude plugin marketplace add <folder>`, then `claude plugin install standup@standup`); edits are then picked up by `/reload-plugins` with no reinstall.

## Use

- The hub opens once when a session joins, without taking keyboard focus. Closing it keeps it closed on subsequent polls and turns; task-arrival auto-open remains a separate setting.
- `/standup` opens the panel. In a plain terminal it is a band above the prompt, drawn on the terminal's own background, and `/standup` again folds it away; in the desktop app it is a pane.
- `/standup-settings` opens the settings: language (中文 or English, default 中文), open on session start (default on), open the panel when a task arrives (default on), draggable divider between the two halves (default off), the "No more like this" button on messages (default off). Settings apply to every session on the machine.
- The status line shows `N tasks need you · /standup`, counted across all sessions.

- Task and update rows identify `project · branch · session title`. Linked worktrees use their repository name; branches refresh every minute. Titles use the host title when available, then the first prompt (up to 80 characters), then the folder name. Older cards remain readable. Updates are grouped into project blocks, ordered by their newest unread update; each block lists updates newest first.

### Tasks

When Claude needs something only you can do (put a key in place, act on your machine or accounts, make a call that is yours, review or approve), it calls `assign_task`. A task is one of:

- **do**: you go do it, then press Done.
- **answer**: you type a few words.
- **choose**: you pick one of 2 to 4 options.

You can answer from the panel in any session. The answer goes back to the session that asked: if that Claude is idle it gets the answer as a new message at once; if it is busy, after its current turn.

Guards:

- An answer that looks like a key or token (`sk-…`, `ghp_…`, `AKIA…`, a private key block, a JWT, `password=…`, a long mixed-case token) is refused, so it never lands in a transcript.
- At most 5 open tasks per session.
- The same ask is not assigned twice while it is open.
- Claude can take a task back with `withdraw_task`, and list its open ones with `list_tasks`.
- After a compact, Claude is told again which of its tasks are still open.

### Summary

After each turn that used tools, Standup asks Haiku to summarize that session's transcript, at most once every 30 minutes per session. If Haiku is unavailable it uses the session's own model. The whole panel admits at most one new message every 30 minutes across all sessions, including consequential authorized actions. A session delayed by another publication retries later without losing its baseline. Each run keeps the newest unseen milestone, or an authorized action if there is no new milestone, and retains the full summary as its next baseline.

A milestone is the session’s overarching goal finishing, or a major stage of that goal: a daily standup update, not each PR, MR or finished run. PR/MR numbers do not belong in milestone headlines. Reading code, answering a question, a plan, a half-finished step or a commit never count. Consequential things Claude did without asking (a merge, a release, a deploy) because your memory, CLAUDE.md, settings or an earlier general yes covered it get a message too, with the permission named at the end.

The prompt sees the latest 60 feed items across all sessions as already reported. New lines with strongly overlapping normalized text from another session are also dropped before publication. Read messages and departed sessions still count for deduplication and cadence.

Messages stay after their session closes. **OK** hides a message in every session. **No more like this** (turn it on in `/standup-settings`) also saves it as a mute: later summaries in every session skip things of that kind (the model judges what is similar). If summarizing fails, the Summary section says `<project>: Updates paused: <reason>`.

**Open ↗** on a task switches the desktop app to the session that handed it out (`open claude://claude.ai/epitaxy/<id>`). Tasks from this session, and from sessions running in a plain terminal (which have no such id), show no Open. Summary messages have no Open.

### How Claude is told to use it

The mod adds a section to the end of the system prompt: things only you can do go through `assign_task`, even if Claude also asked in its reply, and a missing secret is always a task. If you already gave a standing permission for that kind of action, Claude does it without asking and ends its reply with one line saying what it did and under which permission, which is what those messages pick up. The three tool descriptions carry the same rule and are loaded up front, so the model sees them every turn.

Where an organization manages Claude Code, `prompt.compose` and `session.compact` hooks run only for plugins listed in managed settings. There the system-prompt section and the after-compact reminder are skipped, and the tool descriptions alone carry the rule.

## How it works

All data lives in the mod's `$.store`, one JSON file under `~/.claude/plugins/store/`. Each session writes only its own keys, so sessions never overwrite each other:

| Key | Holds | Written by |
| --- | --- | --- |
| `card:<session>` | that session's tasks, feed, last summary, heartbeat | that session |
| `reply:<session>:<task>` | an answer to one task | whichever session answered |
| `ack:<message>` | OK on a message | any session |
| `mute:<message>` | a "No more like this" | any session |
| `settings` | the settings | any session |
| `feed-claim:<session>` | temporary publication claim timestamp | that session |

Every session reads the store every 3 seconds and writes a heartbeat every 60. A session with no heartbeat for 3 minutes is treated as gone and its tasks leave the panel. Cards, replies, OKs and abandoned claims older than 7 days are deleted; mutes are kept. Publication claims serialize competing writers and are removed after the write, including failures; a crashed writer’s claim expires after 30 minutes. Existing card and settings formats are unchanged.

`/reload-plugins` does not fire `session.start`, so joining the store and registering the commands and tools happens on whichever hook runs first.

The panel is one TSX tree for the terminal and the desktop app, using Claude Code's theme colors only (`claude` orange as the accent; `warning`, `success`, `error`, `subtle` for meaning). Cards have round borders that turn orange on hover, and lay out by the pane's width: in a narrow dock the options of a choose-task stack, a long detail is cut to two lines. The divider, when on, is a short handle drawn by a `Client` module that takes the drag and posts the new task-area height.

## Demo data

```bash
bun scripts/demo.ts
```

Adds three made-up sessions (tasks and messages) to the installed mod's store, visible for two hours. `bun scripts/demo.ts --clear` removes them.

## Develop

The `claude` on your PATH must be 2.1.299 or newer, or `validate` rejects the hooks it does not know yet. The desktop app's own binary is at `$CLAUDE_CODE_EXECPATH`.

```bash
claude plugin validate .claude-plugin/plugin.json
```

```bash
claude plugin test .
```

55 unit tests cover assigning (parallel calls included), cross-session answers, secret refusal, reply delivery (a dropped prompt kept for after the turn, overlapping polls submitting once), stale sessions, goal-level prompts, shared-feed deduplication, the global 30-minute gap and competing publications, model fallback, paused updates, OK and mutes, settings sync, auto-open, the band keeping other mods' content, registration after a reload, the system-prompt section, the after-compact reminder, Jump, the divider, and pruning, on both the terminal and desktop surfaces.

```bash
bun evals/run.ts all
```

Runs real models and appends to `evals/results.jsonl`, marking each case `fixed` or `REGRESSED` against its last run:

- **summary**: 12 cases on Haiku (outcomes only, commits and fix-ups folded into one short line with no hashes or commands, small follow-ups after a goal adding nothing, consequential unasked work caught, routine commits and approved-just-now not counted, old lines kept verbatim, mutes respected, Chinese sessions get Chinese lines). About $0.01 a run.
- **assign**: 5 cases on Opus, each in a fresh git sandbox (missing secret → do-task, plain edit → nothing, your decision → choose-task, standing permission → no task and the reply names it, sign-off → task). About $1.6 a run.

Evals load the mod with `--plugin-dir`, which gets its own store, so test tasks never show up in your real panel.

## License

MIT
