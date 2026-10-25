//! ADR 009 and ADR 011 end to end, over HTTP with the fake suggester: on by default and turning
//! it off, what reaches the suggester, pre-fills in the Save tax queue, accepting one with `via`, and turning it off.
//! No network.

mod common;

use std::sync::Arc;

use acct_ai::FakeSuggester;
use acct_core::tax::gst::GstFrequency;
use acct_core::{Account, Mapping, Template};
use acct_server::business::{GstBasis, GstSetup};
use acct_server::commands::Command;
use axum::http::StatusCode;
use chrono::NaiveDate;
use common::{Server, get, post_json, split};
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

/// A command's wire payload, built from the typed command.
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

/// The synthetic sole trader with three statements uploaded, nothing sorted.
async fn business(s: &Server, boss: &str) -> String {
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
    let client = ok(
        s,
        boss,
        Command::SetUpBusiness {
            name: "Marsh Hollow Candles".into(),
            start_date: NaiveDate::from_ymd_opt(2025, 8, 1).unwrap(),
            gst: Some(GstSetup {
                registered_from: NaiveDate::from_ymd_opt(2025, 8, 1).unwrap(),
                frequency: GstFrequency::TwoMonthlyOdd,
                basis: GstBasis::Payments,
            }),
        },
    )
    .await;
    for (name, bytes) in STATEMENTS {
        ok(
            s,
            boss,
            Command::ImportStatement {
                client_id: client.clone(),
                file_name: (*name).into(),
                content_base64: base64(bytes),
                bank_account_id: None,
            },
        )
        .await;
    }
    client
}

