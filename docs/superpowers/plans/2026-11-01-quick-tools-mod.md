# quick-tools mod Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 terminal 输入框上方 band 的最右侧放一个常驻按钮，点开后可一键切换模型、effort、ultracode。

**Architecture:** 一个 hooks module 的 Claude Code mod。纯逻辑（命令输出解析、按钮文字、档位支持）放在 `hooks/logic.ts`，可单测；`hooks/register.tsx` 负责 `AbovePrompt` 渲染、按钮 `onPress` → `$.command.run`、观察 `command.run` 结果同步状态。状态放 `$.state`（atom），合约在 `types/index.d.ts`。

**Tech Stack:** TypeScript/TSX，`claude-code` mod API（engine 2.1.316），`claude-code/testing`。

**Spec:** `docs/superpowers/specs/2026-11-01-quick-tools-mod-design.md`

**API 参考：** `/private/tmp/claude-501/bundled-skills/2.1.316/25d1d15741cc9f97f02f3ddb8ad08990/plugin-authoring/`（`types/claude-code.d.ts` 用 grep 查；`reference.md`；`examples/band.tsx` 与 `examples/pane.test.tsx` 是最接近的范例）。

## Global Constraints

- mod 目录：`mods/quick-tools/`（仓库内唯一一份源码）；`plugin.json` 的 `name` 为 `quick-tools`，`version` `0.1.0`，带 `"types": "./types/index.d.ts"`。
- 只在 `e.surface === 'terminal'` 时绘制；其他 surface 与 `e.props.hasSurvey` 为真时 `return next(e)`。
- 模型：Fable → `claude-fable-5-1`，Opus → `claude-opus-5-5`，Sonnet → `claude-sonnet-5-5`，Haiku → `claude-haiku-5-5`。
- effort 档位顺序：`low` `medium` `high` `xhigh` `max`。
- 切换命令（从 2.1.316 binary 里读到，Task 1 实测确认）：`/model <id>`、`/effort <level>`、`/effort ultracode on|off`。
- 已知输出文本：`Set effort level to <level> (saved as your default for new sessions): …`、`Ultracode on (this session only)…`、`Ultracode off. Effort stays <level>.`。
- 配色：模型紫 `#c792ff`（199;146;255），dim 用 `dimColor`；ULTRA 彩虹逐字底色依次 `#ff5f8a #ff8c64 #ffb84d #e6dc5a #7ee787 #58c4ff #78a0ff #aa8cff #c792ff`，字色 `#15161a`。
- 按钮文字：收起 `⚡ <短名> · <effort>`，ultracode 开时追加 ` · ✦`，展开时追加 ` ▾`；effort 未知显示 `?`。
- 切模型后不补发 `/effort`；显示新模型实际的 effort；新模型不支持的档位置灰、按下无效。
- 展开后点选项不收起；再点按钮、或 `prompt.submit` 时收起。

## Review Focus

- 用户手敲 `/model sonnet`、`/effort low`、`/effort ultracode on`：按钮随之更新 → Task 2 测试 `typed commands update the button`。
- `/model` 输出不认得或命令报错（未知模型）：状态不变、不抛异常 → Task 1 测试 `unrecognised output leaves state alone`。
- Claude 正在回答（`isWorking`）时点击：照常调用 `$.command.run`（engine 排队），不重复调用 → Task 2 测试 `press while working runs once`。
- 当前模型不支持某档（如 Haiku 的 `max`）：该档置灰，按下不调用 `$.command.run` → Task 2 测试 `unsupported effort is inert`。
- 窄 terminal（`bodyColumns` 小于面板宽度）：面板不溢出，至少按钮可见 → Task 2 测试 `narrow band still shows the button`。

---

### Task 1: 脚手架 + 纯逻辑（含命令格式实测）

**Files:**
- Create: `mods/quick-tools/.claude-plugin/plugin.json`
- Create: `mods/quick-tools/hooks/hooks.json`（`{ "modules": ["./register.tsx"] }`）
- Create: `mods/quick-tools/hooks/register.tsx`（本任务只放一个空的 `register`，Task 2 填）
- Create: `mods/quick-tools/hooks/logic.ts`
- Create: `mods/quick-tools/types/index.d.ts`
- Test: `mods/quick-tools/test/logic.test.ts`

