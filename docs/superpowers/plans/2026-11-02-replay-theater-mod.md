# replay-theater mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 claude-code-playground 的 Replay Theater 移植进本仓库：记录一轮里的文件编辑，轮次结束后 band 提示，`/replay` 或点击打开逐步回放；外观换成用户选定的 B 版（步骤清单 + 当前步 diff），文案中文。

**Architecture:** `logic.ts` 放纯逻辑（diff、上下文裁剪、计数、清单窗口、按轮分组 reducer），无 `$`；`register.tsx` 做事件接线、Pane / band 切换与渲染。回放数据放模块变量（`/clear` 后仍在），UI 开关小状态可放 `$.state`。

**Tech Stack:** Claude Code mod API（TSX，全局 `h`），`claude-code/testing`。

**Spec:** `docs/superpowers/specs/2026-11-02-replay-theater-mod-design.md`（执行者必须先读完）

## Global Constraints

- 原版源码是行为的唯一依据，执行者先取下来对照（Apache-2.0，README 注明改编来源）：
  `gh api -H "Accept: application/vnd.github.raw" repos/anthropics/claude-code-playground/contents/claude-code/mods/replay-theater/hooks/replay-theater.mjs > /tmp/<自选>/replay-theater.mjs`
- 写代码前先调用 `plugin-authoring` skill 查当前 mod API（`$.fs`、`$.command.register`、`$.ui.open`、`isPlaced`、`ui.close`、theme key、测试桩写法）；原版是 2.1.280 的 `.mjs`，API 若有出入以当前 API 为准，行为不变。
- mod 目录 `mods/replay-theater/`，结构同 `mods/task-progress/`。
- `plugin.json`：`{ "name": "replay-theater", "version": "0.1.0", "author": { "name": "Daneaz" }, "description": "Step through the file edits Claude made in the last turn, one diff at a time.", "types": "./types/index.d.ts" }`
- 常量：`PANE_ID = 'replay-theater'`、`MAX_DIFF_LINES = 12`、`MAX_LCS_LINES = 400`、`EDIT_TOOLS = Edit / Write / MultiEdit`、打开 pane 前等 200ms、胶囊封顶 10 个（超出加 dim `+N`）、清单窗口 7 行。
- 颜色：紫 `#c792ff`（与 quick-tools 模型紫一致；有对口 theme key 优先）、绿 `success`、红 `error`（无则 `#ff5f5f`）、dim `inactive`、暗 `subtle`；diff 底色删 `#3a1f22`、加 `#1c3326`，若 theme 为浅色或 API 不支持背景色则只留字色。
- 字形：`▶`、胶囊 `▰` / `▱`、`✓` / `›`、diff 前缀 `−` / `+`、`⋯`。
- 中文文案（原样）：提示 `▶ 回放  <胶囊>  N 处编辑  M 个文件 · 点击或 /replay`；pane 标题 `▶ 回放`；`第 k/N`（写作 `k/N`）；`… 还有 N 行`；`（无行变化）`；清单省略 `… N 步`；按钮 `‹ p`、`n ›`、`c 关闭`；`/replay` 描述 `回放上一轮的文件编辑`；命令回包 `回放：N 处编辑` / `回放：上一轮没有编辑`；note `全部替换`、`第 k/N 处`、`新文件`、`重写`。
- band 提示按钮**不设热键**；pane 内 `n` / `p` / `c`、Esc 关闭。
- band：永远组合 `next(e)`（提示 / 展开回放画在上，下层附在下面）；`hasSurvey` 为真时 `return next(e)`；不按 surface 区分。
- 验证命令（全绿才算完）：`claude plugin validate mods/replay-theater`、`tsc -p mods/replay-theater`、`claude plugin test mods/replay-theater`。
- 代码注释用中文。

## Review Focus

1. 记录时 `$.fs.read` / `session.cwd` 抛错 → 编辑照常放行（Task 2 测试 `recording error still passes`）。
2. subagent 的 `turn.start` 不清空主轮次待记列表；subagent 编辑并入主回放（Task 2 测试 `subagent edits join main turn`）。
3. 一轮没有编辑 → 保留上一份回放（Task 2 测试 `empty turn keeps replay`）。
4. 步骤数 > 清单窗口 → 当前步始终可见（Task 1 测试 `window keeps current visible`）。
5. 窄终端回放在 band 展开 → 下层 mod 仍在（Task 2 测试 `band replay keeps lower`）。

