# SubAgent View mod 设计

日期：2026-11-02

## 意图

派出好几个 subagent 并行干活时，用户想一眼看到四件事：**还有几个在跑、各自在干什么、各自还剩几步、大概还要多久**。现有的 task-progress 只在 band 展开后列出「↳ subagent 说明 + 运行中」，看不到每个 subagent 内部的进度，而且它会主动忽略 subagent 自己列的计划（TodoWrite / TaskCreate）。SubAgent View 用的正是这份数据。

SubAgent View 是一个 Claude Code mod：对话右侧的一个 pane，由用户手动开关（`/subagents` 命令，或 quick-tools 面板里的开关）。

## 目标

- pane 顶部是总览：几个在跑 / 完成 / 失败，所有在跑的 subagent 合计剩余步数，以及预计剩余时间。
- 每个在跑的 subagent 占一块：avatar + 短名称（按 agent 类型），任务说明，已跑时长，它自己计划的进度（胶囊 + `3/7` + 剩几步 + 预计剩余），以及当前在做的那一步。
- 结束的 subagent（完成 / 失败 / 被停）缩成一行，放到底部「已结束」下。
- 用 `/subagents` 命令开关 pane；quick-tools 面板在 ULTRA 下面加一个 `◧ SubAgents` 开关，效果一样。
- 不需要模型配合：只观察模型本来就会做的事（派 agent、subagent 列计划、调工具）。
- terminal 与 desktop 都画（desktop 上 Text 用 `mono` 保证列对齐，文案与 terminal 一致）；vscode / mobile 直接 `next(e)`。用户 2026-11-02 要求支持桌面 app。

## 非目标

- 真实的百分比进度：只有计划的步数可数，预计时间只是估算。
- 嵌套的 subagent（subagent 再派出去的）、workflow 的 agent、teammate：不显示（用户确认「只看主会话派的」）。
- 跨 session 的历史：只看当前 session。
- 自动弹出 / 自动收起：用户明确要手动开关。
- quick-tools 开关旁显示在跑数量：用户明确不要。

## 反目标（做到了也算失败）

- 显示的 subagent 状态和实际不符：已结束的还在转圈，或在跑的被漏掉（前台、后台都要覆盖）。
- subagent 的步数被主会话的计划污染，或者反过来，主会话的计划被算到某个 subagent 头上。
- pane 关着时还在定时重绘：动画只在 pane 打开、且有 subagent 在跑时运行。
- 改坏 quick-tools 已有的模型 / effort / ULTRA 切换，或者改坏它和 task-progress 在 band 上的组合。

## 外观（用户选定：侧边 pane，设计稿 v3）

pane 标题：`SubAgent View`。

```
SubAgent View          3 在跑  1 完成  1 失败
合计剩余 12 步   剩余时间约 6 分钟
──────────────────────────────────────────────
🎨 Designer  出登录页设计稿         ⠋ 4m12s
   ▰▰▰▱▱▱▱  3/7  剩 4 步             ≈ 5m
   › 正在画表单状态

🧰 General   实现登录接口           ⠋ 1m03s
   ▰▱▱▱  1/4  剩 3 步                ≈ 3m
   › 正在写测试

🧰 General   迁移数据库             ⠋ 0m18s
   ▱▱▱▱▱  0/5  剩 5 步            估算中
   › 正在读 schema

🔭 Explore   搜索调用点             ⠋ 0m40s
   没有计划   最近：Grep "useAuth"
──────────────────────────────────────────────
已结束
✓ 🎬 Motion   打击感时间轴   4/4        2m30s
✗ 🔍 Reviewer 审查 spec     停在 2/6   1m10s
```

### 总览（前两行）

- 第 1 行：标题（蓝色加粗）+ `N 在跑`（蓝）`N 完成`（绿）`N 失败`（红）。某项为 0 时不显示（我的决定）。
- 第 2 行：`合计剩余 N 步   剩余时间约 M 分钟`（用户定的措辞）。
  - N = 在跑且有计划的 subagent 的剩余步数（未完成的步数，包括进行中的那一步）之和。
  - 剩余时间取在跑的 subagent 里预计剩余最长的那个（它们并行跑）。
  - 所有在跑的都没有计划，或都在「估算中」时，对应部分不显示；没有 subagent 在跑时整行不显示（我的决定）。

### 每个在跑的 subagent（3 行，块之间空一行）

