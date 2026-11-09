# M29: The reporting pack, and reports kept apart from the statements

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M29 takes the next free
ADR number (check) and probably no migration. **It needs M26 first** (`ReportTable`). It's better after M27 and M28,
so the pack can include the beneficiary schedule and the aged reports, but it doesn't have to wait: it includes whatever
exists when it runs.

## The milestone
Status: not started. Planned 2026-11-10. Presentation and wording choices are marked **DECISION FOR ME** and are
answered before code starts.

**Why.** An accountant doesn't hand a client two statements. They hand a *set*: a cover page, contents, a
compilation report, the statements, notes, schedules, the signed approval page, and often a detailed profit and loss
and a trial balance behind. Today the PDF (`crates/pdf`) renders "the statements, the fixed asset schedule and the
notes, in that order", with no choice, no cover and no page numbers.

**What exists today:**
- The ReportDoc (statements, `asset_schedule`, `notes`), the PDF renderer and the Statements tab.
- The paragraph library (`crates/server/src/paragraphs.rs`, `fixtures/practice/paragraphs.json`): practice-maintained
  paragraphs copied into a year, with client fields filled in, feeding accounting policies and notes.
- The trial balance (`TrialBalanceTab.tsx`) and the general ledger (`GlTab`) on screen, and expense analysis. None is
  a printable report that joins the pack.
- Finalising stores the ReportDoc and its hash; that document is the record of what was signed.
- After M26 to M28: `ReportTable`, and optionally the movements statement, the schedule and the aged reports.

**1. The cover page and contents.** Entity name, the statements' title ("Financial statements for the year ended ..."),
who they're prepared for, and the practice's name; then a contents page with page numbers. Built into the ReportDoc
(core knows the order; the PDF paginates, so page numbers are the renderer's, not part of the signed figures).

**2. The approval page.** The statement the directors, trustees or owner sign to approve the accounts: our own
wording, from new paragraph-library kinds, with signature and date lines and the right office-holder for the entity
type (director, trustee, owner). **DECISION FOR ME:** who signs for each entity type and the exact wording, which is
the practice's to approve (hard rule 3: our own words).

**3. The compilation report.** The accountant's own report. Its wording is a professional matter, not ours to set:
the app ships a short neutral placeholder and the practice replaces it from the library. A page can't be finalised
while it still holds the placeholder (a finalise pre-check, accepted only by a practice admin, with the reason logged).
**DECISION FOR ME:** whether that pre-check applies.

**4. Detailed statements.** The same performance statement with every account under each line, prior year beside it.
It's a view of the template and mapping, so no new arithmetic: every account is already behind a line (the ReportDoc
holds the codes), and rounding applies to the line as it does today, with accounts shown to the cent. **DECISION FOR
ME:** accounts in cents or whole dollars; recommended: cents, with the line's rounded figure as the total.

**5. Reports, kept apart from the statements.** The **trial balance**, a journal listing and account transactions (the
GL) are workpapers, not statements, so they get their own **Reports** tab beside Statements (M28's aged reports live
there too) and are never mixed into the statements' view or PDF. Each is a `ReportTable` with its own PDF and CSV
download, and workpapers show cents (as M28).
- The trial balance has opening balances (rolled forward, never posted), the year's movement and the closing balance, by
  account in chart order, with debit and credit columns and a footing row, and drill-down to the account's
  transactions. A finalised year shows the snapshot's TB, with its chart names as they were. The existing on-screen
  tab (`TrialBalanceTab.tsx`) becomes the web view of this report.
- Each ties to the TB: its totals equal the TB's, and the journal listing foots to zero.
- A report joins the pack only if the practice or the year adds it; the default pack has none.
- **DECISION FOR ME:** the trial balance's columns (opening, movement and closing, or closing only), and whether it
  shows nil accounts. Recommended: opening, movement and closing, debit and credit, with nil accounts left out.

**6. The pack.** A per-client-year choice of which items to include and in what order (cover, contents, compilation
report, approval, statements, notes, schedules, detailed statements, and any report the accountant adds), starting from a practice default and
copied into the year at the point of use (Defaults never reach back). One PDF for the whole pack, with page numbers
and a contents page that matches. Finalising pins the pack choice and stores each included item's ReportDoc and hash,
so a finalised pack is never regenerated.

**Out.** Per-page headers with firm branding and logos (white label; backlog), electronic signature, emailing the pack,
templates for the practice's engagement letters, minutes and resolutions (backlog: workpapers), and any tax or IRD
form output.

### Done when
`crates/core/tests/pack.rs` and `crates/server/tests/m29.rs` (`m29_is_done`) show that:
- the sole-trader fixture's pack has a cover, contents, statements, notes, the approval page and the detailed
  statements, in the chosen order, and its pack JSON is snapshotted;
