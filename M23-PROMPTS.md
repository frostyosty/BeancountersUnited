# M23: Invoice scanner (read, check, match)

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M23 takes ADR 017 and
migration 0017 (M24 has 0018). Start it once M22 is done (`m22_is_done` passes), because every AI read must be metered
and limited by M22 from the first call.

## The milestone
Status: not started. Planned 2026-11-09. ADR 017 accepted 2026-11-10, which added local OCR and purchases paid in parts;
the agents were renumbered then.

**What it's for.** An owner has a supplier's invoice or receipt. We read it, check it, match it to the bank line that
paid it, and keep it as the record the GST rules ask for. Reading is the visible part; the value is in the other three:
- Over $200, the GST on an expense waits in 615 until the owner confirms they hold the supplier's taxable supply
  information (`acct_core::coding::SUPPLY_INFO_THRESHOLD`, the `confirm_supply_info` command, and `docs/domain.md`'s GST
  section). A checked invoice matched to the line *is* that information, so confirming it releases the claim.
- Over $1,000 the information must also name the buyer, so we can say plainly when an invoice doesn't.
- A matched invoice names the supplier, which feeds ADR 009's history and merchant layers, so the next line from that
  supplier needs no model.

**Naming.** "Invoices" already means the invoice maker (migration 0011, `crates/server/src/invoices.rs`,
`crates/store/src/invoices.rs`): invoices a user writes. To keep the two apart, the code calls a supplier's invoice or
receipt a **bill**: `acct_core::bill`, `crates/server/src/bills.rs`, the `bills` table, `attach_bill` and so on. The UI
says "invoice or receipt".

**Reading, in stages** (ADR 017, 2 and 13). Each file goes down the stages and stops at the first result that passes
the checks. Read as much as possible on our own server; only the last stage uses a model.
1. **E-invoices** (UBL XML, as PEPPOL uses): read the fields directly.
2. **Everything we can read on our server**, as **page words** (text, position, confidence):
   - **PDFs with a text layer:** the text layer's words.
   - **Photos and scans:** local OCR (Tesseract, run as its own program, in `crates/ocr`), after the upload returns.
     Words OCR isn't sure of are flagged, never guessed: a field with one is left empty and its place kept.
   - Then the same reading for both: a learned template for a supplier this business has confirmed a bill from
     (where each field sat, never the text), then generic rules.
   - **The owner's answers:** when a reading fails only because fields were unclear, the owner sees each unclear bit
     of the page and types what it says (`fill_bill_fields`). Only flagged fields can be answered.
3. **The AI reader**, for what's left (no total found, too little readable, or still failing): a vision reader behind
   an `InvoiceReader` trait in `crates/ai`, with a fake for tests. It's the only stage that sends anything out. It runs
   only when the owner presses **Read this with AI** on that file, never on upload or in bulk, and never for a guest.

**The fields** every stage produces (`acct_core::bill::BillFields`, ADR 017, 9): supplier name, supplier GST number,
invoice number, date, buyer name and which detail identifies them, currency, lines (description, amount), whether the
lines include GST, subtotal, GST, total, whether it says GST is included, the stage that read them, the unclear fields
and the fields the owner typed. Amounts in integer cents.

