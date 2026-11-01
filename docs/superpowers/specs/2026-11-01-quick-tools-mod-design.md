# quick-tools mod 设计

日期：2026-11-01

## 意图

切换模型、effort、ultracode 现在要手动敲 `/model`、`/effort`，慢。quick-tools 是一个 Claude Code mod，在 terminal 输入框上方的 band 最右侧常驻一个按钮，鼠标点开一个小菜单，一点即切。

## 目标

- band 最右侧常驻按钮，显示当前状态。
- 点击按钮，在按钮上方展开一个靠右对齐的小面板（band 自身展开，不是 `Pane`）。
- 面板里一键切换：4 个模型、5 档 effort、ultracode 开关。
- 全程鼠标可用；键盘可用是附带的，不是目标。

## 非目标

- 「未来新 mod 的开关」：本次不做，以后单独设计。
- 不用 `$.ui.open` 的 `Pane`（它的位置由 engine 决定，没法出现在按钮上方）。
- 不支持 terminal 以外的 surface（desktop / vscode / mobile 什么都不画，直接 `next(e)`）。用户 2026-11-02 决定：桌面 app 不用 quick-tools（原生按钮里颜色不生效，选中态表达不出来）。

## 反目标（做到了也算失败）

- 面板常驻展开、挡住对话。
- 显示的状态和实际不符（比如用户手动敲了 `/model sonnet`，按钮还显示 Opus）。
- 挡住 engine 自己的 survey：`AbovePrompt` 的 `hasSurvey` 为真时必须让位。

## 约束

- 位置：`ui.render` 上 `{ component: 'AbovePrompt' }` 的 band。engine 在 band 最右侧固定画 `[-]`（折叠整条 band），占 5 格，mod 去不掉；按钮排在它左边。`bodyColumns` 已扣除这 5 格。
- 切换手段：`$.command.run`，等同于用户敲 `/model <x>`、`/effort <x>`。它在 session 空闲时才执行，所以 Claude 正在回答时点击会排队，下一轮生效。这是可接受的。
- 已知副作用（用户已接受）：`/effort <level>` 会把该档存为新 session 的默认值；ultracode 只作用于当前 session。
- 交付（用户决定）：常驻，每个新 session 都加载。源码只有一份，放在本仓库 `mods/quick-tools/`；本仓库加 `.claude-plugin/marketplace.json`（`"source": "./mods/quick-tools"`）作为 marketplace，用 `claude plugin install` 装上；README 补安装说明。开发期可用 `--plugin-dir` 或 dev-mods 热加载验证，但不留第二份源码。

## 外观（用户选定：C 修订版）

配色沿用 `statusline/statusline-command.sh`：模型紫 `199;146;255`、dim 灰 `107;112;128`，ULTRA 彩虹渐变同 statusline 里的那组 RGB。

收起：

```
                                              ⚡ Opus · high · ✦  [-]
```

- 文字 `⚡ <模型短名> · <effort>`，ultracode 开时末尾加 ` · ✦`。

展开（按钮上方，靠右）：

```
                                 ╭──────────────────────────────────╮
                                 │ Fable  [Opus]  Sonnet  Haiku     │
                                 │ low  medium  [high]  xhigh  max  │
                                 │  ✦ ULTRA                         │
                                 ╰──────────────────────────────────╯
                                              ⚡ Opus · high ▾    [-]
```

- 第 1 行：模型 Fable / Opus / Sonnet / Haiku，选中项反白（紫底深字），其余 dim。
- 第 2 行：effort low / medium / high / xhigh / max，同上，用文字不用进度条。
- 第 3 行：` ✦ ULTRA ` 徽章本身就是开关。开：彩虹底；关：灰底 dim 字。
- 展开时按钮末尾显示 `▾`。

## 行为

- 点按钮：展开 / 收起。
- 点模型或 effort 选项：执行对应命令；面板**保持展开**，方便连改几项（我的决定）。
- 点 ULTRA：切换 ultracode。
- 再点按钮收起；另外用户提交 prompt 时自动收起（我的决定，防止面板一直挡着对话）。执行时裁定：不做 Esc 收起（band 拿不到不打扰 composer 的 Esc），收起只有这两种方式。
- 点已选中的模型或 effort：不发命令。
- 切换模型时 effort（用户决定：如实显示）：Claude Code 按模型分别存 effort，切模型后按钮与面板显示新模型实际的 effort，mod 不补发 `/effort`。新模型不支持的档位在面板里置灰、点击无效。各模型支持哪些档位由 builder 实测确认。执行时实测：2.1.316 上四个模型都支持全部 5 档（只有 settings 的 `maxEffortLevel` 或组织上限会截断），所以置灰逻辑保留但目前不会触发。
- 切模型后 effort 的来源（执行时裁定）：`/model` 的输出不带 effort，切换后按钮先显示 `?`，直到下一次主循环请求的 `turn.step` 报上实际值。picker、meta+p、`/config`、fast mode、fallback 换的模型由 `classic.PostModelSwitch` 观察到，同样把 effort 置为 `?`。
- 状态来源：除了记住自己点过什么，还要观察用户手动敲的 `/model`、`/effort`（`command.run` hook 里 `await next(e)` 后读结果），保证按钮显示与实际一致。
- 模型映射：Fable → `claude-fable-5-1`，Opus → `claude-opus-5-5`，Sonnet → `claude-sonnet-5-5`，Haiku → `claude-haiku-5-5`。执行时裁定：发给 `/model` 的是 alias（`fable` / `opus` / `sonnet` / `haiku`，实测可用），这样存为新 session 默认值的也是 alias；识别时 id、alias、display name 都认。

## 留给 builder 的

- ultracode 用什么命令参数切换（`/effort` 的哪个参数），以及 `/effort`、`/model` 输出文本的确切格式。已知输出样例：`Set effort level to high (saved as your default for new sessions): …`、`Ultracode on (this session only)`、`Ultracode off. Effort stays medium.`。先用 `$.command.list()` 或实测确认。
- session 启动时如何拿初始 effort / ultracode 状态（`$.session.model()` 能拿模型；effort 可从 `turn.step` 的 `e.effort` 或 settings 推）。拿不到时按钮显示 `?` 也可以，第一次切换后即准确。
- `$.state` 的具体结构、types 合约、测试细节。
- 按 plugin-authoring 的要求：`claude plugin validate`、`tsc -p`、`claude plugin test` 全绿。
