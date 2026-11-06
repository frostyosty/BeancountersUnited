# PLAN — milestones for White Label Accounting

<!-- Claude reads this on demand: CLAUDE.md names the current milestone. Update each "Status" line as work lands. -->

Each milestone ends in something that runs and a "Done when" check. Don't start the next milestone's work
early; put ideas in the Backlog instead.

## Direction (2026-10-19)
White Label Accounting is online accounting for NZ small businesses and their accountants, built to take
them off Xero. ADR 007 records the move from a LAN-only practice tool to an online service, and the removal
of hard rule 2. The owner's whole screen is three areas:

1. **Upload bank statements.** Drop the files in, and income is picked up automatically.
2. **Tax to pay if submitted.** A conservative figure: every deposit counts as income and nothing is
   claimed. A **Save tax** button beside it walks the owner through categorising expenses and the deposits
   that aren't income, and the figure drops as they go.
3. **Submit to IRD.** Files the return as it stands. Overpaying doesn't get anyone into trouble (confirmed
   with a tax specialist, 2026-10-19), so an owner can file the conservative figure without categorising
   anything.

Principles:
- No chat (wait maybe a chat but very unintrusive. Suggests where the user might send the largest tax affectant - gives them say 3 options or hwatever, and for each option theres a little drop down "How would I know if it should go to [dropdown name]?" sort of vibe. AI works in the background, pre-filling categories for a person to accept. Core computes every
  amount.
- The figure on screen can always be filed. Categorising only brings it down.
- Every change shows who made it, what changed, and what it did to the tax. This is the main selling point
  against Xero.
- Underneath is the double-entry ledger from M1–M4, so an accountant gets the P&L, balance sheet, notes
  and asset schedule from the same data.

## Business track (start now; runs alongside the milestones)
IRD's approval gates M14 and has its own review steps, so start early. None of this is code. The steps are
in `NON-CODE-TODOS.md`, with the other checks and approvals only a person can do.

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
Status: done (2026-09-23). `crates/server/tests/m2_done.rs` is the check. M1's snapshot shows FY2026 with FY2025 finalised, and nothing can finalise a year until M5, so that test sets FY2025's status directly; without that, the only difference is `"comparatives": "unfinalised"`.
- Migrations for: practice, users, sessions, clients, client_years, master_charts, accounts, templates and mappings (versioned), journals, journal_lines, command_log, and snapshots (table only for now).
- Command pipeline, in order:
  1. decode
  2. authorise by role
  3. validate against current state
  4. apply
  5. append to `command_log`
  6. commit

  It's idempotent on `id`. Errors are structured (`code`, `message`, `details`).
- Auth: argon2id password hashes and an HttpOnly, SameSite=Strict session cookie. First run creates the master user with `acctd init` on the server (decided 2026-09-23: a CLI, so no one else on the LAN can claim an unclaimed server through the web).
- Endpoints:
  - health, login/logout
  - clients, client-years, chart
  - journals (via commands)
  - TB import: CSV upload, then preview, then the import command. The CSV has a header row and either `code, name, debit, credit` or `code, name, amount` (signed, debit positive); the parser tells them apart by the header (decided 2026-09-23). The preview flags any gap between the imported retained earnings and the rolled-forward figure; that usually means last year's adjustments were never posted in the client's own books.
  - report (ReportDoc JSON)
  - sync feed
- `make db-reset` loads fixtures by submitting commands, not raw SQL.

Done when: an HTTP integration test takes the fixture company from empty to a ReportDoc identical to M1's snapshot, and rejected commands (unbalanced journal, unknown account, wrong role) leave no partial writes.

## M3 — Web UI: first usable loop
Status: code complete (2026-09-24); waiting on the manual browser walkthrough before marking it done. Every item below is built, with vitest and Testing Library tests. On 2026-09-24 a scripted run against a real `acctd`, sending the UI's exact payloads, took a new client through chart edits, two years, a TB import (including a rejected file), journals and a refused deactivation, to a report with unfinalised comparatives. Server additions made along the way: `GET /api/practice`, `GET /api/users`, `SyncFeed.head_seq`, and the commands `add_account`, `rename_account`, `set_account_active`, `set_rounding_priority`, `change_own_password`, `reset_password` and `set_user_active`.
- Login, and a client list with client creation.
- Chart editor.
- Journal entry grid with a live out-of-balance figure (integer cents). Separate Debit and Credit columns, converted to signed cents (decided 2026-09-24).
- TB import with a preview and errors shown per row.
- Statement preview: an HTML render of the ReportDoc, with drill-down from a line to its accounts.
- Practice settings (master only).
- Live refresh from the sync feed.

Done when: a user, in a browser in the Codespace, goes from an empty client to previewed statements with comparatives. Checked by vitest and Testing Library component tests plus a manual walkthrough; no Playwright (decided 2026-09-24). DONE WORKS

## M4 — Fixed assets (accounting depreciation)
Status: code complete (2026-09-24); waiting on the snapshot review and a browser check. The decisions are in `docs/domain.md` under "Depreciation": SL takes a rate or a life, staff may set client overrides, disposal proceeds go to an account chosen at disposal, the register doesn't post additions, and the schedule shows book value and accumulated depreciation exactly rounded, so cost gives way. The fixture's depreciation now comes from its register, so the M1 snapshots moved by cents in FY2026 (explained in the commit and in `docs/domain.md`). The done check is `crates/server/tests/assets.rs` (`m4_is_done`) plus `fixture_register_reconciles_to_the_balance_sheet` in core. Still open: where a gain or loss on disposal is presented (`docs/domain.md`, Open). Built: `acct_core::depreciation`, migration 0002, the commands `create_asset_class`, `update_asset_class`, `set_client_asset_class`, `create_asset`, `update_asset`, `delete_asset`, `dispose_asset`, `reinstate_asset`, `run_depreciation` and `apply_asset_class_defaults`, the reads `GET /api/asset-classes`, `/api/clients/{id}/asset-classes` (plus `apply-preview`) and `/api/years/{id}/assets`, the Assets tab, asset classes in practice settings, and the schedule in the statement preview.
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

Done when: the fixture's assets produce a schedule and a depreciation journal that reconcile to the balance sheet. DONE

## Retired milestone numbers (2026-10-19)
The roadmap was restructured around the direction above. The old M5–M9 were folded into M10–M16. Their
numbers aren't reused, because code comments and a committed migration still refer to them.

| Old | Was | Now |
|---|---|---|
| M5 | Finalise, snapshots, PDF | M15 |
| M6 | Bank import and coding | M10 (import) and M11 (coding) |
| M7 | LAN deployment | M12 (HTTPS, backups). The practice certificate authority, device trust and mDNS are dropped (ADR 007). |
| M8 | Classic import and oracle | M16 |
| M9 | Off-network editing | Dropped: the hosted server works from anywhere. |

## M10 — Upload statements, see the tax
Status: code complete (2026-10-23); waiting on a person to check the worked example, and a browser check. Built: the tax engine (`acct_core::tax`), the posting rule, gaps, transfer pairing and IRD spotting (`acct_core::bank`), the parsers (`acct_import::bank`), the sole-trader chart, template and mapping (`fixtures/practice/sole-trader-*`), migrations 0003 (default GST codes) and 0004 (businesses, bank accounts, statements, bank lines, gap journals), the commands `set_up_business`, `add_bank_account`, `import_statement` and `set_opening_balance`, the reads `GET /api/businesses/{id}` and `/api/businesses/{id}/tax`, and the owner screen at `/businesses/{id}` (Save tax and Submit shown but switched off). The done check is `crates/server/tests/m10.rs` (`m10_is_done`): the statements give GST 569.62 and 2,506.32 (968.35 when only income), re-uploading changes nothing, both gaps are flagged, and the accounts with closing balances reconcile. The M10 questions are answered in `docs/domain.md` (2026-10-19), with a worked example a person still has to check. Items marked **check** there go to the tax specialist before M14.
- Rename the UI to White Label Accounting: page title, header and login screen. Crates and binaries keep the `acct` name.
- Sole traders first (this answers the old entity-type question): a sole-trader master chart and template in our own words. Owners never see account codes; categories are accounts underneath.
- Setting up a business: name, start date, whether GST registered and from when, GST filing frequency, and bank accounts. In M10 the balance date is always 31 March and the GST basis is always payments; setup turns down the invoice and hybrid bases with a plain reason.
- Parsers in `crates/import`: OFX, QIF, and one versioned CSV parser per NZ bank format. The right parser is picked by inspecting the file. Synthetic sample statements for each format go in `fixtures/`.
- Checks per bank account:
  - flag date gaps between statements
  - check opening balance + transactions = closing balance, where balances are present
- Duplicate detection keys on account, date, amount, normalised description, and an occurrence count within that key. That way two identical purchases on the same day both survive. Ambiguous overlaps go to the user.
- Every imported line posts straight away as its own bank-coded journal ("Bank statements to the ledger" in `docs/domain.md`):
  - deposits go to money in, not yet sorted, split for GST when the owner is registered
  - withdrawals go to money out, not yet sorted
  - there's an opening-balance journal per bank account, and a gap journal wherever the balance changes across a gap
  - likely transfers between the owner's accounts, and payments to or from IRD, are detected but not applied

  The ledger is then always complete, the conservative figure comes out of it, and M11 recodes lines.
- Tax engine in `crates/core`, pure ("GST" and "Income tax for sole traders" in `docs/domain.md`):
  - GST for a period: the return's boxes on period totals, at the GST rate for the date (versioned data in core); input tax only on categorised lines.
  - Income tax for a year: taxable income through a rate table per income year (2026 and 2027), kept as versioned data with its source recorded in `docs/domain.md`. Until the owner answers, 39% flat and a 12% student loan.
  - Rates in basis points and amounts in cents, with `i128` for intermediate products (hard rule 4, ADR 002).
- The three-area screen. Submit is shown but disabled until M14.
- Reconciliation per bank account: the ledger's bank balance equals the latest statement's closing balance.

Done when: the synthetic sole trader's sample statements give the figures of the worked example in `docs/domain.md`, once a person has checked it: GST 569.62 and tax to pay 2,506.32, or 968.35 when the tax engine is told the business is the owner's only income. Uploading an overlapping statement changes nothing, both gaps are flagged, and every bank account whose statements give a closing balance reconciles.

## M11 — Save tax
Status: not started
- **Save tax** opens one queue, biggest possible saving first, with a running "saved so far" figure. It's re-sorted after each answer, and cards that would save nothing are hidden. It holds:
  - questions: "Is this business your only income?" (and if not, the other income and the tax deducted from it), "Do you have a student loan?", and the independent earner tax credit
  - detected items to confirm: transfers between the owner's accounts, payments to IRD (income tax already paid, or GST), possible duplicates, and missing statements
  - transactions to categorise
- Deposits can be marked as not income: a transfer between the owner's own accounts, a loan, money the owner put in, a GST refund, wages already taxed through PAYE, or the sale of a personal item.
- Withdrawals can be marked as:
  - a business expense category, with its GST code (`standard | zero | exempt | none`). GST on a line over $200 is claimed only once the owner confirms they hold the supplier's taxable supply information.
  - partly private, by percentage
  - an asset purchase, which goes into the M4 register so depreciation follows
  - personal
- Rules per business (for example "always treat COUNTDOWN as personal") match on description text, amount range and direction, with practice-level suggestions. Standard-rate GST splits use the GST rate for the line's date.
- NZD credit card statements: the M10 parsers extended to cards, with a liability account per card.
- AI suggestions pre-fill categories, and the owner accepts them one at a time or all at once. Write an ADR first covering:
  - the provider
  - what leaves the server (for example descriptions and amounts, but not names or IRD numbers)
  - consent and retention
  - whether IRD's terms allow it

  Suggestions are inputs to commands, validated like anything from the UI, and the log records which changes were suggested.
- Recoding a line reverses and reposts its journal, because posted journals never change.

Done when: categorising the synthetic statements as the fixture specifies gives the expected TB, and the tax figures fall by exactly the worked example's amounts.

## M12 — Online: hosting, sign-up and security
Status: not started
- ADR 008: host and region, continuous database backup, and deploys. See "Hosting" under Open questions.
- Owners sign up themselves. A new `owner` role sees and changes only its own business, and can invite the business's accountant. Every read and command checks this, with tests that one owner can't read another's data.
- HTTPS, `Secure` cookies, login throttling, two-factor sign-in with an authenticator app, and encryption at rest.
- `docs/security.md`: the controls behind the OSF questionnaire, access logging, and a breach response plan. IRD must be told about a breach immediately.
- Backups (from the old M7):
  - `acctd backup <path>`, using `VACUUM INTO`, plus continuous backup on the host
  - a documented restore drill
- Deploys from GitHub Actions to staging, then production.
- Desktop apps (ADR 007): retire `acct-master`, and decide whether `acct-client` points at the hosted address and whether `acct-dev` stays.

Done when: staging runs over HTTPS, two owners sign up and neither can read the other's data, and a restore drill brings staging back with an identical `command_log`.

## M13 — Who changed what
Status: code complete (2026-10-24); waiting on a browser check with two people (`NON-CODE-TODOS.md`). This is the selling point against Xero. Built: migration 0008 (`command_log.changes`), recorded by the pipeline for every command: each value it changed before and after, and the business's tax to pay (with its GST and income-year parts) before and after. `crates/server/src/history.rs` describes every command kind in plain English (`history::tests` has one per kind and fails on a kind without one) and serves `GET /api/history` (filters: business, person, dates, a tax figure, or a year's accounts for the drill-down). `crates/server/src/presence.rs` serves `POST /api/presence`, kept in memory. The web app's history panel is on the left of every signed-in page, and the tax figures, TB rows and statement lines have a "Changes" button. The done check is `crates/server/tests/m13.rs` (`m13_is_done`). Commands logged before M13 show no before/after or tax effect.
- A panel on the left of every page shows:
  - who's signed in now
  - a live feed of changes in plain English, for example "Sam marked 12 COUNTDOWN transactions as personal. Tax to pay went up $84."
