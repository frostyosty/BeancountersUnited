//! The OFX parser against the awkward files in `fixtures/bank-statements/ofx-edge` (see its README).
//!
//! `known_gaps` pins behaviour we think is wrong. When one is fixed, that test fails: move the
//! case to the right place above it and update the README.

use std::collections::BTreeSet;
use std::path::PathBuf;

use acct_import::bank::{
    Problem, Statement, StatementError, StatementKind, duplicate_keys, read_statement,
};

fn dir() -> PathBuf {
    [
        env!("CARGO_MANIFEST_DIR"),
        "../../fixtures/bank-statements/ofx-edge",
    ]
    .iter()
    .collect()
}

fn try_read(name: &str) -> Result<Statement, StatementError> {
    let path = dir().join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    read_statement(&bytes)
}

fn ok(name: &str) -> Statement {
    try_read(name).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

fn problems(name: &str) -> Vec<Problem> {
    match try_read(name) {
        Err(StatementError::Invalid { problems, .. }) => problems,
        other => panic!("{name}: expected problems, got {other:?}"),
    }
}

fn not_recognised(name: &str) {
    match try_read(name) {
        Err(StatementError::NotRecognised { .. }) => {}
        other => panic!("{name}: expected NotRecognised, got {other:?}"),
    }
}

/// (date, cents, description) for each line.
fn lines(s: &Statement) -> Vec<(String, i64, String)> {
    s.lines
        .iter()
        .map(|l| (l.date.to_string(), l.amount.cents(), l.description.clone()))
        .collect()
}

fn cents(s: &Statement) -> Vec<i64> {
    s.lines.iter().map(|l| l.amount.cents()).collect()
}

fn descriptions(s: &Statement) -> Vec<&str> {
    s.lines.iter().map(|l| l.description.as_str()).collect()
}

const ACCOUNT: &str = "99-1001-0000123-00";

#[test]
fn layout_and_line_ending_variants_read_the_same_lines() {
    let bare = ok("01-sgml-bare-no-header.ofx");
    assert_eq!(bare.parser, "ofx-sgml-1");
    assert_eq!(bare.account.as_deref(), Some(ACCOUNT));
    assert_eq!(cents(&bare), [-8640, 25000]);
    assert_eq!(bare.period_start, None, "a bare file may have no period");
    assert_eq!(bare.closing.unwrap().amount.cents(), 16360);

    // Every leaf closed, with CRLF endings.
    let closed = ok("02-sgml-crlf-all-leaves-closed.ofx");
    assert_eq!(closed.parser, "ofx-sgml-1");
    assert_eq!(
        lines(&closed),
        [
            ("2025-08-06".to_owned(), -1230, "PIKORUA CAFE".to_owned()),
            (
                "2025-08-07".to_owned(),
                9900,
                "AMBER & ASH BOUTIQUE".to_owned()
            ),
        ]
    );

    // Old Mac CR-only endings.
    let cr = ok("03-sgml-cr-only-line-endings.ofx");
    assert_eq!(cents(&cr), [-500, 1500]);
    assert_eq!(cr.period_end.unwrap().to_string(), "2025-08-31");
}

#[test]
fn headers_that_are_sloppy_still_read() {
    for name in [
        "38a-header-utf8-charset-none.ofx",
        "38b-header-trailing-spaces.ofx",
        "38c-leading-blank-lines.ofx",
        "37-qfx-intuit-tags.ofx",
    ] {
        let s = ok(name);
        assert_eq!(s.account.as_deref(), Some(ACCOUNT), "{name}");
        assert_eq!(cents(&s), [-500], "{name}");
        assert_eq!(s.closing.unwrap().amount.cents(), 1000, "{name}");
    }
}

#[test]
fn dates_are_the_dates_as_written_whatever_the_time_zone() {
    let s = ok("05-xml-nz-timezones.ofx");
    assert_eq!(s.parser, "ofx-xml-1");
    let dates: Vec<String> = s.lines.iter().map(|l| l.date.to_string()).collect();
    // 23:59:59 NZST on the 27th stays the 27th; an EST stamp at 23:59:59 on the 30th is not
    // moved to the 1st; nothing is converted.
    assert_eq!(
        dates,
        ["2025-09-27", "2025-09-28", "2025-09-30", "2025-09-30"]
    );
    assert_eq!(s.period_start.unwrap().to_string(), "2025-09-27");
    assert_eq!(s.period_end.unwrap().to_string(), "2025-09-30");
    assert_eq!(s.closing.unwrap().date.to_string(), "2025-09-30");
}

#[test]
fn text_encodings_are_decoded() {
    // Windows-1252 bytes: the accent, curly apostrophe, en dash and pound sign survive.
    let w = ok("06-sgml-windows-1252-bytes.ofx");
    assert_eq!(
        descriptions(&w),
        [
            "CAFÉ DU PARC MARSH’S ORDER – REF 7",
            "M?ORI ARTS COLLECTIVE PARKING £ COIN"
        ]
    );

    // UTF-8 with a byte-order mark keeps its macrons.
    let u = ok("07-xml-utf8-bom-macrons.ofx");
    assert_eq!(u.parser, "ofx-xml-1");
    assert_eq!(
        descriptions(&u),
        ["MĀORI ARTS COLLECTIVE WHAKATŪ — NELSON ŌTAKI"]
    );
}

#[test]
fn xml_entities_are_decoded_and_bare_ampersands_are_left_alone() {
    let s = ok("08-entities-and-ampersands.ofx");
    assert_eq!(
        descriptions(&s),
        [
            "AMBER & ASH",
            "AMBER & ASH",
            "SMITH &AMP; SONS A&B&C",
            "LESS < MORE > \"QUOTED\" 'X'",
            "TRAILING &",
        ]
    );
}

#[test]
fn comments_inside_text_are_dropped() {
    let s = ok("32-xml-cdata-and-numeric-references.ofx");
    assert_eq!(s.lines[2].description, "WITH A COMMENT");
}

#[test]
fn amount_spellings() {
    let s = ok("09-amount-spellings.ofx");
    assert_eq!(
        cents(&s),
        [1000, -5, 123_450, -123_450, 10_000, 1250, 0, 0, 50, -25]
    );
    let d = ok("09b-amount-decorations.ofx");
    assert_eq!(cents(&d), [123_456, 1200, -1200]);
    let big = ok("31-extreme-amounts.ofx");
    assert_eq!(cents(&big), [99_999_999_999, -99_999_999_999, -1, 1]);
}

#[test]
fn the_sign_of_trnamt_wins_over_trntype() {
    let s = ok("10-trntype-contradicts-sign.ofx");
    assert_eq!(
        cents(&s),
        [4000, -4000, -1500, 31, -200, 50_000, -990, -10_000, -100]
    );
}

#[test]
fn repeated_and_missing_fitids_do_not_collapse_lines() {
    let s = ok("11-duplicate-and-missing-fitid.ofx");
    assert_eq!(s.lines.len(), 8);
    let ids: Vec<Option<&str>> = s.lines.iter().map(|l| l.bank_id.as_deref()).collect();
    assert_eq!(ids[..2], [Some("SAME"), Some("SAME")]);
    assert_eq!(
        ids[5..],
        [None, None, None],
        "a missing or empty FITID is None"
    );

    // De-duplication keys ignore FITID: three identical café lines and two identical anonymous
    // lines keep distinct occurrence numbers, so all of them survive an import.
    let keys = duplicate_keys(ACCOUNT, &s.lines);
    let distinct: BTreeSet<_> = keys.iter().collect();
    assert_eq!(distinct.len(), 8);
    let cafe: Vec<u32> = keys
        .iter()
        .filter(|k| k.description == "PIKORUA CAFE")
        .map(|k| k.occurrence)
        .collect();
    assert_eq!(cafe, [1, 2, 3]);
}

#[test]
fn description_comes_from_name_then_memo_then_payee() {
    let s = ok("12-name-memo-payee-shapes.ofx");
    assert_eq!(
        descriptions(&s),
        [
            "SAME TEXT SAME TEXT",
            "WAXWING SUPPLIES LTD AKL NZ REF 0099 73",
            "THIRTY TWO CHARACTER NAME LIMIT X CONTINUES IN THE MEMO FIELD",
            "MEMO ONLY NO NAME",
            "",
            "PAYEE AGGREGATE NAME",
            "NAME WINS",
            "LOTS OF SPACE AND TABS",
            "",
        ]
    );
}

#[test]
fn optional_elements_we_do_not_use_are_ignored() {
    let s = ok("17-extra-transaction-elements.ofx");
    assert_eq!(cents(&s), [-7500, -3000, -2000]);
    assert_eq!(s.lines[0].description, "CHEQUE 123 PAID");
    // A correction record (CORRECTFITID) is an ordinary line to us.
    assert_eq!(s.lines[1].bank_id.as_deref(), Some("Q2"));
}

#[test]
fn the_ledger_balance_is_used_not_the_available_balance() {
    let s = ok("18-availbal-differs-from-ledgerbal.ofx");
    assert_eq!(s.closing.unwrap().amount.cents(), 10_000);
}

#[test]
fn statements_with_little_in_them() {
    let none = ok("19a-no-transactions-with-balance.ofx");
    assert!(none.lines.is_empty());
    assert_eq!(none.closing.unwrap().amount.cents(), 100_000);

    let bare = ok("19b-no-period-no-balance.ofx");
    assert_eq!((bare.period_start, bare.period_end), (None, None));
    assert!(bare.closing.is_none());
    assert_eq!(bare.lines.len(), 1);

    let zero = ok("19c-nets-to-zero.ofx");
    assert_eq!(cents(&zero).iter().sum::<i64>(), 0);
}

#[test]
fn a_statement_may_span_the_balance_date() {
    let s = ok("13-statement-spans-31-march.ofx");
    let dates: Vec<String> = s.lines.iter().map(|l| l.date.to_string()).collect();
    assert_eq!(dates, ["2025-03-31", "2025-04-01", "2025-04-15"]);
}

#[test]
fn account_numbers_are_normalised_to_the_usual_shape() {
    for (name, want) in [
        ("14a-acctid-bare-15-digits.ofx", ACCOUNT),
        ("14b-acctid-spaces-three-digit-suffix.ofx", ACCOUNT),
        ("14c-acctid-eight-digit-base.ofx", "99-1001-0001230-00"),
        ("14d-acctid-padded.ofx", ACCOUNT),
        // Not a number: kept, upper-cased, so the user can still match it by hand.
        ("14e-acctid-not-a-number.ofx", "SAVINGS-ONE"),
    ] {
        assert_eq!(ok(name).account.as_deref(), Some(want), "{name}");
    }
}

#[test]
fn cards_are_masked_to_their_last_four() {
    for name in [
        "15-card-sgml-masked.ofx",
        "16a-card-stars-and-spaces.ofx",
        "16c-card-full-number.ofx",
    ] {
        let s = ok(name);
        assert_eq!(s.kind, StatementKind::CreditCard, "{name}");
        assert_eq!(s.account.as_deref(), Some("XXXX-XXXX-XXXX-9999"), "{name}");
    }
    // A bank-style number in a card file is taken as the account it is.
    let odd = ok("16d-card-with-bank-style-id.ofx");
    assert_eq!(odd.kind, StatementKind::CreditCard);
    assert_eq!(odd.account.as_deref(), Some(ACCOUNT));
    // Card amounts are already signed from the holder's side: spending negative, owing negative.
    let s = ok("15-card-sgml-masked.ofx");
    assert_eq!(cents(&s), [-4500, 10_000, -250]);
    assert_eq!(s.closing.unwrap().amount.cents(), -9250);
}

#[test]
fn a_whole_file_is_refused_when_any_line_is_bad() {
    // Every bad date is reported with its row; the good one and the blank are not confused.
    let bad_dates = problems("26-bad-dates.ofx");
    let bad: Vec<&str> = bad_dates
        .iter()
        .filter_map(|p| match p {
            Problem::BadDate { value, .. } => Some(value.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        bad,
        ["04/08/2025", "2025-08-05", "20250230", "20251301", "250804"]
    );
    assert!(
        bad_dates
            .iter()
            .any(|p| matches!(p, Problem::MissingField { field, .. } if field == "DTPOSTED"))
    );

    let bad_amounts = problems("27-bad-amounts.ofx");
    let bad: Vec<&str> = bad_amounts
        .iter()
        .filter_map(|p| match p {
            Problem::BadAmount { value, .. } => Some(value.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(
        bad,
        [
            "-1.234,56",
            "12.345",
            "NaN",
            "12.00 CR",
            "1e3",
            "99999999999999999999"
        ]
    );

    let missing = problems("28-missing-date-and-amount.ofx");
    let fields: Vec<&str> = missing
        .iter()
        .filter_map(|p| match p {
            Problem::MissingField { field, .. } => Some(field.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(fields, ["DTPOSTED", "TRNAMT", "TRNAMT"]);

    // 29 February in a non-leap year is bad; 29 February 2024 would have been fine.
    let edges = problems("30-calendar-edges.ofx");
    assert_eq!(edges.len(), 1);
    assert!(matches!(&edges[0], Problem::BadDate { value, .. } if value == "20250229"));
}

#[test]
fn files_we_will_not_take() {
    assert_eq!(
        problems("22-bank-and-card-in-one-file.ofx"),
        [Problem::SeveralStatements]
    );
    assert_eq!(
        problems("23-two-bank-accounts-in-one-file.ofx"),
        [Problem::SeveralStatements]
    );
    assert_eq!(
        problems("24a-foreign-currency-usd.ofx"),
        [Problem::ForeignCurrency {
            currency: "USD".to_owned()
        }]
    );
    assert_eq!(
        problems("29-missing-acctid.ofx"),
        [Problem::Missing {
            field: "ACCTID".to_owned()
        }]
    );
    // Currency spelling: case doesn't matter, and a missing currency is taken as NZD.
    ok("24b-currency-lower-case.ofx");
    ok("24c-currency-empty.ofx");
}

#[test]
fn things_that_are_not_ofx_are_not_recognised() {
    for name in [
        "33-html-error-page-saved-as-ofx.ofx",
        "34-empty-file.ofx",
        "35-header-only.ofx",
        "36-csv-with-ofx-extension.ofx",
    ] {
        not_recognised(name);
    }
}

#[test]
fn an_ordinary_month_reads_fully() {
    let s = ok("39-ordinary-month.ofx");
    assert_eq!(s.lines.len(), 7);
    assert_eq!(
        cents(&s).iter().sum::<i64>(),
        s.closing.unwrap().amount.cents(),
        "this file opens at zero, so the lines add up to the closing balance"
    );
}

/// Behaviour we believe is wrong, pinned so it can't change unnoticed. See the README.
#[test]
fn known_gaps() {
    // 1. A lower-case root tag is not detected, though the tokenizer would cope.
    not_recognised("04-sgml-lowercase-indented-tabs.ofx");

    // 2. A download cut off part-way through a transaction imports a half-read amount
    //    (-7.0 for what was probably -7.05) as a real line, and the closing balance is lost.
    let cut = ok("25-truncated-mid-transaction.ofx");
    assert_eq!(cents(&cut), [-500, -600, -700]);
    assert!(cut.closing.is_none());
    assert_eq!(cut.lines[2].description, "");

    // 3. CDATA is skipped, so the text inside it is lost, and numeric character references
    //    are not decoded.
    let x = ok("32-xml-cdata-and-numeric-references.ofx");
    assert_eq!(x.lines[0].description, "");
    assert_eq!(
        x.lines[1].description,
        "CAF&#201; &#X41;&#X4D;BER &#38; ASH"
    );

    // 4. A sign-on error or an investment-only file is refused as "ACCTID missing", which tells
    //    the user nothing about what is actually wrong with the file.
    for name in [
        "20-signon-error-no-statement.ofx",
        "21-investment-statement-only.ofx",
    ] {
        assert_eq!(
            problems(name),
            [Problem::Missing {
                field: "ACCTID".to_owned()
            }],
            "{name}"
        );
    }

    // 5. A card file that gives only the last four digits is not masked to the usual form, so
    //    it won't match the same card from a CSV or QIF.
    assert_eq!(
        ok("16b-card-last-four-only.ofx").account.as_deref(),
        Some("9999")
    );

    // 6. A line with no description at all is accepted with an empty description.
    let s = ok("12-name-memo-payee-shapes.ofx");
    assert_eq!(s.lines[4].description, "");
}

#[test]
fn every_fixture_is_exercised_by_name() {
    let source = std::fs::read_to_string(
        [env!("CARGO_MANIFEST_DIR"), "tests/ofx_edge.rs"]
            .iter()
            .collect::<PathBuf>(),
    )
    .unwrap();
    let mut missing = Vec::new();
    for entry in std::fs::read_dir(dir()).unwrap() {
        let name = entry.unwrap().file_name().into_string().unwrap();
        if name.ends_with(".ofx") && !source.contains(&format!("\"{name}\"")) {
            missing.push(name);
        }
    }
    assert!(missing.is_empty(), "fixtures no test names: {missing:?}");
}
