//! What the acct desktop apps share (ADR 006).
//!
//! - `acct-master` runs the office server in-process and shows it in a webview.
//! - `acct-client` connects a staff or viewer PC to that master. What a person may do comes from
//!   the account the master set up for them, not from the app.
//! - `acct-dev` runs a throwaway master with the fixtures and opens a window per role.

use std::net::{Ipv4Addr, SocketAddr, UdpSocket};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[cfg(feature = "server")]
pub mod server;
pub mod windows;

/// This app's version. A client only works with a master of the same version.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The port a master listens on unless `ACCT_BIND` says otherwise.
pub const DEFAULT_PORT: u16 = 8080;

/// `GET /api/health`, as the desktop apps read it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Health {
    pub status: String,
    pub version: String,
}

/// Turns what someone typed ("192.168.1.20", "office-pc:8080", "http://office-pc:8080/") into a
/// base URL with no trailing slash. The port defaults to `DEFAULT_PORT`.
pub fn server_url(input: &str) -> Result<String, String> {
    let rest = input.trim();
    let rest = rest.strip_prefix("http://").unwrap_or(rest);
    if rest.starts_with("https://") {
        return Err("acct masters use http:// on the office network (until M7).".into());
    }
    let host_port = rest.trim_end_matches('/');
    if host_port.is_empty() {
        return Err("Type the master's address, for example 192.168.1.20.".into());
    }
    if host_port.contains(['/', ' ', '?', '#', '@']) {
        return Err(format!("{input:?} isn't a computer name or address."));
    }
    // A colon after the last `]` (or anywhere, without brackets) marks a port.
    let after_host = host_port.rsplit_once(']').map_or(host_port, |(_, p)| p);
    if let Some((_, port)) = after_host.rsplit_once(':') {
        port.parse::<u16>()
            .map_err(|_| format!("{port:?} isn't a port number."))?;
        Ok(format!("http://{host_port}"))
    } else {
        Ok(format!("http://{host_port}:{DEFAULT_PORT}"))
    }
}

/// Checks that `base_url` is an acct master of this app's version.
pub async fn check_master(base_url: &str) -> Result<Health, String> {
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
        .map_err(|e| format!("Couldn't reach an acct master at {base_url}: {e}"))?
        .json()
        .await
        .map_err(|_| format!("{base_url} answered, but it isn't an acct master."))?;
    if health.status != "ok" {
        return Err(format!(
            "The master says it isn't ready: {}.",
            health.status
        ));
    }
    if health.version != VERSION {
        return Err(format!(
            "The master runs acct {}, and this app is {VERSION}. Use the matching version.",
            health.version
        ));
    }
    Ok(health)
}

/// This computer's IPv4 address on the office network, to show people what to type into
/// `acct-client`. Connecting a UDP socket only picks a route: nothing is sent.
pub fn lan_ipv4() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).ok()?;
    socket.connect((Ipv4Addr::new(10, 255, 255, 255), 9)).ok()?;
    match socket.local_addr().ok()? {
        SocketAddr::V4(a) if !a.ip().is_loopback() && !a.ip().is_unspecified() => Some(*a.ip()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls_get_a_scheme_and_default_port() {
        assert_eq!(
            server_url("192.168.1.20").unwrap(),
            "http://192.168.1.20:8080"
        );
        assert_eq!(
            server_url(" office-pc:9000/ ").unwrap(),
            "http://office-pc:9000"
        );
        assert_eq!(
            server_url("http://office-pc/").unwrap(),
            "http://office-pc:8080"
        );
        assert_eq!(server_url("[::1]:81").unwrap(), "http://[::1]:81");
        assert_eq!(server_url("[::1]").unwrap(), "http://[::1]:8080");
    }

    #[test]
    fn bad_server_urls_say_why() {
        assert!(server_url("").is_err());
        assert!(server_url("https://office-pc").is_err());
        assert!(server_url("office-pc:port").is_err());
        assert!(server_url("office-pc/path").is_err());
    }
}
