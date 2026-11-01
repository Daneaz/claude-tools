# blast-radius mod 设计

日期：2026-11-02

## 意图

用户要求把 claude-code-playground 里的 Blast Radius mod（<https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius>）**按自己的美术风格复制一份**，放进本仓库。行为照搬原版，只换外观和文案，让它和本仓库的 statusline、quick-tools、task-progress 看起来是同一套东西。

原版做的事：Claude 调 Bash 跑危险命令时先拦下，量出命令会影响什么（删哪些文件、丢哪些改动、丢哪些 commit），在 pane 里列出来，等用户按「执行」或「取消」。取消时把原因以 `deny` 返回给 Claude。

## 目标

- 行为与原版一致（下面「行为」一节逐条列出）。
- 外观换成用户选定的 B 版（见「外观」），文案改中文。
- 与本仓库其他画在 band 上的 mod 共存（见「约束」）。

## 非目标

- 不扩大拦截范围，不修原版 README 里列出的已知局限（不完整解析 shell、`bash -c`、`xargs rm`、`find -delete`、`timeout 5 rm` 等包装都不拦）。
- 不做权限系统、不做 sandbox：按「执行」后命令原样运行。
- 只看 Bash 工具。

## 反目标（做到了也算失败）

- 危险命令没被拦、或被拦后用户没机会选就跑了。
- 按 Enter 默认执行（焦点必须默认在「取消」上）。
- 测量步骤本身执行了路径里的内容（必须把路径作为参数传，不经 shell 拼接；相对路径给 `find` 时加 `./` 前缀）。
- 窄终端里报告或按钮被其他 mod 挤掉，导致用户看不到、只能等 10 分钟超时。

## 行为（照搬原版）

原版源码：`claude-code/mods/blast-radius/hooks/blast-radius.mjs`（528 行），README 同目录。builder 应以原版源码为准，以下是要点：

- **拦截哪些命令**，以及 pane 里显示什么：

  | 命令 | 显示 |
  |---|---|
  | `rm -r` / `rm -f` / `rm -rf` | 会删除的文件（展开 glob 与 `~`），数量与总大小（`find` 计数、`du -k` 算大小），列前 10 个 |
  | `git reset --hard` | `git status --porcelain` 里有改动的文件 + `git diff --shortstat` |
  | `git checkout -- .`、`git restore .` | 未暂存改动的文件 |
  | `git clean` | `git clean -n`（带同样 flag）列出的未跟踪路径 |
  | `git push --force` / `-f` / `--force-with-lease` / `+ref` | 远端分支上本地 HEAD 没有、会被丢掉的 commit（用上次 fetch 的结果；无 remote 名时假定 `origin`） |
  | `manage.py migrate`、`db:migrate`、`alembic upgrade`、`prisma migrate` | 用工具自己的 status 命令列出待执行的 migration |
  | 其他 `migrate` | 提示没法列出 |

- 跟随同一行里的 `cd dir &&`、`pushd`/`popd`、`git -C dir`；`( ... )` 里的 `cd` 只在括号内生效。目录不存在或 `cd -` 时提示量不了，但仍然拦。
- 一次只拦一个；第二个危险调用（如 subagent 的）排队等前一个答完。按钮永远回答它画出时对应的那条命令。
- 等待方式：hook 自身只有 10 秒预算，所以用 `$.process.run(["sleep", ...])` 轮询，直到按钮写入决定。
- 结束条件：执行 / 取消 / 10 分钟无人回应（拒绝）/ 用户 Esc 中断（拒绝）/ 拦截期间出错（拒绝）。拒绝时返回 `{ deny }`，原因里说明为什么、本来会造成什么，并告诉 Claude 除非用户要求不要重试。`deny` 文案用中文还是英文由 builder 定（是给模型看的）。
- 「执行」后 toast 一句提示再放行。
- 终端够宽时开 `Pane`；`isPlaced` 为假（放不下）时改画在 `AbovePrompt` band。
- 按键：`1` 执行、`2` 取消，鼠标可点；band 里在输入框为空时 `1` / `2` 生效。

## 外观（用户选定：B 版，无框 + 左侧色条）

pane 里（例：`rm -rf build`）：

```
▎⚠ 拦截  rm -rf build
▎
▎▰▰▰▰▰▰▰▰▰  删除 9 个文件  1.1 MB
▎
▎  − build/assets/logo.png
▎  − build/index.html
▎  − build/js/app.js.map
▎  − build/js/chunk-1.js
▎    … 还有 5 个
▎
▎[1 执行]  [2 取消]   Claude 在等你决定
```

