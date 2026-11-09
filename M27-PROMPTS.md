# M27: Trusts and current accounts (beneficiary and shareholder balances)

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M27 takes the next free
ADR and migration numbers (check). **It needs M26 first**: it reuses M26's `ReportTable`, its movement lines and its
snapshot handling.

## The milestone
Status: not started. Planned 2026-11-10. Presentation choices are marked **DECISION FOR ME** and are answered before
code starts (CLAUDE.md: ask, then record in `docs/domain.md`).

**Why.** A trust's accounts are mostly about who is owed what. Each beneficiary has a current account (a "beneficiary
loan account"): income the trustees allocate to them goes in, money paid to them comes out, and the balance is what the
trust owes them (or, if overdrawn, what they owe the trust). Accountants issue a schedule of these with the statements.
Companies need the same for shareholder current accounts. We have neither: there is no trust entity type, and the
company template has one line, "Shareholder current account" (830), with nothing behind it.

**What exists today:**
- Practice master charts, mappings, templates, rounding priority lists and asset classes exist per entity type, and
  the fixtures have two: company and sole trader (`fixtures/practice/`). Trusts and partnerships are in the backlog
  ("Companies (IR4), partnerships and trusts: templates and returns").
- A mapping puts every account on exactly one report line; a line shows one figure (M26 adds opening and movement).
- Journals keep a narration and lines of (account, amount); they carry no party or tag, and they never change once
  posted. The GL read (`crates/core/src/gl.rs`) already lists each account's lines.
- M26's `ReportTable` (a grid that foots both ways) and its movement lines.

**1. The schedule.** One row per beneficiary (or shareholder), with columns: opening balance, income allocated to
them, payments and drawings, other movements, closing balance; a total row. The opening is last year's closing, so the
schedule needs no separate prior-year column. A balance shows credit positive (owed to the beneficiary); an overdrawn
one shows in brackets and is flagged.

**2. One ledger account per beneficiary.** Each beneficiary is an account in a range of the trust's chart (for example
8xx.nn), created by the existing account commands. The schedule's rows are every account the mapping puts on the
beneficiary-accounts line, in code order, so a new beneficiary appears with no template edit. Nil rows (no opening, no
movement, no closing) are left out, as everywhere else (docs/domain.md, Nil lines).

**3. Sorting the movements into columns.** Journals can't be tagged and don't change, so the schedule decides from the
journal itself: the account on the other side of the beneficiary's line. The template lists which account ranges mean
"income allocated" (the distributions account) and which mean "payments" (bank accounts); anything else is "other".
- A journal with more than two lines can be ambiguous (a beneficiary leg with several counter-legs). Its beneficiary
  amount goes to "other" and the schedule's warnings count it, so it's never silently guessed.
- **DECISION FOR ME: how to classify.** (a) By the other side of the journal, as above (no new data; ambiguous
  journals land in "other"). (b) A tag on each journal line, set when the journal is made (cleaner, but changes the
  journal type, the most guarded type here). Recommended: (a).

**4. The trust entity type.** A "Trust (standard)" master chart, mapping, template, rounding priority list and asset
classes, in our own words (hard rule 3), written to the same standard as the company and sole-trader ones. The
template's statements:
- performance: income and expenses as usual, then **profit before distributions**, **distributions to beneficiaries**,
  and **undistributed profit**;
