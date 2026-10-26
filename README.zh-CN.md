# Standup

<p align="center">
  <img src="docs/assets/promo-zh.gif" alt="46 秒看懂 Standup：同时跑 6 个 session，只有你能做的事进待办，回答送回派任务的 session，进展里列出每个项目做完了什么。" />
</p>

<p align="center">
  <a href="./.claude-plugin/plugin.json"><img src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FSma1lboy%2Fclaude-standup%2Fmain%2F.claude-plugin%2Fplugin.json&query=%24.version&label=version&style=flat-square&color=c96442" alt="version" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="MIT license" /></a>
</p>

<p align="center"><a href="README.md">English</a></p>

一个 Claude Code mod：把本机所有 session 汇到一个面板里。上半部分「待办」是各个 agent 等你处理的事，下半部分「进展」是它们做完的事，默认每个项目一行总结，展开可查看按时间倒序排列的消息。

在受管理的环境中，内置插件可能跳过 classic 会话/提示词 hooks 和 `prompt.compose`；此时由工具描述提供引导。Standup 也会在工具调用和回合结束时加入并创建会话卡片，因此这些 hook 被跳过不会阻止注册或更新。

输入框下的任务计数默认关闭，可在 `/standup-settings` 开启。任务默认显示紧凑行，展开可查看详情和回答，超过三条折叠为「更多」。进展默认每个项目一行总结，展开项目后可查看和确认各条消息。

## 安装

需要 Claude Code 2.1.299 或更新版本。

在终端里的 Claude Code 输入：

```
/plugin install standup --marketplace Sma1lboy/claude-standup
```

问是否添加 marketplace 时回 `y`，范围选 user（所有 session 都加载）。

或者在 shell 里：

```bash
claude plugin install standup --marketplace Sma1lboy/claude-standup
```

桌面 app 里 `/plugin` 用不了：点输入框旁边的 +，选 Plugins，Add marketplace 填 `Sma1lboy/claude-standup`，再 Add plugin。

## 用法

- 每个 session 加入时自动打开一次，不抢键盘焦点。手动关闭后，轮询和后续回合不会重新打开；来任务时自动打开由单独的设置控制。
- `/standup` 打开面板。纯终端里它是输入框上方的一块区域，直接用终端自己的背景(透明)，再输一次 `/standup` 收起；桌面 app 里是右侧面板。
- `/standup-settings` 打开设置：语言（中文 / English，默认中文）、会话开始时自动打开（默认开）、来任务时自动打开面板（默认开）、待办和进展之间的可拖动分隔线（默认关）、消息上的「不再显示这类」按钮（默认关）。设置对本机所有 session 生效。
- 状态栏显示 `N 个任务等你 · /standup`，是所有 session 加起来的待办数。

- 待办和进展行显示 `项目 · 分支 · 会话标题`。Worktree 使用仓库名，分支每分钟刷新；标题优先用宿主提供的名称，再用首条用户提示（最多 80 字符），最后回退到目录名。旧卡片仍可读取。进展按项目分块，项目按最新未读进展排序，块内按时间从新到旧排列。

### 待办

Claude 遇到只有你能做的事，比如放密钥、在你的机器或账号上操作、需要你拍板、需要你 review 或批准，就会调用 `assign_task` 派一个任务。任务分三种：

- **去做**：你去做，做完点「完成」。
- **回答**：你写几句话。
- **选择**：在 2 到 4 个选项里挑一个。

在任何一个 session 的面板里都能处理，结果会送回派任务的那个 session：那边的 Claude 空闲时立刻作为一条新消息收到，正在忙就等这一轮结束再收到。

几条防护：

- 回答看起来像密钥（`sk-…`、`ghp_…`、`AKIA…`、私钥块、JWT、`password=…`、很长的大小写混合串）会被拒收，避免写进对话记录。
- 每个 session 最多同时开 5 个任务。
- 同一件事还没处理时不会重复派。
- Claude 可以用 `withdraw_task` 撤回任务，用 `list_tasks` 查看还没处理的任务。
- 上下文 compact 之后，会重新告诉 Claude 哪些任务还开着。
- 待办超过 3 条时，后面的收进「还有 N 个」，点一下展开，进展区不会被挤到看不见。

### 进展

某个 session 跑完一轮用过工具的对话后，Standup 用 Haiku 读它的对话记录写一份总结，同一个 session 至少隔 30 分钟才写一次；Haiku 不可用时改用这个 session 自己的模型。整个面板跨所有 session 每 30 分钟最多新增一条消息，依据已有授权执行的重要操作也计入这个限制。被其他 session 抢先发布挡住的总结稍后重试，不消耗原来的基线。每轮选最新的一条新成果，没有新成果时才选一条授权操作，并保存完整总结作为下一轮基线。

