# M28: Contacts and open items: aged receivables and payables

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M28 takes the next free
ADR and migration numbers (check). **It needs M26 first** (its `ReportTable`, and snapshots that carry schedules).
It doesn't depend on M27 and can run alongside it.

## The milestone
Status: not started. Planned 2026-11-10. Presentation choices are marked **DECISION FOR ME** and are answered before
code starts (CLAUDE.md: ask, then record in `docs/domain.md`).

**Why.** The ledger knows that accounts receivable (610) holds $18,400, not who owes it or for how long. Accountants
ask "who owes us and for how long?" at every year-end, for bad-debt review, for the notes, and because clients ask.
Aged receivables and aged payables reports answer that, and AO-style practices expect them.

**What exists today:**
- Accounts 610 (receivables) and 800 (payables) are in the charts, "unused until invoice basis" for sole traders
  (docs/domain.md). Bank-coded books (owners using Save tax) never have receivables or payables, so for them this
  milestone shows nothing. It serves accountants working from a TB import or a Xero or MYOB history.
- Journal lines carry no party: `(account, amount)` only, and journals never change once posted. Contacts exist only
  inside the import parsers (`crates/import/src/xero/contacts.rs`, `myob/contacts.rs`) and aren't stored.
- Sales invoicing doesn't exist (backlog); the invoice maker (`crates/server/src/invoices.rs`) is a free extra outside
  the books and must stay that way. M23's bills are supplier documents for GST checks, not payables.
- M26's `ReportTable`, and finalisation snapshots that store the ReportDoc and its hash.

**1. A sub-register beside the ledger, not inside it.** Parties on journal lines would change the most guarded type
here (journals are immutable, summed, snapshotted and tested everywhere). Instead a client-year keeps **open items**
that explain a control account's balance, and the ledger is never touched by them.
- A **contact**: name, kind (customer, supplier or both) and payment terms in days. Per client.
- An **open item**: contact, control account (an account code), document reference, issue date, due date and an
  amount in cents. An invoice is positive and a credit note negative, in the control account's own sign.
- An **application**: a payment or credit note applied to an item, with its date and amount in cents.
- Outstanding at a date = amount less applications dated on or before it. So any as-at date works, including a year
  end that's long gone, which is what makes the ageing honest.
- **DECISION FOR ME: how much history.** (a) Items with applications, as above (any as-at date). (b) A simple listing
  as at the balance date only, one outstanding amount per item (cheaper, matches a pasted aged report, but can't
  show last year's ageing or a date mid-year). Recommended: (a).

**2. Which accounts are control accounts.** A flag on the chart account (receivables or payables), copied from the
practice master chart like any chart setting, so existing clients' charts only change by the explicit push (Defaults
never reach back). Only flagged accounts accept items.

