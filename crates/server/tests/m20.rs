//! M20 is done (PLAN.md, ADR 014): a visitor tries it on the home page with no sign-up.
//!
//! `m20_is_done` goes through the real routes the way a browser does, and nobody signs in until
//! the claim: the three examples give their pinned figures and Save tax answers lower them by the
//! pinned amounts; a visitor's own file reaches everything the Submit screen reads; claiming
//! keeps every line, answer and figure and the new password signs in; a second guest reaches
//! nothing of the first's; an unclaimed trial past its expiry is swept without touching anyone
//! else; and the per-address limit refuses the next trial in the ADR's words.
//!
//! The figures are the ones `tests/examples.rs` pins from the engine, now reached through
//! `POST /api/guest`, `POST /api/commands` and the Save tax route.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::sync::Arc;

use acct_server::commands::{Command, CommandEnvelope};
use acct_server::guests::{self, Limits};
use acct_server::pipeline::{Actor, submit};
use acct_server::starter::StarterSet;
use acct_store::users::Role;
use acct_store::{bank as bank_store, log, sqlx, users};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Response, StatusCode, header};
use chrono::{Duration, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

/// The visitor's own file, as a browser would drop it.
const OWN_FILE: &str = "harbourlight-cheque-2025-08.ofx";
const OWN: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx");
/// Another file of the visitor's own, for the guest who is claimed and stays.
const CARD_FILE: &str = "harbourlight-visa-2025-08.ofx";
const CARD: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-visa-2025-08.ofx");
/// A signed-up owner's file, in another business.
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

// ---------------------------------------------------------------------------------------------
// Helpers: what a browser does.

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

/// A server with the sole-trader starter set, installed as the server itself so nobody signs in.
async fn server() -> Server {
    let server = Server::new().await;
    let actor = Actor {
        user_id: None,
        role: Role::PracticeAdmin,
        acting_as: None,
    };
    let envelope = CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command: Command::InstallStarterSet {
            set: StarterSet::SoleTrader,
        },
    };
    if let Err(e) = submit(&server.state.store, &actor, envelope, Utc::now()).await {
        panic!(
            "install_starter_set: {}",
            serde_json::to_value(e.body()).unwrap()
        );
    }
    server
}

/// A visitor in a browser: the session cookie they got and the business the start made.
struct Guest {
    cookie: String,
    user_id: String,
    business_id: String,
}

/// `POST /api/guest` from `address` (or none, as in the other tests), with `cookie` if the
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

/// A new visitor drops a file or uses an example; it must work, with no sign-in.
async fn start(server: &Server, source: Value) -> Guest {
    let response = post_guest(server, source, None, None).await;
    let cookie = set_cookie(&response, "acct_session");
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "start: {body}");
    assert_eq!(
        body["me"]["username"], "",
        "a guest has no name yet: {body}"
    );
    Guest {
        cookie: cookie.expect("starting a trial sets the session cookie"),
        user_id: body["me"]["id"].as_str().unwrap().to_owned(),
        business_id: body["business_id"].as_str().unwrap().to_owned(),
    }
}

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

async fn claim(server: &Server, guest: &Guest, email: &str) -> (StatusCode, Value, Option<String>) {
    let response = server
        .send(post_json(
            "/api/guest/claim",
            Some(&guest.cookie),
            &json!({
                "id": new_id(), "email": email, "display_name": "Ana Ngata", "password": PASSWORD,
            }),
        ))
        .await;
    let cookie = set_cookie(&response, "acct_session");
    let (status, body) = split(response).await;
    (status, body, cookie)
}

/// `Server::ok` for commands that return no entity id (an answer, a payment, a registration).
trait RunOk {
    async fn run_ok(&self, cookie: &str, kind: &str, payload: Value) -> Value;
}

impl RunOk for Server {
    async fn run_ok(&self, cookie: &str, kind: &str, payload: Value) -> Value {
        let (status, body) = self.command(cookie, kind, payload).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {body}");
        body
    }
}

