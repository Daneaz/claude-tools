# SubAgent View 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建 `mods/subagent-view`：对话右侧的 pane 列出主会话派出的每个 subagent 的进度与预计剩余时间；quick-tools 面板加一个打开 / 关闭这个 pane 的开关。

**Architecture:** 结构与 `mods/task-progress` 相同：`hooks/logic.ts` 放纯逻辑（状态折叠、估算、格式化、avatar 表），`hooks/register.tsx` 负责接线（`agent.spawn` / `turn.complete` / `tool.call` / `command.run` / `ui.close`）和 Pane 渲染，`types/index.d.ts` 是 `$.state` 合约。quick-tools 通过读 `subagent-view` 的 `isOpen` 来画开关，通过 `$.command.run` 触发 `/subagents`。

**Tech Stack:** Claude Code mod API（build 2.1.316，types 在 `/private/tmp/claude-501/bundled-skills/2.1.316/7aca0845190ad19b1dcc4e6c449fc42e/plugin-authoring/types/claude-code.d.ts`，mod 加载后在 `<mod>/.claude-plugin/types/`）、TSX、`claude-code/testing`。

**Spec:** `docs/superpowers/specs/2026-11-02-subagent-view-mod-design.md`。执行者必须先读它，外观、文案、配色以 spec 为准。

## Global Constraints

- 每个 mod 都要全绿：`claude plugin validate mods/<mod>`、`tsc -p mods/<mod>`（types 还没落地时，按 plugin-authoring skill 的做法用 mod 目录外的 tsconfig）、`claude plugin test mods/<mod>`。
- plugin 名 `subagent-view`；pane id `subagent-view`，标题 `SubAgent View`；命令 `/subagents`。
- 只画 terminal：其他 surface 直接 `next(e)`。
- 文案逐字照 spec：`N 在跑` `N 完成` `N 失败`、`合计剩余 N 步`、`剩余时间约 M 分钟`、`剩 N 步`、`估算中`、`没有计划`、`最近：`、`已结束`、`停在 a/b`、`失败`、`已停止`、`这个 session 还没派出 subagent。` / `派出后会出现在这里。`
- 配色：绿 `#7ec699`、蓝 `#8ab4ff`、dim `#6b7480`、暗胶囊 `#3b424d`、完成名 `#55606e`、黄 `#e5c07b`、红 `#ef7b7b`。能用 theme key 的用 key（task-progress 用的是 `success` / `suggestion` / `inactive` / `subtle`，再加 `warning` / `error`）。
- 只跟踪模型在主会话派出的 subagent：排除 `parentAgentId` 有值、`workflow` 有值、`isTeammate`，以及 `$.agent.list()` 里带 `spawnedBy` 的（别的 mod 派的）。
- 代码注释、提交信息用中文，专有词汇保留英文。

## Review Focus

1. **subagent 结束信号丢失**（后台 agent、被 kill、`turn.complete` 没到）：最终要转为已结束。`prompt.submit` 时，以及计时器每 30 帧，用 `$.agent.list()` 自愈 → Task 2 测试 `self-heal marks a vanished agent ended`。
2. **TaskUpdate 的 taskId 和 TodoWrite 的下标撞号**：TodoWrite 的步骤 id 加前缀 `todo-`，TaskUpdate 不会误改 → Task 1 测试 `taskUpdate ignores todo ids`。
3. **resume 后旧步数配新时长**：估算只用叫醒后完成的步数 → Task 1 测试 `eta after resume uses steps since resume`。
4. **`/clear` 之后**：state 回到默认，计时器自停，pane 显示空状态 → Task 2 测试 `timer stops when state resets`。
5. **用户用 pane 自带的关闭操作关掉 pane**：`isOpen` 要跟着变 false，quick-tools 的开关变灰 → Task 2 测试 `person closing pane clears isOpen`。

---

### Task 1: 纯逻辑与合约（opus / medium）

**Files:**
- Create: `mods/subagent-view/.claude-plugin/plugin.json`：`{ "name": "subagent-view", "version": "0.1.0", "author": { "name": "Daneaz" }, "description": "A side pane showing each subagent's plan progress and time left.", "types": "./types/index.d.ts" }`
- Create: `mods/subagent-view/hooks/hooks.json`：`{ "modules": ["./register.tsx"] }`
- Create: `mods/subagent-view/types/index.d.ts`
- Create: `mods/subagent-view/hooks/logic.ts`
- Create: `mods/subagent-view/hooks/register.tsx`（这一步只放一个空的 `register`，让 validate 通过）
- Test: `mods/subagent-view/test/logic.test.ts`

