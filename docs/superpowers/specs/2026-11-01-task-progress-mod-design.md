# task-progress mod 设计

日期：2026-11-01

## 意图

模型接到任务后会先列一个计划（`TodoWrite`，或 `TaskCreate` / `TaskUpdate`），但这个计划在 terminal 里很快被刷走，用户想知道「做到第几步了、还剩多少」只能往上翻。task-progress 是一个 Claude Code mod，在 prompt 输入框上方的 band 里常驻一行进度，一眼读出当前位置；点一下展开成清单，看每个任务的状态、当前任务「正在干什么」的那句描述，以及正在跑的 subagent。

用户最关心的顺序：先是「第几步 / 还剩多少」，其次是「此刻在干什么」（任务级那句描述就够，不需要细到在动哪个文件、跑哪条命令）。

## 目标

- 有计划时，band 里一行显示：分段进度 + `当前序号/总数` + 当前任务标题 + `还剩 N 个`。
- 点击这一行展开 / 收起任务清单，每个任务一行，带自己的状态进度条与描述。
- 计划全部完成后显示一行完成提示，用户下次提交 prompt 时消失。
- 展开后显示正在跑的 subagent（用户决定）。
- 多个任务同时进行中时，如实显示多个进行中（用户决定）。
- 无需模型配合：只监听模型本来就会调用的计划工具。

## 非目标

- 真实的百分比进度：计划工具里只有三种状态（待办 / 进行中 / 完成），进度条是「虚拟」的（用户决定）。
- 工具级细节（正在读哪个文件、跑哪条命令）、每个任务的耗时和操作次数：用户明确不要。
- 跨 session 保留进度：只看当前 session。
- vscode / mobile surface（直接 `next(e)`）。desktop 也画（用户决定，2026-11-02）：`AbovePrompt` 只在 terminal 与 desktop 上出现；桌面端是比例字体，所有 Text 用 `mono` 保证列对齐。

## 反目标（做到了也算失败）

- 显示的进度和模型实际计划不符（漏了更新、任务顺序错、已删除的任务还在）。
- 没有计划时 band 里留空行或占位。
- 收起状态下还在定时重绘（动画只在展开且有进行中任务时跑）。
- 挡住 engine 自己的 survey：`AbovePrompt` 的 `hasSurvey` 为真时让位。
- 把同一条 band 上的 quick-tools 按钮挤掉或盖住（见「约束」）。

## 外观（用户选定）

收起（例：5 个任务，第 1 个完成，第 2 个进行中）：

```
▰▰▱▱▱  2/5  写代码  还剩 3 个
```

- 开头是小胶囊符号，每个任务一个：完成 = 绿色 `▰`，进行中 = 蓝色 `▰`，未开始 = 暗色 `▱`。（完成用绿色是我的决定，为了和展开后一致；用户看过未反对。）
- `2/5` 蓝色加粗；任务标题正常色；`还剩 N 个` dim。N = 未开始的任务数。

展开（点击收起行后，收起行保留在最上面，下面是清单）：

```
▰▰▱▱▱  2/5  写代码  还剩 3 个

  ✓  查代码        ▰▰▰▰▰▰▰▰▰▰  Done
  ›  写代码        ▱▱▰▰▰▱▱▱▱▱  正在写代码
     review 代码               Next
     跑测试                    Next
     提交                      Next
```

- **完成**：`✓` 绿色，任务名 dim，绿色满格进度条（10 格），描述 `Done`（绿色）。
- **进行中**：`›` 蓝色，任务名加粗亮色，进度条是一段 3 格蓝色亮光在 10 格暗轨里来回扫（不代表百分比，只表示「在跑」），描述是该任务的 `activeForm`（如「正在写代码」），蓝色。
- **未开始**：无符号，任务名 dim，**没有进度条**，描述 `Next`（dim），与上面的描述列对齐。
- 任务名、进度条、描述三列竖向对齐。
- 全部完成：一行 `✓ 5/5 全部完成`（绿色），可展开，清单全部为 Done。

多个任务并行（用户决定：都显示为进行中）：

```
▰▰▰▱▱  2/5  写代码 +1  还剩 2 个

  ✓  查代码        ▰▰▰▰▰▰▰▰▰▰  Done
  ›  写代码        ▱▱▰▰▰▱▱▱▱▱  正在写代码
  ›  写测试        ▱▱▱▱▱▰▰▰▱▱  正在写测试
     review 代码               Next
```

- 每个进行中的任务都是蓝色胶囊、`›`、各自的扫动进度条。
- 收起行（我的决定）：序号与标题取第一个进行中的任务，标题后加 dim 的 `+N`（N = 其余进行中的数量）。

正在跑的 subagent（用户决定：显示）：

```
▰▰▱▱▱  2/5  写代码  还剩 3 个  · 1 个 subagent

  ✓  查代码        ▰▰▰▰▰▰▰▰▰▰  Done
  ›  写代码        ▱▱▰▰▰▱▱▱▱▱  正在写代码
       ↳ subagent  实现登录接口                运行中
     review 代码               Next
```

