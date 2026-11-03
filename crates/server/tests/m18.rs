//! M18's done check (`m18_is_done`), Agent 7b. Every fixture in `fixtures/reconcile/` is set up
//! through the command pipeline (its uploads, then the commands its fault.toml replays), and then:
//!
//! - every upload's result carries a proof whose bank side has an excerpt from the file kept;
//! - the clean set agrees at every statement's closing date and at 31 March;
//! - each single-fault fixture's diagnosis names its fault first, with the exact amount, in the
//!   window fault.toml expects, and sending the suggested fix (as the card does) makes the proof
//!   agree. Faults with no fix (07, 09) carry none; 02's gap is a note, and uploading the missing
//!   statement leaves no gap journal live; 11 is explained in full, with nothing left over;
//! - uploading any file again stores no second copy.
//!
//! If a fixture fails because the server and the fixtures build different books, the test is the
//! record of it: don't loosen it, find out why.

use std::collections::BTreeMap;

use acct_core::Money;
use acct_core::reconcile::{BalanceKind, Finding, FindingKind, Shape, SuggestedFix};
use acct_server::business::{AccountProof, UploadCheck, account_proof};
use acct_server::commands::{Accepted, Command, CommandEnvelope, Via};
use acct_server::error::CommandError;
use acct_server::pipeline::{Actor, submit_via};
use acct_server::statement_files::{ExcerptQuery, excerpt};
use acct_store::Store;
use acct_store::bank as bank_store;
use acct_store::users::Role;
use chrono::{NaiveDate, TimeZone, Utc};
use tempfile::TempDir;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/reconcile");

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

// ---- A reader for the generated TOML, as tests/m18_fixes.rs reads it. ----

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
        self.get(key).trim().trim_matches('"').to_owned()
    }

    fn int(&self, key: &str) -> i64 {
        self.get(key).parse().unwrap()
    }
}

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

