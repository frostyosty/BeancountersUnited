# OFX edge-case fixtures

Synthetic OFX files for hunting parser bugs (CLAUDE.md hard rule 1). Everything is invented: the bank,
merchants, `99-` account numbers and `9999` card digits. The shapes are the quirks real exports have, written
from the OFX spec and from how NZ banks and Quicken-style exporters are known to behave. None is a copy of a
real bank's file. Tested by `crates/import/tests/ofx_edge.rs`, which fails if a file here has no test naming it.

Don't convert line endings or encodings: `.gitattributes` marks this folder `-text` because some files are
deliberately CR-only, CRLF or Windows-1252. They were produced by a throwaway shell script; edit the files directly.

| Files | What they cover |
|---|---|
| 01–04 | Layout: bare `<OFX>` with no header; every leaf closed plus CRLF; CR-only endings; lower-case tags with tabs |
| 05 | OFX 2 XML; NZST/NZDT/GMT/EST stamps around the 28 Sep 2025 clock change. Dates are read as written, never converted |
| 06–07 | Windows-1252 bytes (é, ’, –, £, a `?` where a macron was lost); UTF-8 with a BOM and real macrons |
| 08, 32 | Ampersands bare and escaped, XML entities, CDATA, numeric references, comments |
| 09, 09b, 31 | Valid amount spellings (`+10.00`, `.50`, `-0`, `12.500`), decorated ones (`1,234.56`, `$12.00`, `(12.00)`), and extremes |
| 10 | `TRNTYPE` contradicting the sign of `TRNAMT` (the sign wins) |
| 11 | Repeated, missing and empty `FITID`; identical same-day lines |
| 12 | `NAME`, `MEMO` and `PAYEE` in every combination, including none |
| 13, 30 | A statement spanning 31 March; leap day, year ends, and 29 Feb in a non-leap year |
| 14a–e | `ACCTID` spellings: bare digits, spaces, 3-digit suffix, 8-digit base, padding, not a number |
| 15, 16a–d | Credit cards: masked, stars and spaces, last four only, a full number, a bank-style id |
| 17, 18 | Elements we ignore (`CHECKNUM`, `CORRECTFITID`, `ORIGCURRENCY`, `AVAILBAL`) |
| 19a–c | No transactions; no period or balance; lines netting to zero |
| 20–21 | A sign-on error with no statement; an investment-only file |
| 22–24 | Bank plus card in one file; two accounts; USD, lower-case and empty currency |
| 25–29 | Truncated mid-transaction; bad dates, bad amounts, missing fields, missing `ACCTID` |
| 33–36 | Not OFX: an HTML error page, an empty file, a header with no body, a CSV |
| 37, 38a–c | Quicken `INTU.*` tags; odd headers; leading blank lines |
| 39 | An ordinary month whose lines add up to the closing balance |

## Known gaps

`known_gaps` in the test pins these as they behave today. Fixing one makes that test fail on purpose.

1. **Lower-case root tag** (04): `detect_sgml` wants `<OFX>`, so the file isn't recognised, though the tokenizer already upper-cases tags.
2. **Truncated download** (25): the half-written last transaction is imported as a real line (`-7.0`, probably `-7.05`) and the closing balance is silently missing. This one can put a wrong amount in the books.
3. **CDATA and numeric references** (32): CDATA text is lost and `&#201;` is not decoded.
4. **Sign-on error / investment-only** (20, 21): refused as "ACCTID missing", which doesn't say what's wrong.
5. **Card with last four only** (16b): the account stays `9999` rather than `XXXX-XXXX-XXXX-9999`, so it won't match the same card from a CSV or QIF.
6. **Lines with no description** (12): accepted with an empty description.
