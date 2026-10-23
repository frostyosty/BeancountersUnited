//! M12's tenancy check: two business owners sign up, and neither can read or change the other's
//! business through any route or any command.
//!
//! The routes come from `acct_server::api_routes()` (what the router is built from) and the command
//! kinds from the `Command` enum itself, so a new route or command that this file doesn't cover
//! fails here.

mod common;

use std::collections::BTreeSet;

use acct_server::access::route_rule;
use acct_server::api_routes;
use acct_server::commands::Command;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const ASSET_CLASSES: &str =
    include_str!("../../../fixtures/practice/sole-trader-asset-classes.json");
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

/// Every command kind, from the `Command` enum's own list of variants: serde names them all when
/// it meets one it doesn't know.
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

/// One owner's sign-up: their cookie, user id and business.
struct Owner {
    cookie: String,
    user_id: String,
    business_id: String,
}

async fn sign_up(server: &Server, email: &str, business: &str) -> Owner {
    let response = server
        .send(post_json(
            "/api/signup",
            None,
            &json!({
                "id": new_id(),
                "email": email,
                "display_name": email.split('@').next().unwrap(),
                "password": PASSWORD,
                "business_name": business,
                "start_date": "2025-04-01",
            }),
        ))
        .await;
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .map(|c| c.to_str().unwrap().split(';').next().unwrap().to_owned());
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "sign-up: {body}");
    assert_eq!(body["me"]["role"], "business_owner");
    Owner {
        cookie: cookie.expect("sign-up signs you in"),
        user_id: body["me"]["id"].as_str().unwrap().to_owned(),
        business_id: body["business_id"].as_str().unwrap().to_owned(),
    }
}

/// Everything of owner A's that an attacker could name.
struct Victim {
    owner: Owner,
    year_id: String,
    bank_account_id: String,
    lines: Vec<String>,
    rule_id: String,
    journal_id: String,
    asset_id: String,
    class_id: String,
    invite_token: String,
    template_id: String,
    mapping_id: String,
    coding_settings: Value,
}

impl Victim {
    /// Every id of A's, so a 404 can be told apart from a typo in this file.
    fn ids(&self) -> BTreeSet<String> {
        let mut ids: BTreeSet<String> = [
            &self.owner.business_id,
            &self.year_id,
            &self.bank_account_id,
            &self.rule_id,
            &self.journal_id,
            &self.asset_id,
        ]
        .into_iter()
        .cloned()
        .collect();
        ids.extend(self.lines.iter().cloned());
        ids
    }
}

