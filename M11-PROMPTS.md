# M11 agent prompts

M11 splits into two waves. In wave 1, five agents can work at once because none of them touches the same files. Wave 2 needs wave 1's code, so it starts once that lands.

Each prompt says which files that agent owns. That matters because last time, sessions overwrote each other's parser files.

## Wave 1: start all five now

### Agent 1: tax engine answers and credits (core)
```
Read CLAUDE.md, PLAN.md's M11 section, and these docs/domain.md sections: "The conservative figure and Save tax", "GST" and "Income tax for sole traders".
You own crates/core/src/tax/**, crates/server/src/tax.rs and the "Income tax for sole traders" section of docs/domain.md. Don't edit anything else. Other agents are working in this repo at the same time; if you need a change outside your files, message them (ListAgents / SendMessage).
Task:
1. Extend OwnerAnswers in acct_core::tax:
   - other income, and the tax already deducted from it (PAYE/RWT)
   - income tax already paid, as a credit
   - the independent earner tax credit (IETC), only when income is between $24,000 and $70,000. Record the IETC amounts and abatement, with an IRD source link, in domain.md.
2. Move the tax position calculation out of server/tax.rs into a pure core function that takes in-memory inputs: per-period GST totals, taxable income per income year, and the answers. It returns the position.
3. Add a "what if" helper: given the current inputs and one changed input, return the saving in cents. M11's Save tax queue sorts cards by this.
4. server/tax.rs becomes a thin layer that loads the inputs and calls core. crates/server/tests/m10.rs must still pass unchanged (2,506.32 and 968.35).
5. Add unit tests, plus proptests: answering a question never raises the figure, and tax is monotonic in income.
If a question is about presentation (signs, wording), e.g. whether the total can go negative, show a refund, or floor at 0, ask me instead of guessing.
Don't commit; I commit with my quicksave. Before you finish, run cargo fmt, then clippy -D warnings and the tests for acct-core and acct-server.
```

### Agent 2: categorising and posting rules (core)
```
Read CLAUDE.md, PLAN.md's M11 section, and these docs/domain.md sections: "Bank statements to the ledger", "GST" and "Sole-trader chart and template". Also read crates/core/src/bank.rs (unsorted_lines, HoldingAccounts) and crates/core/src/tax/gst.rs.
You own a new file, crates/core/src/coding.rs, and may add the single line `pub mod coding;` to crates/core/src/lib.rs. Don't edit anything else. Other agents are working at the same time.
Task:
1. Model what a bank line can be coded as:
   - Deposits:
     - income, as standard, zero-rated or exempt
     - not income, one of: a transfer between the owner's own accounts, a loan, money the owner put in, a GST refund, wages already taxed through PAYE, or the sale of a personal item
   - Withdrawals:
     - a business expense, with a category account and a GstCode (standard, zero, exempt or none)
     - partly private, by a percentage in basis points
     - an asset purchase
     - personal (drawings)
     - a transfer
     - a payment to IRD, for GST or for income tax
2. Write a pure function that turns (bank account, date, amount, coding, GST registration, the date the owner confirmed they hold taxable supply information, accounts) into the journal lines.
   - Use the GST rate for the line's date (gst_rate_bp). Round in i128, half away from zero.
   - GST on a line over $200 is claimed only once the owner has confirmed they hold the taxable supply information.
   - A partly private line splits both the amount and the GST.
3. Rules: a per-business rule matches on description text, an amount range and direction, and resolves to a coding. Write a pure matcher that picks the most specific rule, with a deterministic tie-break.
4. Add tests:
   - every coding's lines balance
   - the GST tiers at $200 and $200.01
   - percentage splits foot exactly
   - a proptest that lines always sum to zero
Account codes come from the sole-trader chart in fixtures/practice/sole-trader-chart.json. Read it; don't hard-code anything that isn't there.
If a question is about an accounting presentation convention, ask me, then record the answer in docs/domain.md.
Don't commit. Before you finish, run fmt, clippy -D warnings and the tests for acct-core.
```

