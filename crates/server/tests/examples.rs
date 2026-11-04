//! M20: the landing-page examples on the server (`fixtures/landing/README.md`). Each is run
//! through the same path a guest takes (`start_guest`, ADR 014, 9), and the figures are pinned.

mod common;

use acct_core::GstCode;
use acct_core::Money;
use acct_core::coding::{Coding, DepositCoding, WithdrawalCoding};
use acct_core::tax::gst::GstFrequency;
use acct_server::commands::{Answer, Command, CommandEnvelope, IrdPayment, LineCoding};
use acct_server::examples::{self, ExampleStatement};
use acct_server::pipeline::{Actor, submit};
use acct_server::save_tax::{self, CardKind, Question, SaveTaxCard};
use acct_server::starter::StarterSet;
use acct_store::Store;
use acct_store::bank as bank_store;
use acct_store::guests::GstSource;
use acct_store::users::Role;
use axum::http::{StatusCode, header};
use tempfile::TempDir;

fn m(s: &str) -> Money {
    s.parse().unwrap()
}

/// A throwaway server with the sole-trader defaults and one example's business, made as a
/// visitor's "Use this example" makes it.
struct Example {
    _dir: TempDir,
    store: Store,
    client: String,
}

impl Example {
    async fn new(number: u8) -> Example {
        let dir = TempDir::new().unwrap();
        let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
        let mut e = Example {
            _dir: dir,
            store,
            client: String::new(),
        };
        e.run(Command::InstallStarterSet {
            set: StarterSet::SoleTrader,
        })
        .await;
        e.client = e
            .run_as(
                Role::BusinessOwner,
                examples::start_command(number).unwrap(),
            )
            .await
            .unwrap();
        e
    }

    /// As the server: it can answer for an unsaved trial, which no person but its guest sees.
    async fn run(&self, command: Command) -> Option<String> {
        self.run_as(Role::PracticeAdmin, command).await
    }

    async fn run_as(&self, role: Role, command: Command) -> Option<String> {
        let admin = Actor {
            user_id: None,
            role,
            acting_as: None,
        };
        let kind = command.kind();
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        match submit(&self.store, &admin, envelope, chrono::Utc::now()).await {
            Ok(a) => a.entity_id,
            Err(e) => panic!("{kind}: {}", serde_json::to_value(e.body()).unwrap()),
        }
    }

    async fn queue(&self) -> save_tax::SaveTaxQueue {
        let mut conn = self.store.reader().await.unwrap();
        save_tax::queue(&mut conn, &self.client).await.unwrap()
    }

    /// The code of the business's bank account with this number, adding it first if it isn't
    /// there (a second account the owner mentions, such as savings).
    async fn account_code(&self, number: &str, name: &str) -> acct_core::AccountCode {
        let find = || async {
            let mut conn = self.store.reader().await.unwrap();
            bank_store::bank_accounts(&mut conn, &self.client)
                .await
                .unwrap()
                .into_iter()
                .find(|a| a.account_number.as_deref() == Some(number))
        };
        if let Some(a) = find().await {
            return a.code;
        }
        self.run(Command::AddBankAccount {
            client_id: self.client.clone(),
            name: name.into(),
            account_number: Some(number.into()),
        })
        .await;
        find().await.unwrap().code
    }

