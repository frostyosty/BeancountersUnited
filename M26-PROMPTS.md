# M26: Statement of movements in equity (and the table the next three milestones share)

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M26 takes the next free
ADR and migration numbers (at writing, ADR 019 and migration 0019 are free, but M25 may claim them: check). It comes
after M24. (`ROADMAP.md` reserves M25 for the "Ask the experts" modal, so the reporting milestones start at M26.)
M27, M28, M29 and M30 all build on the table shape this milestone adds, so it goes first.

## The milestone
Status: not started. Planned 2026-11-10. Every presentation choice below is marked **DECISION FOR ME** and goes to a
person before any code is written (CLAUDE.md: don't guess presentation; record the answer in `docs/domain.md`).

**Why.** A set of NZ statements normally has three parts: financial performance, **movements in equity**, and financial
position. We have two of them. The company template shows equity only as the last group of the position statement
(share capital, retained earnings, profit for the year), and the sole-trader template as capital, profit and drawings,
so there's nowhere to see how equity got from last year's figure to this year's: dividends, shares issued, capital
introduced, drawings.

**What exists today:**
- `acct_core::template`: a `Template` is a list of statements, each a tree of `Node`s (`Group`, `Line`, `Total`,
  `Link`). Every figure is the closing balance of the accounts mapped to a line. A row has one current and one prior
  amount (`ReportRow`). There's no way to ask for an opening balance or for one year's movement.
- `ReportDoc` already carries things that aren't statement rows, attached by the caller: `asset_schedule` and `notes`.
- `ledger::rollover` computes opening balances from the prior closing TB. Finalising stores the closing TB, the pinned
  mapping and template versions, the ReportDoc and its SHA-256 (CLAUDE.md, Snapshots).
- Comparatives are the prior year's snapshot TB through this year's mapping (CLAUDE.md, Comparatives).
- Statements today: performance and position only (`fixtures/practice/*-template.json`), plus the fixed asset schedule.
  The sole-trader worked example in `docs/domain.md` already has the figures a movements statement needs: capital
  4,550, profit 2,012, drawings (795), closing equity 5,767, in a first year with no prior column.

**1. What the statement shows.** Opening equity; profit for the year (the P&L's figure as shown); each movement
(dividends, shares issued or repurchased, capital introduced, drawings); closing equity. It's template-driven like
every statement, so a practice can rename or reorder lines.
- **DECISION FOR ME: layout.** (a) Vertical: one column of lines, current and prior beside each other, like the other
  statements. (b) A grid: one column per part of equity (share capital, retained earnings, total) and one row per
  event, which is how many NZ company sets look. Recommended: build the general grid (section 2), use it for companies
  and trusts, and use the vertical layout for sole traders, who have only one pot of equity.
- **DECISION FOR ME: title and position.** "Statement of Movements in Equity" or "Statement of Changes in Equity", and
  whether it sits between performance and position (the usual order) or after position.
- **DECISION FOR ME: sole traders.** Whether the sole-trader template includes it by default. Recommended: yes, since
  the position statement can then keep its short equity group.

**2. A table in the ReportDoc.** The grid is a new shape: rows by named columns, where every column foots and every row
cross-foots. M27 (beneficiary accounts), M28 (aged balances), M29 (listings) and M30 (cash flow) need the same thing, so
the ADR designs one `ReportTable` that all four reuse: columns (key and heading), rows with an amount per column, a
total row and a total column, the same `RowStyle`, drill-down by account codes, and the rule for rounding. Rounding is
the hard part: a grid has to foot both ways after rounding to whole dollars, and the corner cell is owned by both.
The ADR extends the rounding rule in `docs/domain.md` (still one implementation, in core). Where a table sits in the
ReportDoc (a statement-level kind, or a list of schedules beside `asset_schedule` and `notes`) is the ADR's call,
with the constraint that old stored ReportDocs stay readable.

**3. Movement lines in the template.** A `Line` says which figure it takes from its accounts: the closing balance
(today, and the default, so every existing template, mapping and snapshot is unchanged), the opening balance, or the
**movement** in the year (closing minus opening, leaving out the P&L's own closing into retained earnings, which is
the "profit for the year" row). Mapping rules are unchanged: every account with a balance maps to exactly one line,
and nothing is silently dropped.

**4. Equity accounts that move.** A movement needs its own account: dividends can't be told from retained earnings if
they're posted straight into it. The master company chart has only 950 Share capital and 960 Retained earnings; the
sole-trader chart already has capital and drawings accounts. The ADR settles:
- which accounts a practice chart needs (dividends declared, shares issued, and so on), added to the master charts as
  new defaults only. Existing clients' charts don't change on their own (CLAUDE.md, Defaults never reach back); the
  existing "push a default to open years" command, with its preview, is the way to bring them across;
- how those accounts behave at rollover. CLAUDE.md says a sole trader's capital and drawings close to owner's equity,
  and only the P&L closes to retained earnings for a company. The agent checks what `ledger::rollover` actually does
  before the ADR is written, and records any gap. Dividends should close into retained earnings the way drawings do.

**5. Opening, comparatives and the snapshot.** The prior-year column needs the prior year's *opening* equity, which is
the year before's closing. A finalised snapshot holds the closing TB only. The ADR decides how to get the opening:
store the opening TB in snapshots from now on, and for a year finalised before M26 derive it from the earlier year's
snapshot if that is finalised. Where it can't be derived, the prior column shows "not available" with a warning, never
a guess. In a first year the opening is nil and there's no prior column (as in the worked example).

**6. Checks.** Two `EqualityCheck`s: closing equity on this statement equals the position statement's equity total, and
the profit row equals the P&L's net profit as shown (CLAUDE.md, Rounding: the profit in equity is the P&L's figure).

**7. Where it appears.** The Statements tab, the PDF, and the finalisation snapshot, like the other statements.

**Out.** Other comprehensive income and revaluation reserves (no revaluations exist in the app; a reserve account maps
to a column like any other, with no workings), dividends per share, imputation credits (CLAUDE.md, Out), and the cash
flow statement (M30).

### Done when
`crates/core/tests/movements.rs` and `crates/server/tests/m26.rs` (`m26_is_done`) show that:
- the sole-trader worked example's statement matches `docs/domain.md`: opening nil, profit 2,012, capital 4,550,
  drawings (795), closing 5,767, with no prior column, and its golden ReportDoc JSON is snapshotted;
- the company fixture's grid foots down and across in both years, closing equals the position statement's equity
  total, and the profit row equals the P&L's net profit (proptest on random ledgers, as in M1);
- a template with no movement lines builds a ReportDoc byte-identical to before, so no existing snapshot moves;
- finalising stores the statement and its opening figures; a later template edit doesn't change it; a prior year that
  isn't finalised marks the comparative as unfinalised; a prior year finalised before M26 shows "not available" and
  never a guessed figure;
- the dividends account is rejected for a mapping gap or overlap like any other, and a client whose chart lacks it
  gets the statement with the movement in its own line only after the explicit push command.

The web tests cover the grid and the vertical layout from a mocked ReportDoc, and the PDF test covers the page. Then a
browser check on the fixture company.

## Running it

Six waves of small agents. Opus only writes the ADR; the rest is Sonnet at the lowest thinking that suits the job.
- **Wave 1:** ADR. **Nothing in wave 2 starts until you've accepted it and answered its DECISIONS FOR ME.**
- **Wave 2:** two agents at once: core (table, movement lines, builder); and the fixtures and hand-worked example.
- **Wave 3:** store and server (snapshot, reads, finalise).
- **Wave 4:** two agents at once: the web; and the PDF.
- **Wave 5:** the done check.

Every agent reads the milestone section above first. Each prompt says which files the agent owns. Shared files
(`crates/server/src/lib.rs`, `commands.rs`, `access.rs`, `history.rs`, `Cargo.toml` workspace members,
`apps/web/src/App.tsx`, `apps/web/src/icons/registry.json`) are append-only except where a prompt says it owns them:
re-read just before editing, and add only your own lines. Don't hand-edit `packages/types`: run `make types`.

**Migration:** only Agent 4 may add one, and only if the ADR says snapshots must store the opening TB in a new column.
If the snapshot's existing JSON can hold it, there's no migration. Use the next free number and say so.

**Hard rules apply.** Money is integer cents, rates basis points (4). `crates/core` stays pure and byte-stable (5): the
table holds no ids, timestamps or HashMaps. Existing finalised snapshots are never regenerated or altered (7 and
CLAUDE.md, Snapshots). Migrations are append-only. No emoji in the statements or the PDF.

## Wave 1: start now

### Agent 1: the ADR (Opus, high thinking)
```
Read CLAUDE.md (Rounding, Rollover, Snapshots, Comparatives, Defaults never reach back, Hard rules), M26-PROMPTS.md (the milestone), docs/decisions/003-reportdoc.md and 010-pdf-renderer.md, docs/domain.md (Rounding to whole dollars, Statement amounts and columns, Account codes, Sole-trader chart and template, the sole trader's statements worked example), crates/core/src/template.rs, reportdoc.rs, mapping.rs, ledger.rs (rollover), finalise.rs, depreciation.rs (how asset_schedule is built and attached), notes.rs, fixtures/practice/company-chart.json, company-template.json, sole-trader-template.json, crates/server/src/finalise.rs and reports.rs.
You own:
- docs/decisions/NNN-movements-in-equity.md (new; NNN is the next free number, check docs/decisions/)
- a new "Statement of movements in equity" section in docs/domain.md (decisions only; the worked example comes from Agent 3)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed. Give the reason for each choice in a sentence. Mark everything the milestone lists as a DECISION FOR ME, and anything else that's a presentation call, and don't decide them.
1. What ledger::rollover really does with equity accounts other than the P&L (drawings, capital, a would-be dividends account), checked in the code, and the change needed so dividends and drawings close into the designated equity account. If the code differs from CLAUDE.md, say so.
2. ReportTable: its shape (columns, rows, total row and column, row styles, drill-down codes), where it lives in ReportDoc, and how old stored ReportDocs stay readable. Make it general enough for M27 (beneficiary accounts), M28 (aged balances), M29 (listings) and M30 (cash flow); list the needs of each in a sentence.
3. Rounding a grid so it foots both ways: the rule for the corner and for ties between the row's and the column's absorbing line, as an extension of the existing rounding rule. Work an example with numbers.
4. Movement lines: the `basis` on a template Line (closing, opening, movement), its default so existing templates and JSON are unchanged, and how mapping validation treats it.
5. Opening figures in snapshots: the options, the recommendation, what a year finalised before M26 shows, and whether a migration is needed.
6. The new equity accounts on the master charts and how existing clients get them (the explicit push, with its preview).
7. The EqualityChecks and the builder's warnings (a missing opening, an unfinalised comparative).
8. The effect on every existing golden snapshot (the aim is none).
Then list the consequences. List what a person must do (an NZ accountant checks the layout and wording against what they issue) and add it to NON-CODE-TODOS.md.
Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted the ADR (both at once)

### Agent 2: table, movement lines and builder (Sonnet, high thinking)
```
Read CLAUDE.md, M26-PROMPTS.md (the milestone), the accepted ADR (follow it where it differs from the milestone), docs/domain.md (the new movements section and the rounding sections), crates/core/src/template.rs, reportdoc.rs, mapping.rs, ledger.rs, analysis.rs (for how the core reports are structured), and the existing tests and snapshots in crates/core.
You own:
- crates/core/src/table.rs (new), and the ReportTable type's lines in lib.rs
- the `basis` on template lines and the movement builder in template.rs and reportdoc.rs
- the rollover change in ledger.rs, if the ADR calls for one
- crates/core/tests/movements.rs (new)
Task:
1. ReportTable with the rounding rule the ADR gives: one implementation, in core, deterministic, no HashMaps.
2. `basis` on template lines, defaulting to closing, with serde defaults so existing template JSON and ReportDoc JSON are byte-identical. Validate templates and mappings with it.
3. The builder: opening, movement and the profit row, comparatives per the ADR (including "not available"), the two EqualityChecks, and the warnings.
4. Any rollover change, with its own test that a dividends account closes into retained earnings.
Tests: proptest on random ledgers (every column foots, every row cross-foots, closing equals the position equity, profit equals the P&L's); a template with no movement lines gives byte-identical output to before; the rollover change. Use fixtures from Agent 3 when they land; until then use your own inline ones.
Run `scripts/one-build.sh make check`. Don't update snapshots: if one moves, stop and tell me.
Don't commit.
```

### Agent 3: fixtures and the hand-worked example (Sonnet, medium thinking)
```
Read CLAUDE.md, M26-PROMPTS.md (the milestone), the accepted ADR, docs/domain.md (the fixture company worked example and the sole trader's statements worked example), fixtures/practice/company-chart.json, company-mapping.json, company-template.json, sole-trader-*.json, fixtures/clients/example-widgets.json and marsh-hollow-coding.json, and fixtures/README.md.
You own:
- the new dividends and share-issue accounts in fixtures/practice/company-chart.json and company-mapping.json (new defaults only), and the movement lines in company-template.json and sole-trader-template.json as the ADR and the answers say
- a second year of dividends and a share issue in example-widgets.json, as commands through the pipeline (hard rule 6), keeping it synthetic
- docs/domain.md: a new "Worked example: the movements statement" (the sole trader's first-year figures, and the company's two years, worked by hand)
- crates/core/tests/movements_worked.rs (new): asserts the worked figures
Task: build the data and work the examples by hand, and cross-check them with a script that doesn't use acct-core, as the earlier worked examples did. Say "Hand-checked by: (nobody yet)".
Tests: the worked figures asserted from the fixtures; the fixtures still validate.
Don't update insta snapshots; if one moves, stop and tell me why.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 3: after Agents 2 and 3 have landed

### Agent 4: snapshots, reads and finalise (Sonnet, high thinking)
```
Read CLAUDE.md, M26-PROMPTS.md (the milestone), the accepted ADR (the snapshot section), crates/server/src/reports.rs, finalise.rs, commands.rs, pipeline.rs, access.rs, crates/store (snapshots), crates/core/src/table.rs and reportdoc.rs (Agent 2's), crates/server/tests/ (the finalise and reports tests) and tests/common/mod.rs.
You own:
- a migration only if the ADR needs one, and the store code for it
- the opening figures in the finalisation snapshot, in finalise.rs
- the statement in the report read (reports.rs), and the explicit push command's template lines (append-only in commands.rs)
- crates/server/tests/movements.rs (new)
Task: finalising stores the movements statement with its opening figures; the report read builds it from the pinned template and mapping; a year finalised before M26 shows "not available" for its comparative per the ADR and is never changed; the push command previews and touches open years only.
Tests: finalise then edit the template: the stored statement is unchanged and its hash still matches; the old-snapshot case; the push's preview and its open-years-only rule.
Run `scripts/one-build.sh make check`, then `make types`. Don't commit.
```

## Wave 4: after Agent 4 has landed (both at once)

### Agent 5: the web (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M26-PROMPTS.md (the milestone), the accepted ADR, apps/web/src/pages/StatementsTab.tsx and its test and module CSS, apps/web/src/lib/money.ts, and the generated types.
You own:
- a ReportTable component under apps/web/src/components/ReportTable/ (new; M27, M28, M29 and M30 reuse it, so keep it generic: columns, rows, totals, drill-down, a warnings strip)
- the movements statement's mount in StatementsTab.tsx
- Testing Library tests
Task: render the grid and the vertical layout from the ReportDoc with no arithmetic of its own (amounts format through lib/money.ts); drill-down into a cell's accounts; "not available" and "unfinalised" markers on the prior column. No emoji inside the statement body (CLAUDE.md); chrome around it may use Icon.
Tests: both layouts from mocked ReportDocs; the markers; drill-down.
Run `scripts/one-build.sh make check`. Don't commit.
```

### Agent 6: the PDF (Sonnet, medium thinking)
```
Read CLAUDE.md, M26-PROMPTS.md (the milestone), docs/decisions/010-pdf-renderer.md, crates/pdf/src/lib.rs and crates/pdf/tests/render.rs, and the ReportTable type in crates/core/src/table.rs.
You own:
- the table rendering in crates/pdf (a new module, table.rs, plus its lines in lib.rs), and its tests
Task: render the movements statement, grid and vertical, in the statements' order, with the same fonts and number formats; keep the table renderer generic for M27 to M30. It does no arithmetic. Golden tests snapshot the ReportDoc, never the PDF (CLAUDE.md), so test that the PDF builds, has the page, and contains the statement's heading and closing figure as text.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 5: after Agents 5 and 6 have landed

### Agent 7: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M26-PROMPTS.md ("Done when"), the accepted ADR, crates/core/tests/movements.rs and movements_worked.rs, crates/server/tests/movements.rs and tests/common/mod.rs.
You own:
- crates/server/tests/m26.rs (new)
Task: write `m26_is_done`, checking each "Done when" bullet in turn. Reuse the helpers in tests/common rather than copying the other tests' setup.
Run `scripts/one-build.sh make check`. Don't commit.
```

## When all of them are done

Check `make check` passes, then in a browser on the fixture company:
- Statements shows performance, movements in equity, then position (or the order you chose), and every figure ties.
- Finalise 2025, then edit the template: 2025's movements statement doesn't change.
- Open the PDF: the grid is on its own page and foots.
- Hand the worked example to an NZ accountant (`NON-CODE-TODOS.md`), then tick it.

Tick M26's status here and in `PLAN.md`.
