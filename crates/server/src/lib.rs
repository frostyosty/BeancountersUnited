//! The acct HTTP API: routes, auth, the command pipeline and the sync feed.

pub mod ai;
pub mod assets;
pub mod auth;
pub mod business;
pub mod commands;
pub mod error;
pub mod fixtures;
pub mod ledger;
pub mod merchants;
pub mod pipeline;
pub mod reads;
pub mod save_tax;
pub mod tax;
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
use crate::commands::{Accepted, CommandRequest};
use crate::error::CommandError;

/// What every handler shares.
#[derive(Clone)]
pub struct AppState {
    pub store: Arc<Store>,
    /// The AI suggester (ADR 009), if the server is configured with one. `None` means Save tax
    /// shows no AI suggestions.
    pub suggester: Option<Arc<dyn acct_ai::Suggester>>,
}

impl AppState {
    /// A state with the suggester the environment configures, if any.
    pub fn new(store: Arc<Store>) -> AppState {
        AppState {
            store,
            suggester: ai::suggester_from_env(),
        }
    }
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
        .route("/api/asset-classes", get(assets::list_classes))
        .route(
            "/api/clients/{id}/asset-classes",
            get(assets::client_classes),
        )
        .route(
            "/api/clients/{id}/asset-classes/{class_id}/apply-preview",
            get(assets::apply_defaults_preview),
        )
        .route("/api/years/{id}/assets", get(assets::year_assets))
        .route("/api/businesses/{id}", get(tax::get_business))
        .route("/api/businesses/{id}/tax", get(tax::get_tax))
        .route("/api/businesses/{id}/save-tax", get(save_tax::get_save_tax))
        .route(
            "/api/businesses/{id}/coding-settings",
            get(save_tax::get_coding_settings),
        )
        .route("/api/businesses/{id}/rules", get(save_tax::get_rules))
        .route(
            "/api/merchants/{entity_type}",
            get(merchants::get_merchants),
        )
        .route(
            "/api/businesses/{id}/ai-suggestions",
            get(ai::get_ai_suggestions).post(ai::post_ai_suggestions),
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
    body: Result<Json<CommandRequest>, JsonRejection>,
) -> Result<Json<Accepted>, CommandError> {
    let Json(request) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let accepted = pipeline::submit_via(
        &state.store,
        &user.actor(),
        request.envelope,
        request.via,
        chrono::Utc::now(),
    )
    .await?;
    Ok(Json(accepted))
}