- 第 1 行：avatar + 短名称（加粗）+ 任务说明（派它时 `Agent` 工具的 `description`）+ 靠右的转圈 `⠋`（蓝，braille 帧动画）+ 已跑时长（dim，`4m12s`，超过 1 小时显示 `1h03m`）。
- 第 2 行（有计划时）：胶囊进度（完成 = 绿 `▰`，进行中 = 蓝 `▰`，未开始 = 暗 `▱`，每步一个）+ `3/7`（蓝，已完成数 / 总数）+ `剩 N 步`（dim）+ 靠右 `≈ 5m`（黄）或 `估算中`（dim）。
- 第 3 行（有计划时）：`› ` + 当前进行中那一步的 `activeForm`（没有就用标题），蓝色。没有进行中的步骤时显示下一个未开始步骤的标题，dim（我的决定）。
- 没有计划时只有两行：第 2 行是 `没有计划   最近：<工具名> <简短参数>`（dim），简短参数取这次调用最能说明意图的字段（如 Grep 的 pattern、Read 的文件名、Bash 的 description），由 builder 决定；还没调过工具时只写 `没有计划`。
- 胶囊超过可用宽度时截断，`3/7` 一定保留；说明文字过长截断加 `…`。

### 已结束

- 分隔线下一行 `已结束`（dim），然后每个结束的 subagent 一行：
  - 完成：`✓`（绿）+ avatar + 短名称 + 说明（整体 dim）+ `4/4`（绿，没有计划时省略）+ 总用时。
  - 失败或被停：`✗`（红）+ avatar + 短名称 + 说明（dim）+ `停在 2/6`（红；没有计划时写 `失败` 或 `已停止`）+ 总用时。
- 按结束时间倒序（最近结束的在上；我的决定）。

### 没有 subagent 时

```
SubAgent View

这个 session 还没派出 subagent。
派出后会出现在这里。
```

### Avatar 与短名称

按派出时的 agent 类型（`agent.spawn` 的 `subagentType`）决定，和任务无关。同一类型用同一个 avatar，靠任务说明区分在干什么（用户决定）。

| avatar | 短名称 | agent 类型 |
| --- | --- | --- |
| 🧰 | General | `general-purpose` |
| 🔭 | Explore | `Explore` |
| 🧭 | Plan | `Plan` |
| 📖 | Guide | `claude-code-guide` |
| 📟 | Statusline | `statusline-setup` |
| 🤖 | Claude | `claude`（兜底类型） |
| 🎨 | Designer | `designer` |
| 🥊 | Combat | `combat-designer` |
| 🎬 | Motion | `motion-director` |

- 表里没有的类型：按类型名里的关键词猜：`review` → 🔍、`test` → 🧪、`debug` → 🐛、`doc` / `writer` → 📝、`security` → 🛡️、`data` → 📊；都对不上就用 🧩。短名称取类型名，去掉连字符后首字母大写，超过 10 个字符截断。（我的设计，用户看过同意）
- 类型名比较不区分大小写。表写在 mod 代码里，加 agent 时改一行即可。
- emoji 在终端里按 2 列算；避免带 VS16（`U+FE0F`）的 emoji 用在需要对齐的位置（🛡️ 例外，只出现在兜底猜测里，builder 可换成不带 VS16 的）。

### quick-tools 开关

在 quick-tools 展开面板的 `✦ ULTRA` 那行下面加一行 ` ◧ SubAgents ` 徽章，它本身就是开关：

- pane 打开：蓝底（`#8ab4ff`）深字；关闭：灰底 dim 字（与 ULTRA 关闭时同一套 `GREY`）。
- 不显示数量（用户决定）。
- 收起状态的 `⚡ …` 按钮不变。

配色沿用 task-progress：绿 `#7ec699`、蓝 `#8ab4ff`、dim `#6b7480`、暗胶囊 `#3b424d`、完成名 `#55606e`；新增黄 `#e5c07b`（预计时间）、红 `#ef7b7b`（失败）。能用 engine theme key 的优先用 key（如 `success` / `error` / `warning`），具体由 builder 取舍。

## 行为

