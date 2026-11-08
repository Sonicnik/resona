#!/usr/bin/env bash
# One command: installs what's missing, starts the backend on demo data, seeds it once, opens the app.
# Ctrl+C stops everything. Pass --real to use your real data (~/Library/Application Support/Resona) without seeding.
set -euo pipefail
cd "$(dirname "$0")"

[ -d backend/node_modules ] || npm --prefix backend install
[ -d app/node_modules ] || npm --prefix app install

# Running it again restarts: stop an earlier run of *this* app (matched by its working folder), never anything else.
for port in 4317 1420; do
  for pid in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
    case "$cwd" in
      "$PWD"/*) echo "Stopping the previous run (port $port)"; kill "$pid" ;;
      *) echo "Port $port is used by another program: $(ps -o command= -p "$pid")"; exit 1 ;;
    esac
  done
done
for _ in $(seq 1 50); do lsof -ti tcp:4317,1420 -sTCP:LISTEN >/dev/null 2>&1 || break; sleep 0.2; done

trap 'kill 0' EXIT # stop the backend and the app together

if [ "${1:-}" = "--real" ]; then npm --prefix backend start & else npm --prefix backend run demo & fi

backend=$!
for _ in $(seq 1 100); do
  curl -sf http://127.0.0.1:4317/api/health >/dev/null && break
  kill -0 "$backend" 2>/dev/null || { echo "The backend stopped while starting (see the error above)."; exit 1; }
  sleep 0.3
done
curl -sf http://127.0.0.1:4317/api/health >/dev/null || { echo "Backend did not start (is port 4317 in use?)"; exit 1; }

[ "${1:-}" = "--real" ] || npm --prefix backend run seed # skips itself once the demo is seeded

npm --prefix app run dev -- --open
