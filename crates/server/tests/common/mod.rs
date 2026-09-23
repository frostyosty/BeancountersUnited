//! Shared set-up for the HTTP tests: a fresh server with a practice and one user per role.
#![allow(dead_code)]

use std::sync::Arc;

use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_server::{AppState, app};
use acct_store::Store;
use acct_store::users::Role;
use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Request, Response, StatusCode, header};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

pub const PASSWORD: &str = "correct horse battery";

pub struct Server {
    _dir: TempDir,
    pub state: AppState,
}

pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

impl Server {
    /// A server set up with `acctd init` as `boss` (master), plus `sam` (staff) and `val`
    /// (viewer), all with `PASSWORD`.
    pub async fn new() -> Server {
        let dir = TempDir::new().unwrap();
        let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
        let system = Actor {
            user_id: None,
            role: Role::Master,
        };
        let init = CommandEnvelope {
            id: new_id(),
            command: Command::Initialise {
                practice_name: "Example Practice".into(),
                username: "boss".into(),
                display_name: "Bo Boss".into(),
                password: PASSWORD.into(),
            },
        };
        submit(&store, &system, init, chrono::Utc::now())
            .await
            .unwrap();
        let server = Server {
            _dir: dir,
            state: AppState {
                store: Arc::new(store),
            },
        };
        let boss = server.login("boss").await;
        for (username, role) in [("sam", "staff"), ("val", "viewer")] {
            let (status, body) = server
                .command(
                    &boss,
                    "create_user",
                    json!({
                        "username": username,
                        "display_name": username,
                        "password": PASSWORD,
                        "role": role,
                    }),
                )
                .await;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
        server
    }

    pub fn app(&self) -> Router {
        app(self.state.clone())
    }

    pub async fn send(&self, request: Request<Body>) -> Response<Body> {
        self.app().oneshot(request).await.unwrap()
    }

    /// Logs in and returns the `Cookie` header value to send with later requests.
    pub async fn login(&self, username: &str) -> String {
        let response = self
            .send(post_json(
                "/api/login",
                None,
                &json!({ "username": username, "password": PASSWORD }),
            ))
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let set_cookie = response.headers()[header::SET_COOKIE].to_str().unwrap();
        set_cookie.split(';').next().unwrap().to_owned()
    }

    pub async fn command(&self, cookie: &str, kind: &str, payload: Value) -> (StatusCode, Value) {
        let body = json!({ "id": new_id(), "kind": kind, "payload": payload });
        let response = self
            .send(post_json("/api/commands", Some(cookie), &body))
            .await;
        split(response).await
    }
}

pub fn post_json(uri: &str, cookie: Option<&str>, body: &Value) -> Request<Body> {
    let mut r = Request::post(uri).header(header::CONTENT_TYPE, "application/json");
    if let Some(c) = cookie {
        r = r.header(header::COOKIE, c);
    }
    r.body(Body::from(body.to_string())).unwrap()
}

pub fn get(uri: &str, cookie: Option<&str>) -> Request<Body> {
    let mut r = Request::get(uri);
    if let Some(c) = cookie {
        r = r.header(header::COOKIE, c);
    }
    r.body(Body::empty()).unwrap()
}

pub async fn split(response: Response<Body>) -> (StatusCode, Value) {
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let body = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).unwrap()
    };
    (status, body)
}
