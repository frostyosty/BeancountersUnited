//! M19: an overseer views as someone else (ADR 013). Who may start, what reads look like while
//! acting, what's refused, how changes are turned on, and how it ends: by End, by sign-out, and
//! by the sweep when it times out or the person changes.
//!
//! The practice and businesses are set up as `tests/tenancy.rs` sets them up: owner Ana's
//! business, with an upload, a line Ana coded herself (an owner edit hidden from her accountants)
//! and work by `sam`, her accountant, through an invite; and owner Ben's, which sam can't see.

mod common;

use std::collections::BTreeSet;

use acct_server::access::{RouteRule, WhileActing as RouteWhileActing, while_acting};
use acct_server::api_routes;
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::impersonation::{self, ALLOWED, AS_YOURSELF, NEVER, SESSION, WhileActing};
use acct_server::pipeline::{Actor, submit};
use acct_store::users::Role;
use axum::http::{Method, StatusCode, header};
use chrono::{Duration, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const ASSET_CLASSES: &str =
    include_str!("../../../fixtures/practice/sole-trader-asset-classes.json");
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

/// Every command kind, from the `Command` enum's own list of variants (as `tests/tenancy.rs`
/// does it): serde names them all when it meets one it doesn't know.
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
    Owner {
        cookie: cookie.expect("sign-up signs you in"),
        user_id: body["me"]["id"].as_str().unwrap().to_owned(),
        business_id: body["business_id"].as_str().unwrap().to_owned(),
    }
}

/// The practice, the two businesses, and the overseers `olive` and `oscar`.
struct World {
    server: Server,
    ana: Owner,
    ben: Owner,
    year_id: String,
    bank_account_id: String,
    statement_id: String,
    lines: Vec<String>,
    journal_id: String,
    asset_id: String,
    class_id: String,
    template_id: String,
    mapping_id: String,
    invoice_template_id: String,
    invoice_image_id: String,
    coding_settings: Value,
    /// User ids by username.
    users: Vec<(String, String)>,
}

impl World {
    fn user(&self, username: &str) -> String {
        self.users
            .iter()
            .find(|(u, _)| u == username)
            .unwrap_or_else(|| panic!("no user {username}"))
            .1
            .clone()
    }

    async fn head(&self) -> i64 {
        let mut conn = self.server.state.store.reader().await.unwrap();
        acct_store::log::head_seq(&mut conn).await.unwrap()
    }

    async fn log_after(&self, seq: i64) -> Vec<acct_store::log::LoggedCommand> {
        let mut conn = self.server.state.store.reader().await.unwrap();
        acct_store::log::after(&mut conn, seq, 1000).await.unwrap()
    }

    async fn me(&self, cookie: &str) -> Value {
        self.server.get_json("/api/me", cookie).await
    }

    /// Starts viewing as `username` from the session `cookie`, returning the acting id.
    async fn start(&self, cookie: &str, username: &str) -> String {
        self.server
            .ok(
                cookie,
                "start_impersonation",
                json!({ "user_id": self.user(username), "reason": "They asked for help" }),
            )
            .await
    }
}

async fn add_overseer(server: &Server, username: &str, name: &str) {
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
                "username": username, "display_name": name,
                "password": PASSWORD, "role": "overseer",
            },
        }))
        .unwrap(),
    };
    submit(&server.state.store, &system, envelope, Utc::now())
        .await
        .unwrap();
}

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

async fn setup() -> World {
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

    let ana = sign_up(&server, "ana@example.nz", "Ana's Gardens").await;
    let ben = sign_up(&server, "ben@example.nz", "Ben's Bikes").await;
    let biz = ana.business_id.clone();
    server
        .ok(
            &ana.cookie,
            "import_statement",
            json!({
                "client_id": biz,
                "file_name": "kowhai-business-2025-08.csv",
                "content_base64": base64(KOWHAI),
            }),
        )
        .await;
    let business = server
        .get_json(&format!("/api/businesses/{biz}"), &ana.cookie)
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
        .get_json(&format!("/api/businesses/{biz}/save-tax"), &ana.cookie)
        .await;
    let mut lines: Vec<String> = Vec::new();
    collect_line_ids(&queue, &mut lines);
    lines.sort();
    lines.dedup();
    assert!(lines.len() >= 2, "Ana needs two bank lines: {queue}");
    // Ana's own edits (the upload, and this). She doesn't share her edits, so her accountants
    // don't see them in Changes.
    server
        .ok(
            &ana.cookie,
            "add_rule",
            json!({
                "client_id": biz,
                "description_contains": "NO SUCH SHOP",
                "coding": { "direction": "out", "kind": "personal" },
            }),
        )
        .await;
    let coding_settings = server
        .get_json(
            &format!("/api/businesses/{biz}/coding-settings"),
            &ana.cookie,
        )
        .await["settings"]
        .clone();

    let invite = token();
    server
        .ok(
            &ana.cookie,
            "create_invite",
            json!({ "client_id": biz, "email": "sam@practice.nz", "token": invite }),
        )
        .await;
    let sam = server.login("sam").await;
    server
        .ok(&sam, "accept_invite", json!({ "token": invite }))
        .await;
    let client = server.get_json(&format!("/api/clients/{biz}"), &sam).await;
    let year_id = client["years"][0]["id"].as_str().unwrap().to_owned();
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
                "client_id": biz, "class_id": class_id, "name": "Mower",
                "cost": 50000, "residual": 0, "acquired": start,
            }),
        )
        .await;
    let invoice_template_id = server
        .ok(
            &sam,
            "save_invoice_template",
            json!({ "name": "Sam's layout", "html": "<p>Sam</p>" }),
        )
        .await;
    let invoice_image_id = server
        .ok(
            &sam,
            "add_invoice_image",
            json!({ "content_base64": base64(b"GIF89a\x01\x00\x01\x00\x00\x00\x00;") }),
        )
        .await;

    add_overseer(&server, "olive", "Olive").await;
    add_overseer(&server, "oscar", "Oscar").await;
    let olive = server.login("olive").await;
    let users = server
        .get_json("/api/users", &olive)
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|u| {
            (
                u["username"].as_str().unwrap().to_owned(),
                u["id"].as_str().unwrap().to_owned(),
            )
        })
        .collect();

    World {
        server,
        ana,
        ben,
        year_id,
        bank_account_id,
        statement_id,
        lines,
        journal_id,
        asset_id,
        class_id,
        template_id,
        mapping_id,
        invoice_template_id,
        invoice_image_id,
        coding_settings,
        users,
    }
}