async fn queue(server: &Server, cookie: &str, biz: &str) -> Value {
    server
        .get_json(&format!("/api/businesses/{biz}/save-tax"), cookie)
        .await
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

/// Answers a Save tax card the way the README says the line (or the owner) is, as a visitor
/// pressing its button would, and says what it did. `None` for a card this test doesn't answer.
async fn answer(server: &Server, cookie: &str, biz: &str, card: &Value) -> Option<String> {
    let line = card["lines"].get(0);
    let line_id = line.map(|l| l["bank_line_id"].clone());
    let desc = line
        .and_then(|l| l["description"].as_str())
        .unwrap_or("")
        .to_owned();
    let amount = line.and_then(|l| l["amount"].as_i64()).unwrap_or(0);
    match card["kind"].as_str().unwrap() {
        "question" => {
            let question = card["question"].as_str().unwrap();
            if question == "gst_registered" {
                // The README: Matai Design Studio isn't registered.
                server
                    .run_ok(
                        cookie,
                        "set_gst_registration",
                        json!({ "client_id": biz, "registered": false, "source": "owner" }),
                    )
                    .await;
                return Some("GST registered: no".to_owned());
            }
            let (answer, said) = match question {
                "only_income" => (
                    json!({ "question": "only_income", "yes": true }),
                    "only income: yes",
                ),
                "student_loan" => (
                    json!({ "question": "student_loan", "yes": false }),
                    "student loan: no",
                ),
                _ => return None,
            };
            server
                .run_ok(
                    cookie,
                    "answer_question",
                    json!({
                        "client_id": biz, "income_year": card["income_year"], "answer": answer,
                    }),
                )
                .await;
            Some(said.to_owned())
        }
        "ird_payment" => {
            let gst = desc.contains("GST");
            let payment = if gst {
                json!({ "kind": "gst" })
            } else {
                json!({ "kind": "income_tax", "income_year": 2026 })
            };
            server
                .run_ok(
                    cookie,
                    "confirm_ird_payment",
                    json!({ "bank_line_id": line_id.unwrap(), "payment": payment }),
                )
                .await;
            Some(format!(
                "IRD payment: {}",
                if gst { "GST" } else { "income tax" }
            ))
        }
        "categorise" => {
            let assets = [("GRINDER", "700"), ("VAN REGO", "710"), ("LAPTOP", "720")];
            let (coding, said, confirmed) = if amount > 0 && desc.starts_with("TRANSFER FROM") {
                // Money in from the owner's own savings: not income. (A guest's example can't add
                // the savings account, so it's the owner's own money coming in.)
                (
                    json!({ "direction": "in", "kind": "owner_funds" }),
                    "not income",
                    None,
                )
            } else if amount > 0 {
                (
                    json!({
                        "direction": "in", "kind": "income", "account": "100", "gst": "standard",
                    }),
                    "income",
                    None,
                )
            } else if let Some((_, cost)) = assets.iter().find(|(k, _)| desc.contains(k)) {
                // A van or a grinder comes with a tax invoice; GST over $200 is claimed on it.
                (
                    json!({
                        "direction": "out", "kind": "asset_purchase", "account": cost,
                        "gst": "standard",
                    }),
                    "asset",
                    Some(true),
                )
            } else {
                (
                    json!({ "direction": "out", "kind": "personal" }),
                    "personal",
                    None,
                )
            };
            // `code_bank_line` takes the line's coding as its payload.
            let mut line = json!({ "bank_line_id": line_id.unwrap(), "coding": coding });
            if let Some(c) = confirmed {
                line["supply_info_confirmed"] = json!(c);
            }
            server.run_ok(cookie, "code_bank_line", line).await;
            Some(format!("{said}: {desc}"))
        }
        _ => None,
    }
}

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

/// The reads the owner screens and the Submit screen make, as a guest or after claiming.
async fn screens(server: &Server, cookie: &str, biz: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for path in ["", "/tax", "/save-tax", "/rules", "/coding-settings"] {
        out.push(
            server
                .get_json(&format!("/api/businesses/{biz}{path}"), cookie)
                .await,
        );
    }
    out
}

// ---------------------------------------------------------------------------------------------
// The done check.

#[tokio::test]
async fn m20_is_done() {
    let mut server = server().await;

    // 1. Each example: a fresh client, the pinned figure, and the top three cards.
    // (number, conservative figure, the figure after each answer, what the three answers are)
    let pinned: [(u8, i64, [i64; 3], [&str; 3]); 3] = [
        (
            1,
            530_798,
            [205_081, 205_081, 205_081],
            ["only income", "IRD payment", "income"],
        ),
        (
            2,
            911_151,
            [352_036, 168_632, 18_632],
            ["only income", "GST registered", "IRD payment"],
        ),
        (
            3,
            3_289_009,
            [1_818_854, 1_044_940, 669_940],
            ["only income", "not income", "asset"],
        ),
    ];
    // The home page reads the examples with no cookie at all.
    let (status, listed) = split(server.send(get("/api/examples", None)).await).await;
    assert_eq!(status, StatusCode::OK, "{listed}");
    for (number, conservative, steps, labels) in pinned {
        assert_eq!(
            listed[usize::from(number) - 1]["conservative_tax"],
            conservative,
            "GET /api/examples, example {number}"
        );
        let g = start(&server, example_source(number)).await;
        let biz = &g.business_id;
        let me = server.get_json("/api/me", &g.cookie).await;
        assert_eq!(me["guest"]["example"]["number"], number, "{me}");
        assert_eq!(me["guest"]["business_id"], Value::Null, "{me}");

        let tax = server
            .get_json(&format!("/api/businesses/{biz}/tax"), &g.cookie)
            .await;
        assert_eq!(tax["total"], conservative, "example {number}: /tax");
        let mut q = queue(&server, &g.cookie, biz).await;
        assert_eq!(q["conservative_total"], conservative, "example {number}");
        assert_eq!(q["total"], conservative, "example {number}");
        assert_eq!(q["saved_so_far"], 0, "example {number}");

        let mut held = conservative;
        for (step, (figure, label)) in steps.into_iter().zip(labels).enumerate() {
            let top = q["cards"][0].clone();
            let said = answer(&server, &g.cookie, biz, &top)
                .await
                .unwrap_or_else(|| panic!("example {number} step {step}: can't answer {top}"));
            assert!(
                said.starts_with(label),
                "example {number} step {step}: answered {said:?}, wanted {label:?}"
            );
            q = queue(&server, &g.cookie, biz).await;
            assert_eq!(q["total"], figure, "example {number} after {said:?}");
            // "Saved so far" is the queue's own baseline less its figure. Answering "Are you GST
            // registered?" with no moves the baseline too (it's a setting, not an answer), so
            // the baseline is only held to its own sum and to never rising.
            let baseline = q["conservative_total"].as_i64().unwrap();
            if said.starts_with("GST registered") {
                assert!(baseline <= held, "example {number} after {said:?}");
                held = baseline;
            } else {
                assert_eq!(baseline, held, "example {number} after {said:?}");
            }
            assert_eq!(
                q["saved_so_far"].as_i64().unwrap(),
                baseline - figure,
                "example {number} after {said:?}"
            );
            let tax = server
                .get_json(&format!("/api/businesses/{biz}/tax"), &g.cookie)
                .await;
            assert_eq!(
                tax["total"], figure,
                "example {number}: /tax after {said:?}"
            );
        }
    }

    // 2. A visitor's own file, sent as the browser does: base64 through import_statement.
    let a = start(&server, file_source(OWN_FILE, OWN)).await;
    let biz = a.business_id.clone();
    let me = server.get_json("/api/me", &a.cookie).await;
    assert_eq!(me["guest"]["business_id"], biz, "{me}");
    let first = queue(&server, &a.cookie, &biz).await;
    let mut total = first["total"].as_i64().unwrap();
    assert_eq!(first["conservative_total"].as_i64().unwrap(), total);
    let mut answered = 0;
    while answered < 3 {
        let q = queue(&server, &a.cookie, &biz).await;
        let mut said = None;
        for card in q["cards"].as_array().unwrap() {
            if let Some(s) = answer(&server, &a.cookie, &biz, card).await {
                said = Some(s);
                break;
            }
        }
        let said = said.expect("the visitor's file has a card to answer");
        let q = queue(&server, &a.cookie, &biz).await;
        let now = q["total"].as_i64().unwrap();
        assert!(
            now <= total,
            "{said:?} put the tax up from {total} to {now}"
        );
        assert_eq!(
            q["saved_so_far"].as_i64().unwrap(),
            q["conservative_total"].as_i64().unwrap() - now,
            "{said:?}"
        );
        total = now;
        answered += 1;
    }

    // Everything the Submit screen reads is there without a sign-in.
    let business = server
        .get_json(&format!("/api/businesses/{biz}"), &a.cookie)
        .await;
    let accounts = business["bank_accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 1, "{business}");
    assert!(!accounts[0]["statements"].as_array().unwrap().is_empty());
    let tax = server
        .get_json(&format!("/api/businesses/{biz}/tax"), &a.cookie)
        .await;
    assert_eq!(tax["total"].as_i64().unwrap(), total);
    assert!(tax["gst"].is_array() && tax["income"].is_array() && tax["notices"].is_array());
    server
        .get_json(&format!("/api/clients/{biz}"), &a.cookie)
        .await;
    server
        .get_json(
            &format!(
                "/api/bank-accounts/{}/proof",
                accounts[0]["id"].as_str().unwrap()
            ),
            &a.cookie,
        )
        .await;
    let changes = server
        .get_json(&format!("/api/history?business={biz}"), &a.cookie)
        .await;
    assert!(
        changes["entries"].as_array().unwrap().len() >= 4,
        "{changes}"
    );
    // Filing needs an account (ADR 014, 5): the screen is there, the filing is not.
    let (status, body) = server
        .command(
            &a.cookie,
            "create_invite",
            json!({ "client_id": biz, "email": "acc@example.nz", "token": "x".repeat(64) }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["code"], "guest");

    // 4 (before the claim). A second guest can't read or change the first's business.
    let b = start(&server, file_source(OWN_FILE, OWN)).await;
    let mut a_lines = Vec::new();
    collect_line_ids(&queue(&server, &a.cookie, &biz).await, &mut a_lines);
    assert!(!a_lines.is_empty());
    let statement_id = accounts[0]["statements"][0]["id"].as_str().unwrap();
    nobody_else_reaches(&server, &b, &biz, &a_lines, statement_id).await;

    // 3. Claiming keeps every line, answer and figure, and the password signs in.
    sign_up(&server, "taken@example.nz").await;
    let screens_before = screens(&server, &a.cookie, &biz).await;
    let tables_before = dump(&server).await;
    let lines_before = {
        let mut conn = server.state.store.reader().await.unwrap();
        bank_store::bank_lines(&mut conn, &biz).await.unwrap()
    };
    // An email that's taken is refused, and changes nothing.
    let tables_before_refusal = dump(&server).await;
    let (status, body, _) = claim(&server, &a, "taken@example.nz").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "email_taken");
    assert_eq!(dump(&server).await, tables_before_refusal);

    let (status, body, cookie) = claim(&server, &a, "ana@example.nz").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["business_id"], biz);
    let cookie = cookie.expect("claiming carries on signed in");
    assert_ne!(
        cookie, a.cookie,
        "a new session token once it has credentials"
    );
    let me = server.get_json("/api/me", &cookie).await;
    assert_eq!(me["id"], a.user_id.as_str(), "the same user");
    assert_eq!(me["username"], "ana@example.nz");
    assert_eq!(me["guest"], Value::Null);

    // Every line, answer and figure is as it was.
    let mut screens_after = screens(&server, &cookie, &biz).await;
    // The one difference: a saved business is asked to reconcile its opening balance, an unsaved
    // trial isn't. That card saves nothing, so it moves no figure.
    let cards = screens_after[2]["cards"].as_array_mut().unwrap();
    for c in cards.iter().filter(|c| c["kind"] == "reconcile") {
        assert_eq!(c["saving"], 0, "{c}");
    }
    cards.retain(|c| c["kind"] != "reconcile");
    assert_eq!(screens_after, screens_before);
    assert_eq!(
        screens_after[1]["total"].as_i64().unwrap(),
        total,
        "the figure the visitor saw"
    );
    let tables_after = dump(&server).await;
    for table in [
        "bank_lines",
        "bank_accounts",
        "statements",
        "statement_files",
        "journals",
        "journal_lines",
        "tax_answers",
        "coding_rules",
        "bank_line_states",
        "businesses",
    ] {
        assert!(tables_before.contains_key(table), "no table {table}");
        let gone: Vec<&String> = tables_before[table]
            .iter()
            .filter(|r| !tables_after[table].contains(r))
            .collect();
        let new: Vec<&String> = tables_after[table]
            .iter()
            .filter(|r| !tables_before[table].contains(r))
            .collect();
        assert!(
            gone.is_empty() && new.is_empty(),
            "claiming changed {table}: rows gone {gone:?}, rows new {new:?}"
        );
    }
    {
        let mut conn = server.state.store.reader().await.unwrap();
        assert_eq!(
            bank_store::bank_lines(&mut conn, &biz).await.unwrap(),
            lines_before
        );
    }
    // The guest's old token is finished, and the new password signs in as the same person.
    let (status, _) = split(server.send(get("/api/me", Some(&a.cookie))).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let signed_in = server.login("ana@example.nz").await;
    let me = server.get_json("/api/me", &signed_in).await;
    assert_eq!(me["id"], a.user_id.as_str());
    assert_eq!(
        server
            .get_json(&format!("/api/businesses/{biz}/tax"), &signed_in)
            .await["total"]
            .as_i64()
            .unwrap(),
        total
    );

    // 4 (after the claim). Still nobody else's, now that it has an owner with a password.
    nobody_else_reaches(&server, &b, &biz, &a_lines, statement_id).await;

    // 6. The per-address limit refuses the next trial, in the ADR's words (ADR 014, 8).
    server.state.guest_limits = Arc::new(Limits::new(10, 30));
    let here = "203.0.113.5:40000";
    for n in 0..10 {
        let response = post_guest(&server, file_source(OWN_FILE, OWN), None, Some(here)).await;
        assert_eq!(response.status(), StatusCode::OK, "trial {n}");
    }
    let response = post_guest(&server, file_source(OWN_FILE, OWN), None, Some(here)).await;
    assert!(response.headers().contains_key(header::RETRY_AFTER));
    assert!(set_cookie(&response, "acct_session").is_none());
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], "too_many_trials");
    let message = body["message"].as_str().unwrap();
    assert!(
        message.starts_with(
            "Lots of people on your network have tried this in the last hour. \
             Try again in about "
        ) && message.ends_with(" minutes, or sign up to carry on."),
        "{message}"
    );
    // Someone else's address still gets in.
    let response = post_guest(
        &server,
        file_source(OWN_FILE, OWN),
        None,
        Some("198.51.100.7:40000"),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
}

/// A second guest `b` reaches nothing of `biz`: every read is "not found", every command aimed
/// at it is refused as not found and leaves nothing in the log, and the listings don't show it.
async fn nobody_else_reaches(
    server: &Server,
    b: &Guest,
    biz: &str,
    lines: &[String],
    statement_id: &str,
) {
    for path in ["", "/tax", "/save-tax", "/rules", "/coding-settings"] {
        let uri = format!("/api/businesses/{biz}{path}");
        let (status, body) = split(server.send(get(&uri, Some(&b.cookie))).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}: {body}");
    }
    let uri = format!("/api/clients/{biz}");
    let (status, body) = split(server.send(get(&uri, Some(&b.cookie))).await).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{uri}: {body}");

    let coding = json!({ "direction": "out", "kind": "personal" });
    let before = head_seq(server).await;
    for (kind, payload) in [
        (
            "answer_question",
            json!({
                "client_id": biz, "income_year": 2026,
                "answer": { "question": "only_income", "yes": false },
            }),
        ),
        (
            "code_bank_line",
            json!({ "bank_line_id": lines[0], "coding": coding }),
        ),
        (
            "set_gst_registration",
            json!({ "client_id": biz, "registered": false, "source": "owner" }),
        ),
        ("remove_statement", json!({ "statement_id": statement_id })),
        ("expire_guest", json!({ "client_id": biz, "why": "by_you" })),
    ] {
        let (status, body) = server.command(&b.cookie, kind, payload).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{kind}: {body}");
    }
    assert_eq!(
        head_seq(server).await,
        before,
        "a refused command left something in the log"
    );
    for path in ["/api/clients", "/api/sync?after=0", "/api/history"] {
        let text = server.get_json(path, &b.cookie).await.to_string();
        assert!(!text.contains(biz), "{path} shows the other trial: {text}");
        assert!(
            text.contains(&b.business_id),
            "{path} shows b's own: {text}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// 5. Expiry.

#[tokio::test]
async fn m20_an_unclaimed_trial_past_its_expiry_is_swept_and_nothing_else() {
    let server = server().await;
    // Other people's businesses, to stay exactly as they are: a signed-up owner with lines, and
    // a guest who claimed.
    let (owner, other) = sign_up(&server, "ana@example.nz").await;
    server
        .run_ok(
            &owner,
            "import_statement",
            json!({
                "client_id": other, "file_name": "kowhai.csv", "content_base64": base64(KOWHAI),
            }),
        )
        .await;
    let kept = start(&server, file_source(CARD_FILE, CARD)).await;
    let (status, body, _) = claim(&server, &kept, "kept@example.nz").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let before = dump(&server).await;
    let seq_before = head_seq(&server).await;
    let others: BTreeSet<String> = {
        let mut conn = server.state.store.reader().await.unwrap();
        let mut all = BTreeSet::new();
        for biz in [&other, &kept.business_id] {
            for l in bank_store::bank_lines(&mut conn, biz).await.unwrap() {
                all.insert(l.description);
            }
        }
        all
    };

    // The trial: a file of their own, an answer, a rule naming one of its lines, and an example.
    let g = start(&server, file_source(OWN_FILE, OWN)).await;
    let own = g.business_id.clone();
    let descriptions: Vec<String> = {
        let mut conn = server.state.store.reader().await.unwrap();
        bank_store::bank_lines(&mut conn, &own)
            .await
            .unwrap()
            .into_iter()
            .map(|l| l.description)
            // Only descriptions that are the trial's alone say anything when they're missing.
            .filter(|d| d.len() >= 8 && !others.contains(d))
            .collect()
    };
    assert!(!descriptions.is_empty());
    server
        .run_ok(
            &g.cookie,
            "answer_question",
            json!({
                "client_id": own, "income_year": 2026,
                "answer": { "question": "only_income", "yes": true },
            }),
        )
        .await;
    server
        .run_ok(
            &g.cookie,
            "add_rule",
            json!({
                "client_id": own, "description_contains": descriptions[0],
                "coding": { "direction": "out", "kind": "personal" },
            }),
        )
        .await;
    let (status, body) =
        split(post_guest(&server, example_source(1), Some(&g.cookie), None).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let example = body["business_id"].as_str().unwrap().to_owned();
    let trial = [own.clone(), example.clone()];

    // The trial holds files, statements, lines and journals now.
    let during = dump(&server).await;
    for table in [
        "statement_files",
        "statements",
        "bank_lines",
        "journals",
        "journal_lines",
        "businesses",
    ] {
        assert!(
            during[table].len() > before[table].len(),
            "the trial should add to {table}"
        );
    }

    // A day later the example is finished and the guest's own trial is still live; eight days on
    // with nobody back, it's ended too.
    let swept = guests::sweep(&server.state.store, Utc::now() + Duration::hours(25))
        .await
        .unwrap();
    assert_eq!(swept, 1);
    let swept = guests::sweep(&server.state.store, Utc::now() + Duration::days(8))
        .await
        .unwrap();
    assert_eq!(swept, 1);
    let swept = guests::sweep(&server.state.store, Utc::now() + Duration::days(8))
        .await
        .unwrap();
    assert_eq!(swept, 0, "a second sweep finds nothing");
    let (status, _) = split(server.send(get("/api/me", Some(&g.cookie))).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Its statement files, statements, lines, journals and business are gone, and every other
    // table (every other business) is byte-identical to before the trial.
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
    for table in [
        "statement_files",
        "statements",
        "bank_lines",
        "journals",
        "journal_lines",
        "businesses",
    ] {
        assert_eq!(after[table].len(), before[table].len(), "{table}");
    }
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

    // The user: kept for the log's sake, but holding nothing of theirs.
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

    // command_log is as the ADR says: the trial's rows are redacted in place, nothing anywhere
    // holds its file name or lines, every other row is as it was, and seq is still gapless.
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
        if e.client_id.as_ref().is_some_and(|c| trial.contains(c)) {
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
    assert!(
        before["command_log"]
            .iter()
            .all(|r| after["command_log"].contains(r)),
        "an earlier entry that wasn't the trial's changed"
    );
    let seqs: Vec<i64> = entries.iter().map(|e| e.seq).collect();
    assert_eq!(seqs, (1..=seqs.len() as i64).collect::<Vec<_>>());
    assert!(seqs.len() as i64 > seq_before);
    // Two expiries, both the server's own.
    let ends = log::of_kind(&mut conn, "expire_guest").await.unwrap();
    assert_eq!(ends.len(), 2);
    assert!(ends.iter().all(|e| e.user_id.is_none()));
}
