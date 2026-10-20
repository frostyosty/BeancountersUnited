//! An optional PIN gate in front of the whole site, to discourage casual snooping. It is not
//! account security: real access still needs a login. Set `ACCT_SITE_PIN` (in the environment,
//! or in `config.env`) to turn it on; leave it unset or empty to turn it off.
//!
//! Until the visitor enters the PIN, every request except `/api/health` gets the keypad page, so
//! the web app's files and the API are never served.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Json;
use axum::Router;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::post;
use serde::Deserialize;
use sha2::{Digest, Sha256};

const COOKIE: &str = "acct_gate";
const CONFIG_FILE: &str = "config.env";
const PIN_VAR: &str = "ACCT_SITE_PIN";
const MAX_FAILS: u32 = 8;
const LOCKOUT: Duration = Duration::from_secs(60);

#[derive(Clone)]
pub struct Gate {
    pin_len: usize,
    token: String,
    fails: Arc<Mutex<(Instant, u32)>>,
}

impl Gate {
    pub fn new(pin: &str) -> Self {
        Self {
            pin_len: pin.chars().count(),
            token: token_for(pin),
            fails: Arc::new(Mutex::new((Instant::now(), 0))),
        }
    }

    /// The gate configured by `ACCT_SITE_PIN` (environment first, then `config.env` in the
    /// working directory), or `None` when it is unset or empty.
    pub fn from_config() -> Option<Self> {
        let file = std::fs::read_to_string(CONFIG_FILE).unwrap_or_default();
        let pin = std::env::var(PIN_VAR)
            .ok()
            .or_else(|| config_value(&file, PIN_VAR))?;
        let pin = pin.trim();
        if pin.is_empty() {
            return None;
        }
        if !pin.chars().all(|c| c.is_ascii_digit()) {
            tracing::warn!("{PIN_VAR} should be digits only: the keypad can't enter anything else");
        }
        tracing::info!("site PIN gate is on");
        Some(Self::new(pin))
    }

    fn is_unlocked(&self, headers: &HeaderMap) -> bool {
        let prefix = format!("{COOKIE}=");
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|c| c.trim().strip_prefix(&prefix))
            .any(|v| v == self.token)
    }

    /// Counts a wrong guess if `failed`. Returns true when there have been too many recently.
    fn locked_out(&self, failed: bool) -> bool {
        let mut fails = self.fails.lock().unwrap_or_else(|e| e.into_inner());
        if fails.0.elapsed() > LOCKOUT {
            *fails = (Instant::now(), 0);
        }
        if failed {
            fails.1 += 1;
        }
        fails.1 >= MAX_FAILS
    }
}

/// Puts `gate` (if any) in front of `router`.
pub fn apply(router: Router, gate: Option<Gate>) -> Router {
    let Some(gate) = gate else { return router };
    Router::new()
        .route("/__gate", post(unlock).with_state(gate.clone()))
        .merge(router.layer(middleware::from_fn_with_state(gate, check)))
}

