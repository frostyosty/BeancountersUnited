# M30: Statement of cash flows

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M30 takes the next free
ADR number (check) and no migration expected. **It needs M26 first** (`ReportTable` and snapshot handling). It's the
last of the reporting milestones and **optional**: do it only if the answer to the first question below is yes.

## The milestone
Status: not started. Planned 2026-11-10. Presentation choices are marked **DECISION FOR ME** and are answered before
code starts (CLAUDE.md: ask, then record in `docs/domain.md`).

**Why.** Some sets of accounts include a statement of cash flows: where cash came from and where it went, in operating,
investing and financing activities. Whether a client's set needs one depends on its reporting framework (the tier it
reports under, whether it's an exempt company, whether it's a sole trader). Most sole traders' sets don't include one.
Where one is needed, an accountant builds it by hand from the movements in the balance sheet, which is slow and the
kind of thing a ledger can do exactly.

- **DECISION FOR ME (go or no-go): do your practices issue cash flow statements?** If not, leave this milestone in the
  backlog and delete this file's pointer in `PLAN.md`.
- **DECISION FOR ME: which entity types.** Recommended: companies and trusts only, off by default in their templates.

**What exists today:**
- Everything needed to compute it is in the ledger: this year's and the prior year's TBs, the template's lines and the
  mapping. The bank lines of the balance sheet are the cash. Nothing computes movements between years yet: M26 adds
  movement lines.
- The fixed asset schedule gives additions, disposals and depreciation, and the register posts disposals with proceeds
  and a gain or loss account.
- M26's `ReportTable` and snapshot handling.

**1. Indirect method, from the ledger.** Start at net profit, add back what isn't cash (depreciation, losses and
gains on disposal), adjust for the movements in working capital (receivables, payables, GST, accruals), giving cash
from operations; then investing (purchases and sales of fixed assets) and financing (loans, share capital, dividends,
drawings, beneficiary accounts in M27); then the net change in cash, which must equal the movement in the bank lines.
That last equality is the statement's check: if it fails the statement says so and shows the difference, and it
isn't hidden.
- **DECISION FOR ME: direct method.** A direct statement (receipts from customers, payments to suppliers) can come from
  bank coding, but a TB-import client has no bank detail. Recommended: indirect only.

**2. Tagging the template.** Each template line that can move cash carries a cash-flow class: cash, operating
adjustment, working capital, investing, financing, or not applicable. It's a field on the line, serde-defaulted so
existing templates are byte-identical, and validated: every balance-sheet line with a balance in either year has a
class, or the statement shows an error, never a silent drop (the same rule as the mapping invariant). The master
templates get default classes; existing clients keep theirs, as always.
- **DECISION FOR ME: where each class goes** for the awkward lines: GST payable, loans from shareholders, beneficiary
  accounts, accrued interest, the gain or loss on disposal. The ADR proposes a table and you correct it.

