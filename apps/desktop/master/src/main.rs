//! `acct-master`: the office server as a desktop app (ADR 006).
//!
//! It runs the acct server in-process on the office network (`0.0.0.0:8080`, or `ACCT_BIND`)
//! with its database in the app's local data folder (or `ACCT_DB`). Its control window sets up a
//! new practice and shows staff the address to connect `acct-client` to. Closing the control
//! window stops the server.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::net::SocketAddr;
use std::path::PathBuf;

use acct_desktop::server::{self, RunningServer};
use acct_desktop::windows::ServerWindow;
use acct_desktop::{DEFAULT_PORT, VERSION, lan_ipv4};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{self, Actor};
use acct_store::users::Role;
use serde::Serialize;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tracing_subscriber::EnvFilter;

struct Master {
    server: Result<RunningServer, String>,
    db_path: PathBuf,
}

#[derive(Serialize)]
struct Status {
    version: &'static str,
    db_path: String,
    /// Why the server isn't running, if it isn't.
    error: Option<String>,
    initialised: bool,
    /// What staff type into acct-client, if this computer has an office network address.
    lan_address: Option<String>,
    port: Option<u16>,
}

#[tauri::command]
async fn status(state: State<'_, Master>) -> Result<Status, String> {
    let (error, initialised, port) = match &state.server {
        Ok(s) => (
            None,
            server::is_initialised(&s.store).await?,
            Some(s.addr.port()),
        ),
        Err(e) => (Some(e.clone()), false, None),
    };
    let lan_address = port.and_then(|p| {
        lan_ipv4().map(|ip| {
            if p == DEFAULT_PORT {
                ip.to_string()
            } else {
                format!("{ip}:{p}")
            }
        })
    });
    Ok(Status {
        version: VERSION,
        db_path: state.db_path.display().to_string(),
        error,
        initialised,
        lan_address,
        port,
    })
}

/// Sets up a new practice and its first master user, as `acctd init` does.
#[tauri::command]
async fn initialise(
    state: State<'_, Master>,
    practice_name: String,
    username: String,
    display_name: String,
    password: String,
) -> Result<(), String> {
    let server = state.server.as_ref().map_err(Clone::clone)?;
    let envelope = CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command: Command::Initialise {
            practice_name,
            username,
            display_name,
            password,
        },
    };
    let system = Actor {
        user_id: None,
        role: Role::Master,
    };
    pipeline::submit(&server.store, &system, envelope, chrono::Utc::now())
        .await
        .map(|_| ())
        .map_err(|e| e.body().message)
}

/// Opens acct itself (the web app this server serves) in a window.
#[tauri::command]
async fn open_app(app: AppHandle, state: State<'_, Master>) -> Result<(), String> {
    let server = state.server.as_ref().map_err(Clone::clone)?;
    open_office(&app, server)
}

fn open_office(app: &AppHandle, server: &RunningServer) -> Result<(), String> {
    ServerWindow {
        label: "office".into(),
        title: "acct".into(),
        url: server.local_url(),
        profile_dir: None,
        auto_login: None,
    }
    .open(app)
    .map(|_| ())
}

fn db_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(db) = std::env::var_os("ACCT_DB") {
        return Ok(db.into());
    }
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("acct.db"))
}

fn bind_addr() -> Result<SocketAddr, String> {
    match std::env::var("ACCT_BIND") {
        Ok(bind) => bind
            .parse()
            .map_err(|_| format!("ACCT_BIND={bind:?} isn't an address and port.")),
        Err(_) => Ok(SocketAddr::from(([0, 0, 0, 0], DEFAULT_PORT))),
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![status, initialise, open_app])
        .setup(|app| {
            let handle = app.handle().clone();
            let db = db_path(&handle);
            let server = db.clone().and_then(|db| {
                let bind = bind_addr()?;
                tauri::async_runtime::block_on(server::start(&db, bind))
            });
            WebviewWindowBuilder::new(app, "control", WebviewUrl::App("master.html".into()))
                .title("acct master")
                .inner_size(560.0, 680.0)
                .build()?;
            // A practice that's already set up goes straight to acct.
            if let Ok(s) = &server
                && tauri::async_runtime::block_on(server::is_initialised(&s.store)) == Ok(true)
                && let Err(e) = open_office(&handle, s)
            {
                tracing::error!("couldn't open acct: {e}");
            }
            app.manage(Master {
                server,
                db_path: db.unwrap_or_default(),
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // The control window owns the server: closing it quits, which stops the server.
            if window.label() == "control" && matches!(event, WindowEvent::CloseRequested { .. }) {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .expect("acct-master failed to start");
}
