#!/usr/bin/env bash
# Shares one Rust build between every session in this Codespace (CLAUDE.md, "Codespaces").
#   scripts/one-build.sh cargo test -- myob::
#   scripts/one-build.sh make check
#
# 1. Waits for the build lock, then compiles the whole workspace once, the way `make check` does
#    (`cargo build --all-targets` and `cargo clippy --all-targets`). If another session started
#    that compile after you asked, its build already has your edits, so it's reused instead.
# 2. Runs your command without the lock, alongside other sessions' tests. Nothing is left to
#    compile if it uses the same workspace-wide form (see CLAUDE.md).
# `cargo clean` runs, under the lock, only when less than MIN_FREE_GB is free and no session is
# running a command (they hold the lock shared).
set -uo pipefail
cd "$(dirname "$0")/.."
MIN_FREE_GB=${MIN_FREE_GB:-8}
LOCK=/tmp/acct-build.lock
STAMP=/tmp/acct-build.started # when the last shared compile started, in ns

asked=$(date +%s%N)
free_gb() { df -BG --output=avail . | tail -1 | tr -dc 0-9; }

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "one-build: waiting for the shared build" >&2
  flock 9
fi
started=$(cat "$STAMP" 2>/dev/null || echo 0)
if [ "$started" -gt "$asked" ]; then
  echo "one-build: reusing the shared build another session just made" >&2
else
  if [ "$(free_gb)" -lt "$MIN_FREE_GB" ]; then
    echo "one-build: under ${MIN_FREE_GB} GB free, running cargo clean" >&2
    cargo clean
  fi
  date +%s%N >"$STAMP"
  echo "one-build: compiling the workspace for everyone waiting" >&2
  # --keep-going: one session's half-finished crate doesn't stop the others' from building.
  cargo build --all-targets --keep-going --quiet 2>&1 | tail -n 40 >&2
  cargo clippy --all-targets --quiet >/dev/null 2>&1 || true
fi
# Hold the lock shared while the command runs, so a clean can't delete what it's using.
flock -u 9
[ $# -eq 0 ] && exit 0
flock -s 9
"$@"
