//! M11's "Done when" check: coding the synthetic statements as the fixture says gives the worked
//! example's ledger, and the tax falls by its amounts (`docs/domain.md`, "Worked example: Save
//! tax on the synthetic sole trader"). Then each Save tax command's rejections.

use std::collections::BTreeMap;

use acct_core::coding::{Coding, CodingSettings, DepositCoding, WithdrawalCoding};
use acct_core::tax::gst::GstFrequency;
use acct_core::{
    Account, AccountType, AssetAccounts, DepreciationSettings, GstCode, Mapping, Money, Template,
};
use acct_server::ai::{SuggestedCoding, SuggestionConfidence};
use acct_server::business::{GstBasis, GstSetup};
use acct_server::commands::{Answer, Command, CommandEnvelope, IrdPayment, LineCoding, Via};
use acct_server::pipeline::{Actor, submit, submit_via};
use acct_server::save_tax::{self, CardKind, Question, SaveTaxQueue};
use acct_server::tax;
use acct_store::bank::{self as bank_store, AccountKind};
use acct_store::journals::JournalKind;
use acct_store::users::Role;
use acct_store::{Store, assets, clients, journals, log, years};
use chrono::{NaiveDate, TimeZone, Utc};
use serde_json::Value;
use tempfile::TempDir;

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const ASSET_CLASSES: &str =
    include_str!("../../../fixtures/practice/sole-trader-asset-classes.json");
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
const VISA: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-visa-2025-08.ofx");

fn m(s: &str) -> Money {
    s.parse().unwrap()
}

fn d(s: &str) -> NaiveDate {
    s.parse().unwrap()
}

fn code(s: &str) -> acct_core::AccountCode {
    s.parse().unwrap()
}

fn cents(v: &Value) -> Money {
    Money::from_cents(v.as_i64().unwrap())
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
}

const TODAY: &str = "2026-10-23";

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 10, 23, 0, 0, 0).unwrap()
}

fn envelope(command: Command) -> CommandEnvelope {
    CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command,
    }
}

impl Setup {
    async fn run_as(&self, role: Role, command: Command) -> Result<Option<String>, Value> {
        let actor = Actor {
            user_id: None,
            role,
        };
        submit(&self.store, &actor, envelope(command), now())
            .await
            .map(|a| a.entity_id)
            .map_err(|e| serde_json::to_value(e.body()).unwrap())
    }

    async fn run(&self, command: Command) -> Result<Option<String>, Value> {
        self.run_as(Role::Staff, command).await
    }

    async fn ok(&self, command: Command) -> String {
        let kind = command.kind();
        match self.run(command).await {
            Ok(id) => id.unwrap_or_default(),
            Err(e) => panic!("{kind}: {e}"),
        }
    }

