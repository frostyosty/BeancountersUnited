# M18 agent prompts: every upload reconciles, or says why

`PLAN.md` has the milestone ("M18 — Every upload reconciles, or says why"): what it's for, how a difference is
tracked down (checkpoints first, then suspects inside the window), and the "Done when". Every agent reads it first.

There are four waves.
- **Wave 1:** three agents work at once: the checkpoints in core, keeping the original file, and the fixtures.
- **Wave 2:** two agents: the proof card on upload, and the suspects. They need Wave 1.
- **Wave 3:** two agents at once: explaining the whole difference (5), and making the server, core and the
  fixtures agree on the books the suspects see (8). Both need the suspects.
- **Wave 4:** two agents: showing the findings with their fixes, and the done check. They need Wave 3.

Agent 8 was added after Agent 4 found that the fixtures and the server build different books (Agent 4's report,
2026-11-03): the server posts gap journals and stores worked-out balances on the wrong dates, so fixtures 02 and 07
would show no difference in the app, and 04's expected window disagrees with core.

Each prompt says which files that agent owns. Shared files (`crates/core/src/lib.rs`, `crates/server/src/lib.rs`,
`crates/server/src/commands.rs`, `crates/import/src/bank/mod.rs`, `apps/web/src/App.tsx`,
`apps/web/src/icons/registry.json`) are append-only for everyone: re-read just before editing, and add only your own
lines. Don't hand-edit `packages/types`: run `make types`.

**Migrations:** only Agent 2 adds one (0012). Anyone else who thinks they need one stops and asks.

**Hard rules apply throughout.** Fixtures are synthetic (1). Money is integer cents, never floats (4).
`acct_core::reconcile` is pure: no IO, clock or HashMaps, and the same inputs give byte-identical output (5). The check on
upload reads only; every fix is an existing or new command through the pipeline (6).

**Build through `scripts/one-build.sh`** in a Codespace, workspace-wide (`cargo test -- reconcile::`), never `-p`.

## Wave 1: start all three now

### Agent 1: checkpoints and the window (core, pure)
```
Read CLAUDE.md, PLAN.md (M18), crates/server/src/reconcile.rs, crates/server/tests/m15_reconcile.rs, crates/core/src/bank.rs (Gap, Coverage) and crates/import/src/bank/mod.rs (Statement, Balance, StatementLine, balance_check).
You own:
- crates/core/src/reconcile/ (new: mod.rs, checkpoints.rs, and finding.rs as a types-only stub, see 4)
- crates/server/src/reconcile.rs and crates/server/tests/m15_reconcile.rs
- one `pub mod reconcile;` line in crates/core/src/lib.rs (append-only)
Task:
1. Checkpoints. In acct_core::reconcile, a `Checkpoint { date, stated: Money, source: CheckpointSource }`, where the source is a statement id plus what kind of balance it is (opening, closing, or a line's running balance with the line id) and an optional `SourceSpan { line, start, end }` (Agent 2 fills spans in from the parsers; define the type here and have core take it as plain data). Build the list from the stored statements and lines, in date order, and say in a doc comment how an opening balance (start of its date) and a closing balance or running balance (end of its date, after that line) are ordered against the ledger's lines on the same day.
2. The window. Given the checkpoints and the ledger's movements on the bank account, give the ledger balance at each checkpoint, the difference (ledger less stated) at each, and `Window { last_agrees: Option<usize>, first_differs: Option<usize>, difference: Money, shape: Jump | Constant | Drifting }`. Constant: the difference is the same from the first checkpoint on. Jump: it's zero, then one value from first_differs on. Drifting: anything else. No difference at all gives `first_differs: None`.
3. Move the arithmetic in crates/server/src/reconcile.rs (matching lines to journals, unexplained, the status) into core. The server keeps loading the data, access checks and the endpoint. The existing m15_reconcile tests must pass unchanged; the TS type of YearReconciliation must not change (run `make types` and check the diff is empty).
4. finding.rs: define only the types the suspects and the combiner will share, so Waves 2 and 3 can start against them: `Finding { kind: FindingKind, explains: Money, confidence: Likely | Possible, evidence: Vec<EvidenceRef>, fix: Option<SuggestedFix> }`, `EvidenceRef` (bank line, journal, statement or gap, by id), `SuggestedFix` as an enum of command kinds with their payloads (start with MarkDuplicate { bank_line_id }, UnmarkDuplicate { bank_line_id }, SetOpeningBalance { bank_account_id, date, amount }, UploadMissing { bank_account_id, start, end }, RemoveStatement { statement_id }), and `FindingKind` with one variant per suspect in PLAN.md's list. Derive Serialize and TS on all of it. No logic.
Tests: unit tests for each shape, and a property test (proptest, already a dev-dependency? check; if not, explain the addition in your report) that one injected fault (a missing line, a doubled line, a changed amount) always falls between last_agrees and first_differs.
Run cargo test, clippy -D warnings and fmt.
Don't commit.
```