### Agent 3: credit card statements (parsers)
```
Read CLAUDE.md, PLAN.md's M11 section ("NZD credit card statements"), and docs/domain.md's "Bank statement formats" section. Also read crates/import/src/bank/**.
You own crates/import/src/bank/**, new card statement files in fixtures/bank-statements/ (plus that folder's README), and the "Bank statement formats" section of docs/domain.md. Don't edit anything else.
Task:
1. Extend the parsers to NZD credit card statements:
   - OFX CREDITCARDMSGSRSV1
   - QIF !Type:CCard
   - one synthetic NZ card CSV layout
2. Statement gains a kind (Bank or CreditCard).
3. Card signs: a purchase is money out, and a payment to the card is money in, from the card's point of view. Document the convention.
4. Add synthetic fixtures. Use made-up names and numbers only (hard rule 1), and nothing copied from a real bank's sample file.
5. Add tests: detection, sign convention, balance_check, and duplicate keys.
Keep read_statement's signature stable so crates/server still compiles; if you must change it, message whoever is working on crates/server first.
Don't commit. Before you finish, run fmt, clippy -D warnings and the tests for acct-import.
```

### Agent 4: ADR for AI suggestions (doc only, needs me)
```
Read CLAUDE.md (Architecture: "Outside services"), ADR 007, PLAN.md's M11 section (the AI suggestions bullet), and docs/domain.md's sole-trader chart section.
Write docs/decisions/009-ai-suggestions.md. ADR 008 is reserved for M12's hosting decision.
Cover:
- the provider and model (recommend one, with its cost per 1,000 bank lines)
- exactly which fields leave the server: descriptions and amounts, never names, account numbers or IRD numbers; show the redaction rules
- consent: how the owner turns it on, and what's said to them
- retention, at the provider and with us
- whether IRD's terms (the gateway services/OSF) allow it; research this and cite sources
- the crate boundary: crates/ai behind a trait, with a fake for tests and no network in tests
- how a suggestion becomes a command input
- how command_log records "suggested by <model>, accepted by <user>"
  - (Done in this session: ADR 009 is accepted. MCP isn't the route; AI help is the built-in layered suggestions.)
Ask me before settling the provider and the consent wording. Only edit that ADR file, and the "AI provider" line in PLAN.md's Open questions.
Don't write code. Don't commit.
```

### Agent 5: worked example and fixture for M11's done check
```
Read CLAUDE.md, PLAN.md's M11 section (especially "Done when"), and docs/domain.md, in particular "Worked example: the synthetic sole trader" and the GST and income tax sections. Also read fixtures/bank-statements/ and its README.
You own:
- a new section at the end of docs/domain.md, before "## Open": "Worked example: Save tax on the synthetic sole trader"
- a new fixture: fixtures/clients/marsh-hollow-coding.json
- fixtures/README.md
Don't edit anything else.
Task:
1. Choose a coding for every line in the synthetic statements, covering every kind of coding:
   - the 22 Aug transfer pair
   - IRD GST REFUND as not income
   - an expense with standard GST under $200
   - an expense over $200, both with and without the taxable supply confirmation
   - a partly private line
   - an asset purchase, if one fits; otherwise say so
   - personal lines
   - one rule, e.g. a supermarket as personal
   - answers: only income = yes, student loan = no
2. Work out by hand the TB after coding, the new GST box 5 to 15 figures, income tax, and the saving at each step. Cross-check with a standalone script in your scratchpad directory that doesn't use acct-core. Show the arithmetic as the existing worked example does, and mark it "a person still has to check it".
3. The fixture's JSON shape should be simple, line key (account, date, amount, description, occurrence) → coding. Message the agent building crates/core/src/coding.rs (use ListAgents) so the names match.
Don't commit.
```

## Wave 2: once wave 1 is in

