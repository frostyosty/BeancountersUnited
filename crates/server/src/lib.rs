//! The acct HTTP API: routes, auth, the command pipeline and the sync feed.

pub mod access;
pub mod ai;
pub mod assets;
pub mod auth;
pub mod business;
pub mod commands;
pub mod error;
pub mod finalise;
pub mod fixtures;
pub mod history;
pub mod ledger;
pub mod merchants;
pub mod paragraphs;
pub mod pdf;
pub mod pipeline;
pub mod presence;
pub mod reads;
pub mod reconcile;
pub mod reports;
pub mod save_tax;
pub mod signup;
pub mod tax;
pub mod tb_import;
#[cfg(feature = "embed-web")]
pub mod web;

use std::collections::BTreeMap;
use std::sync::Arc;

use acct_store::Store;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::Method;
use axum::routing::{MethodRouter, get, post};
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
    /// Who's signed in now (M13), kept in memory.
    pub presence: Arc<presence::Presence>,
}

impl AppState {
    /// A state with the suggester the environment configures, if any.
    pub fn new(store: Arc<Store>) -> AppState {
        AppState {
            store,
            suggester: ai::suggester_from_env(),
            presence: Arc::default(),
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

/// Every API route: its method, its path and its handler. `app` builds the router from this, and
/// `tests/tenancy.rs` walks it, so a route can't be added without a tenancy test seeing it. Each
/// one also needs a rule in `access::route_rule`, or the access layer refuses it.
fn routes() -> Vec<(Method, &'static str, MethodRouter<AppState>)> {
    vec![
        (Method::GET, "/api/health", get(health)),
        (Method::POST, "/api/login", post(auth::login)),
        (Method::POST, "/api/logout", post(auth::logout)),
        (Method::POST, "/api/signup", post(signup::sign_up_route)),
        (Method::GET, "/api/me", get(auth::me)),
        (Method::POST, "/api/commands", post(submit_command)),
        (Method::GET, "/api/practice", get(reads::get_practice)),
        (Method::GET, "/api/users", get(reads::list_users)),
        (Method::GET, "/api/clients", get(reads::list_clients)),
        (Method::GET, "/api/clients/{id}", get(reads::get_client)),
        (
            Method::GET,
            "/api/clients/{id}/chart",
            get(reads::get_chart),
        ),
        (Method::GET, "/api/years/{id}", get(reads::get_year)),
        (
            Method::GET,
            "/api/years/{id}/journals",
            get(reads::list_journals),
        ),
        (
            Method::GET,
            "/api/years/{id}/tb",
            get(reads::get_trial_balance),
        ),
        (
            Method::GET,
            "/api/years/{id}/report",
            get(reads::get_report),
        ),
        (
            Method::GET,
            "/api/years/{id}/reconciliation",
            get(reconcile::get_reconciliation),
        ),
        (Method::GET, "/api/years/{id}/gl", get(reports::get_gl)),
        (
            Method::GET,
            "/api/years/{id}/analysis",
            get(reports::get_analysis),
        ),
        (
            Method::GET,
            "/api/years/{id}/snapshot",
            get(finalise::get_snapshot),
        ),
        (
            Method::GET,
            "/api/years/{id}/finalise-check",
            get(finalise::get_finalise_check),
        ),
        (
            Method::GET,
            "/api/years/{id}/report.pdf",
            get(pdf::get_report_pdf),
        ),
        (
            Method::POST,
            "/api/years/{id}/tb-import/preview",
            post(tb_import::preview),
        ),
        (Method::GET, "/api/asset-classes", get(assets::list_classes)),
        (
            Method::GET,
            "/api/clients/{id}/asset-classes",
            get(assets::client_classes),
        ),
        (
            Method::GET,
            "/api/clients/{id}/asset-classes/{class_id}/apply-preview",
            get(assets::apply_defaults_preview),
        ),
        (
            Method::GET,
            "/api/years/{id}/assets",
            get(assets::year_assets),
        ),
        (Method::GET, "/api/businesses/{id}", get(tax::get_business)),
        (Method::GET, "/api/businesses/{id}/tax", get(tax::get_tax)),
        (
            Method::GET,
            "/api/businesses/{id}/save-tax",
            get(save_tax::get_save_tax),
        ),
        (
            Method::GET,
            "/api/businesses/{id}/coding-settings",
            get(save_tax::get_coding_settings),
        ),
        (
            Method::GET,
            "/api/businesses/{id}/rules",
            get(save_tax::get_rules),
        ),
        (
            Method::GET,
            "/api/merchants/{entity_type}",
            get(merchants::get_merchants),
        ),
        (
            Method::GET,
            "/api/paragraph-library/{entity_type}",
            get(paragraphs::get_library),
        ),
        (
            Method::GET,
            "/api/paragraphs/{id}/push-preview",
            get(paragraphs::push_preview),
        ),
        (
            Method::GET,
            "/api/years/{id}/notes",
            get(paragraphs::get_year_notes),
        ),
        (
            Method::GET,
            "/api/businesses/{id}/ai-suggestions",
            get(ai::get_ai_suggestions),
        ),
        (
            Method::POST,
            "/api/businesses/{id}/ai-suggestions",
            post(ai::post_ai_suggestions),
        ),
        (Method::GET, "/api/sync", get(reads::sync)),
        (Method::GET, "/api/history", get(history::get_history)),
        (Method::POST, "/api/presence", post(presence::post_presence)),
    ]
}

/// Every API route's method and path, as registered.
pub fn api_routes() -> Vec<(Method, &'static str)> {
    routes().into_iter().map(|(m, p, _)| (m, p)).collect()
}

pub fn app(state: AppState) -> Router {
    let mut by_path: BTreeMap<&'static str, MethodRouter<AppState>> = BTreeMap::new();
    for (_, path, handler) in routes() {
        let merged = match by_path.remove(path) {
            Some(existing) => existing.merge(handler),
            None => handler,
        };
        by_path.insert(path, merged);
    }
    let mut router = Router::new();
    for (path, handler) in by_path {
        router = router.route(path, handler);
    }
    // The access layer runs for every route above (not the web app's files), before its handler.
    let router = router.route_layer(axum::middleware::from_fn_with_state(
        state.clone(),
        access::guard,
    ));
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