### Agent 2: keep the original file, and where each balance came from
```
Read CLAUDE.md, PLAN.md (M18 Agent 2), crates/store/migrations/0004_bank.sql, crates/store/src/bank.rs, crates/import/src/bank/ (mod.rs, ofx.rs, qif.rs, kowhai.rs, pohutukawa.rs, and the other CSV parsers), the import_statement command in crates/server/src/business.rs, and crates/server/src/access.rs.
You own:
- crates/store/migrations/0012_statement_files.sql (new) and its repository functions in crates/store/src/bank.rs
- the span-recording code in each parser in crates/import/src/bank/
- a `span: Option<SourceSpan>` field on Balance and on StatementLine's running balance in crates/import/src/bank/mod.rs (append-only; use the SourceSpan type Agent 1 puts in acct_core::reconcile if acct-import already depends on core, else define it in acct-import and say so in your report so Agent 1 can take it as plain data)
- the storing of the file in import_statement (the part after the lines are stored; don't change how lines are matched or posted)
- a new crates/server/src/statement_files.rs with `GET /api/statements/{id}/excerpt`, plus its route line in crates/server/src/lib.rs (append-only)
Task:
1. Migration 0012: `statement_files (statement_id PRIMARY KEY REFERENCES statements(id), sha256 TEXT NOT NULL, media_type TEXT NOT NULL, bytes BLOB NOT NULL)` and a `balance_spans` store for where each stated balance came from (statement id, kind, line id or null, line, start, end). Uploading the same file again (same sha256 on the same bank account) stores nothing new. It's written inside import_statement's transaction, so it's part of the command (hard rule 6); the bytes aren't copied into command_log (record the sha256 there instead, and check M13's history text still reads well).
2. Spans. Each parser records the source span (1-based line, byte start and end within that line) of every balance it reads: OFX <LEDGERBAL> (<BALAMT>, and <DTASOF> for the date), <AVAILBAL> is ignored; the QIF opening-balance entry; a CSV's "Opening balance"/"Closing balance" rows and each running-balance cell. Test each parser's spans against the fixtures in fixtures/bank-statements/.
3. Excerpt: `GET /api/statements/{id}/excerpt?kind=closing` (or `&line=<bank_line_id>` for a running balance) returns `{ file_name, sha256, media_type, lines: [{ number, text }], highlight: { line, start, end } }`: three lines either side of the span, decoded as the parser decoded the file. Same access check as reading the statement. A statement with no stored file returns `{ kept: false, ... }` with the stored figure, not a 404.
4. Add the retention question to docs/security.md under the data section as Open, pointing at NON-CODE-TODOS.md.
Run `make check`.
Don't commit.
```

### Agent 7a: the fixtures
```
Read CLAUDE.md, PLAN.md (M18, especially Agent 4's list of suspects and the "Done when"), fixtures/bank-statements/README.md and the files beside it, and crates/server/tests/m10.rs (how a test sets up a business and uploads statements).
You own:
- fixtures/reconcile/ (new)
Task:
1. A clean set: a synthetic sole trader with one cheque account and one credit card, a year to 31 March 2026, statements in OFX, QIF and one CSV format, with opening, closing and (in the CSV) running balances. They reconcile at every checkpoint and at 31 March. Use the existing fictional banks (Harbourlight, Kowhai, Pohutukawa, Rimu); no real names, account numbers or merchants that identify anyone.
2. One variant directory per suspect in PLAN.md's list (01-duplicates … 10-transposed), each the clean set plus exactly one fault, with a `fault.toml` saying: which suspect, the expected difference in cents, the expected window (dates), the evidence (which file and row), and the fix that clears it. Where a fault needs a person's action rather than a file (a wrong opening balance typed in, a line wrongly marked duplicate, a hand journal), describe the commands to replay in fault.toml instead of changing files.
3. Duplicates needs at least: the same download uploaded under two names with different description formatting (OFX NAME vs MEMO), and an overlap where one file uses the posting date and the other the transaction date. Also include a pair of identical purchases on one day that are NOT duplicates, which must not be flagged as Likely.
4. 11-two-faults: a duplicate and a wrong opening balance together, with both amounts in fault.toml.
5. A README.md: what each fixture is, the clean totals, and a table of faults with their amounts.
Check every clean file passes `Statement::balance_check` by adding a small test in crates/import/tests/ (a new file you own, reconcile_fixtures.rs) that reads each one.
Don't commit.
```

