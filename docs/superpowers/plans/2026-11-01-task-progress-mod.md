# task-progress mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 prompt 上方的 band 显示当前 session 计划的进度，点击展开任务清单（含每个任务的虚拟进度条与正在跑的 subagent）。

**Architecture:** 纯逻辑（计划 reducer、摘要、扫动帧、截断）放 `hooks/logic.ts`，无 `$` 依赖，单测覆盖；`hooks/register.tsx` 只做事件接线与渲染。状态放 `$.state`（`types/index.d.ts` 合约）。quick-tools 与 task-progress 的 `AbovePrompt` hook 都改为组合 `next(e)`，任意先后都能同时显示。

**Tech Stack:** Claude Code mod API（2.1.316），TSX（全局 `h`），`claude-code/testing`。

**Spec:** `docs/superpowers/specs/2026-11-01-task-progress-mod-design.md`（执行者必须先读完）

## Global Constraints

- mod 目录：`mods/task-progress/`，结构同 `mods/quick-tools/`（`.claude-plugin/plugin.json`、`hooks/hooks.json`、`hooks/register.tsx`、`hooks/logic.ts`、`types/index.d.ts`、`test/*.test.ts(x)`）。
- `plugin.json`：`{ "name": "task-progress", "version": "0.1.0", "author": { "name": "Daneaz" }, "description": "A band above the prompt showing the session plan's progress; click to see each task.", "types": "./types/index.d.ts" }`
- 只画 `surface === 'terminal'`；`hasSurvey` 为真时直接 `return next(e)`。
- 颜色：绿 `success`（theme key；若实测浅色下不可读再改 hex `#7ec699`）、蓝 `#8ab4ff`、完成名 dim `#55606e`、未开始胶囊 `#3b424d`、说明文字 `#6b7480`。
- 文案原样：`还剩 N 个`、`Done`、`Next`、`全部完成`、`运行中`、`↳ subagent`、`N 个 subagent`、`activeForm` 缺省时 `进行中`。
- 字形原样：胶囊 `▰` / `▱`，行进度条 10 格 `▰`，扫动亮光 3 格，符号 `✓` / `›`。
- 动画周期 160ms，只在展开且有进行中任务时运行。
- 验证命令（每个 mod 都要全绿）：`claude plugin validate mods/<mod>`、`tsc -p mods/<mod>`（types 未落地时按 plugin-authoring skill 用外部 tsconfig）、`claude plugin test mods/<mod>`。
- 代码注释用中文。

## Review Focus

1. 主会话建任务、subagent 用 `TaskUpdate` 标完成 → 主表任务照常变 Done（Task 1 测试 `subagent update applies to main task`）。
2. `TaskUpdate` 结果 `success: false` 或 `isError` / `deny` → 状态不变（Task 2 测试 `failed calls leave the plan`）。
3. 计划完成后用户提交新 prompt，再来 `TaskCreate` → 从 1/1 重新计数，不累加旧任务（Task 1 测试 `create after finished starts fresh`）。
4. 后台 subagent（`agent.spawn` 立即返回）跨多个 prompt 仍在跑 → 直到它的 `turn.complete` 才移除（Task 2 测试 `subagent row lives until its turn completes`）。
5. 同 band 两个 mod 都装 → 两者都画出来（Task 3 测试 `composes the band below`；Task 2 测试 `keeps lower band`）。

---

### Task 1: 计划逻辑 `logic.ts`

**Files:**
- Create: `mods/task-progress/hooks/logic.ts`
- Create: `mods/task-progress/types/index.d.ts`
- Test: `mods/task-progress/test/logic.test.ts`

**Interfaces:**
- Produces（`types/index.d.ts` 导出，`logic.ts` 再导出类型）：
  ```ts
  export type TaskStatus = 'pending' | 'in_progress' | 'completed'
  export type Task = { id: string; title: string; activeForm?: string; status: TaskStatus }
  export type Plan = { tasks: Task[] }            // 空数组 = 无计划
  export type Subagent = { agentId: string; description: string }
  export type Summary = {
    total: number; done: number; remaining: number  // remaining = pending 数
    position: number                 // 1 起；第一个进行中的序号，无进行中时为第一个 pending 的序号，全完成时 = total
    title: string                    // 对应 position 的任务标题
    extraRunning: number             // 其余进行中的数量（+N）
    isFinished: boolean              // total > 0 且全部 completed
  }
  declare module 'claude-code' {
    interface PluginState {
      'task-progress': { plan: Plan; subagents: Subagent[]; isOpen: boolean; frame: number }
    }
  }
  ```
