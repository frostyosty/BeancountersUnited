//! M18 Agent 8: the books the suspects see are the books the app has. Each fixture in
//! `fixtures/reconcile/` is set up through the command pipeline (its uploads, and the commands its
//! fault.toml replays), then `reconcile::suspect_input` loads what the suspects look at, and
//! `look_all` must find what `crates/import/tests/reconcile_suspects.rs` finds from the same
//! files: nothing on the clean set, each fault Likely with its exact amount and suggested fix,
//! and 02's gap (which a gap journal fills) as a note that explains nothing.

use std::collections::BTreeMap;

use acct_core::Money;
use acct_core::reconcile::suspects::{JournalOrigin, look_all};
use acct_core::reconcile::{
    BalanceKind, Confidence, Finding, FindingKind, Shape, SuggestedFix, diagnose,
};
use acct_server::commands::{Accepted, Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_server::reconcile::suspect_input;
use acct_store::Store;
use acct_store::bank as bank_store;
use acct_store::users::Role;
use chrono::{NaiveDate, TimeZone, Utc};
use tempfile::TempDir;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/reconcile");

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

// ---- A reader for the generated TOML: sections of single-line `key = value`s. ----

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

/// Top-level tables and arrays of tables, with each one's single-line values. Lines carrying on a
/// multi-line value (evidence) start with a space and are skipped.
fn sections(toml: &str) -> Vec<Section> {
    let mut out = vec![Section::default()];
    for line in toml.lines() {
        let code = strip_comment(line);
        let name = code
            .strip_prefix("[[")
            .and_then(|l| l.strip_suffix("]]"))
            .or_else(|| code.strip_prefix('[').and_then(|l| l.strip_suffix(']')));
        if let Some(name) = name {
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

/// `{ a = 1, b = "x" }` as a map (no nesting).
fn table(v: &str) -> BTreeMap<String, String> {
    v.trim()
        .trim_start_matches('{')
        .trim_end_matches('}')
        .split(", ")
        .filter_map(|kv| kv.split_once(" = "))
        .map(|(k, v)| (k.trim().to_owned(), unquote(v)))
        .collect()
}

/// The kind of a fault's first fix (`fix = [{ kind = "X", ... }]`), if it has one.
fn first_fix(s: &Section) -> Option<String> {
    let v = s.get("fix");
    let at = v.find("kind = ")?;
    Some(unquote(v[at + 7..].split([',', '}']).next()?))
}

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

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ABC[(n >> (18 - 6 * i) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
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

// ---- A fixture's books, through the command pipeline. ----

struct Books {
    _dir: TempDir,
    store: Store,
    client: String,
    /// Account key (`cheque`, `card`) → bank account id.
    accounts: BTreeMap<String, String>,
}

impl Books {
    async fn ok(&self, command: Command) -> Accepted {
        let kind = command.kind();
        let actor = Actor {
            user_id: None,
            role: Role::PracticeAdmin,
            acting_as: None,
        };
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        let at = Utc.with_ymd_and_hms(2026, 10, 23, 0, 0, 0).unwrap();
        submit(&self.store, &actor, envelope, at)
            .await
            .unwrap_or_else(|e| panic!("{kind}: {:?}", e.body()))
    }

    /// The business and accounts from `clean/fixture.toml`, then the fixture's own uploads and
    /// commands (`fault.toml`, or the clean set's `fixture.toml`).
    async fn load(fixture: &str) -> (Books, Vec<Section>) {
        let setup =
            sections(&std::fs::read_to_string(format!("{ROOT}/clean/fixture.toml")).unwrap());
        let own_file = if fixture == "clean" {
            "fixture.toml"
        } else {
            "fault.toml"
        };
        let own =
            sections(&std::fs::read_to_string(format!("{ROOT}/{fixture}/{own_file}")).unwrap());

        let dir = TempDir::new().unwrap();
        let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
        let mut books = Books {
            _dir: dir,
            store,
            client: String::new(),
            accounts: BTreeMap::new(),
        };
        books
            .ok(Command::CreateMasterChart {
                entity_type: "sole_trader".into(),
                name: "Sole trader".into(),
                accounts: serde_json::from_str(include_str!(
                    "../../../fixtures/practice/sole-trader-chart.json"
                ))
                .unwrap(),
            })
            .await;
        let template_id = books
            .ok(Command::CreateTemplate {
                entity_type: "sole_trader".into(),
                name: "Sole trader".into(),
                body: serde_json::from_str(include_str!(
                    "../../../fixtures/practice/sole-trader-template.json"
                ))
                .unwrap(),
            })
            .await
            .entity_id
            .unwrap();
        books
            .ok(Command::CreateMapping {
                template_id,
                name: "Sole trader".into(),
                body: serde_json::from_str(include_str!(
                    "../../../fixtures/practice/sole-trader-mapping.json"
                ))
                .unwrap(),
            })
            .await;
        let business = setup.iter().find(|s| s.name == "business").unwrap();
        books.client = books
            .ok(Command::SetUpBusiness {
                name: business.str("name"),
                start_date: d(business.get("start_date")),
                gst: None,
            })
            .await
            .entity_id
            .unwrap();
        for a in setup.iter().filter(|s| s.name == "accounts") {
            let command = match a.str("command").as_str() {
                "AddBankAccount" => Command::AddBankAccount {
                    client_id: books.client.clone(),
                    name: a.str("name"),
                    account_number: Some(a.str("number")),
                },
                "AddCardAccount" => Command::AddCardAccount {
                    client_id: books.client.clone(),
                    name: a.str("name"),
                    card_number: Some(a.str("number")),
                },
                other => panic!("unexpected {other}"),
            };
            let id = books.ok(command).await.entity_id.unwrap();
            books.accounts.insert(a.str("key"), id);
        }

        let commands: Vec<&Section> = own.iter().filter(|s| s.name == "commands").collect();
        for c in commands
            .iter()
            .filter(|c| c.str("when") == "before_uploads")
        {
            books.replay(c).await;
        }
        for u in own.iter().filter(|s| s.name == "uploads") {
            let file = u.str("file");
            let bytes = std::fs::read(format!("{ROOT}/{fixture}/{file}")).unwrap();
            let bank_account_id = (u.get("choose_account") == "true")
                .then(|| books.accounts[&u.str("account")].clone());
            books
                .ok(Command::ImportStatement {
                    client_id: books.client.clone(),
                    file_name: file,
                    content_base64: base64(&bytes),
                    bank_account_id,
                })
                .await;
        }
        for c in commands.iter().filter(|c| c.str("when") == "after_uploads") {
            books.replay(c).await;
        }
        (books, own)
    }

    async fn replay(&self, c: &Section) {
        let command = match c.str("kind").as_str() {
            "SetOpeningBalance" => Command::SetOpeningBalance {
                bank_account_id: self.accounts[&c.str("account")].clone(),
                balance: Money::from_cents(c.int("balance_cents")),
            },
            "ResolveDuplicate" => Command::ResolveDuplicate {
                bank_line_id: self.line_id(&table(c.get("line"))).await,
                is_duplicate: c.get("is_duplicate") == "true",
            },
            other => panic!("replaying {other} isn't supported here"),
        };
        self.ok(command).await;
    }

    /// The stored line a fixture names by file, date, amount and description.
    async fn line_id(&self, line: &BTreeMap<String, String>) -> String {
        let mut conn = self.store.reader().await.unwrap();
        let date = d(&line["date"]);
        let amount = Money::from_cents(line["amount_cents"].parse().unwrap());
        for l in bank_store::bank_lines(&mut conn, &self.client)
            .await
            .unwrap()
        {
            let s = bank_store::statement(&mut conn, &l.statement_id)
                .await
                .unwrap()
                .unwrap();
            if s.file_name == line["file"]
                && l.date == date
                && l.amount == amount
                && l.description == line["description"]
            {
                return l.id;
            }
        }
        panic!("no stored line {line:?}")
    }

    async fn findings(
        &self,
        key: &str,
    ) -> (acct_core::reconcile::suspects::SuspectInput, Vec<Finding>) {
        let mut conn = self.store.reader().await.unwrap();
        let input = suspect_input(&mut conn, &self.client, &self.accounts[key])
            .await
            .unwrap();
        let found = look_all(&input);
        (input, found)
    }
}

/// Checks one fixture's server books against its fault.toml, as reconcile_suspects.rs checks the
/// books it builds from the same files.
async fn check(fixture: &str) {
    let (books, own) = Books::load(fixture).await;
    for key in ["cheque", "card"] {
        let (input, found) = books.findings(key).await;
        // (The clean set's `[expected]` has the closing balances, for no one account.)
        let at = |s: &Section| s.fields.get("account").map(|a| unquote(a)).as_deref() == Some(key);
        let faults: Vec<&Section> = own.iter().filter(|s| s.name == "faults" && at(s)).collect();
        let notes: Vec<&Section> = own.iter().filter(|s| s.name == "notes" && at(s)).collect();
        let expected = own.iter().find(|s| s.name == "expected" && at(s));
        let diagnosis = diagnose(&input.window, found.clone());

        let Some(expected) = expected else {
            // The account agrees: nothing found but its notes, which explain nothing.
            assert_eq!(input.window.first_differs, None, "{fixture} {key}");
            let got: Vec<(FindingKind, i64, Confidence, Option<&str>)> = found
                .iter()
                .map(|f| {
                    (
                        f.kind,
                        f.explains.cents(),
                        f.confidence,
                        f.fix.as_ref().map(fix_name),
                    )
                })
                .collect();
            let fixes: Vec<Option<String>> = notes.iter().map(|n| first_fix(n)).collect();
            let want: Vec<(FindingKind, i64, Confidence, Option<&str>)> = notes
                .iter()
                .zip(&fixes)
                .map(|(n, f)| (kind(&n.str("suspect")), 0, Confidence::Likely, f.as_deref()))
                .collect();
            assert_eq!(got, want, "{fixture} {key}:{}", show(&found));
            assert!(diagnosis.explained_by.is_empty(), "{fixture} {key}");
            continue;
        };

        // The window is the one the fixture expects.
        let w = &input.window;
        assert_eq!(
            w.difference.cents(),
            expected.int("difference_cents"),
            "{fixture} {key}: difference"
        );
        let shape = match w.shape {
            Shape::Jump => "jump",
            Shape::Constant => "constant",
            Shape::Drifting => "drifting",
        };
        let first = table(expected.get("first_differs"));
        let cp = &input.checkpoints[w.first_differs.expect("out")];
        let of_day = if cp.source.balance == BalanceKind::Opening {
            "start"
        } else {
            "end"
        };
        assert_eq!(
            (shape, cp.date, of_day),
            (
                expected.str("shape").as_str(),
                d(&first["date"]),
                first["of_day"].as_str()
            ),
            "{fixture} {key}: window"
        );

        // Each fault is found Likely, for its exact amount, with the fix fault.toml gives.
        for f in &faults {
            let k = kind(&f.str("suspect"));
            let cents = f.int("explains_cents");
            let finding = found
                .iter()
                .find(|x| {
                    x.kind == k && x.confidence == Confidence::Likely && x.explains.cents() == cents
                })
                .unwrap_or_else(|| {
                    panic!(
                        "{fixture} {key}: {k:?} should explain {cents} Likely; found:{}",
                        show(&found)
                    )
                });
            assert_eq!(
                finding.fix.as_ref().map(fix_name),
                first_fix(f).as_deref(),
                "{fixture} {key}: fix"
            );
        }

        // And together they explain the whole difference.
        assert!(
            diagnosis.remainder.is_zero(),
            "{fixture} {key}: {} left over:{}",
            diagnosis.remainder.cents(),
            show(&diagnosis.explained_by)
        );
        let mut got: Vec<(FindingKind, i64)> = diagnosis
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
        assert_eq!(got, want, "{fixture} {key}");
    }
}

#[tokio::test]
async fn the_clean_set_gives_the_suspects_nothing() {
    check("clean").await;
}

/// The gap journal fills August, so the books agree, and missing lines says so in a note.
#[tokio::test]
async fn a_gap_the_server_filled_is_a_note() {
    check("02-missing-lines").await;
    let (books, _) = Books::load("02-missing-lines").await;
    let (input, _) = books.findings("cheque").await;
    let gap = input
        .journals
        .iter()
        .find(|j| {
            j.origin
                == JournalOrigin::Gap {
                    start: d("2025-08-01"),
                    end: d("2025-08-31"),
                }
        })
        .expect("a gap journal for August");
    assert_eq!(gap.amount, Money::from_cents(41918));
    assert_eq!(gap.date, d("2025-08-31"));
}

/// The swapped November file's running balances don't follow from its amounts: only the last is a
/// checkpoint, and its own balance check breaks at the first row, which is a stored line.
#[tokio::test]
async fn a_sign_the_wrong_way() {
    check("04-sign-wrong-way").await;
    let (books, _) = Books::load("04-sign-wrong-way").await;
    let (input, _) = books.findings("cheque").await;
    let nov = input
        .statements
        .iter()
        .find(|s| s.file_name == "kowhai-cheque-2025-11.csv")
        .unwrap();
    let broken = nov.balance_break.as_ref().expect("its balance check fails");
    let line = broken.bank_line_id.as_deref().expect("at a stored line");
    let line = input.lines.iter().find(|l| l.id == line).unwrap();
    assert_eq!(line.statement_id, nov.id);
    assert_eq!(line.date, d("2025-11-03"));
}

/// The OFX's LEDGERBAL is dated 31 Mar but includes a line it dates 1 Apr: the closing
/// checkpoint is the end of 31 Mar, where the statement's coverage runs to 1 Apr.
#[tokio::test]
async fn a_date_cut_off() {
    check("07-date-cut-off").await;
    let (books, _) = Books::load("07-date-cut-off").await;
    let (input, _) = books.findings("card").await;
    let q4 = input
        .statements
        .iter()
        .find(|s| s.file_name == "visa-2026-01-01_03-31.ofx")
        .unwrap();
    assert_eq!(
        q4.end,
        d("2026-04-01"),
        "the coverage takes in the 1 Apr line"
    );
    let closing = input
        .checkpoints
        .iter()
        .find(|c| c.source.statement_id == q4.id && c.source.balance == BalanceKind::Closing)
        .unwrap();
    assert_eq!(closing.date, d("2026-03-31"));
    assert_eq!(q4.stated_opening, None, "an OFX states only its closing");
}

#[tokio::test]
async fn two_faults() {
    check("11-two-faults").await;
}