## Wave 2: after Wave 1 has landed

### Agent 3: check on upload, and the proof card
```
Read CLAUDE.md, apps/web/src/ui/README.md, PLAN.md (M18 Agent 3), acct_core::reconcile (Agent 1), crates/server/src/statement_files.rs (Agent 2), the import_statement command in crates/server/src/business.rs, apps/web/src/pages/BusinessPage.tsx (the upload) and apps/web/src/pages/ReconcileTab.tsx.
You own:
- the result type of import_statement and the read-only reconciliation step after apply in crates/server/src/business.rs
- apps/web/src/components/BankVsBooks/ (new: the modal, the two cutouts, the print stylesheet, tests)
- the lines in BusinessPage.tsx and ReconcileTab.tsx that open it
- new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. After import_statement applies, inside the same transaction and without writing anything, work out the account's checkpoints and window (acct_core::reconcile) at the statement's closing date, and at 31 March when the statement spans it, and return them in the command's result. At 31 March use: a statement ending that day; else a running balance at the end of that day; else the nearest checkpoint before it, labelled "nearest balance your bank gave: 28 Mar". Add `GET /api/bank-accounts/{id}/proof?date=` returning the same, for opening the card later.
2. The Bank vs books modal: left cutout "Your bank's file says" (the excerpt, monospace, the balance highlighted, file name, date, the first 12 characters of the sha256); right cutout "Your books say" (the ledger balance on the bank account at the end of that date, with the last five lines before it). Between them "Agrees" or "Out by $412.50", with Icon slots for the tick and the warning, and a link to the findings that does nothing until Agent 6 (leave a clearly named prop for it). Side by side above 720px, stacked below. Cards say "you owe $1,087.55" on both sides. A statement uploaded before M18 shows "Original file not kept" in the left cutout with the stored figure.
3. Print: a Print button and an @media print stylesheet that gives one A4 page with the business name, the account, the date, when it was printed and who printed it, and hides the app's chrome. No emoji in what prints: Icons are aria-hidden and hidden in print.
4. It opens automatically after each upload (one per account the upload touched) and from each bank account and each row of the Reconcile tab.
Money only through apps/web/src/lib/money.ts; colours only from tokens. Testing Library tests for: agrees, out by, card wording, no file kept, and that the print header is present.
Run `make check`.
Don't commit.
```

### Agent 4: the suspects (core, pure)
```
Read CLAUDE.md, PLAN.md (M18 Agent 4, the list of suspects), acct_core::reconcile (checkpoints.rs, finding.rs from Agent 1), crates/core/src/bank.rs, crates/import/src/bank/mod.rs (duplicate_keys) and fixtures/reconcile/ (Agent 7a's fixtures and their fault.toml files).
You own:
- crates/core/src/reconcile/suspects/ (new: mod.rs with the Suspect trait and the registry, and one file per suspect)
- additions to FindingKind or SuggestedFix in finding.rs if a suspect needs one (append-only; say why in your report)
Task:
1. `trait Suspect { fn kind(&self) -> FindingKind; fn look(&self, input: &SuspectInput) -> Vec<Finding>; }`. SuspectInput holds the window, the checkpoints, the bank lines (with statement id, bank transaction id where the file had one, posting date, amount, description, the M10 possible_duplicate flag and the owner's duplicate marks), the journals on the bank account, the statements (period, account number, opening and closing) and the gaps. Everything as plain data; no store types.
2. One module per suspect in PLAN.md's order. Each looks inside the window only (except Wrong opening balance, which needs a Constant shape, and Wrong account, which looks at other accounts' files: take those as an optional extra input). Each sets `explains` to the signed amount it would change the difference by if its fix were applied, and Likely only when the evidence is strong (spell out the rule in each module's doc comment). The "within 3 days" thresholds are constants in one place, marked as waiting on the NON-CODE-TODOS decision.
3. Duplicates: never Likely for two identical lines in the same file on the same day (that's two real purchases; M10 keeps both). Same bank transaction id in two files is always Likely.
4. `fn all_suspects() -> Vec<Box<dyn Suspect>>` in a fixed order, and `fn look_all(input) -> Vec<Finding>` sorted deterministically (by kind order, then evidence ids).
Tests: for each fixture in fixtures/reconcile/, its suspect finds the fault with the exact amount and Likely, and on the clean set no suspect returns anything Likely. Load the fixtures through acct-import in a test-only helper, since core can't read files: put those tests in crates/import/tests/reconcile_suspects.rs (yours).
Run cargo test, clippy -D warnings and fmt.
Don't commit.
```

