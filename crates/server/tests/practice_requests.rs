//! M21's practice requests (ADR 015, 7): a practice asks us for an account.
//!
//! A request is a command through the pipeline, stored in its own table with the details kept out
//! of the log; five per address an hour and a hundred a day; only overseers, as themselves, read
//! the list or delete one; and the sweep deletes a request 90 days after it arrived. Every name,
//! email and phone here is made up (hard rule 1).

mod common;

use std::net::SocketAddr;

use acct_server::commands::{Command, CommandEnvelope};
use acct_server::guests;
use acct_server::pipeline::{Actor, submit};
use acct_server::practice_requests::{PER_DAY, PracticeClients};
use acct_store::users::Role;
use acct_store::{log, practice_requests as store};
use axum::body::Body;
use axum::extract::ConnectInfo;
use axum::http::{Request, StatusCode};
use chrono::{Duration, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

const NAME: &str = "Rewi Testperson";
const EMAIL: &str = "rewi@example.nz";
const PRACTICE: &str = "Testperson & Co";
const PHONE: &str = "+64 9 555 0100";

fn ask(name: &str, email: &str) -> Value {
    json!({
        "id": new_id(), "name": name, "email": email, "practice_name": PRACTICE,
        "clients": "11_to_50", "phone": PHONE, "from": "accountants_page",
    })
}

fn post(body: &Value, address: &str) -> Request<Body> {
    let mut request = post_json("/api/practice-requests", None, body);
    request
        .extensions_mut()
        .insert(ConnectInfo(address.parse::<SocketAddr>().unwrap()));
    request
}

/// Asks from `address`, which must be accepted. Returns the request's id.
async fn asks(server: &Server, body: &Value, address: &str) -> String {
    let (status, body) = split(server.send(post(body, address)).await).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["entity_id"].as_str().unwrap().to_owned()
}

/// An overseer, made the only way there is: by the server, through the pipeline.
async fn overseer(server: &Server, username: &str) -> String {
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

/// A server with the sole-trader starter set, which signing up needs.
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
    assert_eq!(response.status(), StatusCode::OK, "sign-up");
    response.headers()[axum::http::header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn list(server: &Server, cookie: &str) -> (StatusCode, Value) {
    split(
        server
            .send(get("/api/practice-requests", Some(cookie)))
            .await,
    )
    .await
}

#[tokio::test]
async fn a_request_is_stored_and_kept_out_of_the_log() {
    let server = server().await;
    let id = asks(&server, &ask(NAME, EMAIL), "203.0.113.1:5000").await;

    let mut conn = server.state.store.reader().await.unwrap();
    let stored = store::get(&mut conn, &id).await.unwrap().unwrap();
    assert_eq!(
        (
            stored.name.as_str(),
            stored.email.as_str(),
            stored.practice_name.as_str(),
            stored.clients.as_str(),
            stored.phone.as_deref(),
            stored.came_from.as_deref(),
        ),
        (
            NAME,
            EMAIL,
            PRACTICE,
            "11_to_50",
            Some(PHONE),
            Some("accountants_page")
        )
    );

    // The log has the command, but none of the details: those live only in the table.
    let entries = log::after(&mut conn, 0, 1000).await.unwrap();
    let row = entries
        .iter()
        .find(|e| e.kind == "request_practice_account")
        .unwrap();
    assert_eq!(row.user_id, None);
    let payload: Value = serde_json::from_str(&row.payload).unwrap();
    assert_eq!(payload["name"], "[redacted]", "{payload}");
    assert_eq!(payload["email"], "[redacted]", "{payload}");
    assert_eq!(payload["practice_name"], "[redacted]", "{payload}");
    assert_eq!(payload["phone"], "[redacted]", "{payload}");
    assert_eq!(payload["clients"], "11_to_50");
    assert_eq!(payload["from"], "accountants_page");
    let all =
        serde_json::to_string(&entries.iter().map(|e| &e.payload).collect::<Vec<_>>()).unwrap();
    for detail in [NAME, EMAIL, PRACTICE, PHONE] {
        assert!(!all.contains(detail), "{detail} reached the log");
    }

    // History names no one, and only overseers see it.
    let olive = overseer(&server, "olive").await;
    let history = server.get_json("/api/history", &olive).await.to_string();
    assert!(
        history.contains("A practice asked for an account (11–50 clients)."),
        "{history}"
    );
    assert!(!history.contains(NAME) && !history.contains(EMAIL));
    let ana = owner(&server, "ana@example.nz").await;
    let history = server.get_json("/api/history", &ana).await.to_string();
    assert!(!history.contains("asked for an account"), "{history}");

    // Sending the same id again is the same request, not another.
    let body = ask(NAME, EMAIL);
    let first = asks(&server, &body, "203.0.113.1:5000").await;
    let again = asks(&server, &body, "203.0.113.1:5000").await;
    assert_eq!(first, again);
    assert_eq!(store::list(&mut conn).await.unwrap().len(), 2);
}

#[tokio::test]
async fn each_address_asks_five_times_an_hour() {
    let server = server().await;
    for i in 0..5 {
        asks(
            &server,
            &ask(NAME, &format!("a{i}@example.nz")),
            "203.0.113.2:5000",
        )
        .await;
    }
    let (status, body) = split(
        server
            .send(post(&ask(NAME, "a5@example.nz"), "203.0.113.2:6000"))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert_eq!(body["code"], "too_many_requests");
    assert_eq!(
        body["message"],
        "We've had a few requests from your network in the last hour. Try again later, or get in \
         touch through the contact page."
    );
    // Another address still can.
    asks(&server, &ask(NAME, "b@example.nz"), "198.51.100.7:5000").await;
    let mut conn = server.state.store.reader().await.unwrap();
    assert_eq!(store::list(&mut conn).await.unwrap().len(), 6);
}

#[tokio::test]
async fn a_hundred_a_day_across_every_address() {
    let server = server().await;
    let anonymous = Actor {
        user_id: None,
        role: Role::BusinessOwner,
        acting_as: None,
    };
    let command = |i: i64| CommandEnvelope {
        id: new_id(),
        command: Command::RequestPracticeAccount {
            name: NAME.into(),
            email: format!("p{i}@example.nz"),
            practice_name: PRACTICE.into(),
            clients: PracticeClients::UpTo10,
            phone: None,
            from: None,
        },
    };
    let now = Utc::now();
    for i in 0..PER_DAY {
        submit(&server.state.store, &anonymous, command(i), now)
            .await
            .unwrap();
    }
    // Checked in the command, from the table, so it holds whichever address asks.
    let (status, body) = split(server.send(post(&ask(NAME, EMAIL), "192.0.2.9:5000")).await).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    // A day on, there's room again.
    submit(
        &server.state.store,
        &anonymous,
        command(PER_DAY),
        now + Duration::hours(25),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_request_is_checked() {
    let server = server().await;
    let address = "203.0.113.3:5000";
    let refused = |body: Value| {
        let server = &server;
        async move { split(server.send(post(&body, address)).await).await }
    };
    let mut body = ask(NAME, EMAIL);
    for (field, value, code) in [
        ("name", json!("   "), "invalid_name"),
        ("practice_name", json!(""), "invalid_practice_name"),
        ("email", json!("not an email"), "invalid_email"),
        ("phone", json!("call me"), "invalid_phone"),
    ] {
        let mut b = body.clone();
        b["id"] = json!(new_id());
        b[field] = value;
        let (status, reply) = refused(b).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{field}: {reply}");
        assert_eq!(reply["code"], code, "{field}: {reply}");
    }
    // Bands and sources are from their lists only.
    for (field, value) in [("clients", "lots"), ("from", "somewhere")] {
        body["id"] = json!(new_id());
        let mut b = body.clone();
        b[field] = json!(value);
        let (status, reply) = refused(b).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{field}: {reply}");
    }
    let mut conn = server.state.store.reader().await.unwrap();
    assert!(store::list(&mut conn).await.unwrap().is_empty());
}

#[tokio::test]
async fn only_overseers_read_and_delete_requests() {
    let server = server().await;
    let first = asks(&server, &ask(NAME, EMAIL), "203.0.113.4:5000").await;
    let second = asks(
        &server,
        &json!({
            "id": new_id(), "name": "Mere Testperson", "email": "mere@example.nz",
            "practice_name": "Mere's", "clients": "over_200",
        }),
        "203.0.113.4:5000",
    )
    .await;

    // An overseer sees them, newest first.
    let olive = overseer(&server, "olive").await;
    let (status, body) = list(&server, &olive).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let ids: Vec<&str> = body
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [second.as_str(), first.as_str()]);
    let r = &body[1];
    assert_eq!(r["name"], NAME);
    assert_eq!(r["email"], EMAIL);
    assert_eq!(r["clients"], "11_to_50");
    assert_eq!(r["phone"], PHONE);
    assert_eq!(r["from"], "accountants_page");
    assert_eq!(body[0]["phone"], Value::Null);
    assert_eq!(body[0]["from"], Value::Null);

    // Nobody else does: not the practice, an owner or a guest.
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let ana = owner(&server, "ana@example.nz").await;
    for (who, cookie) in [("boss", &boss), ("sam", &sam), ("an owner", &ana)] {
        let (status, body) = list(&server, cookie).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}: {body}");
        let (status, body) =
            split(server.send(get("/api/overseer/trials", Some(cookie))).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}: {body}");
        let (status, body) = server
            .command(
                cookie,
                "delete_practice_request",
                json!({ "request_id": first, "why": "by_overseer" }),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}: {body}");
    }

    // Signed in, nobody asks through /api/commands: only the public route asks, with no user.
    for cookie in [&olive, &ana] {
        let (status, body) = server
            .command(
                cookie,
                "request_practice_account",
                json!({
                    "name": NAME, "email": EMAIL, "practice_name": PRACTICE,
                    "clients": "up_to_10",
                }),
            )
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    }

    // An overseer viewing as someone is that someone, so is refused too.
    let (status, body) = server
        .command(
            &olive,
            "start_impersonation",
            json!({ "user_id": me(&server, &ana).await, "reason": "Checking a report" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, body) = list(&server, &olive).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "viewing as: {body}");
    let (status, _) = server
        .command(
            &olive,
            "delete_practice_request",
            json!({ "request_id": first, "why": "by_overseer" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    server.ok(&olive, "end_impersonation", json!({})).await;

    // Only the server deletes one for its age.
    let (status, body) = server
        .command(
            &olive,
            "delete_practice_request",
            json!({ "request_id": first, "why": "expired" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "server_only");

    // As themselves, an overseer deletes one.
    server
        .ok(
            &olive,
            "delete_practice_request",
            json!({ "request_id": first, "why": "by_overseer" }),
        )
        .await;
    let (_, body) = list(&server, &olive).await;
    assert_eq!(body.as_array().unwrap().len(), 1);
    let history = server.get_json("/api/history", &olive).await.to_string();
    assert!(
        history.contains("Olive Overseer deleted a practice request."),
        "{history}"
    );
    let (status, body) = server
        .command(
            &olive,
            "delete_practice_request",
            json!({ "request_id": first, "why": "by_overseer" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
}

#[tokio::test]
async fn the_sweep_deletes_a_request_after_90_days() {
    let server = server().await;
    let id = asks(&server, &ask(NAME, EMAIL), "203.0.113.5:5000").await;
    let olive = overseer(&server, "olive").await;
    let (_, body) = list(&server, &olive).await;
    let delete_after = body[0]["delete_after"].as_str().unwrap().to_owned();
    let created_at = body[0]["created_at"].as_str().unwrap().to_owned();
    let parse = |s: &str| chrono::DateTime::parse_from_rfc3339(s).unwrap();
    assert_eq!(
        parse(&delete_after) - parse(&created_at),
        Duration::days(90)
    );

    // Not yet: the server can't delete it early either.
    guests::sweep(&server.state.store, Utc::now() + Duration::days(89))
        .await
        .unwrap();
    let mut conn = server.state.store.reader().await.unwrap();
    assert!(store::get(&mut conn, &id).await.unwrap().is_some());
    let system = Actor {
        user_id: None,
        role: Role::Overseer,
        acting_as: None,
    };
    let early = submit(
        &server.state.store,
        &system,
        CommandEnvelope {
            id: new_id(),
            command: serde_json::from_value(json!({
                "kind": "delete_practice_request",
                "payload": { "request_id": id, "why": "expired" },
            }))
            .unwrap(),
        },
        Utc::now() + Duration::days(89),
    )
    .await;
    assert_eq!(early.unwrap_err().body().code, "not_due");

    // 90 days on, the guest sweep deletes it, through the pipeline, as the server.
    guests::sweep(&server.state.store, Utc::now() + Duration::days(91))
        .await
        .unwrap();
    assert!(store::get(&mut conn, &id).await.unwrap().is_none());
    let entries = log::after(&mut conn, 0, 1000).await.unwrap();
    let row = entries.last().unwrap();
    assert_eq!(row.kind, "delete_practice_request");
    assert_eq!(row.user_id, None);
    let history = server.get_json("/api/history", &olive).await.to_string();
    assert!(
        history.contains("The system deleted a practice request after 90 days."),
        "{history}"
    );
}

async fn me(server: &Server, cookie: &str) -> String {
    server.get_json("/api/me", cookie).await["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
