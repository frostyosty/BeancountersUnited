# M15 agent prompts

M15 splits into two waves. In wave 1, five agents can work at once because none of them touches the same files. Wave 2 needs wave 1's code (and your sign-off on the PDF ADR), so it starts once that lands.

Each prompt says which files that agent owns. Shared files (`App.tsx`, `YearLayout.tsx`, `icons/registry.json`, `commands.rs`) are append-only for everyone except their named owner: re-read just before editing, and add only your own lines.

**Migrations:** take the next free number in `crates/store/migrations/` when you start, and create the file straight away (even empty) so other agents see the number is taken.

**Roles:** "practice owner" means the role CLAUDE.md calls `practice owner` (still `Role::Master` in code unless M12 has renamed it).

## Wave 1: start all five now

### Agent 1: ADR 010, the PDF renderer (doc only, needs me)
```
Read CLAUDE.md (Reports), ADR 003 (ReportDoc), ADR 007, PLAN.md's M15 section, Dockerfile, fly.toml and crates/core/src/reportdoc.rs.
Write docs/decisions/010-pdf-renderer.md. ADR 008 is hosting (M12) and 009 is AI suggestions.
Compare embedded Typst with headless Chromium on:
- the size of the Docker image and memory on a 512 MB Fly machine
- the build: Rust-only, or a browser in the image
- whether the same ReportDoc gives the same PDF bytes (fonts embedded, no timestamps in metadata)
- page layout control: whole-dollar columns aligned, page breaks that keep a statement's heading with its first lines, "continued" headers, page numbers
- fonts we can ship under an open licence
- how the HTML preview and the PDF stay consistent, given both only render a ReportDoc
Recommend one, and say how it's tested (golden tests snapshot the ReportDoc JSON, never the PDFs; say what, if anything, we check about the PDF).
Ask me before settling it. Only edit that ADR file. Don't write code. Don't commit.
```

