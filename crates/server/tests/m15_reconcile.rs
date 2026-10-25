//! M15's bank reconciliation on the synthetic sole trader: the fixture's bank accounts reconcile
//! (`docs/domain.md`, the M10 worked example's "Reconciliation"), before and after Save tax
//! recodes lines, and a journal posted to a bank account by hand shows up as unmatched.

use acct_core::tax::gst::GstFrequency;
use acct_core::{Account, JournalLine, Mapping, Money, Template};
use acct_server::business::{GstBasis, GstSetup};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_server::reconcile::{ReconcileStatus, YearReconciliation, year_reconciliation};
use acct_store::bank as bank_store;
use acct_store::users::Role;
use acct_store::{Store, years};
use chrono::{NaiveDate, TimeZone, Utc};
use serde_json::Value;
use tempfile::TempDir;

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const CODING: &str = include_str!("../../../fixtures/clients/marsh-hollow-coding.json");

const STATEMENTS: &[(&str, &[u8])] = &[
    (
        "harbourlight-cheque-2025-08.ofx",
        include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx"),
    ),
    (
        "harbourlight-cheque-2025-08-28_09-30.qif",
        include_bytes!(
            "../../../fixtures/bank-statements/harbourlight-cheque-2025-08-28_09-30.qif"
        ),
    ),
    (
        "kowhai-business-2025-08.csv",
        include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv"),
    ),
    (
        "kowhai-business-2025-09-10_09-30.csv",
        include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-09-10_09-30.csv"),
    ),
    (
        "rimu-savings-2025-08-29_09-30.csv",
        include_bytes!("../../../fixtures/bank-statements/rimu-savings-2025-08-29_09-30.csv"),
    ),
];

fn m(s: &str) -> Money {
    s.parse().unwrap()
}

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
    year: String,
}

impl Setup {
    async fn run(&self, role: Role, command: Command) -> String {
        let kind = command.kind();
        let actor = Actor {
            user_id: None,
            role,
        };
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        let now = Utc.with_ymd_and_hms(2026, 10, 25, 0, 0, 0).unwrap();
        match submit(&self.store, &actor, envelope, now).await {
            Ok(a) => a.entity_id.unwrap_or_default(),
            Err(e) => panic!("{kind}: {:?}", serde_json::to_value(e.body()).unwrap()),
        }
    }

    async fn reconciliation(&self) -> YearReconciliation {
        let mut conn = self.store.reader().await.unwrap();
        year_reconciliation(&mut conn, &self.year).await.unwrap()
    }

    async fn line_id(&self, key: &Value) -> String {
        let mut conn = self.store.reader().await.unwrap();
        let accounts = bank_store::bank_accounts(&mut conn, &self.client)
            .await
            .unwrap();
        let account = accounts
            .iter()
            .find(|a| a.account_number.as_deref() == key["account"].as_str())
            .unwrap();
        bank_store::bank_lines(&mut conn, &self.client)
            .await
            .unwrap()
            .into_iter()
            .find(|l| {
                l.bank_account_id == account.id
                    && l.date == d(key["date"].as_str().unwrap())
                    && l.description == key["description"].as_str().unwrap()
            })
            .unwrap()
            .id
    }
}

/// The M10 worked example's starting point: the practice defaults, the business, its statements
/// and Rimu's opening balance.
async fn setup() -> Setup {
    let dir = TempDir::new().unwrap();
    let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
    let mut s = Setup {
        _dir: dir,
        store,
        client: String::new(),
        year: String::new(),
    };
    let accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    let template: Template = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    s.run(
        Role::PracticeAdmin,
        Command::CreateMasterChart {
            entity_type: "sole_trader".into(),
            name: "Sole trader".into(),
            accounts,
        },
    )
    .await;
    let template_id = s
        .run(
            Role::PracticeAdmin,
            Command::CreateTemplate {
                entity_type: "sole_trader".into(),
                name: "Sole trader".into(),
                body: template,
            },
        )
        .await;
    s.run(
        Role::PracticeAdmin,
        Command::CreateMapping {
            template_id,
            name: "Sole trader".into(),
            body: mapping,
        },
    )
    .await;

    let fixture: Value = serde_json::from_str(CODING).unwrap();
    let business = &fixture["business"];
    s.client = s
        .run(
            Role::Staff,
            Command::SetUpBusiness {
                name: business["name"].as_str().unwrap().into(),
                start_date: d(business["start_date"].as_str().unwrap()),
                gst: Some(GstSetup {
                    registered_from: d("2025-08-01"),
                    frequency: GstFrequency::TwoMonthlyOdd,
                    basis: GstBasis::Payments,
                }),
            },
        )
        .await;
    for a in business["bank_accounts"].as_array().unwrap() {
        s.run(
            Role::Staff,
            Command::AddBankAccount {
                client_id: s.client.clone(),
                name: a["name"].as_str().unwrap().into(),
                account_number: Some(a["number"].as_str().unwrap().into()),
            },
        )
        .await;
    }
    for name in fixture["statements"].as_array().unwrap() {
        let name = name.as_str().unwrap();
        let (_, bytes) = STATEMENTS.iter().find(|(n, _)| *n == name).unwrap();
        s.run(
            Role::Staff,
            Command::ImportStatement {
                client_id: s.client.clone(),
                file_name: name.into(),
                content_base64: base64(bytes),
                bank_account_id: None,
            },
        )
        .await;
    }
    for opening in business["opening_balances_entered"].as_array().unwrap() {
        let mut conn = s.store.reader().await.unwrap();
        let account = bank_store::bank_accounts(&mut conn, &s.client)
            .await
            .unwrap()
            .into_iter()
            .find(|a| a.account_number.as_deref() == opening["account"].as_str())
            .unwrap();
        drop(conn);
        s.run(
            Role::Staff,
            Command::SetOpeningBalance {
                bank_account_id: account.id,
                balance: Money::from_cents(opening["amount"].as_i64().unwrap()),
            },
        )
        .await;
    }
    let mut conn = s.store.reader().await.unwrap();
    let year_list = years::for_client(&mut conn, &s.client).await.unwrap();
    s.year = year_list[0].id.clone();
    s
}

