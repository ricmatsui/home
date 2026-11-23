#!/bin/bash
host=$1
url="http://$host/server/files/camera/monitor.jpg"
frame=$(mktemp)
req_id=0
last_wake=0
seen=$(curl -sS -I -m 5 -o /dev/null -w '%header{last-modified}' "$url")

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
    last_wake=$now
  fi
  if result=$(curl -sS -m 5 -o "$frame" ${seen:+-z "$seen"} -w '%{http_code} %header{last-modified}' "$url" 2>&1); then
    read -r code modified <<<"$result"
    case $code in
      200)
        if [[ $modified != "$seen" ]]; then
          cat "$frame"
          seen=$modified
        fi
        ;;
      304 | 404) ;;
      *) echo "$result" >&2 ;;
    esac
  else
    echo "$result" >&2
  fi
  sleep 1
done
