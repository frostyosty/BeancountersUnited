# PLAN — milestones for acct

<!-- Claude reads this on demand: CLAUDE.md names the current milestone. Update each "Status" line as work lands. -->

Each milestone ends in something that runs and a "Done when" check. Don't start the next milestone's work
early; put ideas in the Backlog instead.

## M0 — Repo and dev environment
Status: done, except for one check: a Codespace built fresh from `.devcontainer`. CI is green on `master`.
- `.devcontainer/devcontainer.json`:
  - image `mcr.microsoft.com/devcontainers/base:ubuntu`
  - features `ghcr.io/devcontainers/features/rust:1` and `ghcr.io/devcontainers/features/node:1` (LTS)
  - `forwardPorts: [8080, 5173]`
  - `postCreateCommand: npm install -g pnpm && make setup`
- Cargo workspace:
  - crates `acct-core`, `acct-store`, `acct-server` (binary `acctd`), `acct-import`
  - `rust-toolchain.toml` pinned to stable, with rustfmt and clippy
  - `.cargo/config.toml` `[env]`: `TS_RS_LARGE_INT = "number"` and `TS_RS_EXPORT_DIR = { value = "packages/types/src", relative = true }`, so every crate exports to one place
- pnpm workspace: `apps/web` (Vite, React, TS) and `packages/types`.
- Makefile with the targets listed in CLAUDE.md. `scripts/dev.sh` runs the server and Vite together and stops both on Ctrl-C.
- CI: `.github/workflows/ci.yml` runs `make check` on ubuntu-latest, with Rust build caching.
- `.claude/settings.json`: a PreToolUse hook that blocks Edit and Write on migration files already committed to git, so hard rule 7 is enforced rather than just requested.
- `docs/decisions/001–005`, written from CLAUDE.md's Architecture section:
  - 001: the LAN server has authority over the data
  - 002: money and rates
  - 003: ReportDoc
  - 004: SQLite owned by the server, with runtime-checked queries
  - 005: web-first client
- `docs/domain.md`, seeded with a glossary.
- `.gitignore`: `target/`, `node_modules/`, `data/`, `*.db*`, `CLAUDE.local.md`, `tools/**/out/`.
- Optional once M0 lands: a Codespaces prebuild for `master`, to cut start-up time.

Done when: a fresh Codespace runs `make setup && make check` green, and `make dev` serves a page that calls `/api/health` through the Vite proxy.

## M1 — Core: ledger to statements (pure)
Status: done (2026-09-23). The fixture's snapshots were hand-checked against the worked example in `docs/domain.md` and signed off. Nil-line behaviour is still provisional there.
- Rounding follows `docs/domain.md`: totals are the rounded exact totals, and the absorbing line comes from the client's rounding priority list (`RoundingPriority`, a list of account codes). Core takes the list as an input; storing and editing it comes in M2 and M3.
- `Money`: addition, subtraction, negation, `round_to_dollars` (half away from zero), parsing and formatting.
- `AccountCode`, with a normalised sort key that compares numeric segments numerically: "200" < "200.01" < "1100".
- `Chart` and `Account`. Account type is one of asset, liability, equity, income, expense; each account has an active flag.
- `ClientYear`, with explicit start and end dates. First and last years may be shorter or longer than 12 months.
- `Journal` validation (the invariants in CLAUDE.md), and `TrialBalance` built from journals, including the computed rollover.
- `Template`: a tree of report lines (group, line, subtotal, total), each with a stable key and a presentation sign.
- `Mapping`, versioned: account-code ranges → line key. Validation errors for unmapped accounts and overlapping ranges.
- `ReportDoc` builder: statement of financial performance and statement of financial position (titles come from the template), with comparatives (the prior TB through the current mapping), rounding lines, and the account codes behind each line.
- Fixture: one synthetic company with two years, in `fixtures/`.
- Tests:
  - proptest: random balanced journals give a TB that sums to zero; rounded statements always foot and the balance sheet balances; mapped totals equal TB totals.
  - insta snapshots of the fixture's ReportDoc.

Done when: a person has reviewed the fixture's ReportDoc snapshots and they match a hand-checked statement recorded in `docs/domain.md`.

## M2 — Store, server, command pipeline
Status: in progress.
- Migrations for: practice, users, sessions, clients, client_years, master_charts, accounts, templates and mappings (versioned), journals, journal_lines, command_log, and snapshots (table only for now).
- Command pipeline, in order:
  1. decode
  2. authorise by role
  3. validate against current state
  4. apply
  5. append to `command_log`
  6. commit

  It's idempotent on `id`. Errors are structured (`code`, `message`, `details`).
- Auth: argon2id password hashes and an HttpOnly, SameSite=Strict session cookie. First run creates the master user.
- Endpoints:
  - health, login/logout
  - clients, client-years, chart
  - journals (via commands)
  - TB import: CSV upload, then preview, then the import command. The preview flags any gap between the imported retained earnings and the rolled-forward figure; that usually means last year's adjustments were never posted in the client's own books.
  - report (ReportDoc JSON)
  - sync feed
- `make db-reset` loads fixtures by submitting commands, not raw SQL.

Done when: an HTTP integration test takes the fixture company from empty to a ReportDoc identical to M1's snapshot, and rejected commands (unbalanced journal, unknown account, wrong role) leave no partial writes.

## M3 — Web UI: first usable loop
Status: not started
- Login, and a client list with client creation.
- Chart editor.
- Journal entry grid with a live out-of-balance figure (integer cents).
- TB import with a preview and errors shown per row.
- Statement preview: an HTML render of the ReportDoc, with drill-down from a line to its accounts.
- Practice settings (master only).
- Live refresh from the sync feed.

Done when: a user, in a browser in the Codespace, goes from an empty client to previewed statements with comparatives.

