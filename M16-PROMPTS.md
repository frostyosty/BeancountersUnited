# M16 agent prompts

M16 splits into two waves, plus work on the office machine.
- **Wave 1:** four agents work at once. Two of them write parsers, one writes an ADR, and one does the MYOB Classic spike, which runs on the office machine.
- **Wave 2:** the agents that import parsed history into the books and build the screen for it.
- **The Classic tools:** they wait for the spike.

Each prompt says which files that agent owns. Shared files (`App.tsx`, `icons/registry.json`, `crates/import/src/lib.rs`) are append-only: re-read just before editing, and add only your own lines.

**Migrations:** take the next free number in `crates/store/migrations/` when you start, and create the file straight away (even empty) so other agents see the number is taken.

**Hard rule 1 applies everywhere:** every Xero, MYOB and Classic fixture is synthetic, made up by hand or by a script, never an export of a real client trimmed down. Only the Classic agents run on the office machine, and they write only to gitignored paths (`tools/**/out/`).

## Wave 1: start all four now

### Agent 1: Xero export parsers, and the shared history types
```
Read CLAUDE.md, PLAN.md's M16 section, crates/import/src/tb.rs, crates/import/src/lib.rs and fixtures/README.md. Look up Xero's documented export formats for the chart of accounts, trial balance, general ledger detail (Account Transactions) and contacts, and cite the pages.
You own:
- a new crates/import/src/history.rs: the shared, source-neutral shape every importer produces (accounts with their code, name, type and tax default; TB rows per balance date; GL lines; contacts). Agent 2 uses it too: settle it with them early (ListAgents / SendMessage), and keep it small.
- a new crates/import/src/xero/** (plus `pub mod` lines in crates/import/src/lib.rs)
- new synthetic fixtures in fixtures/xero/, plus a README there
- a new "Importing from Xero and MYOB" section in docs/domain.md (shared with Agent 2: you write the Xero part)
Task:
1. Parse each Xero export into history.rs's types. Detect which export a file is by inspecting it. Money is parsed into integer cents, never floats (hard rule 4). Reject what you can't read with the row and the reason.
2. Synthetic fixtures for a made-up sole trader over two years. The TB totals must match the GL detail, so Agent 5 can check it.
3. Tests: detection, each parser, money parsing edge cases (negatives in brackets, thousands separators), and that the GL detail sums to the TB.
Don't commit. Before you finish, run cargo fmt, clippy -D warnings and the tests for acct-import.
```

### Agent 2: MYOB export parsers (AccountRight / MYOB Business)
```
Read CLAUDE.md, PLAN.md's M16 section, crates/import/src/tb.rs and fixtures/README.md. Look up MYOB AccountRight's and MYOB Business's documented export formats for the chart (accounts list), trial balance, general ledger detail and contacts (cards), and cite the pages. This isn't MYOB AO Classic; that's Agent 4 and the office machine.
You own:
- a new crates/import/src/myob/** (plus `pub mod` lines in crates/import/src/lib.rs)
- new synthetic fixtures in fixtures/myob/, plus a README there
- the MYOB part of the "Importing from Xero and MYOB" section in docs/domain.md
Agent 1 owns crates/import/src/history.rs, the shared shape you parse into. Message them early to agree on it; don't edit it yourself.
Task:
1. Parse each MYOB export into history.rs's types, detecting the export by inspecting the file. Money in integer cents. Reject unreadable rows with the row and the reason.
2. Synthetic fixtures for the same kind of made-up sole trader over two years, with TB totals that match the GL detail.
3. Tests as Agent 1's: detection, each parser, money edge cases, and that the GL detail sums to the TB.
Hard rule 3: borrow formats only; don't copy MYOB's sample files or wording.
Don't commit. Before you finish, run cargo fmt, clippy -D warnings and the tests for acct-import.
```

### Agent 3: ADR 011, pulling history through Xero's API (doc only)
```
Read CLAUDE.md (Architecture: Outside services), ADR 007 and ADR 009 (for the shape of an integration ADR), and PLAN.md's M16 section.
Write docs/decisions/011-xero-api.md. Research and cite:
- Xero's developer terms: whether an app like ours may pull a connected organisation's chart, journals and contacts, any certification needed, and rate limits
- pricing for the API at our scale (say 100 and 1,000 connected organisations)
- OAuth 2.0: what we store (encrypted tokens), and that we never see Xero passwords
- what we'd pull and how it maps onto crates/import/src/history.rs (Agent 1's shared types)
- the crate boundary: its own crate behind a trait, with a fake for tests and no network in tests (ADR 007)
Recommend whether to build it now or leave it as a later option, and say why. Ask me before settling. Only edit that ADR file. Don't write code. Don't commit.
```