**Interfaces:**
- Produces（`hooks/logic.ts`）：
  - `type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'`；`const EFFORTS: readonly Effort[]`
  - `type ModelKey = 'fable' | 'opus' | 'sonnet' | 'haiku'`；`const MODELS: readonly { key: ModelKey; label: string; id: string }[]`（label 为 `Fable`/`Opus`/`Sonnet`/`Haiku`）
  - `type Status = { model: ModelKey | null; effort: Effort | null; ultracode: boolean }`
  - `modelKeyOf(idOrName: string): ModelKey | null`：接受 id、alias、display name（如 `Opus 5.5`）
  - `supportedEfforts(model: ModelKey | null): readonly Effort[]`：未知模型返回全部
  - `applyCommandResult(s: Status, command: 'model' | 'effort', args: string, text: string): Status`：从命令输出更新状态，认不出则原样返回
  - `buttonLabel(s: Status, isOpen: boolean): string`
- Produces（`types/index.d.ts`）：`PluginState['quick-tools'] = { status: Status; isOpen: boolean }`，从 `../hooks/logic` 导入 `Status`。

- [ ] **Step 1: 实测命令格式。** 从 `claude` binary（`strings ~/.local/share/claude/versions/2.1.316 | grep -E 'Ultracode|Set effort level|Set model'`）或 `claude -p` 确认：`/model` 成功输出的文本、`/effort ultracode on|off` 的参数形式、各模型支持的 effort 档位（binary 里 `qwe(e)` 附近）。**不要**在真实 settings 上跑会改默认值的命令。把结论写成 `logic.ts` 顶部注释，与 Global Constraints 不符的地方在汇报里列出。
- [ ] **Step 2: 写失败测试** `test/logic.test.ts`：
  - `modelKeyOf`：`'claude-opus-5-5'`→`'opus'`，`'Sonnet 5.5'`→`'sonnet'`，`'haiku'`→`'haiku'`，`'gpt-4'`→`null`
  - `applyCommandResult`：effort 输出 `Set effort level to xhigh (saved …)` → `effort: 'xhigh'`；`Ultracode on (this session only)` → `ultracode: true`；`Ultracode off. Effort stays medium.` → `ultracode: false, effort: 'medium'`；Step 1 确认的 `/model` 成功输出 → 对应 `model`
  - `unrecognised output leaves state alone`：报错文本 → 返回同一对象
  - `buttonLabel`：`{opus, high, false}, false` → `'⚡ Opus · high'`；`{opus, high, true}, true` → `'⚡ Opus · high · ✦ ▾'`；`{null, null, false}, false` → `'⚡ ? · ?'`
  - `supportedEfforts`：按 Step 1 结论写断言（至少一个模型少于 5 档时断言它）
- [ ] **Step 3: 运行** `claude plugin test mods/quick-tools`，预期 FAIL（函数未定义）。
- [ ] **Step 4: 实现** `logic.ts`、`plugin.json`、`hooks.json`、`types/index.d.ts`、空 `register`。
- [ ] **Step 5: 运行** `claude plugin test mods/quick-tools` 预期 PASS；`claude plugin validate mods/quick-tools` 无错误。
- [ ] **Step 6: Commit** `feat(quick-tools): 脚手架与状态逻辑`

### Task 2: band 渲染与交互

**Files:**
- Modify: `mods/quick-tools/hooks/register.tsx`
- Test: `mods/quick-tools/test/band.test.tsx`

**Interfaces:**
- Consumes: Task 1 的全部 `logic.ts` 导出与 `PluginState['quick-tools']`。
- Produces: 无（终端产物）。

