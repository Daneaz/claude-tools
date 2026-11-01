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

对话右侧的一个 pane，显示主会话派出的每个 subagent：顶部总览在跑 / 完成 / 失败数、合计剩余步数和预计剩余时间；每个在跑的 subagent 显示任务说明、已跑时长、它自己计划的进度（`3/7`、剩几步、预计剩余）和当前在做的那一步；结束的缩成一行放到底部「已结束」下。用 `/subagents` 开关 pane（默认关闭）；与 quick-tools 同时安装时，quick-tools 面板里的 ` ◧ SubAgents ` 开关效果相同。

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

## skills

待添加。
