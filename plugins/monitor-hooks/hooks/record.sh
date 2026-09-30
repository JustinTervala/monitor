#!/bin/sh
# Records Claude Code session lifecycle metadata for Monitor.
# The hook input can contain prompt or response text; it stays in this process's
# memory and only the whitelisted fields below are written.
umask 077
[ -x /usr/bin/plutil ] || exit 0
input=$(cat)
field() { printf '%s' "$input" | /usr/bin/plutil -extract "$1" raw -o - - 2>/dev/null; }
token() { case "$1" in *[!A-Za-z0-9_-]* | '') ;; *) printf '%s' "$1" | cut -c1-64 ;; esac; }
line() { printf '%s' "$1" | tr '\r\n' '  ' | cut -c1-"$2"; }

session=$(field session_id)
case "$session" in *[!0-9a-fA-F-]* | '') exit 0 ;; esac
[ ${#session} -eq 36 ] || exit 0
# Subagent events are not separate Monitor tasks.
[ -z "$(field agent_id)" ] || exit 0

dir="${MONITOR_CLAUDE_HOOKS_DIR:-$HOME/Library/Application Support/Monitor/claude-hooks}"
mkdir -p "$dir" 2>/dev/null || exit 0
cwd=$(field cwd)
case "$cwd" in *'
'*) cwd='' ;; esac
common="v=1
at=$(date +%s)000
entrypoint=$(token "$CLAUDE_CODE_ENTRYPOINT")
cwd=$cwd"

write() {
  tmp="$dir/.$session.$1.$$"
  printf '%s\n' "$2" >"$tmp" && mv -f "$tmp" "$dir/$session.$1"
}
case "$(field hook_event_name)" in
SessionStart)
  write start "$common
source=$(token "$(field source)")
title=$(line "$(field session_title)" 200)"
  ;;
Stop)
  write result "$common
kind=stop
prompt=$(token "$(field prompt_id)")"
  ;;
StopFailure)
  write result "$common
kind=error
error=$(token "$(field error_type)")
prompt=$(token "$(field prompt_id)")"
  ;;
SessionEnd)
  write end "$common
reason=$(token "$(field reason)")"
  ;;
esac
exit 0
