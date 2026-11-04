//! M19 "Done when": an overseer viewing as a staff user sees only what that staff user sees
//! (including an owner's edits hidden by the owner's sharing setting), can't finalise, reopen or
//! file, and every command plus the start and end of the session is in the log with both
//! identities, and in the staff user's own Changes. ADR 013.
//!
//! Synthetic users: overseer `olive`, practice admin `pam`, staff `sam`, and owner Ana, who
//! doesn't share her own edits with her accountants.

mod common;

use acct_server::access::{RouteRule, WhileActing as RouteWhileActing, while_acting};
use acct_server::commands::CommandEnvelope;
use acct_server::impersonation::{self, WhileActing};
use acct_server::pipeline::{Actor, submit};
use acct_store::users::Role;
use axum::http::{Method, StatusCode, header};
use chrono::{Duration, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

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

struct World {
    server: Server,
    ana_cookie: String,
    ana_id: String,
    business_id: String,
    ben_business_id: String,
    year_id: String,
    year_start: String,
    sam_id: String,
    olive_id: String,
}

fn token() -> String {
    let a = uuid::Uuid::now_v7().simple().to_string();
    let b = uuid::Uuid::now_v7().simple().to_string();
    format!("{a}{b}")
}

async fn sign_up(server: &Server, email: &str, business: &str) -> (String, String, String) {
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
        .map(|c| c.to_str().unwrap().split(';').next().unwrap().to_owned())
        .expect("sign-up signs you in");
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "sign-up: {body}");
    (
        cookie,
        body["me"]["id"].as_str().unwrap().to_owned(),
        body["business_id"].as_str().unwrap().to_owned(),
    )
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
    server
        .ok(
            &boss,
            "create_mapping",
            json!({ "template_id": template_id, "name": "Sole trader", "body": mapping }),
        )
        .await;
    // The users: a practice admin, and the overseer (only the server makes one).
    server
        .ok(
            &boss,
            "create_user",
            json!({
                "username": "pam", "display_name": "pam",
                "password": PASSWORD, "role": "practice_admin",
            }),
        )
        .await;
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
                "username": "olive", "display_name": "olive",
                "password": PASSWORD, "role": "overseer",
            },
        }))
        .unwrap(),
    };
    submit(&server.state.store, &system, envelope, Utc::now())
        .await
        .unwrap();

    let (ana_cookie, ana_id, business_id) =
        sign_up(&server, "ana@example.nz", "Ana's Gardens").await;
    let (_, _, ben_business_id) = sign_up(&server, "ben@example.nz", "Ben's Bikes").await;
    server
        .ok(
            &ana_cookie,
            "import_statement",
            json!({
                "client_id": business_id,
                "file_name": "kowhai-business-2025-08.csv",
                "content_base64": base64(KOWHAI),
            }),
        )
        .await;
    // Ana's own edit. She doesn't share her edits, so her accountants don't see it in Changes.
    server
        .ok(
            &ana_cookie,
            "add_rule",
            json!({
                "client_id": business_id,
                "description_contains": "NO SUCH SHOP",
                "coding": { "direction": "out", "kind": "personal" },
            }),
        )
        .await;
    let invite = token();
    server
        .ok(
            &ana_cookie,
            "create_invite",
            json!({ "client_id": business_id, "email": "sam@practice.nz", "token": invite }),
        )
        .await;
    let sam = server.login("sam").await;
    server
        .ok(&sam, "accept_invite", json!({ "token": invite }))
        .await;
    let client = server
        .get_json(&format!("/api/clients/{business_id}"), &sam)
        .await;
    let year_id = client["years"][0]["id"].as_str().unwrap().to_owned();
    let year_start = client["years"][0]["start"].as_str().unwrap().to_owned();

    let olive = server.login("olive").await;
    let users = server.get_json("/api/users", &olive).await;
    let id_of = |name: &str| -> String {
        users
            .as_array()
            .unwrap()
            .iter()
            .find(|u| u["username"] == name)
            .unwrap_or_else(|| panic!("no user {name}"))["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    World {
        sam_id: id_of("sam"),
        olive_id: id_of("olive"),
        server,
        ana_cookie,
        ana_id,
        business_id,
        ben_business_id,
        year_id,
        year_start,
    }
}

impl World {
    async fn head(&self) -> i64 {
        let mut conn = self.server.state.store.reader().await.unwrap();
        acct_store::log::head_seq(&mut conn).await.unwrap()
    }

    async fn log_after(&self, seq: i64) -> Vec<acct_store::log::LoggedCommand> {
        let mut conn = self.server.state.store.reader().await.unwrap();
        acct_store::log::after(&mut conn, seq, 1000).await.unwrap()
    }

