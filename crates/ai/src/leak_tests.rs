//! What leaves the server, checked on the exact bodies both adapters would send, and the
//! adapters read against recorded responses (synthetic, in `recorded/`). No network.

use acct_core::coding::Direction;
use acct_core::{GstCode, Money};

use crate::redact::{ExampleInput, Input, LineInput, request};
use crate::{
    AiError, Category, Confidence, FakeSuggester, Suggester, anthropic, openai_compatible,
};

const OWNER: &str = "Quinn Marsh";
const BUSINESS: &str = "Marsh Hollow Candles";

/// Lines full of the details that must never leave.
fn leaky_request() -> crate::SuggestRequest {
    let lines = [
        LineInput {
            amount: Money::from_cents(-14_250),
            description: "GRIDLINE POWER DIRECT DEBIT 12-3456-7654321-00",
        },
        LineInput {
            amount: Money::from_cents(-30_000),
            description: "Q MARSH ONLINE TRANSFER OUT 99-1001-0000123-00",
        },
        LineInput {
            amount: Money::from_cents(52_075),
            description: "QUINN MARSH T/A MARSH HOLLOW CANDLES IRD 123-456-789",
        },
        LineInput {
            amount: Money::from_cents(-2_500),
            description: "MARSH, Q 0211234567 q.marsh@example.co.nz CARD 4111111111111111",
        },
    ];
    let categories = [
        Category {
            key: "255".to_owned(),
            name: "Power and gas".to_owned(),
            direction: Direction::Out,
        },
        Category {
            key: "personal".to_owned(),
            name: "Personal spending".to_owned(),
            direction: Direction::Out,
        },
        Category {
            key: "100".to_owned(),
            name: "Sales".to_owned(),
            direction: Direction::In,
        },
    ];
    let examples = [ExampleInput {
        amount: Money::from_cents(-9_900),
        description: "TELEWAVE MOBILE Q MARSH 1234567654321000",
        category: "245",
        gst: GstCode::Standard,
    }];
    request(&Input {
        lines: &lines,
        categories: &categories,
        examples: &examples,
        activity: Some("candle maker"),
        private_names: &[OWNER, BUSINESS],
    })
}

fn assert_nothing_private(body: &str) {
    let upper = body.to_uppercase();
    for secret in [
        "QUINN",
        "Q MARSH",
        "MARSH Q",
        "MARSH HOLLOW",
        "CANDLES",
        "12-3456-7654321-00",
        "7654321",
        "99-1001-0000123-00",
        "0000123",
        "123-456-789",
        "0211234567",
        "Q.MARSH@",
        "EXAMPLE.CO.NZ",
        "4111111111111111",
        "1234567654321000",
    ] {
        assert!(!upper.contains(secret), "{secret} left the server: {body}");
    }
    // Every word MARSH that's left must be gone too: it only ever appeared in names.
    assert!(!upper.contains("MARSH"), "a name left the server: {body}");
}

#[test]
fn the_anthropic_body_holds_no_names_or_numbers() {
    let body = anthropic::body("claude-haiku-5-5", &leaky_request()).to_string();
    assert_nothing_private(&body);
    // What it needs is still there.
    assert!(body.contains("GRIDLINE POWER DIRECT DEBIT [acct]"));
    assert!(body.contains("[ird]"));
    assert!(body.contains("candle maker"));
}

#[test]
fn the_openai_compatible_body_holds_no_names_or_numbers() {
    let body = openai_compatible::body("synthetic-mini", &leaky_request()).to_string();
    assert_nothing_private(&body);
    assert!(body.contains("[phone]"));
    assert!(body.contains("[email]"));
}

#[test]
fn no_dates_balances_or_ids_are_sent() {
    let body = anthropic::body("claude-haiku-5-5", &leaky_request()).to_string();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    let batch: serde_json::Value =
        serde_json::from_str(v["messages"][0]["content"].as_str().unwrap()).unwrap();
    let line = batch["transactions"][0].as_object().unwrap();
    let mut keys: Vec<&str> = line.keys().map(String::as_str).collect();
    keys.sort_unstable();
    assert_eq!(keys, ["amount", "description", "direction", "ref"]);
    assert_eq!(batch["transactions"][0]["amount"], 143);
    assert_eq!(batch["transactions"][0]["ref"], 1);
}

#[test]
fn the_anthropic_body_caches_the_business_part() {
    let body = anthropic::body("claude-haiku-5-5", &leaky_request());
    assert_eq!(body["system"][1]["cache_control"]["type"], "ephemeral");
    assert_eq!(body["output_config"]["format"]["type"], "json_schema");
}

#[test]
fn reads_a_recorded_anthropic_response() {
    let recorded: serde_json::Value =
        serde_json::from_str(include_str!("recorded/anthropic.json")).unwrap();
    let got = anthropic::read(&recorded).unwrap();
    assert_eq!(got.len(), 3);
    assert_eq!(got[0].category, "255");
    assert_eq!(got[1].confidence, Confidence::Medium);
}

#[test]
fn an_anthropic_refusal_or_cut_off_is_an_error() {
    let refused = serde_json::json!({ "content": [], "stop_reason": "refusal" });
    assert!(matches!(anthropic::read(&refused), Err(AiError::Refused)));
    let cut = serde_json::json!({ "content": [{"type": "text", "text": "{\"sugg"}], "stop_reason": "max_tokens" });
    assert!(matches!(
        anthropic::read(&cut),
        Err(AiError::BadResponse(_))
    ));
}

#[test]
fn reads_a_recorded_openai_compatible_response() {
    let recorded: serde_json::Value =
        serde_json::from_str(include_str!("recorded/openai_compatible.json")).unwrap();
    let got = openai_compatible::read(&recorded).unwrap();
    assert_eq!(got.len(), 2);
    assert_eq!(got[1].category, "personal");
    let refused = serde_json::json!({ "choices": [{ "message": { "content": null, "refusal": "no" }, "finish_reason": "stop" }] });
    assert!(matches!(
        openai_compatible::read(&refused),
        Err(AiError::Refused)
    ));
}

#[tokio::test]
async fn the_fake_answers_by_description_and_keeps_what_it_saw() {
    let fake = FakeSuggester::with_defaults("fake");
    let got = fake.suggest(leaky_request()).await.unwrap();
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].reference, 1);
    assert_eq!(got[0].category, "255");
    let seen = fake.seen();
    assert_eq!(seen.len(), 1);
    assert_nothing_private(&format!("{:?}", seen[0]));
}

#[test]
fn token_counts_are_read_from_recorded_responses() {
    let a: serde_json::Value =
        serde_json::from_str(include_str!("recorded/anthropic.json")).unwrap();
    let u = anthropic::usage_of(&a);
    assert_eq!(
        (
            u.requests,
            u.input_tokens,
            u.cache_read_tokens,
            u.output_tokens
        ),
        (1, 412, 1890, 96)
    );
    let o: serde_json::Value =
        serde_json::from_str(include_str!("recorded/openai_compatible.json")).unwrap();
    let u = openai_compatible::usage_of(&o);
    assert_eq!((u.input_tokens, u.output_tokens), (2302, 71));
}
