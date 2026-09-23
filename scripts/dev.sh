#!/usr/bin/env bash
# Runs acctd on :8080 and Vite on :5173 (proxying /api). Ctrl-C stops both,
# and if either one exits, the other is stopped too.
set -euo pipefail
cd "$(dirname "$0")/.."

trap 'trap - EXIT INT TERM; kill 0 2>/dev/null' EXIT INT TERM

cargo run -p acct-server --bin acctd &
pnpm --filter web dev &

wait -n
