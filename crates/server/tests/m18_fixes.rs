//! M18 Agent 6: every fix a finding suggests goes through, and says where it came from.
//!
//! Each fixture in `fixtures/reconcile/` is set up through the command pipeline (its uploads and
//! the commands its fault.toml replays). Bank vs books then names the fault, and sending the fix
//! it suggests (with `via: finding`, as the card does) makes the card agree. Also: the two new
//! write paths (`remove_statement`, and correcting an opening balance with `set_opening_balance`)
//! refuse a finalised year, and an amount read wrong is logged with the parser and the row only.

use std::collections::BTreeMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use acct_core::Money;
use acct_core::reconcile::{FindingKind, SuggestedFix};
use acct_server::business::{AccountProof, account_proof};
use acct_server::commands::{Accepted, Command, CommandEnvelope, Via};
use acct_server::error::CommandError;
use acct_server::history::{Changes, describe};
use acct_server::pipeline::{Actor, submit_via};
use acct_server::save_tax::{CardKind, queue};
use acct_store::bank as bank_store;
use acct_store::users::Role;
use acct_store::{Store, journals, log, years};
use chrono::{NaiveDate, TimeZone, Utc};
use tempfile::TempDir;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/reconcile");

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

// ---- A reader for the generated TOML, as tests/m18_suspect_input.rs reads it. ----

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
}

const OWNER: Actor = Actor {
    user_id: None,
    role: Role::PracticeAdmin,
};

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
            .unwrap_or_else(|e| panic!("{kind}: {:?}", e.body()))
    }

    async fn load(fixture: &str) -> Books {
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
            books.upload(fixture, u).await;
        }
        for c in commands.iter().filter(|c| c.str("when") == "after_uploads") {
            books.replay(c).await;
        }
        books
    }

    async fn upload(&self, fixture: &str, u: &Section) -> Accepted {
        let file = u.str("file");
        let bytes = std::fs::read(format!("{ROOT}/{fixture}/{file}")).unwrap();
        let bank_account_id =
            (u.get("choose_account") == "true").then(|| self.accounts[&u.str("account")].clone());
        self.ok(Command::ImportStatement {
            client_id: self.client.clone(),
            file_name: file,
            content_base64: base64(&bytes),
            bank_account_id,
        })
        .await
    }

    async fn replay(&self, c: &Section) {
        let command = match c.str("kind").as_str() {
            "SetOpeningBalance" => Command::SetOpeningBalance {
                bank_account_id: self.accounts[&c.str("account")].clone(),
                balance: Money::from_cents(c.get("balance_cents").parse().unwrap()),
            },
            "ResolveDuplicate" => Command::ResolveDuplicate {
                bank_line_id: self.line_id(&table(c.get("line"))).await,
                is_duplicate: c.get("is_duplicate") == "true",
            },
            "PostJournal" => {
                let year_end = d(&format!("{}-03-31", c.get("client_year")));
                let mut conn = self.store.reader().await.unwrap();
                let year = years::for_client(&mut conn, &self.client)
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
        panic!("no stored line {line:?}")
    }

    async fn proof(&self, key: &str, date: &str) -> AccountProof {
        let mut conn = self.store.reader().await.unwrap();
        account_proof(&mut conn, &self.accounts[key], d(date), None)
            .await
            .unwrap()
    }

    /// The fix the card offers first, as the card sends it, with where it came from.
    async fn fix_first(&self, key: &str, date: &str) -> (FindingKind, Accepted) {
        let p = self.proof(key, date).await;
        let x = p.findings.expect("findings");
        let f = x.diagnosis.explained_by.first().expect("an explanation");
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
            SuggestedFix::UploadMissing { .. } => panic!("not a command"),
        };
        let via = Via::Finding { finding: f.kind };
        let accepted = self
            .send(command, Some(via))
            .await
            .unwrap_or_else(|e| panic!("the fix: {:?}", e.body()));
        (f.kind, accepted)
    }

    /// The log entry of an accepted command, in Changes' words.
    async fn described(&self, seq: i64) -> String {
        let mut conn = self.store.reader().await.unwrap();
        let entry = log::after(&mut conn, seq - 1, 1)
            .await
            .unwrap()
            .into_iter()
            .next()
            .unwrap();
        assert_eq!(entry.seq, seq);
        let changes: Option<Changes> = entry
            .changes
            .as_deref()
            .map(|c| serde_json::from_str(c).unwrap());
        describe(&entry, changes.as_ref(), &BTreeMap::new())
    }

    async fn finalise_first_year(&self) {
        let mut conn = self.store.reader().await.unwrap();
        let year = years::for_client(&mut conn, &self.client).await.unwrap()[0]
            .id
            .clone();
        drop(conn);
        // A person signs a year off, so the practice admin needs a login.
        let admin = self
            .ok(Command::CreateUser {
                username: "boss".into(),
                display_name: "Boss".into(),
                password: "correct horse battery".into(),
                role: Role::PracticeAdmin,
            })
            .await
            .entity_id
            .unwrap();
        let actor = Actor {
            user_id: Some(admin),
            role: Role::PracticeAdmin,
        };
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command: Command::FinaliseYear {
                client_year_id: year,
                accept_uncategorised: Some(true),
            },
        };
        let at = Utc.with_ymd_and_hms(2026, 10, 23, 0, 0, 0).unwrap();
        submit_via(&self.store, &actor, envelope, None, at)
            .await
            .unwrap_or_else(|e| panic!("finalise_year: {:?}", e.body()));
    }
}