- **开关**：`/subagents` 命令切换 pane 的打开 / 关闭（`$.ui.open` / 关闭）。pane 默认关闭。quick-tools 的开关做同一件事，并且读到 pane 当前是否打开来决定蓝 / 灰。
- **跟踪哪些 subagent**：只跟踪主会话派出的（`agent.spawn` 的 `parentAgentId` 为空、不是 workflow 的、不是 teammate）。记录 `agentId`、`subagentType`、`description`、开始时间。
- **结束**：前台、后台都要覆盖（task-progress 用 `turn.complete` 带 `agentId` + `$.agent.list()` 自愈，可参照）。结束时区分完成 / 失败 / 被停（`$.agent.list()` 的 status 有 `completed` / `failed` / `killed`），记下结束时间。
- **subagent 的计划**：`tool.call` 的 `agentId` 等于某个被跟踪的 subagent 时：
  - `TodoWrite`：整表替换这个 subagent 的计划。
  - `TaskCreate`：追加到这个 subagent 的计划。
  - `TaskUpdate`：按 `taskId` 更新它所在的那个计划（谁建的就属于谁，不看谁调的）。`deleted` 时移除。
  - 主会话（没有 `agentId`）的计划不进任何 subagent。
  - 调用失败（`deny`、`isError`、`TaskUpdate` 的 `success === false`）不改状态。
  - 读结果的方式与 task-progress 一致（`await next(e)` 后读 `newTodos` / `task.id`），builder 可复用它 `logic.ts` 里的做法。
- **被叫醒（resume）**（用户决定）：已结束的 subagent 被 SendMessage 叫醒（`agent.spawn` 带 `resume.agentId`，id 不变）时，不新建一条，而是把原记录从「已结束」挪回「在跑」，保留原计划接着算，已跑时长从被叫醒那一刻重新计时。预计剩余只用叫醒后完成的步数和时长来估算，叫醒后还没完成任何一步时显示 `估算中`（我的决定，避免拿旧步数配新时长导致估算偏小）。
- **哪些不算「主会话派的」**（我的决定）：别的 mod 用 `$.agent.spawn` 派出的 agent（带 `spawnedBy`）不显示，只显示模型派出的。
- **失败计数**（我的决定）：被停（killed）算进总览的「N 失败」。
- **最近工具**：`tool.call` 的 `agentId` 属于被跟踪的 subagent 时，记下工具名和简短参数，供「没有计划」的那行使用。
- **预计剩余时间**（我的设计，用户看过同意）：`已跑时长 ÷ 已完成步数 × 剩余步数`。已完成步数为 0 时显示 `估算中`。没有计划的不估算。显示粒度：小于 1 分钟显示 `<1m`，否则四舍五入到分钟。
- **时长与动画**：pane 打开且有 subagent 在跑时，用 `$.clock.every` 推进转圈帧并刷新时长（约每 160ms 推一帧，时长按秒变化即可）；pane 关闭或没有在跑的时停掉计时器。
- **保留多久**：已结束的 subagent 保留到 session 结束（`/clear` 后清空；我的决定）。
- **pane 宽度**：pane 由用户手动打开，任何宽度都会放下；窄时截断说明文字，优先保留 avatar、短名称、`3/7`、时长。

## 约束

- 新 mod：源码放在本仓库 `mods/subagent-view/`，结构参照 `mods/task-progress`（`hooks/logic.ts` 纯逻辑 + `hooks/register.tsx` 接线渲染 + `types/index.d.ts` 合约 + `test/`）；在 `.claude-plugin/marketplace.json` 加一项，README 补说明。
- 改 quick-tools：只在面板里加一行开关，不动其他行为。
- **跨 mod 协作**：quick-tools 要能触发 SubAgent View 的开关、并知道 pane 当前是否打开。候选做法：quick-tools 用 `$.command.run` 调 `/subagents`，再通过 SubAgent View 在 `$.state` 里公开的值（作为 quick-tools 的 `dependencies` 合约）读到打开状态。SubAgent View 没装时，quick-tools 不显示这一行。具体方式由 builder 查 API 决定。
- 按 plugin-authoring 的要求：`claude plugin validate`、`tsc -p`、`claude plugin test` 对两个 mod 都全绿；状态放 `$.state`，有类型合约。

## 留给 builder 的

- `$.state` 的具体结构、合约与测试拆分（纯逻辑和渲染分开测）。
- 跨 mod 协作的具体 API。
- subagent 结束的事件来源，以及完成 / 失败 / 被停的判定。
- theme key 与 hex 的取舍、各列的对齐宽度。
- 「最近工具」的简短参数取哪个字段。
