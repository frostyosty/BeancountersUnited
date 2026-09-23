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

pub const CHART: &str = include_str!("../../../../fixtures/practice/company-chart.json");
pub const TEMPLATE: &str = include_str!("../../../../fixtures/practice/company-template.json");
pub const MAPPING: &str = include_str!("../../../../fixtures/practice/company-mapping.json");
pub const CLIENT: &str = include_str!("../../../../fixtures/clients/example-widgets.json");

pub struct LoadedFixture {
    pub client_id: String,
    pub year_ids: Vec<String>,
}

impl Server {
    /// Submits a command that must succeed and returns the id of what it created.
    pub async fn ok(&self, cookie: &str, kind: &str, payload: Value) -> String {
        let (status, body) = self.command(cookie, kind, payload).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {body}");
        body["entity_id"].as_str().unwrap().to_owned()
    }

    /// Loads the fixture practice defaults (as `master_cookie`) and the fixture company with its
    /// journals (as `staff_cookie`), entirely through `POST /api/commands`.
    pub async fn load_fixture(&self, master_cookie: &str, staff_cookie: &str) -> LoadedFixture {
        self.practice_defaults(master_cookie).await;
        let (client_id, year_ids) = self.fixture_client(staff_cookie).await;
        let client: Value = serde_json::from_str(CLIENT).unwrap();
        for (year, year_id) in client["years"].as_array().unwrap().iter().zip(&year_ids) {
            for journal in year["journals"].as_array().unwrap() {
                let mut payload = journal.clone();
                payload["client_year_id"] = json!(year_id);
                self.ok(staff_cookie, "post_journal", payload).await;
            }
        }
        LoadedFixture {
            client_id,
            year_ids,
        }
    }

    /// The fixture's master chart, template and mapping for companies.
    pub async fn practice_defaults(&self, master_cookie: &str) {
        let accounts: Value = serde_json::from_str(CHART).unwrap();
        self.ok(
            master_cookie,
            "create_master_chart",
            json!({ "entity_type": "company", "name": "Company", "accounts": accounts }),
        )
        .await;
        let template: Value = serde_json::from_str(TEMPLATE).unwrap();
        let template_id = self
            .ok(
                master_cookie,
                "create_template",
                json!({ "entity_type": "company", "name": "Company (standard)", "body": template }),
            )
            .await;
        let mapping: Value = serde_json::from_str(MAPPING).unwrap();
        self.ok(
            master_cookie,
            "create_mapping",
            json!({ "template_id": template_id, "name": "Company (standard)", "body": mapping }),
        )
        .await;
    }

    /// The fixture company and its years, with no journals. Returns (client, years).
    pub async fn fixture_client(&self, staff_cookie: &str) -> (String, Vec<String>) {
        let client: Value = serde_json::from_str(CLIENT).unwrap();
        let client_id = self
            .ok(
                staff_cookie,
                "create_client",
                json!({
                    "name": client["name"],
                    "entity_type": client["entity_type"],
                    "retained_earnings": client["retained_earnings"],
                    "rounding_priority": client["rounding_priority"],
                }),
            )
            .await;
        let mut year_ids = Vec::new();
        for year in client["years"].as_array().unwrap() {
            let year_id = self
                .ok(
                    staff_cookie,
                    "create_client_year",
                    json!({ "client_id": client_id, "start": year["start"], "end": year["end"] }),
                )
                .await;
            year_ids.push(year_id);
        }
        (client_id, year_ids)
    }

    pub async fn get_json(&self, uri: &str, cookie: &str) -> Value {
        let (status, body) = split(self.send(get(uri, Some(cookie))).await).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
        body
    }

    pub async fn get_bytes(&self, uri: &str, cookie: &str) -> Vec<u8> {
        let response = self.send(get(uri, Some(cookie))).await;
        assert_eq!(response.status(), StatusCode::OK, "{uri}");
        to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec()
    }
}