**Interfaces（Produces）:** `types/index.d.ts` 与 `logic.ts` 导出如下，Task 2 和 Task 3 依赖这些名字。

```ts
// types/index.d.ts
export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type Step = { id: string; title: string; activeForm?: string; status: StepStatus }
export type AgentState = 'running' | 'completed' | 'failed' | 'killed'
export type Agent = {
  agentId: string
  type: string          // subagentType
  description: string
  state: AgentState
  startedAt: number     // ms；resume 时重置
  endedAt?: number
  steps: Step[]
  doneAtStart: number   // startedAt 那一刻已完成的步数（新派 0，resume 时 = 当时完成数）
  lastTool?: { tool: string; hint: string }
}
declare module 'claude-code' {
  interface PluginState {
    'subagent-view': { agents: Shaped<Agent[]>; isOpen: boolean; frame: number }
  }
}
```

`logic.ts`（重新导出上述类型）：

- `avatarFor(type: string): { avatar: string; name: string }`：按 spec 的表，类型名比较不区分大小写。兜底时按关键词匹配：`review`→🔍、`test`→🧪、`debug`→🐛、`doc`/`writer`→📝、`security`→🔒（用不带 VS16 的 🔒 代替 🛡️）、`data`→📊，都不中→🧩。兜底短名称：按 `-`/`_` 拆开，每段首字母大写后拼起来，超过 10 列用 `truncate` 截断。
- `spawnAgent(list: Agent[], a: { agentId: string; type: string; description: string; now: number }): Agent[]`：追加；同一个 `agentId` 已存在时原样返回。
- `resumeAgent(list, agentId: string, now: number): Agent[]`：改为 `running`，`startedAt = now`，删掉 `endedAt`，`doneAtStart` 设为当前已完成步数。找不到 id 时原样返回。
- `endAgent(list, agentId, state: Exclude<AgentState, 'running'>, now): Agent[]`：只改 `running` 的那条。
- `endStateOf(reason: 'answer' | 'aborted' | 'refusal' | 'error'): Exclude<AgentState, 'running'>`：`answer`→`completed`，`aborted`→`killed`，其余→`failed`。
- `applyTodoWrite(list, agentId, todos: { content: string; status: StepStatus; activeForm: string }[]): Agent[]`：整表替换该 agent 的 steps，id 为 `todo-<下标>`。
- `applyTaskCreate(list, agentId, id: string, subject: string, activeForm?: string): Agent[]`：追加 pending 步骤。
- `applyTaskUpdate(list, input: { taskId: string; subject?: string; activeForm?: string; status?: StepStatus | 'deleted' }): Agent[]`：在**持有该 taskId 的那个 agent** 上应用，`deleted` 时移除；没有任何 agent 持有时原样返回同一引用。
- `toolHint(tool: string, input: Record<string, unknown>): string`：Grep→`pattern` 加引号；Glob→`pattern`；Read/Edit/Write→`file_path` 的文件名；Bash→`description`，没有时取 `command` 的前 30 列；WebFetch→`url`；WebSearch→`query`；其他→空串。
- `recordTool(list, agentId, tool, input): Agent[]`：设置 `lastTool = { tool, hint: toolHint(...) }`；`TodoWrite`、`TaskCreate`、`TaskUpdate`、`TaskList`、`TaskGet` 不记。
- `progressOf(a: Agent): { total: number; done: number; remaining: number; current?: { text: string; isActive: boolean } }`：`remaining = total - done`。`current` 取第一个 in_progress 步骤（`activeForm ?? title`，`isActive: true`），没有时取第一个 pending 的 `title`（`isActive: false`）。
- `etaOf(a: Agent, now: number): number | 'estimating' | null`：没有步骤→`null`；`doneSince = done - doneAtStart`，`≤ 0` 时→`'estimating'`；否则 `(now - startedAt) / doneSince * remaining`。
- `overviewOf(list: Agent[], now: number): { running: number; completed: number; failed: number; remainingSteps: number; etaMs: number | null }`：`failed` 包含 killed；`remainingSteps` 是在跑且有步骤的 agent 的 `remaining` 之和；`etaMs` 取在跑 agent 里数值型 eta 的最大值，没有时为 `null`。
- `formatElapsed(ms: number): string`：`<1h` 时为 `${m}m${ss}s`（秒补两位，如 `0m40s`、`4m12s`），否则为 `${h}h${mm}m`（如 `1h03m`）。
- `formatEta(ms: number): string`：`<60000` 时为 `<1m`，否则为 `${Math.round(ms/60000)}m`。
- `formatEtaLong(ms: number): string`：`<60000` 时为 `不到 1 分钟`，否则为 `${Math.round(ms/60000)} 分钟`（总览用，拼成 `剩余时间约 6 分钟`；不到 1 分钟时拼成 `剩余时间不到 1 分钟`，这是我的决定）。
- `ordered(list: Agent[]): { running: Agent[]; ended: Agent[] }`：running 保持派出顺序；ended 按 `endedAt` 倒序。
- `textWidth` / `truncate` / `fit`：从 `mods/task-progress/hooks/logic.ts` 复制，宽字符表加上 `0x1f680–0x1f6ff`、`0x1f300–0x1f5ff`（📟 🔒 📊 🔭 等都要算 2 列）。

