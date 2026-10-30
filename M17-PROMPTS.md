# M17 agent prompts: OFX parser fixes

The OFX edge-case fixtures in `fixtures/bank-statements/ofx-edge/` (tests: `crates/import/tests/ofx_edge.rs`) turned up six gaps in the OFX parser. The `known_gaps` test pins each one as it behaves today. This milestone fixes them.

There are two waves.
- **Wave 1:** two agents work at once. They touch different files.
- **Wave 2:** one agent shows the new refusals to users properly. It needs Wave 1's new `Problem` variants.

The six gaps, by number (the ofx-edge README has the same list):
1. A **truncated download** (fixture 25) imports a half-read last amount as a real line and loses the closing balance. This is the only one that can put a wrong amount in the books, so do it first.
2. A **lower-case root tag** (04) isn't recognised.
3. **CDATA text is lost and numeric character references aren't decoded** (32).
4. A **sign-on error or an investment-only file** (20, 21) is refused as "ACCTID missing".
5. A **card file giving only the last four digits** (16b) isn't masked, so it won't match the same card from a CSV or QIF.
6. A **line with no description** (12) is accepted with an empty description.

Each prompt says which files that agent owns. Shared files (`crates/import/src/bank/mod.rs`, `packages/types`) are append-only: re-read just before editing, and add only your own lines.

**Migrations:** none are needed. If you think you need one, stop and ask.

**Hard rule 1 applies:** new fixtures are synthetic. Hard rules 4 and 5 apply to the parser: money is parsed to integer cents, never floats, and `crates/core` stays pure.

**Each fix flips its case in `known_gaps`.** When you fix a gap, move its assertions out of `known_gaps` into the test above it that covers that kind of thing, in the same change. Then update the "Known gaps" list in `fixtures/bank-statements/ofx-edge/README.md`.

## Wave 1: start both now

