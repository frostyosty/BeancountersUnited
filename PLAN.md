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

## M17 — Admin "view as" with real impersonation
Status: not started. Planned 2026-10-26. M12's Settings screen ships a UI-only preview first (the web app swaps the role it renders for, labelled with a "Viewing as …" banner; the server still enforces the real role). This milestone replaces it with the real thing.
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
- White label: practices run it for their clients under their own brand and domain.
- Tax agent mode: an accountant links many clients through IRD's intermediation services and files for them.
- Bank feeds instead of uploads, through an NZ open-banking provider (for example Akahu).
- Provisional tax, ACC levies, tax depreciation, home office and vehicle apportionment, and the IR10.
- GST: the invoice and hybrid bases (these need sales invoicing), and deregistering. Entertainment's half-claim rule.
- Income tax: non-standard balance dates, and older income years (2025's composite rates) for late filers. Penalties and interest on late returns.
- Companies (IR4), partnerships and trusts: templates and returns.
- Premade master charts and templates in the familiar NZ style, in our own words (see `docs/domain.md`).
- Client-level mapping overrides.
- Workpapers; minutes and resolutions from our own paragraph library.
