//! M21's accountant view for guests (ADR 015, 1), `from` on `claim_guest` (4) and the overseer's
//! trial counts (5).
//!
//! A guest reads its own trial's year and an example's, read-only; nobody else reads them; every
//! write on a year is refused, and so is the PDF, with the reason. Claiming keeps where the save
//! came from in the log and nowhere else. The counts come from the log, redacted trials included.
//! A year whose layout is missing says so plainly, never a 500.

mod common;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicU8, Ordering};

use acct_server::guests::{self, ClaimFrom};
use acct_server::pipeline::{Actor, submit};
use acct_server::trial_counts;
use acct_server::{api_routes, commands::CommandEnvelope};
use acct_store::users::Role;
use acct_store::{log, sqlx};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Method, Request, Response, StatusCode, header};
use chrono::{Duration, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

/// The visitor's own file.
const OWN_FILE: &str = "harbourlight-cheque-2025-08.ofx";
const OWN: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx");

/// The year reads a guest may use (ADR 015, 1.1).
const YEAR_READS: [&str; 6] = [
    "/api/years/{id}",
    "/api/years/{id}/journals",
    "/api/years/{id}/tb",
    "/api/years/{id}/report",
    "/api/years/{id}/gl",
    "/api/years/{id}/assets",
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

fn own_file() -> Value {
    json!({ "file": { "file_name": OWN_FILE, "content_base64": base64(OWN) } })
}

fn example(n: u8) -> Value {
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

struct Guest {
    cookie: String,
    business_id: String,
}

/// A visitor starts a trial (or, with `cookie`, the same browser starts another); it must work.
/// Each start comes from its own address, so the per-address limit never gets in the way.
async fn start(server: &Server, source: Value, cookie: Option<&str>) -> Guest {
    let mut request = post_json(
        "/api/guest",
        cookie,
        &json!({ "id": new_id(), "source": source }),
    );
    let address = format!("192.0.2.{}:5000", next_octet());
    request
        .extensions_mut()
        .insert(ConnectInfo(address.parse::<SocketAddr>().unwrap()));
    let response = server.send(request).await;
    let new_cookie = set_cookie(&response, "acct_session");
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "start: {body}");
    Guest {
        cookie: cookie
            .map(str::to_owned)
            .or(new_cookie)
            .expect("starting a trial sets the session cookie"),
        business_id: body["business_id"].as_str().unwrap().to_owned(),
    }
}

/// A new address for each start.
fn next_octet() -> u8 {
    static NEXT: AtomicU8 = AtomicU8::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// The business's first year.
async fn year_of(server: &Server, cookie: &str, business_id: &str) -> String {
    let client = server
        .get_json(&format!("/api/clients/{business_id}"), cookie)
        .await;
    client["years"][0]["id"]
        .as_str()
        .unwrap_or_else(|| panic!("a year: {client}"))
        .to_owned()
}

/// A signed-up owner's session.
async fn owner(server: &Server, email: &str) -> String {
    let response = server
        .send(post_json(
            "/api/signup",
            None,
            &json!({
                "id": new_id(), "email": email, "display_name": "Owner", "password": PASSWORD,
                "business_name": "Owner's", "start_date": "2025-04-01",
            }),
        ))
        .await;
    set_cookie(&response, "acct_session").expect("sign-up signs you in")
}

async fn read(server: &Server, path: &str, cookie: &str) -> (StatusCode, Value) {
    split(server.send(get(path, Some(cookie))).await).await
}

async fn add_overseer(server: &Server, username: &str) -> String {
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
    submit(&server.state.store, &system, envelope, Utc::now())
        .await
        .unwrap();
    server.login(username).await
}

#[tokio::test]
async fn a_guest_reads_its_own_years_and_nobody_else_does() {
    let server = server().await;
    let g = start(&server, own_file(), None).await;
    let own_year = year_of(&server, &g.cookie, &g.business_id).await;
    let ex = start(&server, example(1), Some(&g.cookie)).await;
    assert_ne!(ex.business_id, g.business_id);
    let example_year = year_of(&server, &g.cookie, &ex.business_id).await;

    // Every year read in the allowed list really is a route.
    let routes: Vec<_> = api_routes();
    for path in YEAR_READS {
        assert!(
            routes.iter().any(|(m, p)| *m == Method::GET && *p == path),
            "{path}"
        );
        assert!(guests::route_allowed(&Method::GET, path), "{path}");
    }

    // The guest reads both: its own trial and the example.
    for year in [&own_year, &example_year] {
        for path in YEAR_READS {
            let uri = path.replace("{id}", year);
            let (status, body) = read(&server, &uri, &g.cookie).await;
            assert_eq!(status, StatusCode::OK, "{uri}: {body}");
        }
    }
    // The statements are built, with the codes behind each line, and the GL shows codes.
    let (_, report) = read(&server, &format!("/api/years/{own_year}/report"), &g.cookie).await;
    assert!(report["statements"].is_array(), "{report}");
    let (_, gl) = read(&server, &format!("/api/years/{own_year}/gl"), &g.cookie).await;
    assert!(
        gl["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["code"].is_string()),
        "{gl}"
    );

    // Another guest and a signed-up owner are told they don't exist.
    let other = start(&server, own_file(), None).await;
    let ana = owner(&server, "ana@example.nz").await;
    for (who, cookie) in [("another guest", &other.cookie), ("an owner", &ana)] {
        for year in [&own_year, &example_year] {
            for path in YEAR_READS {
                let uri = path.replace("{id}", year);
                let (status, body) = read(&server, &uri, cookie).await;
                assert_eq!(status, StatusCode::NOT_FOUND, "{who} {uri}: {body}");
                assert_eq!(body["details"]["id"], year.as_str(), "{who} {uri}: {body}");
            }
        }
    }

    // The PDF needs an account, and says so.
    for year in [&own_year, &example_year] {
        let (status, body) =
            read(&server, &format!("/api/years/{year}/report.pdf"), &g.cookie).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
        assert_eq!(body["code"], "guest");
        assert_eq!(body["message"], "Save your work first to download the PDF.");
    }

    // Every other route on a year, read or write, is refused for a guest.
    let mut refused = 0;
    for (method, path) in routes {
        if !path.starts_with("/api/years/{id}") || YEAR_READS.contains(&path) {
            continue;
        }
        let uri = path.replace("{id}", &own_year);
        let request = Request::builder()
            .method(method.clone())
            .uri(&uri)
            .header(header::COOKIE, &g.cookie);
        let request = if method == Method::GET {
            request.body(Body::empty()).unwrap()
        } else {
            request
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap()
        };
        let (status, body) = split(server.send(request).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}: {body}");
        assert_eq!(body["code"], "guest", "{method} {uri}: {body}");
        refused += 1;
    }
    assert!(refused >= 5, "only {refused} year routes refused");
}

#[tokio::test]
async fn every_write_on_a_year_is_refused_for_a_guest() {
    let server = server().await;
    let g = start(&server, own_file(), None).await;
    let year = year_of(&server, &g.cookie, &g.business_id).await;
    let ex = start(&server, example(1), Some(&g.cookie)).await;
    let example_year = year_of(&server, &g.cookie, &ex.business_id).await;
    let (_, journals) = read(&server, &format!("/api/years/{year}/journals"), &g.cookie).await;
    let journal = journals.to_string();
    let journal_id = journals
        .as_array()
        .and_then(|j| j.first())
        .and_then(|j| j["id"].as_str())
        .map_or_else(new_id, str::to_owned);
    let mut conn = server.state.store.reader().await.unwrap();
    let before = log::head_seq(&mut conn).await.unwrap();

    for (business, year) in [(&g.business_id, &year), (&ex.business_id, &example_year)] {
        let writes = [
            (
                "post_journal",
                json!({
                    "client_year_id": year, "date": "2025-08-01", "narration": "X",
                    "lines": [{ "account": "100", "amount": -1 }, { "account": "290", "amount": 1 }],
                }),
            ),
            ("import_tb", json!({ "client_year_id": year, "rows": [] })),
            ("reverse_journal", json!({ "journal_id": journal_id })),
            ("run_depreciation", json!({ "client_year_id": year })),
            (
                "finalise_year",
                json!({ "client_year_id": year, "accept_uncategorised": true }),
            ),
            (
                "reopen_year",
                json!({ "client_year_id": year, "reason": "X" }),
            ),
            ("move_year_layout", json!({ "client_year_id": year })),
            (
                "pick_notes",
                json!({ "client_year_id": year, "paragraph_ids": [] }),
            ),
            (
                "edit_note",
                json!({
                    "client_year_id": year, "paragraph_id": new_id(), "title": "X", "body": "X",
                }),
            ),
            (
                "create_client_year",
                json!({ "client_id": business, "start": "2026-04-01", "end": "2027-03-31" }),
            ),
        ];
        for (kind, payload) in writes {
            let (status, body) = server.command(&g.cookie, kind, payload).await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{kind}: {body}");
            assert_eq!(body["code"], "guest", "{kind}: {body}");
            assert!(
                body["message"]
                    .as_str()
                    .unwrap()
                    .starts_with("Save your work first to "),
                "{kind}: {body}"
            );
        }
    }
    // Nothing reached the log, and the books are as they were.
    assert_eq!(log::head_seq(&mut conn).await.unwrap(), before);
    let (_, after) = read(&server, &format!("/api/years/{year}/journals"), &g.cookie).await;
    assert_eq!(after.to_string(), journal);
}

#[tokio::test]
async fn claiming_keeps_where_the_save_came_from_in_the_log_only() {
    let server = server().await;
    let g = start(&server, own_file(), None).await;
    let claim = |from: Value| {
        json!({
            "id": new_id(), "email": "ana@example.nz", "display_name": "Ana Ngata",
            "password": PASSWORD, "from": from,
        })
    };

    // A `from` off the list is refused, and nothing changes.
    let mut conn = server.state.store.reader().await.unwrap();
    let before = log::head_seq(&mut conn).await.unwrap();
    let (status, body) = split(
        server
            .send(post_json(
                "/api/guest/claim",
                Some(&g.cookie),
                &claim(json!("locked:everything")),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(log::head_seq(&mut conn).await.unwrap(), before);
    let (status, _) = read(&server, "/api/me", &g.cookie).await;
    assert_eq!(status, StatusCode::OK, "still a guest");

    // On the list, it's kept with the claim, and not sent back.
    let response = server
        .send(post_json(
            "/api/guest/claim",
            Some(&g.cookie),
            &claim(json!("locked:pdf")),
        ))
        .await;
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let text = body.to_string();
    assert!(
        !text.contains("locked:pdf") && !text.contains("\"from\""),
        "{body}"
    );
    let entries = log::after(&mut conn, before, 100).await.unwrap();
    let row = entries.iter().find(|e| e.kind == "claim_guest").unwrap();
    let payload: Value = serde_json::from_str(&row.payload).unwrap();
    assert_eq!(payload["from"], "locked:pdf", "{payload}");
    assert_eq!(
        serde_json::from_value::<ClaimFrom>(payload["from"].clone()).unwrap(),
        ClaimFrom::LockedPdf
    );

    // Every name on the list is accepted.
    for from in [
        "banner",
        "accountant_view",
        "saving",
        "submit",
        "locked:invite",
        "locked:ai",
        "locked:pdf",
        "expiry",
    ] {
        serde_json::from_value::<ClaimFrom>(json!(from)).unwrap();
    }
}

#[tokio::test]
async fn the_overseer_counts_trials_from_the_log() {
    let server = server().await;
    let now = Utc::now();
    // One saved from the PDF prompt, one saved with no `from`, one deleted by the visitor, and one
    // left to expire.
    let saved = start(&server, own_file(), None).await;
    server
        .send(post_json(
            "/api/guest/claim",
            Some(&saved.cookie),
            &json!({
                "id": new_id(), "email": "ana@example.nz", "display_name": "Ana",
                "password": PASSWORD, "from": "locked:pdf",
            }),
        ))
        .await;
    let quiet = start(&server, own_file(), None).await;
    server
        .send(post_json(
            "/api/guest/claim",
            Some(&quiet.cookie),
            &json!({
                "id": new_id(), "email": "mere@example.nz", "display_name": "Mere",
                "password": PASSWORD,
            }),
        ))
        .await;
    let deleted = start(&server, own_file(), None).await;
    server
        .ok(
            &deleted.cookie,
            "expire_guest",
            json!({ "client_id": deleted.business_id, "why": "by_you" }),
        )
        .await;
    let left = start(&server, own_file(), None).await;

    // Eight days on, the trial nobody came back to is ended.
    let later = now + Duration::days(8);
    guests::sweep(&server.state.store, later).await.unwrap();
    let mut conn = server.state.store.reader().await.unwrap();
    let (redacted,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM command_log WHERE kind = 'start_guest' AND redacted_seq IS NOT NULL",
    )
    .fetch_one(&mut *conn)
    .await
    .unwrap();
    assert!(redacted >= 2, "the ended trials' starts are redacted");
    let _ = left;

    let counts = trial_counts::counts(&mut conn, later).await.unwrap();
    assert_eq!(counts.weeks.len(), trial_counts::WEEKS);
    assert!(
        counts.weeks[0].starts > counts.weeks[1].starts,
        "newest first"
    );
    let t = &counts.total;
    assert_eq!(
        (
            t.started,
            t.saved,
            t.moved,
            t.expired,
            t.expired_unused,
            t.expired_by_you,
            t.expired_example_finished
        ),
        (4, 2, 0, 2, 1, 1, 0),
        "{t:?}"
    );
    let froms: Vec<_> = t.saves_by_from.iter().map(|s| (s.from, s.saves)).collect();
    assert_eq!(froms, [(Some(ClaimFrom::LockedPdf), 1), (None, 1)]);
    // The weeks add up to the total.
    let started: i64 = counts.weeks.iter().map(|w| w.counts.started).sum();
    let expired: i64 = counts.weeks.iter().map(|w| w.counts.expired).sum();
    assert_eq!((started, expired), (4, 2));

    // The route is an overseer's alone.
    let olive = add_overseer(&server, "olive").await;
    let (status, body) = read(&server, "/api/overseer/trials", &olive).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["total"]["started"], 4, "{body}");
    assert_eq!(body["total"]["saves_by_from"][0]["from"], "locked:pdf");
    assert_eq!(body["total"]["saves_by_from"][1]["from"], Value::Null);
    let boss = server.login("boss").await;
    let guest = start(&server, own_file(), None).await;
    for (who, cookie) in [("boss", &boss), ("a guest", &guest.cookie)] {
        let (status, body) = read(&server, "/api/overseer/trials", cookie).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}: {body}");
    }
}

#[tokio::test]
async fn a_missing_layout_is_said_plainly() {
    let server = server().await;
    let g = start(&server, own_file(), None).await;
    let year = year_of(&server, &g.cookie, &g.business_id).await;
    // A pinned version that's gone can't happen through any command; break the database by hand
    // to see what the statements would say.
    {
        let mut w = server.state.store.writer().await;
        sqlx::query("PRAGMA foreign_keys = OFF")
            .execute(&mut *w)
            .await
            .unwrap();
        sqlx::query("UPDATE client_years SET template_version_id = 'gone' WHERE id = ?")
            .bind(&year)
            .execute(&mut *w)
            .await
            .unwrap();
        sqlx::query("PRAGMA foreign_keys = ON")
            .execute(&mut *w)
            .await
            .unwrap();
    }
    let (status, body) = read(&server, &format!("/api/years/{year}/report"), &g.cookie).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "no_layout");
    assert_eq!(
        body["message"],
        "There's no statement layout for this business yet."
    );
    // The rest of the accountant view still reads.
    for path in ["tb", "gl", "journals"] {
        let (status, body) = read(&server, &format!("/api/years/{year}/{path}"), &g.cookie).await;
        assert_eq!(status, StatusCode::OK, "{path}: {body}");
    }
}