/// `{ a = 1, b = "x" }` as a map. A nested `{ ... }` value is kept as its text.
fn table(v: &str) -> BTreeMap<String, String> {
    let inner = v.trim().trim_start_matches('{').trim_end_matches('}');
    let mut out = BTreeMap::new();
    let (mut depth, mut start) = (0, 0);
    let mut parts = Vec::new();
    for (i, c) in inner.char_indices() {
        match c {
            '{' | '[' => depth += 1,
            '}' | ']' => depth -= 1,
            ',' if depth == 0 => {
                parts.push(&inner[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&inner[start..]);
    for p in parts {
        if let Some((k, v)) = p.split_once(" = ") {
            out.insert(k.trim().to_owned(), v.trim().trim_matches('"').to_owned());
        }
    }
    out
}

/// A fault's fix list (`fix = [{ kind = "X", ... }, ...]`): each step's fields. Empty for `[]`.
fn fix_steps(s: &Section) -> Vec<BTreeMap<String, String>> {
    let v = s.get("fix").trim();
    let inner = v.trim_start_matches('[').trim_end_matches(']').trim();
    if inner.is_empty() {
        return Vec::new();
    }
    inner
        .split("}, ")
        .map(|step| table(&format!("{}}}", step.trim_end_matches('}'))))
        .collect()
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

// ---- A fixture's books, through the command pipeline. ----

struct Books {
    _dir: TempDir,
    store: Store,
    client: String,
    /// Account key (`cheque`, `card`) → bank account id.
    accounts: BTreeMap<String, String>,
    fixture: String,
}

const OWNER: Actor = Actor {
    user_id: None,
    role: Role::PracticeAdmin,
};

/// What one upload returned, by file name.
type Checks = Vec<(String, UploadCheck)>;

impl Books {
    async fn send(&self, command: Command, via: Option<Via>) -> Result<Accepted, CommandError> {
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        let at = Utc.with_ymd_and_hms(2026, 10, 23, 0, 0, 0).unwrap();
        submit_via(&self.store, &OWNER, envelope, via, at).await
    }

    async fn ok(&self, command: Command) -> Accepted {
        let kind = command.kind();
        self.send(command, None)
            .await
            .unwrap_or_else(|e| panic!("{}: {kind}: {:?}", self.fixture, e.body()))
    }

    /// The business and accounts from `clean/fixture.toml`, then the fixture's own uploads and
    /// commands (`fault.toml`, or the clean set's `fixture.toml`). Returns the books, the
    /// fixture's own sections and each upload's check.
    async fn load(fixture: &str) -> (Books, Vec<Section>, Checks) {
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
            fixture: fixture.to_owned(),
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
        let mut checks = Vec::new();
        for u in own.iter().filter(|s| s.name == "uploads") {
            let file = u.str("file");
            let choose = (u.get("choose_account") == "true").then(|| u.str("account"));
            let check = books.upload(fixture, &file, choose.as_deref()).await;
            checks.push((file, check));
        }
        for c in commands.iter().filter(|c| c.str("when") == "after_uploads") {
            books.replay(c).await;
        }
        (books, own, checks)
    }

    /// Uploads `file` (a path under the fixture's directory), as the app does, optionally naming
    /// the account.
    async fn upload(&self, fixture: &str, file: &str, account: Option<&str>) -> UploadCheck {
        let bytes = std::fs::read(format!("{ROOT}/{fixture}/{file}")).unwrap();
        let name = file.rsplit('/').next().unwrap().to_owned();
        self.ok(Command::ImportStatement {
            client_id: self.client.clone(),
            file_name: name.clone(),
            content_base64: base64(&bytes),
            bank_account_id: account.map(|a| self.accounts[a].clone()),
        })
        .await
        .upload
        .unwrap_or_else(|| panic!("{}: {name}: no check in the result", self.fixture))
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
            "PostJournal" => {
                let year_end = d(&format!("{}-03-31", c.get("client_year")));
                let mut conn = self.store.reader().await.unwrap();
                let year = acct_store::years::for_client(&mut conn, &self.client)
                    .await
                    .unwrap()
                    .into_iter()
                    .find(|y| y.year.end() == year_end)
                    .unwrap();
                let lines = c
                    .get("lines")
                    .trim_matches(['[', ']'])
                    .split("}, ")
                    .map(table)
                    .map(|l| {
                        serde_json::from_value(serde_json::json!({
                            "account": l["account"],
                            "amount": l["amount_cents"].parse::<i64>().unwrap(),
                        }))
                        .unwrap()
                    })
                    .collect();
                Command::PostJournal {
                    client_year_id: year.id,
                    date: d(c.get("date")),
                    narration: c.str("narration"),
                    lines,
                }
            }
            other => panic!("replaying {other} isn't supported here"),
        };
        self.ok(command).await;
    }

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
        panic!("{}: no stored line {line:?}", self.fixture)
    }

    async fn proof(&self, key: &str, date: NaiveDate) -> AccountProof {
        let mut conn = self.store.reader().await.unwrap();
        account_proof(&mut conn, &self.accounts[key], date, None)
            .await
            .unwrap()
    }

    async fn statements(&self, key: &str) -> Vec<bank_store::StoredStatement> {
        let mut conn = self.store.reader().await.unwrap();
        bank_store::statements(&mut conn, &self.accounts[key])
            .await
            .unwrap()
    }

    /// The card's first explanation, sent as the card sends it (`via: finding`).
    async fn send_first_fix(&self, key: &str, date: NaiveDate) -> Finding {
        let p = self.proof(key, date).await;
        let f = p
            .findings
            .expect("findings")
            .diagnosis
            .explained_by
            .into_iter()
            .next()
            .expect("an explanation");
        let command = match f.fix.clone().expect("a fix") {
            SuggestedFix::MarkDuplicate { bank_line_id } => Command::ResolveDuplicate {
                bank_line_id,
                is_duplicate: true,
            },
            SuggestedFix::UnmarkDuplicate { bank_line_id } => Command::ResolveDuplicate {
                bank_line_id,
                is_duplicate: false,
            },
            SuggestedFix::SetOpeningBalance {
                bank_account_id,
                amount,
                ..
            } => Command::SetOpeningBalance {
                bank_account_id,
                balance: amount,
            },
            SuggestedFix::RemoveStatement { statement_id } => {
                Command::RemoveStatement { statement_id }
            }
            SuggestedFix::ReverseJournal { journal_id } => Command::ReverseJournal {
                journal_id,
                date: None,
                narration: None,
            },
            SuggestedFix::UploadMissing { .. } => panic!("an upload isn't a command"),
        };
        self.send(command, Some(Via::Finding { finding: f.kind }))
            .await
            .unwrap_or_else(|e| panic!("{}: the fix: {:?}", self.fixture, e.body()));
        f
    }
}

fn difference(p: &AccountProof) -> Option<Money> {
    p.proof.difference()
}

/// Every finding the card carries, explaining or not.
fn all_findings(p: &AccountProof) -> Vec<&Finding> {
    let x = p.findings.as_ref().expect("findings");
    x.diagnosis
        .explained_by
        .iter()
        .chain(&x.diagnosis.other_findings)
        .collect()
}

// ---- The checks. ----

/// Each upload's proof has the excerpt of the file it came from: the lines around the balance, the
/// balance marked, and the file's SHA-256, all from the bytes uploaded.
async fn check_excerpts(books: &Books, fixture: &str, checks: &Checks) {
    for (file, check) in checks {
        let proofs = std::iter::once(&check.at_end).chain(check.at_balance_date.as_ref());
        for p in proofs {
            let ctx = format!("{fixture}: {file}");
            let bank = p
                .proof
                .bank
                .as_ref()
                .unwrap_or_else(|| panic!("{ctx}: the proof has no bank side"));
            let source = &bank.checkpoint.source;
            assert!(source.span.is_some(), "{ctx}: where the file says it");
            let q = match &source.balance {
                BalanceKind::Opening => ExcerptQuery {
                    kind: Some("opening".into()),
                    line: None,
                },
                BalanceKind::Closing => ExcerptQuery {
                    kind: Some("closing".into()),
                    line: None,
                },
                BalanceKind::Running { bank_line_id } => ExcerptQuery {
                    kind: Some("running".into()),
                    line: Some(bank_line_id.clone()),
                },
            };
            let mut conn = books.store.reader().await.unwrap();
            let x = excerpt(&mut conn, &source.statement_id, &q).await.unwrap();
            assert!(x.kept, "{ctx}: the file was kept");
            assert!(x.sha256.as_deref().is_some_and(|h| h.len() == 64), "{ctx}");
            assert!(!x.lines.is_empty(), "{ctx}: no excerpt");
            let at = x.highlight.expect("the balance is marked");
            assert!(x.lines.iter().any(|l| l.number == at.line), "{ctx}");
            // The balance may be the nearest the bank stated, in an earlier file: check against the
            // file the excerpt names, line by line.
            let source_bytes = std::fs::read(format!("{ROOT}/{fixture}/{}", x.file_name)).unwrap();
            let source_text = String::from_utf8_lossy(&source_bytes).replace("\r\n", "\n");
            let source_lines: Vec<&str> = source_text.split('\n').collect();
            for l in &x.lines {
                // Long lines are cut, so compare the start.
                let want = source_lines[l.number as usize - 1];
                let head: String = l.text.chars().take(40).collect();
                assert!(
                    want.starts_with(head.trim_end_matches('…')),
                    "{ctx}: line {} of {} isn't from the file: {:?}",
                    l.number,
                    x.file_name,
                    l.text
                );
            }
        }
    }
}

/// Uploading any of the fixture's files again stores nothing new.
async fn check_reupload(books: &Books, fixture: &str, checks: &Checks) {
    let count = |statements: &[bank_store::StoredStatement]| statements.len();
    let before = [
        count(&books.statements("cheque").await),
        count(&books.statements("card").await),
    ];
    for (file, was) in checks {
        // The account it went to the first time (a file that names none is chosen again).
        let key = books
            .accounts
            .iter()
            .find(|(_, id)| **id == was.bank_account_id)
            .map(|(k, _)| k.as_str());
        let check = books.upload(fixture, file, key).await;
        assert_eq!(
            check.statement_id, None,
            "{fixture}: {file} stored a second copy"
        );
    }
    let after = [
        count(&books.statements("cheque").await),
        count(&books.statements("card").await),
    ];
    assert_eq!(before, after, "{fixture}: statements after uploading again");
}

/// The clean set agrees wherever the bank states a balance: at the end of every statement, and at
/// 31 March.
async fn check_clean(books: &Books, own: &[Section], checks: &Checks) {
    for (file, check) in checks {
        assert_eq!(
            difference(&check.at_end),
            Some(Money::ZERO),
            "clean: {file} when uploaded"
        );
    }
    let expected = own.iter().find(|s| s.name == "expected").unwrap();
    for (key, cents) in [
        ("cheque", expected.int("cheque_cents")),
        ("card", expected.int("card_cents")),
    ] {
        for s in books.statements(key).await {
            let p = books.proof(key, s.end_date).await;
            assert_eq!(
                difference(&p),
                Some(Money::ZERO),
                "clean: {key} at {}'s closing date {}",
                s.file_name,
                s.end_date
            );
        }
        let p = books.proof(key, d("2026-03-31")).await;
        assert_eq!(
            difference(&p),
            Some(Money::ZERO),
            "clean: {key} at 31 March"
        );
        assert_eq!(p.proof.ledger, Money::from_cents(cents), "clean: {key}");
        assert!(
            all_findings(&p).iter().all(|f| f.explains.is_zero()),
            "clean: {key} has findings that explain something"
        );
    }
}

/// The window fault.toml expects, in the proof's terms.
fn check_window(fixture: &str, key: &str, p: &AccountProof, expected: &Section) {
    let ctx = format!("{fixture} {key}");
    assert_eq!(
        difference(p).map(Money::cents),
        Some(expected.int("difference_cents")),
        "{ctx}: difference"
    );
    let shape = match p.proof.window.shape {
        Shape::Jump => "jump",
        Shape::Constant => "constant",
        Shape::Drifting => "drifting",
    };
    assert_eq!(shape, expected.str("shape"), "{ctx}: shape");
    let end_or_start = |c: &acct_core::reconcile::CheckpointAt| {
        (
            c.checkpoint.date,
            if c.checkpoint.source.balance == BalanceKind::Opening {
                "start"
            } else {
                "end"
            },
        )
    };
    let first = table(expected.get("first_differs"));
    let got = p.proof.window.first_differs.as_ref().map(end_or_start);
    assert_eq!(
        got,
        Some((d(&first["date"]), first["of_day"].as_str())),
        "{ctx}: where it first differs"
    );
    let last = expected.get("last_agrees");
    // The start of one day and the end of the one before are the same moment, and two statements
    // can state it (October's closing, November's opening): compare the moment, not the label.
    let moment = |(date, of_day): (NaiveDate, &str)| {
        if of_day == "start" {
            date.pred_opt().unwrap()
        } else {
            date
        }
    };
    let got = p
        .proof
        .window
        .last_agrees
        .as_ref()
        .map(end_or_start)
        .map(moment);
    if last.starts_with('{') {
        let last = table(last);
        assert_eq!(
            got,
            Some(moment((d(&last["date"]), last["of_day"].as_str()))),
            "{ctx}: where it last agreed"
        );
    } else {
        assert_eq!(got, None, "{ctx}: nothing agreed before it");
    }
}

/// One fixture with faults: diagnosis, window, then the fix.
async fn check_fault(books: &Books, own: &[Section]) {
    let fixture = books.fixture.as_str();
    let expecteds: Vec<&Section> = own
        .iter()
        .filter(|s| s.name == "expected" && s.fields.contains_key("account"))
        .collect();
    let notes: Vec<&Section> = own.iter().filter(|s| s.name == "notes").collect();

    // The accounts that agree carry only notes, which explain nothing.
    for n in &notes {
        check_note(books, fixture, n).await;
    }
    assert!(
        !expecteds.is_empty() || !notes.is_empty(),
        "{fixture}: nothing to check"
    );

    for expected in expecteds {
        let key = expected.str("account");
        let date = d(&expected.str("proof_date"));
        let faults: Vec<&Section> = own
            .iter()
            .filter(|s| s.name == "faults" && s.str("account") == key)
            .collect();
        let p = books.proof(&key, date).await;
        check_window(fixture, &key, &p, expected);

        // The diagnosis names the faults, with their exact amounts, and nothing is left over.
        let diagnosis = &p.findings.as_ref().expect("findings").diagnosis;
        let show = || format!("{:?}", diagnosis.explained_by);
        let mut got: Vec<(FindingKind, i64)> = diagnosis
            .explained_by
            .iter()
            .map(|f| (f.kind, f.explains.cents()))
            .collect();
        let mut want: Vec<(FindingKind, i64)> = faults
            .iter()
            .map(|f| (kind(&f.str("suspect")), f.int("explains_cents")))
            .collect();
        if faults.len() == 1 {
            assert_eq!(
                got.first(),
                want.first(),
                "{fixture} {key}: the first explanation: {}",
                show()
            );
        }
        got.sort();
        want.sort();
        assert_eq!(got, want, "{fixture} {key}: explained by");
        assert!(
            diagnosis.remainder.is_zero(),
            "{fixture} {key}: {} left over: {}",
            diagnosis.remainder.cents(),
            show()
        );

        // A fault with no fix carries none; the rest are sent in order.
        let no_fix: Vec<&&Section> = faults.iter().filter(|f| fix_steps(f).is_empty()).collect();
        for f in &no_fix {
            let k = kind(&f.str("suspect"));
            let finding = diagnosis.explained_by.iter().find(|x| x.kind == k).unwrap();
            assert!(finding.fix.is_none(), "{fixture} {key}: {k:?} has no fix");
        }
        if !no_fix.is_empty() {
            continue;
        }
        let mut sent = 0;
        while difference(&books.proof(&key, date).await) != Some(Money::ZERO) {
            sent += 1;
            assert!(
                sent <= faults.len(),
                "{fixture} {key}: still out after fixes"
            );
            let f = books.send_first_fix(&key, date).await;
            let fault = faults
                .iter()
                .find(|x| kind(&x.str("suspect")) == f.kind)
                .unwrap_or_else(|| panic!("{fixture} {key}: a fix for {:?}", f.kind));
            let steps = fix_steps(fault);
            assert_eq!(
                steps[0]["kind"],
                fix_name(f.fix.as_ref().unwrap()),
                "{fixture} {key}: the fix fault.toml names"
            );
            // The rest of a fix: upload the clean file again (04).
            for step in &steps[1..] {
                assert_eq!(step["kind"], "Upload", "{fixture} {key}");
                books.upload(fixture, &step["file"], None).await;
            }
        }
        assert!(sent > 0, "{fixture} {key}: nothing to fix");
        let p = books.proof(&key, date).await;
        assert_eq!(difference(&p), Some(Money::ZERO), "{fixture} {key}: after");
        assert!(
            p.findings.unwrap().diagnosis.explained_by.is_empty(),
            "{fixture} {key}: still explained by something after its fix"
        );
    }
}

/// 02: the gap journal fills the gap, so the account agrees and the card holds a note that
/// explains nothing, with the upload that fixes it. Uploading the missing statement leaves no
/// gap journal live and no note.
async fn check_note(books: &Books, fixture: &str, note: &Section) {
    let key = note.str("account");
    let date = d("2026-03-31");
    let p = books.proof(&key, date).await;
    assert_eq!(difference(&p), Some(Money::ZERO), "{fixture} {key}");
    let k = kind(&note.str("suspect"));
    let notes: Vec<&Finding> = all_findings(&p)
        .into_iter()
        .filter(|f| f.kind == k)
        .collect();
    assert_eq!(notes.len(), 1, "{fixture} {key}: one {k:?} note");
    assert!(
        notes[0].explains.is_zero(),
        "{fixture} {key}: explains nothing"
    );
    assert!(
        p.findings
            .as_ref()
            .unwrap()
            .diagnosis
            .explained_by
            .is_empty(),
        "{fixture} {key}: a note is not an explanation"
    );
    let steps = fix_steps(note);
    assert_eq!(
        notes[0].fix.as_ref().map(fix_name),
        Some(steps[0]["kind"].as_str()),
        "{fixture} {key}: the note's fix"
    );
    {
        let mut conn = books.store.reader().await.unwrap();
        let gaps = bank_store::live_gap_journals(&mut conn, &books.accounts[&key])
            .await
            .unwrap();
        assert_eq!(
            gaps.len(),
            1,
            "{fixture} {key}: a gap journal fills the gap"
        );
    }

    books.upload(fixture, &steps[0]["file"], None).await;
    let p = books.proof(&key, date).await;
    assert_eq!(difference(&p), Some(Money::ZERO), "{fixture} {key}: after");
    let mut conn = books.store.reader().await.unwrap();
    let gaps = bank_store::live_gap_journals(&mut conn, &books.accounts[&key])
        .await
        .unwrap();
    assert!(
        gaps.is_empty(),
        "{fixture} {key}: a gap journal is still live"
    );
    assert!(
        all_findings(&p).iter().all(|f| f.kind != k),
        "{fixture} {key}: the note is still there"
    );
}

#[tokio::test]
async fn m18_is_done() {
    let mut fixtures: Vec<String> = std::fs::read_dir(ROOT)
        .unwrap()
        .map(|e| e.unwrap())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().into_string().unwrap())
        .collect();
    fixtures.sort();
    assert_eq!(
        fixtures.len(),
        13,
        "the clean set and twelve variants: {fixtures:?}"
    );
    for fixture in &fixtures {
        let (books, own, checks) = Books::load(fixture).await;
        check_excerpts(&books, fixture, &checks).await;
        if fixture == "clean" {
            check_clean(&books, &own, &checks).await;
        }
        check_reupload(&books, fixture, &checks).await;
        if fixture != "clean" {
            check_fault(&books, &own).await;
        }
    }
}