/// Submits a command that must succeed, whether or not it creates anything.
async fn ok_or_none(server: &Server, cookie: &str, kind: &str, payload: Value) {
    let (status, body) = server.command(cookie, kind, payload).await;
    assert_eq!(status, StatusCode::OK, "{kind}: {body}");
}

/// A refusal because the session is viewing as someone.
#[track_caller]
fn assert_impersonating(status: StatusCode, body: &Value, what: &str) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {body}");
    assert_eq!(body["code"], "impersonating", "{what}: {body}");
    let message = body["message"].as_str().unwrap();
    assert!(message.starts_with("You're viewing as "), "{what}: {body}");
}

// ---------------------------------------------------------------------------------------------
// Who may start

#[tokio::test]
async fn only_an_overseer_starts_and_only_as_an_active_user_below_them() {
    let w = setup().await;
    let s = &w.server;
    let reason = json!({ "user_id": w.user("sam"), "reason": "They asked for help" });
    // Nobody below an overseer may, a practice admin included (ADR 013, 1: A).
    let before = w.head().await;
    for (who, cookie) in [
        ("a practice admin", s.login("boss").await),
        ("staff", s.login("sam").await),
        ("a viewer", s.login("val").await),
        ("a business owner", w.ana.cookie.clone()),
    ] {
        let (status, body) = s
            .command(&cookie, "start_impersonation", reason.clone())
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}: {body}");
        for kind in ["end_impersonation", "allow_impersonation_changes"] {
            let (status, body) = s.command(&cookie, kind, json!({ "reason": "X" })).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{who}, {kind}: {body}");
        }
    }

    let olive = s.login("olive").await;
    let refused = |user_id: String, reason: &str| json!({ "user_id": user_id, "reason": reason });
    for (payload, code) in [
        // Never as an overseer: another one, or themselves.
        (refused(w.user("oscar"), "X"), "cannot_view_as"),
        (refused(w.user("olive"), "X"), "cannot_view_as"),
        // A reason, trimmed and not empty, of at most 500 characters.
        (refused(w.user("sam"), "   "), "reason_needed"),
        (refused(w.user("sam"), &"x".repeat(501)), "reason_too_long"),
    ] {
        let (status, body) = s.command(&olive, "start_impersonation", payload).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["code"], code, "{body}");
    }
    let (status, body) = s
        .command(&olive, "start_impersonation", refused(new_id(), "X"))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    // An inactive user has no view to see.
    let boss = s.login("boss").await;
    ok_or_none(
        s,
        &boss,
        "set_user_active",
        json!({ "user_id": w.user("val"), "active": false }),
    )
    .await;
    let (status, body) = s
        .command(&olive, "start_impersonation", refused(w.user("val"), "X"))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "user_inactive");
    // Ending or allowing changes while viewing as no one.
    for kind in ["end_impersonation", "allow_impersonation_changes"] {
        let (status, body) = s.command(&olive, kind, json!({ "reason": "X" })).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{kind}: {body}");
        assert_eq!(body["code"], "not_impersonating", "{kind}: {body}");
    }
    assert_eq!(
        w.head().await,
        before + 1,
        "only the set_user_active was logged"
    );

    // The server itself has no session to start one in.
    let system = Actor {
        user_id: None,
        role: Role::Overseer,
        acting_as: None,
    };
    let envelope = CommandEnvelope {
        id: new_id(),
        command: Command::StartImpersonation {
            user_id: w.user("sam"),
            reason: "X".into(),
        },
    };
    let err = submit(&s.state.store, &system, envelope, Utc::now())
        .await
        .unwrap_err();
    assert_eq!(err.body().code, "no_session");

    // An overseer, as staff: Me answers as sam, and says who's really there and until when.
    let acting_id = w.start(&olive, "sam").await;
    let me = w.me(&olive).await;
    assert_eq!(me["id"], w.user("sam"), "{me}");
    assert_eq!(me["role"], "staff");
    assert_eq!(me["acting_as"]["user_id"], w.user("sam"));
    assert_eq!(me["acting_as"]["name"], "sam");
    assert_eq!(me["acting_as"]["allow_changes"], false);
    assert_eq!(me["real"]["user_id"], w.user("olive"));
    assert_eq!(me["real"]["name"], "Olive");
    assert_eq!(me["real"]["role"], "overseer");
    let since: chrono::DateTime<Utc> =
        serde_json::from_value(me["acting_as"]["since"].clone()).unwrap();
    let until: chrono::DateTime<Utc> =
        serde_json::from_value(me["acting_as"]["expires_at"].clone()).unwrap();
    assert_eq!(until - since, Duration::minutes(30));
    // The start is logged as the overseer, and its id names the acting session.
    let start = w.log_after(w.head().await - 1).await.remove(0);
    assert_eq!(start.kind, "start_impersonation");
    assert_eq!(start.user_id.as_deref(), Some(w.user("olive").as_str()));
    assert!(start.result.contains(&acting_id));
    assert!(start.payload.contains("They asked for help"));

    // No nesting.
    let (status, body) = s
        .command(&olive, "start_impersonation", refused(w.user("boss"), "X"))
        .await;
    assert_impersonating(status, &body, "a second start");
    assert!(
        body["message"].as_str().unwrap().contains("already"),
        "{body}"
    );
}