- Each change shows its before and after values and its effect on the tax figure.
- Clicking any figure lists the changes that moved it (the drill-down plus the command log).
- Filters by person, date and business. AI-suggested changes are marked as such, along with who accepted them.
- Built from `command_log` and the sync feed. There's no second record of changes.

Done when: every command kind has a plain-English description covered by a test, and two browsers see each other's presence and changes within a few seconds.

## M14 — File with IRD
Status: not started. Needs IRD test environment access (see the business track).
- `crates/ird` calls the gateway Return service:
  - `RetrieveFilingObligation`: what's due
  - `Prepop`
  - `File`: file and amend
  - `RetrieveStatus`
  - `RetrieveReturn`

  GST first, then the IR3. Confirm the income tax operations in the build pack.
- Owners authorise us through IRD's myIR sign-in (the access services). Tokens are stored encrypted; we never see or store myIR passwords.
- Core builds each return's payload from the ledger, deterministically, with snapshot tests.
- Submit shows the return's lines and the declaration, then files. The exact payload, IRD's response and a SHA-256 of the payload are stored and never regenerated, like a finalisation snapshot.
- A filed GST period or income year rejects changes to its numbers. Corrections go through an amendment.
- After filing, show how to pay. We don't process payments.

Done when: in IRD's test environment, a synthetic business files a GST return and an IR3, checks their status, retrieves them and amends one, and changes to a filed period are rejected.

