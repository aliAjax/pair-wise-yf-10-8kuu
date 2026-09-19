#!/usr/bin/env bash
# 通过 /proc 精确找出以 node 运行 server.js 的进程并重启（避免 pgrep -f 误匹配执行脚本的 shell）
set -u
for p in /proc/[0-9]*; do
  pid=$(basename "$p")
  [ "$pid" = "$$" ] && continue
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null) || continue
  case "$cmd" in
    node*"server.js"*)
      echo "killing $pid: $cmd"
      kill "$pid"
      ;;
  esac
done
sleep 1
nohup node /workspace/server.js >/tmp/server-restart.log 2>&1 &
sleep 1
echo "new server started"