async fn view(s: &Server, cookie: &str, client: &str) -> Value {
    let (status, body) = split(
        s.send(get(
            &format!("/api/businesses/{client}/ai-suggestions"),
            Some(cookie),
        ))
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body
}

async fn ask(s: &Server, cookie: &str, client: &str) -> (StatusCode, Value) {
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

fn set(client: &str, enabled: bool) -> Command {
    Command::SetAiSuggestions {
        client_id: client.into(),
        enabled,
        activity: Some("candle maker".into()),
        private_names: Some(vec!["Q Marsh".into()]),
    }
}

#[tokio::test]
async fn suggestions_are_gated_redacted_and_only_ever_pre_filled() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    let val = s.login("val").await;
    let client = business(&s, &boss).await;

    // No suggester configured: nothing to ask.
    assert_eq!(view(&s, &sam, &client).await["available"], false);
    let (status, body) = ask(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "ai_unavailable");

    let fake = Arc::new(FakeSuggester::with_defaults("fake-model"));
    s.state.suggester = Some(fake.clone());

    // On by default, with no consent screen (ADR 011).
    let v = view(&s, &sam, &client).await;
    assert_eq!(v["available"], true);
    assert_eq!(v["enabled"], true);
    assert!(v.get("consent_version").is_none());

    // Turned off, nothing is asked. Viewers can't change it.
    let (kind, p) = payload(set(&client, false));
    assert_eq!(s.command(&val, &kind, p).await.0, StatusCode::FORBIDDEN);
    ok(&s, &sam, set(&client, false)).await;
    assert_eq!(view(&s, &sam, &client).await["enabled"], false);
    let (_, body) = ask(&s, &sam, &client).await;
    assert_eq!(body["code"], "ai_suggestions_off");
    assert!(fake.seen().is_empty());

    // An old payload with ADR 009's consent version still reads; the field is ignored.
    let (kind, mut p) = payload(set(&client, true));
    p["consent_version"] = json!("2026-10-24:Anthropic");
    assert_eq!(s.command(&sam, &kind, p).await.0, StatusCode::OK);
    assert_eq!(view(&s, &sam, &client).await["enabled"], true);
    let (status, _) = ask(&s, &val, &client).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Ask.
    let (status, run) = ask(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    let asked = run["asked"].as_u64().unwrap();
    let made = run["suggestions"].as_array().unwrap().clone();
    assert!(asked > 0);
    assert!(!made.is_empty(), "{run}");
    assert!(made.iter().all(|m| m["model"] == "fake-model"));

    // What reached the suggester: no names, no account numbers, no dates.
    let seen = fake.seen();
    assert!(!seen.is_empty());
    for request in &seen {
        let text = format!("{request:?}").to_uppercase();
        for secret in [
            "MARSH",
            "MARSH HOLLOW",
            "0000123",
            "0000456",
            "0000789",
            "99-1001",
            "99-5501",
            "99-7702",
            "2025-",
        ] {
            assert!(
                !text.contains(secret),
                "{secret} reached the suggester: {text}"
            );
        }
        assert_eq!(request.activity(), Some("candle maker"));
    }

    // Nothing changed: the suggestions are pre-fills on the queue's cards.
    let (_, queue) = split(
        s.send(get(
            &format!("/api/businesses/{client}/save-tax"),
            Some(&sam),
        ))
        .await,
    )
    .await;
    let ai_cards: Vec<&Value> = queue["cards"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["suggestion"]["source"] == "ai")
        .collect();
    // Cards whose suggestion would save nothing are hidden, as every card is.
    assert!(!ai_cards.is_empty() && ai_cards.len() <= made.len());
    let card = ai_cards[0];
    let suggestion = &card["suggestion"];
    assert_eq!(suggestion["model"], "fake-model");

    // Accepting one unchanged, with `via`.
    let line_id = card["lines"][0]["bank_line_id"].as_str().unwrap();
    let body = json!({
        "id": common::new_id(),
        "kind": "code_bank_line",
        "payload": { "bank_line_id": line_id, "coding": suggestion["coding"] },
        "via": {
            "kind": "suggestion",
            "model": "fake-model",
            "suggestion_ids": [suggestion["id"]],
        },
    });
    let (status, accepted) =
        split(s.send(post_json("/api/commands", Some(&sam), &body)).await).await;
    assert_eq!(status, StatusCode::OK, "{accepted}");
    let still_waiting = view(&s, &sam, &client).await["suggestions"]
        .as_array()
        .unwrap()
        .len();
    assert_eq!(still_waiting, made.len() - 1);

    // Asking again skips the lines that already have a pre-fill.
    let (_, again) = ask(&s, &sam, &client).await;
    assert!(again["asked"].as_u64().unwrap() <= asked - made.len() as u64);

    // Turning it off stops requests and deletes the suggestions still waiting.
    ok(&s, &sam, set(&client, false)).await;
    assert!(
        view(&s, &sam, &client).await["suggestions"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let before = fake.seen().len();
    let (_, body) = ask(&s, &sam, &client).await;
    assert_eq!(body["code"], "ai_suggestions_off");
    assert_eq!(fake.seen().len(), before);
}

#[tokio::test]
async fn record_suggestions_is_checked_like_any_command() {
    let s = Server::new().await;
    let boss = s.login("boss").await;
    let client = business(&s, &boss).await;
    let (_, queue) = split(
        s.send(get(
            &format!("/api/businesses/{client}/save-tax"),
            Some(&boss),
        ))
        .await,
    )
    .await;
    let out_line = queue["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["kind"] == "categorise" && c["lines"][0]["amount"].as_i64().unwrap() < 0)
        .unwrap()["lines"][0]["bank_line_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let record = |coding: Value, confidence: &str| {
        json!({
            "client_id": client,
            "model": "fake-model",
            "suggestions": [{ "bank_line_id": out_line, "coding": coding, "confidence": confidence }],
        })
    };
    let personal = json!({ "direction": "out", "kind": "personal" });

    // Off: nothing is recorded.
    ok(&s, &boss, set(&client, false)).await;
    let (_, body) = s
        .command(
            &boss,
            "record_suggestions",
            record(personal.clone(), "high"),
        )
        .await;
    assert_eq!(body["code"], "ai_suggestions_off");

    ok(&s, &boss, set(&client, true)).await;
    for (coding, confidence, code) in [
        (personal.clone(), "low", "low_confidence"),
        (
            json!({ "direction": "out", "kind": "ird_gst" }),
            "high",
            "not_suggestible",
        ),
        (
            json!({ "direction": "in", "kind": "owner_funds" }),
            "high",
            "invalid_coding",
        ),
        (
            json!({ "direction": "out", "kind": "expense", "account": "100", "gst": "standard" }),
            "high",
            "invalid_coding",
        ),
    ] {
        let (_, body) = s
            .command(&boss, "record_suggestions", record(coding, confidence))
            .await;
        assert_eq!(body["code"], code, "{body}");
    }
    let (status, body) = s
        .command(
            &boss,
            "record_suggestions",
            record(personal.clone(), "high"),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // A sorted line takes no suggestions.
    ok(
        &s,
        &boss,
        Command::CodeBankLine {
            line: serde_json::from_value(json!({ "bank_line_id": out_line, "coding": personal }))
                .unwrap(),
        },
    )
    .await;
    let (_, body) = s
        .command(&boss, "record_suggestions", record(personal, "high"))
        .await;
    assert_eq!(body["code"], "line_already_sorted");
}

const MERCHANTS: &str = include_str!("../../../fixtures/practice/sole-trader-merchants.json");

/// The queue's card for the line whose description contains `text`.
async fn card(s: &Server, cookie: &str, client: &str, text: &str) -> Option<Value> {
    let (_, queue) = split(
        s.send(get(
            &format!("/api/businesses/{client}/save-tax"),
            Some(cookie),
        ))
        .await,
    )
    .await;
    queue["cards"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["lines"][0]["description"]
                .as_str()
                .is_some_and(|d| d.contains(text))
        })
        .cloned()
}

#[tokio::test]
async fn the_merchant_list_suggests_after_rules_and_history_and_before_ai() {
    let mut s = Server::new().await;
    let boss = s.login("boss").await;
    let sam = s.login("sam").await;
    let client = business(&s, &boss).await;
    let expense = |account: &str| json!({ "direction": "out", "kind": "expense", "account": account, "gst": "standard" });
    let add = |pattern: &str, coding: Value| json!({ "entity_type": "sole_trader", "description_contains": pattern, "coding": coding });

    // The practice owner keeps the list, and it's checked against the master chart.
    let (status, _) = s
        .command(&sam, "add_merchant", add("GRIDLINE POWER", expense("255")))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    for (body, code) in [
        (add("GRIDLINE POWER", expense("100")), "invalid_coding"),
        (add("GRIDLINE POWER", expense("999")), "invalid_coding"),
        (
            add(
                "GRIDLINE POWER",
                json!({ "direction": "out", "kind": "ird_gst" }),
            ),
            "not_suggestible",
        ),
        (add(" a ", expense("255")), "pattern_too_short"),
    ] {
        let (_, reply) = s.command(&boss, "add_merchant", body).await;
        assert_eq!(reply["code"], code, "{reply}");
    }
    let (status, _) = s
        .command(
            &boss,
            "add_merchant",
            json!({ "entity_type": "company", "description_contains": "GRIDLINE", "coding": expense("255") }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let list: Vec<Value> = serde_json::from_str(MERCHANTS).unwrap();
    let mut ids = Vec::new();
    for m in &list {
        let (status, reply) = s
            .command(
                &boss,
                "add_merchant",
                add(
                    m["description_contains"].as_str().unwrap(),
                    m["coding"].clone(),
                ),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{reply}");
        ids.push(reply["entity_id"].as_str().unwrap().to_owned());
    }
    let (_, reply) = s
        .command(
            &boss,
            "add_merchant",
            add("gridline  power", expense("290")),
        )
        .await;
    assert_eq!(reply["code"], "merchant_exists");
    let (_, listed) = split(s.send(get("/api/merchants/sole_trader", Some(&sam))).await).await;
    assert_eq!(listed.as_array().unwrap().len(), list.len());

    // It pre-fills the card.
    let power = card(&s, &sam, &client, "GRIDLINE POWER").await.unwrap();
    assert_eq!(power["suggestion"]["source"], "merchant");
    assert_eq!(power["suggestion"]["coding"], expense("255"));

    // AI is asked only about what the list didn't answer.
    let fake = Arc::new(FakeSuggester::with_defaults("fake-model"));
    s.state.suggester = Some(fake.clone());
    ok(&s, &sam, set(&client, true)).await;
    let (status, run) = ask(&s, &sam, &client).await;
    assert_eq!(status, StatusCode::OK, "{run}");
    for request in fake.seen() {
        let text = format!("{request:?}");
        for m in &list {
            let pattern = m["description_contains"].as_str().unwrap();
            assert!(
                !text.contains(pattern),
                "{pattern} was sent to the suggester"
            );
        }
    }

    // A business's own rule wins over the list.
    ok(
        &s,
        &sam,
        Command::AddRule {
            client_id: client.clone(),
            description_contains: "GRIDLINE".into(),
            min: None,
            max: None,
            coding: acct_core::coding::Coding::Out(acct_core::coding::WithdrawalCoding::Personal),
        },
    )
    .await;
    assert!(
        card(&s, &sam, &client, "GRIDLINE POWER").await.is_none(),
        "the rule codes the line, so its card goes"
    );

    // Removing an entry takes its suggestion away; coded lines stay as they are.
    let telewave = card(&s, &sam, &client, "TELEWAVE").await.unwrap();
    assert_eq!(telewave["suggestion"]["source"], "merchant");
    let telewave_index = list
        .iter()
        .position(|m| m["description_contains"] == "TELEWAVE")
        .unwrap();
    ok(
        &s,
        &boss,
        Command::RemoveMerchant {
            merchant_id: ids[telewave_index].clone(),
        },
    )
    .await;
    let telewave = card(&s, &sam, &client, "TELEWAVE").await.unwrap();
    assert_ne!(telewave["suggestion"]["source"], "merchant");
    let (_, reply) = s
        .command(
            &boss,
            "remove_merchant",
            json!({ "merchant_id": ids[telewave_index] }),
        )
        .await;
    assert_eq!(reply["code"], "not_found");
}
