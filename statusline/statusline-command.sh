#!/bin/sh
# Claude Code statusline:身份段(项目/worktree/分支/模型/ULTRA)+ 仪表段(ctx/5h/7d)
# 图标需要 Nerd Font(DroidSansM Nerd Font Mono)。放得下一行就一行,否则折两行。
export LC_ALL=en_US.UTF-8
input=$(cat)

# 一次 jq 取全部字段(制表符分隔)
IFS='	' read -r cwd model effort remaining five_pct five_reset week_pct week_reset worktree transcript <<EOF
$(printf '%s' "$input" | jq -r '[
  (.cwd // .workspace.current_dir // "?"),
  (.model.display_name // "?"),
  (.effort.level // ""),
  (.context_window.remaining_percentage // "" | tostring),
  (.rate_limits.five_hour.used_percentage // "" | tostring),
  (.rate_limits.five_hour.resets_at // "" | tostring),
  (.rate_limits.seven_day.used_percentage // "" | tostring),
  (.rate_limits.seven_day.resets_at // "" | tostring),
  (.worktree.name // .workspace.git_worktree // ""),
  (.transcript_path // "")
] | map(if . == "" then "-" else . end) | @tsv')
EOF
for v in effort remaining five_pct five_reset week_pct week_reset worktree transcript; do
  eval "[ \"\$$v\" = - ] && $v="
done

E=$(printf '\033')
R="${E}[0m"
c() { printf '%s[38;2;%sm' "$E" "$1"; }   # 真彩前景
C_PROJ=$(c "88;196;255"); C_WT=$(c "127;219;202"); C_BR=$(c "255;203;107")
C_MODEL=$(c "199;146;255"); C_DIM=$(c "107;112;128")
I_FOLDER=$(printf '\357\220\223')   # U+F413 oct-file_directory
I_WT=$(printf '\356\242\251')       # U+E8A9 dev-sourcetree
I_BR=$(printf '\357\220\230')       # U+F418 oct-git_branch

# project:git 仓库内取主检出目录名(worktree 里也指向主仓库),否则取 cwd 的 basename
project_dir=""; git_branch=""
if git -C "$cwd" rev-parse --git-dir > /dev/null 2>&1; then
  common=$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  [ -n "$common" ] && project_dir=$(dirname "$common")
  git_branch=$(git -C "$cwd" --no-optional-locks symbolic-ref --short HEAD 2>/dev/null || git -C "$cwd" --no-optional-locks rev-parse --short HEAD 2>/dev/null)
fi
[ -z "$project_dir" ] && project_dir="$cwd"
project=$(basename "$project_dir")

# ultracode:transcript 里最后一次 /effort 切换为准;没切过就看 settings 的 ultracode 键
ultra=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  last=$(grep -a -o -E '"content":"<local-command-stdout>Ultracode o(n|ff)' "$transcript" 2>/dev/null | tail -1)
  case "$last" in *on) ultra=1 ;; *off) ultra=0 ;; esac
fi
if [ -z "$ultra" ] && [ "$(jq -r '.ultracode // false' "$HOME/.claude/settings.json" 2>/dev/null)" = true ]; then
  ultra=1
fi

# 用量配色:<50 绿 / 50–75 黄 / ≥75 红加粗 + ⚠
level_color() {
  if [ "$1" -ge 75 ]; then printf '%s[1;38;2;255;95;95m' "$E"
  elif [ "$1" -ge 50 ]; then c "227;179;65"
  else c "126;231;135"; fi
}
# 进度条:bar <百分比> <格数>
bar() {
  awk -v p="$1" -v n="$2" 'BEGIN { f = int(p * n / 100 + 0.5); if (f > n) f = n
    s = ""; for (i = 0; i < n; i++) s = s (i < f ? "▰" : "▱"); printf "%s", s }'
}
# 时间戳格式化:BSD date 用 -r <秒>,GNU date 用 -d @<秒>
fmt_time() { date -r "$1" "+$2" 2>/dev/null || date -d "@$1" "+$2" 2>/dev/null; }
meter() { # meter <标签> <百分比> <格数> <重置时间>
  pct=$(printf '%.0f' "$2")
  printf '%s%s %s %s%%' "$(level_color "$pct")" "$1" "$(bar "$pct" "$3")" "$pct"
  [ "$pct" -ge 75 ] && printf ' ⚠'
  printf '%s' "$R"
  [ -n "$4" ] && printf ' %s↻%s%s' "$C_DIM" "$4" "$R"
}

# 身份段
id="${C_PROJ}${E}[1m${I_FOLDER} ${project}${R}"
[ -n "$worktree" ] && id="$id  ${C_WT}${I_WT} ${worktree}${R}"
[ -n "$git_branch" ] && id="$id  ${C_BR}${I_BR} ${git_branch}${R}"
id="$id  ${C_MODEL}${model}${R}"
[ -n "$effort" ] && id="$id ${C_DIM}${effort}${R}"
if [ "$ultra" = 1 ]; then
  badge=""; i=0
  for ch in " " "✦" " " U L T R A " "; do
    rgb=$(printf '%s\n' "255;95;138" "255;140;100" "255;184;77" "230;220;90" "126;231;135" "88;196;255" "120;160;255" "170;140;255" "199;146;255" | sed -n "$((i + 1))p")
    badge="$badge${E}[1;38;2;21;22;26;48;2;${rgb}m${ch}"
    i=$((i + 1))
  done
  id="$id  $badge$R"
fi

# 仪表段
gauge=""
if [ -n "$remaining" ]; then
  used=$(awk -v r="$remaining" 'BEGIN { printf "%.0f", 100 - r }')
  gauge=$(meter ctx "$used" 10 "")
fi
if [ -n "$five_pct" ]; then
  t=""; [ -n "$five_reset" ] && t=$(fmt_time "$five_reset" %H:%M)
  gauge="$gauge${gauge:+  }$(meter 5h "$five_pct" 5 "$t")"
fi
if [ -n "$week_pct" ]; then
  t=""; [ -n "$week_reset" ] && t=$(fmt_time "$week_reset" %m/%d)
  gauge="$gauge${gauge:+  }$(meter 7d "$week_pct" 5 "$t")"
fi

# 一行还是两行:取得到终端宽度且放不下才折行
cols="${COLUMNS:-}"
[ -z "$cols" ] && cols=$({ stty size < /dev/tty; } 2>/dev/null | awk '{print $2}')
line="$id${gauge:+  }$gauge"
width=$(printf '%s' "$line" | sed "s/${E}\[[0-9;]*m//g" | wc -m | tr -d ' ')
if [ -n "$gauge" ] && [ -n "$cols" ] && [ "$width" -gt $((cols - 4)) ]; then
  printf '%s\n%s' "$id" "$gauge"
else
  printf '%s' "$line"
fi
