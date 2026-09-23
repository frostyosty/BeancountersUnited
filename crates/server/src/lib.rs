//! The acct HTTP API: routes, auth, the command pipeline and the sync feed.

pub mod commands;
pub mod error;
pub mod pipeline;

use axum::{Json, Router, routing::get};
use serde::Serialize;
use ts_rs::TS;

/// Response body of `GET /api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Health {
    pub status: String,
    pub version: String,
}

pub fn app() -> Router {
    Router::new().route("/api/health", get(health))
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    })
}