fn difference(p: &AccountProof) -> Option<Money> {
    p.proof.bank.as_ref().map(|b| b.compared.difference)
}

#[tokio::test]
async fn a_file_uploaded_twice_is_removed() {
    let books = Books::load("01b-duplicates-posting-date").await;
    assert_eq!(
        difference(&books.proof("card", "2026-03-31").await),
        Some(Money::from_cents(-9960))
    );
    let mut conn = books.store.reader().await.unwrap();
    let statements = bank_store::statements(&mut conn, &books.accounts["card"])
        .await
        .unwrap();
    let doubled = statements
        .iter()
        .find(|s| s.file_name == "visa-activity-2025-06-25_06-30.qif")
        .unwrap()
        .clone();
    let year = years::for_client(&mut conn, &books.client).await.unwrap()[0]
        .id
        .clone();
    let journals_before = journals::for_year(&mut conn, &year).await.unwrap().len();
    drop(conn);

    let (kind, accepted) = books.fix_first("card", "2026-03-31").await;
    assert_eq!(kind, FindingKind::Duplicate);
    let after = books.proof("card", "2026-03-31").await;
    assert_eq!(difference(&after), Some(Money::ZERO));
    assert!(after.findings.unwrap().diagnosis.explained_by.is_empty());

    // The statement, its lines and its kept file are gone; its journals are reversed, not deleted.
    let mut conn = books.store.reader().await.unwrap();
    assert!(
        bank_store::statement(&mut conn, &doubled.id)
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        bank_store::bank_lines(&mut conn, &books.client)
            .await
            .unwrap()
            .iter()
            .all(|l| l.statement_id != doubled.id)
    );
    assert!(
        bank_store::statement_file(&mut conn, &doubled.id)
            .await
            .unwrap()
            .is_none()
    );
    let all = journals::for_year(&mut conn, &year).await.unwrap();
    assert_eq!(all.len(), journals_before + 2, "one reversal per line");
    drop(conn);

    assert_eq!(
        books.described(accepted.seq).await,
        "The system removed the statement visa-activity-2025-06-25_06-30.qif, taking out 2 \
         transactions, fixed from a reconciliation finding."
    );
}

#[tokio::test]
async fn a_removed_file_can_be_uploaded_again() {
    let books = Books::load("01b-duplicates-posting-date").await;
    books.fix_first("card", "2026-03-31").await;
    let own = sections(
        &std::fs::read_to_string(format!("{ROOT}/01b-duplicates-posting-date/fault.toml")).unwrap(),
    );
    let again = own
        .iter()
        .find(|s| s.name == "uploads" && s.str("file") == "visa-activity-2025-06-25_06-30.qif")
        .unwrap();
    // The same file again goes in as it did the first time, and the card is out again by it.
    books.upload("01b-duplicates-posting-date", again).await;
    assert_eq!(
        difference(&books.proof("card", "2026-03-31").await),
        Some(Money::from_cents(-9960))
    );
}

#[tokio::test]
async fn a_wrong_opening_balance_is_corrected() {
    let books = Books::load("03-wrong-opening-balance").await;
    assert_eq!(
        difference(&books.proof("cheque", "2026-03-31").await),
        Some(Money::from_cents(-26485))
    );
    let (kind, accepted) = books.fix_first("cheque", "2026-03-31").await;
    assert_eq!(kind, FindingKind::WrongOpeningBalance);
    assert_eq!(
        difference(&books.proof("cheque", "2026-03-31").await),
        Some(Money::ZERO)
    );
    let mut conn = books.store.reader().await.unwrap();
    let account = bank_store::bank_account(&mut conn, &books.accounts["cheque"])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        account.opening,
        Some((d("2025-04-01"), Money::from_cents(326485)))
    );
    drop(conn);
    assert_eq!(
        books.described(accepted.seq).await,
        "The system changed the opening balance of Kowhai cheque from $3,000 to $3,264.85, \
         fixed from a reconciliation finding."
    );
}

#[tokio::test]
async fn an_entry_by_hand_is_reversed() {
    let books = Books::load("06-entries-by-hand").await;
    assert_eq!(
        difference(&books.proof("cheque", "2026-03-31").await),
        Some(Money::from_cents(35000))
    );
    let (kind, _) = books.fix_first("cheque", "2026-03-31").await;
    assert_eq!(kind, FindingKind::EntryByHand);
    assert_eq!(
        difference(&books.proof("cheque", "2026-03-31").await),
        Some(Money::ZERO)
    );
}

