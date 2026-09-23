//! Passwords, login sessions and the session cookie.
//!
//! Passwords are hashed with argon2id. A login makes a random session token: the browser holds it
//! in an HttpOnly, SameSite=Strict cookie, and the database keeps only its SHA-256.

use std::sync::LazyLock;

use acct_store::sessions::{self, Session};
use acct_store::users::{self, Role, User};
use argon2::Argon2;
use argon2::password_hash::phc::PasswordHash;
use argon2::password_hash::{PasswordHasher, PasswordVerifier};
use axum::Json;
use axum::extract::{FromRequestParts, State};
use axum::http::header::{COOKIE, SET_COOKIE};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue};
use axum::response::{IntoResponse, Response};
use chrono::{Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::AppState;
use crate::error::CommandError;
use crate::pipeline::Actor;

pub const SESSION_COOKIE: &str = "acct_session";
/// How long a login lasts. A working day, with room to spare.
pub const SESSION_HOURS: i64 = 12;
pub const MIN_PASSWORD_CHARS: usize = 10;

pub fn hash_password(password: &str) -> String {
    Argon2::default()
        .hash_password(password.as_bytes())
        .expect("argon2 hashes any password")
        .to_string()
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).is_ok_and(|h| {
        Argon2::default()
            .verify_password(password.as_bytes(), &h)
            .is_ok()
    })
}

pub fn check_password_rules(password: &str) -> Result<(), CommandError> {
    let n = password.chars().count();
    if !(MIN_PASSWORD_CHARS..=256).contains(&n) {
        return Err(CommandError::invalid(
            "weak_password",
            format!("A password needs at least {MIN_PASSWORD_CHARS} characters."),
        ));
    }
    Ok(())
}

/// A new session token: 32 random bytes as hex.
fn new_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS provides randomness");
    hex(&bytes)
}

fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn session_cookie(token: &str, max_age_secs: i64) -> HeaderValue {
    // No `Secure` flag: the office LAN is plain HTTP until M7.
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age_secs}"
    ))
    .expect("the cookie is ASCII")
}

fn token_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == SESSION_COOKIE)
        .map(|(_, value)| value.to_owned())
}

/// The logged-in user, taken from the session cookie. Handlers that take this reject requests
/// without a valid session.
pub struct CurrentUser(pub User);

impl CurrentUser {
    pub fn actor(&self) -> Actor {
        Actor {
            user_id: Some(self.0.id.clone()),
            role: self.0.role,
        }
    }
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = CommandError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<CurrentUser, CommandError> {
        let token = token_from(&parts.headers).ok_or(CommandError::Unauthenticated)?;
        let mut conn = state.store.reader().await?;
        let session = sessions::get(&mut conn, &token_hash(&token))
            .await?
            .filter(|s| s.expires_at > Utc::now())
            .ok_or(CommandError::Unauthenticated)?;
        let user = users::get(&mut conn, &session.user_id)
            .await?
            .filter(|u| u.active)
            .ok_or(CommandError::Unauthenticated)?;
        Ok(CurrentUser(user))
    }
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// The logged-in user, as the UI sees them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Me {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: Role,
}

impl From<&User> for Me {
    fn from(u: &User) -> Me {
        Me {
            id: u.id.clone(),
            username: u.username.clone(),
            display_name: u.display_name.clone(),
            role: u.role,
        }
    }
}

/// A hash to check against when the username doesn't exist, so a failed login takes the same
/// time whether or not the user is real.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| hash_password("not a real password"));

/// `POST /api/login`
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Response, CommandError> {
    let user = {
        let mut conn = state.store.reader().await?;
        users::by_username(&mut conn, req.username.trim()).await?
    };
    let password = req.password;
    let hash = user
        .as_ref()
        .map_or_else(|| DUMMY_HASH.clone(), |u| u.password_hash.clone());
    // Hashing is slow on purpose, so keep it off the async threads.
    let matches = tokio::task::spawn_blocking(move || verify_password(&password, &hash))
        .await
        .unwrap_or(false);
    let user = match user {
        Some(u) if matches && u.active => u,
        _ => return Err(CommandError::BadCredentials),
    };

    let token = new_token();
    let now = Utc::now();
    {
        let mut w = state.store.writer().await;
        sessions::delete_expired(&mut w, now).await?;
        sessions::insert(
            &mut w,
            &Session {
                token_hash: token_hash(&token),
                user_id: user.id.clone(),
                created_at: now,
                expires_at: now + Duration::hours(SESSION_HOURS),
            },
        )
        .await?;
    }
    let mut response = Json(Me::from(&user)).into_response();
    response
        .headers_mut()
        .insert(SET_COOKIE, session_cookie(&token, SESSION_HOURS * 3600));
    Ok(response)
}

/// `POST /api/logout`. Ends the session, if there is one, and clears the cookie.
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, CommandError> {
    if let Some(token) = token_from(&headers) {
        let mut w = state.store.writer().await;
        sessions::delete(&mut w, &token_hash(&token)).await?;
    }
    let mut response = axum::http::StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(SET_COOKIE, session_cookie("", 0));
    Ok(response)
}

/// `GET /api/me`
pub async fn me(user: CurrentUser) -> Json<Me> {
    Json(Me::from(&user.0))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passwords_verify_only_against_their_own_hash() {
        let h = hash_password("correct horse battery");
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("correct horse batterY", &h));
        assert!(!verify_password("anything", "not a hash"));
    }

    #[test]
    fn tokens_are_random_and_only_their_hash_is_kept() {
        let (a, b) = (new_token(), new_token());
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert_eq!(token_hash(&a).len(), 64);
        assert_ne!(token_hash(&a), a);
    }

    #[test]
    fn the_session_cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_static("a=1; acct_session=xyz; b=2"),
        );
        assert_eq!(token_from(&headers).as_deref(), Some("xyz"));
        assert_eq!(token_from(&HeaderMap::new()), None);
    }
}