### Agent 4: MYOB AO Classic spike (office machine only)
Run this session on the office machine, not in a Codespace, from a clone of the repo.
```
Read CLAUDE.md (especially hard rules 1 and 3) and PLAN.md's M16 section.
You're on the office machine, where MYOB AO Classic's data lives under C:\MYOBAO\DATA. You must not copy any client data into the repo, its history, or this chat: no names, numbers, amounts or file contents. Only describe structure.
You own a new "MYOB AO Classic data structure" section in docs/domain.md, and anything you write under tools/classic-import/out/ (gitignored). Don't edit anything else.
Task:
1. Find out how Classic stores its data: FoxPro .dbf files, SQL Server, or both. List the files or tables that hold the chart, the client list, client-years, the TB or journals, and the asset register.
2. For each, record the structure only: table or file name, field names, types and widths, keys, and how one relates to another (e.g. how a client-year is identified). Never sample values.
3. Say which fields our import formats need (chart CSV, TB CSV, asset register CSV) and where each comes from.
4. Open everything read-only. If something can only be opened read-write, stop and ask me.
Before you finish, run `git status` and `git diff`, and confirm to me that only docs/domain.md changed and that it holds no client data. Don't commit.
```

## Wave 2: once wave 1 is in

### Agent 5: importing history into the books
Start once Agent 1's history.rs and at least one parser are in.
```
Read CLAUDE.md (Domain invariants: Books source, TB import, Comparatives, Defaults never reach back; Hard rule 6), PLAN.md's M16 section, crates/import/src/history.rs, crates/server/src/tb_import.rs, crates/server/src/pipeline.rs and commands.rs, and docs/domain.md's "Importing from Xero and MYOB" section.
You own:
- a new crates/core/src/history_import.rs (plus `pub mod` in core's lib.rs): the pure account-mapping proposal and the preview
- a new crates/server/src/history_import.rs, its routes in crates/server/src/lib.rs, your own variants appended to commands.rs and arms to pipeline.rs (keep each arm a one-line call into history_import.rs)
- a new migration if you need one
- a new crates/server/tests/m16.rs
Task:
1. Map their accounts onto ours: propose a mapping (by code range, type and name), show it as a preview, and let the user change it. Every account with a balance must map; unmapped ones are errors shown to the user, never dropped.
2. Commands: import the mapped chart changes, the TB for each year through the existing TB import path, and earlier years as comparatives. The books-source rule holds: a year whose books come from bank coding refuses a TB import, with a plain reason.
3. Ask me what contacts are for before storing them; we don't have contacts in the domain yet.
4. tests/m16.rs, m16_is_done: Agent 1's synthetic Xero export imports to a TB that matches the export's totals, with the prior year as comparatives. Add the same for Agent 2's MYOB fixtures, and rejection tests for each command.
Don't commit. Before you finish, run make check (vitest via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...`) and regenerate the types.
```

### Agent 6: import screen (web)
Start once Agent 5 has generated its types into packages/types.
```
Read CLAUDE.md (Web, Icons and emoji), apps/web/src/pages/TbImportTab.tsx and its test, apps/web/src/lib/files.ts, and the history-import types in packages/types.
You own a new apps/web/src/pages/HistoryImport*.tsx (+ tests and CSS module), its route in App.tsx, its link wherever a client's years are listed, and the client.import* slots in icons/registry.json.
Task:
1. Upload the exports (several files at once), show what was detected in each, and the problems row by row.
2. The mapping preview: their account against ours, with changes allowed and unmapped accounts shown as errors.
3. Confirm, then show the years imported and a link to each year's TB.
Plain English, with <Icon> slots. Run vitest and tsc via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...`. Don't commit.
```

### Agent 7: Classic extractor and oracle
Start once Agent 4's structure section is in. Write the code in a Codespace against synthetic files, then run it on the office machine.
```
Read CLAUDE.md (hard rules 1 and 3), PLAN.md's M16 section, docs/domain.md's "MYOB AO Classic data structure", and crates/import/src/tb.rs plus the asset register import format.
You own tools/classic-import/** and tools/oracle/** (their outputs go only to their gitignored out/ folders), and synthetic Classic-shaped test files under tools/classic-import/testdata/ that you build by script from the documented structure.
Task:
1. tools/classic-import: a read-only extractor that writes our own import formats: chart CSV, TB CSV per client-year, asset register CSV. It never writes to our database, and it never writes outside out/.
2. tools/oracle: compares our TB and statement totals for a client-year with Classic's exported reports, and writes a diff report to out/.
3. Tests run only against the synthetic testdata.
4. Write the steps for running both on the office machine in each tool's README.
When you add a dependency (e.g. a .dbf reader), give the reason in your final message so it goes in the commit. Don't commit.
```

## Done check
Run by me:
- Agent 5's m16_is_done passes.
- On the office machine, the chosen Classic client-years go through the extractor and our import, and the oracle shows they match to the dollar. Any difference is explained in docs/domain.md, describing the cause without client data.

## Notes
- **Shared files:** agents 1 and 2 both write the "Importing from Xero and MYOB" section of docs/domain.md, each only its own part. Agent 1 owns history.rs; Agent 2 asks for changes.
- **Agents 3, 4 and 5 will ask you things:** whether to build the Xero API now (3), anything that can't be opened read-only (4), and what contacts are for (5).
- **The order that matters:** Agent 5 needs Agent 1's history.rs. Agent 6 needs Agent 5. Agent 7 needs Agent 4's structure notes.
- **Not committed yet:** quicksave before starting wave 1, so each agent's work shows up as its own diff.