// ---------------------------------------------------------------------------------------------
// Reads

/// A's id for a path parameter.
fn param(path: &str, name: &str, w: &World) -> String {
    match name {
        "id" if path.starts_with("/api/years/") => w.year_id.clone(),
        "id" if path.starts_with("/api/templates/") => w.template_id.clone(),
        "id" if path.starts_with("/api/mappings/") => w.mapping_id.clone(),
        "id" if path.starts_with("/api/invoices/templates/") => w.invoice_template_id.clone(),
        "id" if path.starts_with("/api/invoices/images/") => w.invoice_image_id.clone(),
        "id" if path.starts_with("/api/statements/") => w.statement_id.clone(),
        "id" if path.starts_with("/api/bank-accounts/") => w.bank_account_id.clone(),
        "id" => w.ana.business_id.clone(),
        "class_id" => w.class_id.clone(),
        "entity_type" => "sole_trader".to_owned(),
        other => panic!("{path}: no value for {{{other}}}; add one here"),
    }
}

fn fill(path: &str, w: &World) -> String {
    let mut out = String::new();
    let mut rest = path;
    while let Some(open) = rest.find('{') {
        let close = rest[open..].find('}').unwrap() + open;
        out.push_str(&rest[..open]);
        out.push_str(&param(path, &rest[open + 1..close], w));
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

const INVOICE_ROUTES: [&str; 4] = [
    "/api/invoices/draft",
    "/api/invoices/templates",
    "/api/invoices/templates/{id}",
    "/api/invoices/images/{id}",
];

/// Every `GET` route, as `own` (the person signed in themselves) and as `acting` (an overseer
/// viewing as them), must answer the same, status and body. Returns how many routes it compared.
async fn assert_same_reads(w: &World, own: &str, acting: &str, who: &str) -> usize {
    let s = &w.server;
    let mut compared = 0;
    for (method, path) in api_routes() {
        if method != Method::GET {
            continue;
        }
        let uri = fill(path, w);
        let (own_status, own_body) = split(s.send(get(&uri, Some(own))).await).await;
        let (status, body) = split(s.send(get(&uri, Some(acting))).await).await;
        if INVOICE_ROUTES.contains(&path) {
            // A person's own invoices stay theirs: neither theirs nor the overseer's show.
            assert_impersonating(status, &body, path);
            continue;
        }
        if path == "/api/me" {
            for key in ["id", "username", "display_name", "role"] {
                assert_eq!(body[key], own_body[key], "{path} as {who}: {key}");
            }
            assert!(own_body["acting_as"].is_null() && !body["acting_as"].is_null());
            continue;
        }
        assert_eq!(
            status, own_status,
            "GET {uri} as {who}: {body} vs {own_body}"
        );
        assert_eq!(body, own_body, "GET {uri} as {who}");
        compared += 1;
    }
    compared
}

#[tokio::test]
async fn reads_while_acting_are_the_persons_own() {
    let w = setup().await;
    let s = &w.server;
    let olive = s.login("olive").await;
    let sam = s.login("sam").await;
    let ana_id = w.ana.user_id.clone();
    let shows_ana_edit = |history: &Value| {
        history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["user_id"] == ana_id.as_str())
    };

    // As herself, Olive sees every business and Ana's own edits; sam sees neither Ben's business
    // nor Ana's edits, as Ana doesn't share them.
    let mine = s.get_json("/api/clients", &olive).await.to_string();
    assert!(mine.contains(&w.ben.business_id), "{mine}");
    assert!(shows_ana_edit(&s.get_json("/api/history", &olive).await));
    let sams = s.get_json("/api/clients", &sam).await.to_string();
    assert!(!sams.contains(&w.ben.business_id), "{sams}");
    assert!(!shows_ana_edit(&s.get_json("/api/history", &sam).await));

    // As sam, every read is sam's, endpoint by endpoint.
    w.start(&olive, "sam").await;
    let compared = assert_same_reads(&w, &sam, &olive, "sam").await;
    assert!(compared > 30, "only {compared} routes compared");
    assert!(!shows_ana_edit(&s.get_json("/api/history", &olive).await));
    for uri in [
        format!("/api/businesses/{}", w.ben.business_id),
        format!("/api/clients/{}", w.ben.business_id),
    ] {
        let (status, _) = split(s.send(get(&uri, Some(&olive))).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}: sam can't see Ben's");
    }
    s.ok(&olive, "end_impersonation", json!({})).await;

    // As Ana, the owner, every read is Ana's.
    w.start(&olive, "ana@example.nz").await;
    assert_same_reads(&w, &w.ana.cookie, &olive, "ana").await;
    s.ok(&olive, "end_impersonation", json!({ "reason": "Done" }))
        .await;

    // Ended, it's Olive's own view again.
    let me = w.me(&olive).await;
    assert_eq!(me["id"], w.user("olive"));
    assert!(me["acting_as"].is_null() && me["real"].is_null(), "{me}");
    let again = s.get_json("/api/clients", &olive).await.to_string();
    assert!(again.contains(&w.ben.business_id), "{again}");
}

#[test]
fn routes_other_than_reads_are_refused_while_acting_unless_given_a_rule() {
    use RouteWhileActing as W;
    let post = Method::POST;
    let rule = RouteRule::SignedIn;
    assert_eq!(while_acting(&Method::GET, "/api/clients", rule), W::Allowed);
    assert_eq!(while_acting(&post, "/api/commands", rule), W::Allowed);
    assert_eq!(while_acting(&post, "/api/presence", rule), W::Allowed);
    // Asking the AI is allowed read-only (ADR 016, 8): it pre-fills and changes no figures.
    for path in [
        "/api/businesses/{id}/ai-suggestions",
        "/api/businesses/{id}/explain",
    ] {
        assert_eq!(while_acting(&post, path, rule), W::Allowed);
    }
    // IRD, reads included (ADR 013, 4), and any new route that changes something.
    assert_eq!(
        while_acting(&Method::GET, "/api/ird/returns/{id}/status", rule),
        W::Refused("deal with IRD")
    );
    assert_eq!(
        while_acting(&post, "/api/ird/returns", rule),
        W::Refused("deal with IRD")
    );
    assert!(matches!(
        while_acting(&post, "/api/something-new", rule),
        W::Refused(_)
    ));
    // Every route that isn't a GET has a decision.
    for (method, path) in api_routes() {
        let rule = acct_server::access::route_rule(&method, path).unwrap();
        if method != Method::GET && rule != RouteRule::Public {
            assert!(
                !matches!(while_acting(&method, path, rule), W::Refused("do this")),
                "{method} {path} has no rule in access::while_acting"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// What's refused

/// A payload of the right shape for each kind, aimed at Ana's business where it names one. The
/// refusal comes before validation, so only the shape matters.
fn payload(kind: &str, w: &World) -> Value {
    let biz = &w.ana.business_id;
    let line = &w.lines[0];
    let coding = json!({ "direction": "out", "kind": "personal" });
    let template: Value = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let classes: Vec<Value> = serde_json::from_str(ASSET_CLASSES).unwrap();
    let class = &classes[0];
    match kind {
        "change_own_password" => {
            json!({ "current_password": PASSWORD, "new_password": "a whole new password" })
        }
        "save_invoice_draft" => json!({ "html": "<p>X</p>" }),
        "save_invoice_template" => json!({ "name": "X", "html": "<p>X</p>" }),
        "add_invoice_image" => json!({ "content_base64": "iVBORw0KGgo=" }),
        "delete_invoice_template" => json!({ "template_id": w.invoice_template_id }),
        "initialise" => json!({
            "practice_name": "X", "username": "x", "display_name": "X", "password": PASSWORD,
        }),
        "sign_up" => json!({
            "email": "x@example.nz", "display_name": "X", "password": PASSWORD,
            "business_name": "X", "start_date": "2025-04-01",
        }),
        "create_user" => json!({
            "username": "x", "display_name": "X", "password": PASSWORD, "role": "staff",
        }),
        "reset_password" => json!({ "user_id": w.ana.user_id, "new_password": PASSWORD }),
        "set_user_active" => json!({ "user_id": w.ana.user_id, "active": false }),
        "create_master_chart" => json!({ "entity_type": "company", "name": "X", "accounts": [] }),
        "install_starter_set" => json!({ "set": "company" }),
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
        "revise_template" => json!({ "template_id": w.template_id, "body": template }),
        "create_mapping" => json!({ "template_id": w.template_id, "name": "X", "body": mapping }),
        "revise_mapping" => json!({ "mapping_id": w.mapping_id, "body": mapping }),
        "create_asset_class" => json!({
            "entity_type": "sole_trader", "key": "x", "name": "X",
            "settings": class["settings"], "accounts": class["accounts"],
        }),
        "update_asset_class" => json!({
            "class_id": w.class_id, "name": "X",
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
            "client_year_id": w.year_id, "date": "2025-08-01", "narration": "X",
            "lines": [{ "account": "100", "amount": -1 }, { "account": "290", "amount": 1 }],
        }),
        "import_tb" => json!({ "client_year_id": w.year_id, "rows": [] }),
        "reverse_journal" => json!({ "journal_id": w.journal_id }),
        "run_depreciation" => json!({ "client_year_id": w.year_id }),
        "move_year_layout" => json!({ "client_year_id": w.year_id }),
        "set_client_asset_class" => json!({ "client_id": biz, "class_id": w.class_id }),
        "apply_asset_class_defaults" => json!({ "client_id": biz, "class_id": w.class_id }),
        "create_asset" => json!({
            "client_id": biz, "class_id": w.class_id, "name": "X",
            "cost": 1, "residual": 0, "acquired": "2025-08-01",
        }),
        "update_asset" => json!({
            "asset_id": w.asset_id, "name": "X", "cost": 1, "residual": 0,
            "acquired": "2025-08-01",
        }),
        "delete_asset" => json!({ "asset_id": w.asset_id }),
        "dispose_asset" => json!({
            "asset_id": w.asset_id,
            "disposal": { "date": "2025-09-01", "proceeds": 0, "proceeds_account": "100" },
        }),
        "reinstate_asset" => json!({ "asset_id": w.asset_id }),
        "add_bank_account" => json!({ "client_id": biz, "name": "X" }),
        "add_card_account" => json!({ "client_id": biz, "name": "X" }),
        "import_statement" => json!({
            "client_id": biz, "file_name": "x.csv", "content_base64": base64(KOWHAI),
        }),
        "set_opening_balance" => json!({ "bank_account_id": w.bank_account_id, "balance": 0 }),
        "code_bank_line" => json!({ "bank_line_id": line, "coding": coding }),
        "code_bank_lines" => json!({ "lines": [{ "bank_line_id": line, "coding": coding }] }),
        "add_rule" => json!({ "client_id": biz, "description_contains": "X", "coding": coding }),
        "remove_rule" => json!({ "rule_id": new_id() }),
        "answer_question" => json!({
            "client_id": biz, "income_year": 2026,
            "answer": { "question": "only_income", "yes": true },
        }),
        "confirm_transfer" => json!({ "out_line_id": w.lines[0], "in_line_id": w.lines[1] }),
        "confirm_ird_payment" => json!({ "bank_line_id": line, "payment": { "kind": "gst" } }),
        "resolve_duplicate" => json!({ "bank_line_id": line, "is_duplicate": true }),
        "confirm_supply_info" => json!({ "bank_line_id": line }),
        "remove_statement" => json!({ "statement_id": w.statement_id }),
        "set_coding_settings" => json!({ "client_id": biz, "settings": w.coding_settings }),
        "set_ai_suggestions" => json!({ "client_id": biz, "enabled": false }),
        "set_history_sharing" => json!({ "client_id": biz, "share_owner_edits": true }),
        "record_suggestions" => json!({ "client_id": biz, "model": "x", "suggestions": [] }),
        "create_invite" => json!({ "client_id": biz, "email": "x@example.nz", "token": token() }),
        "accept_invite" => json!({ "token": token() }),
        "finalise_year" => json!({ "client_year_id": w.year_id, "accept_uncategorised": true }),
        "reopen_year" => json!({ "client_year_id": w.year_id, "reason": "X" }),
        "add_paragraph" => json!({
            "entity_type": "sole_trader",
            "paragraph": { "key": "x", "placement": "note", "title": "X", "body": "X" },
        }),
        "revise_paragraph" => json!({
            "paragraph_id": new_id(), "placement": "note", "title": "X", "body": "X",
        }),
        "push_paragraph" => json!({ "paragraph_id": new_id() }),
        "remove_paragraph" => json!({ "paragraph_id": new_id() }),
        "pick_notes" => json!({ "client_year_id": w.year_id, "paragraph_ids": [] }),
        "edit_note" => json!({
            "client_year_id": w.year_id, "paragraph_id": new_id(), "title": "X", "body": "X",
        }),
        "start_impersonation" => json!({ "user_id": w.user("val"), "reason": "X" }),
        "end_impersonation" => json!({}),
        "allow_impersonation_changes" => json!({ "reason": "X" }),
        // Guests (M20).
        "start_guest" | "add_guest_business" => json!({ "source": { "example": 1 } }),
        "claim_guest" => json!({
            "email": "x@example.nz", "display_name": "X", "password": "correct horse battery",
        }),
        "adopt_guest_business" => json!({ "token": token() }),
        "expire_guest" => json!({ "client_id": biz, "why": "by_you" }),
        // Practice requests (M21).
        "request_practice_account" => json!({
            "name": "X", "email": "x@example.nz", "practice_name": "X", "clients": "up_to_10",
        }),
        "delete_practice_request" => json!({ "request_id": new_id(), "why": "by_overseer" }),
        "set_gst_registration" => {
            json!({ "client_id": biz, "registered": false, "source": "owner" })
        }
        other => panic!("tests/impersonation.rs has no payload for the new command {other}"),
    }
}

#[test]
fn every_command_kind_is_classified_while_acting() {
    let never: Vec<&str> = NEVER.iter().map(|(k, _)| *k).collect();
    let groups: [(&str, &[&str]); 4] = [
        ("ALLOWED", ALLOWED),
        ("SESSION", SESSION),
        ("AS_YOURSELF", AS_YOURSELF),
        ("NEVER", &never),
    ];
    let kinds = all_kinds();
    for kind in &kinds {
        let found: Vec<&str> = groups
            .iter()
            .filter(|(_, g)| g.contains(&kind.as_str()))
            .map(|(name, _)| *name)
            .collect();
        assert_eq!(
            found.len(),
            1,
            "{kind} is in {found:?}: put it in exactly one of crate::impersonation's lists"
        );
    }
    // No stale names, and nothing to do with IRD on the allowed list (ADR 013, 4).
    let known: BTreeSet<&str> = kinds.iter().map(String::as_str).collect();
    for (name, group) in groups {
        for kind in group {
            assert!(
                known.contains(kind),
                "{name} names {kind}, which isn't a command"
            );
        }
    }
    assert!(!ALLOWED.iter().any(|k| k.starts_with("ird_")));
    assert_eq!(
        impersonation::classify("ird_anything"),
        WhileActing::Never("deal with IRD")
    );
    // The ADR's counts: 36 allowed, 2 session, 20 as yourself, 17 never; then M20's (ADR 014):
    // an owner's GST answer allowed, and the five guest commands never; then M21's (ADR 015): the
    // two practice request commands never; then M22's (ADR 016): `record_suggestions` moves from
    // allowed to session.
    assert_eq!(
        (ALLOWED.len(), SESSION.len(), AS_YOURSELF.len(), NEVER.len()),
        (36, 3, 20, 24)
    );
}

#[tokio::test]
async fn every_refused_kind_is_refused_with_changes_off_and_on() {
    let w = setup().await;
    let s = &w.server;
    let olive = s.login("olive").await;
    w.start(&olive, "sam").await;
    let before = w.head().await;

    let walk = |allow: bool| {
        let w = &w;
        let olive = olive.clone();
        async move {
            for kind in all_kinds() {
                let class = impersonation::classify(&kind);
                let refused = match class {
                    WhileActing::Session => false,
                    WhileActing::Allowed => !allow,
                    WhileActing::AsYourself | WhileActing::Never(_) => true,
                };
                if !refused {
                    continue;
                }
                let (status, body) = w.server.command(&olive, &kind, payload(&kind, w)).await;
                assert_impersonating(status, &body, &kind);
                let message = body["message"].as_str().unwrap();
                assert!(message.contains("sam"), "{kind}: {message}");
                match class {
                    WhileActing::Allowed => assert!(message.contains("read-only"), "{message}"),
                    WhileActing::Never(what) if kind != "start_impersonation" => {
                        assert!(message.contains(what), "{kind}: {message}")
                    }
                    _ => {}
                }
            }
        }
    };

    // Changes off: everything but the two session commands.
    walk(false).await;
    assert_eq!(w.head().await, before, "a refused command was logged");
    let (status, body) = s
        .command(
            &olive,
            "finalise_year",
            json!({ "client_year_id": w.year_id }),
        )
        .await;
    assert_impersonating(status, &body, "finalise_year");
    assert_eq!(
        body["message"],
        "You're viewing as sam. Overseers can't finalise a year as someone else."
    );

    // Changes on: still everything not on the allowed list.
    s.ok(
        &olive,
        "allow_impersonation_changes",
        json!({ "reason": "To fix the journal sam asked about" }),
    )
    .await;
    walk(true).await;
    assert_eq!(w.head().await, before + 1, "only the allow was logged");

    // The invoice maker's routes are refused too, and a write route without changes.
    for uri in ["/api/invoices/draft", "/api/invoices/templates"] {
        let (status, body) = split(s.send(get(uri, Some(&olive))).await).await;
        assert_impersonating(status, &body, uri);
    }
}

#[tokio::test]
async fn allowed_writes_work_only_once_changes_are_on() {
    let w = setup().await;
    let s = &w.server;
    let olive = s.login("olive").await;
    let acting_id = w.start(&olive, "sam").await;
    let journal = payload("post_journal", &w);

    // Read-only.
    let (status, body) = s.command(&olive, "post_journal", journal.clone()).await;
    assert_impersonating(status, &body, "post_journal");
    assert_eq!(
        body["message"],
        "You're viewing as sam, read-only. Turn on Allow changes to make this change."
    );
    // Asking the AI is no longer a change (ADR 016, 8): the access layer lets it through, and
    // this server has no suggester, so it is the ordinary "not set up" answer.
    let ai = format!("/api/businesses/{}/ai-suggestions", w.ana.business_id);
    let (status, body) = split(s.send(post_json(&ai, Some(&olive), &json!({}))).await).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "ai_unavailable");

    // Allowing changes needs a reason, and is itself logged.
    let (status, body) = s
        .command(
            &olive,
            "allow_impersonation_changes",
            json!({ "reason": " " }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "reason_needed");
    let allowed = s
        .ok(
            &olive,
            "allow_impersonation_changes",
            json!({ "reason": "To post the adjustment sam asked for" }),
        )
        .await;
    assert_eq!(allowed, acting_id);
    assert_eq!(w.me(&olive).await["acting_as"]["allow_changes"], true);
    let (status, body) = s
        .command(
            &olive,
            "allow_impersonation_changes",
            json!({ "reason": "X" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "already_allowed");

    // Now a write works, recorded as Olive (Agent 3 adds `acting_as`).
    let head = w.head().await;
    s.ok(&olive, "post_journal", journal.clone()).await;
    let row = w.log_after(head).await.remove(0);
    assert_eq!(row.kind, "post_journal");
    assert_eq!(row.user_id.as_deref(), Some(w.user("olive").as_str()));
    // ...as sam: on Ben's business, which sam can't see, it's not found.
    let (status, body) = s
        .command(
            &olive,
            "add_rule",
            json!({
                "client_id": w.ben.business_id,
                "description_contains": "X",
                "coding": { "direction": "out", "kind": "personal" },
            }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    // The AI route gets past the access layer now; this server has no AI provider.
    let (status, body) = split(s.send(post_json(&ai, Some(&olive), &json!({}))).await).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "ai_unavailable");
}

// ---------------------------------------------------------------------------------------------
// How it ends

#[tokio::test]
async fn ending_returns_the_overseers_own_view_and_is_logged_once() {
    let w = setup().await;
    let s = &w.server;
    let olive = s.login("olive").await;
    let acting_id = w.start(&olive, "sam").await;

    // A browser can't say it timed out, or end someone else's by id.
    for payload in [
        json!({ "ended": "timed_out" }),
        json!({ "acting_id": acting_id }),
    ] {
        let (status, body) = s.command(&olive, "end_impersonation", payload).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(body["code"], "server_only");
    }
    let (status, body) = s
        .command(
            &olive,
            "end_impersonation",
            json!({ "reason": "y".repeat(501) }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");

    let head = w.head().await;
    let ended = s
        .ok(
            &olive,
            "end_impersonation",
            json!({ "reason": "All sorted" }),
        )
        .await;
    assert_eq!(ended, acting_id, "the end names the start it closes");
    let end = w.log_after(head).await.remove(0);
    assert_eq!(end.user_id.as_deref(), Some(w.user("olive").as_str()));
    assert!(end.payload.contains("All sorted"));
    assert_eq!(w.me(&olive).await["id"], w.user("olive"));
    let (status, body) = s.command(&olive, "end_impersonation", json!({})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "not_impersonating");
    // Nothing left for the sweep.
    assert_eq!(
        impersonation::sweep(&s.state.store, Utc::now())
            .await
            .unwrap(),
        0
    );

    // Signing out ends it first, as the overseer.
    let acting_id = w.start(&olive, "ana@example.nz").await;
    let head = w.head().await;
    let response = s
        .send(post_json("/api/logout", Some(&olive), &json!({})))
        .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let end = w.log_after(head).await.remove(0);
    assert_eq!(end.kind, "end_impersonation");
    assert_eq!(end.user_id.as_deref(), Some(w.user("olive").as_str()));
    assert!(end.payload.contains("signed_out"), "{}", end.payload);
    assert!(end.result.contains(&acting_id));
    assert_eq!(
        impersonation::sweep(&s.state.store, Utc::now())
            .await
            .unwrap(),
        0
    );
}

/// Moves an acting session's start back, as if `minutes` had passed.
async fn age(w: &World, acting_id: &str, minutes: i64) {
    let mut writer = w.server.state.store.writer().await;
    let session = acct_store::sessions::by_acting_id(&mut writer, acting_id)
        .await
        .unwrap()
        .unwrap();
    let since = session.acting_since.unwrap() - Duration::minutes(minutes);
    acct_store::sqlx::query("UPDATE sessions SET acting_since = ? WHERE acting_id = ?")
        .bind(since)
        .bind(acting_id)
        .execute(&mut *writer)
        .await
        .unwrap();
}

#[tokio::test]
async fn it_times_out_after_thirty_minutes_and_the_sweep_logs_the_end() {
    let w = setup().await;
    let s = &w.server;
    let olive = s.login("olive").await;
    let acting_id = w.start(&olive, "sam").await;

    // 29 minutes in, it's still on, and the sweep leaves it.
    age(&w, &acting_id, 29).await;
    assert_eq!(w.me(&olive).await["id"], w.user("sam"));
    assert_eq!(
        impersonation::sweep(&s.state.store, Utc::now())
            .await
            .unwrap(),
        0
    );

    // Past 30, every request is Olive's own at once, logged or not.
    age(&w, &acting_id, 2).await;
    let me = w.me(&olive).await;
    assert_eq!(me["id"], w.user("olive"), "{me}");
    assert!(me["acting_as"].is_null());
    let clients = s.get_json("/api/clients", &olive).await.to_string();
    assert!(clients.contains(&w.ben.business_id), "{clients}");

    // The sweep logs the end, as the server, naming the start; once.
    let head = w.head().await;
    assert_eq!(
        impersonation::sweep(&s.state.store, Utc::now())
            .await
            .unwrap(),
        1
    );
    let end = w.log_after(head).await.remove(0);
    assert_eq!(end.kind, "end_impersonation");
    assert_eq!(end.user_id, None);
    assert!(end.payload.contains("timed_out"), "{}", end.payload);
    assert!(end.result.contains(&acting_id));
    assert_eq!(
        impersonation::sweep(&s.state.store, Utc::now())
            .await
            .unwrap(),
        0
    );
    let mut conn = s.state.store.reader().await.unwrap();
    assert!(
        acct_store::sessions::by_acting_id(&mut conn, &acting_id)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn it_ends_when_the_person_changes_or_the_session_goes() {
    let w = setup().await;
    let s = &w.server;
    let olive = s.login("olive").await;
    let boss = s.login("boss").await;

    // val is made inactive mid-way: over at once, then logged by the sweep.
    w.start(&olive, "val").await;
    ok_or_none(
        s,
        &boss,
        "set_user_active",
        json!({ "user_id": w.user("val"), "active": false }),
    )
    .await;
    assert_eq!(w.me(&olive).await["id"], w.user("olive"));
    let head = w.head().await;
    assert_eq!(
        impersonation::sweep(&s.state.store, Utc::now())
            .await
            .unwrap(),
        1
    );
    let end = w.log_after(head).await.remove(0);
    assert!(end.payload.contains("person_changed"), "{}", end.payload);

    // The session goes some other way (here, straight from the table, as a reset would).
    let acting_id = w.start(&olive, "sam").await;
    {
        let mut writer = s.state.store.writer().await;
        let session = acct_store::sessions::by_acting_id(&mut writer, &acting_id)
            .await
            .unwrap()
            .unwrap();
        acct_store::sessions::delete(&mut writer, &session.token_hash)
            .await
            .unwrap();
    }
    let head = w.head().await;
    assert_eq!(
        impersonation::sweep(&s.state.store, Utc::now())
            .await
            .unwrap(),
        1
    );
    let end = w.log_after(head).await.remove(0);
    assert!(end.payload.contains("session_gone"), "{}", end.payload);
    assert!(end.result.contains(&acting_id));

    // Every start has exactly one end.
    let all = w.log_after(0).await;
    let starts = all
        .iter()
        .filter(|e| e.kind == "start_impersonation")
        .count();
    let ends = all.iter().filter(|e| e.kind == "end_impersonation").count();
    assert_eq!((starts, ends), (2, 2));
}

#[tokio::test]
async fn a_second_session_of_the_same_overseer_isnt_affected() {
    let w = setup().await;
    let s = &w.server;
    let laptop = s.login("olive").await;
    let phone = s.login("olive").await;
    w.start(&laptop, "sam").await;

    assert_eq!(w.me(&laptop).await["id"], w.user("sam"));
    let me = w.me(&phone).await;
    assert_eq!(me["id"], w.user("olive"));
    assert!(me["acting_as"].is_null(), "{me}");
    let phones = s.get_json("/api/clients", &phone).await.to_string();
    assert!(phones.contains(&w.ben.business_id), "{phones}");
    let laptops = s.get_json("/api/clients", &laptop).await.to_string();
    assert!(!laptops.contains(&w.ben.business_id), "{laptops}");
    // The phone writes as Olive, unrestricted; it can't end the laptop's.
    s.ok(
        &phone,
        "set_up_business",
        json!({ "name": "Olive's test business", "start_date": "2025-04-01" }),
    )
    .await;
    let (status, body) = s.command(&phone, "end_impersonation", json!({})).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "not_impersonating");
    assert_eq!(w.me(&laptop).await["id"], w.user("sam"));
}
