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

## Figures (worked out 2026-11-05, pinned)

Each example is set up as a sole trader whose books start on the first day of the statement (so there's no
gap to estimate), GST registered from that day if the business is, on the payments basis. Example 1 files
two-monthly with periods ending in odd months (its payment is "GST AUG-SEP"); Example 3 with periods
ending in even months ("GST MAY-JUN", "GST REFUND JUL-AUG"); Example 2 isn't registered.
`crates/server/src/examples.rs` imports the file through `import_statement` into a throwaway store and
reads `save_tax::queue`, so the figures are the engine's, not a second calculation. The parser writes
Example 2's account as `99-3305-0098765-02` (it shortens the three-digit suffix).

| | Example 1 | Example 2 | Example 3 |
|---|---|---|---|
| Tax to pay, conservative (nothing answered) | **$5,307.98** | **$8,096.82** | **$32,890.09** |

Then the top card of the Save tax queue is answered, three times, each time the first card the queue
offers and with the answer the lines above imply. The figure after each answer:

| Step | Example 1 | Example 2 | Example 3 |
|---|---|---|---|
| 1 | Only income: yes → $2,050.81 | Only income: yes → $1,686.32 | Only income: yes → $18,188.54 |
| 2 | The GST payment → $2,050.81 | The $1,500 income tax paid → $186.32 | $20,000 transfer in from savings → $10,449.40 |
| 3 | A card settlement is income → $2,050.81 | A client invoice is income → $186.32 | The van, with its tax invoice → $6,699.40 |

Steps that don't move the figure are right, not broken: the card's saving is a best case, and the honest
answer (income, or a GST payment for a period before the statement) saves nothing. The tests that pin
these are `crates/server/tests/examples.rs`; `crates/server/tests/m20.rs` will pin them again through guests.