## Wave 3: after Agent 4 has landed (5 and 8 at once)

### Agent 5: explain the whole difference (core, pure)
```
Read CLAUDE.md, PLAN.md (M18 Agent 5), crates/core/src/reconcile/ (all of it) and fixtures/reconcile/README.md.
You own:
- crates/core/src/reconcile/diagnose.rs (new)
- crates/import/tests/reconcile_suspects.rs (add the combined-fault tests; Agent 4 is finished)
Task:
1. `fn diagnose(window: &Window, findings: Vec<Finding>) -> Diagnosis`, with `Diagnosis { difference, explained_by: Vec<Finding>, remainder: Money, other_findings: Vec<Finding> }`.
2. The smallest set of findings whose `explains` add up exactly to the difference. Findings with the same evidence can't both be used (two suspects pointing at one line). Search exactly over at most 20 findings, Likely first; with more, keep the 20 that are Likely and largest, and say so in a doc comment. Ties: more Likely findings win, then fewer findings, then the deterministic order from look_all.
3. No exact set: take Likely findings largest first while they bring the difference closer to zero, and report the remainder.
4. A difference of zero gives an empty diagnosis even if suspects found something (they go into other_findings).
Tests: each single-fault fixture is explained exactly by its one finding; 11-two-faults is explained exactly by its two; the clean set gives an empty diagnosis; a property test that diagnose never returns a set whose sum isn't difference − remainder.
Run cargo test, clippy -D warnings and fmt.
Don't commit.
```