- the detailed statements' accounts add up to each line's exact figure, and the line shows the same rounded figure as
  the summary statement;
- the trial balance report shows opening, movement and closing by account, its debit and credit columns each total the
  TB, and the journal listing foots to zero;
- the Reports tab and its PDFs are separate from Statements: the statements' view and PDF never contain a report
  unless the year's pack adds one;
- the contents page numbers match the PDF's pages (checked from the PDF's text);
- the placeholder compilation report blocks finalising unless a practice admin accepts it with a reason, which is
  logged; the accepted wording is stored in the snapshot;
- a finalised year's pack is byte-identical after later changes to the library, the template and the pack default;
- the pack's default order doesn't change any existing client.

The web tests cover the pack chooser, the reordering and the approval page. Then a browser check, reading the PDF.

## Running it

Five waves of small agents. Opus only writes the ADR.
- **Wave 1:** ADR. **Nothing in wave 2 starts until you've accepted it and answered its DECISIONS FOR ME.**
- **Wave 2:** two agents at once: core (the pack, detailed statements, the reports); and the paragraph library's new kinds and the fixtures.
- **Wave 3:** the server (pack choice per year, reads, finalise).
- **Wave 4:** two agents at once: the web; and the PDF (cover, contents, pagination, approval).
- **Wave 5:** the done check.

Shared files and rules are as in `M26-PROMPTS.md` ("Running it"). **Migration:** only Agent 4, and only if the pack
choice can't live in the year's existing settings; next free number.

**Hard rules apply.** Money is integer cents (4); core is pure and byte-stable, so the pack JSON holds no page
numbers, timestamps or generated ids (5); changes to a year's pack are commands (6); the wording is our own (3); no
emoji in anything rendered into the pack (CLAUDE.md).

## Wave 1: start now

### Agent 1: the ADR (Opus, high thinking)
```
Read CLAUDE.md (Domain invariants, Snapshots, Defaults never reach back, Hard rules), M29-PROMPTS.md (the milestone), M26-PROMPTS.md, the accepted M26 ADR, docs/decisions/003-reportdoc.md and 010-pdf-renderer.md, docs/domain.md (Accounting policies and notes, Statement amounts and columns), crates/core/src/reportdoc.rs, notes.rs, table.rs, finalise.rs, crates/pdf/src/lib.rs, crates/server/src/paragraphs.rs, finalise.rs, pdf.rs and reports.rs, fixtures/practice/paragraphs.json, apps/web/src/pages/StatementsTab.tsx, TrialBalanceTab.tsx and GlTab.tsx.
You own:
- docs/decisions/NNN-reporting-pack.md (new; NNN is the next free number)
- a new "The reporting pack" section in docs/domain.md (decisions only)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed. Mark each DECISION FOR ME in the milestone and don't decide it.
1. The pack's shape in core: an ordered list of items (cover, contents, compilation report, approval, statements, notes, schedules, detailed statements, optional reports), where it sits relative to ReportDoc, and what is and isn't in the signed, hashed JSON (no page numbers).
2. The pagination boundary: core states the order, the renderer paginates and numbers, and how the contents page gets correct numbers without core knowing them.
3. New paragraph-library kinds (cover, approval, compilation report), their client fields, and the neutral placeholder's wording, our own.
4. Detailed statements: how accounts, rounding and the codes behind a line combine without a second rounding implementation.
5. The reports (trial balance, journal listing, account transactions) as tables kept apart from the statements: how each ties to the TB, what a finalised year shows, their download formats, and how one is added to a pack.
6. Where the per-year pack choice is stored, how it's copied from the practice default at the point of use, and how finalising pins it.
7. The pre-check for the placeholder, who may accept it, and the log entry.
8. What a person must do: an NZ accountant supplies and approves the approval and compilation wording (professional standards apply, so it isn't ours to invent), and checks a sample pack. Add to NON-CODE-TODOS.md.
List the consequences. Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted the ADR (both at once)

### Agent 2: core (Sonnet, high thinking)
```
Read CLAUDE.md, M29-PROMPTS.md, the accepted ADR, crates/core/src/reportdoc.rs, table.rs, notes.rs, gl.rs, ledger.rs, finalise.rs and crates/core/tests/ for the style.
You own:
- crates/core/src/pack.rs (new): the pack type, its builder, the detailed-statements view, the reports as ReportTables (trial balance first); its lines in lib.rs
- crates/core/tests/pack.rs (new)
Task: pure and byte-stable, no HashMaps, no page numbers. The detailed statements reuse the existing rounding: they add no second implementation.
Tests: proptest (detailed accounts sum to the line's exact figure; the trial balance report's columns total the TB; the journal listing foots to zero); the pack's order; the fixture pack's JSON snapshotted.
Run `scripts/one-build.sh make check`. Don't update existing snapshots; if one moves, stop and tell me. Don't commit.
```

### Agent 3: library kinds and fixtures (Sonnet, medium thinking)
```
Read CLAUDE.md, M29-PROMPTS.md, the accepted ADR, crates/core/src/notes.rs, crates/server/src/paragraphs.rs, fixtures/practice/paragraphs.json, docs/domain.md (Accounting policies and notes), and the paragraph library page (apps/web/src/pages/ParagraphLibraryPage.tsx) for what the library already lets a practice edit.
You own:
- the new paragraph kinds and fields in crates/core/src/notes.rs (serde defaults, so existing library JSON is byte-identical), and the ADR's neutral placeholder wording
- fixtures/practice/paragraphs.json: new cover, approval and compilation entries, our own words, invented names
- crates/core/tests/pack_fixtures.rs (new)
Task: add the kinds, fill the fixtures, and test that every field fills for each entity type and that an unfilled field is an error, not a blank.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 3: after Agents 2 and 3 have landed

