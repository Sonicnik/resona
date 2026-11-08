#!/usr/bin/env bash
# One command: installs what's missing, starts the backend on demo data, seeds it once, opens the app.
# Ctrl+C stops everything. Pass --real to use your real data (~/Library/Application Support/Resona) without seeding.
set -euo pipefail
cd "$(dirname "$0")"

[ -d backend/node_modules ] || npm --prefix backend install
[ -d app/node_modules ] || npm --prefix app install

trap 'kill 0' EXIT # stop the backend and the app together

if [ "${1:-}" = "--real" ]; then npm --prefix backend start & else npm --prefix backend run demo & fi

for _ in $(seq 1 100); do curl -sf http://127.0.0.1:4317/api/health >/dev/null && break; sleep 0.3; done
curl -sf http://127.0.0.1:4317/api/health >/dev/null || { echo "Backend did not start (is port 4317 in use?)"; exit 1; }

[ "${1:-}" = "--real" ] || npm --prefix backend run seed # skips itself once the demo is seeded

npm --prefix app run dev -- --open
