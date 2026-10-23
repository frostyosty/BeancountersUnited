//! `acct-dev`: for development only (ADR 006).
//!
//! It runs a throwaway master in-process, on a fresh database in a temporary folder loaded with
//! the synthetic fixtures (`acct_server::fixtures`), on `127.0.0.1` with a free port (or
//! `ACCT_BIND`). From its control window you can:
//! - open a window signed in as each dev user (master, staff, viewer), or a signed-out one;
//!   each has its own browser profile, so their logins don't share a cookie
//! - run the sync simulator (`sim`)
//!
//! Everything is deleted when it quits. Never point it at a real practice's data.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod sim;

use std::net::SocketAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use acct_desktop::VERSION;
use acct_desktop::server::{self, RunningServer};
use acct_desktop::windows::ServerWindow;
use acct_server::fixtures::{self, DEV_PASSWORD, DEV_USERS, Loaded};
use acct_store::users::Role;
use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tempfile::TempDir;
use tracing_subscriber::EnvFilter;

struct Dev {
    server: Result<RunningServer, String>,
    loaded: Option<Loaded>,
    /// The database and every window's browser profile. Deleted on exit.
    dir: Mutex<Option<TempDir>>,
    next_window: AtomicU32,
}

impl Dev {
    fn server(&self) -> Result<&RunningServer, String> {
        self.server.as_ref().map_err(Clone::clone)
    }

    fn profile_dir(&self, name: &str) -> Result<std::path::PathBuf, String> {
        let dir = self.dir.lock().map_err(|e| e.to_string())?;
        let dir = dir.as_ref().ok_or("acct-dev is shutting down")?;
        Ok(dir.path().join(format!("profile-{name}")))
    }
}

#[derive(Serialize)]
struct DevUser {
    username: &'static str,
    role: Role,
}

/// The role's name as the API spells it ("staff", "practice_admin"), so new roles need no change here.
fn role_name(role: Role) -> String {
    serde_json::to_value(role)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| format!("{role:?}"))
}

#[derive(Serialize)]
struct DevStatus {
    version: &'static str,
    url: Option<String>,
    error: Option<String>,
    client_name: Option<String>,
    journals: usize,
    users: Vec<DevUser>,
    password: &'static str,
}

#[tauri::command]
fn status(state: State<'_, Dev>) -> DevStatus {
    DevStatus {
        version: VERSION,
        url: state.server.as_ref().ok().map(RunningServer::local_url),
        error: state.server.as_ref().err().cloned(),
        client_name: state.loaded.as_ref().map(|l| l.client_name.clone()),
        journals: state.loaded.as_ref().map_or(0, |l| l.journals),
        users: DEV_USERS
            .iter()
            .map(|&(username, role)| DevUser { username, role })
            .collect(),
        password: DEV_PASSWORD,
    }
}

/// Opens a window signed in as `username` (one of the dev users), or signed out if it's `None`.
#[tauri::command]
async fn open_as(
    app: AppHandle,
    state: State<'_, Dev>,
    username: Option<String>,
) -> Result<(), String> {
    let server = state.server()?;
    let (label, title, auto_login) = match username {
        Some(name) => {
            let (_, role) = DEV_USERS
                .iter()
                .find(|(u, _)| *u == name)
                .ok_or_else(|| format!("{name:?} isn't a dev user"))?;
            let title = format!("acct dev: {name} ({})", role_name(*role));
            (
                format!("as-{name}"),
                title,
                Some((name, DEV_PASSWORD.to_owned())),
            )
        }
        None => {
            let n = state.next_window.fetch_add(1, Ordering::Relaxed);
            (
                format!("signed-out-{n}"),
                "acct dev: signed out".into(),
                None,
            )
        }
    };
    ServerWindow {
        profile_dir: Some(state.profile_dir(&label)?),
        label,
        title,
        url: server.local_url(),
        auto_login,
    }
    .open(&app)
    .map(|_| ())
}

#[tauri::command]
async fn simulate(
    state: State<'_, Dev>,
    clients: u32,
    journals_each: u32,
) -> Result<sim::SimReport, String> {
    if !(1..=50).contains(&clients) || !(1..=200).contains(&journals_each) {
        return Err("Use 1 to 50 clients and 1 to 200 journals each.".into());
    }
    let url = state.server()?.local_url();
    let config = sim::SimConfig {
        clients,
        journals_each,
    };
    sim::run(&url, "staff", DEV_PASSWORD, config).await
}

fn bind_addr() -> Result<SocketAddr, String> {
    let bind = std::env::var("ACCT_BIND").unwrap_or_else(|_| "127.0.0.1:0".to_owned());
    bind.parse()
        .map_err(|_| format!("ACCT_BIND={bind:?} isn't an address and port."))
}

/// A fresh database with the fixtures loaded, served on `bind`.
async fn start_master(dir: &TempDir) -> Result<(RunningServer, Loaded), String> {
    let server = server::start(&dir.path().join("acct.db"), bind_addr()?).await?;
    let loaded = fixtures::load(&server.store)
        .await
        .map_err(|e| format!("Loading the fixtures failed: {e}"))?;
    Ok((server, loaded))
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![status, open_as, simulate])
        .setup(|app| {
            let dir = tempfile::Builder::new().prefix("acct-dev-").tempdir()?;
            let (server, loaded) = match tauri::async_runtime::block_on(start_master(&dir)) {
                Ok((server, loaded)) => (Ok(server), Some(loaded)),
                Err(e) => (Err(e), None),
            };
            app.manage(Dev {
                server,
                loaded,
                dir: Mutex::new(Some(dir)),
                next_window: AtomicU32::new(1),
            });
            WebviewWindowBuilder::new(app, "control", WebviewUrl::App("dev.html".into()))
                .title("acct dev")
                .inner_size(640.0, 760.0)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the control window quits, closing every other window with it.
            if window.label() == "control" && matches!(event, WindowEvent::CloseRequested { .. }) {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("acct-dev failed to start");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            // Best effort: a webview may still hold its profile open.
            let dev = app.state::<Dev>();
            if let Ok(mut dir) = dev.dir.lock() {
                drop(dir.take());
            }
        }
    });
}
