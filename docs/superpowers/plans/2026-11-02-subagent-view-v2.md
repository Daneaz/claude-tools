# SubAgent View v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 去掉 subagent-view 里依赖计划的显示，改为「工作条 + 最近工具 + 调用次数」。

**Architecture:** 只动 `mods/subagent-view/`：`hooks/logic.ts` 删计划 / ETA 逻辑、加调用计数与 `sweep`；`hooks/register.tsx` 删三个计划 hook、改 pane 渲染；`types/index.d.ts` 改 `Agent` 形状并换 atom shape。外加 README、plugin.json、marketplace.json 的描述。

**Tech Stack:** Claude Code mod API（build 2.1.316），TSX，`claude plugin test`。

**Spec:** `docs/superpowers/specs/2026-11-02-subagent-view-mod-design.md`（v2；以「外观」「行为」两节为准）

## Global Constraints

- 每个在跑 subagent 2 行；第 2 行 = 10 格工作条（3 格亮 `▰` 蓝 `suggestion`，暗 `▱` `subtle`，与 task-progress `sweep(frame, 10, 3)` 同算法）+ 两空格 + `› <工具> <hint>`（蓝）+ 靠右 `N 次工具`（dim）。没调过工具：`› 启动中`（dim），不显示次数。
- 可用宽度 `W < 24` 时省掉工作条。已结束的行不画工作条。
- 总览只剩第 1 行（标题 + 计数）；删掉「合计剩余 / 剩余时间」行。
- 已结束：完成 `✓ … N 次 … 用时`（0 次省略 `N 次`）；失败 / 被停 `✗ … 失败|已停止 … 用时`。
- 调用计数：被 `deny` 的不计；`isError` 的照样计；只计被跟踪 subagent 的调用。resume 后次数接着累加，时长重新计时。
- 删掉只为计划服务的代码与测试（TodoWrite / TaskCreate / TaskUpdate hook、`applyTodoWrite` / `applyTaskCreate` / `applyTaskUpdate` / `progressOf` / `etaOf` / `formatEta` / `formatEtaLong`、`Step` / `StepStatus` / `steps` / `doneAtStart`、`PLAN_TOOLS`）。不留死代码。
- 改了 `Agent` 字段，atom 的 `shape` 从 `'agents-1'` 换成 `'agents-2'`。
- 描述文案：plugin.json 与 marketplace.json 都改为 `"A side pane showing what each subagent is doing and for how long."`；README 的 subagent-view 段落与示意图按 spec v2 改写。
- 验证全绿：`claude plugin validate mods/subagent-view`、`tsc -p mods/subagent-view`、`claude plugin test mods/subagent-view`；quick-tools 不改，但也要 `claude plugin test mods/quick-tools` 仍全绿。

## Review Focus

- 计划类工具（TodoWrite 等）被 subagent 调到时，现在也只是普通工具：计入次数、显示为最近工具。
- 被 deny 的调用不计数也不改最近工具；`isError` 的计数且改最近工具。
- 窄 pane（`bodyColumns` 20、40）每行不超宽（沿用 `layout fits bodyColumns` 测试）。
- 旧版存下的 `agents`（带 `steps`）重载后读作缺省 `[]`，不崩。
- 工作条只在 frame 推进时动；pane 关着时计时器照旧停。

---

### Task 1: v2 改造（logic + register + types + 文档）

**Files:**
- Modify: `mods/subagent-view/hooks/logic.ts`
- Modify: `mods/subagent-view/hooks/register.tsx`
- Modify: `mods/subagent-view/types/index.d.ts`
- Modify: `mods/subagent-view/test/logic.test.ts`, `mods/subagent-view/test/pane.test.tsx`
- Modify: `mods/subagent-view/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `README.md`

**Interfaces:**
- `type Agent = { agentId; type; description; state; startedAt; endedAt?; toolCalls: number; lastTool?: { tool: string; hint: string } }`
- `recordTool(list, agentId, tool, input): Agent[]` —— 设 `lastTool` 且 `toolCalls + 1`（不再跳过任何工具）。
- `sweep(frame: number, width = 10, len = 3): boolean[]` —— 从 task-progress `hooks/logic.ts` 复制（各 mod 独立打包）。
- `spawnAgent` 初始 `toolCalls: 0`；`resumeAgent` 只重置 `startedAt`、清 `endedAt`、状态回 running，保留 `toolCalls`。
- `overviewOf(list)` 只返回 `{ running, completed, failed }`。

- [ ] **Step 1: 改测试（先失败）**

logic.test.ts：删掉 todoWrite / taskUpdate / progressOf / eta / formatEta* 相关测试；新增：
```ts
test('recordTool counts every tool, plan tools included', ...)
  // spawn → recordTool Read {file_path:'/a/b.ts'} → recordTool TodoWrite {}
  // expect toolCalls === 2, lastTool === { tool: 'TodoWrite', hint: '' }
test('resume keeps toolCalls and restarts the clock', ...)
  // toolCalls 3, ended at 500 → resumeAgent(now=1000) → state 'running', startedAt 1000, toolCalls 3, endedAt undefined
test('sweep bounces 3 lit cells across 10', ...)
  // sweep(0) lit 0..2; sweep(7) lit 7..9; sweep(8) lit 6..8; each has exactly 3 true
test('overview counts only', ...)  // { running, completed, failed }，killed 计入 failed
```
pane.test.tsx：删掉 `subagent plan drives progress`、`overview eta wording`；改 `main loop plan is ignored` 为 `main loop tool calls are not counted`；改 `no plan shows last tool` 为：
```ts
test('running agent shows sweep bar, last tool and count', ...)
  // spawn General，subagent 调 Read /x/logic.ts 两次
  // 第 2 行文本以 '   ' 开头，含 10 个 ▰/▱（其中 3 个 ▰）、'› Read logic.ts'、'2 次工具'
test('agent with no tool calls shows 启动中 without count', ...)
test('denied call is not counted; errored call is', ...)
test('sweep bar is dropped when bodyColumns < 24', ...)
test('ended row shows call count or 失败/已停止', ...)  // 完成 0 次时没有「次」
```
`overview line` 测试改为断言没有「合计剩余」「剩余时间」行。

- [ ] **Step 2: 跑测试确认失败**

Run: `claude plugin test mods/subagent-view`
Expected: 新增 / 改写的测试 FAIL。

- [ ] **Step 3: 实现**

按 Interfaces 改 logic.ts 与 types；register.tsx 删三个计划 hook，通用 `tool.call` hook 的条件改为 `r.deny === undefined`（不再看 `isError`）；atom shape `'agents-2'`；渲染按 Global Constraints。工作条读同一个 `frame` atom。

- [ ] **Step 4: 跑全部验证**

Run: `claude plugin validate mods/subagent-view && tsc -p mods/subagent-view && claude plugin test mods/subagent-view && claude plugin test mods/quick-tools`
Expected: 全部通过。

- [ ] **Step 5: 文档 + 提交**

改 plugin.json / marketplace.json 描述、README 段落与示意图（spec v2 外观那张），然后：
```bash
git add mods/subagent-view .claude-plugin/marketplace.json README.md
git commit -m "feat(subagent-view): v2——去掉计划进度，改为工作条、最近工具与调用次数"
```