### Agent 8: the books the suspects see are the books the app has
```
Read CLAUDE.md, PLAN.md (M18), crates/core/src/reconcile/ (checkpoints.rs, suspects/mod.rs and its module docs), crates/server/src/reconcile.rs, crates/server/src/business.rs (coverage, import_statement, regenerate_gaps, account_gaps), crates/server/src/statement_files.rs, crates/store/src/bank.rs (statements, bank_lines, balance_spans), the duplicate answers in crates/server/src/save_tax.rs (resolve_duplicate) and its coding store, fixtures/reconcile/ (generate.py, README.md), and crates/import/tests/reconcile_suspects.rs, which builds the books for the suspects the way this agent must make the server do.
You own:
- the loading in crates/server/src/reconcile.rs (statement_facts, line_facts and a new suspect_input)
- new fields on StatementFacts in crates/core/src/reconcile/checkpoints.rs, and every place that builds one (Agent 3's proof code included: change only the constructor)
- fixtures/reconcile/generate.py and the files it writes (run it; never hand-edit them)
- in crates/import/tests/reconcile_suspects.rs, only the 04 exception and Agent 5's 01b exception (in each_difference_is_explained_by_its_faults; re-read the file just before editing)
- crates/server/tests/m18_suspect_input.rs (new)
Task:
1. Checkpoints only from balances the bank states, on the date it states them. Today import_statement stores the statement's coverage (start = the earlier of the period start and the first line, end = the later of the period end and the last line) and a worked-out opening and closing when the file doesn't state one, and statement_facts passes those to core as if the bank stated them. So in fixture 07 the OFX LEDGERBAL dated 31 Mar becomes a closing balance on 1 Apr, which includes the 1 Apr line, and the cut-off disappears; and an OFX or QIF file gets checkpoints the bank never gave. Give StatementFacts the stated opening and closing with their own dates, kept apart from the coverage (gaps still use the coverage), and make the checkpoints use them. Check whether Agent 2's balance_spans or the kept file already holds what you need. If it needs a new column or table, that's migration 0013: stop and ask first. Say in docs/domain.md what a statement uploaded before M18 (no file kept) gets.
2. Gap journals (fixture 02). When no statement covers some days and the balances either side are known, the server posts a gap journal for the change, so the books agree with the bank and the missing-lines suspect never sees a difference. The fixtures assume no gap journal. This is a presentation question: ask the user before building, then record the answer in docs/domain.md. The options as Agent 4 saw them:
   a. Keep gap journals in the walk. The proof card says "Agrees", with a note under it: "No statement for 1 Aug to 31 Aug. We put the change, $419.18, in as one entry." The note offers the missing-lines fix (UploadMissing). Missing lines gets the gap as a finding that explains nothing (zero), shown as a note, not an explanation. Change fixture 02 so its expected difference is zero, and give its fault.toml a `note` instead of a fault.
   b. Leave gap journals out of the walk, so the card says "Out by $419.18" and missing lines explains it. The card and the ledger then disagree about the balance, which needs explaining on the card.
   Build whichever the user picks, through generate.py and the suspects (Agent 4 is finished: you may change suspects/missing_lines.rs for this).
3. Fixture 04's window. Core keeps a running balance only when the file confirms it's the end of its day (checkpoints.rs, module docs). The swapped November file's running balances don't follow from its amounts, so core keeps only the last, and sees one jump at 28 Nov. generate.py keeps them all and expects a drift from 3 Nov. Core is right: make generate.py apply the same rule, regenerate, and remove the 04 exception from reconcile_suspects.rs.
4. While regenerating: 01b's fault.toml fix should be the one the suspect suggests, `RemoveStatement` of the activity file (the whole file is duplicates), not two MarkDuplicates. Then remove the 01b exception Agent 5 left in reconcile_suspects.rs, so 01b is checked against its fault.toml like every other fixture. Check every fault.toml's `fix` against what the suspect suggests in reconcile_suspects.rs, and say in the README which fixes need Agent 6's new commands.
5. suspect_input. `pub async fn suspect_input(conn, client_id, bank_account_id) -> Result<SuspectInput, _>` in crates/server/src/reconcile.rs: the server's side of what reconcile_suspects.rs's test builds. Lines with their bank id, M10's possible_duplicate flag and the owner's answer; the live journals on the account with their origin (opening, bank line, gap, by hand); the statements with their stated balances and account number; where each kept file's own balances break (re-read it with read_statement and balance_check, and find the stored line for a row by its duplicate key: date, amount, description, occurrence; a file not kept gives None); the gaps; and the other accounts' statements with their nets. Read only.
Tests (m18_suspect_input.rs): upload the clean set and fixtures 02, 04, 07 and 11 through the command pipeline (replaying their fault.toml commands), call suspect_input, and check look_all finds what reconcile_suspects.rs finds for them: nothing on the clean set, each fault Likely with its exact amount. If Agent 7b's m18.rs exists by then, share its fixture loader rather than writing a second one.
Run `make check`.
Don't commit.
```

## Wave 4: after Agents 5 and 8 have landed

