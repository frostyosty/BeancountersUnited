# Build queue: what is waiting on `make check`, and why

Written 2026-10-26 so the checks can be rerun on a faster, non-Codespace machine.
The Codespace has 2 cores and 7 GB of RAM, and five Claude sessions share one `target/`.

## How the shared build works (`scripts/one-build.sh`)

- Every session runs its build or test as `scripts/one-build.sh <command>`.
- The script takes an exclusive lock (`/tmp/acct-build.lock`) and compiles the whole workspace once:
  `cargo build --all-targets --keep-going`, then `cargo clippy --all-targets`.
  Sessions that asked while that compile was running reuse it.
- Each session's own command then runs with the lock held shared, so commands run alongside each other.
- If less than 8 GB is free, the script runs `cargo clean` first. That wipes `target/`, so the next compile is cold.
- Why it is still slow here: a cold compile plus clippy on 2 cores takes about 25-40 minutes, and the
  queued commands only start after it.
- `make types` deletes `packages/types/*.ts` and regenerates them. Mid-run, `git status` shows them all as
  deleted. That is normal, but don't commit during it.

## What `make check` runs, in order

1. `cargo fmt --all --check`
2. `cargo clippy --all-targets -- -D warnings`
3. `make test`: `cargo test` and `pnpm -r test` (vitest)
4. `pnpm -r typecheck` (`tsc --noEmit`)
5. `make types-check`: regenerate the types and fail if they differ from what is committed

`make check` already includes clippy, the Rust tests, the types regeneration and `tsc`. A separate
`cargo clippy`, `make types` or `cargo test` queued next to it duplicates part of it.

## The queue as of 20:39

| Waiting since | Command | Session |
|---|---|---|
| 20:08 | `cargo clippy --all-targets -- -D warnings`, then `cargo test -- myob::` | a0 (MYOB parsers) |
| 20:08 | `cargo clippy --all-targets -- -D warnings` | 72 (invoice maker) |
| 20:09 | `make types` | a7 (history/privacy/Overview) |
| 20:10 | `cargo test -- xero:: history::` | 53 (Xero import) |
| 20:10 | `make check` | 4c (web UI refresh) |

## Per-session reports

_All five sessions replied. Two of them (a7 and 72) both changed `crates/server` files such as `commands.rs`, `pipeline.rs`, `access.rs`, `history.rs` and `lib.rs`, so errors there may come from either side._

### beancountersunited-53: Xero history import (M16)
- **Queued:** `cargo test -- xero:: history::`
- **Changed:** `crates/import/src/history.rs` (new), `crates/import/src/xero/*` (including new `tests.rs`), the `pub mod xero;` line in `crates/import/src/lib.rs`, `fixtures/xero/*`, `fixtures/README.md`, `docs/domain.md` (Xero section), `NON-CODE-TODOS.md`.
- **Why:** confirmation only. 19 `xero::` tests and 1 `history::` test passed earlier. It wants a rerun after the other import session's `cargo fmt` touched its files, and after its last fix.
- **Fresh machine:** `cargo test -- xero:: history::`, then `cargo clippy --all-targets -- -D warnings`. Nothing else needed first.
- **Covered by `make check`:** yes, droppable. Nothing unfinished or known failing.

### beancountersunited-a0: MYOB parsers (M16)
- **Queued:** `cargo clippy --all-targets -- -D warnings`, then `cargo test -- myob::`
- **Changed:** `crates/import/src/myob/**` (new), the `pub mod myob;` line in `crates/import/src/lib.rs`, `fixtures/myob/**`, `docs/domain.md` (MYOB section), `NON-CODE-TODOS.md`. Also `scripts/one-build.sh`, `.cargo/config.toml` (incremental off) and `CLAUDE.md`.
- **Why:** clippy `-D warnings` has never been run on `myob/`. The 34 myob tests passed at about 19:5x and need a rerun after fmt.
- **Fresh machine:** `cargo clippy --all-targets -- -D warnings`, then `cargo test -- myob::`. Nothing needed first.
- **Covered by `make check`:** yes, droppable. Only clippy is unverified.

