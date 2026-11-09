//! M22 (ADR 016): every AI ask leaves one `ai_usage` row, the limits are counted from those rows
//! and survive a restart, the budget cap refuses model calls, and overseers are never refused.
//! Over HTTP with the fake suggester; no network.

mod common;

use std::sync::Arc;

use acct_ai::FakeSuggester;
use acct_ai::eval::Prices;
use acct_core::tax::gst::GstFrequency;
use acct_core::{Account, Mapping, Template};
use acct_server::ai::{ExplainLimits, Quota};
use acct_server::ai_limits::{LimitTable, Plan};
use acct_server::ai_usage::Metered;
use acct_server::ai_watch::AiKind;
use acct_server::business::{GstBasis, GstSetup};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_store::sqlx;
use acct_store::users::Role;
use axum::http::StatusCode;
use chrono::{NaiveDate, Utc};
use common::{PASSWORD, Server, new_id, post_json, split};
use serde_json::{Value, json};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const STATEMENTS: &[(&str, &[u8])] = &[
    (
        "harbourlight-cheque-2025-08.ofx",
        include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx"),
    ),
    (
        "kowhai-business-2025-08.csv",
        include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv"),
    ),
    (
        "rimu-savings-2025-08-29_09-30.csv",
        include_bytes!("../../../fixtures/bank-statements/rimu-savings-2025-08-29_09-30.csv"),
    ),
];

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

fn payload(command: Command) -> (String, Value) {
    let kind = command.kind().to_owned();
    let mut v = serde_json::to_value(command).unwrap();
    (kind, v["payload"].take())
}

async fn ok(s: &Server, cookie: &str, command: Command) -> String {
    let (kind, payload) = payload(command);
    let (status, body) = s.command(cookie, &kind, payload).await;
    assert_eq!(status, StatusCode::OK, "{kind}: {body}");
    body["entity_id"].as_str().unwrap_or_default().to_owned()
}

/// The practice's sole trader defaults.
async fn defaults(s: &Server, boss: &str) {
    let accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    let template: Template = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    ok(
        s,
        boss,
        Command::CreateMasterChart {
            entity_type: "sole_trader".into(),
            name: "Sole trader".into(),
            accounts,
        },
    )
    .await;
    let template_id = ok(
        s,
        boss,
        Command::CreateTemplate {
            entity_type: "sole_trader".into(),
            name: "Sole trader".into(),
            body: template,
        },
    )
    .await;
    ok(
        s,
        boss,
        Command::CreateMapping {
            template_id,
            name: "Sole trader".into(),
            body: mapping,
        },
    )
    .await;
}

/// A sole trader business, with the three statements uploaded and nothing sorted, or with none.
async fn business(s: &Server, boss: &str, name: &str, statements: bool) -> String {
    let client = ok(
        s,
        boss,
        Command::SetUpBusiness {
            name: name.into(),
            start_date: NaiveDate::from_ymd_opt(2025, 8, 1).unwrap(),
            gst: Some(GstSetup {
                registered_from: NaiveDate::from_ymd_opt(2025, 8, 1).unwrap(),
                frequency: GstFrequency::TwoMonthlyOdd,
                basis: GstBasis::Payments,
            }),
        },
    )
    .await;
    if statements {
        for (file, bytes) in STATEMENTS {
            ok(
                s,
                boss,
                Command::ImportStatement {
                    client_id: client.clone(),
                    file_name: (*file).into(),
                    content_base64: base64(bytes),
                    bank_account_id: None,
                },
            )
            .await;
        }
    }
    client
}

async fn suggest(s: &Server, cookie: &str, client: &str) -> (StatusCode, Value) {
    split(
        s.send(post_json(
            &format!("/api/businesses/{client}/ai-suggestions"),
            Some(cookie),
            &json!({}),
        ))
        .await,
    )
    .await
}

async fn explain(s: &Server, cookie: &str, client: &str, card_id: &str) -> (StatusCode, Value) {
    split(
        s.send(post_json(
            &format!("/api/businesses/{client}/explain"),
            Some(cookie),
            &json!({ "card_id": card_id }),
        ))
        .await,
    )
    .await
}

async fn queue(s: &Server, cookie: &str, client: &str) -> Value {
    s.get_json(&format!("/api/businesses/{client}/save-tax"), cookie)
        .await
}