/// A practice with the sole-trader defaults, owner A's business with data of every kind (some of
/// it made by `sam`, A's accountant, through an invite), and owner B.
async fn setup() -> (Server, Victim, Owner) {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let accounts: Value = serde_json::from_str(CHART).unwrap();
    server
        .ok(
            &boss,
            "create_master_chart",
            json!({ "entity_type": "sole_trader", "name": "Sole trader", "accounts": accounts }),
        )
        .await;
    let template: Value = serde_json::from_str(TEMPLATE).unwrap();
    let template_id = server
        .ok(
            &boss,
            "create_template",
            json!({ "entity_type": "sole_trader", "name": "Sole trader", "body": template }),
        )
        .await;
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let mapping_id = server
        .ok(
            &boss,
            "create_mapping",
            json!({ "template_id": template_id, "name": "Sole trader", "body": mapping }),
        )
        .await;
    let classes: Vec<Value> = serde_json::from_str(ASSET_CLASSES).unwrap();
    let mut class_id = String::new();
    for class in &classes {
        let id = server
            .ok(
                &boss,
                "create_asset_class",
                json!({
                    "entity_type": "sole_trader",
                    "key": class["key"],
                    "name": class["name"],
                    "settings": class["settings"],
                    "accounts": class["accounts"],
                }),
            )
            .await;
        if class["key"] == "tools" {
            class_id = id;
        }
    }

    let a = sign_up(&server, "ana@example.nz", "Ana's Gardens").await;
    let b = sign_up(&server, "ben@example.nz", "Ben's Bikes").await;
    let biz = a.business_id.clone();

    server
        .ok(
            &a.cookie,
            "import_statement",
            json!({
                "client_id": biz,
                "file_name": "kowhai-business-2025-08.csv",
                "content_base64": base64(KOWHAI),
            }),
        )
        .await;
    let business = server
        .get_json(&format!("/api/businesses/{biz}"), &a.cookie)
        .await;
    let bank_account_id = business["bank_accounts"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let queue = server
        .get_json(&format!("/api/businesses/{biz}/save-tax"), &a.cookie)
        .await;
    let mut lines: Vec<String> = Vec::new();
    collect_line_ids(&queue, &mut lines);
    lines.sort();
    lines.dedup();
    assert!(lines.len() >= 2, "A needs two bank lines: {queue}");
    let rule_id = server
        .ok(
            &a.cookie,
            "add_rule",
            json!({
                "client_id": biz,
                "description_contains": "NO SUCH SHOP",
                "coding": { "direction": "out", "kind": "personal" },
            }),
        )
        .await;
    let coding_settings = server
        .get_json(&format!("/api/businesses/{biz}/coding-settings"), &a.cookie)
        .await["settings"]
        .clone();

    // A invites their accountant; sam accepts and adds a journal and an asset.
    let invite_token = token();
    server
        .ok(
            &a.cookie,
            "create_invite",
            json!({ "client_id": biz, "email": "sam@practice.nz", "token": invite_token }),
        )
        .await;
    let sam = server.login("sam").await;
    let (status, _) = split(
        server
            .send(get(&format!("/api/clients/{biz}"), Some(&sam)))
            .await,
    )
    .await;
    assert_eq!(
        status,
        StatusCode::NOT_FOUND,
        "sam can't see A before accepting"
    );
    server
        .ok(&sam, "accept_invite", json!({ "token": invite_token }))
        .await;
    let client = server.get_json(&format!("/api/clients/{biz}"), &sam).await;
    let year_id = client["years"][0]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("A's business has a year: {client}"))
        .to_owned();
    let start = client["years"][0]["start"].as_str().unwrap().to_owned();
    let journal_id = server
        .ok(
            &sam,
            "post_journal",
            json!({
                "client_year_id": year_id,
                "date": start,
                "narration": "Accountant's adjustment",
                "lines": [
                    { "account": "100", "amount": -1000 },
                    { "account": "290", "amount": 1000 },
                ],
            }),
        )
        .await;
    let asset_id = server
        .ok(
            &sam,
            "create_asset",
            json!({
                "client_id": biz,
                "class_id": class_id,
                "name": "Mower",
                "cost": 50000,
                "residual": 0,
                "acquired": start,
            }),
        )
        .await;

    // A fresh invite, unaccepted, for B to try.
    let open_token = token();
    server
        .ok(
            &a.cookie,
            "create_invite",
            json!({ "client_id": biz, "email": "someone@practice.nz", "token": open_token }),
        )
        .await;

    let victim = Victim {
        owner: a,
        year_id,
        bank_account_id,
        lines,
        rule_id,
        journal_id,
        asset_id,
        class_id,
        invite_token: open_token,
        template_id,
        mapping_id,
        coding_settings,
    };
    (server, victim, b)
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

/// A's id for a path parameter.
fn param(path: &str, name: &str, v: &Victim) -> String {
    match name {
        "id" if path.starts_with("/api/years/") => v.year_id.clone(),
        "id" => v.owner.business_id.clone(),
        "class_id" => v.class_id.clone(),
        "entity_type" => "sole_trader".to_owned(),
        other => panic!("{path}: no value for {{{other}}}; add one here"),
    }
}

fn fill(path: &str, v: &Victim) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').unwrap() + open;
        out.push_str(&rest[..open]);
        out.push_str(&param(path, &rest[open + 1..close], v));
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

/// No login needed.
const PUBLIC: [&str; 4] = ["/api/health", "/api/login", "/api/logout", "/api/signup"];
/// About the signed-in user only, or checked per command (`/api/commands`, covered below).
const OWN: [&str; 2] = ["/api/me", "/api/commands"];
/// The practice's own data. No business owner sees it.
const PRACTICE: [&str; 4] = [
    "/api/practice",
    "/api/users",
    "/api/asset-classes",
    "/api/merchants/{entity_type}",
];
/// Lists that mix businesses: B sees them, filtered to B's own.
const LISTS: [&str; 2] = ["/api/clients", "/api/sync"];

#[test]
fn every_route_has_an_access_rule() {
    for (method, path) in api_routes() {
        assert!(
            route_rule(&method, path).is_some(),
            "{method} {path} has no rule in access::route_rule, so it's refused for everyone"
        );
    }
}

#[tokio::test]
async fn an_owner_reaches_no_route_into_another_owners_business() {
    let (server, a, b) = setup().await;
    let name = "Ana's Gardens";
    let a_ids = a.ids();
    // A's accountant, who can do everything on A's business that a route offers.
    let sam = server.login("sam").await;
    for (method, path) in api_routes() {
        if PUBLIC.contains(&path) || OWN.contains(&path) {
            continue;
        }
        let uri = fill(path, &a);
        let request = |cookie: &str| {
            let r = Request::builder()
                .method(method.clone())
                .uri(&uri)
                .header(header::COOKIE, cookie);
            if method == Method::POST {
                r.header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from("{}"))
                    .unwrap()
            } else {
                r.body(Body::empty()).unwrap()
            }
        };
        let (status, body) = split(server.send(request(&b.cookie)).await).await;
        let text = body.to_string();
        if PRACTICE.contains(&path) {
            assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}: {body}");
        } else if LISTS.contains(&path) {
            assert_eq!(status, StatusCode::OK, "{method} {path}: {body}");
            assert!(
                !text.contains(&a.owner.business_id) && !text.contains(name),
                "{method} {path} shows B something of A's: {body}"
            );
            assert!(
                text.contains(&b.business_id),
                "{method} {path} should still show B's own: {body}"
            );
        } else if path.contains("{id}") {
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}: {body}");
            // Not found names only the id B sent, and it's a real one of A's.
            assert!(
                a_ids.contains(body["details"]["id"].as_str().unwrap_or("")),
                "{body}"
            );
            assert!(!text.contains(name), "{body}");
            // A's accountant, with the same request, gets past the access check.
            let (status, body) = split(server.send(request(&sam)).await).await;
            assert!(
                status != StatusCode::NOT_FOUND && status != StatusCode::FORBIDDEN,
                "{method} {path} as A's accountant: {status} {body}"
            );
        } else {
            panic!("{method} {path} isn't classified in tests/tenancy.rs");
        }
    }
}

