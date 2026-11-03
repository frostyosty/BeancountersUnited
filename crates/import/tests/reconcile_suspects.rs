//! M18's suspects against the fixtures in `fixtures/reconcile/` (see its README). Core can't read
//! files, so this test reads them with the real parsers, builds each account's books the way the
//! server would (M10's duplicate keys and flags, the opening balance, the replayed commands), walks
//! the checkpoints and hands the suspects plain data.
//!
//! For each fixture: the window is the one its fault.toml expects, the fault's suspect finds it
//! Likely with the exact amount, and no other suspect claims the whole difference as Likely. On the
//! clean set nothing is found at all.
//!
//! Then M18 Agent 5's combiner: each fixture's diagnosis explains the whole difference with exactly
//! its fault's findings, and the clean set's diagnosis is empty.
//!
//! Like the fixtures' generator and the server (M18 Agent 8), the books here hold a gap journal for
//! each gap with known balances either side, and a stated balance sits on the date the file states
//! it. `crates/server/tests/m18_suspect_input.rs` checks the server's own books find the same.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use acct_core::bank::{Coverage, gaps};
use acct_core::money::Money;
use acct_core::reconcile::checkpoints::{
    BankLineFacts, Checkpoint, Movement, StatementFacts, checkpoints, walk,
};
use acct_core::reconcile::suspects::{
    AccountSide, BalanceBreak, JournalOrigin, OpeningFacts, OtherStatement, SuspectInput,
    SuspectJournal, SuspectLine, SuspectStatement, look_all,
};
use acct_core::reconcile::{
    BalanceKind, Confidence, Finding, FindingKind, ReconcileAccountKind, Shape, SuggestedFix,
    diagnose,
};
use acct_import::bank::{BalanceCheck, DuplicateKey, Statement, duplicate_keys, read_statement};
use chrono::NaiveDate;

fn root() -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "../../fixtures/reconcile"]
        .iter()
        .collect()
}

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

// ---- A reader for the generated TOML: sections of `key = value` lines. ----

#[derive(Debug, Default)]
struct Section {
    name: String,
    fields: BTreeMap<String, String>,
}

impl Section {
    fn get(&self, key: &str) -> &str {
        self.fields
            .get(key)
            .unwrap_or_else(|| panic!("[{}] has no {key}", self.name))
    }

    fn str(&self, key: &str) -> String {
        unquote(self.get(key))
    }

    fn int(&self, key: &str) -> i64 {
        self.get(key).parse().unwrap()
    }
}

fn unquote(v: &str) -> String {
    v.trim().trim_matches('"').to_owned()
}

/// Top-level sections and arrays of tables, with each one's single-line values. Lines that carry
/// on a multi-line value (evidence) are skipped; nothing here needs them.
fn sections(toml: &str) -> Vec<Section> {
    let mut out = vec![Section::default()];
    for line in toml.lines() {
        let code = strip_comment(line);
        if let Some(name) = code.strip_prefix("[[").and_then(|l| l.strip_suffix("]]")) {
            out.push(Section {
                name: name.to_owned(),
                ..Section::default()
            });
        } else if let Some(name) = code.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            out.push(Section {
                name: name.to_owned(),
                ..Section::default()
            });
        } else if !line.starts_with(' ')
            && let Some((k, v)) = code.split_once(" = ")
        {
            out.last_mut()
                .unwrap()
                .fields
                .insert(k.to_owned(), v.trim().to_owned());
        }
    }
    out
}

fn strip_comment(line: &str) -> &str {
    let mut quoted = false;
    for (i, c) in line.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '#' if !quoted => return line[..i].trim_end(),
            _ => {}
        }
    }
    line.trim_end()
}