async fn first_card(s: &Server, cookie: &str, client: &str) -> String {
    queue(s, cookie, client).await["cards"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn view(s: &Server, cookie: &str, client: &str) -> Value {
    s.get_json(&format!("/api/businesses/{client}/ai-suggestions"), cookie)
        .await
}

async fn user_id(s: &Server, cookie: &str) -> String {
    s.get_json("/api/me", cookie).await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// Every `ai_usage` row, oldest first, as JSON.
async fn rows(s: &Server) -> Vec<Value> {
    let mut conn = s.state.store.reader().await.unwrap();
    let json: Vec<String> = sqlx::query_scalar(
        "SELECT json_object('kind', kind, 'business_id', business_id, 'user_id', user_id,
            'plan', plan, 'is_overseer', is_overseer, 'acting_as', acting_as, 'model', model,
            'model_calls', model_calls, 'input_tokens', input_tokens,
            'output_tokens', output_tokens, 'cost_micro_usd', cost_micro_usd,
            'latency_ms', latency_ms, 'outcome', outcome, 'lines_total', lines_total,
            'by_rules', by_rules, 'by_history', by_history, 'by_merchants', by_merchants,
            'lines_asked', lines_asked, 'by_model', by_model)
         FROM ai_usage ORDER BY at, rowid",
    )
    .fetch_all(&mut *conn)
    .await
    .unwrap();
    json.iter()
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

fn outcomes(rows: &[Value]) -> Vec<&str> {
    rows.iter()
        .map(|r| r["outcome"].as_str().unwrap())
        .collect()
}

fn install(s: &mut Server, metered: Metered, quota: Quota, explain: ExplainLimits) {
    s.state.suggester = Some(Arc::new(metered));
    s.state.ai_quota = Arc::new(quota);
    s.state.explain_quota = Arc::new(explain);
}

fn fake() -> Arc<FakeSuggester> {
    Arc::new(FakeSuggester::with_defaults("fake-model"))
}

/// The standard plan table, but nothing per address or overall.
fn standard() -> (Quota, ExplainLimits) {
    (
        Quota::new(LimitTable::standard()),
        ExplainLimits::new(LimitTable::standard(), None, None),
    )
}

/// $1 per million input tokens and $5 per million output tokens: the fake's call (120 in, 30 out)
/// costs 120 + 150 = 270 micro-dollars.
const CHEAP: Prices = Prices {
    input: 1_000_000,
    output: 5_000_000,
    cache_read: 0,
    cache_write: 0,
};

/// $100 per million input tokens: the fake's call costs 12,000 micro-dollars, over a 1-cent cap.
const DEAR: Prices = Prices {
    input: 100_000_000,
    output: 0,
    cache_read: 0,
    cache_write: 0,
};

async fn add_overseer(s: &Server, username: &str) {
    let system = Actor {
        user_id: None,
        role: Role::Overseer,
        acting_as: None,
    };
    let envelope = CommandEnvelope {
        id: new_id(),
        command: serde_json::from_value(json!({
            "kind": "create_user",
            "payload": {
                "username": username, "display_name": username,
                "password": PASSWORD, "role": "overseer",
            },
        }))
        .unwrap(),
    };
    submit(&s.state.store, &system, envelope, Utc::now())
        .await
        .unwrap();
}

#[tokio::test]
async fn each_kind_of_ask_writes_exactly_one_row_with_the_right_fields() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    let empty = business(&s, &boss, "Quiet Pines", false).await;
    let model = fake();
    install(
        &mut s,
        Metered::new(model.clone()).with_prices(Some(CHEAP)),
        Quota::default(),
        ExplainLimits::default(),
    );
    let sam_id = user_id(&s, &sam).await;
    assert!(rows(&s).await.is_empty());

    // The practice's merchant list answers a line, so a layer other than the model shows up.
    ok(
        &s,
        &boss,
        serde_json::from_value(json!({
            "kind": "add_merchant",
            "payload": {
                "entity_type": "sole_trader",
                "description_contains": "GRIDLINE POWER",
                "coding": { "direction": "out", "kind": "expense", "account": "255", "gst": "standard" },
            },
        }))
        .unwrap(),
    )
    .await;

    // A suggestions run that called the model.
    let (status, run) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let asked = run["asked"].as_u64().unwrap();
    let made = run["suggestions"].as_array().unwrap().len() as u64;
    assert!(asked > 0 && made > 0);
    let calls = asked.div_ceil(50);
    let all = rows(&s).await;
    assert_eq!(all.len(), 1, "one run, one row: {all:?}");
    let r = &all[0];
    assert_eq!(r["kind"], "suggestion");
    assert_eq!(r["business_id"], client.as_str());
    assert_eq!(r["user_id"], sam_id.as_str());
    assert_eq!(r["plan"], "free");
    assert_eq!(r["is_overseer"], 0);
    assert!(r["acting_as"].is_null());
    assert_eq!(r["outcome"], "ok");
    assert_eq!(r["model"], "fake-model");
    assert_eq!(r["model_calls"], calls);
    assert_eq!(r["input_tokens"], 120 * calls);
    assert_eq!(r["output_tokens"], 30 * calls);
    assert_eq!(
        r["cost_micro_usd"],
        270 * calls,
        "priced once, on the summed usage"
    );
    assert!(r["latency_ms"].is_i64() || r["latency_ms"].is_u64());
    assert_eq!(r["lines_asked"], asked);
    assert_eq!(r["by_model"], made);
    let n = |k: &str| r[k].as_u64().unwrap();
    assert!(n("by_merchants") >= 1, "{r}");
    assert!(n("lines_total") >= n("by_rules") + n("by_history") + n("by_merchants") + asked);

    // An explanation.
    let card = first_card(&s, &sam, &client).await;
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let all = rows(&s).await;
    assert_eq!(all.len(), 2);
    let r = &all[1];
    assert_eq!(r["kind"], "explain");
    assert_eq!(r["user_id"], sam_id.as_str());
    assert_eq!(r["outcome"], "ok");
    assert_eq!(r["model_calls"], 1);
    assert_eq!(r["input_tokens"], 120);
    assert_eq!(r["cost_micro_usd"], 270);
    for layer in [
        "lines_total",
        "by_rules",
        "by_history",
        "by_merchants",
        "lines_asked",
        "by_model",
    ] {
        assert!(r[layer].is_null(), "an explanation has no {layer}");
    }

    // A run with nothing to send: free, so no model, and still one row for the AI share.
    let before = model.seen().len();
    let (status, run) = suggest(&s, &sam, &empty).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(run["asked"], 0);
    assert_eq!(model.seen().len(), before);
    let all = rows(&s).await;
    assert_eq!(all.len(), 3);
    let r = &all[2];
    assert_eq!(r["kind"], "suggestion");
    assert_eq!(r["outcome"], "ok");
    assert!(r["model"].is_null() && r["latency_ms"].is_null());
    assert_eq!(r["model_calls"], 0);
    assert_eq!(
        (&r["input_tokens"], &r["cost_micro_usd"]),
        (&json!(0), &json!(0))
    );
    assert_eq!(r["lines_total"], 0);
    assert_eq!(r["lines_asked"], 0);
    assert_eq!(r["by_model"], 0);

    // An ask that fails is recorded as an error, and a call that failed used nothing.
    install(
        &mut s,
        Metered::new(Arc::new(FakeSuggester::failing("fake-model"))).with_prices(Some(CHEAP)),
        Quota::default(),
        ExplainLimits::default(),
    );
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "ai_failed");
    let (status, run) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert!(run["failed_batches"].as_u64().unwrap() > 0);
    let all = rows(&s).await;
    assert_eq!(all.len(), 5);
    for r in &all[3..] {
        assert_eq!(r["outcome"], "error");
        assert_eq!(r["input_tokens"], 0);
        assert_eq!(r["cost_micro_usd"], 0);
        assert!(r["model_calls"].as_u64().unwrap() >= 1);
    }
    assert_eq!(all[4]["by_model"], 0);
}

#[tokio::test]
async fn nothing_that_could_be_read_back_is_stored() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    install(
        &mut s,
        Metered::new(fake()).with_prices(Some(CHEAP)),
        Quota::default(),
        ExplainLimits::default(),
    );
    let last_seq: i64 = {
        let mut conn = s.state.store.reader().await.unwrap();
        sqlx::query_scalar("SELECT MAX(seq) FROM command_log")
            .fetch_one(&mut *conn)
            .await
            .unwrap()
    };

    let (status, run) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let card = first_card(&s, &sam, &client).await;
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let explanation = body["text"].as_str().unwrap().to_owned();

    // Asking logged only what `record_suggestions` is: no row for an ask, none for an explanation.
    let (new_kinds, new_text): (Vec<String>, String) = {
        let mut conn = s.state.store.reader().await.unwrap();
        let kinds = sqlx::query_scalar("SELECT kind FROM command_log WHERE seq > ?")
            .bind(last_seq)
            .fetch_all(&mut *conn)
            .await
            .unwrap();
        let text = sqlx::query_scalar(
            "SELECT COALESCE(group_concat(payload || result, ' '), '') FROM command_log WHERE seq > ?",
        )
        .bind(last_seq)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        (kinds, text)
    };
    assert!(
        new_kinds.iter().all(|k| k == "record_suggestions"),
        "{new_kinds:?}"
    );

    // What must never be found: a bank description, the card's wording, the explanation's text.
    let descriptions: Vec<String> = {
        let mut conn = s.state.store.reader().await.unwrap();
        sqlx::query_scalar("SELECT description FROM bank_lines")
            .fetch_all(&mut *conn)
            .await
            .unwrap()
    };
    assert!(descriptions.len() > 10);
    let mut secrets: Vec<&str> = descriptions.iter().map(String::as_str).collect();
    secrets.extend([
        "What was this",
        "Until sorted",
        "test explanation",
        &explanation,
    ]);
    let usage = serde_json::to_string(&rows(&s).await).unwrap();
    let usage_columns: String = {
        let mut conn = s.state.store.reader().await.unwrap();
        let names: Vec<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('ai_usage')")
                .fetch_all(&mut *conn)
                .await
                .unwrap();
        names.join(" ")
    };
    for secret in secrets {
        assert!(!usage.contains(secret), "{secret:?} is in ai_usage");
        assert!(!new_text.contains(secret), "{secret:?} is in command_log");
    }
    // And the table has no column that could hold any of it.
    for column in [
        "prompt",
        "response",
        "description",
        "text",
        "name",
        "address",
        "ip",
        "error",
    ] {
        assert!(
            !usage_columns.split(' ').any(|c| c == column),
            "ai_usage has a {column} column"
        );
    }
}