### Agent 2: finalise, snapshots, locks, reopen and comparatives
```
Read CLAUDE.md (Domain invariants: Finalised years, Snapshots, Comparatives), PLAN.md's M15 section, migration 0001's client_years and snapshots tables, crates/store/src/years.rs, crates/server/src/pipeline.rs (open_year and every command arm), crates/server/src/commands.rs, crates/server/src/ledger.rs and crates/core/src/reportdoc.rs (Prior).
You own:
- crates/server/src/commands.rs and pipeline.rs (you're their owner this wave; others may only append their own variants and arms)
- a new crates/server/src/finalise.rs, a new crates/store/src/snapshots.rs (plus `pub mod` lines), crates/store/src/years.rs, and a new migration if you need one
- a new crates/core/src/finalise.rs for the pure pre-checks (plus `pub mod finalise;` in core's lib.rs)
- crates/server/tests/m15.rs
Task:
1. finalise_year (practice owner only). Pre-checks in core, each with a plain message:
   - the prior year, if there is one, is finalised
   - the TB balances
   - mapping is complete for current and prior balances
   - depreciation is current (the system depreciation journal matches what the register computes)
   - no uncategorised bank lines, unless the command says the accountant accepts them as they are (logged)
   Then write the snapshot: TB, pinned template and mapping versions, the ReportDoc, and a SHA-256 of its JSON. Lock the year.
2. Lock enforcement: every command that touches amounts or dates in a finalised year is rejected. Audit every arm in pipeline.rs, not only the ones that call open_year, and list the ones that are allowed (e.g. set_coding_settings) with the reason in a comment. Add a test that walks every command kind against a finalised year, built from the Command enum so a new kind that isn't covered fails.
3. reopen_year (practice owner only), with a required reason that's logged. The old snapshot stays on record.
4. Comparatives: the prior year's snapshot TB through the current year's mapping and template; if the prior year isn't finalised, its live TB, marked unfinalised. Wire this through ledger.rs's report read.
5. GET the snapshot's ReportDoc for a finalised year. It's served as stored, never rebuilt.
6. tests/m15.rs, m15_is_done: a finalised year's ReportDoc is byte-identical across a server restart and after a template edit, posting into that year is rejected, and the fixture's bank accounts reconcile (use Agent 5's endpoint, or message them).
Don't run this at the same time as M12's tenancy agent; both change every command arm.
Don't commit. Before you finish, run make check (vitest via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...`) and regenerate the types.
```

### Agent 3: paragraph library, accounting policies and notes
```
Read CLAUDE.md (AO-like, Hard rule 3, Defaults never reach back), PLAN.md's M15 section, crates/core/src/reportdoc.rs, crates/core/src/template.rs, and docs/domain.md's decisions and sole-trader chart sections.
You own:
- a new crates/core/src/notes.rs (plus `pub mod notes;` in core's lib.rs)
- the notes parts of crates/core/src/reportdoc.rs (a notes section in ReportDoc), and the snapshot updates that causes, which you must explain one by one
- a new crates/store/src/paragraphs.rs, a new migration, and a new crates/server/src/paragraphs.rs, with your own variants appended to commands.rs and arms to pipeline.rs (Agent 2 owns those files: re-read before each edit, and keep your arms one-line calls into paragraphs.rs)
- a new fixtures/practice/paragraphs.json, and a new "Accounting policies and notes" section in docs/domain.md
Task:
1. A practice paragraph library: titled paragraphs with fields (e.g. {business_name}, {balance_date}, {depreciation_methods}). Our own wording only; never MYOB's (hard rule 3). Write a starter set for sole traders: basis of preparation, GST, depreciation, and going concern.
2. Each client-year picks paragraphs and can edit its copy. Defaults never reach back: editing the library doesn't change a client's copy; pushing a change onto open years is an explicit command with a preview.
3. A pure fill function in core: paragraphs + client fields → plain text, failing loudly on an unknown or empty field. It must be byte-stable.
4. Notes go into the ReportDoc after the statements, so the snapshot holds exactly what was signed.
5. Tests: fill, the unknown-field error, the push preview touching only open years, and rejection tests for each command.
Ask me about wording or which notes a sole trader needs (presentation questions), then record the answers in docs/domain.md.
Don't commit. Before you finish, run make check and regenerate the types.
```

### Agent 4: analysis reports and the GL listing
```
Read CLAUDE.md, PLAN.md's M15 section, crates/core/src/ledger.rs, crates/server/src/ledger.rs, crates/server/src/reads.rs and apps/web/src/pages/TrialBalanceTab.tsx and YearLayout.tsx.
You own:
- new crates/core/src/analysis.rs and crates/core/src/gl.rs (plus their `pub mod` lines)
- a new crates/server/src/reports.rs and its GET routes in crates/server/src/lib.rs
- new apps/web/src/pages/GlTab.tsx and AnalysisTab.tsx (+ tests and CSS modules), their routes in App.tsx, their links in YearLayout.tsx, and the year.gl / year.analysis slots in icons/registry.json
Task:
1. GL listing per account for a client-year: date, journal, description, amount and running balance. Matched reversal pairs (a journal and the journal that reverses it, both posted) are hidden by default with a toggle to show them; the running balance is the same either way. The pairing logic is pure, in gl.rs.
2. Analysis reports: expenses by category, this year against last year, with the change in dollars and percent. Percentages in basis points, no floats (hard rule 4). Use the report lines from the mapping so categories match the statements.
3. Accountants see account codes here; owners never do.
4. Tests: core unit tests for reversal pairing (including a reversal of a reversal), and server tests for the reads.
Don't commit. Before you finish, run make check and regenerate the types.
```

### Agent 5: bank reconciliation view and the sole-trader statements worked example
```
Read CLAUDE.md, PLAN.md's M10 and M15 sections, crates/core/src/bank.rs (reconciliation), crates/server/src/business.rs, docs/domain.md (both sole-trader worked examples) and fixtures/.
You own:
- a new crates/server/src/reconcile.rs and its GET route in crates/server/src/lib.rs
- a new apps/web/src/pages/ReconcileTab.tsx (+ test and CSS module), its route in App.tsx, its link in YearLayout.tsx, and the year.reconcile slot in icons/registry.json
- a new section at the end of docs/domain.md, before "## Open": "Worked example: the sole trader's statements"
- a new golden test crates/core/tests/sole_trader_statements.rs and its snapshot
Task:
1. Reconciliation per bank and card account: the statement's closing balance against the ledger balance at that date, with any unmatched items listed (lines without a journal, journals without a line, gap journals).
2. Work out by hand the sole trader's P&L and balance sheet after the M11 coding fixture is applied: whole dollars, rounding lines, prior-year column. Show the arithmetic as the existing worked examples do, and mark it "a person still has to check it". Cross-check with a standalone script in your scratchpad directory that doesn't use acct-core.
3. The golden test builds the ReportDoc from that state and snapshots its JSON, and asserts the totals match the worked example.
Ask me about presentation questions (signs, grouping, wording) and record the answers in docs/domain.md.
Don't commit. Before you finish, run make check and regenerate the types.
```

## Wave 2: once wave 1 is in

### Agent 6: the PDF renderer
Start once ADR 010 is accepted.
```
Implement ADR 010 as it stands:
- a new crate (crates/pdf, or as the ADR names it) that renders a ReportDoc, including Agent 3's notes, to PDF. It renders only; it computes nothing.
- the same input gives the same bytes: fonts embedded, no timestamps or random ids in the metadata. Test this.
- GET a PDF for a client-year: from the snapshot when finalised, from the live ReportDoc otherwise, with "Draft" on every page of a draft.
- the Dockerfile and fly.toml changes it needs (re-read them first; M12 may have changed them).
When you add a dependency, give the reason in your final message so it goes in the commit. Don't touch other agents' files except the route line in crates/server/src/lib.rs.
Don't commit. Before you finish, run make check.
```

### Agent 7: finalise and notes screens (web)
Start once agents 2 and 3 have generated their types into packages/types.
```
Read CLAUDE.md (Web, Icons and emoji, and "Don't use emoji where accounting output is rendered"), apps/web/src/pages/StatementsTab.tsx, YearLayout.tsx, SettingsPage.tsx and their tests, and the finalise and paragraph types in packages/types.
You own:
- new apps/web/src/pages/FinaliseTab.tsx, NotesTab.tsx and ParagraphLibrary.tsx (+ tests and CSS modules)
- the notes section and "Download PDF" button in StatementsTab.tsx
- their routes in App.tsx, links in YearLayout.tsx and SettingsPage.tsx, and the year.finalise* / year.notes* / settings.paragraphs* slots in icons/registry.json
Task:
1. Finalise: run the pre-checks and show each as passed or failed in plain words, with a link to fix it. The finalise button is for the practice owner only, and asks for confirmation. A finalised year shows who finalised it and when, and the snapshot's hash.
2. Reopen: practice owner only, with a required reason.
3. Notes: pick and edit the client-year's paragraphs, with a preview of the filled text.
4. Paragraph library on the settings page (practice owner), including the push-to-open-years preview.
5. The statements preview shows the notes and gets a "Download PDF" button (Agent 6's route).
Statements, notes and PDFs stay plain: no emoji there. Run vitest and tsc via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...`. Don't commit.
```

## Notes
- **Shared files:** agents 3 and 5 both add a section to `docs/domain.md`, each only its own. Agents 4, 5 and 7 all add links to `YearLayout.tsx` and routes to `App.tsx`.
- **Agents 1, 3 and 5 will ask you things:** the PDF renderer (1), note wording and which notes a sole trader needs (3), and statement presentation (5).
- **The order that matters:** Agent 6 needs your sign-off on ADR 010 and Agent 3's notes in the ReportDoc. Agent 7 needs agents 2 and 3. Agent 2's done test uses Agent 5's reconciliation.
- **M12 first:** Agent 2 and M12's tenancy agent both change every command arm, so finish M12's wave 1 before starting this.
- **Not committed yet:** quicksave before starting wave 1, so each agent's work shows up as its own diff.