/// B's attempt at each command kind, aimed at A's data where the command names any.
fn attack(kind: &str, v: &Victim) -> Option<Value> {
    let biz = &v.owner.business_id;
    let line = &v.lines[0];
    let coding = json!({ "direction": "out", "kind": "personal" });
    let template: Value = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let classes: Vec<Value> = serde_json::from_str(ASSET_CLASSES).unwrap();
    let class = &classes[0];
    Some(match kind {
        // Only ever B's own account.
        "change_own_password" => return None,
        "initialise" => json!({
            "practice_name": "Mine now", "username": "mallory",
            "display_name": "Mallory", "password": PASSWORD,
        }),
        "sign_up" => json!({
            "email": "mallory@example.nz", "display_name": "Mallory", "password": PASSWORD,
            "business_name": "Mallory's", "start_date": "2025-04-01",
        }),
        "create_user" => json!({
            "username": "mallory", "display_name": "Mallory",
            "password": PASSWORD, "role": "overseer",
        }),
        "reset_password" => json!({ "user_id": v.owner.user_id, "new_password": PASSWORD }),
        "set_user_active" => json!({ "user_id": v.owner.user_id, "active": false }),
        "create_master_chart" => json!({ "entity_type": "company", "name": "X", "accounts": [] }),
        "create_template" => {
            json!({ "entity_type": "sole_trader", "name": "X", "body": template })
        }
        "revise_template" => json!({ "template_id": v.template_id, "body": template }),
        "create_mapping" => {
            json!({ "template_id": v.template_id, "name": "X", "body": mapping })
        }
        "revise_mapping" => json!({ "mapping_id": v.mapping_id, "body": mapping }),
        "create_asset_class" => json!({
            "entity_type": "sole_trader", "key": "x", "name": "X",
            "settings": class["settings"], "accounts": class["accounts"],
        }),
        "update_asset_class" => json!({
            "class_id": v.class_id, "name": "X",
            "settings": class["settings"], "accounts": class["accounts"],
        }),
        "add_merchant" => json!({
            "entity_type": "sole_trader", "description_contains": "X", "coding": coding,
        }),
        "remove_merchant" => json!({ "merchant_id": new_id() }),
        "create_client" => json!({
            "name": "X", "entity_type": "sole_trader",
            "retained_earnings": "970", "rounding_priority": [],
        }),
        "set_up_business" => json!({ "name": "X", "start_date": "2025-04-01" }),
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
            "client_year_id": v.year_id, "date": "2025-08-01", "narration": "X",
            "lines": [{ "account": "100", "amount": -1 }, { "account": "290", "amount": 1 }],
        }),
        "import_tb" => json!({ "client_year_id": v.year_id, "rows": [] }),
        "reverse_journal" => json!({ "journal_id": v.journal_id }),
        "run_depreciation" => json!({ "client_year_id": v.year_id }),
        "set_client_asset_class" => json!({ "client_id": biz, "class_id": v.class_id }),
        "apply_asset_class_defaults" => json!({ "client_id": biz, "class_id": v.class_id }),
        "create_asset" => json!({
            "client_id": biz, "class_id": v.class_id, "name": "X",
            "cost": 1, "residual": 0, "acquired": "2025-08-01",
        }),
        "update_asset" => json!({
            "asset_id": v.asset_id, "name": "X", "cost": 1, "residual": 0,
            "acquired": "2025-08-01",
        }),
        "delete_asset" => json!({ "asset_id": v.asset_id }),
        "dispose_asset" => json!({
            "asset_id": v.asset_id,
            "disposal": { "date": "2025-09-01", "proceeds": 0, "proceeds_account": "100" },
        }),
        "reinstate_asset" => json!({ "asset_id": v.asset_id }),
        "add_bank_account" => json!({ "client_id": biz, "name": "X" }),
        "add_card_account" => json!({ "client_id": biz, "name": "X" }),
        "import_statement" => json!({
            "client_id": biz, "file_name": "x.csv", "content_base64": base64(KOWHAI),
        }),
        "set_opening_balance" => json!({ "bank_account_id": v.bank_account_id, "balance": 0 }),
        "code_bank_line" => json!({ "bank_line_id": line, "coding": coding }),
        "code_bank_lines" => json!({ "lines": [{ "bank_line_id": line, "coding": coding }] }),
        "add_rule" => json!({
            "client_id": biz, "description_contains": "X", "coding": coding,
        }),
        "remove_rule" => json!({ "rule_id": v.rule_id }),
        "answer_question" => json!({
            "client_id": biz, "income_year": 2026,
            "answer": { "question": "only_income", "yes": true },
        }),
        "confirm_transfer" => json!({ "out_line_id": v.lines[0], "in_line_id": v.lines[1] }),
        "confirm_ird_payment" => json!({ "bank_line_id": line, "payment": { "kind": "gst" } }),
        "resolve_duplicate" => json!({ "bank_line_id": line, "is_duplicate": true }),
        "confirm_supply_info" => json!({ "bank_line_id": line }),
        "set_coding_settings" => json!({ "client_id": biz, "settings": v.coding_settings }),
        "set_ai_suggestions" => json!({ "client_id": biz, "enabled": false }),
        "record_suggestions" => json!({ "client_id": biz, "model": "x", "suggestions": [] }),
        "create_invite" => json!({
            "client_id": biz, "email": "mallory@example.nz", "token": token(),
        }),
        "accept_invite" => json!({ "token": v.invite_token }),
        other => panic!("tests/tenancy.rs has no attack for the new command {other}; add one"),
    })
}