#[tokio::test]
async fn the_daily_limits_survive_a_restart_and_the_next_ask_is_refused() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    let model = fake();
    let (quota, limits) = standard();
    install(&mut s, Metered::new(model.clone()), quota, limits);

    // One suggestions run a day on the standard table, and then the limit.
    let (status, run) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(view(&s, &sam, &client).await["remaining_today"], 0);
    // Five explanations a day.
    let card = first_card(&s, &sam, &client).await;
    for _ in 0..5 {
        assert_eq!(explain(&s, &sam, &client, &card).await.0, StatusCode::OK);
    }
    assert_eq!(rows(&s).await.len(), 6);

    // A restart: a new process, with the same database and nothing in memory.
    let mut s = s.restart().await;
    let model = fake();
    let (quota, limits) = standard();
    install(&mut s, Metered::new(model.clone()), quota, limits);
    let sam = s.login("sam").await;

    assert_eq!(view(&s, &sam, &client).await["remaining_today"], 0);
    let (status, body) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "ai_daily_limit");
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "ai_daily_limit");
    assert!(
        model.seen().is_empty() && model.explained().is_empty(),
        "a refused ask never reaches the model"
    );

    // The refusals are rows too, and say so.
    let all = rows(&s).await;
    assert_eq!(all.len(), 8);
    assert_eq!(&outcomes(&all)[6..], ["refused_limit", "refused_limit"]);
    for r in &all[6..] {
        assert!(r["model"].is_null() && r["model_calls"] == 0 && r["input_tokens"] == 0);
        assert_eq!(r["user_id"], user_id(&s, &sam).await.as_str());
    }
    // A refused suggestions run still records what layers 1 to 3 did, and the model did nothing.
    assert!(all[6]["lines_total"].as_u64().unwrap() > 0);
    assert_eq!(all[6]["by_model"], 0);
    // Refusals don't spend the allowance: they weren't counted, so tomorrow isn't shortened.
    assert_eq!(all.len() - 2, 6);
}

