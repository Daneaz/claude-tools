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

- 在 macOS 上开发和测试。
- Linux 上主体可用，但重置时间用了 BSD 的 `date -r <秒>`，GNU `date` 不认，`↻` 后面的时间会显示为空。

## mods / skills

待添加。
