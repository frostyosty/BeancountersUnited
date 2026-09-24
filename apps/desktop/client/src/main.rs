//! `acct-client`: connects a staff or viewer PC to the office's acct master (ADR 006).
//!
//! It asks for the master's address (remembering the last one), checks it's an acct master of
//! the same version, then shows the master's web app. The app is the same for every role: what
//! someone can do depends on the account the master set up for them.

#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

use std::path::PathBuf;

use acct_desktop::windows::ServerWindow;
use acct_desktop::{VERSION, check_master, server_url};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::EnvFilter;

/// What the client remembers between runs, in its config folder.
#[derive(Default, Serialize, Deserialize)]
struct Settings {
    address: Option<String>,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("client.json"))
}

fn load_settings(app: &AppHandle) -> Settings {
    settings_path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_vec_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Start {
    version: &'static str,
    address: Option<String>,
}

#[tauri::command]
fn start(app: AppHandle) -> Start {
    Start {
        version: VERSION,
        address: load_settings(&app).address,
    }
}

/// Checks the master at `address`, remembers it, and swaps the connect window for the master's
/// web app.
#[tauri::command]
async fn connect(app: AppHandle, address: String) -> Result<(), String> {
    let url = server_url(&address)?;
    check_master(&url).await?;
    save_settings(
        &app,
        &Settings {
            address: Some(address.trim().to_owned()),
        },
    )?;
    let host = url.trim_start_matches("http://").to_owned();
    ServerWindow {
        label: "server".into(),
        title: format!("acct — {host}"),
        url,
        profile_dir: None,
        auto_login: None,
    }
    .open(&app)?;
    if let Some(connect) = app.get_webview_window("connect") {
        let _ = connect.close();
    }
    Ok(())
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![start, connect])
        .setup(|app| {
            WebviewWindowBuilder::new(app, "connect", WebviewUrl::App("client.html".into()))
                .title("acct: connect to the office")
                .inner_size(480.0, 360.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("acct-client failed to start");
}