#[tokio::test]
async fn limits_come_from_the_plan_table() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    let model = fake();
    // Everyone is on the Free plan until billing records plans, so the Free cell decides. A
    // different number in another plan's cell changes nothing for them.
    let table = LimitTable::standard()
        .with(Plan::Free, AiKind::Explain, Some(3))
        .with(Plan::Owner, AiKind::Explain, Some(1))
        .with(Plan::Practice, AiKind::Explain, Some(1))
        .with(Plan::Free, AiKind::Suggestion, Some(2));
    install(
        &mut s,
        Metered::new(model.clone()),
        Quota::new(table.clone()),
        ExplainLimits::new(table, None, None),
    );
    let card = first_card(&s, &sam, &client).await;
    for _ in 0..3 {
        assert_eq!(explain(&s, &sam, &client, &card).await.0, StatusCode::OK);
    }
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(
        (status, &body["code"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("ai_daily_limit"))
    );
    assert_eq!(
        model.explained().len(),
        3,
        "refused at the table's number, not before"
    );

    assert_eq!(view(&s, &sam, &client).await["daily_limit"], 2);
    assert_eq!(suggest(&s, &sam, &client).await.0, StatusCode::OK);
    assert_eq!(view(&s, &sam, &client).await["remaining_today"], 1);
    assert_eq!(suggest(&s, &sam, &client).await.0, StatusCode::OK);
    assert_eq!(suggest(&s, &sam, &client).await.1["code"], "ai_daily_limit");

    // The global cap counts every business's explanations, from the same rows.
    let other = business(&s, &boss, "Quiet Pines", true).await;
    let cap = acct_server::ai::GlobalCap {
        base: 4,
        per_guest: 0,
    };
    s.state.explain_quota = Arc::new(ExplainLimits::new(LimitTable::unlimited(), None, Some(cap)));
    let card = first_card(&s, &sam, &other).await;
    // Three explanations were made today already; the fourth fills the cap.
    assert_eq!(explain(&s, &sam, &other, &card).await.0, StatusCode::OK);
    assert_eq!(
        explain(&s, &sam, &other, &card).await.1["code"],
        "ai_daily_limit"
    );
}

