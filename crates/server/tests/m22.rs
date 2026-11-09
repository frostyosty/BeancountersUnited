//! M22 is done (ADR 016): `m22_is_done` walks the milestone's "Done when" list, one bullet at a time,
//! over HTTP with the fake suggester. No network. The detail of each bullet has its own tests in
//! `ai_usage.rs` and `ai_watch.rs`; this one proves they hold together in one server.

mod common;

use std::sync::Arc;

use acct_ai::FakeSuggester;
use acct_ai::eval::Prices;
use acct_core::tax::gst::GstFrequency;
use acct_core::{Account, Mapping, Template};
use acct_server::ai::{ExplainLimits, Quota};
use acct_server::ai_limits::{LimitTable, Plan};
use acct_server::ai_usage::Metered;
use acct_server::ai_watch::{AiKind, AiUsageView, SpikeRule};
use acct_server::business::{GstBasis, GstSetup};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_store::ai_usage::UsageRow;
use acct_store::sqlx;
use acct_store::users::Role;
use axum::http::{StatusCode, header};
use chrono::{Duration, NaiveDate, NaiveTime, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const STATEMENT: (&str, &[u8]) = (
    "harbourlight-cheque-2025-08.ofx",
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx"),
);
const PATH: &str = "/api/overseer/ai-usage";

/// $1 per million input tokens and $5 per million output tokens (the fake's call costs 270).
const CHEAP: Prices = Prices {
    input: 1_000_000,
    output: 5_000_000,
    cache_read: 0,
    cache_write: 0,
};
/// $100 per million input tokens: one fake call costs 12,000 micro-dollars, over a 1-cent cap.
const DEAR: Prices = Prices {
    input: 100_000_000,
    output: 0,
    cache_read: 0,
    cache_write: 0,
};

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

async fn ok(s: &Server, cookie: &str, command: Command) -> String {
    let kind = command.kind().to_owned();
    let mut v = serde_json::to_value(command).unwrap();
    s.ok(cookie, &kind, v["payload"].take()).await
}

/// The practice's sole trader defaults.
async fn defaults(s: &Server, boss: &str) {
    let accounts: Vec<Account> = serde_json::from_str(CHART).unwrap();
    let template: Template = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    let chart = Command::CreateMasterChart {
        entity_type: "sole_trader".into(),
        name: "Sole trader".into(),
        accounts,
    };
    ok(s, boss, chart).await;
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
    let mapping = Command::CreateMapping {
        template_id,
        name: "Sole trader".into(),
        body: mapping,
    };
    ok(s, boss, mapping).await;
}

/// A sole trader business with one statement uploaded.
async fn business(s: &Server, boss: &str, name: &str) -> String {
    let start = NaiveDate::from_ymd_opt(2025, 8, 1).unwrap();
    let client = ok(
        s,
        boss,
        Command::SetUpBusiness {
            name: name.into(),
            start_date: start,
            gst: Some(GstSetup {
                registered_from: start,
                frequency: GstFrequency::TwoMonthlyOdd,
                basis: GstBasis::Payments,
            }),
        },
    )
    .await;
    let import = Command::ImportStatement {
        client_id: client.clone(),
        file_name: STATEMENT.0.into(),
        content_base64: base64(STATEMENT.1),
        bank_account_id: None,
    };
    ok(s, boss, import).await;
    client
}

async fn overseer(s: &Server, username: &str) -> String {
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
    s.login(username).await
}

fn install(s: &mut Server, metered: Metered, table: Option<LimitTable>) {
    s.state.suggester = Some(Arc::new(metered));
    let table = table.unwrap_or_else(LimitTable::unlimited);
    s.state.ai_quota = Arc::new(Quota::new(table.clone()));
    s.state.explain_quota = Arc::new(ExplainLimits::new(table, None, None));
}

fn fake() -> Arc<FakeSuggester> {
    Arc::new(FakeSuggester::with_defaults("fake-model"))
}

async fn ask(
    s: &Server,
    cookie: &str,
    client: &str,
    what: &str,
    body: &Value,
) -> (StatusCode, Value) {
    let uri = format!("/api/businesses/{client}/{what}");
    split(s.send(post_json(&uri, Some(cookie), body)).await).await
}

async fn suggest(s: &Server, cookie: &str, client: &str) -> (StatusCode, Value) {
    ask(s, cookie, client, "ai-suggestions", &json!({})).await
}

async fn explain(s: &Server, cookie: &str, client: &str, card: &str) -> (StatusCode, Value) {
    ask(s, cookie, client, "explain", &json!({ "card_id": card })).await
}

async fn first_card(s: &Server, cookie: &str, client: &str) -> String {
    let q = s
        .get_json(&format!("/api/businesses/{client}/save-tax"), cookie)
        .await;
    q["cards"][0]["id"].as_str().unwrap().to_owned()
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
            'plan', plan, 'is_overseer', is_overseer, 'acting_as', acting_as,
            'model_calls', model_calls, 'outcome', outcome, 'lines_total', lines_total,
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

async fn view(s: &Server, cookie: &str) -> AiUsageView {
    let (status, body) = split(s.send(get(PATH, Some(cookie))).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_value(body).unwrap()
}

/// An ask for `business` at `at`, which cost 300 micro-dollars.
fn usage_row(at: chrono::DateTime<Utc>, business: &str) -> UsageRow {
    UsageRow {
        id: new_id(),
        at,
        kind: "explain".into(),
        business_id: business.into(),
        user_id: None,
        plan: "free".into(),
        is_overseer: false,
        acting_as: None,
        model: Some("fake-model".into()),
        model_calls: 1,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        cost_micro_usd: Some(300),
        latency_ms: Some(40),
        outcome: "ok".into(),
        lines_total: None,
        by_rules: None,
        by_history: None,
        by_merchants: None,
        lines_asked: None,
        by_model: None,
    }
}

async fn record(s: &Server, rows: &[UsageRow]) {
    for r in rows {
        acct_store::ai_usage::insert(&s.state.store, r)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn m22_is_done() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles").await;
    let sam_id = user_id(&s, &sam).await;
    let model = fake();
    let one_a_day = LimitTable::standard();

    // 1. Every ask writes exactly one row, with the right fields, and keeps no content.
    install(
        &mut s,
        Metered::new(model.clone()).with_prices(Some(CHEAP)),
        Some(one_a_day.clone()),
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
    let all = rows(&s).await;
    assert_eq!(all.len(), 2, "{all:?}");
    for (r, kind) in all.iter().zip(["suggestion", "explain"]) {
        assert_eq!(r["kind"], kind);
        assert_eq!(r["business_id"], client.as_str());
        assert_eq!(r["user_id"], sam_id.as_str());
        assert_eq!(r["plan"], "free");
        assert_eq!(
            (&r["is_overseer"], &r["outcome"]),
            (&json!(0), &json!("ok"))
        );
        assert!(r["acting_as"].is_null());
    }
    assert!(
        all[0]["lines_total"].as_u64().unwrap() > 0 && all[0]["by_model"].as_u64().unwrap() > 0
    );
    assert!(
        all[1]["lines_total"].is_null(),
        "an explanation has no layers"
    );
    let (kinds, logged, descriptions): (Vec<String>, String, Vec<String>) = {
        let mut conn = s.state.store.reader().await.unwrap();
        let kinds = sqlx::query_scalar("SELECT kind FROM command_log WHERE seq > ?")
            .bind(last_seq)
            .fetch_all(&mut *conn)
            .await
            .unwrap();
        let logged = sqlx::query_scalar(
            "SELECT COALESCE(group_concat(payload || result, ' '), '') FROM command_log WHERE seq > ?",
        )
        .bind(last_seq)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
        let descriptions = sqlx::query_scalar("SELECT description FROM bank_lines")
            .fetch_all(&mut *conn)
            .await
            .unwrap();
        (kinds, logged, descriptions)
    };
    assert!(kinds.iter().all(|k| k == "record_suggestions"), "{kinds:?}");
    assert!(descriptions.len() > 5);
    let usage = serde_json::to_string(&all).unwrap();
    let mut secrets: Vec<&str> = descriptions.iter().map(String::as_str).collect();
    secrets.extend(["What was this", explanation.as_str()]);
    for secret in secrets {
        assert!(!usage.contains(secret), "{secret:?} is in ai_usage");
        assert!(!logged.contains(secret), "{secret:?} is in command_log");
    }

    // 2. Both daily limits survive a restart, and the next ask is `refused_limit`.
    for _ in 0..4 {
        assert_eq!(explain(&s, &sam, &client, &card).await.0, StatusCode::OK);
    }
    let mut s = s.restart().await;
    install(&mut s, Metered::new(fake()), Some(one_a_day.clone()));
    let sam = s.login("sam").await;
    for (status, body) in [
        suggest(&s, &sam, &client).await,
        explain(&s, &sam, &client, &card).await,
    ] {
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["code"], "ai_daily_limit");
    }
    let all = rows(&s).await;
    assert_eq!(all.len(), 8);
    assert!(all[6..].iter().all(|r| r["outcome"] == "refused_limit"));

    // 3. Limits come from the plan table: a different number is refused at that number.
    let mut s = s;
    let table = LimitTable::standard().with(Plan::Free, AiKind::Explain, Some(7));
    install(&mut s, Metered::new(fake()), Some(table));
    let sam = s.login("sam").await;
    assert_eq!(
        explain(&s, &sam, &client, &card).await.0,
        StatusCode::OK,
        "6th of 7"
    );
    assert_eq!(
        explain(&s, &sam, &client, &card).await.0,
        StatusCode::OK,
        "7th of 7"
    );
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(
        (status, &body["code"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("ai_daily_limit"))
    );

    // 4. The budget cap refuses model calls, not layers 1 to 3.
    let capped = fake();
    install(
        &mut s,
        Metered::new(capped.clone())
            .with_prices(Some(DEAR))
            .with_daily_budget_cents(Some(1)),
        None,
    );
    let other = business(&s, &boss, "Quiet Pines").await;
    let other_card = first_card(&s, &sam, &other).await;
    assert_eq!(
        explain(&s, &sam, &other, &other_card).await.0,
        StatusCode::OK
    );
    let (status, body) = explain(&s, &sam, &other, &other_card).await;
    assert_eq!(
        (status, &body["code"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("ai_budget"))
    );
    let (status, body) = suggest(&s, &sam, &other).await;
    assert_eq!(
        (status, &body["code"]),
        (StatusCode::UNPROCESSABLE_ENTITY, &json!("ai_budget"))
    );
    assert_eq!(capped.explained().len(), 1);
    assert!(
        capped.seen().is_empty(),
        "a refused run never reaches the model"
    );
    let refused = rows(&s).await.pop().unwrap();
    assert_eq!(refused["outcome"], "refused_budget");
    assert!(
        refused["lines_total"].as_u64().unwrap() > 0 && refused["by_model"] == 0,
        "layers 1 to 3 still ran: {refused}"
    );
    let queue = s
        .get_json(&format!("/api/businesses/{other}/save-tax"), &sam)
        .await;
    assert!(
        !queue["cards"].as_array().unwrap().is_empty(),
        "the queue still works"
    );

    // 5. An overseer is never refused, is recorded as one, and has `acting_as` when viewing as.
    let olive = overseer(&s, "olive").await;
    let olive_id = user_id(&s, &olive).await;
    let before = rows(&s).await.len();
    assert_eq!(
        explain(&s, &olive, &other, &other_card).await.0,
        StatusCode::OK
    );
    s.ok(
        &olive,
        "start_impersonation",
        json!({ "user_id": sam_id, "reason": "They asked for help" }),
    )
    .await;
    assert_eq!(suggest(&s, &olive, &other).await.0, StatusCode::OK);
    let all = rows(&s).await;
    assert_eq!(all.len(), before + 2);
    let (plain, acting) = (&all[before], &all[before + 1]);
    for r in [plain, acting] {
        assert_eq!(
            (&r["is_overseer"], &r["user_id"]),
            (&json!(1), &json!(olive_id))
        );
        assert!(!r["outcome"].as_str().unwrap().starts_with("refused"));
    }
    assert!(plain["acting_as"].is_null());
    assert_eq!(acting["acting_as"], sam_id.as_str());
    s.ok(&olive, "end_impersonation", json!({})).await;

    // 6. The AI-share figures match a pinned set of codings: 4 codings, 3 via a pre-fill.
    install(&mut s, Metered::new(fake()).with_prices(Some(CHEAP)), None);
    let third = business(&s, &boss, "Wren Joinery").await;
    let (status, run) = suggest(&s, &sam, &third).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let q = s
        .get_json(&format!("/api/businesses/{third}/save-tax"), &sam)
        .await;
    let ai: Vec<&Value> = q["cards"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["suggestion"]["source"] == "ai" && c["lines"].as_array().unwrap().len() == 1)
        .collect();
    assert!(
        ai.len() >= 4,
        "the fake pre-fills four single-line cards: {q}"
    );
    let line = |c: &Value| c["lines"][0]["bank_line_id"].clone();
    let via = |cs: &[&Value]| {
        let ids: Vec<&Value> = cs.iter().map(|c| &c["suggestion"]["id"]).collect();
        json!({ "kind": "suggestion", "model": "fake-model", "suggestion_ids": ids })
    };
    let send = |kind: &str, payload: Value, via: Option<Value>| {
        let mut body = json!({ "id": new_id(), "kind": kind, "payload": payload });
        if let Some(v) = via {
            body["via"] = v;
        }
        post_json("/api/commands", Some(&sam), &body)
    };
    let one = |c: &Value| json!({ "bank_line_id": line(c), "coding": c["suggestion"]["coding"] });
    for (c, with_via) in [(ai[0], true), (ai[1], false)] {
        let v = with_via.then(|| via(&[c]));
        let (status, body) = split(s.send(send("code_bank_line", one(c), v)).await).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let both = json!({ "lines": [one(ai[2]), one(ai[3])] });
    let (status, body) = split(
        s.send(send("code_bank_lines", both, Some(via(&[ai[2], ai[3]]))))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let v = view(&s, &olive).await;
    let week = v.share.iter().find(|w| w.codings > 0).expect("this week");
    assert_eq!((week.codings, week.via_suggestion), (4, 3));
    assert_eq!(week.share_bp, Some(7_500));

    // 7. Flags: 3x the median and over the floor flags; under the floor doesn't; invalid rises flag.
    let midnight = Utc::now().date_naive().and_time(NaiveTime::MIN).and_utc();
    let history = |business: &str, per_day: u32, today: u32| {
        let mut out = Vec::new();
        for days_ago in 1..=7 {
            let noon = midnight - Duration::days(days_ago) + Duration::hours(12);
            out.extend(
                (0..per_day).map(|i| usage_row(noon + Duration::seconds(i64::from(i)), business)),
            );
        }
        out.extend((0..today).map(|_| usage_row(Utc::now(), business)));
        out
    };
    let (hammered, quiet) = (new_id(), new_id());
    record(&s, &history(&hammered, 4, 13)).await;
    record(&s, &history(&quiet, 1, 4)).await;
    let v = view(&s, &olive).await;
    let flagged: Vec<&str> = v
        .flags
        .iter()
        .filter(|f| f.rule == SpikeRule::Business)
        .filter_map(|f| f.subject_id.as_deref())
        .collect();
    // (Marsh Hollow's own 11 asks today, with no history, are over the floor, so it flags too.)
    assert!(flagged.contains(&hammered.as_str()), "{:?}", v.flags);
    assert!(!flagged.contains(&quiet.as_str()), "{:?}", v.flags);
    assert_eq!(v.flag_count as usize, v.flags.len());
    // A rise in `invalid`: sixty unusable answers today, against the ~40 fine ones above.
    let mut bad: Vec<UsageRow> = (0..60).map(|_| usage_row(Utc::now(), &new_id())).collect();
    bad.iter_mut().for_each(|r| r.outcome = "invalid".into());
    record(&s, &bad).await;
    let v = view(&s, &olive).await;
    assert!(
        v.flags.iter().any(|f| f.rule == SpikeRule::ErrorShare),
        "{:?}",
        v.flags
    );

    // 8. Everyone but an overseer is refused the read: admins, staff, viewers, owners and guests.
    let val = s.login("val").await;
    let signup = s
        .send(post_json(
            "/api/signup",
            None,
            &json!({
                "id": new_id(), "email": "ana@example.nz", "display_name": "Ana",
                "password": PASSWORD, "business_name": "Ana's Gardens", "start_date": "2025-04-01",
            }),
        ))
        .await;
    assert_eq!(signup.status(), StatusCode::OK, "sign-up");
    let guest = s
        .send(post_json(
            "/api/guest",
            None,
            &json!({ "id": new_id(), "source": { "example": 1 } }),
        ))
        .await;
    assert_eq!(guest.status(), StatusCode::OK, "a guest starts");
    let session = |r: &axum::http::Response<axum::body::Body>| {
        r.headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok()?.split(';').next())
            .find(|c| c.starts_with("acct_session=") && c.len() > "acct_session=".len())
            .expect("a session cookie")
            .to_owned()
    };
    let (ana, guest) = (session(&signup), session(&guest));
    for (who, cookie) in [
        ("a practice admin", &boss),
        ("staff", &sam),
        ("a viewer", &val),
        ("an owner", &ana),
        ("a guest", &guest),
    ] {
        let (status, body) = split(s.send(get(PATH, Some(cookie))).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}: {body}");
    }
}
