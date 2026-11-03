# Landing-page example statements (M20)

Three handcrafted OFX files a visitor can drag onto "Upload bank statements" on the home page. Synthetic
only (CLAUDE.md hard rule 1): the people, businesses, merchants, banks and account numbers are invented, the
`99-` bank code is unassigned, and every bank's `ORG` ends in "(SYNTHETIC)". Made 2026-11-04 by
`generate.py` (integer cents; edit the lines there and rerun it rather than hand-editing the files); each file's `LEDGERBAL` equals the opening balance below
plus its lines, exactly.

Together they cover the shapes NZ banks' OFX downloads usually take, so the demo exercises the real parser:

| | Example 1 | Example 2 | Example 3 |
|---|---|---|---|
| Business | Tūī Street Coffee, a coffee cart | Matai Design Studio, a freelance designer | Kahu Electrical, an electrician |
| GST | Registered (two-monthly) | Not registered | Registered (two-monthly) |
| Bank | Piwakawaka Bank | Tōtara Mutual Bank | Kea Trust Bank |
| Account | `99-2101-0045617-00` | `99-3305-0098765-002` (three-digit suffix) | `99 4410 0023456 00` (spaces) |
| Period | 1–31 Oct 2025 (one month) | 1 Aug – 30 Sep 2025 (two months) | 1 Jul – 30 Sep 2025 (a quarter) |
| Format | OFX 1.02 SGML, LF, unclosed leaf tags, date-only `DTPOSTED`, ASCII | OFX 2.2 XML, UTF-8 with macrons, NZ time zones crossing the 28 Sep daylight-saving change, `&amp;` | OFX 1.02 SGML, CRLF, every leaf closed, times on `DTPOSTED`, `CHECKNUM` |
| Balances | `LEDGERBAL` and equal `AVAILBAL` | `AVAILBAL` $48 below `LEDGERBAL` (a pending debit) | `LEDGERBAL` only |
| Lines | 27 | 24 | 41 |
| Opening → closing | 3,184.20 → 7,969.08 | 2,410.55 → 10,435.47 | 6,842.90 → 25,258.58 |

What each gives Save tax to find (the conservative figure counts every deposit as income and claims nothing):
- **Example 1:** card-terminal settlements (income), roaster, dairy, stall fees, fuel and cups (expenses), a
  supermarket shop and an ATM withdrawal (personal), a $1,000 family loan (not income), a $1,380 grinder
  (an asset), a transfer to savings, and a GST payment to IRD.
- **Example 2:** client invoices paid by direct credit (income), $2,400 from a partner (not income), rent
  (personal, or part home office), software, internet and printing (expenses), a $1,899 laptop (an asset),
  $1,500 of income tax already paid to IRD (a credit), and a transfer to savings.
- **Example 3:** customer payments and builder progress claims (income), trade supplies and a supplier
  credit note, a $20,000 transfer in from savings (not income), a $28,750 van (an asset), a $3,961.33 GST
  refund (not income), a GST payment, the ACC levy, a practising licence, insurance, a cheque, ATM cash and a
  supermarket shop.

The tax figures each example gives, before and after Save tax, are pinned by `crates/server/tests/m20.rs`
once M20's Agent 2 has run them through the tax engine; record them here then.
