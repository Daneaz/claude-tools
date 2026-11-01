# claude-tools

个人 Claude Code 配置收藏：statusline、mods、skills。

## statusline

`statusline/statusline-command.sh`：身份段（项目 / worktree / 分支 / 模型 / effort / ULTRA 徽章）+ 仪表段（ctx / 5h / 7d 用量进度条）。终端放得下就一行，否则折两行。

依赖：`jq`、Nerd Font（如 DroidSansM Nerd Font Mono）、支持真彩的终端。

安装：

```sh
cp statusline/statusline-command.sh ~/.claude/
```

在 `~/.claude/settings.json` 中加入：

```json
"statusLine": {
  "type": "command",
  "command": "sh ~/.claude/statusline-command.sh"
}
```

## mods / skills

待添加。
