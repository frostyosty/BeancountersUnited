//! `acct-dev`: for development only (ADR 006).
//!
//! It runs a throwaway master in-process, on a fresh database in a temporary folder loaded with
//! the synthetic fixtures (`acct_server::fixtures`), on `127.0.0.1` with a free port (or
//! `ACCT_BIND`). From its control window you can:
//! - open a window signed in as each dev user (master, staff, viewer), or a signed-out one;
//!   each has its own browser profile, so their logins don't share a cookie
//! - open the same connect screen acct-client shows, to try that flow against this master
//! - run the sync simulator (`sim`)
//!
//! Everything is deleted when it quits. Never point it at a real practice's data.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod sim;

use std::net::SocketAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};

use acct_desktop::server::{self, RunningServer};
use acct_desktop::windows::ServerWindow;
use acct_desktop::{VERSION, check_master, server_url};
use acct_server::fixtures::{self, DEV_PASSWORD, DEV_USERS, Loaded};
use acct_store::users::Role;
use serde::Serialize;
use tauri::{
    AppHandle, Manager, RunEvent, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
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

fn role_name(role: Role) -> &'static str {
    match role {
        Role::Master => "master",
        Role::Staff => "staff",
        Role::Viewer => "viewer",
    }
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

/// Opens acct-client's connect screen, to try that flow against this master.
#[tauri::command]
async fn open_connect(app: AppHandle, state: State<'_, Dev>) -> Result<(), String> {
    let n = state.next_window.fetch_add(1, Ordering::Relaxed);
    WebviewWindowBuilder::new(
        &app,
        format!("connect-{n}"),
        WebviewUrl::App("client.html".into()),
    )
    .title("acct dev: client connect screen")
    .inner_size(480.0, 360.0)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Start {
    version: &'static str,
    address: Option<String>,
}

/// The connect screen's opening state: this master's address, filled in.
#[tauri::command]
fn start(state: State<'_, Dev>) -> Start {
    Start {
        version: VERSION,
        address: state
            .server
            .as_ref()
            .ok()
            .map(|s| s.local_url().trim_start_matches("http://").to_owned()),
    }
}

/// The connect screen's Connect button: like acct-client's, but each connection gets its own
/// fresh browser profile, and nothing is remembered.
#[tauri::command]
async fn connect(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Dev>,
    address: String,
) -> Result<(), String> {
    let url = server_url(&address)?;
    check_master(&url).await?;
    let n = state.next_window.fetch_add(1, Ordering::Relaxed);
    let label = format!("client-{n}");
    ServerWindow {
        profile_dir: Some(state.profile_dir(&label)?),
        title: format!(
            "acct dev: client {n} ({})",
            url.trim_start_matches("http://")
        ),
        label,
        url,
        auto_login: None,
    }
    .open(&app)?;
    let _ = window.close();
    Ok(())
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
        .invoke_handler(tauri::generate_handler![
            status,
            open_as,
            open_connect,
            start,
            connect,
            simulate
        ])
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
