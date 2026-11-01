#!/bin/sh
# 用假 date 模拟 GNU（不认 -r <秒>，只认 -d @<秒>），检查重置时间仍能显示
dir=$(cd "$(dirname "$0")/.." && pwd)
shim=$(mktemp -d)
cat > "$shim/date" <<'SH'
#!/bin/sh
case "$1" in
  -r) echo "date: $2: No such file or directory" >&2; exit 1 ;;
  -d) exec /bin/date -r "${2#@}" "$3" ;;
  *) exec /bin/date "$@" ;;
esac
SH
chmod +x "$shim/date"
json='{"cwd":"/tmp","model":{"display_name":"Opus"},"rate_limits":{"five_hour":{"used_percentage":10,"resets_at":1793000000},"seven_day":{"used_percentage":10,"resets_at":1793000000}}}'
fail=0
for label in "native" "gnu-shim"; do
  [ "$label" = gnu-shim ] && p="$shim:$PATH" || p="$PATH"
  out=$(printf '%s' "$json" | PATH="$p" sh "$dir/statusline/statusline-command.sh" 2>/dev/null | sed 's/\x1b\[[0-9;]*m//g')
  echo "$out" | grep -qE '↻[0-9]{2}:[0-9]{2}' && echo "$out" | grep -qE '↻[0-9]{2}/[0-9]{2}' \
    && echo "PASS $label" || { echo "FAIL $label: $out"; fail=1; }
done
rm -rf "$shim"; exit $fail
