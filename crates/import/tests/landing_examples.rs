//! The three landing-page example statements (M20, `fixtures/landing/README.md`) through the real
//! parser: each reads cleanly into the lines, period, account and balances the README gives, and
//! its balances agree with its lines.

use std::path::PathBuf;

use acct_core::Money;
use acct_import::bank::{BalanceCheck, Statement, read_statement};
use chrono::NaiveDate;

fn read(name: &str) -> Statement {
    let path: PathBuf = [env!("CARGO_MANIFEST_DIR"), "../../fixtures/landing", name]
        .iter()
        .collect();
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    read_statement(&bytes).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn m(s: &str) -> Money {
    s.parse().unwrap()
}

struct Expect {
    file: &'static str,
    parser: &'static str,
    account: &'static str,
    lines: usize,
    start: &'static str,
    end: &'static str,
    opening: &'static str,
    closing: &'static str,
}

const EXAMPLES: [Expect; 3] = [
    Expect {
        file: "example-1-tui-street-coffee-2025-10.ofx",
        parser: "ofx-sgml-1",
        account: "99-2101-0045617-00",
        lines: 27,
        start: "2025-10-01",
        end: "2025-10-31",
        opening: "3184.20",
        closing: "7969.08",
    },
    Expect {
        file: "example-2-matai-design-2025-08_09.ofx",
        parser: "ofx-xml-1",
        // The file says `-002`; the parser normalises a three-digit suffix to two digits.
        account: "99-3305-0098765-02",
        lines: 24,
        start: "2025-08-01",
        end: "2025-09-30",
        opening: "2410.55",
        closing: "10435.47",
    },
    Expect {
        file: "example-3-kahu-electrical-2025-07_09.ofx",
        parser: "ofx-sgml-1",
        account: "99-4410-0023456-00",
        lines: 41,
        start: "2025-07-01",
        end: "2025-09-30",
        opening: "6842.90",
        closing: "25258.58",
    },
];

#[test]
fn each_example_reads_as_the_readme_says() {
    for e in &EXAMPLES {
        let s = read(e.file);
        assert_eq!(s.parser, e.parser, "{}", e.file);
        assert_eq!(s.account.as_deref(), Some(e.account), "{}", e.file);
        assert_eq!(s.lines.len(), e.lines, "{}", e.file);
        assert_eq!(s.period_start, Some(d(e.start)), "{}", e.file);
        assert_eq!(s.period_end, Some(d(e.end)), "{}", e.file);
        let closing = s.closing.expect("a closing balance");
        assert_eq!(closing.amount, m(e.closing), "{}", e.file);
        assert!(
            s.lines.iter().all(|l| {
                let day = l.date;
                d(e.start) <= day && day <= d(e.end)
            }),
            "{}: every line is inside the period",
            e.file
        );
    }
}

/// OFX gives no opening balance, so the README's opening plus the lines must reach the closing.
#[test]
fn each_examples_balance_agrees_with_its_lines() {
    for e in &EXAMPLES {
        let s = read(e.file);
        let total: Money = s.lines.iter().map(|l| l.amount).sum();
        assert_eq!(
            m(e.opening) + total,
            m(e.closing),
            "{}: opening plus lines is the closing balance",
            e.file
        );
        // The parser's own check passes or, with no opening balance in the file, is skipped;
        // it never reports a disagreement.
        assert!(
            !matches!(s.balance_check(), BalanceCheck::Fails { .. }),
            "{}: {:?}",
            e.file,
            s.balance_check()
        );
    }
}