/// Splits on `sep` outside quotes, braces and brackets.
fn split_top(s: &str, sep: char) -> Vec<&str> {
    let (mut depth, mut quoted, mut from) = (0i32, false, 0);
    let mut out = Vec::new();
    for (i, c) in s.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '{' | '[' if !quoted => depth += 1,
            '}' | ']' if !quoted => depth -= 1,
            c if c == sep && !quoted && depth == 0 => {
                out.push(s[from..i].trim());
                from = i + 1;
            }
            _ => {}
        }
    }
    out.push(s[from..].trim());
    out.retain(|p| !p.is_empty());
    out
}

/// `{ a = 1, b = "x" }` as a map.
fn table(v: &str) -> BTreeMap<String, String> {
    let inner = v.trim().trim_start_matches('{').trim_end_matches('}');
    split_top(inner, ',')
        .into_iter()
        .map(|kv| {
            let (k, v) = kv.split_once(" = ").unwrap();
            (k.trim().to_owned(), v.trim().to_owned())
        })
        .collect()
}

/// `[{ ... }, { ... }]` as maps.
fn tables(v: &str) -> Vec<BTreeMap<String, String>> {
    let inner = v.trim().trim_start_matches('[').trim_end_matches(']');
    split_top(inner, ',').into_iter().map(table).collect()
}

// ---- The books, as the server would build them. ----

struct Account {
    key: String,
    id: String,
    number: String,
    code: String,
    kind: ReconcileAccountKind,
    opening: Option<Money>,
    statements: Vec<Stored>,
    lines: Vec<SuspectLine>,
    keys: BTreeSet<DuplicateKey>,
    hand: Vec<SuspectJournal>,
}

struct Stored {
    id: String,
    parsed: Statement,
    seq: i64,
    cover: Coverage,
}

/// The days and balances a statement covers (the server's `business::coverage`).
fn coverage(s: &Statement) -> Option<Coverage> {
    let first = s.lines.iter().map(|l| l.date).min()?;
    let last = s.lines.iter().map(|l| l.date).max()?;
    let start = s
        .period_start
        .or(s.opening.map(|o| o.date))
        .map_or(first, |d| d.min(first));
    let end = s
        .period_end
        .or(s.closing.map(|c| c.date))
        .map_or(last, |d| d.max(last));
    let net: Money = s.lines.iter().map(|l| l.amount).sum();
    let opening = s
        .opening
        .map(|o| o.amount)
        .or_else(|| s.closing.map(|c| c.amount - net))
        .or_else(|| {
            let line = s.lines.first()?;
            line.balance.map(|b| b - line.amount)
        });
    let closing = s.closing.map(|c| c.amount).or(opening.map(|o| o + net));
    Some(Coverage {
        start,
        end,
        opening,
        closing,
    })
}

struct Books {
    start: NaiveDate,
    seq: i64,
    accounts: Vec<Account>,
}

impl Books {
    fn new(setup: &[Section]) -> Books {
        let start = d(setup
            .iter()
            .find(|s| s.name == "business")
            .unwrap()
            .get("start_date"));
        let accounts = setup
            .iter()
            .filter(|s| s.name == "accounts")
            .map(|s| Account {
                key: s.str("key"),
                id: format!("acct-{}", s.str("key")),
                number: s.str("number"),
                code: s.str("code"),
                kind: if s.str("kind") == "credit_card" {
                    ReconcileAccountKind::CreditCard
                } else {
                    ReconcileAccountKind::Bank
                },
                opening: None,
                statements: Vec::new(),
                lines: Vec::new(),
                keys: BTreeSet::new(),
                hand: Vec::new(),
            })
            .collect();
        Books {
            start,
            seq: 0,
            accounts,
        }
    }

    fn account(&mut self, key: &str) -> &mut Account {
        self.accounts.iter_mut().find(|a| a.key == key).unwrap()
    }

