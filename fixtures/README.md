# Fixtures

Synthetic data only (CLAUDE.md hard rule 1). No real client, person or business appears here; names
and figures are made up.

- `practice/`: practice-level defaults for companies: the master chart, the statement template
  (our own wording), the mapping and the asset classes (`company-asset-classes.json`). Account 250,
  gain or loss on disposal, maps into general expenses only as a placeholder (`docs/domain.md`, Open).
- `clients/example-widgets.json`: one company over two years. Its chart is a copy of the master
  chart. `rounding_priority` is its rounding priority list, and `retained_earnings` is its
  designated equity account for rollover.
  `assets` is its asset register; its depreciation journals aren't in the file, because the register
  generates them.

Amounts are integer cents, debits positive. `acct-core`'s fixture tests read these files at compile
time and snapshot the resulting ReportDocs. `make db-reset` loads them into the dev database through
the command pipeline (`acct-load-fixtures`), with dev users `admin`, `staff` and `viewer`, password
`fixture-password`.
