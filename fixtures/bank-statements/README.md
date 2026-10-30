# Synthetic bank statements

Sample statement files for the parsers in `crates/import`: bank accounts from M10, and NZD credit cards
from M11 (see "Credit cards" below). Synthetic only (CLAUDE.md hard rule 1): the people, businesses,
merchants, banks, card issuers and account numbers are invented, and the three CSV layouts are made up
rather than copied from any real bank's export. The `99-` bank code is unassigned. In the bank files,
where a real bank would put a card number, there are no digits at all; the card files name each card
only by an invented last four digits behind a mask.

## The fictional business

Q Marsh, a sole trader trading as Marsh Hollow Candles. Three bank accounts, at three invented banks:

| Account | Number | Files |
|---|---|---|
| Harbourlight Bank cheque account | 99-1001-0000123-00 | OFX and QIF |
| Kowhai Co-operative Bank business account | 99-5501-0000456-00 | CSV layout A, two files |
| Rimu Savings Society savings account | 99-7702-0000789-00 | CSV layout B, one file |

All dates fall in August and September 2025. Amounts are NZD with two decimals, and negative or debit
means money out. There are 33 distinct transactions across the 5 files (the files hold 37 lines,
because 4 are repeated across the overlap).

## Files

### `harbourlight-cheque-2025-08.ofx`
OFX 1.02 in SGML form (unclosed tags), 11 transactions, 1 to 31 August.
- A distinct `FITID` per line.
- Only a closing balance (`LEDGERBAL`, 2022.56 at 31 Aug). OFX has no opening balance, so
  opening + transactions = closing can't be checked from this file alone.
- The account number is in `ACCTID`, which is how the account gets matched.
- 29 Aug has **two identical purchases** (PIKORUA CAFE, -6.50, different `FITID`s). Both must survive
  import.
- 22 Aug is a transfer to the Kowhai account, matched by a credit in `kowhai-business-2025-08.csv`.

### `harbourlight-cheque-2025-08-28_09-30.qif`
QIF, 12 transactions, 29 Aug to 30 Sep. It follows the OFX for the same account and **overlaps it by
4 lines**, 29 to 31 Aug.
- The overlapping lines are the same transactions as in the OFX, with the description in different
  case and spacing (`Pikorua  Cafe` with two spaces against `PIKORUA CAFE`). Duplicate detection has to
  match them after normalising, and must keep exactly two of the identical 29 Aug purchases: not one
  (over-collapsed), and not four (no dedupe).
- QIF has no balances. The file uses the common convention of an `Opening Balance` entry dated 28 Aug
  (1883.56), which equals the OFX's closing balance less the OFX's last four lines. That lets the
  overlap be cross-checked, but a parser must treat the entry as optional, and it isn't a transaction.
- QIF has no closing balance, so the expected closing balance of 2247.12 at 30 Sep is derived, not
  stated in the file.
- The account number is only in the `!Account` header's name line, and the dates are dd/mm/yyyy. Days
  above 12 occur throughout, so the order can be inferred.
- Includes an ATM cash withdrawal (drawings) and a personal grocery purchase.

### `kowhai-business-2025-08.csv` (CSV layout A)
- 5 transactions for 1 to 31 Aug.
- A metadata preamble (bank, account name, account number, statement period, opening 1250.00 and closing
  2100.01), a blank line, then the header row `Date,Description,Debit,Credit,Balance`, then rows, then an
  `End of statement` trailer line.
- Debit and Credit are separate columns, each row has a running balance, and dates are dd/mm/yyyy.
- One quoted description contains a comma (`"FARO INSURANCE, PREMIUM"`).
- Opening + transactions = closing holds, so the balance check should pass.

### `kowhai-business-2025-09-10_09-30.csv` (CSV layout A)
- 5 transactions for 10 to 30 Sep. Same layout as the August file, and the **gap** case.
- The statement period starts on 10 Sep, so 1 to 9 Sep aren't covered.
- Its opening balance (2480.01) differs from the August closing balance (2100.01) by 380.00. That
  difference stands for transactions in the missing days, and flags the gap a second way.
- Within the file, opening + transactions = closing (2830.73) holds.
- Includes an `IRD GST REFUND` deposit, which M11 must be able to mark as not income.

### `rimu-savings-2025-08-29_09-30.csv` (CSV layout B)
- 4 transactions, 29 Aug to 30 Sep.
- A single header row with the columns `Account,Posted,Type,Payee,Particulars,Reference,Amount`, and no
  preamble or trailer.
- Dates are ISO (yyyy-mm-dd), the amount is one signed column, and the account number is in each row
  rather than in a header.
- No balances anywhere, so the balance check has to be skipped, not failed.
- One quoted field contains a comma (`"Top-up, from personal"`).
- Includes interest, a deposit that is the owner's own money going in, and a transfer out.

## What the files are meant to test

