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
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::AppState;
use crate::error::CommandError;
use crate::impersonation;
use crate::pipeline::{ActingAs, Actor};

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

pub(crate) fn token_hash(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn session_cookie(token: &str, max_age_secs: i64) -> HeaderValue {
    named_cookie(SESSION_COOKIE, token, max_age_secs)
}

/// An HttpOnly, SameSite=Strict cookie for the whole site.
pub(crate) fn named_cookie(name: &str, value: &str, max_age_secs: i64) -> HeaderValue {
    // No `Secure` flag: the office LAN is plain HTTP until M7.
    HeaderValue::from_str(&format!(
        "{name}={value}; HttpOnly; SameSite=Strict; Path=/; Max-Age={max_age_secs}"
    ))
    .expect("the cookie is ASCII")
}

pub(crate) fn token_from(headers: &HeaderMap) -> Option<String> {
    cookie(headers, SESSION_COOKIE)
}

/// The value of the cookie `name`, if the request has one.
pub(crate) fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(n, v)| *n == name && !v.is_empty())
        .map(|(_, value)| value.to_owned())
}

/// The logged-in user, taken from the session cookie. Handlers that take this reject requests
/// without a valid session.
///
/// `.0` is the user every read answers as. While an overseer views as someone (M19, ADR 013),
/// that's the person they're viewing as, not the overseer, so a handler that reads `.0` already
/// sees what that person would. `.1` is the login session: its token, and who's really signed in
/// while acting ([`CurrentUser::real`]). Anything that records who did something uses the real
/// one, through [`CurrentUser::actor`].
pub struct CurrentUser(pub User, pub SessionState);

/// The login session behind a [`CurrentUser`].
pub struct SessionState {
    /// The SHA-256 of the session's token, as `sessions` keeps it.
    pub token_hash: String,
    /// Set while this session is viewing as someone, and only while that's still live.
    pub acting: Option<Acting>,
}

/// A session's live acting state (ADR 013).
pub struct Acting {
    /// The overseer who signed in.
    pub real: User,
    /// The `entity_id` of the `start_impersonation` that began it.
    pub acting_id: String,
    pub since: DateTime<Utc>,
    pub allow_changes: bool,
}

impl CurrentUser {
    /// Who's submitting a command: the real person, plus who they're acting as.
    pub fn actor(&self) -> Actor {
        match &self.1.acting {
            Some(a) => Actor {
                user_id: Some(a.real.id.clone()),
                role: a.real.role,
                acting_as: Some(ActingAs {
                    user_id: self.0.id.clone(),
                    role: self.0.role,
                    acting_id: a.acting_id.clone(),
                }),
            },
            None => Actor {
                user_id: Some(self.0.id.clone()),
                role: self.0.role,
                acting_as: None,
            },
        }
    }

    /// The acting state, while this session is viewing as someone.
    pub fn acting(&self) -> Option<&Acting> {
        self.1.acting.as_ref()
    }

    /// Who's really signed in: the overseer while acting, else the user.
    pub fn real(&self) -> &User {
        self.1.acting.as_ref().map_or(&self.0, |a| &a.real)
    }

    /// The session's token hash.
    pub fn session(&self) -> &str {
        &self.1.token_hash
    }
}

/// The user behind a session token's hash at `now`, if the session is valid. An acting state
/// whose 30 minutes are up, or whose person may no longer be acted as, is treated as already over,
/// whether or not the sweep has logged its end yet (ADR 013, 5).
pub(crate) async fn load(
    conn: &mut acct_store::SqliteConnection,
    token_hash: &str,
    now: DateTime<Utc>,
) -> Result<Option<CurrentUser>, CommandError> {
    let Some(session) = sessions::get(conn, token_hash)
        .await?
        .filter(|s| s.expires_at > now)
    else {
        return Ok(None);
    };
    let Some(user) = users::get(conn, &session.user_id)
        .await?
        .filter(|u| u.active)
    else {
        return Ok(None);
    };
    let acting = match session.acting() {
        Some((who, acting_id, since)) if impersonation::is_live(since, now) => {
            users::get(conn, who)
                .await?
                .filter(|person| impersonation::may_act_as(&user, person))
                .map(|person| (person, acting_id.to_owned(), since))
        }
        _ => None,
    };
    let token_hash = token_hash.to_owned();
    Ok(Some(match acting {
        Some((person, acting_id, since)) => CurrentUser(
            person,
            SessionState {
                token_hash,
                acting: Some(Acting {
                    real: user,
                    acting_id,
                    since,
                    allow_changes: session.allow_changes,
                }),
            },
        ),
        None => CurrentUser(
            user,
            SessionState {
                token_hash,
                acting: None,
            },
        ),
    }))
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = CommandError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<CurrentUser, CommandError> {
        let token = token_from(&parts.headers).ok_or(CommandError::Unauthenticated)?;
        let mut conn = state.store.reader().await?;
        load(&mut conn, &token_hash(&token), Utc::now())
            .await?
            .ok_or(CommandError::Unauthenticated)
    }
}

