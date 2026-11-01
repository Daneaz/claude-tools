# replay-theater mod 设计

日期：2026-11-02

## 意图

用户要求把 claude-code-playground 里的 Replay Theater mod（<https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater>）**按自己的美术风格复制一份**，放进本仓库。行为照搬原版，只换外观和文案，让它和本仓库的 statusline、quick-tools、task-progress 看起来是同一套东西。

原版做的事：一轮里记下 Claude 的每次文件编辑（Edit / Write / MultiEdit），轮次结束后在输入框上方提示，用户打开后在 pane 里一步一步看每次编辑的 diff。只观察，从不拦截、修改或延迟编辑。

## 目标

- 行为与原版一致（下面「行为」一节逐条列出）。
- 外观换成用户选定的 B 版（见「外观」），文案改中文。
- 与本仓库其他画在 band 上的 mod 共存（见「约束」）。

## 非目标

- 不改原版的已知局限：Edit 的 diff 只在 `old_string` / `new_string` 之间、不显示文件行号；被拒或失败的编辑也照样记录；只存在内存里，重启丢失；subagent 的编辑并入主轮次。
- 不自动弹出 pane（原版也是只提示，按需打开）。

## 反目标（做到了也算失败）

- 影响编辑本身：任何记录出错都不能挡住工具调用（必须总是 `next(e)`）。
- 回放内容与实际编辑不符（漏步、顺序错、文件名错）。
- band 上的提示把 quick-tools 按钮或 task-progress 进度挤掉。

## 行为（照搬原版）

原版源码：`claude-code/mods/replay-theater/hooks/replay-theater.mjs`（249 行），README 同目录。builder 应以原版源码为准，以下是要点：

- **记录**：`tool.call` 上 Edit / Write / MultiEdit 记一步（文件、工具、改前改后）。MultiEdit 每个 edit 一步。Write 改前内容在写入前从磁盘读；超过 400 行的文件显示为全删再全加，不做行匹配。
- **按轮分组**：`turn.start`（主循环，非 subagent）清空待记列表；`turn.complete`（主循环）时若有编辑，替换为新的回放、从第 1 步开始。没有编辑的轮次保留上一份回放。
- **diff**：每处改动只保留 1 行上下文，跳过的部分显示 `⋯`；每步最多 12 行，超出显示「… 还有 N 行」；没有行变化时显示「（无行变化）」。
- **打开方式**：`/replay` 命令（`session.start` 里注册，`command.run` 处理）；或 band 提示上的按钮（不设热键，见「约束」）。点 band 按钮时 band 占着键盘，要先隐藏 band、稍等再开 pane（原版等 200ms）。
- **pane**：`n` 下一步、`p` 上一步、`c` 或 Esc 关闭，鼠标可点。`ui.close`（Esc）时同步状态。
- **窄终端**：`isPlaced` 为假时把回放画在 `AbovePrompt` band 里，diff 行数按 `maxRows` 收缩。

## 外观（用户选定：B 版，清单 + 当前步 diff）

轮次结束后 band 上的提示：

```
▶ 回放  ▰▰▰▰▰  5 处编辑  3 个文件 · 点击或 /replay
```

（mockup 里写的是「按 r 或 /replay」，因去掉热键改为「点击或 /replay」。）

- `▶` 与「5 处编辑」紫色（`#c792ff`，quick-tools 的模型紫），「5 处编辑」加粗；胶囊每步一个，绿色；后半句 dim。
- 胶囊过多时封顶（个数由 builder 定，例如 10 个后加 `+N`）。
- 保留可点击的打开入口（按钮样式由 builder 定，与 quick-tools 的按钮风格一致即可）。

打开后（例：第 2/5 步）：

```
▶ 回放  ▰▰▱▱▱  2/5  3 个文件

  ✓  greet.js    Edit  +1 −1
  ›  main.js     Edit  +1 −1
     main.js     Edit  +1 −1
     README.md   Edit  +1 −1
     greet.js    Edit  +1 −1

     − import { greet, greetAll } from "./greet"
     + import { welcome, greetAll } from "./greet"

[‹ p]  [n ›]  [c 关闭]
```