## M4 — Fixed assets (accounting depreciation)
Status: not started
- Practice asset classes, set by the master user: default method, rate, part-year convention, disposal-year convention. Clients can override these.
- Each asset class links, by account code, to its cost, accumulated depreciation, depreciation expense and gain/loss-on-disposal accounts. Depreciation and disposal journals post to these.
- v1 conventions:
  - part-year: `MonthsHeld { count_acquisition_month }`, `Daily`, `FullYear`
  - disposal year: `None` or `ToDisposalDate`
- Asset register:
  - create: the resolved defaults are copied onto the asset and `rate_source` is recorded
  - edit: cost and acquisition date can change only while no finalised year includes the asset. Method and rate changes apply from the first open year onward (prospectively). Any edit marks the open years' depreciation as stale.
  - dispose: date and proceeds; the register works out the gain or loss and posts the disposal journal
- Depreciation run: reverses and reposts the year's depreciation journal in one command.
- "Apply new default to existing assets" command: previews the diff, open years only.
- Asset schedule in the ReportDoc, by class, with comparatives:
  - cost: opening cost, additions, disposals, closing cost
  - accumulated depreciation: opening, depreciation for the year, depreciation on disposals, closing
  - closing book value
  - gain or loss on disposal
- Tests:
  - the worked examples in `docs/domain.md`, as unit tests
  - proptest: book value never goes negative; SL never goes below the residual
  - a reconciliation check: register totals equal the linked ledger accounts

Done when: the fixture's assets produce a schedule and a depreciation journal that reconcile to the balance sheet.

## M5 — Finalise, snapshots, PDF
Status: not started
- Finalise (master only):
  - pre-checks: the prior year is finalised, the TB balances, mapping is complete, depreciation is current, and (once M6 exists) there are no uncoded bank lines
  - then write the snapshot and lock the year
- Lock enforcement in every command that touches amounts or dates. Reopening is master only, needs a reason, and is logged.
- Comparatives use the prior year's snapshot TB, as CLAUDE.md describes.
- Accounting policies and notes come from the practice paragraph library: our own text, with client fields filled in.
- PDF renderer: choose between embedded Typst and headless Chromium in an ADR, then build it.

Done when: a finalised year's ReportDoc is byte-identical across restarts and after template edits, and posting into that year is rejected.

## M6 — Bank import and coding
Status: not started
- Parsers in `crates/import`: OFX, QIF, and one versioned CSV parser per bank format. The right parser is picked by inspecting the file.
- Checks per bank account:
  - flag date gaps between statements
  - check opening balance + transactions = closing balance, where balances are present
- Duplicate detection keys on account, date, amount, normalised description, and an occurrence count within that key. That way two identical purchases on the same day both survive. Ambiguous overlaps go to the user.
- Coding rules: set per client, with practice-level suggestions.
  - Match on description text, amount range and direction.
  - Result: an account, a GST code (`standard | zero | exempt | none`), and an optional split.
  - Standard-rate GST splits use the practice's GST rate setting.
- Coding UI. Coded lines post as journals; uncoded lines block finalisation.

Done when: re-importing an overlapping file creates no duplicates, a gap is flagged, and synthetic statements code to the fixture's expected TB.

## M7 — LAN deployment
Status: not started
- Two ADRs:
  - server host: a Windows service, or Docker on a small Linux box
  - client: a browser with a practice certificate authority installed, or a Tauri shell that trusts only the server's own certificate
- Build:
  - the server binary embeds the built web app
  - if Docker is chosen, a multi-stage Dockerfile and a compose file with a data volume
  - Windows builds run on a Windows GitHub Actions runner
- TLS from a practice-local certificate authority created at install, a device trust procedure, and optional mDNS discovery.
- Backups:
  - `acctd backup <path>`, using `VACUUM INTO`
  - guidance for an encrypted off-site rotation
  - a documented restore drill

Done when: two PCs on the office WiFi edit the same client concurrently, and a restore reproduces finalised snapshots byte-for-byte.

## M8 — Classic import and oracle (office machine only)
Status: not started
- Spike: find out how Classic stores data under `C:\MYOBAO\DATA` (FoxPro .dbf, SQL Server, or both). Record the structure in `docs/domain.md`, never the data.
- `tools/classic-import`: a read-only extractor that outputs our own import formats (chart CSV, TB CSV, asset register CSV). It never writes to our database directly.
- `tools/oracle`: compares our TB and statement totals with Classic's exported reports, and writes a diff report to a gitignored folder.

Done when: the chosen client-years match Classic to the dollar, or every difference is explained in `docs/domain.md`.

## M9 — Off-network editing (only if needed)
Status: waiting on a decision
- A client-year can be checked out while someone is away; nobody else can edit it until it's checked back in.
- Commands made while away queue locally. On check-in, the server revalidates them and reports conflicts.

## Open questions
- Does anyone need to edit away from the office network? This decides M9.
- Straight-line entry: a rate or a useful life? Basis points can't express 1/3, so a 3-year rate of 33.33% leaves a small residue for a fourth year; a life in months doesn't.
- Who may set client-level depreciation overrides: master only, or staff too?
- Which entity types come after companies: trusts, partnerships, sole traders?
- Which server host OS and which client (M7)?

## Backlog (not scheduled)
- Templates for trusts, partnerships and sole traders.
- Premade master charts and templates in the familiar NZ style, in our own words (see `docs/domain.md`).
- A "master dev" sync simulator: one `acctd` with many simulated clients sending commands and following `/api/sync`, checking that they all converge on the same state. Needs M2's sync feed.
- Client-level mapping overrides.
- Workpapers; minutes and resolutions from our own paragraph library.
- GL listing and audit-trail reports (hide matched reversal pairs by default).