---

### Task 1: 纯逻辑 `logic.ts`

**Files:**
- Create: `mods/replay-theater/hooks/logic.ts`、`mods/replay-theater/types/index.d.ts`、`mods/replay-theater/.claude-plugin/plugin.json`、`mods/replay-theater/hooks/hooks.json`、最小 `mods/replay-theater/hooks/register.tsx`
- Test: `mods/replay-theater/test/logic.test.ts`

**Interfaces:**
- Produces（类型）：
  ```ts
  export type DiffLine = { op: '+' | '-' | ' ' | '~'; t: string }
  export type Step = { tool: 'Edit' | 'Write' | 'MultiEdit'; file: string; diff: DiffLine[]; note: string }
  ```
- Produces（函数，移植原版）：
  - `relPath(cwd: string, path?: string): string`
  - `diffLines(oldText?: string, newText?: string): DiffLine[]`（LCS；任一侧 > 400 行时全删再全加；然后 `trimContext`）
  - `countChanges(diff: DiffLine[]): { add: number; del: number }`
  - `fileCount(steps: Step[]): number`（去重文件数）
  - `listWindow(total: number, index: number, size?: number): { start: number; end: number }` —— 默认 7，保证 `start <= index < end`，尽量居中。
  - `pills(total: number, index: number, cap?: number): { seen: number; current: boolean; rest: number; overflow: number }` —— 「看过」= 序号 < index；默认封顶 10。

- [ ] **Step 1: 写失败测试**
  - `edit diff with context`：`'a\nb\nc\nd\ne'` → `'a\nb\nX\nd\ne'` → `[{op:' ',t:'b'},{op:'-',t:'c'},{op:'+',t:'X'},{op:' ',t:'d'}]`。
  - `skipped run shows ellipsis`：两处相隔 ≥ 3 行的改动 → 中间有 `{op:'~',t:'⋯'}`。
  - `big write no lcs`：401 行旧文本 → 结果前 401 项都是 `-`。
  - `new file`：`diffLines('', 'a\nb')` → 两个 `+`。
  - `no change`：相同文本 → 无 `+`/`-`。
  - `count and files`：`countChanges` 正确；`fileCount` 对重复文件去重。
  - `window keeps current visible`：`listWindow(20, 0)` → `{0,7}`；`listWindow(20, 10)` 含 10；`listWindow(20, 19)` → `{13,20}`；`listWindow(3, 1)` → `{0,3}`。
  - `pills`：`pills(5,1)` → `{seen:1,current:true,rest:3,overflow:0}`；`pills(14,0)` → `overflow 4`，`seen+1+rest === 10`。
  - `relPath`：cwd 前缀去掉；无 path → `(unknown file)`。
- [ ] **Step 2: 运行确认失败** — `claude plugin test mods/replay-theater` → FAIL。
- [ ] **Step 3: 实现**。
- [ ] **Step 4: 运行确认通过**。
- [ ] **Step 5: Commit** — `git add mods/replay-theater && git commit -m "feat(replay-theater): diff 与清单逻辑"`

### Task 2: 接线与渲染 `register.tsx`

**Files:**
- Modify: `mods/replay-theater/hooks/register.tsx`
- Test: `mods/replay-theater/test/replay.test.tsx`
- 不改 `.claude-plugin/marketplace.json` 与 `README.md`：由 blast-radius plan 末尾的「集成」统一处理。

**Interfaces:**
- Consumes: Task 1 全部导出。
- Produces: 渲染节点 key：`rt-hint`（band 提示行）、`rt-open`（打开按钮）、`rt-title`、`rt-step-<i>`（清单行）、`rt-more-above` / `rt-more-below`、`rt-diff-<n>`、`rt-diff-more`、`prev`、`next`、`close`。