- [ ] **Step 1: 写失败测试** `test/band.test.tsx`（按 `examples/pane.test.tsx` 的方式 mount `{ plugin: 'quick-tools', component: 'AbovePrompt', surface: 'terminal', props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100, scroll: {offset:0, bodyRows: 20}, view: {} } }`，用 `on('command.run', …)` 充当 engine 并记录调用）：
  - `collapsed shows the button`：只找到一个 Button，文字 `⚡ Opus · high`（state 预置 opus/high）
  - `press opens the panel`：按下按钮后出现 4 个模型、5 个 effort、ULTRA，按钮文字以 ` ▾` 结尾
  - `pick model runs /model`：按 Sonnet → `command.run` 收到 `{ command: 'model', args: 'claude-sonnet-5-5' }`；面板仍展开
  - `pick effort runs /effort`：按 xhigh → `{ command: 'effort', args: 'xhigh' }`
  - `ultra toggles`：ultracode 关时按 ULTRA → `{ command: 'effort', args: 'ultracode on' }`
  - `unsupported effort is inert`：模型为 Task 1 确认的少档模型，按不支持的档 → 无 `command.run` 调用
  - `press while working runs once`：`isWorking: true` 时按一次 → 恰好一次调用
  - `typed commands update the button`：`$.command.run({ command: 'effort', args: 'low' })` 且 engine 回 `{ text: 'Set effort level to low (…)' }` → 按钮显示 `· low`；`/model` 同理
  - `submit collapses`：展开后触发 `prompt.submit` → 面板收起
  - `survey yields` / `other surfaces pass`：`hasSurvey: true` 或 `surface: 'desktop'` → 渲染的是 engine 的（无本 mod 的 Button）
  - `narrow band still shows the button`：`bodyColumns: 24` 展开时按钮仍在
- [ ] **Step 2: 运行** `claude plugin test mods/quick-tools`，预期新测试 FAIL。
- [ ] **Step 3: 实现 `register`。** 要点：
  - `ui.render` on `{ component: 'AbovePrompt' }`：外层 `Box flexDirection="column" alignItems="flex-end"`；展开时上方一个 `borderStyle="round"` 的 Box 放三行（模型行、effort 行、ULTRA 行），选中项反白（紫底深字），其他 dim，不支持的档 dim 且 `onPress` 不发命令；下方是按钮。
  - 按钮/选项都用 `Button`（鼠标可点）；`onPress` 中 `update($, …)` 与 `$.command.run`。
  - `command.run` on `{ command: 'model' }` / `{ command: 'effort' }`：`const r = await next(e)`，用 `applyCommandResult` 更新 `status`，返回 `r`。
  - `prompt.submit`：`isOpen` 置 false，`return next(e)`。
  - 初始状态：`session.start` 里用 `$.session.model()` 填 `model`；`turn.step`（主循环，`e.agentId === undefined`）里若 `e.effort` 是字符串档位则写入 `effort`，再 `return next(e)`。
  - 本 mod 自己发的 `$.command.run` 不会经过自己的 `command.run` hook（API 规定跳过调用者），所以 `onPress` 在 `await $.command.run(...)` 后用返回的 `text` 调 `applyCommandResult`。
- [ ] **Step 4: 运行** `claude plugin test mods/quick-tools` 全 PASS；`claude plugin validate mods/quick-tools` 无错；`tsc -p mods/quick-tools`（types 已生成时）无错。
- [ ] **Step 5: Commit** `feat(quick-tools): band 按钮与切换面板`

### Task 3: marketplace 与 README

**Files:**
- Create: `.claude-plugin/marketplace.json`（仓库根）：`{ "name": "claude-tools", "owner": { "name": "Daneaz" }, "plugins": [{ "name": "quick-tools", "source": "./mods/quick-tools", "description": "…" }] }`，字段以 `reference.md` 的 Sharing 一节为准
- Modify: `README.md`：`## mods` 下加 quick-tools 一段（作用一句、截图式 ASCII、安装命令 `/plugin install quick-tools --marketplace Daneaz/claude-tools`）
- Delete: `mods/.gitkeep`

- [ ] **Step 1:** 写上述文件。
- [ ] **Step 2: 运行** `claude plugin validate .` 与 `claude plugin validate mods/quick-tools`，预期无错误。
- [ ] **Step 3: Commit** `docs(quick-tools): marketplace 与安装说明`

### 收尾（主会话，合并后在主检出做）

- `claude plugin marketplace add /Users/eugenewu/code/claude-tools` → `claude plugin install quick-tools@claude-tools`（folder marketplace，直接读主检出的文件，见 `reference.md` 第 76 行）。
- `/reload-plugins` 后用户实际点一遍。
