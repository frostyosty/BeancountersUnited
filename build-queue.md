# Build queue: moving the checks to another computer

Read first:
- All three sections below are uncommitted work in one shared tree. Carry the whole working tree over (commit it all with `zz_quicksave.txt`, then pull on the other machine), not file by file.
- On the other machine run, in this order: `pnpm install`, `make types`, `make check` (it covers fmt, clippy, all Rust tests, vitest, tsc and the generated-types check). Fix what it reports, then `make desktop-check` is optional.
- You do not need `scripts/one-build.sh` there; it only exists to share one build between sessions here.
- Migrations: 0010 is history sharing, 0011 is invoices. Keep that order.
- Known to fail until its owner finishes: the invoice maker's Rust code has not compiled yet, and clippy failed in acct-import (MYOB code, since fixed but unchecked).
- Compiling is not releasing: `cargo build/test/clippy` only checks the code on the machine. Releasing is a separate step (`.github/workflows/release.yml`, and ADR 008's staging/prod deploys on push). Nothing here deploys anything.

## Agent 2 (beancountersunited-a0): M16 MYOB export parsers
- Task: parse MYOB AccountRight and MYOB Business exports (accounts list, TB, GL detail, cards/contacts) into `acct_import::history`.
- Files (all uncommitted, carry over): `crates/import/src/myob/**` (new), the `pub mod myob;` line in `crates/import/src/lib.rs`, `fixtures/myob/**` (new), `docs/domain.md` (#### MYOB), `NON-CODE-TODOS.md` (2 M16 items). Build tooling: `scripts/one-build.sh`, `.cargo/config.toml` (`incremental = false`), `CLAUDE.md` (Commands, Codespaces).
- Verify, in order (no setup needed):
  1. `cargo fmt --all --check`
  2. `cargo clippy -p acct-import --all-targets -- -D warnings`
  3. `cargo test -p acct-import myob`
- Status: the 34 MYOB tests passed. Clippy found 3 lints in myob/; they're fixed but not yet re-checked. `make check` covers all of this.

## Invoice maker: saved to the account (session 49663bae)
Task: the invoice maker (Settings › Tools) saves drafts, templates and images to the server instead of the browser.
Files (all uncommitted): crates/store/migrations/0011_invoices.sql, crates/store/src/{invoices.rs,lib.rs}, crates/server/src/{invoices.rs,commands.rs,pipeline.rs,access.rs,history.rs,reads.rs,lib.rs}, crates/server/tests/{invoices.rs,tenancy.rs}, apps/web/src/lib/{invoices.ts,invoices.test.ts,invoiceEditor.ts}, apps/web/src/pages/{InvoiceMakerPage.tsx,.module.css,.test.tsx,SettingsLayout.tsx}, apps/web/src/App.tsx, apps/web/src/icons/registry.json, apps/web/package.json, pnpm-lock.yaml, pnpm-workspace.yaml, docs/security.md, NON-CODE-TODOS.md.
Verify, in order: pnpm install; cargo test -- invoices tenancy; make types; pnpm -C apps/web exec vitest run src/pages/InvoiceMakerPage.test.tsx src/lib/invoices.test.ts; make check.
Status: the 6 web tests pass. The Rust code hasn't compiled or been tested yet. Clippy currently fails in acct-import (another session's MYOB code), not in these files.

## Agent 1 (beancountersunited-a7): Changes filters, Settings tabs, owner Overview, "Ask the experts"
- Task: Changes filter checkboxes; owners' edits hidden from practice users unless the owner shares them; Settings (Practice / Admin / My account tabs, UI-only "view as"); owner "Overview" instead of Clients; "Ask the experts" with a daily AI limit. Also PLAN.md M17 (impersonation plan, not built).
- Files (all uncommitted, carry over): `crates/store/migrations/0010_history_sharing.sql` (new), `crates/store/src/tenancy.rs`, `crates/server/src/{history,ai,commands,access,pipeline,lib}.rs`, `crates/server/tests/{m13,m15}.rs`, `crates/server/tests/common/mod.rs`; web: `App.tsx`, `components/{Layout,HistoryPanel}.tsx` (+ css, HistoryPanel.test), `lib/{history,viewAs,historySharing}`, `pages/{OverviewPage,SettingsLayout,SettingsPage,AccountPage,BusinessPage,SaveTaxAi,ClientsPage,MappingPage,TemplatePage,MasterChartPage,ParagraphLibraryPage}.tsx`, tests `settings`, `clients`, `SaveTaxAi`, `SignUpPage`, `icons/registry.json`, `packages/types/src/` (regenerated); `PLAN.md`.
- Verify, in order: `pnpm install`, `make types`, `make check`. For the Rust tests that matter: `cargo test -- m13 owner_edits quota m15`.
- Status: server compiles; types generated; `tsc` clean; vitest 219/221 pass. The 2 failures are `InvoiceMakerPage.test.tsx`, another session's unfinished invoice maker (not mine). My new Rust tests (`owner_edits_are_private_until_the_owner_shares_them`, `the_daily_quota_is_per_business_and_per_day`, the m13/m15 changes) have NOT been run yet.