成果指这个 session 的总目标完成，或其中一个重要阶段完成：像每日站会的汇报，而不是每个 PR、MR 或单次运行。成果标题不写 PR/MR 编号。读代码、回答问题、计划、做了一半的步骤、commit，都不算。Claude 依据已有授权（memory、CLAUDE.md、settings，或之前一句笼统的同意）没问你就做了的重要操作，比如合并、发版、部署，也会记一条，末尾写明依据哪条授权。

总结提示词会看到所有 session 最近 60 条进展，并要求不要重复已汇报的成果。发布前还会丢弃与其他 session 的近期消息归一化后高度重合的文本。已读消息和已离开的 session 仍参与去重和全局间隔计算。

消息在 session 关闭后仍然保留。**OK** 在所有 session 里隐藏这一条，**全部已读**一次隐藏全部。打开「不再显示这类」后，点它除了隐藏，还会把这条存成屏蔽项，以后所有 session 写总结时都会跳过同类内容（是否同类由模型判断）。总结失败时，进展区会显示「<项目>：进展已暂停：<原因>」，不会悄悄吞掉。

待办上的**跳转 ↗**会让桌面 app 切到派任务的那个 session（执行 `open claude://claude.ai/epitaxy/<id>`）。纯终端里跑的 session 没有这个 id，所以不显示跳转。

### 怎么让 Claude 用起来

mod 在 system prompt 末尾加了一段：只有你能做的事要用 `assign_task` 派，回复里问过也要派；没有的密钥一律派任务。但如果这类操作你已经长期授权过，就直接做，并在回复末尾写一行「做了什么、依据哪条授权」，进展区就是靠这一行抓到的。三个工具的描述里写了同样的规则，并且设成不延迟加载，模型每一轮都能看到。

公司托管的 Claude Code 环境里，`prompt.compose` 和 `session.compact` 这两类 hook 只对管理员白名单里的插件生效。这种情况下 system prompt 那段和 compact 之后的提醒都不会生效，只能靠工具描述起作用。

## 原理

所有数据存在 mod 的 `$.store` 里，也就是 `~/.claude/plugins/store/` 下的一个 JSON 文件。每个 session 只写自己的 key，所以不会互相覆盖：

| Key | 内容 | 谁写 |
| --- | --- | --- |
| `card:<session>` | 这个 session 的任务、进展、上一份总结、心跳 | 这个 session |
| `reply:<session>:<task>` | 某个任务的回答 | 回答它的那个 session |
| `ack:<消息>` | 某条消息的 OK | 任意 session |
| `mute:<消息>` | 「不再显示这类」 | 任意 session |
| `settings` | 设置 | 任意 session |
| `feed-claim:<session>` | 临时发布占用时间戳 | 这个 session |

每个 session 每 3 秒读一次 store，每 60 秒写一次心跳。超过 3 分钟没心跳的 session 视为已离开，它的待办从面板上消失。超过 7 天的卡片、回答、OK 和遗留的发布占用会被清理，屏蔽项保留。发布占用让并发写入依次进行，写入后（包括失败时）会释放；进程崩溃遗留的占用在 30 分钟后失效。原有 card 和 settings 数据格式不变。

`/reload-plugins` 不会触发 `session.start`，所以加入 store、注册命令和工具都在第一个运行的 hook 里补上。

## 样例数据

```bash
bun scripts/demo.ts
```

往已安装 mod 的 store 里加几个虚构的 session（带任务和进展），在面板上保留 2 小时，适合截图。`bun scripts/demo.ts --clear` 清掉。

## 开发

PATH 上的 `claude` 要是 2.1.299 或更新版本，不然 `validate` 会把它还不认识的 hook 当成错误。桌面 app 自带的版本在 `$CLAUDE_CODE_EXECPATH`。

```bash
claude plugin validate .claude-plugin/plugin.json
```

```bash
claude plugin test .
```

```bash
bun evals/run.ts all
```

55 个单测覆盖派任务（含同一轮并发派发）、跨 session 回答、拒收密钥、回答送达（被别的 hook 拦下的留到这一轮结束后再送，轮询重叠时只送一次）、离开的 session、总目标级提示词、跨 session 去重、全局 30 分钟间隔和并发发布、模型回退、暂停提示、OK 和全部已读、屏蔽、设置同步、自动打开、面板保留别的 mod 在输入框上方的内容、reload 后的注册、system prompt 那段、compact 后的提醒、跳转、分隔线、待办折叠和清理，终端和桌面两种界面都测。eval 用真实模型跑，结果追加到 `evals/results.jsonl`，并和上一轮对比标出 `fixed` 或 `REGRESSED`：总结 12 个用例（Haiku，约 $0.02 一轮），派任务行为 5 个用例（Opus，每个用例一个临时 git 沙盒，约 $1.6 一轮）。eval 通过 `--plugin-dir` 加载 mod，用的是单独的 store，测试任务不会出现在你真实的面板里。

## 许可

MIT
