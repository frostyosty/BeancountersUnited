//! Logging in and out, the session cookie, and who may submit what over HTTP.

mod common;

use acct_store::sessions::{self, Session};
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use chrono::{Duration, Utc};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::json;

#[tokio::test]
async fn login_sets_a_strict_http_only_cookie_and_logout_ends_it() {
    let server = Server::new().await;
    let response = server
        .send(post_json(
            "/api/login",
            None,
            &json!({ "username": "BOSS", "password": PASSWORD }),
        ))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let set_cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .to_owned();
    assert!(set_cookie.starts_with("acct_session="));
    assert!(set_cookie.contains("HttpOnly"));
    assert!(set_cookie.contains("SameSite=Strict"));
    let cookie = set_cookie.split(';').next().unwrap().to_owned();
    let (_, me) = split(response).await;
    assert_eq!(me["username"], "boss");
    assert_eq!(me["role"], "master");

    let (status, me) = split(server.send(get("/api/me", Some(&cookie))).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(me["display_name"], "Bo Boss");

    let response = server
        .send(post_json("/api/logout", Some(&cookie), &json!({})))
        .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert!(
        response.headers()[header::SET_COOKIE]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    let (status, body) = split(server.send(get("/api/me", Some(&cookie))).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["code"], "unauthenticated");
}

#[tokio::test]
async fn wrong_passwords_and_unknown_users_get_the_same_answer() {
    let server = Server::new().await;
    for (username, password) in [("boss", "wrong password"), ("nobody", PASSWORD)] {
        let response = server
            .send(post_json(
                "/api/login",
                None,
                &json!({ "username": username, "password": password }),
            ))
            .await;
        assert!(response.headers().get(header::SET_COOKIE).is_none());
        let (status, body) = split(response).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["code"], "bad_credentials");
    }
}

#[tokio::test]
async fn commands_need_a_valid_session() {
    let server = Server::new().await;
    let body = json!({
        "id": new_id(),
        "kind": "create_user",
        "payload": { "username": "x", "display_name": "x", "password": PASSWORD, "role": "staff" },
    });
    for cookie in [None, Some("acct_session=forged")] {
        let (status, body) =
            split(server.send(post_json("/api/commands", cookie, &body)).await).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["code"], "unauthenticated");
    }

    // An expired session is no session. Expire every session, including set-up's own login.
    let cookie = server.login("boss").await;
    {
        let mut w = server.state.store.writer().await;
        let all: Vec<Session> = acct_store::sqlx::query_as("SELECT * FROM sessions")
            .fetch_all(&mut *w)
            .await
            .unwrap();
        assert!(!all.is_empty());
        let past = Utc::now() - Duration::hours(1);
        for s in all {
            sessions::delete(&mut w, &s.token_hash).await.unwrap();
            sessions::insert(
                &mut w,
                &Session {
                    expires_at: past,
                    ..s
                },
            )
            .await
            .unwrap();
        }
    }
    let (status, _) = split(server.send(get("/api/me", Some(&cookie))).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn roles_are_enforced_over_http() {
    let server = Server::new().await;
    let payload = json!({
        "username": "newbie",
        "display_name": "New Person",
        "password": PASSWORD,
        "role": "staff",
    });
    for who in ["sam", "val"] {
        let cookie = server.login(who).await;
        let (status, body) = server
            .command(&cookie, "create_user", payload.clone())
            .await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{who}");
        assert_eq!(body["code"], "forbidden");
    }
    let boss = server.login("boss").await;
    let (status, body) = server.command(&boss, "create_user", payload).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    server.login("newbie").await;

    // Nobody can initialise over HTTP, not even a master user.
    let (status, _) = server
        .command(
            &boss,
            "initialise",
            json!({
                "practice_name": "Another",
                "username": "other",
                "display_name": "Other",
                "password": PASSWORD,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn passwords_are_never_logged() {
    let server = Server::new().await;
    let mut r = server.state.store.reader().await.unwrap();
    let log = acct_store::log::after(&mut r, 0, 100).await.unwrap();
    assert_eq!(log[0].kind, "initialise");
    assert_eq!(log[1].kind, "create_user");
    for entry in &log {
        assert!(!entry.payload.contains(PASSWORD), "{}", entry.payload);
        assert!(entry.payload.contains("[redacted]"));
    }
    // Users are hashed with argon2id.
    let user = acct_store::users::by_username(&mut r, "sam")
        .await
        .unwrap()
        .unwrap();
    assert!(user.password_hash.starts_with("$argon2id$"));
}

#[tokio::test]
async fn user_rules_are_checked() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let user = |username: &str, password: &str| json!({ "username": username, "display_name": "X", "password": password, "role": "staff" });
    for (payload, code) in [
        (user("sam", PASSWORD), "username_taken"),
        (user("SAM", PASSWORD), "username_taken"),
        (user("has space", PASSWORD), "invalid_username"),
        (user("short", "123456789"), "weak_password"),
    ] {
        let (status, body) = server.command(&boss, "create_user", payload).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(body["code"], code);
    }
}

#[tokio::test]
async fn bad_bodies_are_malformed() {
    let server = Server::new().await;
    let cookie = server.login("boss").await;
    for body in [
        "not json".to_owned(),
        json!({ "id": new_id(), "kind": "no_such_command", "payload": {} }).to_string(),
        json!({ "kind": "create_user", "payload": {} }).to_string(),
    ] {
        let request = Request::post("/api/commands")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::COOKIE, &cookie)
            .body(Body::from(body))
            .unwrap();
        let (status, body) = split(server.send(request).await).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(body["code"], "malformed");
    }
}

#[tokio::test]
async fn a_server_initialises_only_once() {
    let server = Server::new().await;
    let system = acct_server::pipeline::Actor {
        user_id: None,
        role: acct_store::users::Role::Master,
    };
    let again = acct_server::commands::CommandEnvelope {
        id: new_id(),
        command: acct_server::commands::Command::Initialise {
            practice_name: "Again".into(),
            username: "boss2".into(),
            display_name: "Boss Two".into(),
            password: PASSWORD.into(),
        },
    };
    let err = acct_server::pipeline::submit(&server.state.store, &system, again, Utc::now())
        .await
        .unwrap_err();
    assert_eq!(err.body().code, "already_initialised");
}