    fn upload(&mut self, dir: &Path, file: &str, key: &str) {
        let bytes = std::fs::read(dir.join(file)).unwrap();
        let parsed = read_statement(&bytes).unwrap_or_else(|e| panic!("{file}: {e:?}"));
        self.seq += 1;
        let (seq, start) = (self.seq, self.start);
        let a = self.account(key);
        let cover = coverage(&parsed).expect("every fixture file has lines");
        let covered_before = |d: NaiveDate| {
            a.statements
                .iter()
                .any(|s| s.cover.start <= d && d <= s.cover.end)
        };
        let keys = duplicate_keys(&a.number, &parsed.lines);
        let mut new_lines = Vec::new();
        for (line, key) in parsed.lines.iter().zip(keys) {
            if line.date < start || a.keys.contains(&key) {
                continue;
            }
            new_lines.push((line.clone(), key));
        }
        let inside_earlier = a
            .statements
            .iter()
            .any(|s| s.cover.start <= cover.start && cover.end <= s.cover.end);
        if new_lines.is_empty() && inside_earlier {
            return;
        }
        let flags: Vec<bool> = new_lines
            .iter()
            .map(|(l, _)| covered_before(l.date))
            .collect();
        for ((line, key), flagged) in new_lines.into_iter().zip(flags) {
            let id = format!("{file}#{}", line.row);
            a.keys.insert(key);
            a.lines.push(SuspectLine {
                journal_id: Some(format!("j-{id}")),
                id,
                statement_id: file.to_owned(),
                bank_id: line.bank_id.clone(),
                date: line.date,
                amount: line.amount,
                description: line.description.clone(),
                balance: line.balance,
                possible_duplicate: flagged,
                duplicate_answer: None,
            });
        }
        if a.opening.is_none()
            && cover.start <= start
            && let Some(before) = cover.opening
        {
            let before_start: Money = parsed
                .lines
                .iter()
                .filter(|l| l.date < start)
                .map(|l| l.amount)
                .sum();
            a.opening = Some(before + before_start);
        }
        a.statements.push(Stored {
            id: file.to_owned(),
            parsed,
            seq,
            cover,
        });
    }

    fn command(&mut self, c: &Section) {
        match c.str("kind").as_str() {
            "SetOpeningBalance" => {
                let cents = c.int("balance_cents");
                self.account(&c.str("account")).opening = Some(Money::from_cents(cents));
            }
            "ResolveDuplicate" => {
                let line = table(c.get("line"));
                let id = format!("{}#{}", unquote(&line["file"]), line["row"]);
                let answer = c.get("is_duplicate") == "true";
                let l = self
                    .accounts
                    .iter_mut()
                    .flat_map(|a| a.lines.iter_mut())
                    .find(|l| l.id == id)
                    .unwrap_or_else(|| panic!("no stored line {id}"));
                assert!(
                    l.possible_duplicate,
                    "{id}: the server refuses an unflagged line"
                );
                l.duplicate_answer = Some(answer);
                if answer {
                    l.journal_id = None;
                }
            }
            "PostJournal" => {
                let date = d(c.get("date"));
                let narration = c.str("narration");
                for line in tables(c.get("lines")) {
                    let code = unquote(&line["account"]);
                    let cents: i64 = line["amount_cents"].parse().unwrap();
                    if let Some(a) = self.accounts.iter_mut().find(|a| a.code == code) {
                        a.hand.push(SuspectJournal {
                            id: format!("hand-{}", a.hand.len() + 1),
                            date,
                            narration: narration.clone(),
                            amount: Money::from_cents(cents),
                            origin: JournalOrigin::ByHand,
                        });
                    }
                }
            }
            other => panic!("unexpected command {other}"),
        }
    }