    /// Answers a card the way the README says the line (or the owner) is, and says what it did.
    async fn answer(&self, card: &SaveTaxCard) -> String {
        match card.kind {
            CardKind::Question => {
                let (answer, said) = match card.question.unwrap() {
                    Question::OnlyIncome => (Answer::OnlyIncome { yes: true }, "only income: yes"),
                    Question::StudentLoan => {
                        (Answer::StudentLoan { yes: false }, "student loan: no")
                    }
                    // The README: Matai Design Studio isn't registered.
                    Question::GstRegistered => {
                        self.run(Command::SetGstRegistration {
                            client_id: self.client.clone(),
                            registered: false,
                            registered_from: None,
                            frequency: None,
                            source: GstSource::Owner,
                        })
                        .await;
                        return "GST registered: no".to_owned();
                    }
                    other => panic!("the README doesn't answer {other:?}"),
                };
                self.run(Command::AnswerQuestion {
                    client_id: self.client.clone(),
                    income_year: card.income_year.unwrap(),
                    answer,
                })
                .await;
                said.to_owned()
            }
            CardKind::IrdPayment => {
                let line = &card.lines[0];
                let gst = line.description.contains("GST");
                self.run(Command::ConfirmIrdPayment {
                    bank_line_id: line.bank_line_id.clone(),
                    payment: if gst {
                        IrdPayment::Gst
                    } else {
                        IrdPayment::IncomeTax { income_year: 2026 }
                    },
                })
                .await;
                format!("IRD payment: {}", if gst { "GST" } else { "income tax" })
            }
            CardKind::Categorise => {
                let line = &card.lines[0];
                let d = &line.description;
                let code = |c: &str| c.parse::<acct_core::AccountCode>().unwrap();
                let (coding, said) = if ["TAPPA PAYMENTS", "WHENUA", "KŌRERO", "PURIRI"]
                    .iter()
                    .any(|k| d.contains(k))
                {
                    (
                        Coding::In(DepositCoding::Income {
                            account: code("100"),
                            gst: GstCode::Standard,
                        }),
                        "income",
                    )
                } else if let Some(cost) =
                    [("GRINDER", "700"), ("VAN REGO", "710"), ("LAPTOP", "720")]
                        .iter()
                        .find(|(k, _)| d.contains(k))
                        .map(|(_, c)| *c)
                {
                    (
                        Coding::Out(WithdrawalCoding::AssetPurchase {
                            account: code(cost),
                            gst: GstCode::Standard,
                        }),
                        "asset",
                    )
                } else if d.starts_with("TRANSFER FROM") {
                    let from = self.account_code("99-4410-0023456-01", "Van savings").await;
                    (Coding::In(DepositCoding::Transfer { from }), "transfer in")
                } else {
                    panic!("the README doesn't say what this line is: {d}");
                };
                self.run(Command::CodeBankLine {
                    line: LineCoding {
                        bank_line_id: line.bank_line_id.clone(),
                        coding,
                        // A van or a grinder comes with a tax invoice; GST over $200 is claimed on it.
                        supply_info_confirmed: (said == "asset").then_some(true),
                        asset_class_id: None,
                    },
                })
                .await;
                format!("{said}: {d}")
            }
            other => panic!("the README doesn't answer a {other:?} card"),
        }
    }
}

