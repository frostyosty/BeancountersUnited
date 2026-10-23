//! M10's "Done when" check: the synthetic sole trader's statements give the worked example's
//! figures (`docs/domain.md`, "Worked example: the synthetic sole trader").

use std::collections::BTreeMap;

use acct_core::tax::gst::GstFrequency;
use acct_core::tax::income_tax::{IncomeYear, OwnerAnswers, income_tax_figure};
use acct_core::{Account, Mapping, Money, Template};
use acct_server::business::{GstBasis, GstSetup};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_server::tax;
use acct_store::users::Role;
use acct_store::{Store, journals, years};
use chrono::{NaiveDate, TimeZone, Utc};
use tempfile::TempDir;

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");

const OFX: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx");
const QIF: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08-28_09-30.qif");
const KOWHAI_AUG: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");
const KOWHAI_SEP: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-09-10_09-30.csv");
const RIMU: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/rimu-savings-2025-08-29_09-30.csv");

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
}

const TODAY: (i32, u32, u32) = (2026, 10, 23);

impl Setup {
    async fn run(&self, command: Command) -> Result<Option<String>, serde_json::Value> {
        let actor = Actor {
            user_id: None,
            role: Role::PracticeAdmin,
        };
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        let (y, mo, da) = TODAY;
        let at = Utc.with_ymd_and_hms(y, mo, da, 0, 0, 0).unwrap();
        submit(&self.store, &actor, envelope, at)
            .await
            .map(|a| a.entity_id)
            .map_err(|e| serde_json::to_value(e.body()).unwrap())
    }

    async fn ok(&self, command: Command) -> String {
        let kind = command.kind();
        match self.run(command).await {
            Ok(id) => id.unwrap_or_default(),
            Err(e) => panic!("{kind}: {e}"),
        }
    }

    async fn upload(&self, client_id: &str, name: &str, bytes: &[u8]) {
        self.ok(Command::ImportStatement {
            client_id: client_id.into(),
            file_name: name.into(),
            content_base64: base64(bytes),
            bank_account_id: None,
        })
        .await;
    }

    /// Every account's balance across all of a client's journals.
    async fn tb(&self, client_id: &str) -> (BTreeMap<String, Money>, usize) {
        let mut conn = self.store.reader().await.unwrap();
        let mut tb: BTreeMap<String, Money> = BTreeMap::new();
        let mut count = 0;
        for y in years::for_client(&mut conn, client_id).await.unwrap() {
            for j in journals::for_year(&mut conn, &y.id).await.unwrap() {
                count += 1;
                for l in j.journal.lines {
                    *tb.entry(l.account.to_string()).or_default() += l.amount;
                }
            }
        }
        tb.retain(|_, v| !v.is_zero());
        (tb, count)
    }
}

async fn setup() -> Setup {
    let dir = TempDir::new().unwrap();
    let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
    let s = Setup { _dir: dir, store };
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
    s
}

fn gst(basis: GstBasis) -> GstSetup {
    GstSetup {
        registered_from: d("2025-08-01"),
        frequency: GstFrequency::TwoMonthlyOdd,
        basis,
    }
}

#[tokio::test]
async fn invoice_basis_is_turned_down() {
    let s = setup().await;
    for basis in [GstBasis::Invoice, GstBasis::Hybrid] {
        let err = s
            .run(Command::SetUpBusiness {
                name: "Marsh Hollow Candles".into(),
                start_date: d("2025-08-01"),
                gst: Some(gst(basis)),
            })
            .await
            .unwrap_err();
        assert_eq!(err["code"], "gst_basis_not_supported");
    }
}

