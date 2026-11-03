# OFX edge-case fixtures

Synthetic OFX files for hunting parser bugs (CLAUDE.md hard rule 1). Everything is invented: the bank,
merchants, `99-` account numbers and `9999` card digits. The shapes are the quirks real exports have, written
from the OFX spec and from how NZ banks and Quicken-style exporters are known to behave. None is a copy of a
real bank's file. Tested by `crates/import/tests/ofx_edge.rs`, which fails if a file here has no test naming it.

Don't convert line endings or encodings: `.gitattributes` marks this folder `-text` because some files are
deliberately CR-only, CRLF or Windows-1252. They were produced by a throwaway shell script; edit the files directly.

| Files | What they cover |
|---|---|
| 01–04, 04b–c | Layout: bare `<OFX>` with no header; every leaf closed plus CRLF; CR-only endings; lower-case tags with tabs; a mixed-case SGML header and tags; a lower-case XML declaration and root |
| 05 | OFX 2 XML; NZST/NZDT/GMT/EST stamps around the 28 Sep 2025 clock change. Dates are read as written, never converted |
| 06–07 | Windows-1252 bytes (é, ’, –, £, a `?` where a macron was lost); UTF-8 with a BOM and real macrons |
| 08, 32, 32b | Ampersands bare and escaped, XML entities, CDATA, numeric references, comments; references left as written (bad, out of range, upper-case names) |
| 09, 09b, 31 | Valid amount spellings (`+10.00`, `.50`, `-0`, `12.500`), decorated ones (`1,234.56`, `$12.00`, `(12.00)`), and extremes |
| 10 | `TRNTYPE` contradicting the sign of `TRNAMT` (the sign wins) |
| 11 | Repeated, missing and empty `FITID`; identical same-day lines |
| 12 | `NAME`, `MEMO` and `PAYEE` in every combination, including none |
| 13, 30 | A statement spanning 31 March; leap day, year ends, and 29 Feb in a non-leap year |
| 14a–e | `ACCTID` spellings: bare digits, spaces, 3-digit suffix, 8-digit base, padding, not a number |
| 15, 16a–d | Credit cards: masked, stars and spaces, last four only, a full number, a bank-style id |
| 16e–j | More card spellings: stars with no gaps, lower-case `x` with dashes, a short mask `****9999`, a full number with spaces, last four only in XML; and a bank file whose `ACCTID` is four digits (not a card). The same card in QIF and CSV is tested in `crates/import/src/bank/card_fixtures.rs` |
| 17, 18 | Elements we ignore (`CHECKNUM`, `CORRECTFITID`, `ORIGCURRENCY`, `AVAILBAL`) |
| 19a–c | No transactions; no period or balance; lines netting to zero |
| 20–21 | A sign-on error with no statement; an investment-only file |
| 22–24 | Bank plus card in one file; two accounts; USD, lower-case and empty currency |
| 25, 25b–g | Cut-off downloads, SGML and XML: inside a value, inside a tag, after a whole transaction, and (25g) everything but `</OFX>` |
| 26–29 | Bad dates, bad amounts, missing fields, missing `ACCTID` |
| 33–36 | Not OFX: an HTML error page, an empty file, a header with no body, a CSV |
| 37, 38a–c | Quicken `INTU.*` tags; odd headers; leading blank lines |
| 39 | An ordinary month whose lines add up to the closing balance |

## Known gaps

None. M17 fixed the six these files found; how each was fixed is kept below. A new gap gets a `known_gaps`
test in `ofx_edge.rs` that pins today's behaviour, and a line here.

1. ~~**Lower-case root tag** (04)~~: fixed in M17. Detection ignores case for the root and the header keywords (04b, 04c).
2. ~~**Truncated download** (25)~~: fixed in M17. A file that ends before `</OFX>` or inside a `STMTTRN` is refused as `truncated`, with the row it stops on and the last whole transaction, and nothing is imported (25b–g).
3. ~~**CDATA and numeric references** (32)~~: fixed in M17. CDATA is read as literal text, `&#201;` and `&#xC9;` are decoded, text after a comment is kept, and a bad reference is left as written (32b).
4. ~~**Sign-on error / investment-only** (20, 21)~~: fixed in M17. A `STATUS` error is refused as `bank_error` with the bank's code and words; a file with no bank or card statement says what it holds (`unsupported_section`) or that it has none (`no_statement`).
5. ~~**Card with last four only** (16b)~~: fixed in M17. A card statement's four-digit `ACCTID` is masked to `XXXX-XXXX-XXXX-9999`; a bank statement's (16j) is left alone.
6. ~~**Lines with no description** (12)~~: decided in M17 (docs/domain.md): kept, with an empty description. The web app shows it as "(no description)".
