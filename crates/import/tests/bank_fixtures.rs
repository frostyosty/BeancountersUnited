//! The bank statement parsers against `fixtures/bank-statements` (see its README).

use std::collections::BTreeSet;
use std::path::PathBuf;

use acct_core::Money;
use acct_import::bank::{
    BalanceCheck, DuplicateKey, Statement, StatementError, duplicate_keys, read_statement,
};
use chrono::NaiveDate;

const OFX: &str = "harbourlight-cheque-2025-08.ofx";
const QIF: &str = "harbourlight-cheque-2025-08-28_09-30.qif";
const KOWHAI_AUG: &str = "kowhai-business-2025-08.csv";
const KOWHAI_SEP: &str = "kowhai-business-2025-09-10_09-30.csv";
const RIMU: &str = "rimu-savings-2025-08-29_09-30.csv";
const ALL: [&str; 5] = [OFX, QIF, KOWHAI_AUG, KOWHAI_SEP, RIMU];

fn bytes(name: &str) -> Vec<u8> {
    let path: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "../../fixtures/bank-statements",
        name,
    ]
    .iter()
    .collect();
    std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

fn read(name: &str) -> Statement {
    read_statement(&bytes(name)).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn m(s: &str) -> Money {
    s.parse().unwrap()
}

fn keys(s: &Statement) -> Vec<DuplicateKey> {
    duplicate_keys(s.account.as_deref().unwrap(), &s.lines)
}

fn sum(s: &Statement) -> Money {
    s.lines.iter().map(|l| l.amount).sum()
}

#[test]
fn each_file_picks_its_parser() {
    let parsers: Vec<String> = ALL.iter().map(|f| read(f).parser).collect();
    assert_eq!(
        parsers,
        [
            "ofx-sgml-1",
            "qif-bank-1",
            "kowhai-csv-1",
            "kowhai-csv-1",
            "rimu-csv-1"
        ]
    );
}

#[test]
fn accounts_lines_and_balances() {
    let ofx = read(OFX);
    assert_eq!(ofx.account.as_deref(), Some("99-1001-0000123-00"));
    assert_eq!(ofx.lines.len(), 11);
    assert_eq!(ofx.period_start, Some(d("2025-08-01")));
    assert_eq!(ofx.period_end, Some(d("2025-08-31")));
    assert_eq!(ofx.opening, None);
    let closing = ofx.closing.unwrap();
    assert_eq!(
        (closing.date, closing.amount),
        (d("2025-08-31"), m("2022.56"))
    );
    let first = &ofx.lines[0];
    assert_eq!(first.date, d("2025-08-04"));
    assert_eq!(first.amount, m("-86.40"));
    assert_eq!(first.description, "WAXWING SUPPLIES LTD EFTPOS AUCKLAND");
    assert_eq!(first.bank_id.as_deref(), Some("HL20250804001"));
    assert_eq!(ofx.lines[1].description, "AMBER & ASH BOUTIQUE INV 0388");

    let qif = read(QIF);
    assert_eq!(qif.account.as_deref(), Some("99-1001-0000123-00"));
    assert_eq!(qif.lines.len(), 12, "the opening entry is not a line");
    let opening = qif.opening.unwrap();
    assert_eq!(
        (opening.date, opening.amount),
        (d("2025-08-28"), m("1883.56"))
    );
    assert_eq!(qif.closing, None);
    assert_eq!(qif.lines[0].description, "PIKORUA CAFE EFTPOS WELLINGTON");
    assert_eq!(opening.amount + sum(&qif), m("2247.12"), "derived closing");
    // The QIF's opening entry is the OFX's closing less the OFX's last four lines.
    let last_four: Money = ofx.lines[7..].iter().map(|l| l.amount).sum();
    assert_eq!(closing.amount - last_four, opening.amount);

    let aug = read(KOWHAI_AUG);
    assert_eq!(aug.account.as_deref(), Some("99-5501-0000456-00"));
    assert_eq!(aug.lines.len(), 5);
    let (open, close) = (aug.opening.unwrap(), aug.closing.unwrap());
    assert_eq!((open.date, open.amount), (d("2025-08-01"), m("1250.00")));
    assert_eq!((close.date, close.amount), (d("2025-08-31"), m("2100.01")));
    assert_eq!(aug.lines[0].amount, m("-120.00"));
    assert_eq!(aug.lines[1].amount, m("725.00"));
    assert_eq!(aug.lines[4].description, "FARO INSURANCE, PREMIUM");
    assert_eq!(aug.lines[4].balance, Some(m("2100.01")));

    let sep = read(KOWHAI_SEP);
    assert_eq!(sep.period_start, Some(d("2025-09-10")));
    assert_eq!(sep.opening.unwrap().amount, m("2480.01"));
    assert_eq!(sep.closing.unwrap().amount, m("2830.73"));

    let rimu = read(RIMU);
    assert_eq!(rimu.account.as_deref(), Some("99-7702-0000789-00"));
    assert_eq!(rimu.lines.len(), 4);
    assert_eq!((rimu.opening, rimu.closing), (None, None));
    assert_eq!(rimu.lines[1].description, "Q MARSH TOP-UP, FROM PERSONAL");
    assert_eq!(rimu.lines[2].amount, m("-150.00"));
    assert_eq!(rimu.lines[0].date, d("2025-08-29"));
}

#[test]
fn balance_checks_pass_or_skip() {
    assert_eq!(read(KOWHAI_AUG).balance_check(), BalanceCheck::Passes);
    assert_eq!(read(KOWHAI_SEP).balance_check(), BalanceCheck::Passes);
    for f in [OFX, QIF, RIMU] {
        assert_eq!(read(f).balance_check(), BalanceCheck::Skipped, "{f}");
    }
}

#[test]
fn a_wrong_closing_balance_fails_the_check() {
    let text = String::from_utf8(bytes(KOWHAI_AUG))
        .unwrap()
        .replace("Closing balance,2100.01", "Closing balance,2100.00");
    let s = read_statement(text.as_bytes()).unwrap();
    assert_eq!(
        s.balance_check(),
        BalanceCheck::Fails {
            row: None,
            expected: m("2100.01"),
            stated: m("2100.00"),
        }
    );
}

#[test]
fn both_identical_cafe_purchases_survive() {
    let cafe: Vec<_> = keys(&read(OFX))
        .into_iter()
        .filter(|k| k.date == d("2025-08-29"))
        .collect();
    assert_eq!(cafe.len(), 2);
    assert_eq!((cafe[0].occurrence, cafe[1].occurrence), (1, 2));
    assert_eq!(cafe[0].description, "PIKORUA CAFE EFTPOS WELLINGTON");
    assert_eq!(cafe[0].amount, m("-6.50"));
}

#[test]
fn the_overlap_dedupes_to_33_transactions() {
    let mut seen: BTreeSet<DuplicateKey> = BTreeSet::new();
    let mut added = Vec::new();
    for f in ALL {
        let before = seen.len();
        seen.extend(keys(&read(f)));
        added.push(seen.len() - before);
    }
    assert_eq!(
        added,
        [11, 8, 5, 5, 4],
        "the QIF after the OFX adds 8, not 12"
    );
    assert_eq!(seen.len(), 33);

    let per_account = |a: &str| seen.iter().filter(|k| k.account == a).count();
    assert_eq!(per_account("99-1001-0000123-00"), 19);
    assert_eq!(per_account("99-5501-0000456-00"), 10);
    assert_eq!(per_account("99-7702-0000789-00"), 4);

    // Both 29 Aug cafe purchases are kept: not one (over-collapsed), not four (no dedupe).
    let cafe = seen
        .iter()
        .filter(|k| k.date == d("2025-08-29") && k.description.starts_with("PIKORUA"))
        .count();
    assert_eq!(cafe, 2);
}

#[test]
fn importing_a_file_twice_adds_nothing() {
    for f in ALL {
        let first: BTreeSet<_> = keys(&read(f)).into_iter().collect();
        let mut again = first.clone();
        again.extend(keys(&read(f)));
        assert_eq!(first, again, "{f}");
    }
}

#[test]
fn an_unknown_file_lists_what_we_read() {
    let err = read_statement(b"Date,Amount\n2025-01-01,1.00\n").unwrap_err();
    let StatementError::NotRecognised { formats } = err else {
        panic!("{err:?}")
    };
    for name in ["OFX 1", "OFX 2", "QIF", "Kowhai", "Rimu"] {
        assert!(formats.iter().any(|f| f.contains(name)), "{name}");
    }
}

#[test]
fn windows_line_endings_and_a_bom_read_the_same() {
    for f in ALL {
        let plain = read(f);
        // The checkout may already have either line ending.
        let text = String::from_utf8(bytes(f))
            .unwrap()
            .replace("\r\n", "\n")
            .replace('\n', "\r\n");
        let mut with_bom = b"\xEF\xBB\xBF".to_vec();
        with_bom.extend(text.as_bytes());
        assert_eq!(plain, read_statement(&with_bom).unwrap(), "{f}");
    }
}