    fn journal(&self) -> Value {
        json!({
            "client_year_id": self.year_id,
            "date": self.year_start,
            "narration": "Adjustment made while viewing as sam",
            "lines": [
                { "account": "100", "amount": -1000 },
                { "account": "290", "amount": 1000 },
            ],
        })
    }

    /// Whether a Changes feed shows one of Ana's own edits.
    fn shows_ana_edit(&self, history: &Value) -> bool {
        history["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["user_id"] == self.ana_id.as_str())
    }
}

#[track_caller]
fn assert_impersonating(status: StatusCode, body: &Value, what: &str) {
    assert_eq!(status, StatusCode::FORBIDDEN, "{what}: {body}");
    assert_eq!(body["code"], "impersonating", "{what}: {body}");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .starts_with("You're viewing as "),
        "{what}: {body}"
    );
}

#[tokio::test]
async fn m19_is_done() {
    let w = setup().await;
    let s = &w.server;
    let olive = s.login("olive").await;
    let sam = s.login("sam").await;
    let biz = &w.business_id;

    // Before: as herself Olive sees everything, including Ana's edit and Ben's business; sam
    // sees neither.
    let clients = s.get_json("/api/clients", &olive).await.to_string();
    assert!(clients.contains(&w.ben_business_id), "{clients}");
    assert!(w.shows_ana_edit(&s.get_json("/api/history", &olive).await));
    assert!(!w.shows_ana_edit(&s.get_json("/api/history", &sam).await));

    // Nobody but an overseer starts, and not as another overseer.
    let pam = s.login("pam").await;
    let reason = |id: &str| json!({ "user_id": id, "reason": "Sam can't load the TB" });
    let (status, body) = s
        .command(&pam, "start_impersonation", reason(&w.sam_id))
        .await;
    assert_impersonating_or_forbidden(status, &body);
    let (status, body) = s
        .command(&olive, "start_impersonation", reason(&w.olive_id))
        .await;
    assert!(status.is_client_error(), "can't view as yourself: {body}");

    // Start viewing as the staff user.
    let before_start = w.head().await;
    let acting_id = s.ok(&olive, "start_impersonation", reason(&w.sam_id)).await;

    // Every read is what sam gets signed in, hidden owner edits included.
    for uri in [
        "/api/clients".to_owned(),
        "/api/history".to_owned(),
        format!("/api/clients/{biz}"),
        format!("/api/businesses/{biz}"),
        format!("/api/businesses/{biz}/save-tax"),
        format!("/api/businesses/{biz}/coding-settings"),
        format!("/api/years/{}", w.year_id),
    ] {
        let (own_status, own_body) = split(s.send(get(&uri, Some(&sam))).await).await;
        let (status, body) = split(s.send(get(&uri, Some(&olive))).await).await;
        assert_eq!(status, own_status, "GET {uri}: {body}");
        assert_eq!(body, own_body, "GET {uri}");
    }
    assert!(!w.shows_ana_edit(&s.get_json("/api/history", &olive).await));
    for uri in [
        format!("/api/businesses/{}", w.ben_business_id),
        format!("/api/clients/{}", w.ben_business_id),
    ] {
        let (status, _) = split(s.send(get(&uri, Some(&olive))).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}: sam can't see Ben's");
    }
    let me = s.get_json("/api/me", &olive).await;
    assert_eq!(me["id"], w.sam_id.as_str());
    assert_eq!(me["real"]["user_id"], w.olive_id.as_str());
    assert_eq!(me["acting_as"]["allow_changes"], false);

    // Read-only: a permitted write is refused, and nothing is logged.
    let head = w.head().await;
    let (status, body) = s.command(&olive, "post_journal", w.journal()).await;
    assert_impersonating(status, &body, "post_journal");
    assert!(
        body["message"].as_str().unwrap().contains("read-only"),
        "{body}"
    );
    assert_eq!(w.head().await, head, "a refused command was logged");

    // Allow changes (with a reason), then the same write succeeds.
    s.ok(
        &olive,
        "allow_impersonation_changes",
        json!({ "reason": "To post the adjustment sam asked for" }),
    )
    .await;
    s.ok(&olive, "post_journal", w.journal()).await;

    // Sign-off style and IRD actions are refused even with changes on.
    let head = w.head().await;
    let (status, body) = s
        .command(
            &olive,
            "finalise_year",
            json!({ "client_year_id": w.year_id, "accept_uncategorised": true }),
        )
        .await;
    assert_impersonating(status, &body, "finalise_year");
    let (status, body) = s
        .command(
            &olive,
            "reopen_year",
            json!({ "client_year_id": w.year_id, "reason": "X" }),
        )
        .await;
    assert_impersonating(status, &body, "reopen_year");
    // IRD: no `ird_` command or `/api/ird/` route exists until M14, so check the rule M14 must
    // follow, and that a request to such a route doesn't get through.
    assert!(matches!(
        impersonation::classify("ird_file_return"),
        WhileActing::Never(_)
    ));
    for method in [Method::GET, Method::POST] {
        assert_eq!(
            while_acting(&method, "/api/ird/returns", RouteRule::SignedIn),
            RouteWhileActing::Refused("deal with IRD")
        );
    }
    let (status, _) = s
        .command(
            &olive,
            "ird_file_return",
            json!({ "client_year_id": w.year_id }),
        )
        .await;
    assert!(status.is_client_error(), "ird_ command got through");
    assert_eq!(w.head().await, head, "a refused command was logged");

    // End: the overseer's own view again.
    s.ok(
        &olive,
        "end_impersonation",
        json!({ "reason": "Fixed what sam asked for" }),
    )
    .await;
    let me = s.get_json("/api/me", &olive).await;
    assert_eq!(me["id"], w.olive_id.as_str(), "{me}");
    assert!(me["acting_as"].is_null() && me["real"].is_null(), "{me}");
    let clients = s.get_json("/api/clients", &olive).await.to_string();
    assert!(clients.contains(&w.ben_business_id), "{clients}");
    assert!(w.shows_ana_edit(&s.get_json("/api/history", &olive).await));

    // The log: start, allow, the journal and the end, each with both identities; nothing else.
    let rows = w.log_after(before_start).await;
    let kinds: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "start_impersonation",
            "allow_impersonation_changes",
            "post_journal",
            "end_impersonation"
        ]
    );
    for row in &rows {
        assert_eq!(
            row.user_id.as_deref(),
            Some(w.olive_id.as_str()),
            "{}",
            row.kind
        );
        assert_eq!(
            row.acting_as.as_deref(),
            Some(w.sam_id.as_str()),
            "{}",
            row.kind
        );
    }
    assert!(rows[0].result.contains(&acting_id) && rows[3].result.contains(&acting_id));

    // Sam's own Changes shows all four, naming Olive and "as" sam, and still not Ana's edit.
    let history = s.get_json("/api/history", &sam).await;
    assert!(!w.shows_ana_edit(&history));
    let entries = history["entries"].as_array().unwrap();
    for row in &rows {
        let entry = entries
            .iter()
            .find(|e| e["seq"] == row.seq)
            .unwrap_or_else(|| panic!("sam's Changes is missing {}", row.kind));
        assert_eq!(entry["user_id"], w.olive_id.as_str(), "{}", row.kind);
        assert_eq!(
            entry["acting_as"]["user_id"],
            w.sam_id.as_str(),
            "{}",
            row.kind
        );
    }

    // A second session, started and left alone, times out and its end is logged by the sweep.
    let second = s.ok(&olive, "start_impersonation", reason(&w.sam_id)).await;
    {
        let mut writer = s.state.store.writer().await;
        let session = acct_store::sessions::by_acting_id(&mut writer, &second)
            .await
            .unwrap()
            .unwrap();
        let since = session.acting_since.unwrap() - Duration::minutes(31);
        acct_store::sqlx::query("UPDATE sessions SET acting_since = ? WHERE acting_id = ?")
            .bind(since)
            .bind(&second)
            .execute(&mut *writer)
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
    assert_eq!(end.kind, "end_impersonation");
    assert_eq!(end.user_id, None, "the server ended it");
    assert_eq!(end.acting_as.as_deref(), Some(w.sam_id.as_str()));
    assert!(end.payload.contains("timed_out"), "{}", end.payload);
    assert!(end.result.contains(&second));
    let me = s.get_json("/api/me", &olive).await;
    assert_eq!(me["id"], w.olive_id.as_str(), "{me}");

    // Ana sees the change made on her business, with both names, but not the session's start,
    // allow or end rows (their reasons are for the overseers and sam alone).
    let ana_kinds: Vec<String> = s.get_json("/api/history", &w.ana_cookie).await["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap().to_owned())
        .collect();
    assert!(
        ana_kinds.iter().any(|k| k == "post_journal"),
        "{ana_kinds:?}"
    );
    assert!(
        !ana_kinds
            .iter()
            .any(|k| k.ends_with("_impersonation") || k == "allow_impersonation_changes"),
        "{ana_kinds:?}"
    );
}

/// A practice admin can't start: the command is refused, whichever way.
#[track_caller]
fn assert_impersonating_or_forbidden(status: StatusCode, body: &Value) {
    assert!(
        status == StatusCode::FORBIDDEN || status == StatusCode::UNPROCESSABLE_ENTITY,
        "a practice admin started viewing as someone: {status} {body}"
    );
}