- Produces（`logic.ts` 函数）：
  - `applyTodoWrite(plan: Plan, todos: { content: string; status: TaskStatus; activeForm: string }[]): Plan` — 整表替换，id 用下标字符串。
  - `applyTaskCreate(plan: Plan, id: string, subject: string, activeForm?: string): Plan` — 若 `summarize(plan).isFinished` 先清空，再追加 pending。
  - `applyTaskUpdate(plan: Plan, input: { taskId: string; subject?: string; activeForm?: string; status?: TaskStatus | 'deleted' }): Plan` — id 不存在原样返回；`deleted` 移除。
  - `clearIfFinished(plan: Plan): Plan`
  - `summarize(plan: Plan): Summary`
  - `sweep(frame: number, width?: number, len?: number): boolean[]` — 默认 10 / 3，亮光来回弹（0→7→0，周期 14 帧）。
  - `truncate(text: string, columns: number): string` — 按终端列宽（CJK 全角算 2 列）截断，超出时末尾 `…` 且总宽 ≤ columns。

- [ ] **Step 1: 写失败测试**（`claude-code/testing` 的 `test` / `expect`，写法同 `mods/quick-tools/test/logic.test.ts`）
  - `todo write replaces the list`：两次 `applyTodoWrite`，第二次结果只含第二张表，标题取 `content`。
  - `create appends pending`：`applyTaskCreate(EMPTY,'1','查代码','正在查代码')` → `[{id:'1',title:'查代码',activeForm:'正在查代码',status:'pending'}]`。
  - `create after finished starts fresh`：全 completed 的 3 项后 create → `tasks.length === 1`，`summarize` 得 `position 1, total 1`。
  - `update changes status and deletes`：`in_progress` 生效；`deleted` 后该 id 不在；未知 id 返回原 plan（`toBe` 同一引用）。
  - `subagent update applies to main task`：同上 reducer 级别（不区分调用者），`completed` 生效。
  - `summarize middle`：[completed, in_progress, pending×3] → `{ total:5, done:1, remaining:3, position:2, title:'写代码', extraRunning:0, isFinished:false }`。
  - `summarize parallel`：[completed, in_progress, in_progress, pending] → `position 2, extraRunning 1, remaining 1`。
  - `summarize between tasks`：[completed, pending, pending] → `position 2, title 第二项, extraRunning 0`。
  - `summarize finished`：全完成 → `isFinished true, position === total`。
  - `sweep bounces`：`sweep(0)` 前三格 true；`sweep(7)` 后三格 true；`sweep(14)` 等于 `sweep(0)`；每帧恰 3 个 true。
  - `truncate by columns`：`truncate('review 代码', 20)` 原样；`truncate('一二三四五六', 7)` === `'一二三…'`；`truncate('abcdef', 4)` === `'abc…'`。
- [ ] **Step 2: 运行确认失败** — `claude plugin test mods/task-progress` → FAIL（模块不存在）。
- [ ] **Step 3: 实现 `logic.ts` 与 `types/index.d.ts`**（此时可先放最小 `plugin.json` + `hooks/hooks.json` + 空 `register.tsx` 以便测试运行；Task 2 补全）。
- [ ] **Step 4: 运行确认通过** — `claude plugin test mods/task-progress` → 全部 PASS。
- [ ] **Step 5: Commit** — `git add mods/task-progress && git commit -m "feat(task-progress): 计划逻辑与类型合约"`

### Task 2: 事件接线与 band 渲染 `register.tsx`

**Files:**
- Create/Modify: `mods/task-progress/.claude-plugin/plugin.json`、`mods/task-progress/hooks/hooks.json`（`{ "modules": ["./register.tsx"] }`）、`mods/task-progress/hooks/register.tsx`
- Test: `mods/task-progress/test/band.test.tsx`

**Interfaces:**
- Consumes: Task 1 全部导出。
- Produces: 渲染节点的 key（测试用）：`toggle`（收起行，Button）、`task-<id>`（每个任务行）、`bar-<id>`（进度条，pending 无此 key）、`note-<id>`（描述列文本）、`agent-<agentId>`（subagent 行）。

事件：
- `tool.call`：`await next(e)` 后，结果有 `deny` / `isError` / `(TaskUpdate && result.success === false)` 则不动。否则：
  - `TodoWrite`（仅 `e.agentId === undefined`）→ `applyTodoWrite(plan, result.newTodos)`。
  - `TaskCreate`（仅主循环）→ `applyTaskCreate(plan, result.task.id, e.subject, e.activeForm)`。
  - `TaskUpdate`（任何 loop）→ `applyTaskUpdate(plan, e)`。
- `agent.spawn`：仅 `e.parentAgentId === undefined` 且不是 workflow（`e.workflow === undefined`）；`const r = await next(e)`，有 `r.agentId` 则追加 `{ agentId, description: e.description }`。
- `turn.complete`：`e.agentId` 在 `subagents` 里则移除；然后 `return next(e)`。（若实测后台 subagent 不触发它，再加 `classic.SubagentStop` 按 `agent_id` 移除。）
- `prompt.submit`：`plan = clearIfFinished(plan)`；清空时 `isOpen = false`。
- 动画：模块变量持有 `$.clock.every(160, …)` 的句柄；`isOpen && 有进行中` 时启动（每 tick `update(frame, f => f + 1)`），否则停。在 toggle、plan 变化后调用同一个 `syncTimer($)`。

