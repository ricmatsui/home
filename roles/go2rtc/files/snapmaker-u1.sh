#!/bin/bash
host=$1
frame=$(mktemp)
req_id=0
last_wake=0

trap 'kill "$WS_PID" 2>/dev/null; rm -f "$frame"; exit' TERM INT

wake() {
  if ! kill -0 "$WS_PID" 2>/dev/null; then
    coproc WS { exec websocat -t -E --ping-interval 20 "ws://$host/websocket" >/dev/null; }
  fi
  req_id=$((req_id + 1))
  printf '{"jsonrpc":"2.0","method":"camera.start_monitor","params":{"domain":"lan","interval":0,"req_id":%d},"id":%d}\n' \
    "$req_id" "$req_id" >&"${WS[1]}"
}

while :; do
  now=$(date +%s)
  if (( now - last_wake >= 10 )); then
    wake
    (( last_wake == 0 )) && sleep 3
    last_wake=$now
  fi
  if err=$(curl -fsS -m 5 -o "$frame" "http://$host/server/files/camera/monitor.jpg" 2>&1); then
    cat "$frame"
  else
    echo "$err" >&2
  fi
  sleep 1
done
