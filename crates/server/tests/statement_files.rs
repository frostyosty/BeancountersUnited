//! M18 (Agent 2): every upload keeps its original file and where each balance sits in it, the
//! command log keeps only the file's SHA-256, and the excerpt shows the bank's own words.

use acct_core::reconcile::BalanceKind;
use acct_core::{Account, Mapping, Money, Template};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::history::{self, Changes};
use acct_server::invoices::sha256_hex;
use acct_server::pipeline::{Actor, submit};
use acct_server::statement_files::{ExcerptQuery, StatementExcerpt, excerpt};
use acct_server::tax;
use acct_store::users::Role;
use acct_store::{Store, bank, log, sqlx};
use chrono::{NaiveDate, TimeZone, Utc};
use tempfile::TempDir;

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");

const OFX: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx");
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

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

struct Setup {
    _dir: TempDir,
    store: Store,
    client: String,
}

impl Setup {
    async fn ok(&self, command: Command) -> String {
        let kind = command.kind();
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        let actor = Actor {
            user_id: None,
            role: Role::PracticeAdmin,
            acting_as: None,
        };
        let at = Utc.with_ymd_and_hms(2026, 10, 23, 0, 0, 0).unwrap();
        match submit(&self.store, &actor, envelope, at).await {
            Ok(a) => a.entity_id.unwrap_or_default(),
            Err(e) => panic!("{kind}: {:?}", e.body()),
        }
    }

    async fn upload(&self, name: &str, bytes: &[u8]) {
        self.ok(Command::ImportStatement {
            client_id: self.client.clone(),
            file_name: name.into(),
            content_base64: base64(bytes),
            bank_account_id: None,
        })
        .await;
    }

    /// The id of the first statement of the bank account with this number.
    async fn statement_id(&self, account_number: &str) -> String {
        let mut conn = self.store.reader().await.unwrap();
        let view = tax::business_view(&mut conn, &self.client).await.unwrap();
        let account = view
            .bank_accounts
            .iter()
            .find(|a| a.account_number.as_deref() == Some(account_number))
            .unwrap();
        account.statements[0].id.clone()
    }

    async fn excerpt(
        &self,
        statement_id: &str,
        kind: &str,
        line: Option<&str>,
    ) -> StatementExcerpt {
        let mut conn = self.store.reader().await.unwrap();
        let q = ExcerptQuery {
            kind: Some(kind.to_owned()),
            line: line.map(str::to_owned),
        };
        excerpt(&mut conn, statement_id, &q).await.unwrap()
    }