## M15 — Accountant view: statements, notes, finalise, PDF
Status: not started (was M5)
- The P&L and balance sheet (built in M1–M3), checked against a sole-trader worked example. Add notes, analysis reports (for example expenses by category, year on year), and a GL listing that hides matched reversal pairs by default.
- Bank reconciliation view: statement balance against the ledger, with any unmatched items.
- Finalise (master only):
  - pre-checks: the prior year is finalised, the TB balances, mapping is complete, depreciation is current, and there are no uncategorised bank lines unless the accountant accepts them as they are
  - then write the snapshot and lock the year
- Lock enforcement in every command that touches amounts or dates. Reopening is master only, needs a reason, and is logged.
- Comparatives use the prior year's snapshot TB, as CLAUDE.md describes.
- Accounting policies and notes come from the practice paragraph library: our own text, with client fields filled in.
- PDF renderer: choose between embedded Typst and headless Chromium in an ADR, then build it.

Done when: a finalised year's ReportDoc is byte-identical across restarts and after template edits, posting into that year is rejected, and the fixture's bank accounts reconcile.

## M16 — Bring your history: Xero and MYOB
Status: not started (takes in the old M8)
- Import from Xero's and MYOB's standard exports: chart of accounts, trial balance, general ledger detail and contacts. Their accounts map onto ours with a preview, and earlier years become comparatives.
- Pulling history through Xero's API is a later option: write an ADR after checking Xero's developer terms and pricing.
- MYOB AO Classic, on an office machine only (hard rule 1):
  - Spike: find out how Classic stores data under `C:\MYOBAO\DATA` (FoxPro .dbf, SQL Server, or both). Record the structure in `docs/domain.md`, never the data.
  - `tools/classic-import`: a read-only extractor that outputs our own import formats (chart CSV, TB CSV, asset register CSV). It never writes to our database directly.
  - `tools/oracle`: compares our TB and statement totals with Classic's exported reports, and writes a diff report to a gitignored folder.

