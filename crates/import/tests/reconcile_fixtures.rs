//! M18's reconciliation fixtures in `fixtures/reconcile/` (see its README) read as their
//! fault.toml files say: the clean set agrees with itself at every stated balance, and every
//! line a fault.toml points at is where it says, as the parsers read it.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use acct_import::bank::{BalanceCheck, Statement, read_statement};
use chrono::NaiveDate;

const CHEQUE: &str = "99-5501-0000612-00";
const CARD: &str = "XXXX-XXXX-XXXX-5290";

fn root() -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "../../fixtures/reconcile"]
        .iter()
        .collect()
}

fn read(dir: &Path, name: &str) -> Statement {
    let path = dir.join(name);
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    read_statement(&bytes).unwrap_or_else(|e| panic!("{}: {e:?}", path.display()))
}

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

/// The `file = "..."` of each `[[uploads]]` entry, in order. The TOML is generated, so a line
/// that starts with `file = ` is always an upload.
fn uploads(toml: &str) -> Vec<String> {
    toml.lines()
        .filter_map(|l| l.strip_prefix("file = \""))
        .map(|l| l.trim_end_matches('"').to_owned())
        .collect()
}

fn fixture_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(root())
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("fault.toml").exists())
        .collect();
    dirs.sort();
    dirs
}

/// The ledger of one account as M10 builds it from these files: lines in upload order, less any
/// with the same date, amount, description and occurrence as one already taken.
struct Ledger {
    opening: Option<i64>,
    lines: Vec<(NaiveDate, i64)>,
    keys: BTreeSet<(NaiveDate, i64, String, u32)>,
}

impl Ledger {
    fn new() -> Self {
        Ledger {
            opening: None,
            lines: Vec::new(),
            keys: BTreeSet::new(),
        }
    }

    fn take(&mut self, s: &Statement) {
        let start = d("2025-04-01");
        let net: i64 = s.lines.iter().map(|l| l.amount.cents()).sum();
        let first = s
            .period_start
            .into_iter()
            .chain(s.lines.iter().map(|l| l.date))
            .min();
        if self.opening.is_none() && first.is_some_and(|f| f <= start) {
            self.opening = s
                .opening
                .map(|o| o.amount.cents())
                .or(s.closing.map(|c| c.amount.cents() - net));
        }
        let mut seen: Vec<(NaiveDate, i64, String)> = Vec::new();
        for l in &s.lines {
            let k = (l.date, l.amount.cents(), l.description.clone());
            let occurrence = 1 + seen.iter().filter(|s| **s == k).count() as u32;
            seen.push(k.clone());
            if self.keys.insert((k.0, k.1, k.2, occurrence)) {
                self.lines.push((l.date, l.amount.cents()));
            }
        }
    }

    fn at_start(&self, day: NaiveDate) -> i64 {
        self.opening.unwrap()
            + self
                .lines
                .iter()
                .filter(|l| l.0 < day)
                .map(|l| l.1)
                .sum::<i64>()
    }

    fn at_end(&self, day: NaiveDate) -> i64 {
        self.opening.unwrap()
            + self
                .lines
                .iter()
                .filter(|l| l.0 <= day)
                .map(|l| l.1)
                .sum::<i64>()
    }
}

#[test]
fn the_clean_set_agrees_at_every_stated_balance() {
    let dir = root().join("clean");
    let toml = std::fs::read_to_string(dir.join("fixture.toml")).unwrap();
    let files = uploads(&toml);
    assert_eq!(files.len(), 16);
    let statements: Vec<(String, Statement)> =
        files.iter().map(|f| (f.clone(), read(&dir, f))).collect();

    for (name, s) in &statements {
        let expected = if s.parser == "kowhai-csv-1" {
            BalanceCheck::Passes
        } else {
            // OFX states only a closing balance and QIF only an opening one.
            BalanceCheck::Skipped
        };
        assert_eq!(s.balance_check(), expected, "{name}");
    }

    for (account, closing) in [(CHEQUE, 845_230), (CARD, -49_949)] {
        let mut ledger = Ledger::new();
        let mine: Vec<_> = statements
            .iter()
            .filter(|(_, s)| s.account.as_deref() == Some(account))
            .collect();
        for (_, s) in &mine {
            ledger.take(s);
        }
        let mut checked = 0;
        for (name, s) in &mine {
            if let Some(o) = s.opening {
                assert_eq!(ledger.at_start(o.date), o.amount.cents(), "{name} opening");
                checked += 1;
            }
            if let Some(c) = s.closing {
                assert_eq!(ledger.at_end(c.date), c.amount.cents(), "{name} closing");
                checked += 1;
            }
            for l in &s.lines {
                if let Some(b) = l.balance {
                    // The cheque account has at most one line a day, so a running balance is
                    // also the balance at the end of its day.
                    assert_eq!(ledger.at_end(l.date), b.cents(), "{name} row {}", l.row);
                    checked += 1;
                }
            }
        }
        assert_eq!(
            ledger.at_end(d("2026-03-31")),
            closing,
            "{account} at 31 March"
        );
        assert!(checked >= 4, "{account}: only {checked} balances");
    }
}