渲染（`ui.render` on `{ component: 'AbovePrompt' }`）：
- 先 `const below = await next(e)`；`plan.tasks` 为空 → 返回 `below`。
- 否则返回 `<Box flexDirection="column">{本 mod 的行}{below}</Box>`（below 为空时不放）。
- 收起行（Button key `toggle`）：胶囊 + `  {position}/{total}` 蓝粗 + `  {title}` + (`extraRunning>0` 时 dim ` +N`) + `  还剩 N 个` dim + (subagent>0 时 dim `  · N 个 subagent`)。完成时改为绿色 `✓ {total}/{total} 全部完成`。
- 展开时空一行后逐任务一行，列宽：名称列 = 最长任务名宽度（上限 `bodyColumns` 的 40%），用 `truncate` 后右补空格对齐；进度条列 10 格；描述列见 spec。
- subagent 行挂载位置按 spec（恰一个进行中挂其下，否则在末尾），文本截断到一行。

- [ ] **Step 1: 写失败测试**（engine 桩写法同 `mods/quick-tools/test/band.test.tsx`：`on('tool.call', …)` 桩按工具名回 result；`$.ui.mount(BAND)` 后 `find` / `press`）
  - `hidden without plan`：mount → 找不到 `toggle`。
  - `collapsed shows progress`：TodoWrite 5 项（1 完成 1 进行中 3 待办）→ `toggle` 文本含 `2/5`、`写代码`、`还剩 3 个`。
  - `press expands rows`：press `toggle` → `task-0..4` 都在；`bar-0` / `bar-1` 在，`bar-2` 不在；`note-0` 含 `Done`，`note-1` 含 `正在写代码`，`note-2` 含 `Next`；再 press 收起后 `task-0` 不在。
  - `parallel shows +N`：两项进行中 → `toggle` 含 `+1`；展开后 `bar-1`、`bar-2` 都在。
  - `ignores subagent plan`：带 `agentId` 的 TodoWrite / TaskCreate 不出现 band。
  - `failed calls leave the plan`：`TaskUpdate` 桩回 `{ result: { success:false, … } }` 与 `{ deny:'x' }` → 状态不变。
  - `finished clears on next prompt`：全完成 → `toggle` 含 `全部完成`；`$.prompt.submit` 后 band 消失。
  - `subagent row lives until its turn completes`：`agent.spawn` 桩回 `{ model:'m', agentId:'a1' }` → 收起行含 `1 个 subagent`，展开有 `agent-a1` 含 description 与 `运行中`；再 `prompt.submit` 仍在；`turn.complete({ agentId:'a1', … })` 后消失。
  - `keeps lower band`：另注册一个更低层 `ui.render` 桩返回 `<Text key="low">x</Text>` → 有计划和无计划时都能 `find({ key:'low' })`。
  - `quiet on survey`：`hasSurvey: true` → 无 `toggle`。
- [ ] **Step 2: 运行确认失败** — `claude plugin test mods/task-progress` → 新测试 FAIL。
- [ ] **Step 3: 实现 `register.tsx` 与清单文件**。
- [ ] **Step 4: 全部验证** — `claude plugin validate mods/task-progress`、`tsc -p mods/task-progress`、`claude plugin test mods/task-progress` 全绿。
- [ ] **Step 5: Commit** — `git commit -m "feat(task-progress): band 接线与渲染"`

### Task 3: quick-tools 组合 band + marketplace + README

**Files:**
- Modify: `mods/quick-tools/hooks/register.tsx`（`ui.render` AbovePrompt hook，约 119–200 行）
- Test: `mods/quick-tools/test/band.test.tsx`
- Modify: `.claude-plugin/marketplace.json`、`README.md`

**Interfaces:**
- Consumes: 无（与 Task 1/2 无代码依赖，可与 Task 1 并行）。
- Produces: quick-tools 的 render 返回 `<Box flexDirection="column">{below}{原 root}</Box>`（`below = await next(e)`，为空时只返回原 root）；`hasSurvey` / 非 terminal 分支不变。

- [ ] **Step 1: 写失败测试** `composes the band below`：注册更低层 `ui.render` AbovePrompt 桩返回 `<Text key="low">x</Text>`，mount 后 `find({ key:'low' })` 与 `find({ key:'toggle' })` 都存在。
- [ ] **Step 2: 运行确认失败** — `claude plugin test mods/quick-tools` → 该测试 FAIL，其余 PASS。
- [ ] **Step 3: 实现组合**。
- [ ] **Step 4: marketplace 加项**：`{ "name": "task-progress", "source": "./mods/task-progress", "description": "A band above the prompt showing the session plan's progress; click to see each task." }`；README 的 mods 部分照 quick-tools 的格式补一节（用途一句 + 安装命令 `claude plugin install task-progress@claude-tools`，以 README 里 quick-tools 现有写法为准）。
- [ ] **Step 5: 验证** — `claude plugin validate mods/quick-tools`、`tsc -p mods/quick-tools`、`claude plugin test mods/quick-tools` 全绿。
- [ ] **Step 6: Commit** — `git commit -m "feat(quick-tools): band 组合下层 mod；marketplace 加 task-progress"`