- [ ] **Step 1: 写失败的测试** `test/logic.test.ts`，至少覆盖下面这些（断言值逐字照写）：
  - `avatarFor`：`avatarFor('general-purpose')` → `{ avatar: '🧰', name: 'General' }`；`avatarFor('explore').avatar === '🔭'`；`avatarFor('combat-designer')` → `{ '🥊', 'Combat' }`；`avatarFor('code-reviewer')` → `{ '🔍', 'CodeReview…' }`（10 列截断）；`avatarFor('foo')` → `{ '🧩', 'Foo' }`。
  - `taskUpdate ignores todo ids`：agent A 用 TodoWrite 建了 2 步（`todo-0`、`todo-1`），`applyTaskUpdate(list, { taskId: '1', status: 'completed' })` 返回同一引用。
  - `taskUpdate applies to owner`：A 用 TaskCreate 建了 id `7`，B 调 `applyTaskUpdate({ taskId: '7', status: 'completed' })` 后，A 的步骤变为 completed。
  - `eta`：startedAt 0，7 步完成 3 步，now 180000 → `etaOf` 为 `240000`；0 步完成 → `'estimating'`；没有步骤 → `null`。
  - `eta after resume uses steps since resume`：4 步完成 2 步后结束，`resumeAgent(now=100000)`，再完成 1 步，now 160000 → `etaOf` 为 `60000`（叫醒后 60s 完成 1 步，剩 1 步）。
  - `overview`：3 个在跑（剩 4 / 3 / 5 步，eta 分别为 300000 / 180000 / 'estimating'）、1 个 completed、1 个 killed → `{ running: 3, completed: 1, failed: 1, remainingSteps: 12, etaMs: 300000 }`。
  - `formatElapsed(40000) === '0m40s'`、`formatElapsed(252000) === '4m12s'`、`formatElapsed(3780000) === '1h03m'`；`formatEta(30000) === '<1m'`、`formatEta(300000) === '5m'`；`formatEtaLong(360000) === '6 分钟'`。
  - `endStateOf`：answer / aborted / error / refusal 依次 → completed / killed / failed / failed。
  - `toolHint('Grep', { pattern: 'useAuth' }) === '"useAuth"'`、`toolHint('Read', { file_path: '/a/b/c.ts' }) === 'c.ts'`。
  - `spawnAgent` 遇到重复 id 时原样返回；`ordered` 中 ended 按 endedAt 倒序。
- [ ] **Step 2: 运行确认失败**：`claude plugin test mods/subagent-view`，预期 FAIL（logic 尚未实现）。
- [ ] **Step 3: 按上面的 Interfaces 实现 `logic.ts` 和 `types/index.d.ts`**，`register.tsx` 先写 `export const register: Register = () => {}`。
- [ ] **Step 4: 验证**：`claude plugin validate mods/subagent-view`、`tsc -p mods/subagent-view`、`claude plugin test mods/subagent-view` 全绿。
- [ ] **Step 5: 提交** `feat(subagent-view): 纯逻辑与类型合约`。

### Task 2: 接线与 Pane 渲染（opus / medium；依赖 Task 1）

**Files:**
- Modify: `mods/subagent-view/hooks/register.tsx`
- Test: `mods/subagent-view/test/pane.test.tsx`（engine 替身的写法参照 `mods/task-progress/test/band.test.tsx` 的 `engine()` 与 `mock.clock`）