    /// The suspects' input for one account, with its checkpoints walked.
    fn input(&self, key: &str) -> (SuspectInput, Vec<Checkpoint>) {
        let a = self.accounts.iter().find(|a| a.key == key).unwrap();
        let facts: Vec<StatementFacts<'_>> = a
            .statements
            .iter()
            .map(|s| StatementFacts {
                id: &s.id,
                file_name: &s.id,
                start: s.cover.start,
                end: s.cover.end,
                opening: s.parsed.opening.map(|o| o.amount),
                opening_date: s.parsed.opening.map_or(s.cover.start, |o| o.date),
                closing: s.parsed.closing.map(|c| c.amount),
                closing_date: s.parsed.closing.map_or(s.cover.end, |c| c.date),
                stored_closing: s.cover.closing,
                imported_seq: s.seq,
                opening_span: None,
                closing_span: None,
            })
            .collect();
        let line_facts: Vec<BankLineFacts<'_>> = a
            .lines
            .iter()
            .map(|l| BankLineFacts {
                id: &l.id,
                statement_id: &l.statement_id,
                date: l.date,
                amount: l.amount,
                description: &l.description,
                occurrence: 1,
                balance: l.balance,
                balance_span: None,
                journal_id: l.journal_id.as_deref(),
                duplicate: l.duplicate_answer == Some(true),
            })
            .collect();
        let cps = checkpoints(&facts, &line_facts, Some(self.start));

        let opening_id = format!("open-{key}");
        let mut journals = Vec::new();
        let mut movements = Vec::new();
        if let Some(amount) = a.opening {
            journals.push(SuspectJournal {
                id: opening_id.clone(),
                date: self.start,
                narration: "Opening balance".into(),
                amount,
                origin: JournalOrigin::Opening,
            });
            movements.push(Movement {
                date: self.start,
                amount,
                opening: true,
            });
        }
        for l in a.lines.iter().filter(|l| l.posts()) {
            journals.push(SuspectJournal {
                id: l.journal_id.clone().unwrap(),
                date: l.date,
                narration: l.description.clone(),
                amount: l.amount,
                origin: JournalOrigin::BankLine {
                    bank_line_id: l.id.clone(),
                },
            });
            movements.push(Movement {
                date: l.date,
                amount: l.amount,
                opening: false,
            });
        }
        for j in &a.hand {
            journals.push(j.clone());
            movements.push(Movement {
                date: j.date,
                amount: j.amount,
                opening: false,
            });
        }
        // The server's gap journals: the change across each gap with known balances either side,
        // on its last day, unless it's zero (docs/domain.md, "Bank vs books").
        let covers: Vec<Coverage> = a.statements.iter().map(|s| s.cover).collect();
        let account_gaps = gaps(self.start, a.opening, &covers);
        for g in &account_gaps {
            let Some(change) = g.change.filter(|c| !c.is_zero()) else {
                continue;
            };
            journals.push(SuspectJournal {
                id: format!("gap-{key}-{}", g.start),
                date: g.end,
                narration: format!("No statement from {} to {}", g.start, g.end),
                amount: change,
                origin: JournalOrigin::Gap {
                    start: g.start,
                    end: g.end,
                },
            });
            movements.push(Movement {
                date: g.end,
                amount: change,
                opening: false,
            });
        }
        let walked = walk(&cps, &movements);

        let statements = a
            .statements
            .iter()
            .map(|s| SuspectStatement {
                id: s.id.clone(),
                file_name: s.id.clone(),
                start: s.cover.start,
                end: s.cover.end,
                imported_seq: s.seq,
                account_number: s.parsed.account.clone(),
                stated_opening: s.parsed.opening.map(|o| o.amount),
                stated_closing: s.parsed.closing.map(|c| c.amount),
                balance_break: match s.parsed.balance_check() {
                    BalanceCheck::Fails {
                        row,
                        expected,
                        stated,
                    } => Some(BalanceBreak {
                        bank_line_id: row
                            .map(|r| format!("{}#{r}", s.id))
                            .filter(|id| a.lines.iter().any(|l| &l.id == id)),
                        expected,
                        stated,
                    }),
                    _ => None,
                },
            })
            .collect();
        let others = self
            .accounts
            .iter()
            .filter(|o| o.key != key)
            .flat_map(|o| {
                o.statements.iter().map(|s| OtherStatement {
                    bank_account_id: o.id.clone(),
                    statement_id: s.id.clone(),
                    start: s.cover.start,
                    end: s.cover.end,
                    net: o
                        .lines
                        .iter()
                        .filter(|l| l.posts() && l.statement_id == s.id)
                        .map(|l| l.amount)
                        .sum(),
                })
            })
            .collect();
        let input = SuspectInput {
            account: AccountSide {
                bank_account_id: a.id.clone(),
                kind: a.kind,
                account_number: Some(a.number.clone()),
                start: self.start,
            },
            opening: a.opening.map(|amount| OpeningFacts {
                journal_id: opening_id,
                date: self.start,
                amount,
            }),
            checkpoints: cps.clone(),
            compared: walked.compared,
            window: walked.window,
            lines: a.lines.clone(),
            journals,
            statements,
            gaps: account_gaps,
            other_accounts: Some(others),
        };
        (input, cps)
    }
}