| Case | Where |
|---|---|
| Picking the parser by inspecting the file | all five |
| Two identical purchases on the same day both survive | `harbourlight-cheque-2025-08.ofx`, 29 Aug |
| Overlapping statement, same transactions in different case and spacing, changes nothing | the QIF after the OFX |
| Importing the same file twice changes nothing | any |
| Date gap flagged | the two Kowhai files |
| Balance check passes, fails or is skipped | passes for both Kowhai files, skipped for the OFX alone, the QIF and Rimu |
| Quoted commas | the Kowhai August file and the Rimu file |
| Debit/Credit columns against one signed column | layout A against layout B |

## Expected result after importing everything

| Account | Distinct transactions | Closing balance | Last statement date |
|---|---|---|---|
| 99-1001-0000123-00 | 19 | 2247.12 (derived) | 30 Sep |
| 99-5501-0000456-00 | 10 | 2830.73 | 30 Sep |
| 99-7702-0000789-00 | 4 | none | 30 Sep |

Importing the QIF after the OFX adds 8 transactions, not 12. Importing the Kowhai September file after
the August file adds 5 and raises a gap from 1 Sep to 9 Sep.

## Credit cards (M11)

The same fictional owner has two NZD credit cards. Card files are read as statements of kind
`credit_card`, and every amount is signed **from the card's point of view**, like a bank account: a
purchase, fee or interest is negative (money out), a payment to the card or a refund is positive (money
in), and a balance owed is negative. The rules are in `docs/domain.md`, "Bank statement formats".

| Card | Masked number | Files |
|---|---|---|
| Harbourlight Bank Visa | XXXX-XXXX-XXXX-4417 | OFX and QIF |
| Pohutukawa Card Services card | XXXX-XXXX-XXXX-8802 | CSV layout C, one file |

The tests are in `crates/import/src/bank/card_fixtures.rs`.

### `harbourlight-visa-2025-08.ofx`
OFX 2.2 in XML form, a `CREDITCARDMSGSRSV1` statement, 10 transactions, 1 to 31 August.
- `ACCTID` is the issuer's mask `XXXXXXXXXXXX4417`, read as `XXXX-XXXX-XXXX-4417`.
- Purchases, a 312.40 payment, a 18.50 refund, a USD purchase already converted to NZD (the memo holds
  the USD amount) with its overseas fee, and purchase interest.
- 30 Aug has **two identical purchases** (PIKORUA CAFE, -7.20, different `FITID`s). Both must survive.
- Only a closing balance: `LEDGERBAL` -265.09 at 31 Aug (owed). The derived opening balance is -312.40,
  which the 11 Aug payment clears. Balance check skipped.

### `harbourlight-visa-2025-08-29_09-30.qif`
QIF `!Type:CCard`, 9 transactions, 30 Aug to 28 Sep. It follows the OFX for the same card and
**overlaps it by 3 lines**, 30 to 31 Aug, written in different case and spacing.
- The card is named only in the `!Account` header (`Harbourlight Visa XXXX-XXXX-XXXX-4417`, type
  `CCard`) and the opening entry's category.
- `Opening Balance` entry dated 29 Aug, -247.74: the OFX's closing balance less its last three lines.
- Derived closing balance -403.04 at 30 Sep. Charges are negative and the 265.09 payment positive, as
  Quicken writes card files.

### `pohutukawa-card-2025-08-15_09-14.csv` (CSV layout C)
- 7 transactions, 15 Aug to 14 Sep.
- Preamble (issuer, cardholder, `Card number` masked by the issuer, statement period, opening 120.00,
  closing 1087.55, credit limit), a blank line, then the header
  `Processed,Transaction date,Details,Amount`, rows, and an `End of statement` trailer.
- Written the way the bill reads: amounts unsigned for charges, `CR` after credits (a refund and a
  payment), and balances positive when owed. The parser flips all of it, so the opening balance is
  -120.00 and the closing -1087.55, and opening + lines = closing holds.
- The posting date is `Processed`; `Transaction date` is a day or so earlier and isn't used.
- One quoted description contains a comma (`"KAURI PETROL, NELSON"`).

### What the card files test

| Case | Where |
|---|---|
| Detection: OFX card message set, QIF `CCard` section, CSV layout C | all three |
| Sign convention: purchases out, payments and refunds in, owed balances negative | all three |
| Flipping a bill-style CSV (`CR` credits) to card signs | the CSV |
| Card numbers masked to the last four digits | all three |
| Balance check passes, fails (wrong sign) or is skipped | passes for the CSV, skipped for the OFX and the QIF |
| Two identical purchases on the same day both survive | the OFX, 30 Aug |
| Overlap across formats dedupes | the QIF after the OFX adds 6, not 9 |

Expected after importing all three: 16 distinct transactions on XXXX-XXXX-XXXX-4417 (derived balance
-403.04 at 30 Sep) and 7 on XXXX-XXXX-XXXX-8802 (-1087.55 at 14 Sep).

More awkward OFX files (encodings, line endings, bad values, refused files) are in `ofx-edge/`; see its README.
