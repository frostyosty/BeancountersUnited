//! M20's guests (ADR 014): a visitor tries it on the home page with no sign-up.
//!
//! Starting with an example and with a file of their own; a guest works on its own business and
//! reaches nobody else's; every command kind is classified for guests, and each refused one is
//! refused; claiming keeps everything; signing in to an existing account instead moves the trial;
//! expiry deletes exactly the trial and leaves every other row byte-identical; and the per-address
//! limits.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::sync::Arc;

use acct_server::api_routes;
use acct_server::commands::Command;
use acct_server::guests::{self, GUEST_ALLOWED, GUEST_REFUSED, Limits};
use acct_store::guests::{self as guest_store, GstSource};
use acct_store::{bank as bank_store, log, sqlx, users};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, Response, StatusCode, header};
use chrono::{Duration, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const ASSET_CLASSES: &str =
    include_str!("../../../fixtures/practice/sole-trader-asset-classes.json");
/// The visitor's own file.
const OWN_FILE: &str = "harbourlight-cheque-2025-08.ofx";
const OWN: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx");
/// A second file of the visitor's own: a card, so it adds an account to the same business.
const CARD: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-visa-2025-08.ofx");
/// A signed-up owner's file, in another business.
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

/// Every command kind, from the `Command` enum's own list of variants (as `tests/tenancy.rs`).
fn all_kinds() -> Vec<String> {
    let err = serde_json::from_value::<Command>(json!({ "kind": "?", "payload": {} }))
        .unwrap_err()
        .to_string();
    let list = err
        .split_once("expected one of ")
        .unwrap_or_else(|| panic!("serde's message changed: {err}"))
        .1;
    list.split(", ")
        .map(|k| {
            k.trim_matches(|c: char| c == '`' || c.is_whitespace())
                .to_owned()
        })
        .collect()
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

fn token() -> String {
    let a = uuid::Uuid::now_v7().simple().to_string();
    let b = uuid::Uuid::now_v7().simple().to_string();
    format!("{a}{b}")
}

fn file_source(name: &str, bytes: &[u8]) -> Value {
    json!({ "file": { "file_name": name, "content_base64": base64(bytes) } })
}

fn example_source(n: u8) -> Value {
    json!({ "example": n })
}

/// The `name=value` of a cookie the response sets, if it sets it to something.
fn set_cookie(response: &Response<Body>, name: &str) -> Option<String> {
    response
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok()?.split(';').next())
        .find(|c| c.starts_with(&format!("{name}=")) && c.len() > name.len() + 1)
        .map(str::to_owned)
}

/// A server with the sole-trader starter set, which a guest's business is set up from.
async fn server() -> Server {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    server
        .ok(
            &boss,
            "install_starter_set",
            json!({ "set": "sole_trader" }),
        )
        .await;
    server
}

/// A visitor in a browser: their session cookie once they have one.
struct Guest {
    cookie: String,
    user_id: String,
    /// The business the last start went into.
    business_id: String,
    me: Value,
}

/// `POST /api/guest` from `address` (or no address, as in the other tests), with `cookie` if the
/// browser has one. Returns the response unread.
async fn post_guest(
    server: &Server,
    source: Value,
    cookie: Option<&str>,
    address: Option<&str>,
) -> Response<Body> {
    let mut request = post_json(
        "/api/guest",
        cookie,
        &json!({ "id": new_id(), "source": source }),
    );
    if let Some(a) = address {
        request
            .extensions_mut()
            .insert(ConnectInfo(a.parse::<SocketAddr>().unwrap()));
    }
    server.send(request).await
}

/// A new visitor drops a file or uses an example; it must work.
async fn start(server: &Server, source: Value) -> Guest {
    let response = post_guest(server, source, None, None).await;
    let cookie = set_cookie(&response, "acct_session");
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "start: {body}");
    Guest {
        cookie: cookie.expect("starting a trial sets the session cookie"),
        user_id: body["me"]["id"].as_str().unwrap().to_owned(),
        business_id: body["business_id"].as_str().unwrap().to_owned(),
        me: body["me"].clone(),
    }
}

/// The same browser drops another file or uses another example; it must work.
async fn again(server: &Server, guest: &Guest, source: Value) -> Guest {
    let response = post_guest(server, source, Some(&guest.cookie), None).await;
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "again: {body}");
    Guest {
        cookie: guest.cookie.clone(),
        user_id: body["me"]["id"].as_str().unwrap().to_owned(),
        business_id: body["business_id"].as_str().unwrap().to_owned(),
        me: body["me"].clone(),
    }
}

async fn flags(server: &Server, client_id: &str) -> Option<guest_store::BusinessFlags> {
    let mut conn = server.state.store.reader().await.unwrap();
    guest_store::flags(&mut conn, client_id).await.unwrap()
}

