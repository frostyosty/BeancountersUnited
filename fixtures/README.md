# Fixtures

Synthetic data only (CLAUDE.md hard rule 1). No real client, person or business appears here; names
and figures are made up.

- `practice/`: practice-level defaults for companies: the master chart, the statement template
  (our own wording) and the mapping.
- `clients/example-widgets.json`: one company over two years. Its chart is a copy of the master
  chart. `rounding_priority` is its rounding priority list, and `retained_earnings` is its
  designated equity account for rollover.

Amounts are integer cents, debits positive. `acct-core`'s fixture tests read these files at compile
time and snapshot the resulting ReportDocs. From M2, `make db-reset` loads them through the command
pipeline.