### beancountersunited-72: invoice maker saves moved to the server
- **Queued:** `cargo clippy --all-targets -- -D warnings` (since 20:08). Nothing compiled yet.
- **Changed:** Rust: `crates/store/migrations/0011_invoices.sql`, `crates/store/src/invoices.rs`, `crates/server/src/invoices.rs` (new), `commands.rs`, `pipeline.rs`, `access.rs`, `history.rs`, `reads.rs`, `lib.rs`, `tests/invoices.rs` (new), `tests/tenancy.rs`. Web: `lib/invoices.ts`, `lib/invoiceEditor.ts`, `pages/InvoiceMakerPage.*`, `SettingsLayout.tsx`, `App.tsx`, `icons/registry.json`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`.
- **Why:** first compile of the new server code, so compile and clippy errors are expected and need fixing.
- **Fresh machine:** `pnpm install`; `cargo clippy --all-targets -- -D warnings`; `cargo test -- invoices tenancy`; `make types`; then `make check`.
- **Covered by `make check`:** yes, droppable.
- **State:** the 6 web tests pass. The Rust is unverified. The generated types `InvoiceDraft`, `InvoiceTemplate`, `InvoiceTemplateSummary` and `Command` still need `make types` and committing.

### beancountersunited-4c: web UI refresh and dark mode
- **Queued:** `make check` (first queued 19:28, resubmitted about 20:10).
- **Changed:** `apps/web` only: `styles/`, the new `ui/` kit, page headers and modals. In the tree: `styles/controls.css` and the `AnalysisTab`, `JournalsTab` and `StatementsTab` CSS modules. No Rust.
- **Why:** CLAUDE.md requires `make check`, but it only needs the web half.
- **Fresh machine:** `pnpm install`, `pnpm --filter web typecheck`, `pnpm --filter web test`. No cargo or database.
- **Covered by `make check`:** yes, and its own check is droppable in favour of the web commands.
- **Known failing, not its own:** `SignUpPage.test` (looks for a "My business" link, now labelled "Overview") and the `HistoryPanel.test` person filter (filters now sit behind a toggle). Both come from another session's Layout and HistoryPanel edits.

### beancountersunited-a7: `make types`
- **Queued:** `make types` (pid 232581, resubmitted after cancelling an older one). Nothing else queued.
- **Task:** Changes filters (`staff_only`/`manual`/`ledger`), owner-edit privacy (new command `set_history_sharing`, migration `0010_history_sharing.sql`), Settings tabs, owner Overview, and "Ask the experts" with a daily AI quota.
- **Changed:** Rust: `crates/server/src/{history,ai,commands,access,pipeline,lib}.rs`, `crates/store/src/tenancy.rs`, `crates/store/migrations/0010_history_sharing.sql`, server tests `m13`, `m15` and `common`. Web: `Layout`, `App`, `SettingsLayout`, `OverviewPage`, `SaveTaxAi`, `HistoryPanel`, `lib/viewAs`, `lib/historySharing`. Also `PLAN.md` (M17).
- **Why:** it needs the generated TS types (`HistorySharing`, `AiSuggestionsView.remaining_today`) so `tsc` and vitest can run. The server already compiles.
- **Fresh machine, in order:** `make types`, `pnpm install`, `make check`. Narrower: `cargo test -- m13 ai` and `pnpm --filter web test`.
- **Covered by `make check`:** yes, no separate check needed.
- **State:** all uncommitted. Unverified: the new Rust tests, the web tests, and the updated `SaveTaxAi` and settings tests.

## Running it on another machine

1. Get the working tree across, including untracked files. The tree has about 235 changed paths and has not
   been committed (new files include `crates/server/src/invoices.rs`, `crates/store/migrations/0011_invoices.sql`,
   `fixtures/xero/` and the invoice maker pages). The quickest way is `zz_quicksave.txt` (commit and push),
   then clone or pull on the other machine. Review `git status` first: `sample invoice generator` at the root is
   an untracked scratch file.
2. `make setup` (cargo fetch, pnpm install, cargo-insta).
3. `make check`. It covers the fmt, clippy, test, tsc and types steps above.
4. If `make check` fails at `types-check`, run `make types` and commit the regenerated `packages/types`.
5. Run any extra per-session commands listed above that `make check` does not cover
   (e.g. `cargo test -- xero:: history::` is already part of `cargo test`).
6. On a machine with plenty of disk and RAM, run plain `make check`. `scripts/one-build.sh` is only needed in
   the Codespace.
