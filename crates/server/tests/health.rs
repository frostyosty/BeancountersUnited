mod common;

use axum::http::StatusCode;
use common::{Server, get, split};

#[tokio::test]
async fn health_reports_ok_without_a_login() {
    let server = Server::new().await;
    let (status, json) = split(server.send(get("/api/health", None)).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], "ok");
    assert_eq!(json["version"], env!("CARGO_PKG_VERSION"));
}