#[tokio::test]
async fn m10_is_done() {
    let s = setup().await;
    let client = s
        .ok(Command::SetUpBusiness {
            name: "Marsh Hollow Candles".into(),
            start_date: d("2025-08-01"),
            gst: Some(gst(GstBasis::Payments)),
        })
        .await;
    for (name, number) in [
        ("Harbourlight cheque", "99-1001-0000123-00"),
        ("Kowhai business", "99-5501-0000456-00"),
        ("Rimu savings", "99-7702-0000789-00"),
    ] {
        s.ok(Command::AddBankAccount {
            client_id: client.clone(),
            name: name.into(),
            account_number: Some(number.into()),
        })
        .await;
    }

    s.upload(&client, "harbourlight.ofx", OFX).await;
    s.upload(&client, "harbourlight.qif", QIF).await;
    s.upload(&client, "kowhai-aug.csv", KOWHAI_AUG).await;
    s.upload(&client, "kowhai-sep.csv", KOWHAI_SEP).await;
    s.upload(&client, "rimu.csv", RIMU).await;

    // Rimu's statement starts on 29 August, so the owner gives the balance on 1 August.
    let mut conn = s.store.reader().await.unwrap();
    let view = tax::business_view(&mut conn, &client).await.unwrap();
    drop(conn);
    let rimu = &view.bank_accounts[2];
    assert_eq!(rimu.code, "600.03");
    assert!(rimu.needs_opening_balance);
    s.ok(Command::SetOpeningBalance {
        bank_account_id: rimu.id.clone(),
        balance: m("1,000.00"),
    })
    .await;

    // The ledger at 30 September: 33 bank lines, 3 opening balances and 1 gap.
    let (tb, journal_count) = s.tb(&client).await;
    let expected: BTreeMap<String, Money> = [
        ("140", "-3,797.45"),
        ("600.01", "2,247.12"),
        ("600.02", "2,830.73"),
        ("600.03", "1,153.76"),
        ("810", "-569.63"),
        ("950", "-4,250.00"),
        ("965", "2,385.47"),
    ]
    .into_iter()
    .map(|(c, a)| (c.to_owned(), m(a)))
    .collect();
    assert_eq!(tb, expected);
    assert_eq!(journal_count, 33 + 3 + 1);

    // The figure: GST 569.62, income tax 1,481.01, student loan 455.69.
    let today = d("2026-10-23");
    let mut conn = s.store.reader().await.unwrap();
    let position = tax::position(&mut conn, &client, today).await.unwrap();
    let [period] = position.gst.as_slice() else {
        panic!("one GST period: {:?}", position.gst)
    };
    assert_eq!(
        (period.start, period.end),
        (d("2025-08-01"), d("2025-09-30"))
    );
    let boxes = period.boxes.unwrap();
    assert_eq!(boxes.box5, m("4,367.08"));
    assert_eq!(boxes.box8, m("569.62"));
    assert_eq!(boxes.box15, m("569.62"));
    let [year] = position.income.as_slice() else {
        panic!("one income year: {:?}", position.income)
    };
    assert_eq!(year.income_year, 2026);
    assert_eq!(year.taxable_income, m("3,797.45"));
    assert_eq!(year.income_tax, Some(m("1,481.01")));
    assert_eq!(year.student_loan, Some(m("455.69")));
    assert_eq!(position.total, m("2,506.32"));
    // Rimu's gap has no balance at its end, so the figure says it's incomplete.
    assert!(position.notices.iter().any(|n| n.code == "incomplete"));

    // Told the business is the owner's only income, the engine gives 968.35.
    let only = OwnerAnswers {
        only_income: Some(true),
        student_loan: None,
    };
    let f = income_tax_figure(IncomeYear(2026), year.taxable_income, &only).unwrap();
    assert_eq!(boxes.box15 + f.total(), m("968.35"));

    // Both gaps are flagged: Kowhai's with a change of 380.00, Rimu's with none.
    let view = tax::business_view(&mut conn, &client).await.unwrap();
    let gaps: Vec<_> = view
        .bank_accounts
        .iter()
        .map(|a| {
            a.gaps
                .iter()
                .map(|g| (g.start, g.end, g.change))
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(
        gaps,
        vec![
            vec![],
            vec![(d("2025-09-01"), d("2025-09-09"), Some(m("380.00")))],
            vec![(d("2025-08-01"), d("2025-08-28"), None)],
        ]
    );

    // Every bank account whose statements give a closing balance reconciles.
    let recs: Vec<_> = view
        .bank_accounts
        .iter()
        .map(|a| a.reconciliation.as_ref().map(|r| (r.ledger, r.agrees)))
        .collect();
    assert_eq!(
        recs,
        vec![
            Some((m("2,247.12"), Some(true))),
            Some((m("2,830.73"), Some(true))),
            Some((m("1,153.76"), None)),
        ]
    );

    // Detected for Save tax, not applied.
    assert_eq!(view.transfers.len(), 1);
    assert_eq!(view.transfers[0].0.amount, m("-500.00"));
    assert_eq!(view.transfers[0].0.date, d("2025-08-22"));
    let ird: Vec<_> = view.ird_payments.iter().map(|l| l.amount).collect();
    assert_eq!(ird, vec![m("163.42")]);
    drop(conn);

    // Uploading an overlapping statement again changes nothing.
    for (name, bytes) in [
        ("harbourlight.qif", QIF),
        ("harbourlight.ofx", OFX),
        ("kowhai-sep.csv", KOWHAI_SEP),
    ] {
        s.upload(&client, name, bytes).await;
    }
    let (tb_again, count_again) = s.tb(&client).await;
    assert_eq!(tb_again, expected);
    assert_eq!(count_again, journal_count);
}

#[tokio::test]
async fn statements_in_any_order_give_the_same_ledger() {
    let s = setup().await;
    let client = s
        .ok(Command::SetUpBusiness {
            name: "Marsh Hollow Candles".into(),
            start_date: d("2025-08-01"),
            gst: Some(gst(GstBasis::Payments)),
        })
        .await;
    // No accounts added first: uploads add them from the files' account numbers.
    s.upload(&client, "kowhai-sep.csv", KOWHAI_SEP).await;
    s.upload(&client, "harbourlight.qif", QIF).await;
    s.upload(&client, "kowhai-aug.csv", KOWHAI_AUG).await;
    s.upload(&client, "harbourlight.ofx", OFX).await;
    let (tb, _) = s.tb(&client).await;
    // Kowhai was added first this time, so it's 600.01. Balances as in the worked example.
    assert_eq!(tb["600.01"], m("2,830.73"));
    assert_eq!(tb["600.02"], m("2,247.12"));
    // The same GST as when uploaded in order, less Rimu's three lines (0.24 + 39.13 + 0.25).
    assert_eq!(tb["810"], m("-569.63") + m("39.62"));
}

#[tokio::test]
async fn a_line_after_today_is_refused() {
    let s = setup().await;
    let client = s
        .ok(Command::SetUpBusiness {
            name: "Future Co".into(),
            start_date: d("2026-04-01"),
            gst: None,
        })
        .await;
    let file = b"Account,Posted,Type,Payee,Particulars,Reference,Amount\n\
                 99-7702-0000789-00,2027-01-05,DEP,X,Y,,10.00\n";
    let err = s
        .run(Command::ImportStatement {
            client_id: client,
            file_name: "future.csv".into(),
            content_base64: base64(file),
            bank_account_id: None,
        })
        .await
        .unwrap_err();
    assert_eq!(err["code"], "line_in_future");
}
