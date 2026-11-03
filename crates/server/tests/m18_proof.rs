//! M18, Agent 3: every upload checks itself against the books, and returns Bank vs books in its
//! result. Uses the synthetic fixtures in `fixtures/reconcile/` (Agent 7a).

use acct_core::Money;
use acct_core::reconcile::{BalanceKind, ProofAt, Shape};
use acct_server::business::{AccountProof, UploadCheck, account_proof};
use acct_server::commands::{Accepted, Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_store::Store;
use acct_store::users::Role;
use chrono::{NaiveDate, TimeZone, Utc};
use tempfile::TempDir;

const CLEAN: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/reconcile/clean"
);
const WRONG_OPENING: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../fixtures/reconcile/03-wrong-opening-balance"
);

/// The clean set's uploads, in `fixture.toml`'s order.
const UPLOADS: [&str; 16] = [
    "kowhai-cheque-2025-04.csv",
    "kowhai-cheque-2025-05.csv",
    "kowhai-cheque-2025-06.csv",
    "visa-2025-04-01_06-30.ofx",
    "kowhai-cheque-2025-07.csv",
    "kowhai-cheque-2025-08.csv",
    "kowhai-cheque-2025-09.csv",
    "visa-2025-07-01_09-28.qif",
    "visa-2025-09-27_12-31.qif",
    "kowhai-cheque-2025-10.csv",
    "kowhai-cheque-2025-11.csv",
    "kowhai-cheque-2025-12.csv",
    "kowhai-cheque-2026-01.csv",
    "kowhai-cheque-2026-02.csv",
    "kowhai-cheque-2026-03.csv",
    "visa-2026-01-01_03-31.ofx",
];

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
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

struct Setup {
    _dir: TempDir,
    store: Store,
    client: String,
    cheque: String,
    card: String,
}

impl Setup {
    async fn new() -> Setup {
        let dir = TempDir::new().unwrap();
        let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
        let mut s = Setup {
            _dir: dir,
            store,
            client: String::new(),
            cheque: String::new(),
            card: String::new(),
        };
        s.ok(Command::CreateMasterChart {
            entity_type: "sole_trader".into(),
            name: "Sole trader".into(),
            accounts: serde_json::from_str(include_str!(
                "../../../fixtures/practice/sole-trader-chart.json"
            ))
            .unwrap(),
        })
        .await;
        let template_id = s
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
        s.ok(Command::CreateMapping {
            template_id,
            name: "Sole trader".into(),
            body: serde_json::from_str(include_str!(
                "../../../fixtures/practice/sole-trader-mapping.json"
            ))
            .unwrap(),
        })
        .await;
        s.client = s
            .ok(Command::SetUpBusiness {
                name: "Ferncliff Joinery".into(),
                start_date: d("2025-04-01"),
                gst: None,
            })
            .await
            .entity_id
            .unwrap();
        s.cheque = s
            .ok(Command::AddBankAccount {
                client_id: s.client.clone(),
                name: "Kowhai cheque".into(),
                account_number: Some("99-5501-0000612-00".into()),
            })
            .await
            .entity_id
            .unwrap();
        s.card = s
            .ok(Command::AddCardAccount {
                client_id: s.client.clone(),
                name: "Harbourlight Visa".into(),
                card_number: Some("XXXX-XXXX-XXXX-5290".into()),
            })
            .await
            .entity_id
            .unwrap();
        s
    }