#[tokio::test]
async fn an_owner_can_submit_no_command_against_another_owners_business() {
    let (server, a, b) = setup().await;
    let kinds = all_kinds();
    assert!(kinds.len() > 40, "{kinds:?}");
    let a_ids = a.ids();
    let head = |s: &Server| {
        let state = s.state.clone();
        async move {
            let mut conn = state.store.reader().await.unwrap();
            acct_store::log::head_seq(&mut conn).await.unwrap()
        }
    };
    let before = head(&server).await;
    let mut not_found = BTreeSet::new();
    for kind in &kinds {
        let Some(payload) = attack(kind, &a) else {
            continue;
        };
        let (status, body) = server.command(&b.cookie, kind, payload).await;
        // Only the access check's answers count: a 400 or 422 would mean this file's payload is
        // wrong, not that B was stopped.
        match status {
            StatusCode::FORBIDDEN => {}
            StatusCode::NOT_FOUND => {
                let id = body["details"]["id"].as_str().unwrap_or("");
                assert!(
                    a_ids.contains(id),
                    "{kind}: not found names {id:?}, not A's: {body}"
                );
                not_found.insert(kind.as_str());
            }
            _ => panic!("{kind}: B got {status} {body}"),
        }
    }
    assert_eq!(
        head(&server).await,
        before,
        "a rejected command left something in the log"
    );
    // The owner's own kinds of work get past the role check, so it's tenancy that stops them, and
    // they're told A's things don't exist. Everything else is beyond an owner's role.
    let owners_work: BTreeSet<&str> = [
        "add_bank_account",
        "add_card_account",
        "add_rule",
        "answer_question",
        "code_bank_line",
        "code_bank_lines",
        "confirm_ird_payment",
        "confirm_supply_info",
        "confirm_transfer",
        "create_invite",
        "import_statement",
        "record_suggestions",
        "remove_rule",
        "resolve_duplicate",
        "set_ai_suggestions",
        "set_opening_balance",
    ]
    .into();
    assert_eq!(not_found, owners_work);
}

