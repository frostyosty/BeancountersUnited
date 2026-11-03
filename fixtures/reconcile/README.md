# Reconciliation fixtures (M18)

Synthetic statements for M18, "Every upload reconciles, or says why" (`PLAN.md`): a clean set
that agrees with the ledger at every balance the bank states, and one variant per suspect, each
the clean set plus exactly one fault. Synthetic only (CLAUDE.md hard rule 1): the business, the
owner, the merchants and the account numbers are invented, at the fictional banks of
`fixtures/bank-statements/`. The `99-` bank code is unassigned.

**Everything here is generated.** Edit `generate.py` and run `python fixtures/reconcile/generate.py`;
it rewrites every fixture directory and this README, the same way every run. It simulates the
ledger the way the server builds it (M10's exact duplicate key, the opening balance from the first
statement reaching the start date unless the owner typed one first, a line resolved as a duplicate
posting nothing, a gap journal for the change across days no statement covers) and the
checkpoints the way core walks them (only balances a file states, on the dates it states them, and
a running balance only where the file confirms it's the end of its day), and refuses to write a
fixture whose fault doesn't add up.
`crates/import/tests/reconcile_fixtures.rs` reads every file with the real parsers and checks the
clean set and the line references against them.

## The business

J Pettigrew, a sole trader trading as Ferncliff Joinery. Start date 1 Apr 2025, balance date 31 Mar 2026, not
registered for GST. Two accounts, added in this order, so their codes are fixed:

| Key | Account | Number | Code | Opening, 1 Apr 2025 | Closing, 31 Mar 2026 | Lines |
|---|---|---|---|---|---|---|
| `cheque` | Kowhai Co-operative Bank cheque account (`AddBankAccount`) | 99-5501-0000612-00 | 600.01 | 3,264.85 | 8,452.30 | 120 |
| `card` | Harbourlight Bank Visa (`AddCardAccount`) | XXXX-XXXX-XXXX-5290 | 850.01 | -318.60 | -499.49 | 101 |

Card amounts are signed from the card's point of view (a balance owed is negative), as in
`fixtures/bank-statements/README.md`. Each month the cheque account pays the card's balance in full
on the 24th (`PAYMENT TO HARBOURLIGHT VISA 5290` out, `PAYMENT RECEIVED` in on the card).

## The clean set (`clean/`)

`clean/fixture.toml` has the setup (business, accounts), the 16 uploads in order, the commands to
replay, and the expected closing balances. Every opening, closing and running balance agrees with
the ledger (143 on the cheque account, 4 on the card), and so does 31 March.

| Files | Format | What the file states |
|---|---|---|
| `kowhai-cheque-YYYY-MM.csv` (12) | Kowhai CSV (layout A), one per month | opening, closing, and a running balance on every row |
| `visa-2025-04-01_06-30.ofx` | OFX 2.2 (XML) card statement | closing only (`LEDGERBAL` 30 Jun) |
| `visa-2025-07-01_09-28.qif` | QIF `!Type:CCard` | opening entry only (start of 1 Jul) |
| `visa-2025-09-27_12-31.qif` | QIF `!Type:CCard` | opening entry only (start of 27 Sep) |
| `visa-2026-01-01_03-31.ofx` | OFX 1.02 (SGML) card statement | closing only (`LEDGERBAL` 31 Mar) |

Things the clean set holds on purpose:
- **At most one cheque line a day**, so a running balance is also the balance at the end of its day,
  whichever way same-day lines are ordered.
- **Two identical purchases on 19 Sep 2025** on the card (`PIKORUA CAFE WELLINGTON`, -7.20 each, in
  the July to September QIF). Both are real. The duplicates suspect must not flag them as Likely.
- **An overlap that M10 flags.** The July to September QIF was downloaded on 28 Sep, before a late
  `WOODMILL HARDWARE` -64.80 posted that day. The next QIF starts at 27 Sep, so its 27 and 28 Sep
  lines repeat (M10's key drops them) and the late line is new but flagged a possible duplicate.
  The clean set replays `ResolveDuplicate` with `is_duplicate = false` for it; 05 says yes instead.
- **Opening balances come from the files**: the April CSV states the cheque account's, and the
  card's is the first OFX's closing balance less its lines. Nobody types one, except in 03, 10
  and 11.

## How a fixture is described

Each variant has a `fault.toml` beside its files:
- `setup`: the business and accounts, always `../clean/fixture.toml`.
- `[[faults]]`: the `suspect` (PLAN.md's list, in snake case), the `account`, `explains_cents` (the
  part of the difference it accounts for), `confidence`, a `summary`, the `evidence` (lines by file,
  row, date, amount and description as the parser reads them; statements by file name; gaps; the
  command that caused it) and the `fix` that clears it, which is the one its suspect suggests. One
  entry, except in 11, and none in 02.
- `[[notes]]`: as `[[faults]]`, for a finding that explains nothing because the books agree
  (`explains_cents = 0`). Only 02 has one: a gap the server already filled with a gap journal.
- `[[expected]]`: per account that's out, the `difference_cents` at `proof_date` (the last stated
  balance on or before it), the `shape` (`jump`, `constant` or `drifting`), and the window: the
  stated balance that `last_agrees` and the one that `first_differs`.
- `[[uploads]]`: every file in upload order, with `choose_account = true` where the upload must send
  `bank_account_id` (the file names no account), and how many lines M10 should add.
- `[[commands]]`: commands to replay `before_uploads` or `after_uploads`, with `fault = true` on the
  one that is the fault. Accounts are named by key (`cheque`, `card`), and lines as in evidence.

Amounts are integer cents. A difference is the ledger less the bank's stated balance, as
`acct_core::reconcile` reports it. An opening balance is the balance at the start of its date, a
closing or running balance the balance at the end of its date.

## Faults

Differences are at 31 Mar 2026, ledger less bank. Only the account named is out; the other agrees
everywhere. 02 isn't here: nothing differs (see its note below).

| Fixture | Suspect | What's wrong | Account | Difference | Shape | Last agrees | First differs |
|---|---|---|---|---|---|---|---|
| `01a-duplicates-two-names` | `duplicates` | Duplicates: the same month downloaded twice, under two names, NAME against MEMO. | card | -22.50 | jump | 2025-09-27 (start of day), visa-2025-09-27_12-31.qif opening balance | 2026-03-31 (end of day), visa-2026-01-01_03-31.ofx closing balance (LEDGERBAL) |
| `01b-duplicates-posting-date` | `duplicates` | Duplicates: an overlap where one file uses the posting date and the other the transaction date. | card | -99.60 | jump | 2025-06-25 (start of day), visa-activity-2025-06-25_06-30.qif opening balance | 2025-06-30 (end of day), visa-2025-04-01_06-30.ofx closing balance (LEDGERBAL) |
| `03-wrong-opening-balance` | `wrong_opening_balance` | Wrong opening balance: typed by the owner, so the first statement's isn't used. | cheque | -264.85 | constant | none: out from the first balance | 2025-04-01 (start of day), kowhai-cheque-2025-04.csv opening balance |
| `04-sign-wrong-way` | `sign_wrong_way` | Sign the wrong way: a CSV's debit and credit columns read the wrong way round. | cheque | -976.36 | jump | 2025-11-01 (start of day), kowhai-cheque-2025-11.csv opening balance | 2025-11-28 (end of day), kowhai-cheque-2025-11.csv row 18 running balance |
| `05-marked-duplicate-but-isnt` | `marked_duplicate_but_isnt` | Marked duplicate but isn't: the owner answered yes for a line M10 flagged. | card | 64.80 | jump | 2025-09-27 (start of day), visa-2025-09-27_12-31.qif opening balance | 2026-03-31 (end of day), visa-2026-01-01_03-31.ofx closing balance (LEDGERBAL) |
| `06-entries-by-hand` | `entries_by_hand` | Entries by hand: a journal on the bank account that no statement line matches. | cheque | 350.00 | jump | 2025-10-12 (end of day), kowhai-cheque-2025-10.csv row 12 running balance | 2025-10-15 (end of day), kowhai-cheque-2025-10.csv row 13 running balance |
| `07-date-cut-off` | `date_cut_off` | Date cut-off: a line the file dates after its closing balance, which includes it. | card | 85.90 | jump | 2025-09-27 (start of day), visa-2025-09-27_12-31.qif opening balance | 2026-03-31 (end of day), visa-2026-01-01_03-31.ofx closing balance (LEDGERBAL) |
| `08-wrong-account` | `wrong_account` | Wrong account: the owner's personal account file uploaded to the business cheque account. | cheque | -187.88 | drifting | 2025-11-01 (start of day), kowhai-cheque-2025-11.csv opening balance | 2025-11-01 (start of day), everyday-2025-11.qif opening balance |
| `09-amount-read-wrong` | `amount_read_wrong` | Amount read wrong: cents read as dollars. | cheque | -3,959.01 | jump | 2026-02-12 (end of day), kowhai-cheque-2026-02.csv row 12 running balance | 2026-02-18 (end of day), kowhai-cheque-2026-02.csv row 14 running balance |
| `10-transposed-digits` | `transposed_digits` | Transposed digits: the card's opening balance typed as 381.60 owed, not 318.60. | card | -63.00 | constant | none: out from the first balance | 2025-06-30 (end of day), visa-2025-04-01_06-30.ofx closing balance (LEDGERBAL) |
| `11-two-faults` | `wrong_opening_balance` + `duplicates` | Two faults on the cheque account: a wrong opening balance and one duplicate. | cheque | -655.14 | drifting | none: out from the first balance | 2025-04-01 (start of day), kowhai-cheque-2025-04.csv opening balance |

Notes on particular fixtures:
- **01a and 01b** are both duplicates: 01a a second export of March whose NAME holds the
  transaction type and MEMO the merchant (same FITIDs), 01b a "recent activity" QIF dated by the
  purchase date, overlapping an OFX dated by the posting date. The 19 Sep identical pair is in
  both, and isn't a duplicate. Every line of 01b's activity file repeats the OFX, so its fix is to
  remove that statement, as the suspect suggests, rather than mark each line.
- **02** has no fault. With August missing, the server posts the change across the gap
  (419.18 out) as one gap journal on 31 Aug, so the ledger agrees with every balance the bank
  states and Bank vs books says it agrees. Missing lines reports the gap as a note that explains
  nothing (`[[notes]]`), offering the August upload, which reverses the gap journal and posts the
  lines instead (`docs/domain.md`, "Bank vs books").
- **03 and 11** type the cheque account's opening balance (3,000.00) before the first upload, so the
  April statement's 3,264.85 isn't used. The difference doesn't divide by 9.
- **10** types the card's opening as -381.60 for -318.60: 63.00 divides by 9, and swapping the 1 and
  the 8 gives it. `wrong_opening_balance` also explains it; `transposed_digits` is more specific
  and must rank first.
- **04 and 09** fail `Statement::balance_check` on purpose (at the first row, and at the TELEWAVE
  MOBILE row). Every other file passes it, or skips it because the format states only one end.
  In 04 the swapped file's running balances don't follow from the amounts read, so only its last
  (which the closing balance confirms) is a checkpoint, and the difference jumps once.
- **07**'s line is dated 1 Apr 2026, so it lands in the year to 31 March 2027.
- **08**'s file names no account, so the upload chooses the cheque account
  (`choose_account = true`). A file naming another account would be refused (`wrong_bank_account`).
- **11** re-downloads 20 to 30 June on the cheque account. Three of its lines match exactly; the card
  payment's text is cut short (`PAYMENT TO HARBOURLI`), so M10's key misses it. With the typed
  opening balance, the two amounts add up to the difference exactly.

**Worked-out balances aren't checkpoints here.** M10 stores a balance for both ends of every
statement, working out the end the file doesn't state (opening + lines, or closing − lines). The
windows above count only balances the files state. A worked-out balance can't disagree with its own
file, only with a later upload, and in the clean set one does: `visa-2025-07-01_09-28.qif` was
downloaded on 28 Sep before the late `WOODMILL HARDWARE` -64.80 posted, so its worked-out closing
for 28 Sep is 64.80 more than the ledger's, while every stated balance agrees. That's what a
mid-day download looks like at a real bank, and an OFX's stated `LEDGERBAL` taken then would be off
the same way. If core counted worked-out balances, the clean set would show a window at 28 Sep, and
10's `constant` shape would break there.

## Fixes, and the commands they need

Each `fix` is the one its suspect suggests (`crates/import/tests/reconcile_suspects.rs` checks it).
Some need commands M18 Agent 6 adds or extends:

| Fix | Fixtures | Command |
|---|---|---|
| `RemoveStatement` | 01a, 01b, 04 (then upload the clean file), 08 | `remove_statement`: new (Agent 6) |
| `SetOpeningBalance` | 03, 10, 11 | correcting an opening balance that's already set: new (Agent 6); `set_opening_balance` only sets one once |
| `MarkDuplicate` | 11 | `resolve_duplicate` with `is_duplicate = true` (the line is flagged) |
| `UnmarkDuplicate` | 05 | `resolve_duplicate` with `is_duplicate = false` |
| `ReverseJournal` | 06 | `reverse_journal` |
| `UploadMissing` | 02 (a note) | `import_statement` of the missing file |
| none | 07, 09 | nothing to send: the owner or accountant decides |
