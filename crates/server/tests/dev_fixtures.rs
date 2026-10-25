//! `make db-reset`'s loader (`acct_server::fixtures`) runs end to end, and the sole trader it adds
//! has the starter paragraph library and a year whose statements carry its notes.

mod common;

use std::sync::Arc;

use acct_server::fixtures::{self, DEV_PASSWORD, SOLE_TRADER_NAME};
use acct_server::{AppState, app};
use acct_store::Store;
use axum::http::{StatusCode, header};
use serde_json::{Value, json};
use tower::ServiceExt;

#[tokio::test]
async fn the_dev_fixtures_load_with_a_sole_trader_whose_year_has_notes() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
    fixtures::load(&store).await.unwrap();
    let router = app(AppState::new(Arc::new(store)));
    let send = |request| router.clone().oneshot(request);

    let login = send(common::post_json(
        "/api/login",
        None,
        &json!({ "username": "staff", "password": DEV_PASSWORD }),
    ))
    .await
    .unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    let cookie = login.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let get = async |uri: &str| -> Value {
        let (status, body) =
            common::split(send(common::get(uri, Some(&cookie))).await.unwrap()).await;
        assert_eq!(status, StatusCode::OK, "{uri}: {body}");
        body
    };

    let library = get("/api/paragraph-library/sole_trader").await;
    assert_eq!(library.as_array().unwrap().len(), 8);

    let clients = get("/api/clients").await;
    let clients = clients.as_array().unwrap();
    // The company stays first, where the desktop sync simulator looks for it.
    assert_eq!(clients[0]["name"], "Example Widgets Limited");
    let sole = clients
        .iter()
        .find(|c| c["name"] == SOLE_TRADER_NAME)
        .unwrap();
    let detail = get(&format!("/api/clients/{}", sole["id"].as_str().unwrap())).await;
    let year = detail["years"][0]["id"].as_str().unwrap().to_owned();

    let notes = get(&format!("/api/years/{year}/notes")).await;
    assert_eq!(notes.as_array().unwrap().len(), 6);
    let report = get(&format!("/api/years/{year}/report")).await;
    let notes = report["notes"].as_array().unwrap();
    // Note 1 holds the four policies; income tax and owner's equity follow.
    assert_eq!(notes.len(), 3, "{notes:?}");
    assert_eq!(notes[0]["sections"].as_array().unwrap().len(), 4);
    let text = notes[0]["sections"][0]["text"].to_string();
    assert!(text.contains(SOLE_TRADER_NAME), "{text}");
}
