# Fixtures

Synthetic data only (CLAUDE.md hard rule 1). No real client, person or business appears here; names
and figures are made up.

- `practice/`: practice-level defaults for companies: the master chart, the statement template
  (our own wording), the mapping and the asset classes (`company-asset-classes.json`). Account 250,
  gain or loss on disposal, maps into general expenses only as a placeholder (`docs/domain.md`, Open).
- `practice/sole-trader-*.json`: the same set for sole traders (`docs/domain.md`, "Sole-trader chart
  and template"), plus `sole-trader-rounding-priority.json`, the default rounding priority list a new
  sole-trader client starts with, and `sole-trader-coding-settings.json`, the accounts Save tax codings
  post to by default ("Coding settings"). The asset class rates are placeholders (1 basis point,
  marked `rate_placeholder`) until M11 sets them from IRD's rates.
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

Amounts are integer cents, debits positive. `acct-core`'s fixture tests read these files at compile
time and snapshot the resulting ReportDocs. `make db-reset` loads them into the dev database through
the command pipeline (`acct-load-fixtures`), with dev users `admin`, `staff` and `viewer`, password
`fixture-password`.