    async fn files_kept(&self) -> i64 {
        let mut conn = self.store.reader().await.unwrap();
        let (n,): (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM statement_files WHERE bytes IS NOT NULL")
                .fetch_one(&mut *conn)
                .await
                .unwrap();
        n
    }
}

async fn setup() -> Setup {
    let dir = TempDir::new().unwrap();
    let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
    let mut s = Setup {
        _dir: dir,
        store,
        client: String::new(),
    };
    let accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    let template: Template = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    s.ok(Command::CreateMasterChart {
        entity_type: "sole_trader".into(),
        name: "Sole trader".into(),
        accounts,
    })
    .await;
    let template_id = s
        .ok(Command::CreateTemplate {
            entity_type: "sole_trader".into(),
            name: "Sole trader".into(),
            body: template,
        })
        .await;
    s.ok(Command::CreateMapping {
        template_id,
        name: "Sole trader".into(),
        body: mapping,
    })
    .await;
    s.client = s
        .ok(Command::SetUpBusiness {
            name: "Marsh Hollow Candles".into(),
            start_date: "2025-08-01".parse().unwrap(),
            gst: None,
        })
        .await;
    s
}

/// The highlighted text of an excerpt.
fn marked(e: &StatementExcerpt) -> String {
    let h = e.highlight.expect("a highlight");
    let line = e.lines.iter().find(|l| l.number == h.line).unwrap();
    let units: Vec<u16> = line.text.encode_utf16().collect();
    String::from_utf16(&units[h.start as usize..h.end as usize]).unwrap()
}

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

#[tokio::test]
async fn an_upload_keeps_its_file_and_where_each_balance_is() {
    let s = setup().await;
    s.upload("kowhai-aug.csv", KOWHAI).await;
    let id = s.statement_id("99-5501-0000456-00").await;

    let mut conn = s.store.reader().await.unwrap();
    let file = bank::statement_file(&mut conn, &id).await.unwrap().unwrap();
    assert_eq!(file.bytes, KOWHAI);
    assert_eq!(file.sha256, sha256_hex(KOWHAI));
    assert_eq!(file.media_type, "text/csv");
    let spans = bank::balance_spans(&mut conn, &id).await.unwrap();
    let kinds: Vec<&str> = spans
        .iter()
        .map(|s| match s.balance {
            BalanceKind::Opening => "opening",
            BalanceKind::Running { .. } => "running",
            BalanceKind::Closing => "closing",
        })
        .collect();
    assert_eq!(
        kinds,
        [
            "opening", "closing", "running", "running", "running", "running", "running"
        ],
        "in file order"
    );
    let lines = bank::bank_lines(&mut conn, &s.client).await.unwrap();
    drop(conn);

    let closing = s.excerpt(&id, "closing", None).await;
    assert!(closing.kept);
    assert_eq!(closing.file_name, "kowhai-aug.csv");
    assert_eq!(closing.sha256.as_deref(), Some(sha256_hex(KOWHAI).as_str()));
    assert_eq!(closing.stated, Some(Money::from_cents(210_001)));
    assert_eq!(closing.date, d("2025-08-31"));
    assert_eq!(marked(&closing), "2100.01");
    let numbers: Vec<u32> = closing.lines.iter().map(|l| l.number).collect();
    assert_eq!(numbers, [3, 4, 5, 6, 7, 8, 9], "three lines either side");
    assert_eq!(closing.lines[3].text, "Closing balance,2100.01");

    let opening = s.excerpt(&id, "opening", None).await;
    assert_eq!(marked(&opening), "1250.00");
    assert_eq!(opening.date, d("2025-08-01"));

    // A running balance, by its line.
    let hardware = lines
        .iter()
        .find(|l| l.description == "WOODMILL HARDWARE")
        .unwrap();
    let running = s.excerpt(&id, "running", Some(&hardware.id)).await;
    assert_eq!(marked(&running), "1130.00");
    assert_eq!(running.stated, Some(Money::from_cents(113_000)));
    assert_eq!(running.date, d("2025-08-05"));
}

#[tokio::test]
async fn an_ofx_closing_balance_is_its_ledger_balance() {
    let s = setup().await;
    s.upload("harbourlight.ofx", OFX).await;
    let id = s.statement_id("99-1001-0000123-00").await;
    let closing = s.excerpt(&id, "closing", None).await;
    assert_eq!(closing.media_type.as_deref(), Some("application/x-ofx"));
    assert_eq!(marked(&closing), "2022.56");
    assert!(
        closing.lines.iter().any(|l| l.text.contains("<LEDGERBAL>")),
        "{:?}",
        closing.lines
    );
    // OFX states no opening balance: the file is kept, but there's nothing in it to show.
    let opening = s.excerpt(&id, "opening", None).await;
    assert!(opening.kept);
    assert!(opening.lines.is_empty() && opening.highlight.is_none());
}

#[tokio::test]
async fn the_log_keeps_the_files_hash_not_its_bytes() {
    let s = setup().await;
    s.upload("kowhai-aug.csv", KOWHAI).await;
    let mut conn = s.store.reader().await.unwrap();
    let entries = log::after(&mut conn, 0, 1000).await.unwrap();
    let entry = entries
        .iter()
        .find(|e| e.kind == "import_statement")
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&entry.payload).unwrap();
    assert_eq!(
        payload["content_base64"],
        format!("sha256:{}", sha256_hex(KOWHAI))
    );
    assert!(!entry.payload.contains(&base64(KOWHAI)[..40]));
    // M13's history still reads it as an upload.
    let changes: Option<Changes> = entry
        .changes
        .as_deref()
        .and_then(|c| serde_json::from_str(c).ok());
    let sentence = history::describe(entry, changes.as_ref(), &Default::default());
    assert!(
        sentence.starts_with(
            "The system uploaded the statement kowhai-aug.csv, adding 5 new transactions."
        ),
        "{sentence}"
    );
}

#[tokio::test]
async fn the_same_file_again_stores_nothing_new() {
    let s = setup().await;
    s.upload("kowhai-aug.csv", KOWHAI).await;
    assert_eq!(s.files_kept().await, 1);
    s.upload("kowhai-aug.csv", KOWHAI).await;
    s.upload("kowhai-aug (1).csv", KOWHAI).await;
    assert_eq!(s.files_kept().await, 1);
}

#[tokio::test]
async fn a_statement_from_before_m18_says_its_file_was_not_kept() {
    let s = setup().await;
    s.upload("kowhai-aug.csv", KOWHAI).await;
    let id = s.statement_id("99-5501-0000456-00").await;
    {
        // Stands in for a statement uploaded before migration 0012, which kept no file.
        let mut w = s.store.writer().await;
        for sql in [
            "DELETE FROM balance_spans WHERE statement_id = ?",
            "DELETE FROM statement_files WHERE statement_id = ?",
        ] {
            sqlx::query(sql).bind(&id).execute(&mut *w).await.unwrap();
        }
    }
    let closing = s.excerpt(&id, "closing", None).await;
    assert!(!closing.kept);
    assert_eq!(closing.file_name, "kowhai-aug.csv");
    assert_eq!(closing.stated, Some(Money::from_cents(210_001)));
    assert!(closing.lines.is_empty() && closing.sha256.is_none());
}