#[test]
fn every_variant_file_reads() {
    let dirs = fixture_dirs();
    assert_eq!(dirs.len(), 12);
    for dir in dirs {
        let toml = std::fs::read_to_string(dir.join("fault.toml")).unwrap();
        let fixture = dir.file_name().unwrap().to_string_lossy().into_owned();
        for f in uploads(&toml) {
            let s = read(&dir, &f);
            let check = s.balance_check();
            match (fixture.as_str(), f.as_str()) {
                // Columns swapped: the first row's running balance is wrong.
                ("04-sign-wrong-way", "kowhai-cheque-2025-11.csv") => {
                    assert!(
                        matches!(check, BalanceCheck::Fails { row: Some(9), .. }),
                        "{fixture}/{f}: {check:?}"
                    );
                }
                // 39.99 printed as 3999, on the 18 Feb row.
                ("09-amount-read-wrong", "kowhai-cheque-2026-02.csv") => {
                    assert!(
                        matches!(check, BalanceCheck::Fails { row: Some(14), .. }),
                        "{fixture}/{f}: {check:?}"
                    );
                }
                _ => assert!(
                    !matches!(check, BalanceCheck::Fails { .. }),
                    "{fixture}/{f}: {check:?}"
                ),
            }
        }
    }
}

/// One `line = { file = "...", row = N, date = ..., amount_cents = N, description = "..." }`
/// from a fault.toml.
struct LineRef {
    file: String,
    row: u32,
    date: NaiveDate,
    cents: i64,
    description: String,
}

fn line_refs(toml: &str) -> Vec<LineRef> {
    let mut out = Vec::new();
    let mut rest = toml;
    while let Some(i) = rest.find("line = { file = ") {
        rest = &rest[i + "line = { ".len()..];
        let end = rest.find(" }").unwrap();
        let mut r = LineRef {
            file: String::new(),
            row: 0,
            date: d("2000-01-01"),
            cents: 0,
            description: String::new(),
        };
        for field in rest[..end].split(", ") {
            let (k, v) = field.split_once(" = ").unwrap();
            let v = v.trim_matches('"');
            match k {
                "file" => r.file = v.to_owned(),
                "row" => r.row = v.parse().unwrap(),
                "date" => r.date = d(v),
                "amount_cents" => r.cents = v.parse().unwrap(),
                "description" => r.description = v.to_owned(),
                other => panic!("unexpected field {other}"),
            }
        }
        out.push(r);
    }
    out
}

#[test]
fn every_line_a_fault_points_at_is_there() {
    let mut count = 0;
    let clean = root().join("clean");
    for dir in fixture_dirs().into_iter().chain([clean.clone()]) {
        let name = if dir == clean {
            "fixture.toml"
        } else {
            "fault.toml"
        };
        let toml = std::fs::read_to_string(dir.join(name)).unwrap();
        for r in line_refs(&toml) {
            let s = read(&dir, &r.file);
            let line = s.lines.iter().find(|l| l.row == r.row).unwrap_or_else(|| {
                panic!("{}: {} has no line at row {}", dir.display(), r.file, r.row)
            });
            assert_eq!(
                (line.date, line.amount.cents(), line.description.as_str()),
                (r.date, r.cents, r.description.as_str()),
                "{}: {} row {}",
                dir.display(),
                r.file,
                r.row
            );
            count += 1;
        }
    }
    assert!(count > 20, "only {count} line references");
}
