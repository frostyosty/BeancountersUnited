//! The acct HTTP API: routes, auth, the command pipeline and the sync feed.

pub mod auth;
pub mod commands;
pub mod error;
pub mod fixtures;
pub mod ledger;
pub mod pipeline;
pub mod reads;
pub mod tb_import;
#[cfg(feature = "embed-web")]
pub mod web;

use std::sync::Arc;

use acct_store::Store;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use ts_rs::TS;

use crate::auth::CurrentUser;
use crate::commands::{Accepted, CommandEnvelope};
use crate::error::CommandError;

/// What every handler shares.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
}

/// Response body of `GET /api/health`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Health {
    pub status: String,
    pub version: String,
}

pub fn app(state: AppState) -> Router {
    let router = Router::new()
        .route("/api/health", get(health))
        .route("/api/login", post(auth::login))
        .route("/api/logout", post(auth::logout))
        .route("/api/me", get(auth::me))
        .route("/api/commands", post(submit_command))
        .route("/api/practice", get(reads::get_practice))
        .route("/api/users", get(reads::list_users))
        .route("/api/clients", get(reads::list_clients))
        .route("/api/clients/{id}", get(reads::get_client))
        .route("/api/clients/{id}/chart", get(reads::get_chart))
        .route("/api/years/{id}", get(reads::get_year))
        .route("/api/years/{id}/journals", get(reads::list_journals))
        .route("/api/years/{id}/tb", get(reads::get_trial_balance))
        .route("/api/years/{id}/report", get(reads::get_report))
        .route(
            "/api/years/{id}/tb-import/preview",
            post(tb_import::preview),
        )
        .route("/api/sync", get(reads::sync));
    #[cfg(feature = "embed-web")]
    let router = router.fallback(web::serve);
    router.with_state(state)
}

/// Serves the API (and, with `embed-web`, the web app) on `listener` until `shutdown` resolves.
/// `acctd` and the desktop apps all run the server through this.
pub async fn serve(
    listener: tokio::net::TcpListener,
    state: AppState,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> std::io::Result<()> {
    axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown)
        .await
}

async fn health() -> Json<Health> {
    Json(Health {
        status: "ok".to_owned(),
        version: env!("CARGO_PKG_VERSION").to_owned(),
    })
}

/// `POST /api/commands`
async fn submit_command(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Result<Json<CommandEnvelope>, JsonRejection>,
) -> Result<Json<Accepted>, CommandError> {
    let Json(envelope) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let accepted =
        pipeline::submit(&state.store, &user.actor(), envelope, chrono::Utc::now()).await?;
    Ok(Json(accepted))
}
