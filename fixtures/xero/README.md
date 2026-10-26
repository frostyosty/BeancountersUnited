# Xero exports (synthetic)

Made-up Xero exports for an invented sole trader, Kereru Ridge Pottery: GST registered, with a
March balance date, over two years (FY2025 and FY2026). No real business or person is here; the
contacts' emails use `.example` domains and their GST numbers are invented.

| File | Export | Layout it exercises |
| --- | --- | --- |
| `chart-of-accounts.csv` | Chart of accounts | Xero's import template columns, `*` on required ones |
| `contacts.csv` | Contacts | Template columns; customer, supplier, both and other |
| `trial-balance-2025.csv` | Trial Balance at 31 Mar 2025 | `Account Code` column; YTD and month columns differ |
| `trial-balance-2026.csv` | Trial Balance at 31 Mar 2026 | Code in the account cell (`Sales (200)`), sections and totals |
| `account-transactions-2025.csv` | Account Transactions, FY2025 | Grouped by account; no openings (first year) |
| `account-transactions-2026.csv` | Account Transactions, FY2026 | Openings in the running balance, credits in brackets |

The figures:
- Amounts are in dollars and cents, as Xero writes them, with thousands separators.
- Each year's TB equals its Account Transactions: each account's opening balance plus its postings
  (`acct_import::xero` tests, `the_gl_detail_sums_to_the_tb`).
- FY2025 profit is $16,520.53 and FY2026's is $16,709.29. FY2026's retained earnings (960) are
  FY2025's profit, and so is the opening balance its Account Transactions gives for 960.
- GST is 3/23 of each GST-inclusive amount, rounded half away from zero to the cent. GST is paid to
  nil at the end of October and of March.
- Depreciation is 25% diminishing value on the kiln, posted by a manual journal on 31 March.

The layouts are described in `docs/domain.md`, "Importing from Xero and MYOB". The files came from a
throwaway script and are kept as written. Edit them by hand only if the totals still agree, and
re-run the `acct-import` tests afterwards.