#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// The logged-in user, as the UI sees them. While an overseer views as someone (ADR 013), it's
/// that person, with `acting_as` and `real` saying so.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Me {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub role: Role,
    /// Set while this session is viewing as this user: since when, until when, and whether
    /// changes are on. `null` otherwise. The server always sends it; it's optional in the type
    /// only so code that builds a `Me` (tests, sign-up) needn't name it.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub acting_as: Option<MeActingAs>,
    /// The overseer really signed in, while viewing as this user. `null` otherwise, and always
    /// sent, as `acting_as` is.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub real: Option<MeReal>,
    /// Set for a guest who hasn't saved their work (M20, ADR 014): when the trial goes, and its
    /// businesses. `null` for everyone else, and always sent, as `acting_as` is.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub guest: Option<crate::guests::MeGuest>,
    /// Set for a signed-in owner whose browser was a guest just before signing in, with a trial
    /// of their own they could move into this account (`POST /api/guest/adopt`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub moveable_trial: Option<crate::guests::MoveableTrial>,
}

/// [`Me::acting_as`]: the person being viewed as, and the acting session's limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MeActingAs {
    pub user_id: String,
    pub name: String,
    pub role: Role,
    #[ts(type = "string")]
    pub since: DateTime<Utc>,
    /// 30 minutes after `since`. It ends then, read-only or not.
    #[ts(type = "string")]
    pub expires_at: DateTime<Utc>,
    pub allow_changes: bool,
}

/// [`Me::real`]: who's really signed in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MeReal {
    pub user_id: String,
    pub name: String,
    pub role: Role,
}

impl From<&User> for Me {
    fn from(u: &User) -> Me {
        Me {
            id: u.id.clone(),
            // A guest's username is an internal placeholder, not something to show.
            username: if u.is_guest() {
                String::new()
            } else {
                u.username.clone()
            },
            display_name: u.display_name.clone(),
            role: u.role,
            acting_as: None,
            real: None,
            guest: None,
            moveable_trial: None,
        }
    }
}

impl From<&CurrentUser> for Me {
    fn from(user: &CurrentUser) -> Me {
        let mut me = Me::from(&user.0);
        if let Some(a) = user.acting() {
            me.acting_as = Some(MeActingAs {
                user_id: user.0.id.clone(),
                name: user.0.display_name.clone(),
                role: user.0.role,
                since: a.since,
                expires_at: impersonation::expires_at(a.since),
                allow_changes: a.allow_changes,
            });
            me.real = Some(MeReal {
                user_id: a.real.id.clone(),
                name: a.real.display_name.clone(),
                role: a.real.role,
            });
        }
        me
    }
}

/// A hash to check against when the username doesn't exist, so a failed login takes the same
/// time whether or not the user is real.
static DUMMY_HASH: LazyLock<String> = LazyLock::new(|| hash_password("not a real password"));

/// `POST /api/login`. A guest (M20) can't sign in: they have no password. If this browser was a
/// guest with a business of their own, the guest's token is kept in a cookie of its own for a
/// while, so the owner can move that trial into their account (ADR 014, 4).
pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
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
        Some(u) if matches && u.active && !u.is_guest() => u,
        _ => return Err(CommandError::BadCredentials),
    };

    let token = new_token();
    let now = Utc::now();
    let trial = match token_from(&headers) {
        Some(guest_token) if user.role == Role::BusinessOwner => {
            let mut conn = state.store.reader().await?;
            crate::guests::moveable(&mut conn, &guest_token, now)
                .await?
                .map(|t| (guest_token, t))
        }
        _ => None,
    };
    {
        let mut w = state.store.writer().await;
        sessions::delete_expired(&mut w, now).await?;
        sessions::insert(
            &mut w,
            &Session::new(
                token_hash(&token),
                user.id.clone(),
                now,
                now + Duration::hours(SESSION_HOURS),
            ),
        )
        .await?;
    }
    let mut me = Me::from(&user);
    me.moveable_trial = trial.as_ref().map(|(_, t)| t.clone());
    let mut response = Json(me).into_response();
    response
        .headers_mut()
        .append(SET_COOKIE, session_cookie(&token, SESSION_HOURS * 3600));
    if let Some((guest_token, _)) = trial {
        response.headers_mut().append(
            SET_COOKIE,
            named_cookie(
                crate::guests::MOVE_COOKIE,
                &guest_token,
                crate::guests::GUEST_DAYS * 86_400,
            ),
        );
    }
    Ok(response)
}

