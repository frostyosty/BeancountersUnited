//! M22 (ADR 016, 7, 9 and 10): the overseer's view of AI use, `GET /api/overseer/ai-usage`.
//! Only overseers read it, as themselves; the AI share is read from real codings made through
//! commands; and the spike flags fire on the thresholds. Over HTTP with the fake suggester; no
//! network. (The thresholds have their own unit tests in `src/ai_watch.rs`.)

mod common;

use std::sync::Arc;

use acct_ai::FakeSuggester;
use acct_ai::eval::Prices;
use acct_core::tax::gst::GstFrequency;
use acct_core::{Account, Mapping, Template};
use acct_server::ai::{ExplainLimits, Quota};
use acct_server::ai_limits::{LimitTable, Plan};
use acct_server::ai_usage::Metered;
use acct_server::ai_watch::{AiKind, AiOutcome, AiUsageView, AskSubject, SpikeRule};
use acct_server::business::{GstBasis, GstSetup};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_store::ai_usage::UsageRow;
use acct_store::users::Role;
use axum::http::{StatusCode, header};
use chrono::{DateTime, Duration, NaiveDate, NaiveTime, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
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
const PATH: &str = "/api/overseer/ai-usage";

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

/// A sole trader business, with the three statements uploaded and nothing sorted.
async fn business(s: &Server, boss: &str, name: &str) -> String {
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
    client
}

/// An overseer, made the only way there is: by the server, through the pipeline.
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
                "username": username, "display_name": "Olive Overseer",
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

async fn user_id(s: &Server, cookie: &str) -> String {
    s.get_json("/api/me", cookie).await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// The cookie a response sets for the session.
fn session(response: &axum::http::Response<axum::body::Body>) -> String {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next())
        .find(|c| c.starts_with("acct_session=") && c.len() > "acct_session=".len())
        .expect("the response sets the session cookie")
        .to_owned()
}

fn install(s: &mut Server, metered: Metered) {
    s.state.suggester = Some(Arc::new(metered));
    s.state.ai_quota = Arc::new(Quota::new(LimitTable::standard()));
    s.state.explain_quota = Arc::new(ExplainLimits::new(LimitTable::standard(), None, None));
}

fn fake() -> Arc<FakeSuggester> {
    Arc::new(FakeSuggester::with_defaults("fake-model"))
}

/// $1 per million input tokens and $5 per million output tokens.
const CHEAP: Prices = Prices {
    input: 1_000_000,
    output: 5_000_000,
    cache_read: 0,
    cache_write: 0,
};

async fn read(s: &Server, cookie: &str, query: &str) -> (StatusCode, Value) {
    split(s.send(get(&format!("{PATH}{query}"), Some(cookie))).await).await
}

/// The view, which must be there.
async fn view(s: &Server, cookie: &str, query: &str) -> AiUsageView {
    let (status, body) = read(s, cookie, query).await;
    assert_eq!(status, StatusCode::OK, "{query}: {body}");
    serde_json::from_value(body).unwrap()
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

/// A row for `business`, an explanation that cost 300 micro-dollars, at `at`.
fn usage_row(at: DateTime<Utc>, business: &str) -> UsageRow {
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

/// Writes rows the way the metered path does, so a test can set the time and the outcome.
async fn record(s: &Server, rows: &[UsageRow]) {
    for r in rows {
        acct_store::ai_usage::insert(&s.state.store, r)
            .await
            .unwrap();
    }
}

/// `business` asked `per_day` times at noon on each of the 7 whole days before today, and `today`
/// times now.
async fn history(s: &Server, business: &str, per_day: u32, today: u32) {
    let midnight = Utc::now().date_naive().and_time(NaiveTime::MIN).and_utc();
    let mut rows = Vec::new();
    for days_ago in 1..=7 {
        let noon = midnight - Duration::days(days_ago) + Duration::hours(12);
        rows.extend(
            (0..per_day).map(|i| usage_row(noon + Duration::seconds(i64::from(i)), business)),
        );
    }
    rows.extend((0..today).map(|_| usage_row(Utc::now(), business)));
    record(s, &rows).await;
}

// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn only_overseers_read_ai_usage_and_only_as_themselves() {
    let s = Server::new().await;
    let boss = s.login("boss").await;
    s.ok(
        &boss,
        "install_starter_set",
        json!({ "set": "sole_trader" }),
    )
    .await;
    let sam = s.login("sam").await;
    let val = s.login("val").await;
    let signup = s
        .send(post_json(
            "/api/signup",
            None,
            &json!({
                "id": new_id(), "email": "ana@example.nz", "display_name": "Ana",
                "password": PASSWORD, "business_name": "Ana's Gardens",
                "start_date": "2025-04-01",
            }),
        ))
        .await;
    assert_eq!(signup.status(), StatusCode::OK, "sign-up");
    let ana = session(&signup);
    let guest = s
        .send(post_json(
            "/api/guest",
            None,
            &json!({ "id": new_id(), "source": { "example": 1 } }),
        ))
        .await;
    assert_eq!(guest.status(), StatusCode::OK, "a guest starts");
    let guest = session(&guest);
    let olive = overseer(&s, "olive").await;

    // The whole practice, an owner and a guest are refused; so is no one at all.
    for (who, cookie) in [
        ("a practice admin", &boss),
        ("staff", &sam),
        ("a viewer", &val),
        ("an owner", &ana),
        ("a guest", &guest),
    ] {
        let (status, body) = read(&s, cookie, "").await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}: {body}");
    }
    let (status, _) = split(s.send(get(PATH, None)).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // An overseer reads it, empty to begin with.
    let empty = view(&s, &olive, "").await;
    assert_eq!(empty.series.len(), 90);
    assert!(empty.flags.is_empty() && empty.top_businesses.is_empty() && empty.asks.is_none());
    assert_eq!(empty.flag_count, 0);
    assert!(empty.budget.is_none(), "no cap, no budget");
    assert_eq!(empty.share.len(), 26);
    assert!(
        empty.share.iter().all(|w| w.layers.is_none()),
        "nothing is measured yet"
    );
    assert_eq!(view(&s, &olive, "?by=hour").await.series.len(), 48);

    // The query is checked.
    for (query, why) in [
        ("?business=a&user=b", "both subjects"),
        ("?by=week", "an unknown series"),
        ("?business=a&from=yesterday", "a time that isn't RFC 3339"),
        (
            "?business=a&from=2026-11-11T00:00:00Z&to=2026-11-10T00:00:00Z",
            "a window backwards",
        ),
    ] {
        let (status, body) = read(&s, &olive, query).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{why}: {body}");
        assert_eq!(body["code"], "malformed", "{why}");
    }
    let (status, _) = read(&s, &olive, "?business=nobody").await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Viewing as someone, an overseer is that someone, so is refused too.
    let (status, body) = s
        .command(
            &olive,
            "start_impersonation",
            json!({ "user_id": user_id(&s, &ana).await, "reason": "Checking a report" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = read(&s, &olive, "").await;
    assert_eq!(status, StatusCode::FORBIDDEN, "viewing as: {body}");
}

#[tokio::test]
async fn the_view_reports_real_asks_by_business_and_by_person() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles").await;
    install(&mut s, Metered::new(fake()).with_prices(Some(CHEAP)));
    let sam_id = user_id(&s, &sam).await;
    let olive = overseer(&s, "olive").await;

    let (status, run) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let card = queue(&s, &sam, &client).await["cards"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let (status, body) = explain(&s, &sam, &client, &card).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let v = view(&s, &olive, "").await;
    assert!(v.prices_known && v.flags.is_empty() && v.flag_count == 0);
    let today = v.series.last().unwrap();
    assert_eq!(today.asks, 2);
    assert_eq!(
        today
            .by_kind
            .iter()
            .map(|k| (k.kind, k.asks))
            .collect::<Vec<_>>(),
        [(AiKind::Suggestion, 1), (AiKind::Explain, 1)]
    );
    assert_eq!(today.by_outcome.len(), 1);
    assert_eq!(
        (today.by_outcome[0].outcome, today.by_outcome[0].asks),
        (AiOutcome::Ok, 2)
    );
    assert_eq!(
        (today.by_plan[0].plan, today.by_plan[0].asks),
        (Plan::Free, 2)
    );
    assert!(today.cost_micro_usd > 0 && today.input_tokens > 0 && today.output_tokens > 0);
    assert_eq!(today.overseer_asks, 0);
    // The business and the person, named live.
    let top = &v.top_businesses[0];
    assert_eq!(
        (top.id.as_str(), top.name.as_str(), top.asks_today),
        (client.as_str(), "Marsh Hollow Candles", 2)
    );
    assert_eq!((top.median_7d, top.change_pct), (0, None));
    assert_eq!(
        (v.top_users[0].id.as_str(), v.top_users[0].name.as_str()),
        (sam_id.as_str(), "sam")
    );

    // The business's asks, newest first.
    let v = view(&s, &olive, &format!("?business={client}")).await;
    let list = v.asks.expect("a business's list");
    assert_eq!(list.subject, AskSubject::Business);
    assert_eq!(
        (list.id.as_str(), list.name.as_str()),
        (client.as_str(), "Marsh Hollow Candles")
    );
    assert!(!list.truncated);
    assert_eq!(
        list.rows
            .iter()
            .map(|r| (r.kind, r.outcome))
            .collect::<Vec<_>>(),
        [
            (AiKind::Explain, AiOutcome::Ok),
            (AiKind::Suggestion, AiOutcome::Ok)
        ]
    );
    let r = &list.rows[0];
    assert_eq!((r.plan, r.is_overseer), (Plan::Free, false));
    assert_eq!(
        (r.user_id.as_deref(), r.model.as_deref()),
        (Some(sam_id.as_str()), Some("fake-model"))
    );
    assert_eq!(r.cost_micro_usd, Some(270));
    assert!(r.lines_total.is_none(), "an explanation has no layers");
    assert!(
        list.rows[1].lines_total.is_some(),
        "a run has its layer counts"
    );

    // The same two, by the person.
    let v = view(&s, &olive, &format!("?user={sam_id}")).await;
    let list = v.asks.unwrap();
    assert_eq!(
        (list.subject, list.name.as_str(), list.rows.len()),
        (AskSubject::User, "sam", 2)
    );

    // A window that ends before they asked is empty, and the id is still known.
    let from = (Utc::now() - Duration::days(30)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let to = (Utc::now() - Duration::days(20)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let v = view(
        &s,
        &olive,
        &format!("?business={client}&from={from}&to={to}"),
    )
    .await;
    assert!(v.asks.unwrap().rows.is_empty());

    // Nothing the owner wrote or a bank said is in it: only counts, ids and names.
    let (_, body) = read(&s, &olive, &format!("?business={client}")).await;
    let text = body.to_string().to_uppercase();
    for secret in ["GRIDLINE", "HARBOURLIGHT", "KOWHAI", "99-1001"] {
        assert!(!text.contains(secret), "{secret} is in the overseer's view");
    }
}

#[tokio::test]
async fn the_ai_share_matches_a_pinned_set_of_codings() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    defaults(&s, &boss).await;
    let client = business(&s, &boss, "Marsh Hollow Candles").await;
    install(&mut s, Metered::new(fake()).with_prices(Some(CHEAP)));
    let olive = overseer(&s, "olive").await;

    // Before anything is coded, and before any run, nothing is measured.
    let v = view(&s, &olive, "").await;
    assert!(
        v.share
            .iter()
            .all(|w| w.codings == 0 && w.share_bp.is_none() && w.layers.is_none())
    );

    let (status, run) = suggest(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let q = queue(&s, &sam, &client).await;
    let ai: Vec<&Value> = q["cards"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["suggestion"]["source"] == "ai" && c["lines"].as_array().unwrap().len() == 1)
        .collect();
    assert!(
        ai.len() >= 4,
        "the fake pre-fills at least four single-line cards: {q}"
    );

    // Pinned: one pre-fill accepted as it was, one the owner changed (the same coding, sent
    // without `via`, as an edited pre-fill is), and two more accepted together in one
    // `code_bank_lines`. So 4 codings, 3 of them via a pre-fill: 7,500 basis points.
    let line = |c: &Value| c["lines"][0]["bank_line_id"].clone();
    let via = |c: &Value| json!({ "kind": "suggestion", "model": "fake-model", "suggestion_ids": [c["suggestion"]["id"]] });
    let send = |kind: &str, payload: Value, via: Option<Value>| {
        let mut body = json!({ "id": new_id(), "kind": kind, "payload": payload });
        if let Some(v) = via {
            body["via"] = v;
        }
        post_json("/api/commands", Some(&sam), &body)
    };
    let accepted = ai[0];
    let (status, body) = split(
        s.send(send(
            "code_bank_line",
            json!({ "bank_line_id": line(accepted), "coding": accepted["suggestion"]["coding"] }),
            Some(via(accepted)),
        ))
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let edited = ai[1];
    let (status, body) = split(
        s.send(send(
            "code_bank_line",
            json!({ "bank_line_id": line(edited), "coding": edited["suggestion"]["coding"] }),
            None,
        ))
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // A third and fourth, accepted together in one command: two codings, two pre-fills.
    {
        let (c, d) = (ai[2], ai[3]);
        let lines = json!([
            { "bank_line_id": line(c), "coding": c["suggestion"]["coding"] },
            { "bank_line_id": line(d), "coding": d["suggestion"]["coding"] },
        ]);
        let via = json!({
            "kind": "suggestion", "model": "fake-model",
            "suggestion_ids": [c["suggestion"]["id"], d["suggestion"]["id"]],
        });
        let (status, body) = split(
            s.send(send(
                "code_bank_lines",
                json!({ "lines": lines }),
                Some(via),
            ))
            .await,
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    let (codings, via_suggestion) = (4_u32, 3_u32);

    let v = view(&s, &olive, "").await;
    let coded: u32 = v.share.iter().map(|w| w.codings).sum();
    let accepted: u32 = v.share.iter().map(|w| w.via_suggestion).sum();
    assert_eq!(
        (coded, accepted),
        (codings, via_suggestion),
        "{:?}",
        v.share
    );
    let week = v
        .share
        .iter()
        .find(|w| w.codings > 0)
        .expect("this week has codings");
    assert_eq!(week.share_bp, Some(7_500));
    assert_eq!(
        week.iso_week.len(),
        8,
        "such as 2026-W46: {}",
        week.iso_week
    );

    // The layers, from the one run: what each answered, in basis points of the cards it saw.
    let l = week.layers.as_ref().expect("the run is measured");
    assert!(l.lines_total > 0);
    assert_eq!(
        l.rules_bp + l.history_bp + l.merchants_bp + l.model_bp + l.unanswered_bp,
        10_000
    );
    let by_model = run["suggestions"].as_array().unwrap().len() as u32;
    assert_eq!(l.model_bp, by_model * 10_000 / l.lines_total);
    assert!(l.model_bp > 0, "the model answered some");
}

#[tokio::test]
async fn a_business_at_three_times_its_median_is_flagged_and_one_below_the_floor_isnt() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    defaults(&s, &boss).await;
    let hammered = business(&s, &boss, "Marsh Hollow Candles").await;
    let quiet = business(&s, &boss, "Quiet Pines").await;
    install(&mut s, Metered::new(fake()).with_prices(Some(CHEAP)));
    let olive = overseer(&s, "olive").await;

    // A usual 4 a day, then 13 today: over 3 times 4 (and over the floor of 10).
    history(&s, &hammered, 4, 13).await;
    // A usual 1 a day, then 4 today: over 3 times 1, but under the floor, so not a spike.
    history(&s, &quiet, 1, 4).await;

    let v = view(&s, &olive, "").await;
    let business_flags: Vec<_> = v
        .flags
        .iter()
        .filter(|f| f.rule == SpikeRule::Business)
        .collect();
    assert_eq!(business_flags.len(), 1, "{:?}", v.flags);
    let f = business_flags[0];
    assert_eq!(f.subject_id.as_deref(), Some(hammered.as_str()));
    assert_eq!(f.subject_name.as_deref(), Some("Marsh Hollow Candles"));
    assert_eq!((f.value, f.threshold), (13, 12));
    assert!(
        f.message
            .starts_with("Marsh Hollow Candles made 13 AI asks today."),
        "{}",
        f.message
    );
    // The badge counts what's listed.
    assert_eq!(v.flag_count as usize, v.flags.len());
    assert_eq!(v.flag_count, 1);
    // Both are in the top list, with their change against their own median.
    let by_id = |id: &str| v.top_businesses.iter().find(|t| t.id == id).unwrap();
    assert_eq!(
        (by_id(&hammered).median_7d, by_id(&hammered).change_pct),
        (4, Some(225))
    );
    assert_eq!(
        (by_id(&quiet).median_7d, by_id(&quiet).change_pct),
        (1, Some(300))
    );
    assert_eq!(v.top_businesses[0].id, hammered);

    // The click-through shows the business's asks, newest first, to view as.
    let from = (Utc::now() - Duration::days(10)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let v = view(&s, &olive, &format!("?business={hammered}&from={from}")).await;
    let list = v.asks.unwrap();
    assert_eq!(list.rows.len(), 7 * 4 + 13);
    assert!(
        list.rows.windows(2).all(|w| w[0].at >= w[1].at),
        "newest first"
    );
}

#[tokio::test]
async fn a_rise_in_invalid_outcomes_flags() {
    let mut s = Server::new().await;
    install(&mut s, Metered::new(fake()).with_prices(Some(CHEAP)));
    let olive = overseer(&s, "olive").await;

    // Ten calls to the model today, from ten businesses: 2 of them unusable is 20%, which is the
    // line itself, not over it.
    let mut rows: Vec<UsageRow> = (0..10).map(|_| usage_row(Utc::now(), &new_id())).collect();
    for r in rows.iter_mut().take(2) {
        r.outcome = "invalid".into();
    }
    record(&s, &rows).await;
    assert!(view(&s, &olive, "").await.flags.is_empty());

    // Two more fail, and an ask the limits refused doesn't dilute the share: 4 of 12.
    let mut more: Vec<UsageRow> = (0..2).map(|_| usage_row(Utc::now(), &new_id())).collect();
    for r in &mut more {
        r.outcome = "error".into();
    }
    let mut refused = usage_row(Utc::now(), &new_id());
    refused.outcome = "refused_limit".into();
    refused.model = None;
    refused.cost_micro_usd = Some(0);
    record(&s, &more).await;
    record(&s, &[refused]).await;
    let v = view(&s, &olive, "").await;
    assert_eq!(v.flags.len(), 1, "{:?}", v.flags);
    let f = &v.flags[0];
    assert_eq!(f.rule, SpikeRule::ErrorShare);
    assert_eq!((f.value, f.threshold), (34, 20), "4 of 12, rounded up");
    assert_eq!(v.flag_count, 1);
}

#[tokio::test]
async fn the_budget_flags_at_eighty_percent_and_once_hit() {
    let mut s = Server::new().await;
    let olive = overseer(&s, "olive").await;
    // No suggester, so no cap and no budget, whatever was spent.
    record(&s, &[usage_row(Utc::now(), "b")]).await;
    assert!(view(&s, &olive, "").await.budget.is_none());

    // A US$1.00 cap is 1,000,000 micro-dollars.
    install(
        &mut s,
        Metered::new(fake())
            .with_prices(Some(CHEAP))
            .with_daily_budget_cents(Some(100)),
    );
    let mut spend = usage_row(Utc::now(), "b");
    spend.cost_micro_usd = Some(799_700);
    record(&s, &[spend]).await;
    // 300 + 799,700 = 800,000: 80%.
    let v = view(&s, &olive, "").await;
    let b = v.budget.as_ref().unwrap();
    assert_eq!(
        (b.cap_cents, b.spent_micro_usd, b.percent),
        (100, 800_000, 80)
    );
    assert!(b.reached_at.is_none());
    assert_eq!(v.flags.len(), 1, "{:?}", v.flags);
    assert_eq!(v.flags[0].rule, SpikeRule::BudgetWarn);
    assert_eq!(
        v.flags[0].message,
        "Today's AI spend is US$0.80, 80% of the US$1.00 daily budget."
    );

    // Past the cap: a hit, with when, and the asks refused since.
    let mut over = usage_row(Utc::now(), "b");
    over.cost_micro_usd = Some(250_000);
    let mut refused = usage_row(Utc::now(), "b");
    refused.outcome = "refused_budget".into();
    refused.model = None;
    refused.cost_micro_usd = Some(0);
    record(&s, &[over, refused]).await;
    let v = view(&s, &olive, "").await;
    let b = v.budget.as_ref().unwrap();
    assert_eq!((b.percent, b.refused_today), (105, 1));
    assert!(b.reached_at.is_some());
    assert_eq!(v.flags.len(), 1);
    assert_eq!(v.flags[0].rule, SpikeRule::BudgetHit);
    assert!(
        v.flags[0]
            .message
            .starts_with("The daily AI budget of US$1.00 was reached at ")
    );
    assert!(
        v.flags[0].message.ends_with("UTC; 1 asks refused so far."),
        "{}",
        v.flags[0].message
    );
}