**3. Agreeing to the ledger.** At a date, the outstanding items on a control account should equal its ledger balance.
Core computes the difference and shows it as "not agreed to the ledger", never hides it. The check at finalising is a
warning the accountant can accept (like the other pre-checks that accept an explanation), and only for clients that
keep a listing (a client with no items isn't asked). With a TB import the ledger has one journal at the year end, so
the agreement is only meaningful at the balance date.

**4. Ageing.** Buckets are current, then one, two and three months overdue, and older. **DECISION FOR ME.**
- By what: days past the **due date** (recommended; the usual convention) or the issue date.
- Bucket edges: calendar months or 30-day steps. Recommended: whole months past due, our own labels.
- Items with no due date use the issue date plus the contact's terms.
- Amounts show in cents (recommended), not whole dollars like the statements: these are workpapers that must tie to
  the ledger to the cent. Say so in `docs/domain.md`.

**5. The reports.** *Aged receivables* and *aged payables*, each by contact with a column per bucket and a total, with
drill-down from a contact to its items and from an item to its applications. Built in core as M26's `ReportTable`,
with the agreement to the ledger as its last row. As at the year end they join the finalisation snapshot, so a
finalised year's listing never changes.

**6. Getting items in.**
- Add, edit and remove by hand, each a command.
- **CSV import in our own format** (contact, reference, issue date, due date, amount, outstanding), previewed before
  it's applied. An import replaces the listing for one control account and year in one command and leaves other
  accounts alone, as TB import does; re-importing an identical file changes nothing. Our format is documented in
  `docs/domain.md`.
- Reading Xero's and MYOB's own aged-report exports is M16's territory; this milestone leaves a note there and the
  CSV format is the target for it.

**7. Rules.** Every change is a command through the pipeline, so it's logged (hard rule 6). Items and applications are
rejected for a finalised year; an application can't pay more than the item's amount (stated, with a plain reason);
dates fall in the year's range for items of that year. Staff and practice admins edit; viewers read; owners see none
of this in this milestone.

**Out.** Sales invoicing, invoice-basis GST (backlog: this register is what they'd feed, but don't scaffold it),
customer statements and payment reminders, email, allocating bank lines to invoices in Save tax, bad-debt write-off
journals (the accountant posts the journal as now), and foreign currency (Out in CLAUDE.md).

### Done when
`crates/core/tests/ageing.rs` and `crates/server/tests/m28.rs` (`m28_is_done`) show that:
- an invoice, a part payment and a credit note age correctly at a chosen date; an item paid after the as-at date is
  still open at it; an item fully applied before it is gone; every column foots to cents;
- the open items agree to the control account's ledger balance, and a deliberate gap shows as "not agreed" with its
  amount, and as a finalise warning that can be accepted;
- a CSV import previews, replaces one control account's listing, leaves others alone, and does nothing when repeated;
- none of these commands changes any journal or the TB (the ledger is byte-identical before and after);
- commands are rejected for a finalised year, for an unflagged account and for an over-application, each with a
  reason; a viewer can read and not write; an owner can't read;
- a finalised year's aged reports are frozen; a later contact rename doesn't change them;
- everything uses invented contacts (hard rule 1).

The web tests cover the contacts list, the items table, the import preview, and the report from a mocked ReportDoc.
Then a browser check.

## Running it

Six waves of small agents. Opus only writes the ADR.
- **Wave 1:** ADR. **Nothing in wave 2 starts until you've accepted it and answered its DECISIONS FOR ME.**
- **Wave 2:** two agents at once: core (items, ageing, agreement); and the fixtures with the hand-worked example.
- **Wave 3:** the store: migration, repositories.
- **Wave 4:** two agents at once: the server (commands, reads, finalise); and the CSV parser in `crates/import`.
- **Wave 5:** two agents at once: the web; and the PDF.
- **Wave 6:** the done check.

Shared files and rules are as in `M26-PROMPTS.md` ("Running it"). **Migration:** only Agent 4, with the next free
number: contacts, open items, applications, and the chart's control flag.

**Hard rules apply.** Money is integer cents (4); core is pure and byte-stable, with ageing computed from dates it's
given, never a clock (5); every change is a command (6); migrations are append-only (7); invented contacts only (1).

## Wave 1: start now

### Agent 1: the ADR (Opus, high thinking)
```
Read CLAUDE.md (Hard rules, Domain invariants, Commands, Roles), M28-PROMPTS.md (the milestone), M26-PROMPTS.md, the accepted M26 ADR, docs/decisions/003-reportdoc.md, 007-online-service.md and 017-invoice-scanner.md (so bills aren't confused with payables), docs/domain.md (Account codes, Sole-trader chart and template, Importing from Xero and MYOB, TB import and Books source sections, Tax invoices), crates/core/src/ledger.rs, chart.rs, finalise.rs, crates/import/src/xero/contacts.rs and myob/contacts.rs, crates/server/src/tb_import.rs and commands.rs (the pattern for a replace-by-import command).
You own:
- docs/decisions/NNN-open-items-and-ageing.md (new; NNN is the next free number)
- a new "Contacts, open items and ageing" section in docs/domain.md (decisions only, including our CSV format)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed. Mark each DECISION FOR ME in the milestone and don't decide it.
1. Why a sub-register and not parties on journal lines, in a paragraph, and the invariant that no command here touches a journal or the TB.
2. The data model: contacts, open items, applications, the chart's control flag; the keys, and what is practice data versus client data.
3. The commands (create_contact, update_contact, add_open_item, update_open_item, remove_open_item, apply_to_item, import_open_items, and any more), payloads, validation, how each reads in Changes, and the finalised-year rule.
4. The agreement to the ledger: its exact definition, its warning, and the finalise pre-check.
5. Ageing: the rule exactly (as at, buckets, the due-date fallback), with a worked example with numbers.
6. The report in M26's ReportTable, its drill-down, and its place in the snapshot.
7. The CSV format and the import's preview, replace and idempotence.
8. Access: who reads and writes; owners and guests see nothing.
9. What an Xero or MYOB aged-report import would need to map onto this, noted for M16 (not built here).
List the consequences, including migration, types and routes. Add what a person must do (an NZ accountant checks the ageing convention and the worked example) to NON-CODE-TODOS.md.
Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted the ADR (both at once)

### Agent 2: items, ageing and agreement (Sonnet, high thinking)
```
Read CLAUDE.md, M28-PROMPTS.md, the accepted ADR (follow it where it differs from the milestone), crates/core/src/table.rs, ledger.rs, chart.rs and crates/core/tests/ for the style.
You own:
- crates/core/src/openitems.rs (new): contacts, items, applications, validation, outstanding-at-a-date, ageing, agreement to a TB, the ReportTable builder; its lines in lib.rs
- the chart's control-account flag in chart.rs (serde default, so existing chart JSON is byte-identical)
- crates/core/tests/ageing.rs (new)
Task: pure code, no clock: the as-at date is always an input. Byte-stable, no HashMaps, cents only.
Tests: the ADR's worked example; proptest (applications never exceed an item, outstanding is monotone as applications are added, every column foots, the buckets partition the outstanding amount, the total is independent of the as-at bucket edges); the validation rules; the agreement difference.
Run `scripts/one-build.sh make check`. Don't update snapshots; if one moves, stop and tell me. Don't commit.
```

### Agent 3: fixtures and the worked example (Sonnet, medium thinking)
```
Read CLAUDE.md, M28-PROMPTS.md, the accepted ADR, docs/domain.md (the existing worked examples, for style), fixtures/README.md, fixtures/practice/company-chart.json and sole-trader-chart.json, fixtures/clients/example-widgets.json.
You own:
- the control flag on 610 and 800 in the master charts (new defaults only)
- fixtures/open-items/ (new): our CSV format's samples, including a bad file for each validation rule
- open items for example-widgets, loaded through commands (hard rule 6), agreeing to its ledger's 610 and 800 balances, with one deliberate gap in a second client
- a "Worked example: aged receivables" in docs/domain.md, hand-worked and cross-checked with a script that doesn't use acct-core ("Hand-checked by: (nobody yet)")
- crates/core/tests/ageing_worked.rs (new)
Task: invented contacts and amounts only (hard rule 1). Build the data, work the example, assert it.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 3: after Agents 2 and 3 have landed

### Agent 4: store (Sonnet, medium thinking)
```
Read CLAUDE.md, M28-PROMPTS.md, the accepted ADR (the data model), crates/store/src (an existing repository such as assets or paragraphs, and the migration list), crates/core/src/openitems.rs (Agent 2's).
You own:
- crates/store/migrations/NNNN_open_items.sql (new; the next free number, check) and crates/store/src/open_items.rs (new)
Task: tables for contacts, open items, applications and the chart's control flag; repositories using sqlx runtime queries (ADR 004), no `query!` macros. No reads or writes outside the command pipeline's transaction for writes (hard rule 6).
Tests: integration tests of each repository's SQL, against a temporary database.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 4: after Agent 4 has landed (both at once)

### Agent 5: the server (Sonnet, high thinking)
```
Read CLAUDE.md, M28-PROMPTS.md, the accepted ADR (the commands, the access rules), crates/server/src/commands.rs, pipeline.rs, access.rs, history.rs, impersonation.rs, finalise.rs, reports.rs, tb_import.rs, lib.rs, crates/store/src/open_items.rs, crates/server/tests/ and tests/common/mod.rs.
You own:
- crates/server/src/open_items.rs (new): the commands, the reads (contacts, items, aged reports as at a date) and their response types
- the lines for the new commands and routes in commands.rs, history.rs, impersonation.rs, lib.rs and access.rs (append-only)
- the finalise warning and the snapshot's schedule (finalise.rs, lines only)
- crates/server/tests/open_items.rs (new)
Task: each ADR command validates in core, applies and appends to command_log in one transaction (hard rule 6), and is rejected for a finalised year; the import previews and replaces one control account's listing; reads take the as-at date as a parameter (the server's clock decides "today" only for the default); owners and guests are refused.
Tests: each command and its rejection; the ledger and TB are byte-identical before and after every command; the finalise warning; the access rules.
Run `scripts/one-build.sh make check`, then `make types`. Don't commit.
```

### Agent 6: the CSV parser (Sonnet, medium thinking)
```
Read CLAUDE.md, M28-PROMPTS.md, the accepted ADR (the CSV format), crates/import/src (the TB importer and the bank CSV parsers for style and error reporting), fixtures/open-items/ (Agent 3's), and the core types in crates/core/src/openitems.rs.
You own:
- crates/import/src/open_items.rs (new) and its lines in lib.rs, and crates/import/tests/open_items.rs (new)
Task: parse our CSV into core's item types: integer cents only (hard rule 4), dates as NaiveDate, a line-numbered error for every bad row, a refusal for a file with any bad row (nothing partly imported), and stable output order. It does no IO beyond reading the bytes it's given.
Tests: every sample file, each bad file's exact error, and a round trip.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 5: after Agents 5 and 6 have landed (both at once)

### Agent 7: the web (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M28-PROMPTS.md, the accepted ADR, apps/web/src/components/ReportTable/ (M26's), the year layout (YearLayout.tsx) and an existing tab such as AssetsTab.tsx and its test, lib/money.ts, and the generated types.
You own:
- a new "Debtors and creditors" tab under apps/web/src/components/OpenItems/ (contacts, items, applications, the CSV import with its preview, the as-at date picker, the two aged reports through ReportTable, the agreement row), its mount in YearLayout.tsx and routes in App.tsx (lines only), and new slots in apps/web/src/icons/registry.json (append-only)
- Testing Library tests
Task: render what the server returns; no arithmetic. The not-agreed warning is plain and shows the difference. Finalised years are read-only with the reason. The tab is hidden from owners and guests.
Run `scripts/one-build.sh make check`. Don't commit.
```

### Agent 8: the PDF (Sonnet, low thinking)
```
Read CLAUDE.md, M28-PROMPTS.md, crates/pdf/src/lib.rs and its table module (M26's), crates/pdf/tests/render.rs.
You own:
- the aged reports' pages in crates/pdf (lines only) and their test
Task: render both reports after the statements via the generic table renderer, amounts in cents, the agreement row last. It does no arithmetic.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 6: after Agents 7 and 8 have landed

### Agent 9: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M28-PROMPTS.md ("Done when"), the accepted ADR, crates/core/tests/ageing.rs and ageing_worked.rs, crates/server/tests/open_items.rs and tests/common/mod.rs.
You own:
- crates/server/tests/m28.rs (new)
Task: write `m28_is_done`, checking each "Done when" bullet in turn. Reuse the helpers in tests/common.
Run `scripts/one-build.sh make check`. Don't commit.
```

## When all of them are done

Check `make check` passes, then in a browser on the fixture: import the sample CSV, see the aged receivables and the
agreement to the ledger, change a balance to open a gap and see the warning, finalise with and without accepting it,
and look at the PDF. Hand the worked example to an NZ accountant (`NON-CODE-TODOS.md`) and tick it. Tick M28's status
here and in `PLAN.md`, and add a line under M16 saying the aged-report imports now have a target.