- 不画方框；每行左边一条琥珀色竖线 `▎`。
- 标题：`⚠ 拦截` 琥珀色加粗，后面是完整命令（亮色加粗，过长截断）。
- 影响行：红色 `▰` 胶囊表示规模，后面是红色加粗的摘要（如「删除 9 个文件」），dim 的附加信息（大小、`+2 −1` 等）。胶囊个数与数量的映射由 builder 定（例如按数量封顶 10 个；不适合计数的类型如 migrate 可以不画胶囊）。
- 列表：每项前缀按类型着色——删除类用红色 `−`；git 状态类沿用状态字母（`A` 绿、`M` 蓝、其他 dim）。路径里与命令目标相同的前缀（如 `build/`）可 dim（我的决定，mockup 里这样画，用户选了这版）。超出 10 个时 dim 的「… 还有 N 个」。
- 说明 / 无法测量的提示：dim。
- 按钮：`1 执行`、`2 取消`；焦点默认在「取消」，聚焦的按钮用蓝色底。后面 dim 的「Claude 在等你决定」。
- band 版（窄终端）：同样风格，压成更少的行，例：

```
▎⚠ 拦截  git reset --hard   丢弃 2 个文件的未提交改动  +2 −1
▎  A  NOTES.md
▎  M  src/math.js
▎[1 执行]  [2 取消]   未提交的改动无法恢复
```

配色沿用 task-progress spec：绿 `#7ec699`、蓝 `#8ab4ff`、dim `#6b7480`、暗 `#3b424d`；新增琥珀 `#ffb84d`、红 `#ff5f5f`（都取自 `statusline/statusline-command.sh` 里已有的 RGB）。浅色终端优先用 engine 的 theme key（红用 `error`、琥珀用 `warning` 一类、绿用 `success`），没有对口 key 的再用 hex；具体取舍由 builder 定。

## 约束

- **band 共存**：本仓库 quick-tools、task-progress（均已合入 `main`）都画在 `AbovePrompt` band，且都组合 `next(e)`；replay-theater 也会画在上面。用户同意的优先级：**Blast Radius 拦截时最优先**，其次是回放提示，平时显示 quick-tools / task-progress。
  - 不拦截时 Blast Radius 的 render hook 直接 `return next(e)`。
  - 拦截且画在 band 时，Blast Radius 只返回自己的报告，不组合下层（独占）。
  - mod 之间的 hook 顺序本 mod 控制不了：若别的 mod 排在它上层，它们组合 `next(e)` 后会把自己的内容叠上去。底线是 Blast Radius 的报告和两个按钮完整可见、不被挤掉。为此本仓库所有画 band 的 mod（含 replay-theater，即使在 band 里展开回放时）都必须组合 `next(e)`、永不吞掉下层（我的决定，replay-theater spec 已同步）。
- **surface**：照搬原版，不按 surface 区分，所有 surface 都拦（我的决定）。理由：放行违反「没机会选就跑了」这条反目标；拦着最坏是超时拒绝，命令不会被执行，偏安全。pane 放不下就退到 band，与原版一致。
  - `hasSurvey` 为真时不让位——拦截比 survey 重要（我的决定，因为让位会让用户看不到按钮、只能等超时）。builder 若发现两者会冲突导致按钮不可用，再按实际情况处理。
- 交付沿用 quick-tools 的方式：源码在 `mods/blast-radius/`，TypeScript（`.tsx`）+ `types/index.d.ts` 合约 + 测试；在 `.claude-plugin/marketplace.json` 加一项；README 补安装说明，注明改编自 claude-code-playground 的 Blast Radius。
- 按 plugin-authoring 的要求：`claude plugin validate`、`tsc -p`、`claude plugin test` 全绿。
- 原版的分类器、测量步骤、拦截队列都有测试覆盖（原版 README 提到），本版同样要有：分类器（各命令、`cd`/`git -C` 跟随、不该拦的命令）、测量（用临时目录真跑 `find`/`du`/git）、队列与决定（按钮回答对应命令、超时、中断、出错都拒绝）、渲染。

## 留给 builder 的

- 从原版 `.mjs` 移植成 `.tsx` 时的模块拆分（参照 quick-tools 的 `logic.ts` + `register.tsx`：纯逻辑与渲染分开测）。
- theme key 与 hex 的取舍、胶囊个数映射。
- `deny` 文案的语言。
- pane 的行数与宽度。