### Agent 6: server commands, recoding and the Save tax queue
```
Read CLAUDE.md, PLAN.md's M11 section, docs/domain.md (including the new Save tax worked example), crates/core/src/coding.rs, crates/core/src/tax/**, crates/server/src/business.rs, crates/server/src/commands.rs and crates/server/src/pipeline.rs, and crates/server/tests/m10.rs.
You own:
- crates/store/migrations/0005_coding.sql
- crates/store/src/coding.rs
- crates/server/src/save_tax.rs
- crates/server/src/commands.rs and pipeline.rs (command arms)
- crates/server/src/business.rs
- crates/server/tests/m11.rs
Task:
1. Commands:
   - code_bank_line: reverses the line's journal and reposts it with the new coding, all inside one command; posted journals never change
   - code_bank_lines (a batch, for "accept all")
   - add_rule and remove_rule
   - answer_question: only income, other income and tax deducted, student loan, IETC
   - confirm_transfer (posts both sides)
   - confirm_ird_payment
   - resolve_duplicate
   - confirm_supply_info
   - add_card_account (850.xx liability) and card statement import
   - asset purchase codings create an M4 asset through the existing asset commands' code path
2. Every command accepts an optional `suggested_by` per ADR 009, recorded in command_log.
3. GET /api/businesses/{id}/save-tax returns the queue: cards with a kind, the line(s) or question, a suggested coding if any, and the saving from core's what-if, sorted largest first, zero-saving cards hidden, plus the saved-so-far total.
4. tests/m11.rs: m11_is_done applies fixtures/clients/marsh-hollow-coding.json through commands only, and asserts the worked example's TB and the falls in tax. Also add rejection tests for each command, and a test that recoding twice leaves one live journal.
5. Coding settings (docs/domain.md, "Coding settings"; added 2026-10-23 by the coding.rs agent, approved by the user):
   - Store each business's acct_core::coding::CodingSettings in 0005_coding.sql, set at create_business from fixtures/practice/sole-trader-coding-settings.json. Businesses created before 0005 get those defaults too.
   - Add set_coding_settings { client_id, settings } for staff and the practice owner. Validate with CodingSettings::validate against the client's chart. It changes no figures, so it's allowed in finalised years, and it applies only to lines coded afterwards.
   - Pass the stored settings to coded_lines via CodingContext.settings.
   - Add a GET for the settings so a form can show them; the accountant's settings form itself is still unassigned.
Don't commit. Before you finish, run make check, with vitest via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...` (the local Node is too old), and regenerate the types., also, an earlier agent said "  For whoever works on crates/server: card imports now get    
  past the parser, but the server doesn't use kind yet. It    
  still names a new account "Account {number}" and has no     
  liability account per card. That's part of M11 but wasn't in
  this task." is that us?
```

### Agent 7: Save tax screen (web)
Start once agent 6 has generated its view types into packages/types.
```
Read CLAUDE.md (Web, Icons and emoji), apps/web/src/pages/BusinessPage.tsx and its test, and the save-tax types in packages/types.
You own apps/web/src/pages/SaveTax*.tsx, SaveTax.module.css and SaveTax.test.tsx, the business.save* slots in icons/registry.json, the Save tax route in App.tsx, and enabling the Save tax button in BusinessPage.tsx.
Task:
1. The Save tax screen: one card at a time, the biggest saving first, and a running "saved so far" at the top, refetching after each answer.
2. Card types:
   - question cards
   - transfer, IRD and duplicate confirmations
   - gap cards with what the gap costs
   - categorise cards: pick a category with plain names, never account codes, a GST tick over $200, a private %, or "always do this for <description>", which creates a rule
3. "Accept all suggestions" goes in one batch command.
4. Write plain English for owners who aren't accountants. Use <Icon> slots for icons.
5. Add tests in the style of BusinessPage.test.tsx.
Run vitest and tsc via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...`. Don't commit.
```

### Agent 8: AI suggestions crate
Start once ADR 009 is approved and agent 6 has accepted `suggested_by`.
```
Implement ADR 009 as it stands:
- crates/ai: a trait, the provider client, a fake, and the redaction function, with tests proving names and account numbers never leave the server
- a server endpoint that asks for suggestions for unsorted lines and returns them as pre-filled codings, which are never applied until the owner accepts them
- consent gating
When you add a dependency, give the reason in the commit message notes for me. Don't touch save_tax.rs or the commands beyond what you agree with agent 6 via SendMessage.
```

## Notes
- **Shared files:** agents 1, 3 and 5 all edit `docs/domain.md`, but each one only its own section.
- **Agents 4 and 5 will ask you things:** agent 4 needs your call on the AI provider and the consent wording, and agent 5 makes accounting choices you'll want to check.
- **The order that matters:** agent 6 needs agents 1, 2 and 5. Agents 7 and 8 need agent 6, and agent 8 also needs your sign-off on ADR 009.
- **Not committed yet:** M10 is still uncommitted, so quicksave before starting wave 1. Each agent's work then shows up as its own diff.