#[tokio::test]
async fn an_excerpt_names_what_it_was_asked_for() {
    let s = setup().await;
    s.upload("kowhai-aug.csv", KOWHAI).await;
    let id = s.statement_id("99-5501-0000456-00").await;
    let mut conn = s.store.reader().await.unwrap();
    let ask = |kind: Option<&str>, line: Option<&str>| ExcerptQuery {
        kind: kind.map(str::to_owned),
        line: line.map(str::to_owned),
    };
    let err = |r: Result<StatementExcerpt, acct_server::error::CommandError>| {
        serde_json::to_value(r.unwrap_err().body()).unwrap()["code"].clone()
    };
    assert_eq!(
        err(excerpt(&mut conn, "nope", &ask(None, None)).await),
        "not_found"
    );
    assert_eq!(
        err(excerpt(&mut conn, &id, &ask(Some("middle"), None)).await),
        "malformed"
    );
    assert_eq!(
        err(excerpt(&mut conn, &id, &ask(Some("running"), None)).await),
        "malformed"
    );
    assert_eq!(
        err(excerpt(&mut conn, &id, &ask(None, Some("no-such-line"))).await),
        "not_found"
    );
    // No kind means the closing balance.
    let e = excerpt(&mut conn, &id, &ask(None, None)).await.unwrap();
    assert_eq!(e.stated, Some(Money::from_cents(210_001)));
}

#[tokio::test]
async fn a_full_card_number_is_masked_in_the_copy_kept() {
    const FULL: &[u8] =
        include_bytes!("../../../fixtures/bank-statements/ofx-edge/16c-card-full-number.ofx");
    assert!(FULL.windows(14).any(|w| w == b"4000-0000-0000"));
    let s = setup().await;
    s.upload("card.ofx", FULL).await;
    let id = s.statement_id("XXXX-XXXX-XXXX-9999").await;
    let mut conn = s.store.reader().await.unwrap();
    let file = bank::statement_file(&mut conn, &id).await.unwrap().unwrap();
    drop(conn);
    let text = String::from_utf8_lossy(&file.bytes);
    assert!(text.contains("<ACCTID>XXXX-XXXX-XXXX-9999"), "{text}");
    assert!(!text.contains("4000"), "{text}");
    assert_eq!(file.bytes.len(), FULL.len());
    assert_eq!(
        file.sha256,
        sha256_hex(&file.bytes),
        "the hash is of the copy kept"
    );
    // The spans still point at the balance.
    let closing = s.excerpt(&id, "closing", None).await;
    assert_eq!(marked(&closing), "-45.00");
    assert_eq!(closing.stated, Some(Money::from_cents(-4500)));
}

#[tokio::test]
async fn a_second_statement_from_the_same_file_points_at_the_first_and_keeps_its_spans() {
    // A nil line posts nothing and isn't recorded, so uploading this again makes a new
    // statement even though the file is the same.
    const NIL: &[u8] = b"Kowhai Co-operative Bank - Account statement (SYNTHETIC SAMPLE)
        Account number,99-5501-0000456-00
        Statement period,01/08/2025,31/08/2025
        Opening balance,10.00
        Closing balance,5.00
        
        Date,Description,Debit,Credit,Balance
        05/08/2025,WOODMILL HARDWARE,5.00,,5.00
        06/08/2025,CARD CHECK,0.00,,5.00
        End of statement
";
    let s = setup().await;
    s.upload("nil.csv", NIL).await;
    s.upload("nil (1).csv", NIL).await;
    assert_eq!(s.files_kept().await, 1, "the bytes are kept once");

    let mut conn = s.store.reader().await.unwrap();
    let view = tax::business_view(&mut conn, &s.client).await.unwrap();
    let statements = &view.bank_accounts[0].statements;
    assert_eq!(statements.len(), 2, "{statements:?}");
    let (first, second) = (&statements[0].id, &statements[1].id);
    let file = bank::statement_file(&mut conn, second)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&file.statement_id, first, "read through the first upload");
    assert_eq!(file.bytes, NIL);
    let spans = bank::balance_spans(&mut conn, second).await.unwrap();
    let kinds: Vec<&BalanceKind> = spans.iter().map(|s| &s.balance).collect();
    assert_eq!(kinds, [&BalanceKind::Opening, &BalanceKind::Closing]);
    drop(conn);

    let closing = s.excerpt(second, "closing", None).await;
    assert!(closing.kept);
    assert_eq!(closing.file_name, "nil (1).csv");
    assert_eq!(marked(&closing), "5.00");
}