/// The worked example's reconciliation, account by account.
fn assert_fixture_reconciles(rec: &YearReconciliation) {
    let summary: Vec<_> = rec
        .accounts
        .iter()
        .map(|a| {
            (
                a.code.as_str(),
                a.status,
                a.date,
                a.ledger_balance,
                a.statement_balance,
            )
        })
        .collect();
    let sep30 = Some(d("2025-09-30"));
    assert_eq!(
        summary,
        vec![
            (
                "600.01",
                ReconcileStatus::Agrees,
                sep30,
                Some(m("2,247.12")),
                Some(m("2,247.12"))
            ),
            (
                "600.02",
                ReconcileStatus::Agrees,
                sep30,
                Some(m("2,830.73")),
                Some(m("2,830.73"))
            ),
            // Rimu's statement has no balances, so it can't be checked.
            (
                "600.03",
                ReconcileStatus::NoBalance,
                sep30,
                Some(m("1,153.76")),
                None
            ),
        ]
    );
    let [cheque, kowhai, rimu] = rec.accounts.as_slice() else {
        panic!("three accounts")
    };
    for a in [cheque, kowhai, rimu] {
        assert!(a.lines_without_journal.is_empty(), "{}", a.code);
        assert!(a.journals_without_line.is_empty(), "{}", a.code);
    }
    // Kowhai's gap: 1 to 9 September, a rise of 380.00, posted as a gap journal.
    assert_eq!(kowhai.gap_journals.len(), 1);
    assert_eq!(kowhai.gap_journals[0].start, d("2025-09-01"));
    assert_eq!(kowhai.gap_journals[0].end, d("2025-09-09"));
    assert_eq!(kowhai.gap_journals[0].amount, m("380.00"));
    // Rimu's gap: 1 to 28 August, flagged with no amount.
    assert!(rimu.gap_journals.is_empty());
    assert_eq!(rimu.gaps.len(), 1);
    assert_eq!(rimu.gaps[0].start, d("2025-08-01"));
    assert_eq!(rimu.gaps[0].end, d("2025-08-28"));
    assert_eq!(rimu.gaps[0].change, None);
    assert!(cheque.gaps.is_empty());
}

#[tokio::test]
async fn the_fixtures_bank_accounts_reconcile() {
    let s = setup().await;
    assert_fixture_reconciles(&s.reconciliation().await);

    // Confirming the transfer pair reposts both lines as one journal; it still reconciles.
    let fixture: Value = serde_json::from_str(CODING).unwrap();
    let pair = &fixture["transfers"][0];
    let out_line_id = s.line_id(&pair["out"]).await;
    let in_line_id = s.line_id(&pair["in"]).await;
    s.run(
        Role::Staff,
        Command::ConfirmTransfer {
            out_line_id,
            in_line_id,
        },
    )
    .await;
    assert_fixture_reconciles(&s.reconciliation().await);
}

#[tokio::test]
async fn a_hand_journal_on_a_bank_account_is_unmatched() {
    let s = setup().await;
    s.run(
        Role::Staff,
        Command::PostJournal {
            client_year_id: s.year.clone(),
            date: d("2025-09-15"),
            narration: "Cash banked".into(),
            lines: vec![
                JournalLine {
                    account: "600.01".parse().unwrap(),
                    amount: m("25.00"),
                },
                JournalLine {
                    account: "100".parse().unwrap(),
                    amount: m("-25.00"),
                },
            ],
        },
    )
    .await;
    let rec = s.reconciliation().await;
    let cheque = &rec.accounts[0];
    assert_eq!(cheque.status, ReconcileStatus::Explained);
    assert_eq!(cheque.difference, Some(m("25.00")));
    assert_eq!(cheque.unexplained, Some(Money::ZERO));
    assert_eq!(cheque.journals_without_line.len(), 1);
    assert_eq!(cheque.journals_without_line[0].narration, "Cash banked");
    assert_eq!(cheque.journals_without_line[0].amount, m("25.00"));
}
