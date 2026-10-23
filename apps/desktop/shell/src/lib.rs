//! What the acct desktop app shares (ADR 006): running the server in-process and opening windows
//! onto it. Only `acct-dev` is left: `acct-master` and `acct-client` retired in M12 (ADR 007's
//! amendment note in ADR 006), and `acctd` is the server.

use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(feature = "server")]
pub mod server;
pub mod windows;

/// This app's version, which must match the server's.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// `GET /api/health`, as the desktop apps read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    pub status: String,
    pub version: String,
}

/// Checks that `base_url` is an acct server of this app's version.
pub async fn check_server(base_url: &str) -> Result<Health, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .map_err(|e| e.to_string())?;
    let health: Health = client
        .get(format!("{base_url}/api/health"))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Couldn't reach an acct server at {base_url}: {e}"))?
        .json()
        .await
        .map_err(|_| format!("{base_url} answered, but it isn't an acct server."))?;
    if health.status != "ok" {
        return Err(format!(
            "The server says it isn't ready: {}.",
            health.status
        ));
    }
    if health.version != VERSION {
        return Err(format!(
            "The server runs acct {}, and this app is {VERSION}. Use the matching version.",
            health.version
        ));
    }
    Ok(health)
}
