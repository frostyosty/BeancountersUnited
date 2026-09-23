# 003: Statements are built as a ReportDoc

Status: accepted

## Context
Statements are shown as an HTML preview, printed to PDF, and stored as the record of what was signed when
a year is finalised. All three must agree exactly, and the stored record must never change.

## Decision
- `acct-core` builds a `ReportDoc`: sections, lines, current and prior amounts, styles, and the account
  codes behind each line.
- A ReportDoc refers to accounts by code and to lines by template key. It holds no generated ids,
  timestamps or HashMaps, so serialising it to JSON is byte-stable.
- The HTML preview and the PDF only render a ReportDoc. They do no arithmetic and make no layout decisions
  that change figures.
- Finalising a year stores the ReportDoc and a SHA-256 of its JSON. That stored document is never
  regenerated.
- Golden tests snapshot the ReportDoc JSON with insta. PDFs aren't snapshotted.

## Consequences
- The statement logic is testable without a browser, a database or a PDF engine.
- Drill-down works from the account codes stored on each line.
- Renderers can change freely without affecting signed figures. Changes to the ReportDoc's shape must
  keep old snapshots readable.