/// Builds a fixture's books: commands before the uploads, the uploads, then commands after.
fn books(dir: &Path, toml: &str) -> Books {
    let own = sections(toml);
    let setup_toml = std::fs::read_to_string(root().join("clean/fixture.toml")).unwrap();
    let mut books = Books::new(&sections(&setup_toml));
    let commands: Vec<&Section> = own.iter().filter(|s| s.name == "commands").collect();
    for c in commands
        .iter()
        .filter(|c| c.str("when") == "before_uploads")
    {
        books.command(c);
    }
    for u in own.iter().filter(|s| s.name == "uploads") {
        books.upload(dir, &u.str("file"), &u.str("account"));
    }
    for c in commands.iter().filter(|c| c.str("when") == "after_uploads") {
        books.command(c);
    }
    books
}

fn kind(suspect: &str) -> FindingKind {
    match suspect {
        "duplicates" => FindingKind::Duplicate,
        "missing_lines" => FindingKind::MissingLines,
        "wrong_opening_balance" => FindingKind::WrongOpeningBalance,
        "sign_wrong_way" => FindingKind::SignReversed,
        "marked_duplicate_but_isnt" => FindingKind::MarkedDuplicateButIsnt,
        "entries_by_hand" => FindingKind::EntryByHand,
        "date_cut_off" => FindingKind::DateCutOff,
        "wrong_account" => FindingKind::WrongAccount,
        "amount_read_wrong" => FindingKind::AmountReadWrong,
        "transposed_digits" => FindingKind::TransposedDigits,
        other => panic!("unknown suspect {other}"),
    }
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

fn show(found: &[Finding]) -> String {
    found
        .iter()
        .map(|f| {
            format!(
                "\n  {:?} {:?} {} {:?}",
                f.kind,
                f.confidence,
                f.explains.cents(),
                f.evidence
            )
        })
        .collect()
}

#[test]
fn the_clean_set_gives_the_suspects_nothing() {
    let dir = root().join("clean");
    let toml = std::fs::read_to_string(dir.join("fixture.toml")).unwrap();
    let books = books(&dir, &toml);
    for key in ["cheque", "card"] {
        let (input, _) = books.input(key);
        assert_eq!(input.window.first_differs, None, "{key}");
        let found = look_all(&input);
        assert!(found.is_empty(), "{key}:{}", show(&found));
    }
}

#[test]
fn each_fault_is_found_by_its_suspect() {
    let dirs = fixture_dirs();
    assert_eq!(dirs.len(), 12);
    for dir in dirs {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let toml = std::fs::read_to_string(dir.join("fault.toml")).unwrap();
        let own = sections(&toml);
        let books = books(&dir, &toml);
        let faults: Vec<&Section> = own.iter().filter(|s| s.name == "faults").collect();
        let notes: Vec<&Section> = own.iter().filter(|s| s.name == "notes").collect();
        assert!(!faults.is_empty() || !notes.is_empty(), "{name}");

        for key in ["cheque", "card"] {
            let (input, cps) = books.input(key);
            let found = look_all(&input);
            let expected = own
                .iter()
                .find(|s| s.name == "expected" && s.str("account") == key);
            let Some(expected) = expected else {
                // The account agrees, so nothing is found but its notes: findings that explain
                // nothing (a gap a gap journal already fills).
                assert_eq!(input.window.first_differs, None, "{name} {key}");
                let got: Vec<(FindingKind, i64, Confidence)> = found
                    .iter()
                    .map(|f| (f.kind, f.explains.cents(), f.confidence))
                    .collect();
                let want: Vec<(FindingKind, i64, Confidence)> = notes
                    .iter()
                    .filter(|n| n.str("account") == key)
                    .map(|n| (kind(&n.str("suspect")), 0, Confidence::Likely))
                    .collect();
                assert_eq!(got, want, "{name} {key}:{}", show(&found));
                continue;
            };

            // The books are the ones the fixture describes.
            let w = &input.window;
            assert_eq!(
                w.difference.cents(),
                expected.int("difference_cents"),
                "{name} {key}: difference"
            );
            let shape = match w.shape {
                Shape::Jump => "jump",
                Shape::Constant => "constant",
                Shape::Drifting => "drifting",
            };
            let first = table(expected.get("first_differs"));
            let cp = &cps[w.first_differs.expect("out")];
            let of_day = if cp.source.balance == BalanceKind::Opening {
                "start"
            } else {
                "end"
            };
            let window = (shape, cp.date, of_day);
            let says = (
                expected.str("shape"),
                d(&first["date"]),
                unquote(&first["of_day"]),
            );
            assert_eq!(
                window,
                (says.0.as_str(), says.1, says.2.as_str()),
                "{name} {key}: window"
            );

            // Each fault is found, Likely, for exactly its amount: by one finding, or by all of its
            // suspect's Likely findings together.
            let mine: Vec<&&Section> = faults.iter().filter(|f| f.str("account") == key).collect();
            for f in &mine {
                let k = kind(&f.str("suspect"));
                let cents = f.int("explains_cents");
                let likely: Vec<&Finding> = found
                    .iter()
                    .filter(|x| x.kind == k && x.confidence == Confidence::Likely)
                    .collect();
                let total: i64 = likely.iter().map(|x| x.explains.cents()).sum();
                assert!(
                    !likely.is_empty()
                        && (total == cents || likely.iter().any(|x| x.explains.cents() == cents)),
                    "{name} {key}: {k:?} should explain {cents} Likely; found:{}",
                    show(&found)
                );
            }

            // Nothing else claims the whole difference as Likely, so the combiner isn't misled.
            let fault_kinds: BTreeSet<FindingKind> =
                mine.iter().map(|f| kind(&f.str("suspect"))).collect();
            let misleading: Vec<Finding> = found
                .iter()
                .filter(|x| {
                    x.confidence == Confidence::Likely
                        && !fault_kinds.contains(&x.kind)
                        && x.explains == w.difference
                })
                .cloned()
                .collect();
            assert!(
                misleading.is_empty(),
                "{name} {key}: other suspects claim it all:{}",
                show(&misleading)
            );
        }
    }
}

#[test]
fn the_same_books_give_the_same_findings() {
    let dir = root().join("11-two-faults");
    let toml = std::fs::read_to_string(dir.join("fault.toml")).unwrap();
    let a = look_all(&books(&dir, &toml).input("cheque").0);
    let mut input = books(&dir, &toml).input("cheque").0;
    input.lines.reverse();
    input.statements.reverse();
    input.journals.reverse();
    let b = look_all(&input);
    assert_eq!(a, b);
    assert!(!a.is_empty());
}

// ---- M18 Agent 5: the diagnosis. ----

/// A suggested fix's kind, as fault.toml names it.
fn fix_name(fix: &SuggestedFix) -> &'static str {
    match fix {
        SuggestedFix::MarkDuplicate { .. } => "MarkDuplicate",
        SuggestedFix::UnmarkDuplicate { .. } => "UnmarkDuplicate",
        SuggestedFix::SetOpeningBalance { .. } => "SetOpeningBalance",
        SuggestedFix::UploadMissing { .. } => "UploadMissing",
        SuggestedFix::RemoveStatement { .. } => "RemoveStatement",
        SuggestedFix::ReverseJournal { .. } => "ReverseJournal",
    }
}

