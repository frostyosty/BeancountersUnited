# Fixtures

Synthetic data only (CLAUDE.md hard rule 1). No real client, person or business appears here; names
and figures are made up.

- `practice/`: practice-level defaults for companies: the master chart, the statement template
  (our own wording), the mapping and the asset classes (`company-asset-classes.json`). Account 250,
  gain or loss on disposal, maps into general expenses only as a placeholder (`docs/domain.md`, Open).
- `practice/sole-trader-*.json`: the same set for sole traders (`docs/domain.md`, "Sole-trader chart
  and template"), plus `sole-trader-rounding-priority.json`, the default rounding priority list a new
  sole-trader client starts with, and `sole-trader-coding-settings.json`, the accounts Save tax codings
  post to by default ("Coding settings"), and `sole-trader-merchants.json`, a practice merchant list
  (ADR 009's layer 3) for the invented merchants in `bank-statements/`, each a description pattern
  and the coding it suggests. The asset class rates are placeholders (1 basis point,
  marked `rate_placeholder`) until M11 sets them from IRD's rates.
- `practice/paragraphs.json`: the sole-trader starter set for the paragraph library (M15), in our own
  wording, as `acct_core::notes::Paragraph`s. `docs/domain.md`, "Accounting policies and notes",
  explains the placements and fields.
- `presentation/amounts.json`: how statements show whole-dollar amounts, as test vectors (ADR 010).
  `crates/pdf`'s tests check the PDF against them; the web preview's tests should too.
- `ai/labelled-lines.json`: ADR 009's bake-off set, 350 NZ-style bank lines with invented merchant
  names, each labelled with the category and GST code Save tax should pick, plus the categories a
  sole trader is offered. `acctd ai-eval` runs a provider over it. The labels follow the chart's
  default GST codes, and a person still has to check them. `tools/ai-labelled-lines/generate.py`
  rebuilds it.
- `clients/example-widgets.json`: one company over two years. Its chart is a copy of the master
  chart. `rounding_priority` is its rounding priority list, and `retained_earnings` is its
  designated equity account for rollover.
  `assets` is its asset register; its depreciation journals aren't in the file, because the register
  generates them.
- `clients/marsh-hollow-coding.json`: M11's done check. It says how the sole trader in
  `bank-statements/` (Marsh Hollow Candles) sorts every line in Save tax, and what should come out.
  `docs/domain.md`, "Worked example: Save tax on the synthetic sole trader", works the figures.
  - `business` and `statements`: the setup and upload order of the M10 example.
  - `answers`: the owner's answers to the Save tax questions.
  - `rules`: per-business rules, in `acct_core::coding`'s rule shape.
  - `transfers`: pairs to confirm, each an `out` and an `in` line key.
  - `lines`: one entry per other line. `key` is the import's duplicate key (bank account number,
    date, signed amount, normalised description, occurrence from 1). Each has either a `coding`, in
    `acct_core::coding`'s shape, or `rule`, the id of the rule that should code it.
    `supply_info_confirmed` appears on lines over $200 with a standard GST code.
  - `expected`: the position before any answers, after the answers only, and after everything: the
    TB (debits positive), the GST boxes and the income tax.

- `xero/`: M16's synthetic Xero exports (chart, contacts, two years of TB and Account Transactions)
  for an invented sole trader, Kereru Ridge Pottery. These are CSVs in dollars, as Xero writes them;
  see `xero/README.md`.

Amounts are integer cents, debits positive. `acct-core`'s fixture tests read these files at compile
time and snapshot the resulting ReportDocs. `make db-reset` loads them into the dev database through
the command pipeline (`acct-load-fixtures`), with dev users `admin`, `staff` and `viewer`, password
`fixture-password`. It loads the company defaults and client, then the sole-trader defaults, the
paragraph library, and an invented sole trader, Tui Street Joinery, with one open year (FY2026, no
books yet) whose notes are picked, so the Notes tab and the notes in its statements have something
to show.