### Agent 1: the OFX tokenizer and detection (gaps 1, 2, 3)
```
Read CLAUDE.md, crates/import/src/bank/ofx.rs, crates/import/src/bank/mod.rs (Problem, read_statement), crates/import/tests/ofx_edge.rs (especially known_gaps) and fixtures/bank-statements/ofx-edge/README.md.
You own:
- crates/import/src/bank/ofx.rs
- crates/import/tests/ofx_edge.rs
- fixtures/bank-statements/ofx-edge/ (edit or add files; they are -text in .gitattributes, so keep their bytes)
- one new variant in the Problem enum in crates/import/src/bank/mod.rs (append-only)
Task:
1. Truncation (gap 1, fixture 25). SGML OFX may leave leaf tags unclosed, but aggregates (STMTTRN, BANKTRANLIST, STMTRS, OFX) are always closed. A file that ends without `</OFX>`, or while a STMTTRN is still open, is truncated. Refuse it with a new `Problem::Truncated` that says how far it got (the row, and the last transaction it read completely) and import nothing. Delete the code and comment that keeps a half-read last transaction. Add fixtures for a file cut inside a tag, inside a value, and cleanly after a complete STMTTRN but before `</OFX>`, in both SGML and XML. Then check whether the QIF and CSV parsers can import a cut-off file the same way, and write what you find in your report. Don't change them.
2. Detection (gap 2, fixture 04). Make `detect_sgml` and `detect_xml` case-insensitive for the `<OFX>` root and the header keywords, and keep the order they're tried in. Add a mixed-case file too.
3. Text (gap 3, fixture 32). Read CDATA as literal text, and decode numeric character references (`&#201;`, `&#xC9;`) along with the five named entities. A bad or out-of-range reference is left as written, not an error. Leave `&AMP;` in upper case alone (XML entities are case-sensitive) and say so in a comment.
Tests: every changed fixture goes through ofx_edge.rs as above, and nothing that passed before regresses. Run cargo test, clippy -D warnings and fmt for acct-import.
Don't commit.
```

### Agent 2: card masking across formats (gap 5)
```
Read CLAUDE.md, crates/import/src/bank/text.rs (normalise_card, normalise_account), crates/import/src/bank/qif.rs, crates/import/src/bank/pohutukawa.rs, crates/import/src/bank/card_fixtures.rs and fixtures/bank-statements/README.md (the Credit cards section).
You own:
- crates/import/src/bank/text.rs
- crates/import/src/bank/card_fixtures.rs
- new card-masking fixtures under fixtures/bank-statements/ofx-edge/ named 16e onwards, plus a QIF equivalent in fixtures/bank-statements/
Task:
1. Gap 5 (fixture 16b): an OFX card file whose ACCTID is just the last four digits stays `9999`, so it won't match the same card read from the CSV (`XXXX-XXXX-XXXX-9999`). Make a card statement's four-digit account id normalise to the usual masked form. Only for card statements: a bare four-digit id in a bank statement is not a card. If normalise_card can't tell the difference by itself, add a separate entry point that only the card paths call.
2. List every way each card format can spell its card (OFX, QIF credit card, Pohutukawa CSV). Add a fixture and a test for each spelling that isn't covered yet, and a test that the same card read from each format gives the same account string and so the same duplicate keys.
3. Never keep a full card number: say in a test that a 16-digit number gives only its last four.
Update ofx_edge.rs's `known_gaps` (gap 5) as the header of this file says; Agent 1 owns the rest of that file, so re-read it just before editing and touch only gap 5. Run cargo test, clippy -D warnings and fmt for acct-import.
Don't commit.
```

## Wave 2: after Agent 1 has finished

### Agent 3: say what's wrong with the file (gaps 4 and 6)
```
Read CLAUDE.md, crates/import/src/bank/ofx.rs, crates/import/src/bank/mod.rs (Problem, StatementError and their Display text), crates/import/tests/ofx_edge.rs and wherever the server and web app turn a Problem into text for the user (grep for UnsupportedSection and for `Problem` in crates/server and apps/web).
You own:
- the OFX sign-on and section handling in crates/import/src/bank/ofx.rs (Agent 1 is finished; re-read it)
- Problem variants and their messages in crates/import/src/bank/mod.rs
- the places that show a Problem to a user, in crates/server and apps/web
- crates/import/tests/ofx_edge.rs and the ofx-edge README
Don't hand-edit packages/types: run `make types`.
Task:
1. Gap 4 (fixtures 20, 21). Read the SONRS STATUS. A non-zero CODE (or SEVERITY ERROR) means the bank refused to give us a statement: refuse the file with a problem that carries the code and the bank's MESSAGE, and a plain-words explanation ("Your bank sent an error instead of a statement: 'Signon invalid'. Try downloading it again."). A file with no bank or card statement at all (only INVSTMTMSGSRSV1, or nothing) says what it holds instead, using the existing UnsupportedSection if that fits. Never say "ACCTID missing" for these.
2. Gap 6 (fixture 12). DECISION FOR ME: a transaction with neither NAME, MEMO nor PAYEE. Ask me before settling. The options are to refuse the file, to import with a placeholder description such as "(no description)", or to import it empty. Recommend one, with a reason. Then apply my answer, make the other parsers (QIF, the CSVs) do the same if they differ, and record it in docs/domain.md.
3. Show each new problem in the web upload screen in the same style as the existing ones, with the row number where there is one, and test the text.
Run `make check`.
Don't commit.
```

## When all three are done

Check that the `known_gaps` test is gone or empty, that the ofx-edge README's "Known gaps" list is empty or says "None", and that `make check` passes. Then re-run the fixtures through the import screen by hand once: fixture 25 (truncated) and 20 (bank error) should each refuse with a message a business owner could act on.

Note for the owner of PLAN.md: PLAN.md already has an "M17 — Admin 'view as' with real impersonation". Rename one of the two before work starts.