#[tokio::test]
async fn the_budget_cap_refuses_model_calls_but_not_the_free_layers() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    let empty = business(&s, &boss, "Quiet Pines", false).await;
    let model = fake();
    // A 1-cent cap that the first model call overshoots.
    install(
        &mut s,
        Metered::new(model.clone())
            .with_prices(Some(DEAR))
            .with_daily_budget_cents(Some(1)),
        Quota::default(),
        ExplainLimits::default(),
    );
    ok(
        &s,
        &boss,
        serde_json::from_value(json!({
            "kind": "add_merchant",
            "payload": {
                "entity_type": "sole_trader",
                "description_contains": "GRIDLINE POWER",
                "coding": { "direction": "out", "kind": "expense", "account": "255", "gst": "standard" },
            },
        }))
        .unwrap(),
    )
    .await;
    let card = first_card(&s, &sam, &client).await;
    assert_eq!(explain(&s, &sam, &client, &card).await.0, StatusCode::OK);
    assert_eq!(rows(&s).await[0]["cost_micro_usd"], 12_000);

    // Now every model call is refused, in plain words and without a cost.
    for (status, body) in [
        explain(&s, &sam, &client, &card).await,
        suggest(&s, &sam, &client).await,
    ] {
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["code"], "ai_budget");
        let message = body["message"].as_str().unwrap();
        assert!(message.contains("resting until tomorrow"), "{message}");
        assert!(
            !message.contains('$') && !message.contains("cent"),
            "{message}"
        );
    }
    assert_eq!(model.explained().len(), 1);
    assert!(model.seen().is_empty());
    let all = rows(&s).await;
    assert_eq!(outcomes(&all), ["ok", "refused_budget", "refused_budget"]);
    // The refused run still did layers 1 to 3.
    let refused = &all[2];
    assert!(refused["by_merchants"].as_u64().unwrap() >= 1, "{refused}");
    assert_eq!(refused["by_model"], 0);

    // The free layers carry on: the merchant list still pre-fills the card...
    let q = queue(&s, &sam, &client).await;
    assert!(
        q["cards"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["suggestion"]["source"] == "merchant"),
        "the merchant suggestion is gone"
    );
    // ...and a run with nothing to send isn't a model call, so it isn't refused.
    let (status, run) = suggest(&s, &sam, &empty).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(rows(&s).await[3]["outcome"], "ok");
}