    /// The error code a command is rejected with.
    async fn rejected(&self, command: Command) -> String {
        let kind = command.kind();
        match self.run(command).await {
            Ok(_) => panic!("{kind} was accepted"),
            Err(e) => e["code"].as_str().unwrap().to_owned(),
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

    /// Every account's balance across all the business's journals, and the journal count.
    async fn tb(&self) -> (BTreeMap<String, Money>, usize) {
        let mut conn = self.store.reader().await.unwrap();
        let mut tb: BTreeMap<String, Money> = BTreeMap::new();
        let mut count = 0;
        for y in years::for_client(&mut conn, &self.client).await.unwrap() {
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

    async fn total(&self) -> Money {
        let mut conn = self.store.reader().await.unwrap();
        tax::position(&mut conn, &self.client, d(TODAY))
            .await
            .unwrap()
            .total
    }

    async fn queue(&self) -> SaveTaxQueue {
        let mut conn = self.store.reader().await.unwrap();
        save_tax::queue(&mut conn, &self.client).await.unwrap()
    }

    /// The id of the line with this fixture key.
    async fn line(&self, key: &Value) -> String {
        let mut conn = self.store.reader().await.unwrap();
        let accounts = bank_store::bank_accounts(&mut conn, &self.client)
            .await
            .unwrap();
        let account = accounts
            .iter()
            .find(|a| a.account_number.as_deref() == key["account"].as_str())
            .unwrap_or_else(|| panic!("no account for {key}"));
        bank_store::bank_lines(&mut conn, &self.client)
            .await
            .unwrap()
            .into_iter()
            .find(|l| {
                l.bank_account_id == account.id
                    && l.date == d(key["date"].as_str().unwrap())
                    && l.amount == cents(&key["amount"])
                    && l.description == key["description"].as_str().unwrap()
                    && i64::from(l.occurrence) == key["occurrence"].as_i64().unwrap()
            })
            .unwrap_or_else(|| panic!("no line for {key}"))
            .id
    }

    /// The first line whose description contains `text`.
    async fn line_like(&self, text: &str) -> bank_store::BankLine {
        let mut conn = self.store.reader().await.unwrap();
        bank_store::bank_lines(&mut conn, &self.client)
            .await
            .unwrap()
            .into_iter()
            .find(|l| l.description.contains(text))
            .unwrap_or_else(|| panic!("no line like {text}"))
    }

    /// The bank-line journals for a line's date and description that are in force: neither
    /// reversed nor a reversal.
    async fn live_journals(&self, line: &bank_store::BankLine) -> usize {
        let mut conn = self.store.reader().await.unwrap();
        let mut all = Vec::new();
        for y in years::for_client(&mut conn, &self.client).await.unwrap() {
            all.extend(journals::for_year(&mut conn, &y.id).await.unwrap());
        }
        let reversed: Vec<String> = all
            .iter()
            .filter_map(|j| j.reverses_journal_id.clone())
            .collect();
        all.iter()
            .filter(|j| {
                j.kind == JournalKind::BankLine
                    && j.journal.date == line.date
                    && j.journal.narration == line.description
                    && j.reverses_journal_id.is_none()
                    && !reversed.contains(&j.id)
            })
            .count()
    }
}

fn gst(basis: GstBasis) -> GstSetup {
    GstSetup {
        registered_from: d("2025-08-01"),
        frequency: GstFrequency::TwoMonthlyOdd,
        basis,
    }
}

/// The practice defaults, the business from the fixture, its statements, and Rimu's opening
/// balance: the M10 worked example's starting point.
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
    s_master(
        &s,
        Command::CreateMasterChart {
            entity_type: "sole_trader".into(),
            name: "Sole trader".into(),
            accounts,
        },
    )
    .await;
    let template_id = s_master(
        &s,
        Command::CreateTemplate {
            entity_type: "sole_trader".into(),
            name: "Sole trader".into(),
            body: template,
        },
    )
    .await;
    s_master(
        &s,
        Command::CreateMapping {
            template_id,
            name: "Sole trader".into(),
            body: mapping,
        },
    )
    .await;
    let classes: Vec<Value> = serde_json::from_str(ASSET_CLASSES).unwrap();
    for class in classes {
        let settings: DepreciationSettings =
            serde_json::from_value(class["settings"].clone()).unwrap();
        let accounts: AssetAccounts = serde_json::from_value(class["accounts"].clone()).unwrap();
        s_master(
            &s,
            Command::CreateAssetClass {
                entity_type: "sole_trader".into(),
                key: class["key"].as_str().unwrap().into(),
                name: class["name"].as_str().unwrap().into(),
                settings,
                accounts,
            },
        )
        .await;
    }

    let fixture: Value = serde_json::from_str(CODING).unwrap();
    let business = &fixture["business"];
    s.client = s
        .ok(Command::SetUpBusiness {
            name: business["name"].as_str().unwrap().into(),
            start_date: d(business["start_date"].as_str().unwrap()),
            gst: Some(gst(GstBasis::Payments)),
        })
        .await;
    for a in business["bank_accounts"].as_array().unwrap() {
        s.ok(Command::AddBankAccount {
            client_id: s.client.clone(),
            name: a["name"].as_str().unwrap().into(),
            account_number: Some(a["number"].as_str().unwrap().into()),
        })
        .await;
    }
    let names: Vec<&str> = fixture["statements"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    for name in names {
        let (_, bytes) = STATEMENTS.iter().find(|(n, _)| *n == name).unwrap();
        s.upload(name, bytes).await;
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
        s.ok(Command::SetOpeningBalance {
            bank_account_id: account.id,
            balance: cents(&opening["amount"]),
        })
        .await;
    }
    s
}

async fn s_master(s: &Setup, command: Command) -> String {
    let kind = command.kind();
    match s.run_as(Role::PracticeAdmin, command).await {
        Ok(id) => id.unwrap_or_default(),
        Err(e) => panic!("{kind}: {e}"),
    }
}

fn coded(bank_line_id: String, coding: Coding) -> LineCoding {
    LineCoding {
        bank_line_id,
        coding,
        supply_info_confirmed: None,
        asset_class_id: None,
    }
}

fn personal() -> Coding {
    Coding::Out(WithdrawalCoding::Personal)
}

fn expense(account: &str) -> Coding {
    Coding::Out(WithdrawalCoding::Expense {
        account: code(account),
        gst: GstCode::Standard,
    })
}

#[tokio::test]
async fn m11_is_done() {
    let s = setup().await;
    let fixture: Value = serde_json::from_str(CODING).unwrap();
    let expected = &fixture["expected"];
    let year = 2026;

    // Before anything: the M10 figure, and the biggest card first is "only income".
    assert_eq!(s.total().await, cents(&expected["before"]["total"]));
    let q = s.queue().await;
    assert_eq!(q.saved_so_far, Money::ZERO);
    assert_eq!(q.cards[0].kind, CardKind::Question);
    assert_eq!(q.cards[0].question, Some(Question::OnlyIncome));
    assert_eq!(q.cards[0].saving, m("1,537.97"));
    assert!(
        q.cards.windows(2).all(|w| w[0].saving >= w[1].saving),
        "biggest saving first"
    );
    assert!(q.cards.iter().all(|c| c.saving > Money::ZERO));

    // The answers.
    let answers = &fixture["answers"];
    s.ok(Command::AnswerQuestion {
        client_id: s.client.clone(),
        income_year: year,
        answer: Answer::OnlyIncome {
            yes: answers["only_income"].as_bool().unwrap(),
        },
    })
    .await;
    assert_eq!(s.total().await, cents(&expected["after_answers"]["total"]));
    // Now the student loan question would save nothing, so it's hidden.
    let q = s.queue().await;
    assert!(
        !q.cards
            .iter()
            .any(|c| c.question == Some(Question::StudentLoan))
    );
    s.ok(Command::AnswerQuestion {
        client_id: s.client.clone(),
        income_year: year,
        answer: Answer::StudentLoan {
            yes: answers["student_loan"].as_bool().unwrap(),
        },
    })
    .await;
    assert_eq!(s.total().await, cents(&expected["after_answers"]["total"]));

    // The rule codes both grocery lines.
    let mut rule_ids = BTreeMap::new();
    for rule in fixture["rules"].as_array().unwrap() {
        let id = s
            .ok(Command::AddRule {
                client_id: s.client.clone(),
                description_contains: rule["description_contains"].as_str().unwrap().into(),
                min: rule["min"].as_i64().map(Money::from_cents),
                max: rule["max"].as_i64().map(Money::from_cents),
                coding: serde_json::from_value(rule["coding"].clone()).unwrap(),
            })
            .await;
        rule_ids.insert(rule["id"].as_str().unwrap().to_owned(), id);
    }

    // The transfer pair: the queue offers it, saving 110.87 (step 3).
    let q = s.queue().await;
    let transfer = q
        .cards
        .iter()
        .find(|c| c.kind == CardKind::Transfer)
        .expect("a transfer card");
    assert_eq!(transfer.saving, m("110.87"));
    for pair in fixture["transfers"].as_array().unwrap() {
        let out_line_id = s.line(&pair["out"]).await;
        let in_line_id = s.line(&pair["in"]).await;
        assert_eq!(
            transfer
                .lines
                .iter()
                .map(|l| l.bank_line_id.clone())
                .collect::<Vec<_>>(),
            vec![out_line_id.clone(), in_line_id.clone()]
        );
        s.ok(Command::ConfirmTransfer {
            out_line_id,
            in_line_id,
        })
        .await;
    }
    assert_eq!(s.total().await, m("857.48"));

    // Every other line, as the fixture says.
    let mut by_hand = Vec::new();
    let mut confirm = Vec::new();
    for entry in fixture["lines"].as_array().unwrap() {
        let id = s.line(&entry["key"]).await;
        if let Some(rule) = entry["rule"].as_str() {
            let mut conn = s.store.reader().await.unwrap();
            let state = acct_store::coding::line_state(&mut conn, &id)
                .await
                .unwrap()
                .expect("coded by the rule");
            assert_eq!(state.rule_id.as_ref(), Some(&rule_ids[rule]));
            continue;
        }
        let coding: Coding = serde_json::from_value(entry["coding"].clone()).unwrap();
        if entry["supply_info_confirmed"].as_bool() == Some(true) {
            confirm.push(id.clone());
        }
        by_hand.push(coded(id, coding));
    }
    // Code most one at a time and the rest in one batch, as "accept all" would.
    let batch = by_hand.split_off(by_hand.len() / 2);
    for line in by_hand {
        s.ok(Command::CodeBankLine { line }).await;
    }
    s.ok(Command::CodeBankLines { lines: batch }).await;
    for bank_line_id in confirm {
        s.ok(Command::ConfirmSupplyInfo { bank_line_id }).await;
    }

    // The ledger.
    let (tb, _) = s.tb().await;
    let want: BTreeMap<String, Money> = expected["tb"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), cents(v)))
        .collect();
    assert_eq!(tb, want);

    // The GST return and the income tax.
    let mut conn = s.store.reader().await.unwrap();
    let position = tax::position(&mut conn, &s.client, d(TODAY)).await.unwrap();
    drop(conn);
    let [period] = position.gst.as_slice() else {
        panic!("one GST period")
    };
    let g = &expected["gst"];
    let boxes = period.boxes.unwrap();
    for (name, got) in [
        ("box5", boxes.box5),
        ("box6", boxes.box6),
        ("box7", boxes.box7),
        ("box8", boxes.box8),
        ("box9", boxes.box9),
        ("box10", boxes.box10),
        ("box11", boxes.box11),
        ("box12", boxes.box12),
        ("box13", boxes.box13),
        ("box14", boxes.box14),
        ("box15", boxes.box15),
    ] {
        assert_eq!(got, cents(&g[name]), "{name}");
    }
    let [income] = position.income.as_slice() else {
        panic!("one income year")
    };
    let it = &expected["income_tax"];
    assert_eq!(income.income_year, it["year"].as_i64().unwrap() as i32);
    assert_eq!(income.taxable_income, cents(&it["taxable_income"]));
    assert_eq!(income.income_tax, Some(cents(&it["income_tax"])));
    assert_eq!(income.student_loan, Some(cents(&it["student_loan"])));
    assert_eq!(position.total, cents(&expected["total"]));

    // The queue: 1,965.85 saved, and only the gap and the Faro premium's supply information are
    // left (the cards for personal lines save nothing, so they're hidden).
    let q = s.queue().await;
    assert_eq!(q.total, m("540.47"));
    assert_eq!(q.conservative_total, m("2,506.32"));
    assert_eq!(q.saved_so_far, m("1,965.85"));
    let kinds: Vec<CardKind> = q.cards.iter().map(|c| c.kind).collect();
    assert_eq!(kinds, vec![CardKind::Gap, CardKind::SupplyInfo]);
    // Confirming the premium's supply information would claim its 28.04 of GST.
    assert_eq!(q.cards[1].saving, m("28.04"));
    assert_eq!(q.cards[1].lines[0].amount, m("-215.00"));
}

/// Shared by the tests below: a business at the M10 starting point, plus "only income" answered.
async fn answered() -> Setup {
    let s = setup().await;
    s.ok(Command::AnswerQuestion {
        client_id: s.client.clone(),
        income_year: 2026,
        answer: Answer::OnlyIncome { yes: true },
    })
    .await;
    s
}

#[tokio::test]
async fn recoding_twice_leaves_one_live_journal() {
    let s = answered().await;
    let line = s.line_like("WOODMILL HARDWARE").await;
    let (before, _) = s.tb().await;
    assert_eq!(s.live_journals(&line).await, 1);
    s.ok(Command::CodeBankLine {
        line: coded(line.id.clone(), expense("280")),
    })
    .await;
    s.ok(Command::CodeBankLine {
        line: coded(line.id.clone(), personal()),
    })
    .await;
    assert_eq!(s.live_journals(&line).await, 1);
    let (tb, count) = s.tb().await;
    // 120.00 moved from "not yet sorted" to drawings; the bank is untouched.
    assert_eq!(tb["960"], m("120.00"));
    assert_eq!(tb["965"], before["965"] - m("120.00"));
    assert_eq!(tb["600.02"], before["600.02"]);
    assert!(!tb.contains_key("280"));

    // Coding it the same way again posts nothing.
    s.ok(Command::CodeBankLine {
        line: coded(line.id.clone(), personal()),
    })
    .await;
    assert_eq!(s.tb().await.1, count);
}

#[tokio::test]
async fn recoding_one_side_of_a_transfer_undoes_the_pair() {
    let s = answered().await;
    let out = s.line_like("TRANSFER TO").await;
    let inn = s.line_like("TRANSFER FROM").await;
    let (before, _) = s.tb().await;
    s.ok(Command::ConfirmTransfer {
        out_line_id: out.id.clone(),
        in_line_id: inn.id.clone(),
    })
    .await;
    // Confirming again changes nothing.
    let count = s.tb().await.1;
    s.ok(Command::ConfirmTransfer {
        out_line_id: out.id.clone(),
        in_line_id: inn.id.clone(),
    })
    .await;
    assert_eq!(s.tb().await.1, count);
    s.ok(Command::CodeBankLine {
        line: coded(out.id.clone(), personal()),
    })
    .await;
    let (tb, _) = s.tb().await;
    // The deposit is back to unsorted income, with its GST, and the withdrawal is drawings.
    assert_eq!(tb["140"], before["140"]);
    assert_eq!(tb["810"], before["810"]);
    assert_eq!(tb["960"], m("500.00"));
    assert_eq!(tb["600.01"], before["600.01"]);
    assert_eq!(tb["600.02"], before["600.02"]);
}

#[tokio::test]
async fn an_income_tax_payment_is_a_credit() {
    let s = answered().await;
    let before = s.total().await;
    let line = s.line_like("ATM WITHDRAWAL").await;
    s.ok(Command::ConfirmIrdPayment {
        bank_line_id: line.id,
        payment: IrdPayment::IncomeTax { income_year: 2026 },
    })
    .await;
    assert_eq!(s.total().await, before - m("200.00"));
    let (tb, _) = s.tb().await;
    assert_eq!(tb["962"], m("200.00"));
}

#[tokio::test]
async fn an_asset_purchase_goes_into_the_register() {
    let s = answered().await;
    let line = s.line_like("WOODMILL HARDWARE").await;
    s.ok(Command::CodeBankLine {
        line: coded(
            line.id.clone(),
            Coding::Out(WithdrawalCoding::AssetPurchase {
                account: code("700"),
                gst: GstCode::Standard,
            }),
        ),
    })
    .await;
    let mut conn = s.store.reader().await.unwrap();
    let register = assets::assets_for_client(&mut conn, &s.client)
        .await
        .unwrap();
    drop(conn);
    let [asset] = register.as_slice() else {
        panic!("one asset: {register:?}")
    };
    assert_eq!(asset.name, "WOODMILL HARDWARE");
    assert_eq!(asset.asset.cost, m("104.35"));
    assert_eq!(asset.asset.acquired, d("2025-08-05"));
    assert_eq!(s.tb().await.0["700"], m("104.35"));

    // Recoding it as something else takes the asset out again.
    s.ok(Command::CodeBankLine {
        line: coded(line.id, expense("280")),
    })
    .await;
    let mut conn = s.store.reader().await.unwrap();
    assert!(
        assets::assets_for_client(&mut conn, &s.client)
            .await
            .unwrap()
            .is_empty()
    );
}

#[tokio::test]
async fn coding_settings_apply_to_lines_coded_afterwards() {
    let s = answered().await;
    let mut conn = s.store.reader().await.unwrap();
    let mut settings: CodingSettings = acct_store::coding::settings(&mut conn, &s.client)
        .await
        .unwrap()
        .unwrap();
    drop(conn);
    assert_eq!(settings.drawings, code("960"));
    let atm = s.line_like("ATM WITHDRAWAL").await;
    s.ok(Command::CodeBankLine {
        line: coded(atm.id, personal()),
    })
    .await;
    settings.drawings = code("954");
    s.ok(Command::SetCodingSettings {
        client_id: s.client.clone(),
        settings,
    })
    .await;
    let cafe = s.line_like("KAURI GAS").await;
    s.ok(Command::CodeBankLine {
        line: coded(cafe.id, personal()),
    })
    .await;
    let (tb, _) = s.tb().await;
    assert_eq!(tb["960"], m("200.00"));
    assert_eq!(tb["954"], m("48.20"));
}

#[tokio::test]
async fn card_statements_get_a_liability_account() {
    let s = setup().await;
    s.upload("harbourlight-visa-2025-08.ofx", VISA).await;
    let mut conn = s.store.reader().await.unwrap();
    let card = bank_store::bank_accounts(&mut conn, &s.client)
        .await
        .unwrap()
        .into_iter()
        .find(|a| a.kind == AccountKind::CreditCard)
        .expect("a card account");
    assert_eq!(card.code, code("850.01"));
    assert_eq!(card.name, "Credit card ending 4417");
    assert_eq!(card.account_number.as_deref(), Some("XXXX-XXXX-XXXX-4417"));
    let chart = clients::chart(&mut conn, &s.client).await.unwrap();
    assert_eq!(
        chart.get(&code("850.01")).unwrap().account_type,
        AccountType::Liability
    );
    let cheque = bank_store::bank_accounts(&mut conn, &s.client)
        .await
        .unwrap()
        .into_iter()
        .find(|a| a.code == code("600.01"))
        .unwrap();
    drop(conn);
    let (tb, _) = s.tb().await;
    assert!(tb.contains_key("850.01"));

    // A card statement can't go into a bank account, nor a bank statement into a card.
    let err = s
        .run(Command::ImportStatement {
            client_id: s.client.clone(),
            file_name: "visa.ofx".into(),
            content_base64: base64(VISA),
            bank_account_id: Some(cheque.id),
        })
        .await
        .unwrap_err();
    assert_eq!(err["code"], "wrong_bank_account");
    let other = s
        .ok(Command::AddCardAccount {
            client_id: s.client.clone(),
            name: "Spare card".into(),
            card_number: None,
        })
        .await;
    let (_, bytes) = STATEMENTS[0];
    let err = s
        .run(Command::ImportStatement {
            client_id: s.client.clone(),
            file_name: "cheque.ofx".into(),
            content_base64: base64(bytes),
            bank_account_id: Some(other),
        })
        .await
        .unwrap_err();
    assert_eq!(err["code"], "wrong_account_kind");
}

#[tokio::test]
async fn via_is_recorded_in_the_log() {
    let s = answered().await;
    let line = s.line_like("ATM WITHDRAWAL").await;
    let other = s.line_like("PIKORUA CAFE").await;
    let actor = Actor {
        user_id: None,
        role: Role::Staff,
    };
    // An AI suggestion waiting on the owner (ADR 009).
    s.ok(Command::SetAiSuggestions {
        client_id: s.client.clone(),
        enabled: true,
        activity: None,
        private_names: None,
    })
    .await;
    s.ok(Command::RecordSuggestions {
        client_id: s.client.clone(),
        model: "claude-haiku-5-5".into(),
        suggestions: vec![
            SuggestedCoding {
                bank_line_id: line.id.clone(),
                coding: personal(),
                confidence: SuggestionConfidence::High,
            },
            SuggestedCoding {
                bank_line_id: other.id.clone(),
                coding: personal(),
                confidence: SuggestionConfidence::Medium,
            },
        ],
    })
    .await;
    async fn live(s: &Setup) -> Vec<acct_store::ai::StoredSuggestion> {
        let mut conn = s.store.reader().await.unwrap();
        acct_store::ai::live_suggestions(&mut conn, &s.client)
            .await
            .unwrap()
    }
    let waiting = live(&s).await;
    let suggestion = waiting
        .iter()
        .find(|w| w.bank_line_id == line.id)
        .unwrap()
        .clone();
    let via = |ids: Vec<String>| Via::Suggestion {
        model: "claude-haiku-5-5".into(),
        suggestion_ids: ids,
    };
    async fn code_code(
        s: &Setup,
        coding: LineCoding,
        v: Via,
    ) -> Result<acct_server::commands::Accepted, acct_server::error::CommandError> {
        let actor = Actor {
            user_id: None,
            role: Role::Staff,
        };
        submit_via(
            &s.store,
            &actor,
            envelope(Command::CodeBankLine { line: coding }),
            Some(v),
            now(),
        )
        .await
    }
    let code_of = |e: acct_server::error::CommandError| {
        serde_json::to_value(e.body()).unwrap()["code"].clone()
    };

    // The coding must be the suggestion's, for the suggestion's line, from its model.
    let err = code_code(
        &s,
        coded(line.id.clone(), expense("290")),
        via(vec![suggestion.id.clone()]),
    )
    .await
    .unwrap_err();
    assert_eq!(code_of(err), "invalid_via");
    let err = code_code(
        &s,
        coded(other.id.clone(), personal()),
        via(vec![suggestion.id.clone()]),
    )
    .await
    .unwrap_err();
    assert_eq!(code_of(err), "invalid_via");
    let err = code_code(
        &s,
        coded(line.id.clone(), personal()),
        Via::Suggestion {
            model: "another-model".into(),
            suggestion_ids: vec![suggestion.id.clone()],
        },
    )
    .await
    .unwrap_err();
    assert_eq!(code_of(err), "invalid_via");

    // Accepted unchanged: logged with `via`, and kept as accepted.
    let env = envelope(Command::CodeBankLine {
        line: coded(line.id.clone(), personal()),
    });
    let id = env.id.clone();
    submit_via(
        &s.store,
        &actor,
        env,
        Some(via(vec![suggestion.id.clone()])),
        now(),
    )
    .await
    .unwrap();
    let mut conn = s.store.reader().await.unwrap();
    let logged = log::find(&mut conn, &id).await.unwrap().unwrap();
    let logged_via: Value = serde_json::from_str(logged.via.as_deref().unwrap()).unwrap();
    assert_eq!(logged_via["kind"], "suggestion");
    assert_eq!(logged_via["model"], "claude-haiku-5-5");
    assert_eq!(logged_via["suggestion_ids"][0], suggestion.id.as_str());
    let stored = acct_store::ai::suggestion(&mut conn, &suggestion.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.accepted_seq, Some(logged.seq));
    drop(conn);

    // An accepted suggestion can't be accepted again.
    let err = code_code(
        &s,
        coded(line.id.clone(), personal()),
        via(vec![suggestion.id.clone()]),
    )
    .await
    .unwrap_err();
    assert_eq!(code_of(err), "invalid_via");

    // Coding a line some other way deletes the suggestion still waiting on it.
    s.ok(Command::CodeBankLine {
        line: coded(other.id.clone(), expense("290")),
    })
    .await;
    assert!(live(&s).await.is_empty());

    // A suggestion must say which model and which suggestions.
    let err = submit_via(
        &s.store,
        &actor,
        envelope(Command::CodeBankLine {
            line: coded(line.id, personal()),
        }),
        Some(Via::Suggestion {
            model: " ".into(),
            suggestion_ids: vec![],
        }),
        now(),
    )
    .await
    .unwrap_err();
    assert_eq!(code_of(err), "invalid_via");
}

#[tokio::test]
async fn coding_commands_are_rejected_when_they_should_be() {
    let s = answered().await;
    let atm = s.line_like("ATM WITHDRAWAL").await;
    let sale = s.line_like("PAYBLOOM").await;
    let transfer_out = s.line_like("TRANSFER TO").await;

    // code_bank_line: the coding's direction must be the line's, and its accounts must fit.
    assert_eq!(
        s.rejected(Command::CodeBankLine {
            line: coded(sale.id.clone(), personal()),
        })
        .await,
        "invalid_coding"
    );
    assert_eq!(
        s.rejected(Command::CodeBankLine {
            line: coded(atm.id.clone(), expense("100")),
        })
        .await,
        "invalid_coding"
    );
    assert_eq!(
        s.rejected(Command::CodeBankLine {
            line: coded("nope".into(), personal()),
        })
        .await,
        "not_found"
    );
    // A transfer to an account with its own statement for that day goes through confirm_transfer.
    assert_eq!(
        s.rejected(Command::CodeBankLine {
            line: coded(
                transfer_out.id.clone(),
                Coding::Out(WithdrawalCoding::Transfer { to: code("600.02") }),
            ),
        })
        .await,
        "use_confirm_transfer"
    );
    // Viewers can't code.
    let err = s
        .run_as(
            Role::Viewer,
            Command::CodeBankLine {
                line: coded(atm.id.clone(), personal()),
            },
        )
        .await
        .unwrap_err();
    assert_eq!(err["code"], "forbidden");

    // code_bank_lines: all or nothing, at least one line, no line twice.
    let (_, count) = s.tb().await;
    assert_eq!(
        s.rejected(Command::CodeBankLines {
            lines: vec![
                coded(atm.id.clone(), personal()),
                coded(sale.id.clone(), personal()),
            ],
        })
        .await,
        "invalid_coding"
    );
    assert_eq!(s.tb().await.1, count, "nothing was kept");
    assert_eq!(
        s.rejected(Command::CodeBankLines { lines: vec![] }).await,
        "no_lines"
    );
    assert_eq!(
        s.rejected(Command::CodeBankLines {
            lines: vec![
                coded(atm.id.clone(), personal()),
                coded(atm.id.clone(), personal()),
            ],
        })
        .await,
        "line_repeated"
    );

    // add_rule and remove_rule.
    let rule =
        |text: &str, min: Option<&str>, max: Option<&str>, coding: Coding| Command::AddRule {
            client_id: s.client.clone(),
            description_contains: text.into(),
            min: min.map(m),
            max: max.map(m),
            coding,
        };
    assert_eq!(
        s.rejected(rule("  ", None, None, personal())).await,
        "empty_rule"
    );
    assert_eq!(
        s.rejected(rule("ATM", Some("5.00"), Some("4.00"), personal()))
            .await,
        "min_above_max"
    );
    assert_eq!(
        s.rejected(rule("ATM", Some("-5.00"), None, personal()))
            .await,
        "negative_amount"
    );
    assert_eq!(
        s.rejected(rule("ATM", None, None, expense("960"))).await,
        "invalid_coding"
    );
    assert_eq!(
        s.rejected(Command::RemoveRule {
            rule_id: "nope".into()
        })
        .await,
        "not_found"
    );
    let rule_id = s.ok(rule("ATM", None, None, personal())).await;
    s.ok(Command::RemoveRule {
        rule_id: rule_id.clone(),
    })
    .await;
    assert_eq!(
        s.rejected(Command::RemoveRule { rule_id }).await,
        "not_found"
    );

    // answer_question.
    let answer = |income_year, answer| Command::AnswerQuestion {
        client_id: s.client.clone(),
        income_year,
        answer,
    };
    assert_eq!(
        s.rejected(answer(2031, Answer::StudentLoan { yes: false }))
            .await,
        "no_such_year"
    );
    assert_eq!(
        s.rejected(answer(
            2026,
            Answer::OtherIncome {
                income: m("-1.00"),
                tax_deducted: Money::ZERO,
            }
        ))
        .await,
        "negative_amount"
    );
    assert_eq!(
        s.rejected(answer(2026, Answer::Ietc { months: 13 })).await,
        "invalid_months"
    );

    // confirm_transfer: money out of one account and the same amount into another.
    assert_eq!(
        s.rejected(Command::ConfirmTransfer {
            out_line_id: sale.id.clone(),
            in_line_id: atm.id.clone(),
        })
        .await,
        "not_a_transfer"
    );

    // confirm_ird_payment.
    let refund = s.line_like("IRD GST REFUND").await;
    assert_eq!(
        s.rejected(Command::ConfirmIrdPayment {
            bank_line_id: refund.id.clone(),
            payment: IrdPayment::IncomeTax { income_year: 2026 },
        })
        .await,
        "income_tax_refund_not_supported"
    );
    assert_eq!(
        s.rejected(Command::ConfirmIrdPayment {
            bank_line_id: atm.id.clone(),
            payment: IrdPayment::IncomeTax { income_year: 2030 },
        })
        .await,
        "unlikely_income_year"
    );

    // resolve_duplicate: only for lines flagged as possible duplicates.
    assert_eq!(
        s.rejected(Command::ResolveDuplicate {
            bank_line_id: atm.id.clone(),
            is_duplicate: true,
        })
        .await,
        "not_a_possible_duplicate"
    );

    // confirm_supply_info: only for money out.
    assert_eq!(
        s.rejected(Command::ConfirmSupplyInfo {
            bank_line_id: sale.id.clone(),
        })
        .await,
        "not_spending"
    );

    // add_card_account.
    assert_eq!(
        s.rejected(Command::AddCardAccount {
            client_id: s.client.clone(),
            name: "Card".into(),
            card_number: Some("12".into()),
        })
        .await,
        "invalid_card_number"
    );
    assert_eq!(
        s.rejected(Command::AddCardAccount {
            client_id: s.client.clone(),
            name: " ".into(),
            card_number: None,
        })
        .await,
        "name_required"
    );

    // set_coding_settings: every account must exist and be of the right type.
    let mut conn = s.store.reader().await.unwrap();
    let mut settings = acct_store::coding::settings(&mut conn, &s.client)
        .await
        .unwrap()
        .unwrap();
    drop(conn);
    settings.income_tax = code("290");
    assert_eq!(
        s.rejected(Command::SetCodingSettings {
            client_id: s.client.clone(),
            settings,
        })
        .await,
        "invalid_coding_settings"
    );
}

#[tokio::test]
async fn duplicates_post_nothing_until_said_otherwise() {
    let s = answered().await;
    // A re-export of a day Rimu's statement already covers, with the top-up described differently:
    // a new line on a covered day is a possible duplicate.
    s.upload(
        "rimu-again.csv",
        b"Account,Posted,Type,Payee,Particulars,Reference,Amount
          99-7702-0000789-00,2025-09-03,DEP,Q MARSH,Top-up,,300.00
",
    )
    .await;
    let line = s.line_like("Q MARSH TOP-UP").await;
    let line = if line.possible_duplicate {
        line
    } else {
        let mut conn = s.store.reader().await.unwrap();
        bank_store::bank_lines(&mut conn, &s.client)
            .await
            .unwrap()
            .into_iter()
            .find(|l| l.possible_duplicate)
            .expect("a possible duplicate")
    };
    let q = s.queue().await;
    let card = q
        .cards
        .iter()
        .find(|c| c.kind == CardKind::Duplicate)
        .expect("a duplicate card");
    assert_eq!(card.lines[0].bank_line_id, line.id);
    assert!(card.saving > Money::ZERO);
    let (before, _) = s.tb().await;
    s.ok(Command::ResolveDuplicate {
        bank_line_id: line.id.clone(),
        is_duplicate: true,
    })
    .await;
    let (tb, _) = s.tb().await;
    assert_eq!(tb["600.03"], before["600.03"] - line.amount);
    assert_eq!(
        s.rejected(Command::CodeBankLine {
            line: coded(
                line.id.clone(),
                if line.amount < Money::ZERO {
                    personal()
                } else {
                    Coding::In(DepositCoding::OwnerFunds)
                }
            ),
        })
        .await,
        "line_is_duplicate"
    );
    s.ok(Command::ResolveDuplicate {
        bank_line_id: line.id.clone(),
        is_duplicate: false,
    })
    .await;
    assert_eq!(s.tb().await.0, before);
}