Done when: a synthetic Xero export imports to a TB that matches the export's totals, with comparatives, and the chosen Classic client-years match to the dollar or every difference is explained in `docs/domain.md`.

## M17 — OFX parser fixes
Status: not started. Planned 2026-11-03. The agent prompts are in `M17-PROMPTS.md` (three agents, two waves). The OFX edge-case fixtures in `fixtures/bank-statements/ofx-edge/` turned up six gaps, which the `known_gaps` test in `crates/import/tests/ofx_edge.rs` pins as they behave today:
1. A **truncated download** (fixture 25) imports a half-read last amount as a real line and loses the closing balance. It's the only gap that can put a wrong amount in the books, so it goes first: refuse the file, saying how far it got, and import nothing.
2. A **lower-case root tag** (04) isn't recognised.
3. **CDATA text** is lost and **numeric character references** aren't decoded (32).
4. A **sign-on error** or an **investment-only file** (20, 21) is refused as "ACCTID missing". It should say what the file actually holds, or pass on the bank's error.
5. A **card file giving only the last four digits** (16b) isn't masked, so it won't match the same card from a CSV or QIF.
6. A **line with no description** (12) is accepted empty. How to treat it is a decision for a person, asked before it's settled and recorded in `docs/domain.md`.

No migrations. Each fix moves its case out of `known_gaps` and updates the "Known gaps" list in the ofx-edge README.

Done when: `known_gaps` is gone or empty, the README's "Known gaps" says "None", `make check` passes, and fixtures 25 (truncated) and 20 (bank error) are each refused in the upload screen with a message a business owner could act on.

## M18 — Every upload reconciles, or says why
Status: not started. Planned 2026-11-03. Builds on M10's per-file balance check (`Statement::balance_check`) and duplicate keys, and on the bank reconciliation already in `crates/server/src/reconcile.rs` (M15).

Every upload checks itself. The owner sees proof that the books agree with the bank: two cutouts side by side, the bank file's balance and the ledger's balance on the same date, on a card they can print. When they don't agree, the app works out the likely reasons by itself, shows them biggest first, and offers a fix that previews the corrected balance before anything changes.

**How a difference is tracked down.** Testing the difference against every line comes second. First find *where* the books and the bank part ways. The bank states a balance at many points: each statement's opening and closing balance, and every running balance in files that have one. Walk those checkpoints in date order and compare the ledger's balance at each one. The last checkpoint that agrees and the first that doesn't bracket the fault, usually to one statement or a few days. The suspects then look only inside that window, so they run fast and give specific answers. Where a file states only a closing balance, the window is the whole statement. The shape also helps: a jump at one checkpoint points to one bad line, a constant difference from the very start points to the opening balance, and a difference that grows points to a pattern such as a sign or a cut-off.

Work is split into agents, in four waves; the copy-paste prompts are in `M18-PROMPTS.md`. Agent 7 is split there: its fixtures come first (7a) and its done check last (7b). Agent 8 runs alongside Agent 5.

### Agent 1: checkpoints and the window (core, pure)
- `acct_core::reconcile`: the checkpoints (date, the stated balance, and where it came from: the statement and the span in its file), the ledger's balance at each, and the window `{ last_agrees, first_differs, difference }`, plus how the difference moves from one checkpoint to the next.
- Move the arithmetic of `crates/server/src/reconcile.rs` into core. The server only loads the data. Output is byte-stable: sorted, with no HashMaps.
- Property test: put one fault into a random ledger, and the window always contains it.

### Agent 2: keep the evidence (the original file)
- Migration 0012: `statement_files` (statement id, SHA-256, bytes, media type). Uploading the same file again stores nothing new.
- The parsers record the source span of each balance they read: OFX `<LEDGERBAL>` (`<BALAMT>`, `<DTASOF>`), the QIF opening entry, a CSV's "Closing balance" row or a running balance cell.
- `GET /api/statements/{id}/excerpt`: about six lines of the original text around a span, with the span marked, plus the file's name and SHA-256. Access checks as for the statement.
- Statements uploaded before M18 have no file kept. Their cutout says so and shows the stored figure.