**Interfaces:**
- Consumes：Task 1 `logic.ts` 的全部导出。
- Produces：atom `{ plugin: 'subagent-view', key: 'isOpen' }`（boolean），pane 打开时为 true，Task 3 会读它；命令 `subagents`。

接线（照搬 task-progress 的 `await next(e)` 后读结果的模式）：

- `session.start`：`$.command.register({ name: 'subagents', description: 'Show or hide the SubAgent View pane' })`。
- `command.run { command: 'subagents' }`：`isOpen` 为 true 时调 `$.ui.close({ id: 'subagent-view' })`，否则调 `$.ui.open({ id: 'subagent-view', title: 'SubAgent View' })`；然后更新 `isOpen` 并 `syncTimer`。返回 `{ text: '' }`（不在对话里留回执，这是我的决定；如果 engine 要求非空，就用 `SubAgent View 已打开` / `已关闭`）。
- `ui.close`：pane 的 id 是 `subagent-view` 时，把 `isOpen` 设为 false 并 `syncTimer`，然后 `return next(e)`（不拦截关闭）。
- `agent.spawn`：`const r = await next(e)`，拿不到 `r.agentId` 时直接返回。有 `e.resume` 时→`resumeAgent`；否则按 Global Constraints 过滤（`spawnedBy` 从 `$.agent.list()` 里按 id 查，失败时按「不是 mod 派的」处理）→`spawnAgent`，`now` 取 `$.clock.now()`（以 types 里的签名为准）。
- `turn.complete`：`agentId` 属于被跟踪的 running agent 时→`endAgent(endStateOf(e.reason))`。
- `tool.call`（不限工具）：`e.agentId` 属于被跟踪的 agent 时，`await next(e)`，失败（`deny` / `isError` / TaskUpdate 的 `success === false`）不改状态；成功后按工具名分派：TodoWrite → `applyTodoWrite`，TaskCreate → `applyTaskCreate`，其他 → `recordTool`。`TaskUpdate` 不看 `agentId`，一律走 `applyTaskUpdate`（主会话 TaskUpdate 自己建的 task 时，因为没有 agent 持有那个 taskId，`applyTaskUpdate` 会原样返回）。
- `prompt.submit` 与计时器每 30 帧做一次自愈：`$.agent.list()` 里状态是 `completed` / `failed` / `killed` 的，或已经不在列表里的被跟踪 running agent→`endAgent`（状态照 list，不在列表里的算 `completed`）。
- 计时器：pane 打开且有 running agent 时，`$.clock.every(160, ...)` 推进 `frame`；tick 先自检、不该跑就停掉自己（照搬 task-progress 的 `tick` / `syncTimer`）。已跑时长和预计时间在渲染时用 `$.clock.now()` 现算，不存进 state。