async fn check(State(gate): State<Gate>, req: Request, next: Next) -> Response {
    if req.uri().path() == "/api/health" || gate.is_unlocked(req.headers()) {
        return next.run(req).await;
    }
    if req.uri().path().starts_with("/api/") {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let page = PAGE.replace("{PIN_LEN}", &gate.pin_len.to_string());
    ([(header::CACHE_CONTROL, "no-store")], Html(page)).into_response()
}

#[derive(Deserialize)]
struct Attempt {
    pin: String,
}

async fn unlock(
    State(gate): State<Gate>,
    headers: HeaderMap,
    Json(attempt): Json<Attempt>,
) -> Response {
    if gate.locked_out(false) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    if token_for(&attempt.pin) != gate.token {
        gate.locked_out(true);
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let secure = headers
        .get("x-forwarded-proto")
        .is_some_and(|v| v == "https");
    let cookie = format!(
        "{COOKIE}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000{}",
        gate.token,
        if secure { "; Secure" } else { "" }
    );
    ([(header::SET_COOKIE, cookie)], StatusCode::NO_CONTENT).into_response()
}

fn token_for(pin: &str) -> String {
    Sha256::digest(format!("acct-site-gate:{pin}"))
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `KEY=value` lines; `#` comments, blank lines and quotes around the value are ignored.
fn config_value(file: &str, key: &str) -> Option<String> {
    file.lines().find_map(|line| {
        let (k, v) = line.trim().split_once('=')?;
        (k.trim() == key).then(|| v.trim().trim_matches(['"', '\'']).to_owned())
    })
}

const PAGE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Enter PIN</title>
<style>
:root{color-scheme:light dark;--bg:#f6f7f9;--fg:#1b1f24;--key:#fff;--line:#d5d9df;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#14171b;--fg:#e8eaed;--key:#1f242a;--line:#333a42}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);font:16px system-ui,sans-serif}
main{width:min(280px,calc(100vw - 32px));text-align:center}
h1{font-size:1.1rem;font-weight:600;margin:0 0 16px}
.dots{display:flex;justify-content:center;gap:10px;height:20px;margin-bottom:20px}
.dots i{width:14px;height:14px;border-radius:50%;border:2px solid var(--accent)}
.dots i.on{background:var(--accent)}
.pad{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
button{height:56px;font-size:1.3rem;border:1px solid var(--line);border-radius:12px;background:var(--key);color:var(--fg);cursor:pointer}
button:active{background:var(--line)}
#msg{min-height:1.5em;margin-top:16px;color:#dc2626;font-size:.9rem}
.shake{animation:s .3s}@keyframes s{25%{transform:translateX(-8px)}75%{transform:translateX(8px)}}
</style></head><body><main>
<h1>🔒 Enter PIN</h1>
<div class="dots" id="dots" aria-hidden="true"></div>
<div class="pad" id="pad"></div>
<div id="msg" role="alert"></div>
</main>
<script>
const LEN={PIN_LEN};let pin="";
const dots=document.getElementById("dots"),pad=document.getElementById("pad"),msg=document.getElementById("msg");
for(let i=0;i<LEN;i++)dots.append(document.createElement("i"));
function draw(){[...dots.children].forEach((d,i)=>d.classList.toggle("on",i<pin.length));}
function key(label,fn){const b=document.createElement("button");b.type="button";b.textContent=label;b.onclick=fn;pad.append(b);}
for(const n of [1,2,3,4,5,6,7,8,9])key(n,()=>add(String(n)));
key("⌫",()=>{pin=pin.slice(0,-1);draw();});key("0",()=>add("0"));key("OK",submit);
function add(d){if(pin.length<LEN){pin+=d;draw();msg.textContent="";if(pin.length===LEN)submit();}}
async function submit(){
  if(!pin)return;
  const r=await fetch("/__gate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({pin})});
  if(r.ok){location.reload();return;}
  msg.textContent=r.status===429?"Too many tries. Wait a minute.":"Wrong PIN.";
  pin="";draw();dots.classList.remove("shake");void dots.offsetWidth;dots.classList.add("shake");
}
addEventListener("keydown",e=>{if(/^\d$/.test(e.key))add(e.key);else if(e.key==="Backspace"){pin=pin.slice(0,-1);draw();}else if(e.key==="Enter")submit();});
</script></body></html>
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::routing::get;
    use tower::ServiceExt;

    fn gated() -> Router {
        let inner = Router::new()
            .route("/", get(|| async { "secret app" }))
            .route("/api/health", get(|| async { "ok" }))
            .route("/api/me", get(|| async { "me" }));
        apply(inner, Some(Gate::new("1234")))
    }

    async fn send(req: Request<Body>) -> (StatusCode, HeaderMap, String) {
        let res = gated().oneshot(req).await.unwrap();
        let (parts, body) = res.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        (
            parts.status,
            parts.headers,
            String::from_utf8_lossy(&bytes).into(),
        )
    }

    fn get_req(path: &str) -> Request<Body> {
        Request::get(path).body(Body::empty()).unwrap()
    }

    fn unlock_req(pin: &str) -> Request<Body> {
        Request::post("/__gate")
            .header("content-type", "application/json")
            .body(Body::from(format!(r#"{{"pin":"{pin}"}}"#)))
            .unwrap()
    }

    #[tokio::test]
    async fn locked_visitors_get_the_keypad_and_no_api() {
        let (status, _, body) = send(get_req("/")).await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.contains("Enter PIN") && !body.contains("secret app"));
        assert_eq!(send(get_req("/api/me")).await.0, StatusCode::UNAUTHORIZED);
        assert_eq!(send(get_req("/api/health")).await.0, StatusCode::OK);
    }

    #[tokio::test]
    async fn right_pin_sets_a_cookie_that_unlocks() {
        let (status, headers, _) = send(unlock_req("1234")).await;
        assert_eq!(status, StatusCode::NO_CONTENT);
        let cookie = headers[header::SET_COOKIE].to_str().unwrap();
        let pair = cookie.split(';').next().unwrap().to_owned();
        let mut req = get_req("/");
        req.headers_mut()
            .insert(header::COOKIE, pair.parse().unwrap());
        let (status, _, body) = send(req).await;
        assert_eq!((status, body.as_str()), (StatusCode::OK, "secret app"));
    }

    #[tokio::test]
    async fn wrong_pin_is_rejected() {
        let (status, headers, _) = send(unlock_req("0000")).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert!(!headers.contains_key(header::SET_COOKIE));
    }

    #[test]
    fn too_many_wrong_guesses_lock_out() {
        let gate = Gate::new("1234");
        assert!(!gate.locked_out(false));
        assert!((0..MAX_FAILS).any(|_| gate.locked_out(true)));
        assert!(gate.locked_out(false));
    }

    #[test]
    fn reads_config_env_lines() {
        let file = "# comment\nOTHER=1\nACCT_SITE_PIN = \"4321\"\n";
        assert_eq!(config_value(file, PIN_VAR).as_deref(), Some("4321"));
        assert_eq!(config_value(file, "MISSING"), None);
    }
}