    async fn ok(&self, command: Command) -> Accepted {
        let kind = command.kind();
        let actor = Actor {
            user_id: None,
            role: Role::PracticeAdmin,
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

    async fn upload(&self, dir: &str, file: &str) -> UploadCheck {
        let bytes = std::fs::read(format!("{dir}/{file}")).unwrap();
        self.ok(Command::ImportStatement {
            client_id: self.client.clone(),
            file_name: file.into(),
            content_base64: base64(&bytes),
            bank_account_id: None,
        })
        .await
        .upload
        .unwrap_or_else(|| panic!("{file}: no check in the result"))
    }

    async fn proof(&self, account: &str, date: &str) -> AccountProof {
        let mut conn = self.store.reader().await.unwrap();
        account_proof(&mut conn, account, d(date), None)
            .await
            .unwrap()
    }
}

fn difference(p: &AccountProof) -> Option<Money> {
    p.proof.difference()
}

#[tokio::test]
async fn every_clean_upload_agrees_with_the_books() {
    let s = Setup::new().await;
    let mut last = None;
    for file in UPLOADS {
        let check = s.upload(CLEAN, file).await;
        let account = if file.starts_with("visa") {
            &s.card
        } else {
            &s.cheque
        };
        assert_eq!(&check.bank_account_id, account, "{file}");
        assert!(check.statement_id.is_some(), "{file} stored a statement");
        let p = &check.at_end;
        assert_eq!(p.business_name, "Ferncliff Joinery");
        assert_eq!(difference(p), Some(Money::ZERO), "{file}: {p:?}");
        let bank = p.proof.bank.as_ref().unwrap();
        if file.ends_with(".qif") {
            // A QIF file states only its opening balance. The closing M10 works out from its
            // lines isn't the bank's word, so the card uses the nearest balance the bank stated.
            assert_eq!(p.proof.at, ProofAt::Nearest, "{file}");
        } else {
            assert_eq!(p.proof.at, ProofAt::Exact, "{file}");
            assert_eq!(p.statement_file.as_deref(), Some(file), "{file}");
            assert_eq!(
                bank.checkpoint.source.balance,
                BalanceKind::Closing,
                "{file}"
            );
        }
        // Every balance the bank states was read from its file.
        assert!(
            bank.checkpoint.source.span.is_some(),
            "{file}: where the file states it"
        );
        assert!(!p.proof.recent.is_empty() && p.proof.recent.len() <= 5);
        assert_eq!(p.proof.window.difference, Money::ZERO, "{file}");
        // None of the clean files runs past 31 March.
        assert_eq!(check.at_balance_date, None, "{file}");
        last = Some(check);
    }
    let card = last.unwrap().at_end;
    assert_eq!(card.proof.date, d("2026-03-31"));
    assert_eq!(card.proof.ledger, Money::from_cents(-49949), "card owed");

    let cheque = s.proof(&s.cheque, "2026-03-31").await;
    assert_eq!(cheque.proof.ledger, Money::from_cents(845230));
    assert_eq!(difference(&cheque), Some(Money::ZERO));
    // The recent lines run up to the date and end with the last one in the file.
    let recent = &cheque.proof.recent;
    assert_eq!(recent.len(), 5);
    assert_eq!(recent.last().unwrap().narration, "DRAWINGS TO OWN ACCOUNT");
}

#[tokio::test]
async fn uploading_a_file_again_still_checks_the_account() {
    let s = Setup::new().await;
    s.upload(CLEAN, "kowhai-cheque-2025-04.csv").await;
    let again = s.upload(CLEAN, "kowhai-cheque-2025-04.csv").await;
    assert_eq!(again.statement_id, None, "nothing new stored");
    assert_eq!(again.at_end.proof.date, d("2025-04-30"));
    assert_eq!(difference(&again.at_end), Some(Money::ZERO));
}

#[tokio::test]
async fn a_date_with_no_balance_uses_the_nearest_before() {
    let s = Setup::new().await;
    s.upload(CLEAN, "kowhai-cheque-2025-04.csv").await;
    s.upload(CLEAN, "kowhai-cheque-2025-05.csv").await;
    // No statement covers 3 June, so the nearest balance before it is May's closing.
    let p = s.proof(&s.cheque, "2025-06-03").await;
    assert_eq!(p.proof.at, ProofAt::Nearest);
    assert_eq!(p.proof.books_date, d("2025-05-31"));
    assert_eq!(difference(&p), Some(Money::ZERO));
    // The first statement's opening balance is the end of the day before it.
    let p = s.proof(&s.cheque, "2025-03-31").await;
    assert_eq!(p.proof.at, ProofAt::Exact);
    assert_eq!(difference(&p), Some(Money::ZERO));
    // Before that, there's no bank balance at all.
    let p = s.proof(&s.cheque, "2025-03-30").await;
    assert_eq!(p.proof.bank, None);
    assert_eq!(difference(&p), None);
}

#[tokio::test]
async fn a_wrong_opening_balance_is_out_from_the_start() {
    let s = Setup::new().await;
    s.ok(Command::SetOpeningBalance {
        bank_account_id: s.cheque.clone(),
        balance: Money::from_cents(300000),
    })
    .await;
    let mut last = None;
    for file in UPLOADS.iter().filter(|f| f.starts_with("kowhai")) {
        last = Some(s.upload(WRONG_OPENING, file).await);
    }
    let p = last.unwrap().at_end;
    assert_eq!(p.proof.date, d("2026-03-31"));
    assert_eq!(difference(&p), Some(Money::from_cents(-26485)));
    assert_eq!(p.proof.window.shape, Shape::Constant);
    assert_eq!(p.proof.window.last_agrees, None);
    let first = p.proof.window.first_differs.unwrap();
    assert_eq!(first.checkpoint.date, d("2025-04-01"));
    assert_eq!(first.checkpoint.source.balance, BalanceKind::Opening);
    assert_eq!(first.compared.ledger, Money::from_cents(300000));
}
