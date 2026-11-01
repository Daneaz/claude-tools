# claude-tools

个人 Claude Code 配置收藏：statusline、mods、skills。

## statusline

`statusline/statusline-command.sh`

- **身份段**：项目名 / worktree / git 分支 / 模型 / effort / ULTRA 徽章
- **仪表段**：ctx（context 用量）/ 5h / 7d（rate limit 用量）进度条；<50% 绿、50–75% 黄、≥75% 红 + ⚠，附重置时间
- 终端放得下就一行，否则折两行

### 依赖

| 依赖 | 用途 | 安装（macOS） |
| --- | --- | --- |
| `jq` | 解析 Claude Code 传入的 JSON | `brew install jq`（macOS 15+ 自带 `/usr/bin/jq`） |
| Nerd Font | 文件夹 / 分支 / worktree 图标 | 见下 |
| 真彩终端 | 24-bit 颜色 | iTerm2、Ghostty、WezTerm、Kitty、VS Code 终端均可；macOS 自带 Terminal.app 不支持真彩，颜色会失真 |
| `git` | 取项目名与分支（可选） | 一般已安装 |

### 安装

**1. 安装 Nerd Font**（任意一款 Nerd Font 都行，这里用 DroidSansM）

```sh
brew install --cask font-droid-sans-mono-nerd-font
```

或从 <https://www.nerdfonts.com/font-downloads> 下载后双击安装。

**2. 把终端字体切到 Nerd Font**

在终端设置里把字体改为 `DroidSansM Nerd Font Mono`（或你装的那款）。例如：

- iTerm2：Settings → Profiles → Text → Font
- Ghostty：配置文件里加 `font-family = DroidSansM Nerd Font Mono`
- VS Code 终端：`"terminal.integrated.fontFamily": "DroidSansM Nerd Font Mono"`

不装字体也能用，只是三个图标会显示成方块 / 问号。

**3. 复制脚本**

```sh
curl -fsSL https://raw.githubusercontent.com/Daneaz/claude-tools/main/statusline/statusline-command.sh \
  -o ~/.claude/statusline-command.sh
```

**4. 配置 Claude Code**

在 `~/.claude/settings.json` 中加入：

```json
"statusLine": {
  "type": "command",
  "command": "sh ~/.claude/statusline-command.sh"
}
```

重启 Claude Code 即可看到效果。

### 自测

不启动 Claude Code，直接喂一段假数据看输出：

```sh
echo '{"cwd":"'"$PWD"'","model":{"display_name":"Opus"},"context_window":{"remaining_percentage":60},"rate_limits":{"five_hour":{"used_percentage":80,"resets_at":1793000000}}}' \
  | sh ~/.claude/statusline-command.sh; echo
```

### 平台说明

- macOS 与 Linux 均可用：重置时间先试 BSD `date -r`，失败再用 GNU `date -d @`。
- 在 macOS 上开发和实测；Linux 分支由 `tests/test_statusline_date.sh` 用模拟的 GNU `date` 覆盖。

## mods

### quick-tools

band 最右侧常驻一个按钮，点开即可一键切换模型 / effort / ultracode。

收起：

```
                                              ⚡ Opus · high · ✦  [-]
```

展开（按钮上方，靠右；再按一次按钮或提交 prompt 时收起）：

```
                                 ╭──────────────────────────────────╮
                                 │ Fable  [Opus]  Sonnet  Haiku     │
                                 │ low  medium  [high]  xhigh  max  │
                                 │  ✦ ULTRA                         │
                                 │  ◧ SubAgents                     │
                                 ╰──────────────────────────────────╯
                                              ⚡ Opus · high ▾    [-]
```

选中项紫底深字（图中用 `[ ]` 表示），其余 dim；` ✦ ULTRA ` 本身就是开关，开时彩虹底，关时灰底。
装了 subagent-view 时 ULTRA 下面多一行 ` ◧ SubAgents `，等同于 `/subagents`：pane 打开时蓝底，关闭时灰底；没装时不显示。

注意：

- 切换模型后 effort 显示 `?`，直到下一次请求时自动更新。
- 点模型 / effort 等同于手敲 `/model` / `/effort`，会存为新 session 的默认值；ultracode 只作用于当前 session。
- 开局读不到 ultracode 的状态，一律显示为关。

安装方式二选一（两种都用 marketplace 名 `claude-tools`，不要同时添加）：

从 GitHub 安装（在终端会话里输入）：

```
/plugin install quick-tools --marketplace Daneaz/claude-tools
```

随后按 `y` 添加 marketplace，再选择 scope。

本机从 clone 目录安装：

```
claude plugin marketplace add <本仓库绝对路径>
claude plugin install quick-tools@claude-tools
```

这种方式直接读 clone 目录里的 `mods/quick-tools`：改了源码后在会话里运行 `/reload-plugins` 即生效，无需重装。

### task-progress

当前 session 有计划（TodoWrite / Task 工具）时，band 上常驻一行进度，点开可逐条查看每个任务的状态；没有计划时不显示。与 quick-tools 同时安装时，进度行在上、quick-tools 按钮在下。

安装方式与 quick-tools 相同（marketplace 名同为 `claude-tools`，已添加过就不用再加）：

从 GitHub 安装（在终端会话里输入）：

```
/plugin install task-progress --marketplace Daneaz/claude-tools
```

本机从 clone 目录安装：