**3. Rounding and sign.** Whole dollars like the other statements; the grid-style rounding of M26 applies, with the net
change in cash protected (it must equal the bank lines' movement as shown). Outflows show in brackets.

**4. A first year.** There's no prior balance sheet, so the opening is nil and every balance is a movement: the
statement works, and says "no prior year" like the other statements do. A prior year that isn't finalised marks the
comparative as unfinalised (CLAUDE.md, Comparatives).

**5. Where it appears.** The Statements tab, the PDF (M26's table renderer), the pack (M29) if it exists, and the
snapshot.

**Out.** The direct method, segment or foreign-currency cash flows, interest and tax paid classified under any
framework's special rules beyond a class per line, and notes reconciling to profit beyond the indirect method's own
first section.

### Done when
`crates/core/tests/cashflow.rs` and `crates/server/tests/m30.rs` (`m30_is_done`) show that:
- the company fixture's statement works out by hand (the worked example in `docs/domain.md`): operations, investing,
  financing, net change, and opening plus net change equals closing cash;
- proptest on random ledgers: the net change always equals the bank lines' movement, or the statement reports the
  difference; every balance-sheet account is in exactly one class; the grid foots both ways;
- an unclassified balance-sheet line is an error shown to the user;
- templates without classes build a ReportDoc byte-identical to before;
- the statement is frozen once a year is finalised; a first year works with no prior column.

The web test covers the statement and its check row. Then a browser check on the fixture company.

## Running it

Four waves of small agents. Opus only writes the ADR.
- **Wave 1:** ADR. **Nothing in wave 2 starts until you've accepted it and answered its DECISIONS FOR ME.**
- **Wave 2:** two agents at once: core (the builder and the template classes); and the hand-worked example and fixtures.
- **Wave 3:** the server, then the web and PDF together (two agents at once).
- **Wave 4:** the done check.

Shared files and rules are as in `M26-PROMPTS.md` ("Running it").

**Hard rules apply.** Money is integer cents (4); core is pure and byte-stable (5); the worked example is hand-checked
and cross-checked by a script that doesn't use acct-core, and says "Hand-checked by: (nobody yet)" until a person has.

## Wave 1: start now

### Agent 1: the ADR (Opus, high thinking)
```
Read CLAUDE.md (Rounding, Rollover, Comparatives, Snapshots, Hard rules), M30-PROMPTS.md (the milestone), M26-PROMPTS.md, the accepted M26 ADR, docs/domain.md (Rounding to whole dollars, Depreciation, Statement amounts and columns), crates/core/src/template.rs, reportdoc.rs, table.rs, depreciation.rs (disposals), mapping.rs, finalise.rs, fixtures/practice/company-template.json and company-mapping.json.
You own:
- docs/decisions/NNN-cash-flow-statement.md (new; NNN is the next free number)
- a new "Statement of cash flows" section in docs/domain.md (decisions only)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed. Mark each DECISION FOR ME in the milestone and don't decide it.
1. The indirect method as a formula over the two TBs, line by line, including depreciation and the disposal's proceeds, gain or loss, so that nothing is counted twice (work an example with numbers where depreciation, a disposal and an asset purchase all occur in one year).
2. The classes, the template field, the default classes for the company template's every balance-sheet line (a table), and the validation.
3. The check (net change equals the bank lines' movement) and what happens when it fails.
4. Rounding as an extension of M26's rule, with the net change protected.
5. First year, unfinalised prior year, and a prior year finalised before M26 (opening not available).
6. What M27's beneficiary accounts and M28's receivables and payables contribute, if those exist by then.
List the consequences. Add what a person must do (an NZ accountant checks the classes and the worked example) to NON-CODE-TODOS.md. Don't commit.
Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted the ADR (both at once)

### Agent 2: the builder and classes (Sonnet, high thinking)
```
Read CLAUDE.md, M30-PROMPTS.md, the accepted ADR (follow it where it differs from the milestone), crates/core/src/template.rs, reportdoc.rs, table.rs, mapping.rs, depreciation.rs, and crates/core/tests/ for the style.
You own:
- crates/core/src/cashflow.rs (new) and its lines in lib.rs
- the cash-flow class field on template lines in template.rs (serde default; existing JSON byte-identical) and its validation
- crates/core/tests/cashflow.rs (new)
Task: a pure builder from the two TBs, the template with its classes and the mapping to a ReportTable, with the check row and the warnings. No clock, no HashMaps.
Tests: proptest (net change equals the bank movement or the difference is reported; every balance-sheet account is in exactly one class; the grid foots both ways); an unclassified line is an error; a template with no classes is byte-identical to before.
Run `scripts/one-build.sh make check`. Don't update snapshots; if one moves, stop and tell me. Don't commit.
```

### Agent 3: fixtures and the worked example (Sonnet, medium thinking)
```
Read CLAUDE.md, M30-PROMPTS.md, the accepted ADR, docs/domain.md (the worked examples, for the style), fixtures/practice/company-template.json and company-mapping.json, fixtures/clients/example-widgets.json.
You own:
- the default cash-flow classes in fixtures/practice/company-template.json (and sole-trader-template.json only if the answers say so; new defaults only)
- a year in example-widgets.json with a purchase, a disposal and depreciation, as commands through the pipeline (hard rule 6)
- a "Worked example: the cash flow statement" in docs/domain.md, hand-worked and cross-checked with a script that doesn't use acct-core ("Hand-checked by: (nobody yet)")
- crates/core/tests/cashflow_worked.rs (new)
Task: build the data, work the example, assert it. Invented data only (hard rule 1).
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 3: after Agents 2 and 3 have landed

### Agent 4: the server (Sonnet, medium thinking)
```
Read CLAUDE.md, M30-PROMPTS.md, the accepted ADR, crates/server/src/reports.rs, finalise.rs, commands.rs, access.rs, lib.rs, crates/server/tests/ and tests/common/mod.rs.
You own:
- the statement in the report read (reports.rs) and in the snapshot (finalise.rs), lines only
- crates/server/tests/cashflow.rs (new)
Task: the read builds it from the pinned template and mapping and the year's and prior year's TBs; finalising stores it; a template without classes is unaffected.
Tests: the fixture's figures; finalise then edit the template: unchanged; an unclassified line is reported.
Run `scripts/one-build.sh make check`, then `make types`. Don't commit.
```

### Agent 5: the web (Sonnet, low thinking), at the same time as Agent 6
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M30-PROMPTS.md, the accepted ADR, apps/web/src/components/ReportTable/ (M26's), pages/StatementsTab.tsx and the generated types.
You own:
- the cash flow statement's mount in StatementsTab.tsx, its check row, and the unclassified-line error message, with Testing Library tests
Task: render what the server returns, no arithmetic; the failed-check difference is shown plainly.
Run `scripts/one-build.sh make check`. Don't commit.
```

### Agent 6: the PDF (Sonnet, low thinking), at the same time as Agent 5
```
Read CLAUDE.md, M30-PROMPTS.md, crates/pdf/src/lib.rs and its table module (M26's), crates/pdf/tests/render.rs.
You own:
- the cash flow statement's page in crates/pdf (lines only) and its test
Task: render it in the statements' order using the generic table renderer, outflows in brackets. It does no arithmetic.
Run `scripts/one-build.sh make check`. Don't commit.
```

## Wave 4: after Agents 5 and 6 have landed

### Agent 7: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M30-PROMPTS.md ("Done when"), the accepted ADR, crates/core/tests/cashflow.rs and cashflow_worked.rs, crates/server/tests/cashflow.rs and tests/common/mod.rs.
You own:
- crates/server/tests/m30.rs (new)
Task: write `m30_is_done`, checking each "Done when" bullet in turn. Reuse the helpers in tests/common.
Run `scripts/one-build.sh make check`. Don't commit.
```

## When all of them are done

Check `make check` passes, then in a browser on the fixture company: the cash flow statement ties to the bank lines,
and its PDF page foots. Hand the worked example to an NZ accountant (`NON-CODE-TODOS.md`) and tick it. Tick M30's
status here and in `PLAN.md`.