/// The kind of a fault's first fix in fault.toml (`fix = [{ kind = "X", ... }]`), if it has one.
fn first_fix(fault: &Section) -> Option<String> {
    let v = fault.get("fix");
    let at = v.find("kind = ")?;
    Some(unquote(v[at + 7..].split([',', '}']).next()?))
}

#[test]
fn the_clean_set_needs_no_explaining() {
    let dir = root().join("clean");
    let toml = std::fs::read_to_string(dir.join("fixture.toml")).unwrap();
    let books = books(&dir, &toml);
    for key in ["cheque", "card"] {
        let (input, _) = books.input(key);
        let d = diagnose(&input.window, look_all(&input));
        assert!(d.difference.is_zero(), "{key}");
        assert!(d.explained_by.is_empty(), "{key}:{}", show(&d.explained_by));
        assert!(d.remainder.is_zero(), "{key}");
        assert!(
            d.other_findings.is_empty(),
            "{key}:{}",
            show(&d.other_findings)
        );
    }
}

#[test]
fn each_difference_is_explained_by_its_faults() {
    for dir in fixture_dirs() {
        let name = dir.file_name().unwrap().to_string_lossy().into_owned();
        let toml = std::fs::read_to_string(dir.join("fault.toml")).unwrap();
        let own = sections(&toml);
        let books = books(&dir, &toml);
        for key in ["cheque", "card"] {
            let (input, _) = books.input(key);
            let d = diagnose(&input.window, look_all(&input));
            let faults: Vec<&Section> = own
                .iter()
                .filter(|s| s.name == "faults" && s.str("account") == key)
                .collect();
            if faults.is_empty() {
                assert!(d.difference.is_zero(), "{name} {key}");
                assert!(d.explained_by.is_empty(), "{name} {key}");
                // A note explains nothing, so it's among the other findings, with its fix.
                for n in own
                    .iter()
                    .filter(|s| s.name == "notes" && s.str("account") == key)
                {
                    let k = kind(&n.str("suspect"));
                    let note = d
                        .other_findings
                        .iter()
                        .find(|x| x.kind == k && x.explains.is_zero())
                        .unwrap_or_else(|| panic!("{name} {key}: no {k:?} note"));
                    assert_eq!(
                        note.fix.as_ref().map(fix_name),
                        first_fix(n).as_deref(),
                        "{name} {key}: note's fix"
                    );
                }
                continue;
            }

            // Exactly the faults, each by one finding, with nothing left over.
            assert!(
                d.remainder.is_zero(),
                "{name} {key}: {} left over; explained by:{}
others:{}",
                d.remainder.cents(),
                show(&d.explained_by),
                show(&d.other_findings)
            );
            let mut got: Vec<(FindingKind, i64)> = d
                .explained_by
                .iter()
                .map(|f| (f.kind, f.explains.cents()))
                .collect();
            let mut want: Vec<(FindingKind, i64)> = faults
                .iter()
                .map(|f| (kind(&f.str("suspect")), f.int("explains_cents")))
                .collect();
            got.sort();
            want.sort();
            assert_eq!(got, want, "{name} {key}:{}", show(&d.explained_by));
            assert!(
                d.explained_by
                    .iter()
                    .all(|f| f.confidence == Confidence::Likely),
                "{name} {key}:{}",
                show(&d.explained_by)
            );

            // Each finding suggests the fix fault.toml gives first, and none where it gives none
            // (`fix = []`).
            for f in &faults {
                let k = kind(&f.str("suspect"));
                let finding = d.explained_by.iter().find(|x| x.kind == k).unwrap();
                let suggested = finding.fix.as_ref().map(fix_name);
                assert_eq!(suggested, first_fix(f).as_deref(), "{name} {key}: fix");
            }
        }
    }
}
