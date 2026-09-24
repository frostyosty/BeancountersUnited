//! Windows onto an acct server.
//!
//! A server window shows the web app the master serves. It's a remote page, so Tauri gives it no
//! access to the app's commands: only the local pages in `apps/desktop/ui` can call them.

use std::path::PathBuf;

use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// A window onto the web app at `url`.
pub struct ServerWindow {
    pub label: String,
    pub title: String,
    pub url: String,
    /// A separate browser profile for this window, so its login doesn't share a cookie with
    /// another window's. `None` uses the app's default profile.
    pub profile_dir: Option<PathBuf>,
    /// Log in as this user when the page loads without a session (acct-dev only).
    pub auto_login: Option<(String, String)>,
}

impl ServerWindow {
    /// Opens the window, or brings it to the front if it's already open.
    pub fn open<R: Runtime>(self, app: &AppHandle<R>) -> Result<WebviewWindow<R>, String> {
        if let Some(existing) = app.get_webview_window(&self.label) {
            let _ = existing.unminimize();
            let _ = existing.set_focus();
            return Ok(existing);
        }
        let url = self
            .url
            .parse()
            .map_err(|e| format!("{:?} isn't a URL: {e}", self.url))?;
        let mut builder = WebviewWindowBuilder::new(app, &self.label, WebviewUrl::External(url))
            .title(&self.title)
            .inner_size(1100.0, 760.0);
        if let Some(dir) = self.profile_dir {
            builder = builder.data_directory(dir);
        }
        if let Some((username, password)) = self.auto_login {
            let script = auto_login_script(&username, &password);
            builder = builder.on_page_load(move |webview, payload| {
                if payload.event() == PageLoadEvent::Finished {
                    let _ = webview.eval(&script);
                }
            });
        }
        builder.build().map_err(|e| e.to_string())
    }
}

/// Logs in if there's no session, then reloads. With a session it does nothing, so the reload
/// doesn't loop; a failed login doesn't reload either.
fn auto_login_script(username: &str, password: &str) -> String {
    let body = serde_json::json!({ "username": username, "password": password }).to_string();
    let body = serde_json::to_string(&body).expect("strings serialise");
    format!(
        "fetch('/api/me').then(function (r) {{ if (r.status !== 401) return; \
         return fetch('/api/login', {{ method: 'POST', headers: {{ 'content-type': 'application/json' }}, body: {body} }}) \
         .then(function (l) {{ if (l.ok) location.reload(); }}); }});"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_auto_login_script_embeds_credentials_as_a_json_string() {
        let s = auto_login_script("staff", "it's \"quoted\"");
        assert!(
            s.contains(r#"body: "{\"password\":\"it's \\\"quoted\\\"\",\"username\":\"staff\"}""#)
        );
    }
}