### Agent 4: the server (Sonnet, high thinking)
```
Read CLAUDE.md, M29-PROMPTS.md, the accepted ADR (the pack choice and the pre-check), crates/server/src/finalise.rs, reports.rs, pdf.rs, paragraphs.rs, commands.rs, pipeline.rs, access.rs, history.rs, lib.rs, crates/store (settings per year) and tests/common/mod.rs.
You own:
- crates/server/src/pack.rs (new): the pack read, and the command to set a year's pack (copied from the practice default at the point of use)
- the pre-check and the snapshot's pack items (finalise.rs, lines only), and the new command's lines in commands.rs, history.rs, impersonation.rs, lib.rs and access.rs (append-only)
- a migration only if the ADR needs one
- crates/server/tests/pack.rs (new)
Task: the pack read builds the pack from the year's pinned template, mapping and paragraphs; setting the pack is a command, rejected for a finalised year; finalising stores each item's ReportDoc and hash, and runs the placeholder pre-check.
Tests: the order; the pre-check and its logged acceptance; a finalised pack survives library, template and default changes unchanged; existing clients are unaffected.
Run `scripts/one-build.sh make check`, then `make types`. Don't commit.
```

## Wave 4: after Agent 4 has landed (both at once)

### Agent 5: the web (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M29-PROMPTS.md, the accepted ADR, pages/StatementsTab.tsx, FinaliseTab.tsx, NotesTab.tsx, ParagraphLibraryPage.tsx, components/ReportTable/ and the generated types.
You own:
- a "Reports" tab under apps/web/src/components/Reports/ (trial balance, journal listing, account transactions, and M28's aged reports if they exist; as-at date, PDF and CSV download; the existing TrialBalanceTab becomes its trial balance view), mounted beside Statements and never inside it
- a "Pack" tab under apps/web/src/components/Pack/ (choose items, reorder, preview each, the placeholder warning), its mount and route (lines only), and new slots in apps/web/src/icons/registry.json (append-only)
- the approval and compilation entries' editing in ParagraphLibraryPage.tsx (lines only)
- Testing Library tests
Task: the practice default and the year's pack, reordering without drag-only controls (keyboard-friendly), a preview per item that only renders the server's data, and the placeholder warning in Finalise's pre-check list.
Run `scripts/one-build.sh make check`. Don't commit.
```

### Agent 6: the PDF (Sonnet, high thinking)
```
Read CLAUDE.md, M29-PROMPTS.md, the accepted ADR (the pagination boundary), docs/decisions/010-pdf-renderer.md, crates/pdf/src/lib.rs and tests/render.rs, and the table module (M26's).
You own:
- crates/pdf: the cover, contents and approval pages, each report as its own standalone PDF, pagination and page numbers, and tests
Task: render the whole pack in one PDF in the pack's order. The renderer owns pagination; the contents page's numbers are computed by laying the pack out first, so they match. It does no arithmetic and makes no layout choice that changes a figure.
Tests: the PDF builds for the fixture pack; its text has the cover, each section's heading, and contents numbers matching the pages where those headings fall.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 5: after Agents 5 and 6 have landed

### Agent 7: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M29-PROMPTS.md ("Done when"), the accepted ADR, crates/core/tests/pack.rs, crates/server/tests/pack.rs and tests/common/mod.rs.
You own:
- crates/server/tests/m29.rs (new)
Task: write `m29_is_done`, checking each "Done when" bullet in turn. Reuse the helpers in tests/common.
Run `scripts/one-build.sh make check`. Don't commit.
```

## When all of them are done

Check `make check` passes, then in a browser: build a pack for the fixture sole trader, open the PDF, check the contents
numbers by eye, finalise (accept the placeholder with a reason), and see the pack unchanged after editing the library.
Hand a sample pack to an NZ accountant (`NON-CODE-TODOS.md`) and tick it. Tick M29's status here and in `PLAN.md`.