/// `POST /api/logout`. Ends the session, if there is one, and clears the cookie. A session
/// viewing as someone ends that first, through the pipeline (ADR 013, 5).
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, CommandError> {
    if let Some(token) = token_from(&headers) {
        impersonation::end_on_sign_out(&state, &token_hash(&token)).await;
        let mut w = state.store.writer().await;
        if let Some(s) = sessions::get(&mut w, &token_hash(&token)).await? {
            state.presence.leave(&s.user_id);
        }
        sessions::delete(&mut w, &token_hash(&token)).await?;
    }
    let mut response = axum::http::StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(SET_COOKIE, session_cookie("", 0));
    Ok(response)
}

/// `GET /api/me`: the user every read answers as, and, while viewing as someone, who's really
/// signed in. For a guest, their trial; for an owner who was a guest in this browser a moment
/// ago, the trial they could move in.
pub async fn me(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
) -> Result<Json<Me>, CommandError> {
    let mut me = Me::from(&user);
    let mut conn = state.store.reader().await?;
    let now = Utc::now();
    if user.0.is_guest() {
        let expires = sessions::get(&mut conn, user.session())
            .await?
            .map_or(now, |s| s.expires_at);
        me.guest = crate::guests::me_guest(&mut conn, &user.0, expires).await?;
    } else if user.0.role == Role::BusinessOwner
        && user.acting().is_none()
        && let Some(token) = cookie(&headers, crate::guests::MOVE_COOKIE)
    {
        me.moveable_trial = crate::guests::moveable(&mut conn, &token, now).await?;
    }
    Ok(Json(me))
}

/// Starts a session for `user_id` and returns its `Set-Cookie` value. Sign-up (M12) uses this,
/// so a new owner is signed in with the same session and cookie as a login.
pub(crate) async fn start_session(
    state: &AppState,
    user_id: &str,
) -> Result<HeaderValue, CommandError> {
    start_session_for(state, user_id, Duration::hours(SESSION_HOURS)).await
}

/// A guest's session (M20, ADR 014, 6): 7 days, moved on by their requests, so it's also the
/// clock that ends an unused trial. Not the 12 hours a signed-in session gets, which would lock a
/// guest out of their own trial overnight.
pub(crate) async fn start_guest_session(
    state: &AppState,
    user_id: &str,
) -> Result<HeaderValue, CommandError> {
    start_session_for(state, user_id, Duration::days(crate::guests::GUEST_DAYS)).await
}

async fn start_session_for(
    state: &AppState,
    user_id: &str,
    lasts: Duration,
) -> Result<HeaderValue, CommandError> {
    let token = new_token();
    let now = Utc::now();
    let mut w = state.store.writer().await;
    sessions::delete_expired(&mut w, now).await?;
    sessions::insert(
        &mut w,
        &Session::new(token_hash(&token), user_id.to_owned(), now, now + lasts),
    )
    .await?;
    Ok(session_cookie(&token, lasts.num_seconds()))
}

/// Moves a guest's session on to 7 days from `now`, and returns the cookie to send again so the
/// browser keeps it as long. At most once an hour; between bumps the cookie is sent with what's
/// left. Login state, so outside the pipeline (hard rule 6).
pub(crate) async fn slide_guest_session(
    state: &AppState,
    token: &str,
    now: chrono::DateTime<Utc>,
) -> Result<HeaderValue, CommandError> {
    let hash = token_hash(token);
    let lasts = Duration::days(crate::guests::GUEST_DAYS);
    let current = {
        let mut conn = state.store.reader().await?;
        sessions::get(&mut conn, &hash).await?.map(|s| s.expires_at)
    };
    let Some(current) = current else {
        return Ok(session_cookie("", 0));
    };
    let expires = if current < now + lasts - Duration::minutes(crate::guests::BUMP_EVERY_MINUTES) {
        let mut w = state.store.writer().await;
        acct_store::guests::extend_session(&mut w, &hash, now + lasts).await?;
        now + lasts
    } else {
        current
    };
    Ok(session_cookie(token, (expires - now).num_seconds().max(0)))
}

/// When the last of a user's sessions ends.
pub(crate) async fn latest_session_expiry(
    conn: &mut acct_store::SqliteConnection,
    user_id: &str,
) -> Result<Option<chrono::DateTime<Utc>>, CommandError> {
    Ok(acct_store::guests::latest_session_expiry(conn, user_id).await?)
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