#[tokio::test]
async fn the_practice_sees_an_owners_business_only_once_invited() {
    let (server, a, b) = setup().await;
    let boss = server.login("boss").await;
    let val = server.login("val").await;
    let sam = server.login("sam").await;
    let biz = &a.owner.business_id;

    // sam accepted A's invite; boss and val didn't, and see neither business.
    let list = server.get_json("/api/clients", &sam).await.to_string();
    assert!(
        list.contains(biz.as_str()) && !list.contains(&b.business_id),
        "{list}"
    );
    for cookie in [&boss, &val] {
        let list = server.get_json("/api/clients", cookie).await.to_string();
        assert!(!list.contains(biz.as_str()), "{list}");
        let (status, _) = split(
            server
                .send(get(&format!("/api/businesses/{biz}"), Some(cookie)))
                .await,
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }

    // A practice admin can't take over an owner's account.
    let (status, body) = server
        .command(
            &boss,
            "reset_password",
            json!({ "user_id": a.owner.user_id, "new_password": "a whole new password" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let users = server.get_json("/api/users", &boss).await.to_string();
    assert!(!users.contains("ana@example.nz"), "{users}");

    // An invite works once.
    let (status, body) = server
        .command(&val, "accept_invite", json!({ "token": a.invite_token }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = server
        .command(&boss, "accept_invite", json!({ "token": a.invite_token }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "invite_unusable");
    // val can now read A's business, but a viewer still can't change it.
    server
        .get_json(&format!("/api/businesses/{biz}"), &val)
        .await;
    let (status, _) = server
        .command(
            &val,
            "add_bank_account",
            json!({ "client_id": biz, "name": "X" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn an_owner_does_only_the_owners_work_on_their_own_business() {
    let (server, a, _b) = setup().await;
    let biz = &a.owner.business_id;
    let (status, body) = server
        .command(
            &a.owner.cookie,
            "post_journal",
            attack("post_journal", &a).unwrap(),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    let (status, body) = server
        .command(
            &a.owner.cookie,
            "add_card_account",
            json!({ "client_id": biz, "name": "Visa" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

#[tokio::test]
async fn sign_up_needs_its_password_to_sign_in_again() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let accounts: Value = serde_json::from_str(CHART).unwrap();
    server
        .ok(
            &boss,
            "create_master_chart",
            json!({ "entity_type": "sole_trader", "name": "Sole trader", "accounts": accounts }),
        )
        .await;
    let body = |password: &str, id: &str| {
        json!({
            "id": id, "email": "ana@example.nz", "display_name": "Ana",
            "password": password, "business_name": "Ana's", "start_date": "2025-04-01",
        })
    };
    let id = new_id();
    let (status, first) = split(
        server
            .send(post_json("/api/signup", None, &body(PASSWORD, &id)))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    // Resubmitting the same id returns the original result, but no session without the password.
    let (status, _) = split(
        server
            .send(post_json(
                "/api/signup",
                None,
                &body("wrong password!", &id),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    // The same email again is refused.
    let (status, again) = split(
        server
            .send(post_json("/api/signup", None, &body(PASSWORD, &new_id())))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(again["code"], "email_taken");
    // Sign-up can't come through /api/commands.
    let (status, _) = server
        .command(&boss, "sign_up", body(PASSWORD, &new_id()))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    // The log keeps neither the password nor an invite token.
    let mut conn = server.state.store.reader().await.unwrap();
    let all = acct_store::log::after(&mut conn, 0, 500).await.unwrap();
    assert!(all.iter().all(|e| !e.payload.contains(PASSWORD)));
}

#[tokio::test]
async fn only_an_overseer_makes_an_overseer_and_it_sees_every_business() {
    let (server, a, b) = setup().await;
    let boss = server.login("boss").await;
    let overseer = json!({
        "username": "olive", "display_name": "Olive",
        "password": PASSWORD, "role": "overseer",
    });
    let (status, body) = server.command(&boss, "create_user", overseer.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // The server itself, acting as an overseer, can.
    let system = acct_server::pipeline::Actor {
        user_id: None,
        role: acct_store::users::Role::Overseer,
    };
    let envelope = acct_server::commands::CommandEnvelope {
        id: new_id(),
        command: serde_json::from_value(json!({ "kind": "create_user", "payload": overseer }))
            .unwrap(),
    };
    acct_server::pipeline::submit(&server.state.store, &system, envelope, chrono::Utc::now())
        .await
        .unwrap();
    let olive = server.login("olive").await;
    let list = server.get_json("/api/clients", &olive).await.to_string();
    assert!(
        list.contains(&a.owner.business_id) && list.contains(&b.business_id),
        "{list}"
    );
    let users = server.get_json("/api/users", &olive).await.to_string();
    assert!(users.contains("ana@example.nz"), "{users}");
}