### Agent 3: check on upload, and the proof card
- `import_statement`'s result carries the reconciliation for that account at the statement's closing date, and at the balance date (31 March) when the statement spans it. This is read-only work after apply, inside the same transaction; there's no new command and no new write path.
- At 31 March: use a statement ending that day if there is one, else the running balance at the end of that day if a line gives one, else the nearest checkpoint before it, labelled as such.
- The **Bank vs books** modal opens after every upload, and from each bank account and the Reconcile tab:
  - Left cutout, "Your bank's file says": the excerpt from Agent 2 with the balance highlighted, the file name, the date and the start of the SHA-256.
  - Right cutout, "Your books say": the ledger's balance on the bank account at the end of the same date, with the few lines before it.
  - Between them: "Agrees ✅" or "Out by $412.50 ⚠️", and a link to the findings (Agent 6).
  - Side by side on a desktop, stacked on a phone. A print stylesheet makes one A4 page with the business, the account, the date, when it was printed and who printed it. No emoji in the printed figures.
- Cards use the card's own wording on both sides ("you owe $1,087.55").
- Built from `ui/` (`Modal`, `Card`), tokens and `<Icon>`; money only through `money.ts`.

### Agent 4: the suspects (core, pure)
- A `Suspect` trait. Given the window, the lines, the journals, the statements and the checkpoints, a suspect returns zero or more `Finding { kind, explains: Money, confidence: Likely | Possible, evidence, fix }`. `evidence` refers to lines, journals and statements by id; `fix` is a suggested command, never applied by the suspect.
- One module per suspect, each with its own fixture and tests. A new suspect is a new module and fixture, and nothing else changes. The first set, most common first:
  1. **Duplicates.** Lines of the same amount within 3 days whose descriptions match once normalised, lines with the same bank transaction id (OFX `FITID`) in two files, and M10's `possible_duplicate` lines. It also catches overlapping downloads that M10's exact key missed because the bank formatted the description differently (OFX `NAME` against `MEMO`, cut-short CSV text) or one file used the posting date and the other the transaction date. A single duplicate equal to the difference ranks first; sets of them are left to Agent 5.
  2. **Missing lines.** Days no statement covers inside the window, where the difference equals the change across them. Also a cut-short download: the file's own balance check fails at its end, or its last line stops short of its stated period.
  3. **Wrong opening balance.** The difference is the same from the first checkpoint on, so the opening balance entered differs from the first statement's.
  4. **Sign the wrong way.** The difference is twice a line, or twice a file's net: a card file read as a bank account, or a CSV's debit and credit columns read the wrong way round.
  5. **Marked duplicate but isn't.** A line the owner marked as a duplicate with no other line of that amount within 3 days.
  6. **Entries by hand.** Journals on the bank account with no statement line (M15's `journals_without_line`). Any equal to the difference rank first.
  7. **Date cut-off.** A line the ledger dates after the checkpoint that the file lists before it, or the other way round.
  8. **Wrong account.** The file's account number differs from the bank account's, or the difference equals the net of a file uploaded to another account.
  9. **Amount read wrong.** The difference is 99 or 100 times a line (cents read as dollars), or the file's own running balance breaks at one row. Either our parser or the bank's file is wrong: tell the owner, and log it for us with the parser and row, never the content.
  10. **Transposed digits.** Only for amounts a person typed (opening balances, journals by hand): the difference divides by 9 and swapping two digits gives it.

### Agent 5: explain the whole difference (core, pure)
- Find the smallest set of findings whose amounts add up exactly to the difference: an exact subset sum over at most 20 findings, ranked by confidence when there's more than one. If none is exact, rank by confidence and size and show what's left over.
- `Diagnosis { difference, explained_by, remainder, other_findings }`, in a deterministic order, so the same books always give the same report.

### Agent 6: tell the owner and the accountant
- When an account is out, the modal leads with the best explanation in plain English, for example "These 3 lines look like they were uploaded twice. Removing them makes the books agree." Each has a **Fix it** button that runs an existing command (mark as duplicate, set the opening balance, upload the missing statement) and shows the balance afterwards, so the owner sees ✅ before confirming.
- The other findings are in an expandable list, each linking to its lines.
- Findings join M11's Save tax queue as detected items and M15's Reconcile tab. M13's history records that a fix came from a finding.
- When nothing explains it: "We couldn't work out why. Between 3 Feb and 28 Feb your books and bank go out by $412.50." Then **Ask your accountant**, for an owner with a linked accountant.

### Agent 8: the books the suspects see are the books the app has
Added after Agent 4 found that the fixtures and the server build different books.
- Checkpoints come only from balances the bank states, on the dates it states them, not from a statement's coverage or worked-out balances.
- Gap journals: ask whether the proof card counts them, then make the fixtures and the missing-lines suspect agree with the answer (recorded in `docs/domain.md`).
- The fixtures' generator keeps a running balance only when core would; every fault.toml's fix is the one its suspect suggests.
- `suspect_input` on the server loads the suspects' input, read only, and a test checks the server's books find what the fixtures' tests find.

### Agent 7: fixtures and the done check
- `fixtures/reconcile/`: a clean set of synthetic statements, one variant per suspect with that fault put in, and one with two faults together.
- `crates/server/tests/m18.rs` (`m18_is_done`).

Done when: every fixture upload shows the proof card, with the excerpt from the uploaded file; the clean set agrees; each single-fault fixture names its fault as the best explanation with the exact amount, and applying its fix makes the card agree; the two-fault fixture is explained in full; and the printed card fits on one A4 page.

## M19 — Admin "view as" with real impersonation
Status: not started. Planned 2026-10-26. M12's Settings screen ships a UI-only preview first (the web app swaps the role it renders for, labelled with a "Viewing as …" banner; the server still enforces the real role). This milestone replaces it with the real thing. The agent prompts are in `M19-PROMPTS.md` (five agents, four waves).
- Write an ADR first (`docs/decisions/`) covering who may impersonate, what it may do, and how it's audited. Starting position:
  - Only an `overseer` may impersonate, and only a user or role below them. Nobody can impersonate an overseer.
  - Impersonating is a session state, not a login: the session keeps the overseer's identity (`user_id`) and adds `acting_as` (a user id, or a role with a business for the owner view). Ending it returns to the overseer's own view.
  - Every check in `access.rs` runs against the acting identity, so the overseer sees exactly what that person sees, including the Changes feed and what an owner has or hasn't shared with staff.
  - **Read-only by default.** Writes while impersonating need an explicit "allow changes" toggle, last for the session, and are refused for sign-off style commands (`finalise_year`, `reopen_year`, `accept_invite`, `change_own_password`, `submit` to IRD) so an overseer can never sign or file as someone else.
- Audit: `command_log` records both identities (`user_id` = the overseer, new `acting_as` column) so Changes says "Overseer (as Sam Staff)". Starting and ending a session are logged as commands (`start_impersonation`, `end_impersonation`, with a required reason), visible to the impersonated user in their own Changes.
- Safety: sessions time out after 30 minutes; the UI shows a persistent banner with an End button; it's off for business owners' IRD-linked actions (M14) entirely.
- Migration: `sessions.acting_as`, `command_log.acting_as` (append-only).
- Replace the UI-only preview in Settings → Admin with the server-backed switcher, and delete the client-side role override.

Done when: a test shows an overseer acting as staff sees only what that staff user sees (including owner edits hidden by the owner's sign-off setting), can't finalise, reopen or file, and that every command and the start and end of the session appear in the log with both identities.

## M20 — Try it on the home page, no sign-up
Status: done (2026-11-07). `m20_is_done` passes and the desktop and phone browser check is done. ADR 014 is accepted. Planned 2026-11-04. The three example statements are written: `fixtures/landing/` (see its README for what each one covers). The agent prompts are in `M20-PROMPTS.md` (seven agents, four waves). M19 has ADR 013 and migration 0013 reserved, so M20 takes ADR 014 and migration 0014.

A visitor sees the product work before they sign up. They drop a bank statement (one of ours, or their own) onto "Upload bank statements" in "From bank statement to IRD", and the steps below it fill in with their real figures: the tax to pay, Save tax cards they can answer, and File tax. With their own file they can go all the way to the File tax screen without signing up or signing in. Everything runs through the real parser, pipeline and tax engine; nothing on the page is a mock-up.

**The home page (desktop).**
- Beside the four-step flow, in the empty space to its right, a panel: "Drag and drop an example OFX", with three statement cards (Example 1–3). Each card looks like a small paper statement: the bank, the business, the period and its first few lines.
- Clicking a card opens it full screen (`Modal`): the statement laid out like a bank statement, from the parsed lines, with a "Raw file" tab showing the OFX text, and a **Use this example** button. Escape or ✕ closes it.
- A card can be dragged onto the Upload step, which highlights as a drop target. **Use this example** does the same for keyboard and touch users. The Upload step also takes a real file: dragged from the desktop, or through **Choose a file**.
- Next to the drop zone, one line: what happens to an uploaded file and how long we keep it (ADR 014).

**The home page (phone).** No panel. Under the Upload step's text, three links, "Example 1", "Example 2", "Example 3", each opening the same full-screen preview with **Use this example**.

**What happens on a drop.**
1. Upload: the file name, the bank, the period and the number of lines, or the parser's own plain-English error.
2. See your tax: a loader for about two seconds, with steps ("Reading 27 transactions…", "Working out GST…", "Income tax…"), then the conservative figure with its line ("Counts every deposit as income and claims nothing."). The wait is a minimum display time, not fake work; with reduced motion, no animation.
3. Save tax: fills in the same way with the top three cards from the real queue. Answering one sends the real command, and the figure and "saved so far" update. **See all** opens the full Save tax page for this business.
4. File tax: lights up with **Review your return**, which opens the Submit screen for this business.

**The hero ticket.** "Example: tax if you filed today" becomes a button. Clicking it loads Example 1 exactly as a drop would and scrolls to the flow. Its amount is Example 1's real conservative figure (served by the examples read), not a typed-in $4,820.

**Guests (ADR 014 settles the details).** The starting position:
- The first drop (not a page view) creates a guest: a `business_owner` user with no email or password, and a business, through a new `start_guest` command on a public route. The browser gets an ordinary session cookie. Using an example sends the example's number; the server imports its own copy of the file, so the browser never uploads it.
- A guest can use the owner screens (`/businesses/{id}`, Save tax, Submit) with no sign-in. A banner offers **Save your work** (`claim_guest`: email, name, password), which turns the guest into an ordinary owner and keeps everything.
- Filing with IRD (M14) needs a claimed account to hold the myIR authorisation and the filed record. Until M14 lands, Review your return ends at the Submit screen with Submit switched off, as today.
- **GST registration (decided 2026-11-04).** Detect it, otherwise assume registered, and ask late:
  - A GST refund from IRD, or an IRD payment whose reference says GST, proves registration, so the business is treated as registered with the reason shown ("We spotted a GST payment to IRD on 22 Oct…"). The payment dates give the filing frequency where they can.
  - Statements can't prove someone isn't registered. Without proof, assume registered ("Assumed GST registered · change"): with the same deposits it gives the higher figure unless the business makes a loss, so the figure stays conservative and saying "not registered" only brings it down. Deposits over $60,000 a year add a warning that registration is compulsory.
  - There's no up-front question. "Are you GST registered?" is a Save tax card, ranked by its saving like the others. While it's only assumed, GST-only questions (GST codes, supplier information over $200) are held back.
  - At Submit, if still unconfirmed, IRD's filing obligations settle it once M14 is built, and IRD's answer wins. Before then, Submit asks "We couldn't tell if you're GST registered. Are you?" When the figure changes there, the screen says why.
  - Examples 1 and 3 come out detected; Example 2 comes out assumed.
- Guests aren't offered AI suggestions (ADR 009's opt-in) or inviting an accountant until they've claimed.
- Unclaimed guests expire after a set time without use and their data is deleted, through the pipeline. ADR 014 says how that squares with an append-only `command_log`.
- Abuse limits: guests started per IP per hour, upload size, statements per guest, and guests alive at once.
- A guest's changes appear in their own Changes (M13) as "You (not saved yet)".

**The example statements** (`fixtures/landing/`, written 2026-11-04): a GST-registered coffee cart (OFX 1.02 SGML, one month), a freelance designer who isn't GST registered (OFX 2.2 XML, UTF-8 with macrons, NZ time zones across the daylight-saving change, two months), and a GST-registered electrician who buys a van (SGML with CRLF and closed tags, a cheque, a quarter). Each gives Save tax something different to find: a family loan, money from a partner, a transfer from savings, a GST refund, income tax already paid, and an asset. Edit them through `fixtures/landing/generate.py`, which keeps the balances exact.

Done when: `crates/server/tests/m20.rs` (`m20_is_done`) shows that, with no sign-in, each example gives its pinned conservative figure and answering its top three Save tax cards lowers it by pinned amounts; a real-shaped OFX from `fixtures/bank-statements/` goes from upload through Save tax to the Submit screen; claiming keeps every line and answer; one guest can't read another's business; an unclaimed guest expires and its statements, lines and files are gone; and the rate limit refuses the next guest from the same IP. The web tests cover dragging a card, **Use this example**, a real file, the phone links, the preview, the loader and the hero ticket. Then a browser check on a desktop and a phone.

## M21 — The whole taste first, then sign up at the peak
Status: ADR 015 accepted (2026-11-07); wave 2 of `M21-PROMPTS.md` is next. Planned 2026-11-06. Builds on M20's guests (ADR 014). The agent prompts are in `M21-PROMPTS.md` (five agents, four waves). M21 takes ADR 015 and migration 0015.

M20 lets a visitor see their tax and bring it down with no account. M21 lets them see everything else too, the accountant's side included, and asks for an account only when it's worth the most to them: when there's something to keep, or something only an account can do. Everything they see is still the real thing, read from their own trial.

**The accountant view, for owners and guests (read-only).**
- The owner's business screen gets a switch: **Your view · Accountant view**. The accountant view shows the same business's books for its current year: the statements (profit and loss, balance sheet), trial balance, journals, general ledger, the asset register and Changes. It's the accountant's own screens (M15), read-only: no journals, TB import, notes, chart edits or finalising. A line at the top says what it is: "This is what your accountant sees. They work on these same books, so nothing gets typed in twice."
- Claimed owners get it too. Today they can read these routes but nothing links to them.
- A guest sees it for their own trial or an example, with no sign-in. Downloading the PDF needs an account, so it says "Save your work to download the PDF", like M20's other locked actions. For an example, it says "Try it with your own statement" instead, because examples can't be saved.
- Server: the guest route list (ADR 014) gains the read-only year routes for the guest's own business. The statements need the practice's sole-trader template and mapping. Where a server has none, the statements tab says so plainly; it never shows an error.

**The home page's "boring stuff, for accountants" opens it.**
- The three tiles become buttons that work by keyboard and touch:
  - Real double-entry books opens the journals and trial balance.
  - Statements that foot opens the statements.
  - Who changed what opens Changes.
- With a trial loaded, a tile opens that view of the trial. Without one, it loads Example 1, as the hero ticket does, and then opens the view: one click to see it.
- Each view has "Back to your tax".

**Ask for an account at the peak, never before.**
- Nothing asks for an account on arrival, while looking, or on the way out. There are no pop-ups on landing, no "are you sure you want to leave", and no countdowns.
- An account is asked for only at these points, each in words about what they'd keep or get:
  1. **The first real saving on their own file.** The first time Save tax brings the figure down by $100 or more, a line appears under "saved so far": "Keep the $X you've saved: save your work. It takes 20 seconds." It shows once per trial and can be dismissed.
  2. **Filing.** Filing needs an account (ADR 014, 5), so saving their work is the first step of Submit, not a detour.
  3. **Something only an account can do:** inviting an accountant, AI suggestions, the PDF and filing. "Save your work first to …" was built in M20; the PDF is added.
  4. **The peak of an example is their own file, not an account.** Examples can't be saved, so after an example's figure drops, the line says "Like that? Drop your own statement and see yours."
  5. **Before the trial goes.** The banner already says when the trial expires. In its last 48 hours it says so plainly.
- **Measuring it without tracking anyone:**
  - `claim_guest` records which of these led to it (`from`) in its own log entry.
  - An overseer read in Settings → Tools shows trials started, saved and expired by week, and saves by `from`. This needs no third-party analytics and no cookies beyond the session.

**Owner or accountant: asked only when it's a fair question.**
- If the guest opened the accountant view, **Save your work** first asks "Who are you?", with **I run this business** already selected, or **I'm an accountant or bookkeeper**. A guest who never opened it isn't asked.
- Opening the accountant view is a reason to offer the choice, never a reason to pick it for them. Owners open it too: "your accountant gets proper books" is part of the owner's pitch. Getting it wrong costs differently:
  - An accountant sent down the owner path loses one click.
  - An owner sent down the accountant path loses their trial and lands in a product they don't need.
- **I run this business** is M20's claim, unchanged.
- **I'm an accountant or bookkeeper** is a practice account request, not an account:
  - It asks for their name, email, practice name, roughly how many clients they have, and optionally a phone number. It's the `request_practice_account` command, on a public route.
  - An overseer sees the requests in Settings → Admin and sets the practice up as today. Someone follows up by hand; that's in NON-CODE-TODOS.md.
  - The trial isn't moved anywhere. An accountant's trial is usually an example. An own-file trial stays a trial, kept for 7 days, and can still be saved by its owner.
  - The form reminds them not to upload a client's statement without the client's OK.
- `/accountants` and `/signup` get the same **Get a practice account** entry.
- **Why not self-serve accountant accounts yet:** the server has one practice. Practice users are made by an admin, and charts, templates and the paragraph library are practice-wide. Letting a firm sign itself up needs practice tenancy (the White label backlog item), which is its own milestone. Until then, a request someone answers is honest, and suits the stage the business is at.

**ADR 015 settles:**
- the accountant view's exact route list, and what's locked;
- the peak rules: the $100 threshold, once per trial, and dismissal;
- the `from` values;
- the practice request: what's stored, how long it's kept, the privacy policy line, and who sees it;
- that claimed owners get the switch too.

Done when: `crates/server/tests/m21.rs` (`m21_is_done`) shows, with no sign-in:
- a guest reads its trial's statements, trial balance, journals, general ledger and asset register;
- it's refused every write on them, and the PDF, with the reason;
- a second guest can't read them;
- `claim_guest` records its `from`;
- a practice request goes through the pipeline and only overseers can list it;
- the overseer's counts match the trials started, saved and expired.

The web tests cover:
- each tile, with and without a trial;
- the switch, read-only;
- the saving line appearing once at the threshold, and never for an example;
- an example's "drop your own statement" line;
- the "Who are you?" question appearing only after the accountant view;
- the practice request form.

Then a browser check on a desktop and a phone.

## Open questions
- **Who's the customer?** Assumed: business owners first (sole traders), with their accountants working on the same data. Practices running it for their clients under their own brand (the "white label") comes later. Confirmed.
- **GST or income tax first in M14?** Assumed GST: its periods are shorter, so it's filed more often. yes
- **Hosting (M12).** Decided in ADR 008 (proposed 2026-10-24).
  - Fly.io in Sydney: one machine and one volume, because SQLite has a single writer.
  - Litestream streams the database to a Tigris bucket, so we can lose at most about 10 s of work. Fly's daily volume snapshots are a second layer.
  - There are two apps, `wla-staging` and `wla-prod`.
  - Staging deploys automatically once CI passes. Production deploys after a manual approval.
  - Expect about US$5–7 a month for production.
- **AI provider (M11).** Decided in ADR 009 (accepted 2026-10-23).
  - The provider is swappable. Suggestions come first from rules, the business's own history and a practice merchant list, and only then from a model.
  - Development starts on Claude Haiku 5.5, and a bake-off on a labelled set chooses the production model.
  - Suggestions are off by default and opt-in per business.
  - IRD must confirm before real owners use it.
  - An MCP server for outside AI agents isn't planned.
- **Which entity types come after sole traders:** companies, partnerships or trusts? Whatever is most prudent.
- ~~Does anyone need to edit away from the office network?~~ Yes, answered by going online (ADR 007).

## Backlog (not scheduled)
- White label: practices run it for their clients under their own brand and domain. This needs practice tenancy first (practice-owned charts, templates, paragraphs and users), which is also what self-serve accountant sign-up waits on (M21).
- Tax agent mode: an accountant links many clients through IRD's intermediation services and files for them.
- Bank feeds instead of uploads, through an NZ open-banking provider (for example Akahu).
- Provisional tax, ACC levies, tax depreciation, home office and vehicle apportionment, and the IR10.
- GST: the invoice and hybrid bases (these need sales invoicing), and deregistering. Entertainment's half-claim rule.
- Income tax: non-standard balance dates, and older income years (2025's composite rates) for late filers. Penalties and interest on late returns.
- Companies (IR4), partnerships and trusts: templates and returns.
- Premade master charts and templates in the familiar NZ style, in our own words (see `docs/domain.md`).
- Client-level mapping overrides.
- Workpapers; minutes and resolutions from our own paragraph library.
- Messages between an owner and their accountant inside the app. M18's "Ask your accountant" copies a ready message for the owner to send themselves until there is one.