- movements in trust funds (M26's statement: settled sum, capital reserves, retained income, with distributions as a movement);
- position: the beneficiary current accounts as one line; and
- the schedule from section 1.
The agent audits where entity types are listed (the practice master chart per entity type, the new-business form, the
fixtures loader, the import mappers) and adds "trust" in each.
- **DECISION FOR ME: where the balances sit on the position statement.** Credit balances are owed to beneficiaries
  (a liability), debit balances are owed by them (an asset), and a mapping can't split one account by sign. (a) One line
  of net beneficiary accounts, with the schedule giving each one and a warning counting overdrawn beneficiaries.
  (b) Two lines, with the template pointing at separate account ranges the accountant keeps apart. Recommended: (a).
- **DECISION FOR ME: where they sit in the template.** Under liabilities, or as part of trust funds. Recommended:
  liabilities, because it's an amount owed.

**5. Company shareholders.** The company template gets the same schedule, off by default. A practice turns it on, and
adds one account per shareholder under 830. No change to existing clients (Defaults never reach back).

**6. Where it appears.** The Statements tab, the PDF, and the finalisation snapshot. A finalised schedule never
changes.

**Out.**
- Allocating income to beneficiaries as a helper (splitting by percent, rounding the remainder). It's a tax decision
  as much as an accounting one, so it stays with the accountant's own journal until a tax milestone.
- IR6 and any trust tax workings (trustee and beneficiary rates, minimum tax, distributions and their dates), and
  FBT or interest on overdrawn accounts (CLAUDE.md, Out). The schedule shows facts; it explains no tax.
- Partnerships (backlog; the schedule engine would serve them), a trust deed's beneficial interests, trustee
  resolutions, and a statement per beneficiary to send them.

### Done when
`crates/core/tests/trust.rs` and `crates/server/tests/m27.rs` (`m27_is_done`), against a synthetic trust with three
beneficiaries over two years, show that:
- the schedule foots down and across, each closing equals its account's balance, each opening equals last year's
  closing, and the total equals the position statement's line;
- a journal paying a beneficiary from the bank lands in "payments", an allocation from the distributions account lands
  in "income allocated", and a journal with several counter-legs lands in "other" with a warning;
- a beneficiary account added mid-year appears with no template edit; an overdrawn beneficiary is bracketed and counted;
- the trust template validates (no unmapped accounts, no overlapping ranges) and every account of the fixture trust
  chart maps to exactly one line;
- the company and sole-trader statements are byte-identical to before, and a company without the schedule switched on
  shows nothing new;
- a finalised year's schedule is frozen through template and chart edits.

The web tests cover the schedule and the new-business form offering "Trust". Then a browser check on the fixture trust.

## Running it

Five waves of small agents. Opus only writes the ADR.
- **Wave 1:** ADR. **Nothing in wave 2 starts until you've accepted it and answered its DECISIONS FOR ME.**
- **Wave 2:** two agents at once: core (the schedule builder); and the trust fixtures with the hand-worked example.
- **Wave 3:** the server (entity type everywhere it's listed, reads, finalise).
- **Wave 4:** two agents at once: the web; and the PDF.
- **Wave 5:** the done check.

Shared files and rules are as in `M26-PROMPTS.md` ("Running it"): append-only shared files, `make types`, no commits,
`scripts/one-build.sh` for every build and test. **Migration:** probably none (the schedule reads journals). If the
entity-type list is stored in a table that needs a new value, Agent 4 adds one, with the next free number.

**Hard rules apply.** Money is integer cents (4); core is pure and byte-stable (5); any chart or practice change is a
command (6); no real client data, the trust is invented (1); templates and paragraph wording are our own (3).

## Wave 1: start now

### Agent 1: the ADR (Opus, high thinking)
```
Read CLAUDE.md (Scope, Hard rules, Domain invariants, Roles), M27-PROMPTS.md and M26-PROMPTS.md (both milestones), the accepted M26 ADR, docs/domain.md (Account codes, Sole-trader chart and template, Nil lines, the rounding sections), crates/core/src/template.rs, reportdoc.rs, table.rs (M26's), gl.rs, chart.rs, mapping.rs, fixtures/practice/company-*.json and sole-trader-*.json, and a grep for where "company" and "sole_trader" appear as an entity type across crates/ and apps/web/src.
You own:
- docs/decisions/NNN-trusts-and-current-accounts.md (new; NNN is the next free number)
- a new "Trusts and current accounts" section in docs/domain.md (decisions only)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed. Mark each DECISION FOR ME in the milestone and don't decide it.
1. The list of every place an entity type is named, and what adding "trust" touches in each.
2. The schedule's definition in a template (roster by mapped line, columns by contra-account ranges), how it reads journals in pure core (what it takes as input), and how ambiguous journals are handled.
3. The trust chart's account ranges, with the account codes, names and types, and the mapping. Our own wording (hard rule 3).
4. The trust template's statements, line by line, and the equality checks.
5. How company shareholder accounts switch the schedule on, per practice.
6. Rollover for the trust: which accounts close to which (settled sum, capital, retained income; distributions).
7. How trusts fit CLAUDE.md's Scope (statements only; IR6 and tax workings stay Out), and the line to add to its Scope and Layout notes if any.
8. What a person must do: an NZ accountant checks the chart, template and wording against a real trust's accounts (without real data in the repo, hard rule 1). Add to NON-CODE-TODOS.md.
List the consequences. Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted the ADR (both at once)

### Agent 2: the schedule builder (Sonnet, high thinking)
```
Read CLAUDE.md, M27-PROMPTS.md, the accepted ADR (follow it where it differs from the milestone), crates/core/src/gl.rs, table.rs, template.rs, reportdoc.rs, mapping.rs and crates/core/tests/ for the existing style.
You own:
- crates/core/src/schedule.rs (new), its lines in lib.rs, and the schedule definition in template.rs (serde defaults so existing templates are byte-identical)
- crates/core/tests/trust.rs (new)
Task: a pure builder: given the template's schedule, the mapping, the year's chart, its journals and the opening and closing TBs, build a ReportTable with one row per account on the roster line, the ADR's columns, classified by contra account, a total row and column, the warnings (ambiguous journals, overdrawn counts), and drill-down codes. Byte-stable, no HashMaps.
Tests: proptest (every row cross-foots, columns foot, closing equals the TB balance, opening equals the prior closing, every beneficiary line is classified exactly once); the multi-leg journal case; nil rows omitted.
Run `scripts/one-build.sh make check`. Don't update snapshots; if one moves, stop and tell me. Don't commit.
```

### Agent 3: the trust fixtures and worked example (Sonnet, medium thinking)
```
Read CLAUDE.md, M27-PROMPTS.md, the accepted ADR, docs/domain.md (the sole trader's statements worked example, for the style), fixtures/README.md, fixtures/practice/company-chart.json, company-mapping.json, company-template.json and company-asset-classes.json.
You own:
- fixtures/practice/trust-chart.json, trust-mapping.json, trust-template.json, trust-asset-classes.json, trust-rounding-priority.json (new, from the ADR)
- fixtures/clients/example-trust.json (new): an invented trust with three beneficiaries over two years, loaded through commands (hard rule 6), with an allocation, payments, an overdrawn beneficiary and one multi-leg journal
- a "Worked example: the trust's statements and schedule" in docs/domain.md, worked by hand and cross-checked by a script that doesn't use acct-core ("Hand-checked by: (nobody yet)")
- crates/core/tests/trust_worked.rs (new)
Task: build the fixtures and the example, then assert the worked figures. Everything invented, no real names or amounts (hard rule 1).
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 3: after Agents 2 and 3 have landed

### Agent 4: the server (Sonnet, high thinking)
```
Read CLAUDE.md, M27-PROMPTS.md, the accepted ADR (its list of every place an entity type is named), crates/server/src/reports.rs, finalise.rs, fixtures.rs, starter.rs, business.rs, commands.rs, access.rs, crates/store (where entity type is stored), crates/server/tests/ and tests/common/mod.rs.
You own:
- "trust" wherever the ADR's list says an entity type is named in crates/ (the loader, the new-business path, the master charts, the import mappers), and a migration only if one is needed
- the schedule in the report read (reports.rs), and in the snapshot (finalise.rs)
- crates/server/tests/trust.rs (new)
Task: a trust can be created, gets the trust master chart, mapping and template copied at the point of use, and shows the schedule; finalising freezes it. Existing company and sole-trader clients are unchanged.
Tests: create a trust, post the fixture's journals, read the schedule; finalise then edit the template: unchanged; a company without the schedule gets nothing new.
Run `scripts/one-build.sh make check`, then `make types`. Don't commit.
```

## Wave 4: after Agent 4 has landed (both at once)

### Agent 5: the web (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M27-PROMPTS.md, the accepted ADR, apps/web/src/components/ReportTable/ (M26's), pages/StatementsTab.tsx, NewBusinessPage.tsx, MasterChartPage.tsx, and the generated types.
You own:
- the schedule's mount in StatementsTab.tsx, using the generic ReportTable
- "Trust" in NewBusinessPage.tsx and the practice settings where entity types are chosen (their lines only), and an overdrawn-beneficiary notice
- Testing Library tests
Task: show the schedule with its warnings (ambiguous journals, overdrawn), the trust option in the new-business form, and the trust master chart among the practice's. Render only what the server returns.
Run `scripts/one-build.sh make check`. Don't commit.
```

### Agent 6: the PDF (Sonnet, low thinking)
```
Read CLAUDE.md, M27-PROMPTS.md, crates/pdf/src/lib.rs and its table module (M26's), crates/pdf/tests/render.rs.
You own:
- the schedule's page in crates/pdf (its lines only) and its test
Task: render the schedule after the statements using the generic table renderer, with the warnings as footnotes. It does no arithmetic.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 5: after Agents 5 and 6 have landed

### Agent 7: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M27-PROMPTS.md ("Done when"), the accepted ADR, crates/core/tests/trust.rs and trust_worked.rs, crates/server/tests/trust.rs and tests/common/mod.rs.
You own:
- crates/server/tests/m27.rs (new)
Task: write `m27_is_done`, checking each "Done when" bullet in turn. Reuse the helpers in tests/common.
Run `scripts/one-build.sh make check`. Don't commit.
```

## When all of them are done

Check `make check` passes, then in a browser: create a trust, look at its three statements and the schedule, finalise,
and look at the PDF. Hand the trust worked example to an NZ accountant (`NON-CODE-TODOS.md`) and tick it. Tick M27's
status here and in `PLAN.md`, and update `PLAN.md`'s backlog line about trusts so it says only their returns remain.
