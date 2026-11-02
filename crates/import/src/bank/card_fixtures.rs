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

fn read_text(label: &str, text: &str) -> Statement {
    read_statement(text.as_bytes()).unwrap_or_else(|e| panic!("{label}: {e:?}"))
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

// One invented card, `9999`, spelled every way each card format can spell it. The OFX files are
// in `ofx-edge/` (15, 16a to 16i), the QIF is `test-card-9999-short-mask-2025-08.qif`, and the
// Pohutukawa CSVs are built here around one line on 4 August: WAXWING SUPPLIES LTD, 45.00.
//
// - OFX `ACCTID` in `CCACCTFROM`: the issuer's mask `XXXXXXXXXXXX9999` (15), stars and spaces
//   (16a), last four only (16b in SGML, 16i in XML), a full number with dashes (16c) or spaces
//   (16h), stars with no gaps (16e), lower-case `x` with dashes (16f), a short mask `****9999`
//   (16g). A bank-style id in a card file (16d) stays the account it is, and a four-digit id in
//   a bank file (16j) is not a card; both are tested in `tests/ofx_edge.rs`.
// - QIF `!Type:CCard`: the card in the `!Account` name or, failing that, the opening entry's
//   category, in any of these spellings except a bare four digits, which free text can't tell
//   from a year (see `find_card`). The account is then left for the owner to pick.
// - Pohutukawa CSV: the `Card number` preamble value, in any of these spellings.
const CARD_9999: &str = "XXXX-XXXX-XXXX-9999";
const QIF_9999: &str = "test-card-9999-short-mask-2025-08.qif";
const OFX_9999: [&str; 9] = [
    "15-card-sgml-masked.ofx",
    "16a-card-stars-and-spaces.ofx",
    "16b-card-last-four-only.ofx",
    "16c-card-full-number.ofx",
    "16e-card-stars-no-gaps.ofx",
    "16f-card-lower-case-dashes.ofx",
    "16g-card-short-mask.ofx",
    "16h-card-full-number-spaces.ofx",
    "16i-card-xml-last-four-only.ofx",
];
const CARD_SPELLINGS: [&str; 9] = [
    "9999",
    "****9999",
    "XXXX 9999",
    "XXXXXXXXXXXX9999",
    "XXXX XXXX XXXX 9999",
    "xxxx-xxxx-xxxx-9999",
    "**** **** **** 9999",
    "4000 0000 0000 9999",
    "4000000000009999",
];

fn edge(name: &str) -> Statement {
    read(&format!("ofx-edge/{name}"))
}

fn pohutukawa_9999(card_number: &str) -> String {
    format!(
        "Pohutukawa Card Services - Card statement (SYNTHETIC SAMPLE)\n\
         Cardholder,Q MARSH\n\
         Card number,{card_number}\n\
         Statement period,01/08/2025,31/08/2025\n\
         Opening balance,0.00\n\
         Closing balance,45.00\n\
         Credit limit,5000.00\n\
         \n\
         Processed,Transaction date,Details,Amount\n\
         04/08/2025,03/08/2025,WAXWING SUPPLIES LTD,45.00\n\
         End of statement\n"
    )
}

#[test]
fn every_ofx_spelling_of_a_card_masks_to_the_same_account() {
    for name in OFX_9999 {
        let s = edge(name);
        assert_eq!(s.kind, StatementKind::CreditCard, "{name}");
        assert_eq!(s.account.as_deref(), Some(CARD_9999), "{name}");
    }
}

#[test]
fn every_qif_spelling_of_a_card_masks_to_the_same_account() {
    let s = read(QIF_9999);
    assert_eq!(s.kind, StatementKind::CreditCard);
    assert_eq!(s.account.as_deref(), Some(CARD_9999), "the short mask");

    let text = String::from_utf8(bytes(QIF_9999))
        .unwrap()
        .replace("\r\n", "\n");
    for spelling in CARD_SPELLINGS.iter().filter(|&&c| c != "9999") {
        let named = text.replace("NTest Card ****9999", &format!("NTest Card {spelling}"));
        assert_eq!(
            read_text(spelling, &named).account.as_deref(),
            Some(CARD_9999),
            "in the !Account name: {spelling}"
        );
        let category_only = text
            .replace("NTest Card ****9999\n", "NTest Card\n")
            .replace(
                "L[Test Card **** **** **** 9999]",
                &format!("L[Test Card {spelling}]"),
            );
        assert_eq!(
            read_text(spelling, &category_only).account.as_deref(),
            Some(CARD_9999),
            "in the opening entry's category: {spelling}"
        );
    }

    // Only the last four, in free text, isn't read as the card; the owner picks it instead.
    let bare = text
        .replace("NTest Card ****9999\n", "NTest Card 9999\n")
        .replace("L[Test Card **** **** **** 9999]", "L[Test Card 9999]");
    let s = read_text("bare", &bare);
    assert_eq!((s.kind, s.account), (StatementKind::CreditCard, None));
}

#[test]
fn every_csv_spelling_of_a_card_masks_to_the_same_account() {
    for spelling in CARD_SPELLINGS {
        let s = read_text(spelling, &pohutukawa_9999(spelling));
        assert_eq!(s.parser, "pohutukawa-card-csv-1", "{spelling}");
        assert_eq!(s.account.as_deref(), Some(CARD_9999), "{spelling}");
    }
}

#[test]
fn the_same_card_from_each_format_has_the_same_duplicate_keys() {
    let ofx_last_four = edge("16i-card-xml-last-four-only.ofx");
    let ofx_short_mask = edge("16g-card-short-mask.ofx");
    let qif = read(QIF_9999);
    let csv_last_four = read_text("csv", &pohutukawa_9999("9999"));
    let csv_full = read_text("csv", &pohutukawa_9999("4000 0000 0000 9999"));

    let want = keys(&ofx_last_four);
    assert_eq!(want.len(), 1);
    assert_eq!(want[0].account, CARD_9999);
    assert_eq!(want[0].description, "WAXWING SUPPLIES LTD");
    assert_eq!(want[0].amount, m("-45.00"));
    for (label, s) in [
        ("OFX short mask", &ofx_short_mask),
        ("QIF", &qif),
        ("CSV last four", &csv_last_four),
        ("CSV full number", &csv_full),
    ] {
        assert_eq!(keys(s), want, "{label}");
    }

    // So the card's line, read from every format, is added once.
    let mut seen: BTreeSet<DuplicateKey> = BTreeSet::new();
    for s in [
        &ofx_last_four,
        &ofx_short_mask,
        &qif,
        &csv_last_four,
        &csv_full,
    ] {
        seen.extend(keys(s));
    }
    assert_eq!(seen.len(), 1);
}

#[test]
fn a_full_card_number_is_never_kept() {
    for s in [
        edge("16c-card-full-number.ofx"),
        edge("16h-card-full-number-spaces.ofx"),
        read_text("csv", &pohutukawa_9999("4000000000009999")),
    ] {
        assert_eq!(s.account.as_deref(), Some(CARD_9999));
        assert!(keys(&s).iter().all(|k| k.account == CARD_9999));
    }
}
