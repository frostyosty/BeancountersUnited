//! The credit card parsers against the card files in `fixtures/bank-statements` (see its README).

use std::collections::BTreeSet;
use std::path::PathBuf;

use acct_core::Money;
use chrono::NaiveDate;

use super::{BalanceCheck, DuplicateKey, Statement, StatementKind, duplicate_keys, read_statement};

const OFX: &str = "harbourlight-visa-2025-08.ofx";
const QIF: &str = "harbourlight-visa-2025-08-29_09-30.qif";
const CSV: &str = "pohutukawa-card-2025-08-15_09-14.csv";
const ALL: [&str; 3] = [OFX, QIF, CSV];

const VISA: &str = "XXXX-XXXX-XXXX-4417";
const POHUTUKAWA: &str = "XXXX-XXXX-XXXX-8802";

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
fn each_card_file_picks_its_parser_and_is_a_card() {
    let found: Vec<(String, StatementKind, Option<String>)> = ALL
        .iter()
        .map(|f| {
            let s = read(f);
            (s.parser, s.kind, s.account)
        })
        .collect();
    let card = StatementKind::CreditCard;
    assert_eq!(
        found,
        [
            ("ofx-xml-1".to_owned(), card, Some(VISA.to_owned())),
            ("qif-ccard-1".to_owned(), card, Some(VISA.to_owned())),
            (
                "pohutukawa-card-csv-1".to_owned(),
                card,
                Some(POHUTUKAWA.to_owned())
            ),
        ]
    );
}

#[test]
fn the_bank_fixtures_are_still_bank_statements() {
    for f in [
        "harbourlight-cheque-2025-08.ofx",
        "harbourlight-cheque-2025-08-28_09-30.qif",
        "kowhai-business-2025-08.csv",
        "rimu-savings-2025-08-29_09-30.csv",
    ] {
        assert_eq!(read(f).kind, StatementKind::Bank, "{f}");
    }
}

#[test]
fn purchases_are_money_out_and_payments_money_in() {
    let ofx = read(OFX);
    assert_eq!(ofx.lines.len(), 10);
    assert_eq!(ofx.lines[0].description, "WAXWING SUPPLIES LTD AUCKLAND");
    assert_eq!(ofx.lines[0].amount, m("-48.90"), "purchase");
    assert_eq!(ofx.lines[2].description, "PAYMENT RECEIVED THANK YOU");
    assert_eq!(ofx.lines[2].amount, m("312.40"), "payment");
    assert_eq!(ofx.lines[6].amount, m("18.50"), "refund");
    assert_eq!(ofx.lines[9].amount, m("-2.95"), "interest");
    let closing = ofx.closing.unwrap();
    assert_eq!(
        (closing.date, closing.amount),
        (d("2025-08-31"), m("-265.09")),
        "a balance owed is negative"
    );
    assert_eq!(closing.amount - sum(&ofx), m("-312.40"), "derived opening");

    let qif = read(QIF);
    assert_eq!(qif.lines.len(), 9, "the opening entry is not a line");
    let opening = qif.opening.unwrap();
    assert_eq!(
        (opening.date, opening.amount),
        (d("2025-08-29"), m("-247.74"))
    );
    assert_eq!(qif.lines[4].amount, m("265.09"), "payment");
    assert_eq!(qif.lines[7].amount, m("-310.00"), "purchase");
    assert_eq!(opening.amount + sum(&qif), m("-403.04"), "derived closing");
    // The QIF's opening entry is the OFX's closing less the OFX's last three lines.
    let last_three: Money = ofx.lines[7..].iter().map(|l| l.amount).sum();
    assert_eq!(closing.amount - last_three, opening.amount);

    // The CSV writes charges unsigned and credits with CR; both come out card-signed.
    let csv = read(CSV);
    assert_eq!(csv.lines.len(), 7);
    assert_eq!(csv.lines[0].date, d("2025-08-16"), "the processed date");
    assert_eq!(csv.lines[0].amount, m("-436.20"), "purchase");
    assert_eq!(csv.lines[2].description, "KAURI PETROL, NELSON");
    assert_eq!(csv.lines[3].amount, m("189.00"), "refund");
    assert_eq!(csv.lines[5].amount, m("250.00"), "payment");
    let (open, close) = (csv.opening.unwrap(), csv.closing.unwrap());
    assert_eq!((open.date, open.amount), (d("2025-08-15"), m("-120.00")));
    assert_eq!((close.date, close.amount), (d("2025-09-14"), m("-1087.55")));
}

#[test]
fn balance_checks_pass_fail_or_skip() {
    assert_eq!(read(CSV).balance_check(), BalanceCheck::Passes);
    for f in [OFX, QIF] {
        assert_eq!(read(f).balance_check(), BalanceCheck::Skipped, "{f}");
    }
    let text = String::from_utf8(bytes(CSV))
        .unwrap()
        .replace("Closing balance,1087.55", "Closing balance,1087.55 CR");
    assert_eq!(
        read_statement(text.as_bytes()).unwrap().balance_check(),
        BalanceCheck::Fails {
            row: None,
            expected: m("-1087.55"),
            stated: m("1087.55"),
        },
        "a closing balance with the wrong sign fails"
    );
}

#[test]
fn both_identical_cafe_purchases_survive() {
    let cafe: Vec<_> = keys(&read(OFX))
        .into_iter()
        .filter(|k| k.date == d("2025-08-30"))
        .collect();
    assert_eq!(cafe.len(), 2);
    assert_eq!((cafe[0].occurrence, cafe[1].occurrence), (1, 2));
    assert_eq!(cafe[0].account, VISA);
    assert_eq!(cafe[0].description, "PIKORUA CAFE WELLINGTON");
    assert_eq!(cafe[0].amount, m("-7.20"));
}

#[test]
fn the_card_overlap_dedupes() {
    let mut seen: BTreeSet<DuplicateKey> = BTreeSet::new();
    let mut added = Vec::new();
    for f in ALL {
        let before = seen.len();
        seen.extend(keys(&read(f)));
        added.push(seen.len() - before);
    }
    assert_eq!(added, [10, 6, 7], "the QIF after the OFX adds 6, not 9");
    let per_card = |a: &str| seen.iter().filter(|k| k.account == a).count();
    assert_eq!(per_card(VISA), 16);
    assert_eq!(per_card(POHUTUKAWA), 7);
}

#[test]
fn importing_a_card_file_twice_adds_nothing() {
    for f in ALL {
        let first: BTreeSet<_> = keys(&read(f)).into_iter().collect();
        let mut again = first.clone();
        again.extend(keys(&read(f)));
        assert_eq!(first, again, "{f}");
    }
}

#[test]
fn windows_line_endings_and_a_bom_read_the_same() {
    for f in ALL {
        let plain = read(f);
        let text = String::from_utf8(bytes(f))
            .unwrap()
            .replace("\r\n", "\n")
            .replace('\n', "\r\n");
        let mut with_bom = b"\xEF\xBB\xBF".to_vec();
        with_bom.extend(text.as_bytes());
        assert_eq!(plain, read_statement(&with_bom).unwrap(), "{f}");
    }
}