#[tokio::test]
async fn a_budget_cap_with_unknown_prices_fails_closed() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    let model = fake();
    // "fake-model" is on no price list, and the cap is a whole $50.
    install(
        &mut s,
        Metered::new(model.clone()).with_daily_budget_cents(Some(5_000)),
        Quota::default(),
        ExplainLimits::default(),
    );
    let card = first_card(&s, &sam, &client).await;
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "ai_budget");
    assert!(model.explained().is_empty());
    assert_eq!(outcomes(&rows(&s).await), ["refused_budget"]);

    // Without a cap, unknown prices only mean unknown costs.
    install(
        &mut s,
        Metered::new(model.clone()),
        Quota::default(),
        ExplainLimits::default(),
    );
    assert_eq!(explain(&s, &sam, &client, &card).await.0, StatusCode::OK);
    let all = rows(&s).await;
    assert!(all[1]["cost_micro_usd"].is_null(), "{}", all[1]);
    assert_eq!(all[1]["input_tokens"], 120);
}

#[tokio::test]
async fn an_overseer_is_never_refused_and_is_recorded_as_one() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    add_overseer(&s, "olive").await;
    let olive = s.login("olive").await;
    let olive_id = user_id(&s, &olive).await;
    let sam_id = user_id(&s, &sam).await;
    let model = fake();
    let table = LimitTable::standard().with(Plan::Free, AiKind::Explain, Some(1));
    install(
        &mut s,
        Metered::new(model.clone()).with_prices(Some(DEAR)),
        Quota::new(table.clone()),
        ExplainLimits::new(table, None, None),
    );
    let card = first_card(&s, &sam, &client).await;

    // Past the one-a-day limits, twice over, and no limit is shown to them.
    for _ in 0..2 {
        assert_eq!(suggest(&s, &olive, &client).await.0, StatusCode::OK);
        assert_eq!(explain(&s, &olive, &client, &card).await.0, StatusCode::OK);
    }
    let v = view(&s, &olive, &client).await;
    assert!(
        v["daily_limit"].is_null() && v["remaining_today"].is_null(),
        "{v}"
    );
    let all = rows(&s).await;
    assert_eq!(all.len(), 4);
    for r in &all {
        assert_eq!(r["is_overseer"], 1);
        assert_eq!(r["user_id"], olive_id.as_str());
        assert!(r["acting_as"].is_null());
        assert_ne!(r["outcome"], "refused_limit");
    }

    // Their asks didn't use up the business's allowance: Sam still has a whole day.
    assert_eq!(view(&s, &sam, &client).await["remaining_today"], 1);
    assert_eq!(suggest(&s, &sam, &client).await.0, StatusCode::OK);
    assert_eq!(explain(&s, &sam, &client, &card).await.0, StatusCode::OK);
    assert_eq!(
        explain(&s, &sam, &client, &card).await.1["code"],
        "ai_daily_limit"
    );
    assert_eq!(rows(&s).await.last().unwrap()["is_overseer"], 0);

    // The budget cap doesn't refuse them either, though their calls count towards it.
    s.state.suggester = Some(Arc::new(
        Metered::new(model.clone())
            .with_prices(Some(DEAR))
            .with_daily_budget_cents(Some(1)),
    ));
    s.state.explain_quota = Arc::new(ExplainLimits::default());
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(
        (status, &body["code"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("ai_budget"))
    );
    let before = model.explained().len();
    assert_eq!(explain(&s, &olive, &client, &card).await.0, StatusCode::OK);
    assert_eq!(model.explained().len(), before + 1);

    // Viewing as Sam, with Allow changes off: asking works, and it's recorded as Olive's,
    // acting as Sam.
    s.ok(
        &olive,
        "start_impersonation",
        json!({ "user_id": sam_id, "reason": "They asked for help" }),
    )
    .await;
    let (status, run) = suggest(&s, &olive, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert_eq!(explain(&s, &olive, &client, &card).await.0, StatusCode::OK);
    let all = rows(&s).await;
    for r in &all[all.len() - 2..] {
        assert_eq!(r["is_overseer"], 1);
        assert_eq!(r["user_id"], olive_id.as_str());
        assert_eq!(r["acting_as"], sam_id.as_str());
        assert_ne!(r["outcome"], "refused_budget");
    }

    // Accepting a pre-fill is a change, so it still needs Allow changes.
    let q = queue(&s, &olive, &client).await;
    let ai = q["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["suggestion"]["source"] == "ai")
        .expect("the run made a pre-fill");
    let body = json!({
        "id": new_id(),
        "kind": "code_bank_line",
        "payload": { "bank_line_id": ai["lines"][0]["bank_line_id"], "coding": ai["suggestion"]["coding"] },
        "via": { "kind": "suggestion", "model": "fake-model", "suggestion_ids": [ai["suggestion"]["id"]] },
    });
    let (status, reply) = split(
        s.send(post_json("/api/commands", Some(&olive), &body))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{reply}");
    assert_eq!(reply["code"], "impersonating");

    // A business's own off switch still applies to an overseer (ADR 016, D4): no ask, no row.
    let sam_cookie = s.login("sam").await;
    let (status, body) = s
        .command(
            &sam_cookie,
            "set_ai_suggestions",
            json!({ "client_id": client, "enabled": false }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let rows_before = rows(&s).await.len();
    let (status, body) = suggest(&s, &olive, &client).await;
    assert_eq!(
        (status, &body["code"]),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            &json!("ai_suggestions_off")
        )
    );
    assert_eq!(
        explain(&s, &olive, &client, &card).await.1["code"],
        "ai_suggestions_off"
    );
    assert_eq!(rows(&s).await.len(), rows_before);
}

#[tokio::test]
async fn the_allowance_belongs_to_the_business_not_the_person() {
    // A viewer can't ask at all; a practice admin and staff share the business's one a day.
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    let val = s.login("val").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    let (quota, limits) = standard();
    install(&mut s, Metered::new(fake()), quota, limits);
    assert_eq!(suggest(&s, &val, &client).await.0, StatusCode::FORBIDDEN);
    assert!(rows(&s).await.is_empty(), "a refused request isn't an ask");
    assert_eq!(suggest(&s, &boss, &client).await.0, StatusCode::OK);
    // The allowance is the business's, not the person's.
    assert_eq!(suggest(&s, &sam, &client).await.1["code"], "ai_daily_limit");
}

#[test]
fn only_the_metered_wrapper_can_reach_a_model() {
    // Nothing in the server but `ai_usage.rs` (and the bake-off in `main.rs`) may name the raw
    // trait or call it. The types stop a value being used; this stops one being threaded back in.
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut checked = 0;
    for entry in std::fs::read_dir(&src).unwrap() {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if !name.ends_with(".rs") || name == "ai_usage.rs" || name == "main.rs" {
            continue;
        }
        checked += 1;
        let text = std::fs::read_to_string(&path).unwrap();
        for forbidden in ["Suggester", ".suggest(", ".explain("] {
            assert!(
                !text.contains(forbidden),
                "{name} mentions {forbidden:?}: go through ai_usage::Metered"
            );
        }
    }
    assert!(checked > 20);
}

#[tokio::test]
async fn a_run_whose_every_answer_is_dropped_is_invalid() {
    use acct_ai::{Confidence, FakeAnswer};
    use acct_core::GstCode;
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles", true).await;
    // The model answers, but only ever with low confidence, which never pre-fills a card.
    let model = Arc::new(FakeSuggester::new(
        "fake-model",
        vec![FakeAnswer::new(
            "GRIDLINE POWER",
            "255",
            GstCode::Standard,
            Confidence::Low,
        )],
    ));
    install(
        &mut s,
        Metered::new(model),
        Quota::default(),
        ExplainLimits::default(),
    );
    let (status, run) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    assert!(run["suggestions"].as_array().unwrap().is_empty());
    let all = rows(&s).await;
    assert_eq!(outcomes(&all), ["invalid"]);
    assert_eq!(all[0]["by_model"], 0);
}