#[tokio::test]
async fn neither_fix_reaches_a_finalised_year() {
    let books = Books::load("clean").await;
    books.finalise_first_year().await;
    let mut conn = books.store.reader().await.unwrap();
    let statement = bank_store::statements(&mut conn, &books.accounts["cheque"])
        .await
        .unwrap()[0]
        .id
        .clone();
    drop(conn);
    let head = || async {
        let mut conn = books.store.reader().await.unwrap();
        log::head_seq(&mut conn).await.unwrap()
    };
    let before = head().await;
    for command in [
        Command::RemoveStatement {
            statement_id: statement.clone(),
        },
        Command::SetOpeningBalance {
            bank_account_id: books.accounts["cheque"].clone(),
            balance: Money::from_cents(100),
        },
    ] {
        let kind = command.kind();
        let err = books.send(command, None).await.unwrap_err();
        assert_eq!(err.body().code, "year_finalised", "{kind}");
    }
    assert_eq!(head().await, before, "nothing reached the log");
}

#[tokio::test]
async fn a_line_in_a_confirmed_transfer_keeps_its_statement() {
    let books = Books::load("clean").await;
    let mut conn = books.store.reader().await.unwrap();
    let lines = bank_store::bank_lines(&mut conn, &books.client)
        .await
        .unwrap();
    drop(conn);
    // A card repayment: money out of the cheque account, into the card, on the same day.
    let pair = lines.iter().find_map(|out| {
        let inn = lines.iter().find(|i| {
            i.bank_account_id != out.bank_account_id
                && i.date == out.date
                && i.amount == -out.amount
                && out.amount < Money::ZERO
        })?;
        Some((out.clone(), inn.clone()))
    });
    let Some((out, inn)) = pair else {
        panic!("the clean set has no transfer between its accounts");
    };
    books
        .ok(Command::ConfirmTransfer {
            out_line_id: out.id.clone(),
            in_line_id: inn.id.clone(),
        })
        .await;
    let err = books
        .send(
            Command::RemoveStatement {
                statement_id: out.statement_id.clone(),
            },
            None,
        )
        .await
        .unwrap_err();
    assert_eq!(err.body().code, "statement_line_in_transfer");
}

#[tokio::test]
async fn an_account_out_comes_first_in_save_tax() {
    let books = Books::load("01b-duplicates-posting-date").await;
    let mut conn = books.store.reader().await.unwrap();
    let q = queue(&mut conn, &books.client).await.unwrap();
    let first = &q.cards[0];
    assert_eq!(first.kind, CardKind::Reconcile);
    let r = first.reconcile.as_ref().unwrap();
    assert_eq!(r.bank_account_id, books.accounts["card"]);
    assert_eq!(r.difference, Money::from_cents(-9960));
    assert_eq!(r.explained_by, vec![FindingKind::Duplicate]);
    assert_eq!(
        q.cards
            .iter()
            .filter(|c| c.kind == CardKind::Reconcile)
            .count(),
        1,
        "the cheque account agrees"
    );

    let clean = Books::load("clean").await;
    let mut conn = clean.store.reader().await.unwrap();
    let q = queue(&mut conn, &clean.client).await.unwrap();
    assert!(q.cards.iter().all(|c| c.kind != CardKind::Reconcile));
}

/// Captures what the server logs while it's set as the thread's default.
#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn an_amount_read_wrong_is_logged_without_the_content() {
    let captured = Captured::default();
    let writer = captured.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_writer(move || writer.clone())
        .with_ansi(false)
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let books = Books::load("09-amount-read-wrong").await;
    let text = String::from_utf8(captured.0.lock().unwrap().clone()).unwrap();
    let logged: Vec<&str> = text
        .lines()
        .filter(|l| l.contains("may be read wrong"))
        .collect();
    assert!(!logged.is_empty(), "nothing logged: {text}");

    let mut conn = books.store.reader().await.unwrap();
    let feb = bank_store::statements(&mut conn, &books.accounts["cheque"])
        .await
        .unwrap()
        .into_iter()
        .find(|s| s.file_name == "kowhai-cheque-2026-02.csv")
        .unwrap();
    let file = std::fs::read_to_string(format!(
        "{ROOT}/09-amount-read-wrong/kowhai-cheque-2026-02.csv"
    ))
    .unwrap();
    for line in &logged {
        assert!(
            line.contains(&format!("parser {}, row 14", feb.parser)),
            "{line}"
        );
        // Nothing from the file: no amounts, descriptions or account numbers.
        for word in ["TELEWAVE", "MOBILE", "3999", "39.99", "0000612", "99-5501"] {
            assert!(!line.contains(word), "{line} gives away {word}");
        }
        for field in file.lines().flat_map(|l| l.split(',')) {
            let field = field.trim();
            if field.len() >= 4 && !field.chars().all(|c| c.is_ascii_digit()) {
                assert!(!line.contains(field), "{line} gives away {field}");
            }
        }
    }
}