渲染：`ui.render { component: 'Pane', requestId: 'subagent-view' }`，surface 不是 terminal 时 `next(e)`。宽度用 `e.props.bodyColumns`。版式逐字照 spec 的「外观」：总览两行、分隔线 `─` 铺满宽度、每个 running agent 2 到 3 行并用空行隔开、`已结束` 区。转圈帧用 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`，按 `frame % 10` 取。右侧列（时长、`≈ 5m`）按 `bodyColumns` 右对齐，左侧说明用 `truncate` 让出位置。胶囊宽度上限是 `bodyColumns - 24` 格，超出就截断，`a/b` 一定保留。

- [ ] **Step 1: 写失败的测试** `test/pane.test.tsx`（mount 的 `PANE` 照 `pane.test.tsx` 的例子，`bodyColumns: 60`）：
  - `empty pane shows hint`：能找到文本 `这个 session 还没派出 subagent。`。
  - `spawned agent shows avatar, name, description`：派出 `{ subagentType: 'designer', description: '出登录页设计稿' }` → 能找到含 `🎨`、`Designer`、`出登录页设计稿` 的行。
  - `subagent plan drives progress`：该 agent（`agentId` = 派出得到的 id）调 TodoWrite 共 7 步、完成 3 步、第 4 步 in_progress、activeForm 为 `正在写测试` → 能找到 `3/7`、`剩 4 步`、`› 正在写测试`；用 `mock.clock` 推进 180s 后能找到 `≈ 4m`。
  - `main loop plan is ignored`：不带 `agentId` 调 TodoWrite → 该 agent 那块显示 `没有计划`。
  - `no plan shows last tool`：该 agent 调 Grep `{ pattern: 'useAuth' }` → 能找到 `最近：Grep "useAuth"`。
  - `overview line`：两个 running agent，各自剩 4 步和 3 步 → 能找到 `合计剩余 7 步`、`剩余时间约`。
  - `ended agents sink`：`turn.complete { agentId, reason: 'aborted' }` → 出现 `已结束`，以及含 `✗` 和 `已停止`（没有计划时）的行；总览出现 `1 失败`。
  - `resume moves agent back`：结束后再来一次 `agent.spawn`，带 `resume: { agentId }` → 不再有 `已结束`，agent 只出现一次。
  - `nested and plugin-spawned agents are ignored`：带 `parentAgentId` 的派出，以及 `agent.list` 里带 `spawnedBy` 的派出都不出现。
  - `command toggles pane`：`/subagents` 第一次触发 `ui.open`（可以拦下 `ui.open` 检查 `id`），`isOpen` 变为 true；第二次触发 `ui.close`，`isOpen` 变为 false。
  - `person closing pane clears isOpen`：触发 `ui.close`，`origin` 为 `person` → `isOpen` 为 false。
  - `self-heal marks a vanished agent ended`：`agent.list` 返回空 → 下一次 `prompt.submit` 后该 agent 进入已结束。
  - `timer stops when state resets`：pane 打开、有 running agent 时计时器在跑；把 state 换成默认值（模拟 `/clear`）后，下一次 tick 停掉计时器（照 task-progress 的同名测试写）。
- [ ] **Step 2: 运行确认失败**：`claude plugin test mods/subagent-view`，预期上面这些新测试 FAIL。
- [ ] **Step 3: 实现 `register.tsx`。**
- [ ] **Step 4: 验证**：validate / tsc / test 三项全绿。
- [ ] **Step 5: 提交** `feat(subagent-view): 接线与 pane 渲染`。

### Task 3: quick-tools 开关、marketplace、README（opus / medium；依赖 Task 1 的合约，可与 Task 2 并行）

**Files:**
- Modify: `mods/quick-tools/hooks/register.tsx`（ULTRA 那个 `<Box>` 下面加一行）
- Modify: `mods/quick-tools/.claude-plugin/plugin.json`：版本升到 `0.2.0`
- Modify: `.claude-plugin/marketplace.json`：加 `{ "name": "subagent-view", "source": "./mods/subagent-view", "description": "A side pane showing each subagent's plan progress and time left." }`
- Modify: `README.md`：mods 部分照 task-progress 的写法补一节 subagent-view
- Test: `mods/quick-tools/test/band.test.tsx`

**Interfaces:**
- Consumes：`{ plugin: 'subagent-view', key: 'isOpen' }`（boolean）；命令 `subagents`。
- 跨 mod 读取：先查 types 和 reference.md 里有没有不需要 `dependencies` 也能 `$.state.get` 另一个 mod 的 state 的方式（spec 要求：SubAgent View 没装时，quick-tools 不显示这一行，所以不能把它列成硬依赖）。读不到（reject，或 value 为 undefined）时视为「没装」。如果类型系统要求合约，就选一种不会让 quick-tools 在 subagent-view 缺席时加载失败的写法，并在提交信息里写明选了哪种。只有在 API 确实无法做到时，才退回 `dependencies`，并在汇报里说明 spec 的这一条做不到。
- 徽章文字 ` ◧ SubAgents `：开时蓝底（`#8ab4ff`）深字（`INK`），关时 `GREY` 底 dim 字。按下时 `$.command.run({ command: 'subagents', args: '' })`，失败时静默。

- [ ] **Step 1: 写失败的测试**（在 quick-tools 现有的 `band.test.tsx` 里）：
  - `subagents chip hidden when subagent-view absent`：读 `subagent-view` state 失败时，面板里找不到 `◧ SubAgents`。
  - `subagents chip reflects isOpen`：`state.get` 对 `subagent-view/isOpen` 返回 true → 徽章的 Text 的 `backgroundColor` 是蓝色。
  - `pressing chip runs /subagents`：按下徽章 → 拦到 `command.run`，`command === 'subagents'`。
  - 现有测试全部保持通过。
- [ ] **Step 2: 运行确认失败**：`claude plugin test mods/quick-tools`。
- [ ] **Step 3: 实现**；改 marketplace 和 README。
- [ ] **Step 4: 验证**：quick-tools 和 subagent-view 两个 mod 的 validate / tsc / test 全绿。
- [ ] **Step 5: 提交** `feat(quick-tools): SubAgents 开关；marketplace 加 subagent-view`。