### Agent 6: tell the owner, with fixes
```
Read CLAUDE.md, apps/web/src/ui/README.md, PLAN.md (M18 Agent 6), acct_core::reconcile (diagnose.rs, finding.rs, and the module docs of each file in suspects/: they say which fix each finding suggests, and when there's none), Agent 8's suspect_input in crates/server/src/reconcile.rs, Agent 3's apps/web/src/components/BankVsBooks/ and its proof endpoint, crates/server/src/commands.rs (code_bank_line, set_opening_balance, reverse_journal, resolve_duplicate), crates/server/src/history.rs, and the M11 Save tax queue (grep "detected" in crates/server and apps/web).
You own:
- the diagnosis in the import_statement result and the proof endpoint (crates/server/src/business.rs, the part Agent 3 added)
- apps/web/src/components/BankVsBooks/Findings*.tsx (new) and the prop Agent 3 left for it
- a new `remove_statement` command (reverse its lines' journals in one command; history text and tests per M13), in crates/server/src/commands.rs (append-only) and history.rs. Duplicates (a whole file uploaded twice: fixtures 01a, 01b), Sign the wrong way (04) and Wrong account (08) all suggest it.
- whatever lets the owner correct an opening balance (see 6), in commands.rs (append-only), history.rs and the business code behind set_opening_balance
- the lines that add findings to the Save tax queue and to ReconcileTab.tsx
Task:
1. Return the Diagnosis alongside the window wherever Agent 3 returns the window. Build the suspects' input with Agent 8's suspect_input; don't load it a second way.
2. In the modal when out: the best explanation first, in plain English, one template per FindingKind (for example "These 3 lines look like they were uploaded twice. Removing them makes your books agree."), naming the lines with date, description and amount. A Fix it button per explained finding: it previews the balance afterwards (work it out from the finding's amount; don't send anything), and only on confirm sends the fix's command. Fixing the whole explanation is one button that sends each command in turn and stops at the first refusal.
3. Other findings in an expandable list, each linking to its lines in the statement view.
4. Nothing explains it: "We couldn't work out why. Between 3 Feb and 28 Feb your books and your bank go out by $412.50." and, for an owner with a linked accountant, Ask your accountant (whatever M12's invite link offers today; if there's no message channel yet, add it to PLAN.md's Backlog instead of building one).
5. Findings appear in M11's Save tax queue as detected items and on the Reconcile tab. A command sent from a finding carries `from_finding: <FindingKind>` in its payload so M13's history says "fixed from a reconciliation finding"; the server ignores it for anything else and validates the command as usual.
6. Make every suggested fix sendable. Agent 4 found these won't go through as things stand:
   - SetOpeningBalance (Wrong opening balance, Transposed digits; fixtures 03, 10, 11): set_opening_balance can be set only once, and every one of these accounts already has an opening balance. Let the owner correct it: reverse the opening journal and post the new one in one command, open years only, refused on a finalised year, with M13 history text ("changed the opening balance from $3,000.00 to $3,264.85"). Extend set_opening_balance or add a command; say which in your report. If it touches a public type, propose it first.
   - MarkDuplicate: resolve_duplicate refuses a line M10 didn't flag, so the suspect only suggests it for flagged lines. For an unflagged duplicate (fix: None) say what to do instead.
   - ReverseJournal (Entries by hand, fixture 06): send reverse_journal with the journal's id.
   - RemoveStatement for Sign the wrong way (04): after removing the file, tell the owner to upload it again. If the parser reads it the same wrong way, that's Amount read wrong's "log it for us" case below.
7. Findings with no fix (Date cut-off 07, Amount read wrong 09, one line with its sign the wrong way, an unflagged duplicate): no Fix it button. Say plainly what happened and who can fix it (the accountant: a journal, or accept it as a timing difference). For Amount read wrong, the server logs the parser id and the file's row for us, and never the content (no amounts, descriptions or account numbers); add a test that the log line holds none of them.
Testing Library tests for each FindingKind's text, the preview, the confirm, and a finding with no fix; server tests for remove_statement and the opening balance correction, each with its rejection on a finalised year.
Run `make check`.
Don't commit.
```

### Agent 7b: the done check (Sonnet, medium thinking)
```
Read CLAUDE.md, PLAN.md (M18 "Done when"), fixtures/reconcile/ (README.md and every fault.toml, as Agent 8 regenerated them, and the gap-journal decision in docs/domain.md), crates/server/tests/m10.rs, and Agent 8's crates/server/tests/m18_suspect_input.rs (reuse its fixture loader).
You own:
- crates/server/tests/m18.rs (new)
Task: `m18_is_done`. For every fixture in fixtures/reconcile/: set up the business, upload its files (and replay any commands in fault.toml) through the command pipeline, and check the import result carries a proof with an excerpt from the uploaded file. The clean set agrees at every closing date and at 31 March. Each single-fault fixture's diagnosis names the fault from fault.toml as the first explanation with the exact amount, and its window is the one fault.toml expects; sending its suggested fix makes the proof agree. 11-two-faults is explained in full with remainder zero. Re-uploading any file stores no second copy.
Some fixtures need more than one step:
- A fix may be several commands (04: remove the statement, then upload the clean file named in fault.toml). Send them in order.
- Faults with no fix (fix = [], 07 and 09): check the diagnosis names them, and that the finding carries no fix, rather than that a fix makes the proof agree.
- 02: check whatever the gap-journal decision in docs/domain.md says the card shows (a note with the upload fix, or a difference explained by missing lines), and that uploading the missing statement leaves no gap journal live.
- 03, 10 and 11 correct an opening balance that's already set, with Agent 6's command.
If any of these fails because the server and the fixtures still build different books, don't loosen the test: report which fixture and why.
Run `make check`.
Don't commit.
```

## When all of them are done

Check `make check` passes, then by hand in a browser: upload the clean set and one fault fixture, open Bank vs books, print it to PDF and check it's one A4 page with both cutouts readable, and fix the fault from the card. Tick M18's status in PLAN.md and add the browser check to NON-CODE-TODOS.md if it's left for later.

Note: M17-PROMPTS.md (OFX parser fixes) refuses truncated OFX files. M18's "Missing lines" suspect still covers cut-short QIF and CSV files, which M17 only reports on.