- 标题行：紫色加粗 `▶ 回放`；胶囊每步一个——看过的绿 `▰`、当前紫 `▰`、没看的暗 `▱`；`2/5` 紫色加粗；文件数 dim。
- 步骤清单（布局同 task-progress 展开清单）：看过的 `✓` 绿色、文件名 dim；当前步 `›` 紫色、文件名亮色加粗；没看的整行 dim。列：文件名、工具名（dim）、`+N`（绿）`−N`（红）竖向对齐。文件名过长从开头截断。「看过」= 序号小于当前步（我的决定）。
- 步骤多时清单需要限高：只显示当前步附近的一个窗口，上下用 dim 的「… N 步」表示省略（我的决定，窗口大小由 builder 定）。
- diff：缩进与清单的文件名列对齐；删行红字配暗红底 `#3a1f22`，加行绿字配暗绿底 `#1c3326`；上下文行与 `⋯` dim。
- 按钮：`‹ p` 上一步、`n ›` 下一步（默认焦点，紫底）、`c 关闭`。第 1 步时上一步、最后一步时下一步的表现由 builder 定（原版是夹在边界不动）。
- band 版（窄终端）：同样结构，清单与 diff 按 `maxRows` 收缩。

配色沿用 task-progress spec：绿 `#7ec699`、蓝 `#8ab4ff`、dim `#6b7480`、暗 `#3b424d`、完成名 dim `#55606e`；新增紫 `#c792ff`、红 `#ff5f5f`（取自 `statusline/statusline-command.sh`）、diff 底色两个。浅色终端优先用 engine 的 theme key（绿 `success`、红 `error`），diff 底色在浅色终端下若不可读可以去掉底色只留字色；具体由 builder 定。

## 约束

- **band 共存**：本仓库 quick-tools、task-progress（均已合入 `main`，都组合 `next(e)`）画在 `AbovePrompt` band，blast-radius 也会。用户同意的优先级：Blast Radius 拦截时最优先，**其次是回放提示**，平时显示 quick-tools / task-progress。
  - 「优先」只指上下顺序：回放提示单独占一行，放在下层内容的上方（我的决定）。mod 之间的 hook 顺序由 engine 定；若回放排在 task-progress 下层、被其 `RESERVED` 行数挤掉，接受，不为此改 task-progress / quick-tools（我的决定）。
  - 永远组合 `next(e)`、不吞掉下层——包括窄终端下回放在 band 里展开时（回放画在上，下层照常附在下面）。这是为了保证 Blast Radius 拦截时的按钮永远可见（我的决定，与 blast-radius spec 一致）。
  - `hasSurvey` 为真时让位，直接 `next(e)`（同 quick-tools）。
  - 提示一直留到下一份回放替换它（照搬原版）。
- **热键 `r`**（我的决定）：band 提示上的按钮**不设单键热键**。原版的 `r` 在输入框为空时会抢走用户新 prompt 的第一个字母（如 "run tests"），提示又常驻，这个问题会一直在。打开方式保留：`/replay`、鼠标点击、键盘聚焦 band 后按 Enter。pane 里的 `n` / `p` / `c` 不受影响（pane 持有焦点时才生效）。
- **状态存放**（我的决定）：回放数据放模块变量（同原版），`/clear` 后回放仍在；UI 开关类小状态可放 `$.state`。合约 `types/index.d.ts` 照常写。
- **surface**：照搬原版，不按 surface 区分（我的决定）。
- 交付沿用 quick-tools 的方式：源码在 `mods/replay-theater/`，TypeScript（`.tsx`）+ `types/index.d.ts` 合约 + 测试；在 `.claude-plugin/marketplace.json` 加一项；README 补安装说明，注明改编自 claude-code-playground 的 Replay Theater。
- 按 plugin-authoring 的要求：`claude plugin validate`、`tsc -p`、`claude plugin test` 全绿；状态放 `$.state`。
- 测试覆盖：diff 生成（上下文裁剪、`⋯`、12 行封顶、400 行以上的 Write）、按轮分组（subagent 轮次不清空、无编辑的轮次保留旧回放）、记录出错仍放行、翻页边界、渲染。

## 留给 builder 的

- 从原版 `.mjs` 移植成 `.tsx` 时的模块拆分（参照 quick-tools 的 `logic.ts` + `register.tsx`）。
- theme key 与 hex 的取舍、胶囊封顶、清单窗口大小。
- pane 的行数与宽度（原版 `rows` ≤ 22、`columns: 58`；B 版多了清单，需要相应加高）。