事件照搬原版 `register`（`session.start` 注册 `/replay`；`command.run`；`tool.call` 记录后总是 `next(e)`，记录包在 try 里；`turn.start` 主循环清 pending；`turn.complete` 主循环有 pending 才替换回放；`ui.close` 同步）。`stepsFor` 移植进 register（依赖 `$`），note 文案改中文。

渲染按 spec「外观」B 版：
- band 提示（`rt-hint` 行）：紫 `▶` + 绿胶囊（`pills(total,-1)` 全绿 / 封顶）+ 紫粗 `N 处编辑` + dim `M 个文件 · 点击或 /replay`；整行或右侧 `rt-open` 为可点按钮（无 hotkey）。
- 回放视图：标题行（紫粗 `▶ 回放` + 胶囊 + 紫粗 `k/N` + dim `M 个文件`）；空行；清单窗口（`✓` 绿 + dim 文件名 / `›` 紫 + 亮粗文件名 / 整行 dim；列：文件名（从开头截断）、工具名 dim、`+N` 绿 `−N` 红，对齐）；窗口外 dim `… N 步`；空行；diff（缩进对齐文件名列；`−` 红字暗红底、`+` 绿字暗绿底、上下文 / `⋯` dim；≤ 12 行 + `… 还有 N 行`）；空行；按钮 `‹ p`、`n ›`（`autoFocus`）、`c 关闭`。
- band 内展开时 diff 行数按 `maxRows` 收缩（原版公式），清单窗口可缩到 3。
- pane `rows` 按内容估算（清单窗口 + diff + 6），`columns` 由执行者定（≥ 58）。

- [ ] **Step 1: 写失败测试**（engine 桩写法同 `mods/task-progress/test/band.test.tsx`；`ui.open` 桩默认 `{ isPlaced: true }`；`fs` 桩按路径回内容）
  - `records edits per turn`：主轮次 2 次 Edit、1 次 Write（新文件）→ `turn.complete` 后 band `rt-hint` 含 `3 处编辑`、`2 个文件`（视文件而定）。
  - `no hint before any edits`：无编辑 → 无 `rt-hint`，下层 `low` 在。
  - `hint keeps lower`：有提示时 `low` 仍在。
  - `quiet on survey`：`hasSurvey: true` → 无 `rt-hint`。
  - `hint button has no hotkey`：`rt-open` 无 `hotkey` 属性。
  - `replay command opens`：`/replay` → `ui.open` 被调用 `id:'replay-theater'`；回包 `回放：3 处编辑`；无回放时回包 `回放：上一轮没有编辑`。
  - `steps navigate`：打开后 `rt-title` 含 `1/3`；press `next` → `2/3`，`rt-step-0` 含 `✓`；第 3 步再 `next` 仍 `3/3`；`prev` 回 `2/3`。
  - `diff caps at 12`：20 行改动 → 12 个 `rt-diff-*` + `rt-diff-more` 含 `还有`。
  - `multiedit one step per edit`：MultiEdit 3 个 edit → 3 步，note `第 1/3 处`。
  - `recording error still passes`：`fs.read` 抛错的 Write → 下层收到调用。
  - `subagent edits join main turn`：主 `turn.start` → subagent `turn.start`（带 `agentId`）→ subagent Edit → 主 `turn.complete` → 回放含该步。
  - `empty turn keeps replay`：有回放后一轮无编辑 → 提示仍是旧数量。
  - `band replay keeps lower`：`ui.open` 回 `{ isPlaced: false }` → AbovePrompt 含 `rt-title` 且含 `low`；press `close` 后回到提示。
  - `escape syncs state`：发 `ui.close {id:'replay-theater'}` → 之后 AbovePrompt 重新显示提示。
- [ ] **Step 2: 运行确认失败**。
- [ ] **Step 3: 实现 `register.tsx`**。
- [ ] **Step 4: 全部验证** — `claude plugin validate mods/replay-theater`、`tsc -p mods/replay-theater`、`claude plugin test mods/replay-theater` 全绿；另跑 quick-tools、task-progress 的 `claude plugin test` 确认未受影响。
- [ ] **Step 5: Commit** — `git commit -m "feat(replay-theater): 接线与回放渲染"`
