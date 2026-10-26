# MYOB export fixtures

Synthetic (CLAUDE.md hard rule 1). Ponga Lane Dog Grooming is a made-up sole trader. Every name,
card, phone number, email (`example.com`) and GST number (`000-…`, never a valid IRD number) is
invented. The files copy only the *layout* of MYOB's exports, not their sample files or wording
(hard rule 3). `crates/import/src/myob/` reads them, and its tests check them. `docs/domain.md`,
"Importing from Xero and MYOB", describes each layout and where it was documented.

Two years, balance date 31 March:

- FY2024 (1/04/2023 to 31/03/2024): opening bank $2,500.00, equipment $4,000.00 less $400.00
  depreciation, owner's capital $6,100.00. 19 transactions, profit $5,128.67.
- FY2025 (1/04/2024 to 31/03/2025): openings are FY2024's closing balance-sheet balances, with
  FY2024's profit in retained earnings (3-8000). 15 transactions, profit $3,443.48.

Each year's GL detail (openings plus postings) adds up to that year's TB account by account.

## `accountright/`: MYOB AccountRight (desktop)

- `accounts.txt`: File → Export Data → Accounts, tab separated, with a chosen subset of fields.
  Header accounts are marked `H`; 9-1000 is inactive.
- `tb-fy2024.csv`, `tb-fy2025.csv`: the Trial Balance report for March, exported as CSV, with the
  Account No. column added. Title rows, then the month's and the year to date's debits and credits,
  then a `Total:` row.
- `gl-fy2024.csv`, `gl-fy2025.csv`: the General Ledger [Detail] report for the year, exported as
  CSV. Grouped by account: a heading row with the beginning balance, the postings with a running
  ending balance, then a `Total:` row. Balances are positive on the account's normal side, so the
  accumulated depreciation and drawings balances are negative.
- `customer-cards.txt`, `supplier-cards.txt`: File → Export Data → Cards, tab separated. One
  customer card is inactive.

## `business/`: MYOB Business (browser)

- `accounts.txt`: the chart of accounts export (tab separated), with parent account numbers.
- `tb-fy2025.csv`: the Trial Balance's Excel export saved as CSV, titled "As of", without `$`.
- `gl-fy2025.csv`: the General Ledger detail's Excel export saved as CSV after repeating the account
  on every row, with `1-Apr-2024` style dates and no card names.
- `contacts.csv`: the Contacts report saved as CSV, with a contact type per row.

The Business layouts are less well documented than AccountRight's (see `docs/domain.md`), so they
need checking against real exports before we rely on them.