- 每个正在跑的 subagent 一行：`↳ subagent`（dim）+ 派它时的说明（`Agent` 工具入参的 `description`）+ `运行中`（蓝色）。没有进度条。（排版是我的决定）
- 挂在哪（我的决定）：恰好一个任务进行中时，挂在它下面；没有或多于一个时，统一列在清单最后。
- 收起行（我的决定）：有 subagent 在跑时，末尾加 dim 的 `· N 个 subagent`。
- subagent 结束（成功、失败或被停掉）就移除这一行。没有计划、只有 subagent 在跑时，band 不出现（band 的前提是有计划；我的决定）。

配色（用户看过的深色版）：绿 `#7ec699`、蓝 `#8ab4ff`、完成名 dim `#55606e`、未开始胶囊 `#3b424d`、说明文字 `#6b7480`。浅色终端也要可读：优先用 engine 的 theme key（绿色用 `success`；蓝色没有语义对口的 key），没有合适 key 的再用 hex；具体由 builder 取舍（我向用户说过「颜色会跟着终端主题走」）。

## 行为

- **数据来源**：`tool.call` hook 观察两套计划工具，`await next(e)` 后读结果再更新状态：
  - `TodoWrite`：整表替换，用结果里的 `newTodos`（`content` 作标题，`activeForm` 作描述）。
  - `TaskCreate` / `TaskUpdate`：增量。`TaskCreate` 用结果里的 `task.id` 和入参的 `subject` / `activeForm` 追加；`TaskUpdate` 按 `taskId` 改 `subject` / `activeForm` / `status`，`status: 'deleted'` 时移除。顺序按创建顺序。
  - 工具调用失败（结果是错误）时不改状态。
- **新计划的开始**（我的决定）：`TodoWrite` 天然整表替换；`TaskCreate` 时若当前列表已全部完成（或已在完成后被清掉），就从空列表重新开始，否则追加。
- **当前任务**：所有 `in_progress` 的任务都算进行中；收起行用第一个。没有进行中的任务时（两个任务之间），收起行显示「下一个未开始任务」的序号与标题，胶囊里没有蓝色那格。（我的决定）
- **计划完成**：所有任务都是完成状态时显示完成行；下一次 `prompt.submit` 时清空计划，band 消失。
- **展开 / 收起**：点击收起行切换；默认收起。展开状态在计划清空后重置为收起（我的决定）。
- **subagent 跟踪**：只跟踪主会话派出的 subagent（嵌套的不算）。前台 `Agent` 调用可用 `tool.call` 包住 `next(e)` 得到起止；后台运行（`run_in_background`）的 `Agent` 调用会立刻返回，结束要靠别的信号。builder 查 API（`agent.spawn`、`SubagentStart` / `SubagentStop` 一类事件）选一个能同时覆盖前台和后台的起止来源。
- **动画**：只在展开且有进行中任务时，用 `$.clock.every`（约 160ms）推进亮光位置；收起、无进行中任务或计划清空时停掉计时器。
- **subagent 的计划**（我的决定）：只显示主会话的计划。区分依据：`tool.call` 输入的 `agentId` 在主循环里不存在，在 subagent / teammate 里有值（quick-tools 在 `turn.step` 上已这样判断）。规则：
  - 带 `agentId` 的 `TodoWrite`、`TaskCreate` 忽略（subagent 自己的计划不进 band）。
  - `TaskUpdate` 不论谁调，只要 `taskId` 在主表里就照常应用：任务表是 session 共享的，常见做法是主会话建任务、subagent 把它标为完成，丢弃这些更新会让任务卡在「进行中」。
- **失败判定**：结果为 `{ deny }`、带 `isError`，或 `TaskUpdate` 结果的 `success === false`，都视为失败，不改状态。
- **`TaskCreate` 的字段**：结果只有 `{ task: { id, subject } }`，`activeForm` 从入参取（可选，缺省时描述显示「进行中」），初始状态为未开始。
- **长文本**：任务名过长时截断加 `…`，保证一行不折行；收起行在窄终端里优先保留胶囊和 `2/5`。

## 约束

- 位置：`ui.render` 上 `{ component: 'AbovePrompt' }` 的 band。
- **与 quick-tools 共存**：本仓库的 `mods/quick-tools` 也画在这条 band 上（撑满 `bodyColumns`，按钮靠最右），而且它的 render hook 不调用 `next(e)`，排在它下面的 mod 画不出来。task-progress 必须调用 `next(e)` 并把下层的树一起放进自己的返回里；quick-tools 也要改成同样组合 `next(e)`，否则谁在上层谁独占 band。两者的排布由 builder 决定（同一行左右分，或 task-progress 单独占上一行），前提是互不遮挡、quick-tools 按钮仍在最右。
- 交付沿用 quick-tools 的方式：源码放在本仓库 `mods/task-progress/`，在 `.claude-plugin/marketplace.json` 里加一项，README 补安装说明。
- 按 plugin-authoring 的要求：`claude plugin validate`、`tsc -p`、`claude plugin test` 全绿；状态放 `$.state`，有 `types/index.d.ts` 合约。

## 留给 builder 的

- `$.state` 的具体结构、合约、测试细节（参照 `mods/quick-tools` 的 `logic.ts` + 测试分法：纯逻辑与渲染分开测）。
- theme key 与 hex 的取舍。
- 与 quick-tools 同 band 的具体排布。
- subagent 起止的事件来源。
- 用户正在看某个 agent 的 transcript 时（`AbovePrompt` 的 `view.agentId` 有值）band 是否照常显示主计划。