```
claude plugin marketplace add <本仓库绝对路径>
claude plugin install task-progress@claude-tools
```

### subagent-view

对话右侧的一个 pane，显示主会话派出的每个 subagent：顶部总览在跑 / 完成 / 失败数、合计剩余步数和预计剩余时间；每个在跑的 subagent 显示任务说明、已跑时长、它自己计划的进度（`3/7`、剩几步、预计剩余）和当前在做的那一步；结束的缩成一行放到底部「已结束」下。用 `/subagents` 开关 pane（默认关闭）；与 quick-tools 同时安装时，quick-tools 面板里的 ` ◧ SubAgents ` 开关效果相同（quick-tools 只在终端显示）。pane 支持终端与 Claude 桌面 app（VS Code 扩展里不画），桌面 app 里用 `/subagents` 开关。

```
SubAgent View          3 在跑  1 完成  1 失败
合计剩余 12 步   剩余时间约 6 分钟
──────────────────────────────────────────────
🎨 Designer  出登录页设计稿         ⠋ 4m12s
   ▰▰▰▱▱▱▱  3/7  剩 4 步             ≈ 5m
   › 正在画表单状态
```

注意：进度只按 subagent 自己列的计划步数算，预计时间只是估算；没有计划的 subagent 只显示最近一次工具调用。

安装方式与 quick-tools 相同（marketplace 名同为 `claude-tools`，已添加过就不用再加）：

从 GitHub 安装（在终端会话里输入）：

```
/plugin install subagent-view --marketplace Daneaz/claude-tools
```

本机从 clone 目录安装：

```
claude plugin marketplace add <本仓库绝对路径>
claude plugin install subagent-view@claude-tools
```

### blast-radius

改编自 claude-code-playground 的 [Blast Radius](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius)（Apache-2.0），换了配色与中文文案。Claude 用 Bash 跑危险命令前先拦下，量出会影响什么，等你选「执行」或「取消」：

| 命令 | 显示 |
| --- | --- |
| `rm -r` / `rm -f` / `rm -rf` | 会删除的文件、数量与大小 |
| `git reset --hard`、`git checkout -- .`、`git restore .` | 会丢掉改动的文件 |
| `git clean` | 会清掉的未跟踪路径 |
| `git push --force` / `-f` / `--force-with-lease` / `+ref` | 远端上会被丢掉的 commit |
| `manage.py migrate`、`db:migrate`、`alembic upgrade`、`prisma migrate` | 待执行的 migration |

终端够宽（约 144 列）时开在右侧 pane：

```
▎⚠ 拦截  rm -rf build
▎
▎▰▰▰▰▰▰▰▰▰  删除 9 个文件  1.1 MB
▎
▎  − build/assets/logo.png
▎  − build/index.html
▎    … 还有 7 个
▎
▎[1 执行]  [2 取消]   Claude 在等你决定
```

窄终端画在输入框上方的 band，按钮排在第 2 行，保证不被其他 mod 挤出视野：

```
▎⚠ 拦截  git reset --hard   丢弃 2 个文件的未提交改动  +2 −1
▎[1 执行]  [2 取消]   未提交的改动无法恢复
▎  A  NOTES.md
▎  M  src/math.js
```

- 按 `1` 执行、`2` 取消，也可以点按钮；焦点默认在「取消」，直接回车不会执行。
- 10 分钟没人回、按 Esc 中断、手动关掉 pane、拦截中出错，一律拒绝，命令不会跑。
- 一次只拦一个，第二个危险调用排队。

已知局限：

- 只读命令文本，不完整解析 shell：`bash -c "…"`、`xargs rm`、`find -delete`、`timeout 5 rm` 等包装拦不到。这是安全网，不是权限系统，硬性禁止请用 permission rules。
- band 里输入框为空时按 `1` 就会执行，正好要输入以「1」开头的消息时注意。
- band 被折叠（ctrl+x ctrl+a）时看不到拦截，只能等超时拒绝。
- 测量 migration 时会跑项目自己的 status 命令（会加载项目代码）。

安装：

```
/plugin install blast-radius --marketplace Daneaz/claude-tools
```

或本机：`claude plugin install blast-radius@claude-tools`（先按上文添加 marketplace）。

### replay-theater

改编自 claude-code-playground 的 [Replay Theater](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater)（Apache-2.0），换了版式、配色与中文文案。记下一轮里 Claude 的每次文件编辑（Edit / Write / MultiEdit），轮次结束后在 band 上提示，打开后逐步看每次编辑的 diff。只观察，不拦截、不改动编辑。

轮次结束后的提示：

```
▶ 回放  ▰▰▰▰▰  5 处编辑  3 个文件 · 点击或 /replay
```

打开后：

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

- 打开：`/replay`，或点提示（提示不设单键热键，免得吃掉你输入的第一个字母）。
- pane 里 `n` 下一步、`p` 上一步、`c` 或 Esc 关闭。
- 回放一直保留到下一轮有编辑的轮次；没有编辑的轮次不替换。

已知局限：

- Edit 的 diff 只在 `old_string` / `new_string` 之间，不显示文件行号；每步最多 12 行。
- 被拒或失败的编辑也会记录；subagent 的编辑并入主轮次。
- 只存在内存里，重启 Claude Code 或重载插件后丢失。

安装：

```
/plugin install replay-theater --marketplace Daneaz/claude-tools
```

或本机：`claude plugin install replay-theater@claude-tools`。

## skills

待添加。
