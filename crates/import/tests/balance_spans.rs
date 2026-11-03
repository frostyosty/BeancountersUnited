//! M18: every balance a parser reads knows where in the file it was written, so the owner can be
//! shown the bank's own words. Checked against `fixtures/bank-statements` and its `ofx-edge` files.

use std::path::{Path, PathBuf};

use acct_core::Money;
use acct_import::bank::{SourceSpan, decode, read_statement};

fn dir(sub: &str) -> PathBuf {
    [
        env!("CARGO_MANIFEST_DIR"),
        "../../fixtures/bank-statements",
        sub,
    ]
    .iter()
    .collect()
}

fn files(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|e| e != "md"))
        .collect();
    out.sort();
    out
}

fn abs(m: Money) -> Money {
    Money::from_cents(m.cents().abs())
}

/// The text a span marks.
fn at(text: &str, span: SourceSpan) -> &str {
    let line = text
        .split('\n')
        .nth(span.line as usize - 1)
        .unwrap_or_else(|| panic!("no line {}", span.line));
    &line[span.start as usize..span.end as usize]
}

/// A balance as a statement writes it, read without its sign: `1,883.56`, `-12.00`, `250.00 CR`.
fn unsigned(written: &str) -> Money {
    let s = written.trim();
    let s = s
        .strip_suffix("CR")
        .or_else(|| s.strip_suffix("cr"))
        .unwrap_or(s);
    let s: String = s
        .trim()
        .trim_start_matches(['-', '+'])
        .chars()
        .filter(|&c| c != ',')
        .collect();
    s.parse()
        .unwrap_or_else(|e| panic!("{written:?} isn't an amount: {e}"))
}

/// Every balance the file states has a span, and the span marks that balance.
fn check(path: &Path) -> Option<Vec<String>> {
    let bytes = std::fs::read(path).unwrap();
    let statement = read_statement(&bytes).ok()?;
    let text = decode(&bytes);
    let name = path.file_name().unwrap().to_string_lossy();
    let mut marked = Vec::new();
    for (what, balance) in [
        ("opening", statement.opening),
        ("closing", statement.closing),
    ] {
        let Some(b) = balance else { continue };
        let span = b
            .span
            .unwrap_or_else(|| panic!("{name}: the {what} balance has no span"));
        let written = at(&text, span);
        assert_eq!(unsigned(written), abs(b.amount), "{name} {what}: {span:?}");
        marked.push(format!("{what} {written}"));
    }
    for line in &statement.lines {
        match (line.balance, line.balance_span) {
            (None, None) => {}
            (Some(b), Some(span)) => {
                assert_eq!(span.line, line.row, "{name}: on the line's own row");
                assert_eq!(unsigned(at(&text, span)), abs(b), "{name} row {}", line.row);
            }
            other => panic!(
                "{name} row {}: balance and span disagree: {other:?}",
                line.row
            ),
        }
    }
    let running = statement
        .lines
        .iter()
        .filter(|l| l.balance.is_some())
        .count();
    if running > 0 {
        marked.push(format!("{running} running"));
    }
    Some(marked)
}

#[test]
fn every_fixture_balance_points_at_its_own_text() {
    let mut seen = Vec::new();
    for path in files(&dir("")) {
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        let marked = check(&path).unwrap_or_else(|| panic!("{name} should read"));
        seen.push((name, marked.join(", ")));
    }
    let find = |name: &str| {
        seen.iter()
            .find(|(n, _)| n == name)
            .map(|(_, m)| m.as_str())
            .unwrap_or_else(|| panic!("no fixture {name}"))
    };
    // One of each parser, spelled out, so a span that marks the wrong figure can't pass.
    assert_eq!(find("harbourlight-cheque-2025-08.ofx"), "closing 2022.56");
    assert_eq!(
        find("harbourlight-cheque-2025-08-28_09-30.qif"),
        "opening 1883.56"
    );
    assert_eq!(
        find("kowhai-business-2025-08.csv"),
        "opening 1250.00, closing 2100.01, 5 running"
    );
    assert!(
        find("pohutukawa-card-2025-08-15_09-14.csv").starts_with("opening "),
        "{seen:?}"
    );
    assert_eq!(find("rimu-savings-2025-08-29_09-30.csv"), "");
}

#[test]
fn every_ofx_edge_file_that_reads_marks_its_ledger_balance() {
    let mut read = 0;
    for path in files(&dir("ofx-edge")) {
        if check(&path).is_some() {
            read += 1;
        }
    }
    assert!(read > 20, "only {read} edge files read");
}

#[test]
fn the_ledger_balance_is_marked_not_the_available_one() {
    let path = dir("ofx-edge").join("18-availbal-differs-from-ledgerbal.ofx");
    let bytes = std::fs::read(&path).unwrap();
    let s = read_statement(&bytes).unwrap();
    let text = decode(&bytes);
    let span = s.closing.unwrap().span.unwrap();
    let before: Vec<&str> = text.split('\n').take(span.line as usize).collect();
    let ledger = before.iter().rposition(|l| l.contains("<LEDGERBAL>"));
    let avail = before.iter().rposition(|l| l.contains("<AVAILBAL>"));
    assert!(ledger.is_some(), "{before:?}");
    assert!(avail.is_none_or(|a| a < ledger.unwrap()), "{before:?}");
}