/// Every `bank_line_id` anywhere in a Save tax queue.
fn collect_line_ids(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Object(map) => {
            for (k, v) in map {
                match (k.as_str(), v) {
                    ("bank_line_id", Value::String(id)) => out.push(id.clone()),
                    _ => collect_line_ids(v, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| collect_line_ids(v, out)),
        _ => {}
    }
}

async fn head_seq(server: &Server) -> i64 {
    let mut conn = server.state.store.reader().await.unwrap();
    log::head_seq(&mut conn).await.unwrap()
}

// ---------------------------------------------------------------------------------------------
// Starting.

#[tokio::test]
async fn a_visitor_starts_with_an_example_or_their_own_file() {
    let server = server().await;

    // An example: a guest with an example business and none of their own yet.
    let g = start(&server, example_source(1)).await;
    assert_eq!(g.me["role"], "business_owner");
    assert_eq!(g.me["username"], "");
    assert_eq!(g.me["display_name"], "You");
    assert_eq!(g.me["guest"]["business_id"], Value::Null);
    assert_eq!(g.me["guest"]["example"]["number"], 1);
    assert_eq!(g.me["guest"]["example"]["business_id"], g.business_id);
    let example_one = g.business_id.clone();
    let f = flags(&server, &example_one).await.unwrap();
    assert_eq!(f.example, Some(1));
    // Example 1 pays IRD for GST, so registration is detected (ADR 014, 9).
    assert_eq!(f.source(), GstSource::Detected);
    assert!(f.gst_evidence.is_some());
    let me = server.get_json("/api/me", &g.cookie).await;
    assert_eq!(me["guest"]["example"]["number"], 1, "{me}");
    server
        .get_json(&format!("/api/businesses/{example_one}/tax"), &g.cookie)
        .await;

    // Their own file goes in a business of its own, next to the example.
    let own = again(&server, &g, file_source(OWN_FILE, OWN)).await;
    assert_ne!(own.business_id, example_one);
    assert_eq!(own.user_id, g.user_id, "the same guest");
    assert_eq!(own.me["guest"]["business_id"], own.business_id);
    assert_eq!(own.me["guest"]["example"]["business_id"], example_one);
    let f = flags(&server, &own.business_id).await.unwrap();
    assert_eq!(f.example, None);
    assert!(
        matches!(f.source(), GstSource::Assumed | GstSource::Detected),
        "set up from the file alone: {:?}",
        f.source()
    );
    let business = server
        .get_json(&format!("/api/businesses/{}", own.business_id), &g.cookie)
        .await;
    assert_eq!(business["bank_accounts"].as_array().unwrap().len(), 1);

    // A second file of their own is an ordinary upload into the same business.
    let card = again(&server, &g, file_source("card.ofx", CARD)).await;
    assert_eq!(card.business_id, own.business_id);
    let business = server
        .get_json(&format!("/api/businesses/{}", own.business_id), &g.cookie)
        .await;
    assert_eq!(business["bank_accounts"].as_array().unwrap().len(), 2);

    // Another example replaces the first; their own business is untouched.
    let two = again(&server, &g, example_source(2)).await;
    assert_ne!(two.business_id, example_one);
    assert_eq!(two.me["guest"]["example"]["number"], 2);
    assert_eq!(two.me["guest"]["business_id"], own.business_id);
    assert!(
        flags(&server, &example_one).await.is_none(),
        "Example 1 is gone"
    );
    assert_eq!(
        flags(&server, &two.business_id).await.unwrap().source(),
        GstSource::Assumed,
        "Example 2 has no GST payment, so it's assumed"
    );

    // A guest's own file makes a business from it alone: "Your business", from 1 April.
    let fresh = start(&server, file_source(OWN_FILE, OWN)).await;
    assert_eq!(fresh.me["guest"]["business_id"], fresh.business_id);
    assert_eq!(fresh.me["guest"]["example"], Value::Null);
    let client = server
        .get_json(
            &format!("/api/clients/{}", fresh.business_id),
            &fresh.cookie,
        )
        .await;
    assert_eq!(client["name"], "Your business", "{client}");
    assert_eq!(client["years"][0]["start"], "2025-04-01", "{client}");
}

#[tokio::test]
async fn a_file_the_parser_rejects_makes_no_guest() {
    let server = server().await;
    let guests_before = {
        let mut conn = server.state.store.reader().await.unwrap();
        users::guests(&mut conn).await.unwrap().len()
    };
    let before = head_seq(&server).await;
    let response = post_guest(
        &server,
        file_source("notes.ofx", b"this is not a bank statement"),
        None,
        None,
    )
    .await;
    assert!(set_cookie(&response, "acct_session").is_none());
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert!(
        !body["message"].as_str().unwrap_or("").is_empty(),
        "the parser says why: {body}"
    );
    assert_eq!(head_seq(&server).await, before);
    let mut conn = server.state.store.reader().await.unwrap();
    assert_eq!(users::guests(&mut conn).await.unwrap().len(), guests_before);
}

#[tokio::test]
async fn someone_signed_in_starts_no_trial() {
    let server = server().await;
    let boss = server.login("boss").await;
    let (status, body) =
        split(post_guest(&server, example_source(1), Some(&boss), None).await).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "signed_in");
}

// ---------------------------------------------------------------------------------------------
// Tenancy.

/// What a guest's business has that someone else could name.
struct Trial {
    guest: Guest,
    bank_account_id: String,
    statement_id: String,
    lines: Vec<String>,
    rule_id: String,
}

impl Trial {
    fn ids(&self) -> BTreeSet<String> {
        let mut ids: BTreeSet<String> = [
            &self.guest.business_id,
            &self.bank_account_id,
            &self.statement_id,
            &self.rule_id,
        ]
        .into_iter()
        .cloned()
        .collect();
        ids.extend(self.lines.iter().cloned());
        ids
    }
}

async fn trial(server: &Server) -> Trial {
    let guest = start(server, file_source(OWN_FILE, OWN)).await;
    let biz = guest.business_id.clone();
    let business = server
        .get_json(&format!("/api/businesses/{biz}"), &guest.cookie)
        .await;
    let bank_account_id = business["bank_accounts"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let statement_id = business["bank_accounts"][0]["statements"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let queue = server
        .get_json(&format!("/api/businesses/{biz}/save-tax"), &guest.cookie)
        .await;
    let mut lines = Vec::new();
    collect_line_ids(&queue, &mut lines);
    lines.sort();
    lines.dedup();
    assert!(lines.len() >= 2, "the trial needs two lines: {queue}");
    let rule_id = server
        .ok(
            &guest.cookie,
            "add_rule",
            json!({
                "client_id": biz,
                "description_contains": "NO SUCH SHOP",
                "coding": { "direction": "out", "kind": "personal" },
            }),
        )
        .await;
    Trial {
        guest,
        bank_account_id,
        statement_id,
        lines,
        rule_id,
    }
}

/// A's id for a path parameter.
fn fill(path: &str, t: &Trial) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').unwrap() + open;
        out.push_str(&rest[..open]);
        let value = match &rest[open + 1..close] {
            "id" if path.starts_with("/api/statements/") => t.statement_id.clone(),
            "id" if path.starts_with("/api/bank-accounts/") => t.bank_account_id.clone(),
            "id" => t.guest.business_id.clone(),
            "entity_type" => "sole_trader".to_owned(),
            _ => new_id(),
        };
        out.push_str(&value);
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

fn request(method: &Method, uri: &str, cookie: &str) -> Request<Body> {
    let r = Request::builder()
        .method(method.clone())
        .uri(uri)
        .header(header::COOKIE, cookie);
    if *method == Method::POST {
        r.header(header::CONTENT_TYPE, "application/json")
            .body(Body::from("{}"))
            .unwrap()
    } else {
        r.body(Body::empty()).unwrap()
    }
}

/// Another guest's attempt at each command a guest may send, aimed at A's trial. `None` for the
/// ones that name no one else's data.
fn attack(kind: &str, a: &Trial) -> Option<Value> {
    let biz = &a.guest.business_id;
    let line = &a.lines[0];
    let coding = json!({ "direction": "out", "kind": "personal" });
    Some(match kind {
        "import_statement" => json!({
            "client_id": biz, "file_name": "x.csv", "content_base64": base64(KOWHAI),
        }),
        "remove_statement" => json!({ "statement_id": a.statement_id }),
        "set_opening_balance" => json!({ "bank_account_id": a.bank_account_id, "balance": 0 }),
        "add_bank_account" => json!({ "client_id": biz, "name": "X" }),
        "add_card_account" => json!({ "client_id": biz, "name": "X" }),
        "code_bank_line" => json!({ "bank_line_id": line, "coding": coding }),
        "code_bank_lines" => json!({ "lines": [{ "bank_line_id": line, "coding": coding }] }),
        "add_rule" => json!({ "client_id": biz, "description_contains": "X", "coding": coding }),
        "remove_rule" => json!({ "rule_id": a.rule_id }),
        "answer_question" => json!({
            "client_id": biz, "income_year": 2026,
            "answer": { "question": "only_income", "yes": true },
        }),
        "confirm_transfer" => json!({ "out_line_id": a.lines[0], "in_line_id": a.lines[1] }),
        "confirm_ird_payment" => json!({ "bank_line_id": line, "payment": { "kind": "gst" } }),
        "resolve_duplicate" => json!({ "bank_line_id": line, "is_duplicate": true }),
        "confirm_supply_info" => json!({ "bank_line_id": line }),
        "set_gst_registration" => {
            json!({ "client_id": biz, "registered": false, "source": "owner" })
        }
        "expire_guest" => json!({ "client_id": biz, "why": "by_you" }),
        "add_guest_business" | "claim_guest" => return None,
        other => panic!("tests/guests.rs has no attack for the allowed command {other}; add one"),
    })
}

#[tokio::test]
async fn a_guest_reaches_nothing_of_another_guests_trial() {
    let server = server().await;
    let a = trial(&server).await;
    let b = start(&server, file_source(OWN_FILE, OWN)).await;
    let a_ids = a.ids();
    let biz = &a.guest.business_id;

    // A's own reads work.
    for path in ["tax", "save-tax", "rules", "coding-settings"] {
        server
            .get_json(&format!("/api/businesses/{biz}/{path}"), &a.guest.cookie)
            .await;
    }

    // Every route a guest may use: B is told A's things don't exist, and lists show only B's.
    for (method, path) in api_routes() {
        if !guests::route_allowed(&method, path) || !path.contains("{id}") {
            continue;
        }
        let uri = fill(path, &a);
        let (status, body) = split(server.send(request(&method, &uri, &b.cookie)).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {body}");
        assert!(
            a_ids.contains(body["details"]["id"].as_str().unwrap_or("")),
            "{method} {path}: {body}"
        );
        // A, with the same request, gets past the access check.
        let (status, body) =
            split(server.send(request(&method, &uri, &a.guest.cookie)).await).await;
        assert!(
            status != StatusCode::NOT_FOUND && status != StatusCode::FORBIDDEN,
            "{method} {path} as A: {status} {body}"
        );
    }
    for path in ["/api/clients", "/api/sync?after=0", "/api/history"] {
        let text = server.get_json(path, &b.cookie).await.to_string();
        assert!(
            !text.contains(biz.as_str()),
            "{path} shows B A's trial: {text}"
        );
        assert!(
            text.contains(&b.business_id),
            "{path} shows B's own: {text}"
        );
    }

    // Every command a guest may send, aimed at A's trial.
    let before = head_seq(&server).await;
    for kind in GUEST_ALLOWED {
        let Some(payload) = attack(kind, &a) else {
            continue;
        };
        let (status, body) = server.command(&b.cookie, kind, payload).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{kind}: {body}");
        let id = body["details"]["id"].as_str().unwrap_or("");
        assert!(a_ids.contains(id), "{kind}: not found names {id:?}: {body}");
    }
    assert_eq!(
        head_seq(&server).await,
        before,
        "a refused command left something in the log"
    );

    // Nobody else sees an unsaved trial either: not the practice, not an overseer, not an owner.
    let system = acct_server::pipeline::Actor {
        user_id: None,
        role: users::Role::Overseer,
        acting_as: None,
    };
    let envelope = acct_server::commands::CommandEnvelope {
        id: new_id(),
        command: serde_json::from_value(json!({
            "kind": "create_user",
            "payload": {
                "username": "olive", "display_name": "Olive",
                "password": PASSWORD, "role": "overseer",
            },
        }))
        .unwrap(),
    };
    acct_server::pipeline::submit(&server.state.store, &system, envelope, Utc::now())
        .await
        .unwrap();
    let owner = sign_up(&server, "ana@example.nz").await.0;
    for who in ["boss", "sam", "olive"] {
        let cookie = server.login(who).await;
        check_unseen(&server, &cookie, biz, who).await;
    }
    check_unseen(&server, &owner, biz, "an owner").await;
}

async fn check_unseen(server: &Server, cookie: &str, biz: &str, who: &str) {
    let (status, body) = split(
        server
            .send(get(&format!("/api/businesses/{biz}"), Some(cookie)))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{who}: {body}");
    let list = server.get_json("/api/clients", cookie).await.to_string();
    assert!(!list.contains(biz), "{who} lists the trial: {list}");
}

/// An owner signs up. Returns their cookie and business.
async fn sign_up(server: &Server, email: &str) -> (String, String) {
    let response = server
        .send(post_json(
            "/api/signup",
            None,
            &json!({
                "id": new_id(),
                "email": email,
                "display_name": "Ana Owner",
                "password": PASSWORD,
                "business_name": "Ana's Gardens",
                "start_date": "2025-04-01",
            }),
        ))
        .await;
    let cookie = set_cookie(&response, "acct_session");
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "sign-up: {body}");
    (
        cookie.expect("sign-up signs you in"),
        body["business_id"].as_str().unwrap().to_owned(),
    )
}

// ---------------------------------------------------------------------------------------------
// What a guest may do.

#[test]
fn every_command_kind_is_classified_for_guests() {
    let refused: Vec<&str> = GUEST_REFUSED.iter().map(|(k, _)| *k).collect();
    let kinds = all_kinds();
    assert!(kinds.len() > 40, "{kinds:?}");
    for kind in &kinds {
        let allowed = GUEST_ALLOWED.contains(&kind.as_str());
        let is_refused = refused.contains(&kind.as_str());
        assert!(
            allowed != is_refused,
            "{kind} must be on exactly one of guests::GUEST_ALLOWED and GUEST_REFUSED \
             (allowed: {allowed}, refused: {is_refused})"
        );
    }
    let known: BTreeSet<&str> = kinds.iter().map(String::as_str).collect();
    for kind in GUEST_ALLOWED.iter().chain(&refused) {
        assert!(known.contains(kind), "{kind} isn't a command");
    }
    assert!(!GUEST_ALLOWED.iter().any(|k| k.starts_with("ird_")));
    assert_eq!(
        guests::classify("ird_file_return"),
        guests::ForGuests::Refused("file with IRD")
    );
    assert_eq!(
        guests::classify("a_command_from_next_year"),
        guests::ForGuests::Refused("do this")
    );
}

/// A payload of the right shape for each refused kind. The refusal comes before validation, so
/// only the shape matters.
fn payload(kind: &str, biz: &str, settings: &Value) -> Value {
    let coding = json!({ "direction": "out", "kind": "personal" });
    let template: Value = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let classes: Vec<Value> = serde_json::from_str(ASSET_CLASSES).unwrap();
    let class = &classes[0];
    let year = new_id();
    match kind {
        "create_invite" => json!({ "client_id": biz, "email": "x@example.nz", "token": token() }),
        "set_ai_suggestions" => json!({ "client_id": biz, "enabled": false }),
        "record_suggestions" => json!({ "client_id": biz, "model": "x", "suggestions": [] }),
        "change_own_password" => {
            json!({ "current_password": PASSWORD, "new_password": "a whole new password" })
        }
        "set_history_sharing" => json!({ "client_id": biz, "share_owner_edits": true }),
        "set_coding_settings" => json!({ "client_id": biz, "settings": settings }),
        "save_invoice_draft" => json!({ "html": "<p>X</p>" }),
        "save_invoice_template" => json!({ "name": "X", "html": "<p>X</p>" }),
        "delete_invoice_template" => json!({ "template_id": new_id() }),
        "add_invoice_image" => json!({ "content_base64": "iVBORw0KGgo=" }),
        "finalise_year" => json!({ "client_year_id": year, "accept_uncategorised": true }),
        "reopen_year" => json!({ "client_year_id": year, "reason": "X" }),
        "accept_invite" => json!({ "token": token() }),
        "start_guest" => json!({ "source": { "example": 1 } }),
        "adopt_guest_business" => json!({ "token": token() }),
        "sign_up" => json!({
            "email": "x@example.nz", "display_name": "X", "password": PASSWORD,
            "business_name": "X", "start_date": "2025-04-01",
        }),
        "initialise" => json!({
            "practice_name": "X", "username": "x", "display_name": "X", "password": PASSWORD,
        }),
        "create_user" => json!({
            "username": "x", "display_name": "X", "password": PASSWORD, "role": "staff",
        }),
        "reset_password" => json!({ "user_id": new_id(), "new_password": PASSWORD }),
        "set_user_active" => json!({ "user_id": new_id(), "active": false }),
        "install_starter_set" => json!({ "set": "company" }),
        "create_master_chart" => json!({ "entity_type": "company", "name": "X", "accounts": [] }),
        "add_master_account" => json!({
            "entity_type": "sole_trader",
            "account": { "code": "999", "name": "X", "account_type": "expense", "active": true },
        }),
        "rename_master_account" => {
            json!({ "entity_type": "sole_trader", "code": "100", "name": "X" })
        }
        "set_master_account_active" => {
            json!({ "entity_type": "sole_trader", "code": "100", "active": false })
        }
        "set_master_account_gst" => {
            json!({ "entity_type": "sole_trader", "code": "100", "default_gst": null })
        }
        "create_template" => json!({ "entity_type": "sole_trader", "name": "X", "body": template }),
        "revise_template" => json!({ "template_id": new_id(), "body": template }),
        "create_mapping" => json!({ "template_id": new_id(), "name": "X", "body": mapping }),
        "revise_mapping" => json!({ "mapping_id": new_id(), "body": mapping }),
        "move_year_layout" => json!({ "client_year_id": year }),
        "create_client" => json!({
            "name": "X", "entity_type": "sole_trader",
            "retained_earnings": "970", "rounding_priority": [],
        }),
        "add_account" => json!({
            "client_id": biz,
            "account": { "code": "999", "name": "X", "account_type": "expense", "active": true },
        }),
        "rename_account" => json!({ "client_id": biz, "code": "100", "name": "X" }),
        "set_account_active" => json!({ "client_id": biz, "code": "100", "active": false }),
        "set_account_gst" => json!({ "client_id": biz, "code": "100", "default_gst": null }),
        "set_rounding_priority" => json!({ "client_id": biz, "rounding_priority": [] }),
        "create_client_year" => {
            json!({ "client_id": biz, "start": "2030-04-01", "end": "2031-03-31" })
        }
        "post_journal" => json!({
            "client_year_id": year, "date": "2025-08-01", "narration": "X",
            "lines": [{ "account": "100", "amount": -1 }, { "account": "290", "amount": 1 }],
        }),
        "import_tb" => json!({ "client_year_id": year, "rows": [] }),
        "reverse_journal" => json!({ "journal_id": new_id() }),
        "create_asset_class" => json!({
            "entity_type": "sole_trader", "key": "x", "name": "X",
            "settings": class["settings"], "accounts": class["accounts"],
        }),
        "update_asset_class" => json!({
            "class_id": new_id(), "name": "X",
            "settings": class["settings"], "accounts": class["accounts"],
        }),
        "set_client_asset_class" => json!({ "client_id": biz, "class_id": new_id() }),
        "create_asset" => json!({
            "client_id": biz, "class_id": new_id(), "name": "X",
            "cost": 1, "residual": 0, "acquired": "2025-08-01",
        }),
        "update_asset" => json!({
            "asset_id": new_id(), "name": "X", "cost": 1, "residual": 0,
            "acquired": "2025-08-01",
        }),
        "delete_asset" | "reinstate_asset" => json!({ "asset_id": new_id() }),
        "dispose_asset" => json!({
            "asset_id": new_id(),
            "disposal": { "date": "2025-09-01", "proceeds": 0, "proceeds_account": "100" },
        }),
        "run_depreciation" => json!({ "client_year_id": year }),
        "apply_asset_class_defaults" => json!({ "client_id": biz, "class_id": new_id() }),
        "set_up_business" => json!({ "name": "X", "start_date": "2025-04-01" }),
        "add_merchant" => json!({
            "entity_type": "sole_trader", "description_contains": "X", "coding": coding,
        }),
        "remove_merchant" => json!({ "merchant_id": new_id() }),
        "add_paragraph" => json!({
            "entity_type": "sole_trader",
            "paragraph": { "key": "x", "placement": "note", "title": "X", "body": "X" },
        }),
        "revise_paragraph" => json!({
            "paragraph_id": new_id(), "placement": "note", "title": "X", "body": "X",
        }),
        "pick_notes" => json!({ "client_year_id": year, "paragraph_ids": [] }),
        "edit_note" => json!({
            "client_year_id": year, "paragraph_id": new_id(), "title": "X", "body": "X",
        }),
        "push_paragraph" | "remove_paragraph" => json!({ "paragraph_id": new_id() }),
        "start_impersonation" => json!({ "user_id": new_id(), "reason": "X" }),
        "end_impersonation" => json!({}),
        "allow_impersonation_changes" => json!({ "reason": "X" }),
        other => panic!("tests/guests.rs has no payload for the refused command {other}; add one"),
    }
}

#[tokio::test]
async fn each_refused_kind_is_refused_with_its_reason() {
    let server = server().await;
    let before = head_seq(&server).await;
    // A guest sends at most 60 commands a minute, so a fresh guest every 40.
    let mut guest = start(&server, file_source(OWN_FILE, OWN)).await;
    let before_own = head_seq(&server).await;
    let settings = server
        .get_json(
            &format!("/api/businesses/{}/coding-settings", guest.business_id),
            &guest.cookie,
        )
        .await["settings"]
        .clone();
    let mut sent = 0;
    for (kind, what) in GUEST_REFUSED {
        if sent == 40 {
            guest = start(&server, file_source(OWN_FILE, OWN)).await;
            sent = 0;
        }
        sent += 1;
        let (status, body) = server
            .command(
                &guest.cookie,
                kind,
                payload(kind, &guest.business_id, &settings),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{kind}: {body}");
        assert_eq!(body["code"], "guest", "{kind}: {body}");
        assert_eq!(
            body["message"],
            format!("Save your work first to {what}."),
            "{kind}"
        );
    }
    assert!(before_own > before);
    // Nothing refused reached the log: only the two starts did.
    let mut conn = server.state.store.reader().await.unwrap();
    let kinds: Vec<String> = log::after(&mut conn, before, 1000)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.kind)
        .collect();
    assert_eq!(kinds, ["start_guest", "start_guest"]);
}

#[tokio::test]
async fn a_guest_uses_only_the_routes_for_its_own_trial() {
    let server = server().await;
    let a = trial(&server).await;
    let public = [
        "/api/health",
        "/api/examples",
        "/api/login",
        "/api/logout",
        "/api/signup",
        "/api/guest",
    ];
    let mut refused = 0;
    for (method, path) in api_routes() {
        if public.contains(&path) || guests::route_allowed(&method, path) {
            continue;
        }
        let uri = fill(path, &a);
        let (status, body) =
            split(server.send(request(&method, &uri, &a.guest.cookie)).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
        assert_eq!(body["code"], "guest", "{method} {path}: {body}");
        refused += 1;
    }
    assert!(refused > 20, "only {refused} routes refused");
    let biz = &a.guest.business_id;
    for (path, message) in [
        (
            format!("/api/businesses/{biz}/ai-suggestions"),
            "Save your work first to use AI suggestions.",
        ),
        (
            "/api/invoices/draft".to_owned(),
            "Save your work first to make invoices.",
        ),
        ("/api/users".to_owned(), "Save your work first to do this."),
    ] {
        let (status, body) = split(server.send(get(&path, Some(&a.guest.cookie))).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{path}: {body}");
        assert_eq!(body["message"], message, "{path}");
    }
}

#[tokio::test]
async fn an_example_takes_no_files_and_a_big_file_is_refused_before_its_read() {
    let server = server().await;
    let g = start(&server, example_source(3)).await;
    for (kind, payload) in [
        (
            "import_statement",
            json!({
                "client_id": g.business_id, "file_name": OWN_FILE,
                "content_base64": base64(OWN),
            }),
        ),
        (
            "add_bank_account",
            json!({ "client_id": g.business_id, "name": "Mine" }),
        ),
    ] {
        let (status, body) = server.command(&g.cookie, kind, payload).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{kind}: {body}");
        assert_eq!(body["code"], "example", "{kind}: {body}");
    }

    let own = again(&server, &g, file_source(OWN_FILE, OWN)).await;
    let big = "A".repeat(1_500_000);
    let (status, body) = server
        .command(
            &g.cookie,
            "import_statement",
            json!({ "client_id": own.business_id, "file_name": "big.ofx", "content_base64": big }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "file_too_big");
    // As the first file of a trial, too.
    let (status, body) = split(
        post_guest(
            &server,
            json!({ "file": { "file_name": "big.ofx", "content_base64": "A".repeat(1_500_000) } }),
            None,
            None,
        )
        .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "file_too_big");
}

#[tokio::test]
async fn a_guest_slows_down_after_sixty_commands_a_minute() {
    let server = server().await;
    let g = start(&server, example_source(1)).await;
    let send = || async {
        let (status, body) = server
            .command(
                &g.cookie,
                "create_invite",
                payload("create_invite", &g.business_id, &Value::Null),
            )
            .await;
        (status, body)
    };
    for _ in 0..guests::COMMANDS_PER_MINUTE {
        let (status, body) = send().await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }
    // The 61st in a minute is refused; if a minute turned over meanwhile, the count started
    // again, so it comes within another 60.
    let mut limited = None;
    for _ in 0..=guests::COMMANDS_PER_MINUTE {
        let (status, body) = send().await;
        if status == StatusCode::TOO_MANY_REQUESTS {
            limited = Some(body);
            break;
        }
    }
    let body = limited.expect("a guest is slowed down");
    assert_eq!(body["code"], "slow_down");
    assert_eq!(
        body["message"],
        "Slow down a little. Try that again in a moment."
    );
}

// ---------------------------------------------------------------------------------------------
// Claiming.

/// The reads the owner screens need, as a guest or after claiming.
async fn screens(server: &Server, cookie: &str, biz: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for path in ["", "/tax", "/save-tax", "/rules"] {
        out.push(
            server
                .get_json(&format!("/api/businesses/{biz}{path}"), cookie)
                .await,
        );
    }
    out
}

/// Answers "Is this your only income?" yes, as a guest's Save tax card does.
async fn only_income(server: &Server, cookie: &str, biz: &str) {
    let (status, body) = server
        .command(
            cookie,
            "answer_question",
            json!({
                "client_id": biz, "income_year": 2026,
                "answer": { "question": "only_income", "yes": true },
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

async fn history(server: &Server, cookie: &str, biz: &str) -> Vec<Value> {
    server
        .get_json(&format!("/api/history?business={biz}"), cookie)
        .await["entries"]
        .as_array()
        .unwrap()
        .clone()
}

#[tokio::test]
async fn claiming_keeps_every_line_answer_and_figure() {
    let server = server().await;
    let a = trial(&server).await;
    let g = &a.guest;
    let biz = g.business_id.clone();
    only_income(&server, &g.cookie, &biz).await;
    let example = again(&server, g, example_source(1)).await.business_id;

    let before = screens(&server, &g.cookie, &biz).await;
    let lines_before = {
        let mut conn = server.state.store.reader().await.unwrap();
        bank_store::bank_lines(&mut conn, &biz).await.unwrap()
    };
    let changes = history(&server, &g.cookie, &biz).await;
    assert!(changes.len() >= 3, "{changes:?}");
    for e in &changes {
        if e["user_id"] == g.user_id.as_str() {
            assert_eq!(e["who"], "You (not saved yet)", "{e}");
        }
    }

    // Claiming with an email that's taken is refused, and changes nothing.
    sign_up(&server, "taken@example.nz").await;
    let claim = |email: &str| {
        json!({
            "id": new_id(), "email": email, "display_name": "Ana Ngata", "password": PASSWORD,
        })
    };
    let (status, body) = split(
        server
            .send(post_json(
                "/api/guest/claim",
                Some(&g.cookie),
                &claim("taken@example.nz"),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "email_taken");
    assert_eq!(
        body["message"],
        "There's already an account with that email. Sign in instead."
    );

    let response = server
        .send(post_json(
            "/api/guest/claim",
            Some(&g.cookie),
            &claim("ana@example.nz"),
        ))
        .await;
    let cookie = set_cookie(&response, "acct_session").expect("claiming carries on signed in");
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["business_id"], biz);
    assert_ne!(
        cookie, g.cookie,
        "a new session token once it has credentials"
    );

    // The guest's token is finished; the new one is an ordinary owner.
    let (status, _) = split(server.send(get("/api/me", Some(&g.cookie))).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let me = server.get_json("/api/me", &cookie).await;
    assert_eq!(me["id"], g.user_id.as_str(), "the same user");
    assert_eq!(me["username"], "ana@example.nz");
    assert_eq!(me["guest"], Value::Null);

    // Every line, answer and figure is as it was; the example is gone.
    let mut after = screens(&server, &cookie, &biz).await;
    // The one difference: an unsaved trial isn't asked to reconcile its opening balance (it has
    // only the statement it dropped); a saved business is. That card saves nothing.
    let cards = after[2]["cards"].as_array_mut().unwrap();
    let reconcile: Vec<Value> = cards
        .iter()
        .filter(|c| c["kind"] == "reconcile")
        .cloned()
        .collect();
    assert_eq!(reconcile.len(), 1, "{reconcile:?}");
    assert_eq!(reconcile[0]["saving"], 0);
    cards.retain(|c| c["kind"] != "reconcile");
    assert_eq!(after, before);
    let mut conn = server.state.store.reader().await.unwrap();
    assert_eq!(
        bank_store::bank_lines(&mut conn, &biz).await.unwrap(),
        lines_before
    );
    drop(conn);
    assert!(flags(&server, &example).await.is_none(), "the example went");
    let changes = history(&server, &cookie, &biz).await;
    for e in &changes {
        if e["user_id"] == g.user_id.as_str() {
            assert_eq!(e["who"], "Ana Ngata", "{e}");
        }
    }
    assert!(
        changes
            .iter()
            .any(|e| e["kind"] == "claim_guest" && e["who"] == "Ana Ngata"),
        "{changes:?}"
    );

    // They sign in with the new password.
    server.login("ana@example.nz").await;
    // And claiming again isn't a thing.
    let (status, body) = split(
        server
            .send(post_json(
                "/api/guest/claim",
                Some(&cookie),
                &claim("other@example.nz"),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "not_a_guest");
}

#[tokio::test]
async fn an_example_alone_cant_be_saved() {
    let server = server().await;
    let g = start(&server, example_source(2)).await;
    let (status, body) = split(
        server
            .send(post_json(
                "/api/guest/claim",
                Some(&g.cookie),
                &json!({
                    "id": new_id(), "email": "ana@example.nz",
                    "display_name": "Ana", "password": PASSWORD,
                }),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "example_only");
}

/// ADR 014, 4 (B): a guest who signs in to an account they have instead can move the trial in.
#[tokio::test]
async fn signing_in_instead_offers_to_move_the_trial_in() {
    let server = server().await;
    let (_, own_business) = sign_up(&server, "ana@example.nz").await;
    let a = trial(&server).await;
    let g = &a.guest;
    let lines_before = {
        let mut conn = server.state.store.reader().await.unwrap();
        bank_store::bank_lines(&mut conn, &g.business_id)
            .await
            .unwrap()
    };

    // Signing in from the guest's browser.
    let response = server
        .send(post_json(
            "/api/login",
            Some(&g.cookie),
            &json!({ "username": "ana@example.nz", "password": PASSWORD }),
        ))
        .await;
    let session = set_cookie(&response, "acct_session").unwrap();
    let kept = set_cookie(&response, guests::MOVE_COOKIE).expect("the trial's token is kept");
    let (status, me) = split(response).await;
    assert_eq!(status, StatusCode::OK, "{me}");
    assert_eq!(me["moveable_trial"]["statements"], 1, "{me}");
    assert_eq!(
        me["moveable_trial"]["lines"],
        i64::try_from(lines_before.len()).unwrap()
    );
    let both = format!("{session}; {kept}");
    let me = server.get_json("/api/me", &both).await;
    assert_eq!(me["moveable_trial"]["statements"], 1, "{me}");

    // A guest can't sign in at all: there's no password.
    let guest_name = format!("guest:{}", g.user_id);
    let (status, _) = split(
        server
            .send(post_json(
                "/api/login",
                None,
                &json!({ "username": guest_name, "password": "" }),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Moving it in: a business of its own in the account, with every line.
    let response = server
        .send(post_json(
            "/api/guest/adopt",
            Some(&both),
            &json!({ "id": new_id(), "move_it": true }),
        ))
        .await;
    assert!(
        response
            .headers()
            .get_all(header::SET_COOKIE)
            .iter()
            .any(|c| c
                .to_str()
                .unwrap()
                .starts_with(&format!("{}=;", guests::MOVE_COOKIE))),
        "the kept token is cleared"
    );
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["business_id"], g.business_id);
    let list = server.get_json("/api/clients", &session).await.to_string();
    assert!(
        list.contains(&g.business_id) && list.contains(&own_business),
        "{list}"
    );
    let mut conn = server.state.store.reader().await.unwrap();
    assert_eq!(
        bank_store::bank_lines(&mut conn, &g.business_id)
            .await
            .unwrap(),
        lines_before
    );
    let retired = users::get(&mut conn, &g.user_id).await.unwrap().unwrap();
    assert_eq!(retired.username, format!("expired:{}", g.user_id));
    assert_eq!(retired.display_name, "Ana Owner");
    assert!(!retired.active);
    drop(conn);
    let (status, _) = split(server.send(get("/api/me", Some(&g.cookie))).await).await;
    assert_eq!(
        status,
        StatusCode::UNAUTHORIZED,
        "the guest's session is gone"
    );
    // A moved trial is the owner's now, so the sweep leaves it alone.
    let swept = guests::sweep(&server.state.store, Utc::now() + Duration::days(30))
        .await
        .unwrap();
    assert_eq!(swept, 0);
    server
        .get_json(&format!("/api/businesses/{}", g.business_id), &session)
        .await;
}

#[tokio::test]
async fn leaving_the_trial_behind_lets_the_sweep_end_it() {
    let server = server().await;
    sign_up(&server, "ana@example.nz").await;
    let g = start(&server, file_source(OWN_FILE, OWN)).await;
    let response = server
        .send(post_json(
            "/api/login",
            Some(&g.cookie),
            &json!({ "username": "ana@example.nz", "password": PASSWORD }),
        ))
        .await;
    let session = set_cookie(&response, "acct_session").unwrap();
    let kept = set_cookie(&response, guests::MOVE_COOKIE).unwrap();
    let (status, body) = split(
        server
            .send(post_json(
                "/api/guest/adopt",
                Some(&format!("{session}; {kept}")),
                &json!({ "id": new_id(), "move_it": false }),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["business_id"], Value::Null);
    // No session is left, so the very next sweep ends it.
    let swept = guests::sweep(&server.state.store, Utc::now())
        .await
        .unwrap();
    assert_eq!(swept, 1);
    assert!(flags(&server, &g.business_id).await.is_none());
}

// ---------------------------------------------------------------------------------------------
// Expiry.

/// Every row of every table, each row as text, sorted: what "byte-identical" is checked against.
async fn dump(server: &Server) -> BTreeMap<String, Vec<String>> {
    let mut conn = server.state.store.reader().await.unwrap();
    let tables: Vec<(String,)> = sqlx::query_as(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         ORDER BY name",
    )
    .fetch_all(&mut *conn)
    .await
    .unwrap();
    let mut out = BTreeMap::new();
    for (table,) in tables {
        let columns: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM pragma_table_info(?) ORDER BY cid")
                .bind(&table)
                .fetch_all(&mut *conn)
                .await
                .unwrap();
        let row = columns
            .iter()
            .map(|(c,)| format!("'{c}=' || quote(\"{c}\")"))
            .collect::<Vec<_>>()
            .join(" || ' | ' || ");
        // Table and column names come from the database itself.
        let sql = format!("SELECT {row} FROM \"{table}\" ORDER BY 1");
        let rows: Vec<(String,)> = sqlx::query_as(sqlx::AssertSqlSafe(sql))
            .fetch_all(&mut *conn)
            .await
            .unwrap();
        out.insert(table, rows.into_iter().map(|(r,)| r).collect());
    }
    out
}

#[tokio::test]
async fn expiry_deletes_the_trial_and_leaves_everything_else_byte_identical() {
    let server = server().await;
    // Someone else's business, with lines, to stay exactly as it is.
    let (owner, other) = sign_up(&server, "ana@example.nz").await;
    server
        .ok(
            &owner,
            "import_statement",
            json!({
                "client_id": other, "file_name": "kowhai.csv", "content_base64": base64(KOWHAI),
            }),
        )
        .await;
    let before = dump(&server).await;
    let seq_before = head_seq(&server).await;

    // A trial: the visitor's own file, an answer, a rule naming one of their lines, an example.
    let g = start(&server, file_source(OWN_FILE, OWN)).await;
    let own = g.business_id.clone();
    let (descriptions, other_descriptions) = {
        let mut conn = server.state.store.reader().await.unwrap();
        let mine: Vec<String> = bank_store::bank_lines(&mut conn, &own)
            .await
            .unwrap()
            .into_iter()
            .map(|l| l.description)
            .collect();
        let theirs: BTreeSet<String> = bank_store::bank_lines(&mut conn, &other)
            .await
            .unwrap()
            .into_iter()
            .map(|l| l.description)
            .collect();
        (mine, theirs)
    };
    // Only descriptions that are the trial's alone say anything when they're missing.
    let descriptions: Vec<String> = descriptions
        .into_iter()
        .filter(|d| d.len() >= 8 && !other_descriptions.contains(d))
        .collect();
    assert!(!descriptions.is_empty());
    only_income(&server, &g.cookie, &own).await;
    server
        .ok(
            &g.cookie,
            "add_rule",
            json!({
                "client_id": own, "description_contains": descriptions[0],
                "coding": { "direction": "out", "kind": "personal" },
            }),
        )
        .await;
    let example = again(&server, &g, example_source(1)).await.business_id;
    let trial = [own.clone(), example.clone()];

    // A day later the example has finished; the guest's own trial is still live.
    let swept = guests::sweep(&server.state.store, Utc::now() + Duration::hours(25))
        .await
        .unwrap();
    assert_eq!(swept, 1);
    assert!(flags(&server, &example).await.is_none());
    assert!(flags(&server, &own).await.is_some());
    // Eight days on, nobody has been back: it's ended, and a second sweep finds nothing.
    let swept = guests::sweep(&server.state.store, Utc::now() + Duration::days(8))
        .await
        .unwrap();
    assert_eq!(swept, 1);
    let swept = guests::sweep(&server.state.store, Utc::now() + Duration::days(8))
        .await
        .unwrap();
    assert_eq!(swept, 0);
    let (status, _) = split(server.send(get("/api/me", Some(&g.cookie))).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Every table but the log, users and sessions is exactly as before the trial.
    let after = dump(&server).await;
    assert_eq!(
        before.keys().collect::<Vec<_>>(),
        after.keys().collect::<Vec<_>>()
    );
    for (table, rows) in &before {
        if ["command_log", "users", "sessions"].contains(&table.as_str()) {
            continue;
        }
        assert_eq!(&after[table], rows, "{table} changed");
    }
    // Users: everyone from before unchanged, plus the guest's row, holding nothing of theirs.
    let added: Vec<&String> = after["users"]
        .iter()
        .filter(|r| !before["users"].contains(r))
        .collect();
    assert_eq!(added.len(), 1, "{added:?}");
    assert!(before["users"].iter().all(|r| after["users"].contains(r)));
    let mut conn = server.state.store.reader().await.unwrap();
    let retired = users::get(&mut conn, &g.user_id).await.unwrap().unwrap();
    assert_eq!(retired.username, format!("expired:{}", g.user_id));
    assert_eq!(retired.display_name, "Expired guest");
    assert_eq!(retired.password_hash, "");
    assert!(!retired.active);
    let (sessions,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM sessions WHERE user_id = ?")
        .bind(&g.user_id)
        .fetch_one(&mut *conn)
        .await
        .unwrap();
    assert_eq!(sessions, 0);

    // No row outside the log names the trial's businesses.
    for (table, rows) in &after {
        if table == "command_log" {
            continue;
        }
        for row in rows {
            for id in &trial {
                assert!(
                    !row.contains(id.as_str()),
                    "{table} still names {id}: {row}"
                );
            }
        }
    }

    // The log: the trial's rows are redacted, and nothing anywhere holds its file name or lines.
    let entries = log::after(&mut conn, 0, 100_000).await.unwrap();
    let mut redacted = 0;
    for e in &entries {
        let text = format!(
            "{} {} {} {}",
            e.payload,
            e.result,
            e.changes.as_deref().unwrap_or(""),
            e.via.as_deref().unwrap_or("")
        );
        assert!(
            !text.contains(OWN_FILE),
            "seq {} holds the file name: {text}",
            e.seq
        );
        for d in &descriptions {
            assert!(
                !text.contains(d.as_str()),
                "seq {} holds {d:?}: {text}",
                e.seq
            );
        }
        let about_trial = e.client_id.as_ref().is_some_and(|c| trial.contains(c));
        if about_trial {
            redacted += 1;
            assert_eq!(e.payload, r#"{"redacted":"guest"}"#, "seq {}", e.seq);
            assert_eq!(e.changes, None, "seq {}", e.seq);
            assert!(e.redacted_seq.is_some(), "seq {}", e.seq);
        } else {
            assert_eq!(e.redacted_seq, None, "seq {} isn't the trial's", e.seq);
        }
    }
    // start, answer, rule and the example's add: at least four.
    assert!(redacted >= 4, "{redacted}");
    // Every seq is still there: the log is gapless.
    let seqs: Vec<i64> = entries.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, (1..=seqs.len() as i64).collect::<Vec<_>>());
    assert!(seqs.len() as i64 > seq_before);
    // Two expiries, both the server's.
    let ends = log::of_kind(&mut conn, "expire_guest").await.unwrap();
    assert_eq!(ends.len(), 2);
    assert!(ends.iter().all(|e| e.user_id.is_none()));
}

#[tokio::test]
async fn a_guest_deletes_their_own_trial_and_nobody_elses() {
    let server = server().await;
    let a = start(&server, file_source(OWN_FILE, OWN)).await;
    let b = start(&server, file_source(OWN_FILE, OWN)).await;
    let (status, body) = server
        .command(
            &b.cookie,
            "expire_guest",
            json!({ "client_id": a.business_id, "why": "by_you" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    // Only the server ends a trial as unused.
    let (status, body) = server
        .command(
            &a.cookie,
            "expire_guest",
            json!({ "client_id": a.business_id, "why": "unused" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "server_only");

    server
        .ok(
            &a.cookie,
            "expire_guest",
            json!({ "client_id": a.business_id, "why": "by_you" }),
        )
        .await;
    assert!(flags(&server, &a.business_id).await.is_none());
    let (status, _) = split(server.send(get("/api/me", Some(&a.cookie))).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    server.get_json("/api/me", &b.cookie).await;
    assert!(flags(&server, &b.business_id).await.is_some());
}

// ---------------------------------------------------------------------------------------------
// The per-address limits (ADR 014, 8).

#[tokio::test]
async fn the_per_address_limit_refuses_the_next_trial() {
    let mut server = server().await;
    server.state.guest_limits = Arc::new(Limits::new(2, 3));
    let here = "203.0.113.5:40000";
    let start_from = |source: Value, address: &'static str| {
        let server = &server;
        async move { post_guest(server, source, None, Some(address)).await }
    };

    for _ in 0..2 {
        let response = start_from(file_source(OWN_FILE, OWN), here).await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = start_from(file_source(OWN_FILE, OWN), here).await;
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], "too_many_trials");
    let message = body["message"].as_str().unwrap();
    assert!(
        message.starts_with("Lots of people on your network have tried this in the last hour.")
            && message.ends_with("or sign up to carry on."),
        "{message}"
    );

    // Examples have their own count from the same address.
    for _ in 0..3 {
        let response = start_from(example_source(1), here).await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let (status, body) = split(start_from(example_source(1), here).await).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("tried the examples"),
        "{body}"
    );

    // Another address, and an IPv6 address in another /64, start as normal; the same /64 doesn't.
    let response = start_from(file_source(OWN_FILE, OWN), "198.51.100.7:40000").await;
    assert_eq!(response.status(), StatusCode::OK);
    for _ in 0..2 {
        let response = start_from(file_source(OWN_FILE, OWN), "[2001:db8:1:2::5]:40000").await;
        assert_eq!(response.status(), StatusCode::OK);
    }
    let response = start_from(file_source(OWN_FILE, OWN), "[2001:db8:1:2::9]:40000").await;
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
}