#[tokio::test]
async fn the_examples_describe_their_files() {
    let all = examples::examples().await.unwrap();
    let summary: Vec<_> = all
        .iter()
        .map(|e: &ExampleStatement| {
            (
                e.number,
                e.title.as_str(),
                e.business.as_str(),
                e.bank.as_str(),
                e.lines.len(),
                e.opening_balance,
                e.closing_balance,
                e.gst.map(|g| g.frequency),
                e.gst_source,
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            (
                1,
                "Example 1",
                "Tūī Street Coffee",
                "Piwakawaka Bank",
                27,
                m("3,184.20"),
                m("7,969.08"),
                Some(GstFrequency::TwoMonthlyOdd),
                GstSource::Detected
            ),
            (
                2,
                "Example 2",
                "Matai Design Studio",
                "Tōtara Mutual Bank",
                24,
                m("2,410.55"),
                m("10,435.47"),
                // Its only IRD line is income tax: nothing proves it either way (ADR 014, 3).
                Some(GstFrequency::TwoMonthlyOdd),
                GstSource::Assumed
            ),
            (
                3,
                "Example 3",
                "Kahu Electrical",
                "Kea Trust Bank",
                41,
                m("6,842.90"),
                m("25,258.58"),
                Some(GstFrequency::TwoMonthlyEven),
                GstSource::Detected
            ),
        ]
    );
    for e in all {
        assert!(e.raw.contains("<OFX>"), "{}: the raw OFX text", e.title);
        assert!(
            e.lines
                .iter()
                .all(|l| l.date >= e.period_start && l.date <= e.period_end)
        );
        // A guest's books start on 1 April of the statement's income year (ADR 014, 3).
        assert_eq!(e.start_date, "2025-04-01".parse().unwrap());
        assert_eq!(e.gst.unwrap().registered_from, e.start_date);
    }
    // The parser's own text, so a visitor sees the macrons and the ampersand as written.
    assert!(all[1].raw.contains("Tōtara"));
}

#[tokio::test]
async fn each_examples_conservative_figure_is_pinned() {
    let pinned: Vec<(u8, Money)> = examples::examples()
        .await
        .unwrap()
        .iter()
        .map(|e| (e.number, e.conservative_tax))
        .collect();
    assert_eq!(
        pinned,
        vec![
            (1, Money::from_cents(530_798)),
            // Assumed registered, so its deposits carry GST: the higher figure.
            (2, Money::from_cents(911_151)),
            (3, Money::from_cents(3_289_009)),
        ]
    );
    // The same figure an owner's upload gives, with nothing answered and nothing sorted.
    for (number, figure) in pinned {
        let q = Example::new(number).await.queue().await;
        assert_eq!(q.conservative_total, figure, "example {number}");
        assert_eq!(q.total, figure, "example {number}");
        assert_eq!(q.saved_so_far, Money::ZERO);
    }
}

/// Answering the top three cards, each time the first the queue offers, with the answers the
/// README implies. The figure after each answer is pinned.
#[tokio::test]
async fn answering_the_top_three_cards_lowers_each_figure_by_pinned_amounts() {
    let mut got: Vec<(u8, Vec<(String, i64)>)> = Vec::new();
    for number in 1..=3u8 {
        let e = Example::new(number).await;
        let mut steps = Vec::new();
        for _ in 0..3 {
            let top = e.queue().await.cards.remove(0);
            let said = e.answer(&top).await;
            steps.push((said, e.queue().await.total.cents()));
        }
        got.push((number, steps));
    }
    let step = |said: &str, cents: i64| (said.to_owned(), cents);
    assert_eq!(
        got,
        vec![
            // 5,307.98 before. The GST payment is for August and September, before this
            // statement starts, and a card settlement is income, so those two save nothing.
            (
                1,
                vec![
                    step("only income: yes", 205_081),
                    step("IRD payment: GST", 205_081),
                    step("income: TAPPA PAYMENTS SETTLE MERCH 4471 10-12OCT", 205_081),
                ]
            ),
            // 9,111.51 before, assumed GST registered. Once the business is the only income,
            // "Are you GST registered?" is the top card, and "no" takes its GST off. The $1,500
            // already paid to IRD is a credit.
            (
                2,
                vec![
                    step("only income: yes", 352_036),
                    step("GST registered: no", 168_632),
                    step("IRD payment: income tax", 18_632),
                ]
            ),
            // 32,890.09 before. $20,000 from savings isn't income, and the van's GST
            // ($3,750) is claimed.
            (
                3,
                vec![
                    step("only income: yes", 1_818_854),
                    step(
                        "transfer in: TRANSFER FROM 99 4410 0023456 01 VAN SAVINGS",
                        1_044_940
                    ),
                    step("asset: ROTORUA MOTOR CENTRE VAN REGO KHE24", 669_940),
                ]
            ),
        ]
    );
}

#[tokio::test]
async fn the_route_is_public_and_cached() {
    let server = common::Server::new().await;
    let response = server.send(common::get("/api/examples", None)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[header::CACHE_CONTROL],
        "public, max-age=3600"
    );
    let (_, body) = common::split(response).await;
    let list = body.as_array().unwrap();
    assert_eq!(list.len(), 3);
    assert_eq!(list[0]["title"], "Example 1");
    assert_eq!(list[0]["conservative_tax"], 530_798);
    assert!(list[0]["lines"][0]["amount"].is_i64());
    assert!(list[0]["lines"][0]["date"].is_string());
    assert!(list[0]["raw"].as_str().unwrap().contains("<OFX>"));
}