**Checks, in core, always applied** (`acct_core::bill`, pure). Whatever stage produced the fields:
- the lines add up to the subtotal, and subtotal plus GST equals the total;
- the GST is what the rate for the invoice date gives on the GST-inclusive total, within an allowance ADR 017 sets
  (the rate comes from core's dated GST data, never a literal 15%);
- the supplier's GST number, if given, passes the IRD number checksum;
- the fields the amount requires are there (the buyer's name too over $1,000), as `docs/domain.md`'s "Tax invoices"
  section says, with every rule marked **check** for the tax specialist.
Every failed check is returned by name. A failing result is kept and shown to the owner with the fields as read, can't
be confirmed, and posts nothing. A model's answer that fails is counted as `invalid` in M22's usage. The model only
proposes fields; core computes every amount that reaches the ledger.

**Matching to a bank line** (core, deterministic). Same amount (or lines adding to it, for a split payment), a date
within a window, and the supplier name against the line's normalised description. Several candidates go to the owner
to choose; nothing is guessed. Proposals are worked out when a bill is read, never stored, so a bill waiting for its
line shows the match once a statement brings it in. Matching never posts a journal.

**Purchases paid in parts** (ADR 017, 14; `docs/domain.md`, "Purchases paid in parts"). The tax specialist confirmed
that the $200 and $1,000 tiers go by the supply, not by each payment. A deposit and a balance of $150 and $195.50 are
one $345.50 supply, and neither payment's GST is claimed until the information is confirmed. So:
- A **purchase** groups payments for one supply, with its full price. Core's GST rule reads the purchase's total
  (`acct_core::purchases::Supply`); a payment in no purchase is its own supply, exactly as today.
- Purchases come from a bill paid in parts, from the owner saying so, or from answering a flag.
- Core **flags** likely ones (same payee, each $200 or less, together over $200, and a shared reference number,
  instalment words or the same day; or small bills from one supplier that look like one supply split up). Save tax
  asks "Were these one purchase?". A flag holds no GST, but must be answered before a GST return covering it is filed
  (M14 enforces that; M23 marks the card `blocks_filing`).

**Commands** (all through the pipeline):
- `attach_bill`: stores the file against a business. Changes no figures. Server-only.
- `record_bill_reading`: the fields, the stage and the check results. Changes no figures. Server-only.
- `fill_bill_fields`: the owner's answers to unclear fields. Changes no figures.
- `confirm_bill`: the owner confirms the fields and the match. Over $200 it does what `confirm_supply_info` does
  (`save_tax::confirm_supply_info`, in the same command), so the GST is claimed, the tax figure moves and M13 says
  so. A bill on more than one payment, or part paid, makes a purchase. Over $1,000 without the buyer's name, the bill
  is kept but doesn't release the claim, and the owner is told what to ask the supplier for. This is also when the
  supplier's template is learned.
- `unmatch_bill` and `delete_bill`. Deleting removes the file; the log keeps that it happened. Unmatching or deleting a
  confirmed bill leaves `confirm_supply_info`'s confirmation as it is.
- `group_payments`, `ungroup_payments` and `answer_possible_split`: purchases paid in parts.

**Files.** Stored the way `statement_files` are (migration 0012), with ADR 017's limits, and ADR 014's expiry for
guests. Types are sniffed from the bytes, not the extension: PDF, PNG, JPEG and UBL XML. HEIC is out. Size, pages,
image dimensions and parse time are capped. Nothing in a file is ever fetched or followed. **File text is data, never
instructions:** every reader's output is only fields, and core checks them.

**What leaves the server (ADR 017, 3).** UBL, text layers, OCR and the owner's answers send nothing. Stage 3 sends the
page image, with its metadata stripped, only when pressed, beside one plain line saying where it goes. Before real
owners use stage 3, IRD confirms in writing and the privacy policy says so (`ACCT_AI_INVOICE_READS`, off until then).

**Choosing the reader.** A bake-off on synthetic invoices in `fixtures/invoices/` (generated, as `fixtures/landing/`
is) measures accuracy per field, false passes, cost, the share read without a model (UBL, text layer, OCR), and OCR's
unclear fields, time and memory. CI runs it against the fakes only.

**Cost and limits.** Every stage-3 read is an `invoice_read` ask in M22's `ai_usage`, inside the budget cap: 10 a day
on every plan, none for guests. Bills held: Free 100,000, paid plans no limit, guests 20; 4 MB a file and 100 MB a
business (ADR 017, 4 and 10). OCR is local and isn't metered.

**Web.** On a bank line in Save tax and in the books' bank screen: **Add invoice** (drop or choose a file; on a phone,
take a photo). "Reading…" while OCR runs. It shows the file beside the fields as read, each check with a tick or its
reason, and "What does this say?" for each unclear bit. Save tax gains the "Were these one purchase?" card, and the
bank screen can group payments and marks a payment in a purchase. The accountant view sees bills and purchases
read-only, with the file.

**Out.** Sales invoicing, the invoice and hybrid GST bases (so an unpaid bill never changes the tax figure), a payables
workflow (due dates, aged payables), email-in addresses, bank feeds, sending crops of unclear bits to the AI, and the
filing gate itself (M14).

### Done when
`crates/server/tests/m23.rs` (`m23_is_done`) and `crates/core` tests show, on the synthetic files in
`fixtures/invoices/`:
- a UBL file and a text-layer PDF give their pinned fields, and a fake reader that fails the test if called proves
  stages 1 and 2 never reach it;
- a synthetic photo is read through OCR (`FakeOcr` with the fixture's words) with no model, and `crates/ocr`'s test
  reads a synthetic photo with real Tesseract in CI;
- a blurred field comes back unclear; the owner's answer completes the reading; answering a field that wasn't unclear
  is refused;
- a scan OCR can't read reaches the fake AI reader only when asked, and never for a guest;
- a bill whose lines don't add up, whose GST is wrong, or whose GST number fails the checksum fails with the check
  named, can't be confirmed, and nothing posts;
- the prompt-injection fixture changes no field and no figure;
- a bill matches the right bank line, an ambiguous one is left for the owner, and an unmatched one stays as evidence;
- confirming a bill over $200 releases the GST claim and moves the tax figure by the pinned amount; one over $1,000
  that doesn't name the buyer is reported short and releases nothing;
- the deposit-and-balance pair is flagged; "One purchase" moves their GST to 615 and the tax figure up by the pinned
  45.07; the matching invoice releases it; "Separate purchases" stops that flag; a payment in no purchase posts exactly
  as before (a property test in core);
- every stage-3 read is an `invoice_read` in M22's usage and respects its limit and the budget cap;
- an owner can't read another business's bills or purchases, and an expired guest's bill files are gone.

The web tests cover adding a file, the checks, the unclear answers, the match choice, the possible-split card and the
phone photo input. Then a browser check on a desktop and a phone.

## Running it

Six waves, fourteen agents. Opus only wrote the ADR; the rest is Sonnet at the lowest thinking that suits the job.
- **Wave 1:** ADR 017 with the domain sections (done, accepted 2026-11-10), and the synthetic fixtures.
- **Wave 2:** two agents at once: the bill types and checks in core; purchases in core.
- **Wave 3:** four agents at once: matching in core, the deterministic readers, OCR, and the AI reader.
- **Wave 4:** the server's records: storage for bills and purchases, the bill commands, the GST rule reading purchases,
  the reads, and every API type.
- **Wave 5:** four agents at once: upload, the staged read and the OCR worker; purchases on the server; the bill
  screens; the purchase screens. The web agents build against wave 4's types.
- **Wave 6:** the done check.

Every agent reads the milestone section above first. Each prompt says which files the agent owns. Shared files
(`Cargo.toml`'s workspace members, `crates/server/src/lib.rs`, `commands.rs`, `access.rs`, `history.rs`, `guests.rs`'s
lists, `impersonation.rs`'s lists, `crates/core/src/lib.rs`, `crates/import/src/lib.rs`, `crates/ai/src/lib.rs`,
`apps/web/src/App.tsx`, `apps/web/src/icons/registry.json`, `apps/web/src/pages/SaveTaxCards.tsx`, the books' bank
screen) are append-only except where a prompt says it owns them: re-read just before editing, and add only your own
lines. Don't hand-edit `packages/types`: run `make types`. Leave the invoice maker's files alone.

**Migration:** only Agent 9 adds one, 0017, with every table in ADR 017's consequences. M24 has 0018; if 0017 is taken
by then, stop and ask.

**Hard rules apply.** No real invoice, supplier, person or number anywhere (1): `fixtures/invoices/` is generated and
invented. Amounts are integer cents and rates basis points, with i128 for products (4). `crates/core` stays pure (5):
reading, OCR and files live elsewhere, and core only checks what they hand it. Every change to business data is a
command (6); M22's usage rows are metering. No file text, OCR word, field value or prompt in a log or error. Emoji only
in the chrome, never in the fields.

## Wave 1: start now (both at once)

### Agent 1: ADR 017 and the tax-invoice rules (Opus, high thinking). Done 2026-11-10.
```
Read CLAUDE.md (hard rules 1, 4, 5 and 6), M23-PROMPTS.md (the milestone), docs/decisions/009-ai-suggestions.md, 011-generalised-ai-requests.md, 014-guests.md and 016-ai-usage.md, docs/domain.md (the GST sections and the worked examples about supply information), docs/security.md, crates/core/src/coding.rs (SUPPLY_INFO_THRESHOLD), crates/server/src/save_tax.rs (confirm_supply_info), crates/server/src/statement_files.rs and migration 0012, crates/ai/src/lib.rs and redact.rs, crates/server/src/ai_usage.rs and ai_limits.rs, apps/web/src/pages/PricingPage.tsx.
You own:
- docs/decisions/017-invoice-scanner.md (new; check 017 is still the next free number)
- a new "Tax invoices" section in docs/domain.md (our own words; link IRD's pages, copy nothing)
- new rows in docs/security.md (Planned, M23)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed, and the domain section. Give the reason for each recommendation in a sentence; where it's my call, list the options and mark it DECISION FOR ME.
1. Tax invoices (domain.md): the fields a supplier's invoice must show up to $200, over $200 and over $1,000; which the checks require; the GST rounding allowance. Cite IRD's pages, mark every rule **check** for the tax specialist, and add a worked example with invented numbers.
2. The stages: what "a result that passes" means, so the cascade knows when to stop.
3. Stage 3's privacy: the page image, a crop, or text from local OCR (say what local OCR would add to a hosted Rust server). Compare what each exposes, accuracy and cost. DECISION FOR ME: what is sent, and the wording of the one plain line on the Read this with AI button (recommend that line, no consent screen, as ADR 011 removed it).
4. Retention: where files live, for how long, what's deleted with the business, guests' expiry, and the limits shared with statement files.
5. Supplier templates: what's learned (field positions or patterns, never text), learned only on confirm_bill, per business only (say why, tied to hard rule 1).
6. File safety: types, sniffing, size, page and time caps, nothing fetched. Confirm HEIC is out.
7. The five commands: payloads, what each stores, which change figures (only confirm_bill, through confirm_supply_info's logic), what unmatching or deleting a confirmed bill does, how each reads in Changes in plain English, and which are allowed while an overseer is viewing as someone (M19's WhileActing).
8. Matching: amounts (including split payments), the date window, the name comparison, what's ambiguous, and when a statement import re-runs matching.
9. The API: routes and JSON shapes for upload, the staged read, Read this with AI, and the owner's and accountant view's reads, named as Rust types, so wave 4 can define them all and the web can build against them.
10. Limits: invoice_read reads and invoice uploads per plan in M22's limits table (the pricing page's promises as the starting numbers), guests never reaching stage 3. The numbers are the owner's call (NON-CODE-TODOS.md).
11. The bake-off: what's measured, what's good enough, and what CI tests without a network.
12. Prompt injection: the reader prompt treats the file as data, a fixed output shape, no tools, and what happens to a reply that tries anything else.
Then list the consequences: migration 0017, the commands and routes, the guest, access and impersonation changes, the crates touched, any new dependency, the types.
Don't commit. Stop after the ADR and the domain section and give me the DECISIONS FOR ME as a short list.
```
The owner then asked for local OCR and purchases paid in parts; the same session added ADR 017's sections 13 and 14,
"Purchases paid in parts" in `docs/domain.md`, and this file's new agents.

### Agent 2: the synthetic invoices (Sonnet, medium thinking)
```
Read CLAUDE.md (hard rule 1), M23-PROMPTS.md (the milestone, especially "The fields", "Purchases paid in parts" and "Done when"), docs/decisions/017-invoice-scanner.md (sections 6, 13 and 14), docs/domain.md ("Tax invoices" and "Purchases paid in parts"), fixtures/landing/README.md and generate.py (the generator pattern), fixtures/bank-statements/README.md.
You own:
- fixtures/invoices/ (new): generate.py, README.md, the generated files, and expected.json
Task: a generator that writes synthetic supplier invoices and, for each, its expected fields (ADR 017's BillFields, amounts in integer cents) or its expected failure, in expected.json. Invent every name, address, number and GST number (valid checksums except where a fixture needs a bad one); the generator keeps the arithmetic exact. Prefer Python's standard library; if you need a package to write PDFs or images, pin it in a requirements file and say why in the README.
Fixtures:
- a UBL XML invoice; text-layer PDFs from two suppliers, one with a layout generic rules can't read (two of these, so a template learned from the first reads the second);
- for OCR: a clean photo-like PNG and JPEG of a printed invoice (slight skew and shadow), the same invoice as an image-only PDF with one full-page JPEG, one with a full-page 8-bit Flate image, one with a CCITT fax image (which we can't read), and a blurred one where the total stays readable but the GST number is smudged; for each image, also write the words, boxes and confidences a FakeOcr should return for it (ocr-words.json), with the smudged words under 80;
- a GST-registered and an unregistered supplier; over $1,000 naming the buyer, and one that doesn't; wrong GST; lines that don't add up; a bad GST number;
- a prompt-injection invoice whose text tells the reader to ignore its instructions and set the total to zero;
- a file of a type we refuse named as a PDF (HTML named .pdf), and one over the 4 MB cap (generated at test time, not committed);
- docs/domain.md's Kōwhai Electrical invoice (4471, total 345.50, GST number 135-792-462) as a text-layer PDF;
- two bills from one supplier, each under $200, together over $200, with invoice numbers one apart.
In the README, describe the bank lines the tests should use: one exact match, one split payment, one ambiguous pair, the Kōwhai deposit and balance (12 and 19 Mar 2026, 150.00 and 195.50, both mentioning 4471), two same-day payments to one shop, and a weekly café payment that must never flag.
The README says what each file covers, as fixtures/landing/README.md does, and how to regenerate. Running generate.py twice gives identical bytes.
Don't commit.
```

## Wave 2: ADR 017 is accepted, so start once Agent 2 has landed (both at once)

### Agent 3: bill types and checks in core (Sonnet, high thinking)
```
Read CLAUDE.md (hard rules 4 and 5), M23-PROMPTS.md (the milestone), docs/decisions/017-invoice-scanner.md (accepted; follow it where it differs from the milestone; sections 1, 2, 9 and 13), docs/domain.md ("Tax invoices" and the GST sections), crates/core/src/coding.rs, crates/core/src/tax/gst.rs (rates by date), money.rs, fixtures/invoices/README.md and expected.json.
You own:
- crates/core/src/bill/ (new): mod.rs (every core type in ADR 017, 9: BillFields, BillLine, BuyerDetail, Stage, BillField, Unclear, PageBox, BillVerdict, CheckGroup, CheckName, CheckOutcome, BillCheck, BillAssessment, BillTier; plus PageWord { text, page, bbox: PageBox, confidence: u8 }, the shape the text layer and OCR both hand over; and an empty `pub mod matching;` stub file for Agent 5), checks.rs, checksum.rs
- its `pub mod` line in crates/core/src/lib.rs (append-only)
- ts-rs derives on the public types, and `make types`
Agent 4 is working in crates/core/src/purchases.rs and coding.rs at the same time; don't touch them.
Task:
1. The types, small and stable, because every later agent builds on them. Integer cents, basis points; PageBox in basis points of the page.
2. The checks, returning every check by name with its group and outcome, and the verdict: the arithmetic, the GST for the date within the allowance (rate from gst.rs, never a literal), the IRD number checksum (its own function, invented numbers), the required fields for the tier, and "no GST charged". An unclear field counts as missing.
3. Property tests: arithmetic off by more than the allowance never passes; the checksum rejects any one-digit change.
4. A test per rule in the domain section, each with a rejecting case, the worked examples' three bills and two failures, and a test that every expected.json entry with fields gives its expected check results.
Run `make check`.
Don't commit.
```

### Agent 4: purchases in core (Sonnet, high thinking)
```
Read CLAUDE.md (hard rules 4, 5 and 6), M23-PROMPTS.md (the milestone, "Purchases paid in parts"), docs/decisions/017-invoice-scanner.md (section 14, accepted), docs/domain.md ("GST", "Tax invoices" and "Purchases paid in parts"), crates/core/src/coding.rs (coded_lines, gst_totals, SUPPLY_INFO_THRESHOLD, normalise), crates/core/src/bank.rs, crates/server/src/save_tax.rs and ai.rs (the callers of coded_lines and gst_totals), fixtures/invoices/README.md (the bank lines for flagging).
You own:
- crates/core/src/purchases.rs (new) and its `pub mod` line in crates/core/src/lib.rs (append-only)
- the signature change in crates/core/src/coding.rs: coded_lines and gst_totals take `&Supply` in place of `supply_info_confirmed`, and test the supply's total against the threshold
- the mechanical update of every caller in crates/server (pass `Supply::of_line(..)` with the confirmation they pass today; nothing else changes there yet; Agent 9 wires purchases in)
Agent 3 is working in crates/core/src/bill/ at the same time; don't touch it.
Task:
1. `Supply` and `Supply::of_line` as ADR 017, 14 gives them.
2. The purchase rules as a pure check returning every failure by name: lines all money-out, at most one purchase per line, total at least the lines' sum, lines within 365 days of the earliest. (The finalised-year and bill rules are the server's.)
3. `possible_splits`: given the business's bank lines, the lines already in purchases, the "separate" answers (as sorted line-id sets), and a small input struct of its own for bills (supplier GST number, date, invoice number, total; don't depend on crates/core/src/bill/), return the flagged sets with their sign, exactly as the ADR says: the payee key, the four signs, nothing for regular payments, strongest sign first, a line in at most one set, sorted deterministically. Make the payee normalisation public for Agent 5 if it fits there.
4. Tests: a property test that `Supply::of_line` gives byte-identical postings and totals to today's for any line and coding; domain.md's Kōwhai example (separate: 45.07 claimed; one purchase: 45.07 in 615, expenses 130.43 and 170.00); each sign flags its README case; the weekly café never flags; an answered set doesn't flag again; output doesn't depend on input order.
Run `make check`.
Don't commit.
```

## Wave 3: after Agents 3 and 4 have landed (all four at once)

### Agent 5: matching in core (Sonnet, medium thinking)
```
Read CLAUDE.md (hard rule 5), M23-PROMPTS.md (the milestone, "Matching"), docs/decisions/017-invoice-scanner.md (sections 8 and 14), crates/core/src/bill/ (Agent 3's types), crates/core/src/purchases.rs (Agent 4's), crates/core/src/bank.rs and coding.rs (normalised descriptions), fixtures/invoices/README.md (the bank lines for matching).
You own:
- crates/core/src/bill/matching.rs
Task: given a bill, the business's bank lines, the lines held by confirmed bills, the existing purchases and the line the bill was added from, return BillMatch exactly as the ADR says: one line or a split set, the date window, name evidence (macrons folded, stop-words dropped, the invoice number's digits), a purchase whose total equals the bill's proposed first, two bills on one line both demoted, nothing guessed. Byte-identical output for the same inputs: no HashMap order in anything returned.
Tests: the README's exact, split and ambiguous cases; the Kōwhai invoice against its two payments, with and without a purchase already made; no match outside the window; a property test that the result doesn't depend on the order of the lines.
Run `make check`.
Don't commit.
```

### Agent 6: the deterministic readers (Sonnet, medium thinking)
```
Read CLAUDE.md (hard rules 1 and 5), M23-PROMPTS.md (the milestone), docs/decisions/017-invoice-scanner.md (sections 2, 5, 6 and 13), crates/core/src/bill/ (read into these types, PageWord included; don't define your own), crates/import/src/lib.rs and src/bank/ (the parser structure and fixture-driven tests), fixtures/invoices/README.md, expected.json and ocr-words.json.
You own:
- crates/import/src/bill/ (new): sniff.rs (types, caps, metadata stripping), ubl.rs, pdf_text.rs (the text layer as PageWords), scan.rs (a scanned PDF page's one full-page image, as JPEG bytes or a Flate image wrapped as PNG, or "can't read"), rules.rs and template.rs (both reading PageWords, whatever their source), and a mod.rs with one entry point that runs stage 1 and the text-layer part of stage 2 and says plainly when OCR or stage 3 is needed, plus a function that reads fields from any PageWords (Agent 10 calls it with OCR's words)
- its `pub mod` line in crates/import/src/lib.rs (append-only)
- crates/import/tests/bill_fixtures.rs (new)
- any new dependency (for PDF text and images: prefer pure Rust; `lopdf` first, `png` to wrap Flate images, `quick-xml` for UBL with DTDs refused; say in your report what you checked about maintenance and licence, for the commit message)
Task:
1. sniff: types from the bytes, the ADR's caps, Exif and the other metadata stripped by walking segments, nothing fetched or followed.
2. ubl: UBL XML into BillFields.
3. pdf_text and scan as above; the text-layer test (fewer than 20 letters or digits on page 1) decides which.
4. rules and template over PageWords: a field is clear only if every word in its value is at or above the confidence floor (a parameter, 80 by default); an unclear one is left empty and listed in `unclear` with its box. Learn templates from a confirmed bill's fields and its words, storing no text; apply a supplier's template before the generic rules.
Tests: every fixture gives its expected fields or failure; the photos' ocr-words.json give their fields, and the blurred one gives an unclear GST number with its box; the scans give their JPEG or PNG, and the CCITT one "can't read"; a template learned from one awkward-layout invoice reads the second; the sniffer refuses the HTML-named-.pdf and the oversized file, and strips a JPEG's GPS; the injection fixture's fields are read as plain values and its total isn't zero.
Run `make check`.
Don't commit.
```

### Agent 7: local OCR (Sonnet, medium thinking)
```
Read CLAUDE.md (hard rules 1 and 5, Architecture: outside services), M23-PROMPTS.md (the milestone), docs/decisions/017-invoice-scanner.md (section 13, accepted: Tesseract), crates/core/src/bill/ (PageWord, PageBox), crates/ai/src/lib.rs (how an integration sits behind a trait with a fake), Dockerfile, .github/workflows/ci.yml, fixtures/invoices/README.md and ocr-words.json.
You own:
- crates/ocr/ (new crate `acct_ocr`): the PageOcr trait (an image's bytes in, Vec<PageWord> out, or an error saying why), TesseractOcr, and FakeOcr (canned words per SHA-256, a call counter, and a variant that panics if called)
- its line in the workspace Cargo.toml (append-only)
- the Tesseract packages in the Dockerfile's runtime stage (tesseract-ocr, tesseract-ocr-eng, tesseract-ocr-mri; check the names on Debian bookworm) and in ci.yml
- crates/ocr/tests/tesseract.rs (new)
Task:
1. TesseractOcr runs the `tesseract` program with the image on stdin and TSV on stdout (`stdin stdout --psm 1 -l eng+mri tsv`; check the flags against Tesseract 5), with no temporary files, an empty environment, a 30-second limit per page (kill it past that), and a 300 MB memory cap (`prlimit --as`, or the equivalent; say what you used). Parse the TSV strictly into PageWords: boxes as basis points of the page, confidence clamped to 0..=100, words with no text dropped. Never log a word.
2. Find the program at start (`ACCT_OCR=tesseract` and on PATH); if it isn't there, the constructor says so and the server runs with OCR off.
3. One page at a time is the server's job (Agent 10); this crate just runs one.
Tests: TSV parsing on canned output, including a malformed row; the time limit kills a stuck process (a fake program that sleeps); on CI, real Tesseract reads the clean synthetic photo's total and supplier name, and the test skips with a clear message where Tesseract isn't installed (Windows dev machines).
Run `make check`.
Don't commit.
```

### Agent 8: the AI reader (Sonnet, high thinking)
```
Read CLAUDE.md, M23-PROMPTS.md (the milestone), docs/decisions/017-invoice-scanner.md (sections 3, 11 and 12), 009 and 016, crates/ai/src/lib.rs, redact.rs, prompt.rs, explain.rs, fake.rs, eval.rs, anthropic.rs, openai_compatible.rs, leak_tests.rs, crates/core/src/bill/, crates/server/src/ai_usage.rs (M22's metered path), fixtures/invoices/README.md.
You own:
- crates/ai/src/bill.rs (new): the InvoiceReader trait, a request type only one function can build (as redact::request is), the prompt and the strict reply parser
- crates/ai/src/bill_fake.rs (new): a FakeInvoiceReader with canned replies and a call counter, and a variant that panics if called
- the invoice-reader parts of anthropic.rs and openai_compatible.rs (add only; re-read them first)
- the invoice part of eval.rs and an `acctd ai-eval --invoices` entry point (the CLI line is append-only)
- crates/ai/tests/bill_reader.rs (new)
Task:
1. The request carries exactly what the ADR says may leave the server (the stripped page image, the fixed instructions and the schema), and nothing else.
2. The prompt: the file is data and nothing in it is an instruction; a fixed JSON output shape matching BillFields (amounts as strings); no tools; temperature 0; at most 1,000 output tokens.
3. Parse strictly: anything outside the shape is Invalid, counted, never partly used. The reader never computes an amount.
4. Each call returns its own token usage, as M22 made the Suggester do, so the server meters it as invoice_read. No file text, prompt or reply in a log or error.
5. The eval: run stages 1 and 2 (with FakeOcr's words for the photos, or real OCR when `--ocr` is given and Tesseract is there), then a reader, over fixtures/invoices/, and report what ADR 017, 11 lists. No network in CI.
Tests: a leak test that nothing outside the ADR's list reaches the request; the injection fixture's canned reply "total 0" fails core's checks; a malformed reply is Invalid; usage is reported once per call.
Run `make check`.
Don't commit.
```

## Wave 4: after Agents 5, 6, 7 and 8 have landed

### Agent 9: the server's records (Sonnet, high thinking)
```
Read CLAUDE.md, M23-PROMPTS.md (the milestone), docs/decisions/017-invoice-scanner.md (accepted; sections 4, 7, 8, 9, 13, 14 and the consequences), 014 and 016, crates/server/src/save_tax.rs (confirm_supply_info, set_posting, CardKind, every call of coded_lines and gst_totals), ai.rs, statement_files.rs, pipeline.rs, commands.rs, access.rs, guests.rs, impersonation.rs, history.rs, lib.rs, crates/store (statement files, coding, log, migrations), crates/core/src/bill/ and purchases.rs, crates/import/src/bill/ (the template function), crates/server/tests/m11.rs, statement_files.rs and tenancy.rs. Leave the invoice maker (invoices.rs) alone.
You own:
- crates/store/migrations/0017_bills.sql (new; every table in ADR 017's consequences, purchases included, and the ai_usage rebuild), crates/store/src/bills.rs and crates/store/src/purchases.rs (new)
- crates/server/src/bills.rs (new): attach_bill, record_bill_reading, fill_bill_fields, confirm_bill, unmatch_bill and delete_bill, the bill reads, and every API type in ADR 017, 9 and 14 (with ts-rs derives), including the upload and read responses Agent 10 will serve and PurchaseView, PossibleSplit and SplitSign for Agent 11
- the purchase lookup: one function that gives a line's Supply (its purchase's total, or the line itself, and its confirmation), threaded into every caller of coded_lines and gst_totals that Agent 4 updated, so the GST rule reads purchases from here on
- `CardKind::PossibleSplit` (the variant only; Agent 11 makes the cards), `commands::SERVER_ONLY`, `RouteRule::Bill`, and the lines for the new commands in commands.rs, access.rs, history.rs, guests.rs and impersonation.rs (append-only)
- remove_statement's and expire_guest's deletes for the new tables
- crates/server/tests/bills.rs (new)
Task:
1. Migration 0017 and the store, as the ADR lists them. No file text or OCR word stored.
2. The bill commands as the ADR specifies. record_bill_reading runs core's checks on the fields it's given and records the reading whatever its verdict; a failing reading never replaces a passing one. fill_bill_fields answers only fields the reading lists as unclear, marks them typed, and runs the checks again. confirm_bill refuses a failing verdict with the checks named; on more than one line, or part paid, it makes a purchase with the bill's total; it releases through confirm_supply_info's logic for every line of a purchase over $200 when the verdict holds; when short, a purchase's small payments now wait in 615; it learns the template.
3. Matching on read (Agent 5's function), never stored.
4. Reads for the owner and the accountant view (read-only, with the file), checked in access.rs.
5. The API types, then `make types`.
Tests: each failing fixture's fields are recorded, can't be confirmed, and post nothing; an unclear field answered completes the reading, and answering any other field is refused; one match, ambiguous, unmatched, and a waiting bill matching once a statement brings its line; confirm moves the tax figure by the pinned amount and shows in Changes; the over-$1,000 bill without the buyer is short; the Kōwhai invoice confirmed on its two payments makes a purchase and claims 45.07, and a short version of it moves 45.07 to 615; every existing Save tax and GST test still passes unchanged; another business can't read a bill; delete removes the file and keeps the log entry; an expired guest's files and purchases are gone.
Run `make check`.
Don't commit.
```

## Wave 5: after Agent 9 has landed (all four at once)

### Agent 10: upload, the staged read and the OCR worker (Sonnet, medium thinking)
```
Read CLAUDE.md, M23-PROMPTS.md (the milestone), docs/decisions/017-invoice-scanner.md (sections 2, 3, 6, 9, 10 and 13), crates/server/src/bills.rs and crates/store/src/bills.rs (Agent 9's), ai_usage.rs and ai_limits.rs (M22), statement_files.rs (the upload pattern), guests.rs, lib.rs, main.rs, crates/import/src/bill/, crates/ocr/, crates/ai/src/bill.rs and bill_fake.rs.
You own:
- crates/server/src/bill_reading.rs (new): the upload route (attach_bill, then stage 1 and the text layer, then record_bill_reading), the Read this with AI route, and the OCR worker
- the InvoiceReader and PageOcr in AppState and their wiring in lib.rs and main.rs (append-only), `ACCT_OCR`, and the invoice_read and bills-held limits in ai_limits.rs
- crates/server/tests/bill_reading.rs (new)
Task:
1. Upload: its own body limit, sniff, stage 1, the text layer (template first), then record the reading through Agent 9's command. A photo or scan is recorded as `Reading` and queued for OCR. Uploads count against the plan's bills-held limit and the space caps.
2. The OCR worker: one page at a time, the first 3 pages, through PageOcr; read the words with crates/import's PageWords reader; submit record_bill_reading as the uploader, so `/api/sync` tells the browser. On start, queue every image or scan with no reading. With OCR off, the bill is "not read yet".
3. Read this with AI: offered and allowed only as ADR 017, 3 and 13 say (not for a guest, not while viewing as someone or as an overseer, not with the AI switch off or ACCT_AI_INVOICE_READS unset), through M22's metered path as invoice_read, with its plan limit and the budget cap. The reply goes through record_bill_reading like any other reading.
4. No file text, OCR word or field value in any log, error or metric. Serve the response types Agent 9 defined; don't change their shape.
Tests (FakeOcr and the fake readers): UBL and text-layer fixtures give their fields with the panicking fake reader installed; a photo goes Reading, then Read with FakeOcr's words and no AI call; the blurred photo comes back with an unclear field and no AI offered until the owner's answer fails; a scan OCR can't read reaches the fake AI reader only when asked, never for a guest, is metered as invoice_read, and is refused past the limit or the cap; a restart re-queues an unread photo; the injection fixture changes no field and no figure; the refused-type and oversized files are refused.
Run `make check`.
Don't commit.
```

### Agent 11: purchases on the server (Sonnet, medium thinking)
```
Read CLAUDE.md, M23-PROMPTS.md (the milestone, "Purchases paid in parts"), docs/decisions/017-invoice-scanner.md (section 14), docs/domain.md ("Purchases paid in parts"), crates/core/src/purchases.rs, crates/server/src/save_tax.rs (the cards, confirm_supply_info), bills.rs and crates/store/src/purchases.rs (Agent 9's), commands.rs, access.rs, history.rs, guests.rs, impersonation.rs, crates/server/tests/m11.rs.
You own:
- crates/server/src/purchases.rs (new): group_payments, ungroup_payments and answer_possible_split, and `GET /api/businesses/{id}/purchases`
- in save_tax.rs: the PossibleSplit cards (from core's possible_splits, with `blocks_filing` while a line is in a period not yet filed; until M14 that's every period), one SupplyInfo card per purchase, and confirm_supply_info confirming every line of a purchase
- the lines for the new commands and route in commands.rs, access.rs, history.rs, guests.rs, impersonation.rs and lib.rs (append-only)
- crates/server/tests/purchases.rs (new)
Task: as ADR 017, 14 specifies. Making or ending a purchase reposts each coded line in it inside the command; a line in a finalised year is refused; ending a bill's purchase is refused ("unmatch the bill instead"); `Accepted` carries the tax before and after; Changes reads as the ADR words it.
Tests: the Kōwhai pair is flagged with "Both mention 4471"; "One purchase" moves 45.07 to 615 and the figure up by 45.07; "Separate purchases" removes the flag for good; ungrouping puts it back; confirm_supply_info on one payment confirms both; a finalised-year line is refused; the weekly café never flags; another business can't group or read a purchase; while viewing as someone it needs changes on.
Run `make check`.
Don't commit.
```

### Agent 12: the bill screens (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M23-PROMPTS.md (the milestone, "Web"), docs/decisions/017-invoice-scanner.md (sections 3, 9 and 13: the API, the button's wording, the unclear answers), apps/web/src/pages/SaveTaxPage.tsx and the components it uses for a bank line, the books' bank screen under apps/web/src/pages/BooksLayout.tsx, apps/web/src/lib/readOnly.tsx (M21's read-only context), apps/web/src/components/GuestBanner/ (LockedForGuest), the sync hook, apps/web/src/lib/money.ts, apps/web/src/lib/icons.tsx, and the generated types from Agent 9.
Agent 10 is building the upload and read routes at the same time: build against the generated types and mock the fetch in tests. Agent 13 is building the purchase screens; don't touch them. Don't touch crates/.
You own:
- apps/web/src/components/Bill/ (new): AddInvoice, BillChecks, BillMatch, BillPreview, UnclearAnswers
- one-line mounts on a bank line in Save tax and in the books' bank screen (append-only)
- new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. Add invoice on a bank line: drop or choose a file, or take a photo on a phone (`capture` on the input). Every photo is redrawn through a canvas (long edge 2,048 px, JPEG) before upload, which turns it upright and drops its Exif. "Reading…" until the sync feed brings the reading.
2. The file beside the fields as read, and each check with a tick or its plain reason.
3. Unclear answers: for each unclear field, that bit of the page cut from the file in the browser (its box), with "What does this say?"; send fill_bill_fields; show the checks again. Answered fields show "typed by [name]".
4. Read this with AI, only when the server offers it, with the ADR's one line. For a guest, "Save your work to read invoices with AI", as LockedForGuest does. A limit or the budget refusing shows plain wording, no cost.
5. The match: one line to confirm, or candidates to pick from (a set for a split payment). Confirm sends confirm_bill and shows the server's new tax figure ("GST claimed: your tax to pay fell $X"). Short bills say what to ask the supplier for.
6. Unmatch and delete, through ConfirmDialog with the ADR's wording.
7. In the accountant view (the read-only context), the bill and file with no buttons.
8. Icons through <Icon> with text labels, colours from tokens, no arithmetic in the browser.
Testing Library tests: adding a file and Reading…; the checks; a named failed check; answering an unclear field; the AI button's wording, guest-locked and refused states; the match choice; confirm moving the figure; the short note; unmatch and delete; read-only in the accountant view; the phone photo input.
Run `make check`.
Don't commit.
```

### Agent 13: the purchase screens (Sonnet, low thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M23-PROMPTS.md (the milestone, "Purchases paid in parts" and "Web"), docs/decisions/017-invoice-scanner.md (section 14, the card's wording), docs/domain.md ("Purchases paid in parts"), apps/web/src/pages/SaveTaxCards.tsx (the SupplyInfo card is the pattern), the books' bank screen under apps/web/src/pages/BooksLayout.tsx, apps/web/src/lib/readOnly.tsx, apps/web/src/lib/money.ts, apps/web/src/lib/icons.tsx, and the generated types from Agent 9.
Agent 11 is building the commands at the same time: build against the generated types and mock the fetch in tests. Don't touch crates/ or apps/web/src/components/Bill/.
You own:
- apps/web/src/components/Purchase/ (new): PossibleSplitCard, GroupPayments, PurchaseBadge
- the possible_split case in SaveTaxCards.tsx, and a one-line mount on the books' bank screen (append-only)
- new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. The "Were these one purchase?" card: the payments, the sign in plain words ("Both mention 4471"), One purchase (with the total, editable, and the ADR's "Your tax to pay rises by $X" before sending) and Separate purchases. A card that blocks filing says "Answer this before you file GST".
2. On the bank screen: choose payments and Group as one purchase, with the full price; a payment in a purchase shows "1 of 2 payments towards $345.50", and the purchase can be ended through ConfirmDialog.
3. The server's figures only: no arithmetic in the browser. Read-only in the accountant view.
Testing Library tests: the card's wording and both answers; the rise shown before sending; grouping from the bank screen; the badge; ending a purchase; read-only in the accountant view.
Run `make check`.
Don't commit.
```

## Wave 6: after Agents 10 to 13 have landed

### Agent 14: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M23-PROMPTS.md ("Done when"), docs/decisions/017-invoice-scanner.md, crates/server/tests/bills.rs, bill_reading.rs, purchases.rs, m11.rs, m22.rs, guests.rs and tests/common/mod.rs, crates/ocr/tests/tesseract.rs, fixtures/invoices/README.md.
You own:
- crates/server/tests/m23.rs (new)
Task: write `m23_is_done` on the synthetic files, FakeOcr and the fake readers, checking each "Done when" bullet in turn (the real-Tesseract bullet is crates/ocr's test; just check it exists and runs in ci.yml). Reuse the helpers in tests/common rather than copying the other tests' setup.
Run `make check`.
Don't commit.
```

## When all of them are done

Check `make check` passes, then:
- Run `acctd ai-eval --invoices --ocr` with a real key on the synthetic set (a few cents) and record in ADR 017: the
  chosen reader, accuracy per field, the share read without a model (UBL, text layer, OCR), OCR's unclear fields, and
  its time and peak memory per page. Set the confidence floor from them. If OCR is tight in 512 MB, raise it with the
  owner (`NON-CODE-TODOS.md`).
- **Desktop:** on a business with a bank line over $200, add the synthetic UBL invoice: it reads with no AI, matches,
  and Confirm makes the tax figure fall. Add the clean photo: it reads through OCR with no AI button. Add the blurred
  one: answer its unclear field. Add the CCITT scan: Read this with AI shows its line, and the read appears in Settings
  → Tools → AI usage as an invoice read. Add the wrong-GST invoice and check the failing check is named. Upload a
  statement with the Kōwhai deposit and balance: answer "One purchase", see the figure rise, add the Kōwhai invoice and
  see it fall. Open the accountant view and check bills and purchases are read-only.
- **Staging:** check OCR runs in the deployed image (Tesseract installed, a photo reads).
- **Phone:** photograph a printed synthetic invoice and add it. Never a real client's invoice (hard rule 1).

Tick M23's status here and in `PLAN.md`. Add the browser check to `NON-CODE-TODOS.md` if it's left for later.
