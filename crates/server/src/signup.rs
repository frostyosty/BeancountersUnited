//! Business owners sign themselves up (M12), and invite their accountant.
//!
//! Sign-up is a command like any other change (CLAUDE.md hard rule 6): `POST /api/signup` submits
//! `sign_up` through the pipeline, then starts a session, as logging in does.

use acct_store::tenancy::{self, Access, Invite};
use acct_store::{SqliteConnection, new_id, users};
use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::header::SET_COOKIE;
use axum::response::{IntoResponse, Response};
use chrono::{Days, NaiveDate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::AppState;
use crate::auth::{self, Me};
use crate::business::{self, GstSetup};
use crate::commands::{Command, CommandEnvelope};
use crate::error::CommandError;
use crate::pipeline::{self, Actor};
use acct_store::users::Role;

/// How long an invite can be accepted for.
pub const INVITE_DAYS: u64 = 14;

/// What `sign_up` creates.
pub struct NewOwner<'a> {
    pub email: &'a str,
    pub display_name: &'a str,
    pub password: &'a str,
    pub business_name: &'a str,
    pub start_date: NaiveDate,
    pub gst: Option<&'a GstSetup>,
}

/// Creates the owner, with their email as their username, and their business. Returns the
/// business's client id.
pub async fn sign_up(
    tx: &mut SqliteConnection,
    seq: i64,
    new: NewOwner<'_>,
) -> Result<String, CommandError> {
    let email = check_email(new.email)?;
    pipeline::check_name(new.business_name)?;
    if users::by_username(tx, &email).await?.is_some() {
        return Err(CommandError::invalid(
            "email_taken",
            "There's already an account with that email. Sign in instead.",
        ));
    }
    let user_id = pipeline::insert_user(
        tx,
        &email,
        new.display_name,
        new.password,
        Role::BusinessOwner,
        seq,
    )
    .await?;
    let client_id = business::set_up(tx, seq, new.business_name, new.start_date, new.gst).await?;
    tenancy::grant(tx, &client_id, &user_id, Access::Owner, seq).await?;
    Ok(client_id)
}

/// Records an invite to `client_id`. Returns the invite's id.
pub async fn create_invite(
    tx: &mut SqliteConnection,
    seq: i64,
    today: NaiveDate,
    client_id: &str,
    email: &str,
    token: &str,
    by: &str,
) -> Result<String, CommandError> {
    let email = check_email(email)?;
    check_token(token)?;
    let id = new_id();
    tenancy::insert_invite(
        tx,
        &Invite {
            id: id.clone(),
            client_id: client_id.to_owned(),
            email,
            token_hash: token_hash(token),
            created_by: by.to_owned(),
            created_seq: seq,
            expires_on: today + Days::new(INVITE_DAYS),
            accepted_by: None,
            accepted_seq: None,
        },
    )
    .await?;
    Ok(id)
}

/// Gives the practice user `by` access to the invite's business. Returns its client id.
pub async fn accept_invite(
    tx: &mut SqliteConnection,
    seq: i64,
    today: NaiveDate,
    token: &str,
    by: &str,
) -> Result<String, CommandError> {
    let unusable = || {
        CommandError::invalid(
            "invite_unusable",
            "This invite link doesn't work: it's been used, it's expired, or it was copied \
             wrongly. Ask the business owner for a new one.",
        )
    };
    let invite = tenancy::invite_by_token_hash(tx, &token_hash(token))
        .await?
        .filter(|i| i.accepted_by.is_none() && today <= i.expires_on)
        .ok_or_else(unusable)?;
    if tenancy::access(tx, &invite.client_id, by).await?.is_none() {
        tenancy::grant(tx, &invite.client_id, by, Access::Accountant, seq).await?;
    }
    tenancy::mark_accepted(tx, &invite.id, by, seq).await?;
    Ok(invite.client_id)
}

/// An email address, trimmed and lowercased. Only its shape is checked; nothing is sent to it.
fn check_email(email: &str) -> Result<String, CommandError> {
    let email = email.trim().to_lowercase();
    let ok = email.len() <= 254
        && !email.chars().any(char::is_whitespace)
        && email.split_once('@').is_some_and(|(local, domain)| {
            !local.is_empty() && domain.contains('.') && !domain.contains('@')
        });
    if !ok {
        return Err(CommandError::invalid(
            "invalid_email",
            "That doesn't look like an email address.",
        ));
    }
    Ok(email)
}

/// An invite token is 32 random bytes as lowercase hex, made by the browser.
fn check_token(token: &str) -> Result<(), CommandError> {
    let ok = token.len() == 64
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !ok {
        return Err(CommandError::invalid(
            "invalid_token",
            "An invite token is 64 hex characters.",
        ));
    }
    Ok(())
}

fn token_hash(token: &str) -> String {
    Sha256::digest(token.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The body of `POST /api/signup`. `id` is the command id, from `newId()`.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct SignUpRequest {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub password: String,
    pub business_name: String,
    #[ts(type = "string")]
    pub start_date: NaiveDate,
    #[ts(optional)]
    pub gst: Option<GstSetup>,
}

/// The response to a sign-up: who's now signed in, and their business.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SignedUp {
    pub me: Me,
    pub business_id: String,
}

/// `POST /api/signup`: submits `sign_up`, then signs the new owner in.
pub async fn sign_up_route(
    State(state): State<AppState>,
    body: Result<Json<SignUpRequest>, JsonRejection>,
) -> Result<Response, CommandError> {
    let Json(req) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let email = req.email.trim().to_lowercase();
    let password = req.password.clone();
    let envelope = CommandEnvelope {
        id: req.id,
        command: Command::SignUp {
            email: req.email,
            display_name: req.display_name,
            password: req.password,
            business_name: req.business_name,
            start_date: req.start_date,
            gst: req.gst,
        },
    };
    let anonymous = Actor {
        user_id: None,
        role: Role::BusinessOwner,
    };
    let accepted = pipeline::submit(&state.store, &anonymous, envelope, chrono::Utc::now()).await?;
    let business_id = accepted
        .entity_id
        .ok_or_else(|| CommandError::Malformed("sign-up created nothing".to_owned()))?;

    // A resubmitted id returns the original result without running the command again, so the
    // password is checked before a session is given out.
    let user = {
        let mut conn = state.store.reader().await?;
        users::by_username(&mut conn, &email).await?
    }
    .filter(|u| u.active && u.role == Role::BusinessOwner)
    .ok_or(CommandError::BadCredentials)?;
    let hash = user.password_hash.clone();
    let matches = tokio::task::spawn_blocking(move || auth::verify_password(&password, &hash))
        .await
        .unwrap_or(false);
    if !matches {
        return Err(CommandError::BadCredentials);
    }
    let cookie = auth::start_session(&state, &user.id).await?;
    let mut response = Json(SignedUp {
        me: Me::from(&user),
        business_id,
    })
    .into_response();
    response.headers_mut().insert(SET_COOKIE, cookie);
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn emails_are_trimmed_lowercased_and_shape_checked() {
        assert_eq!(check_email("  Ana@Example.NZ ").unwrap(), "ana@example.nz");
        for bad in [
            "",
            "ana",
            "@example.nz",
            "ana@localhost",
            "a na@x.nz",
            "a@b@c.nz",
        ] {
            assert!(check_email(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn tokens_are_64_lowercase_hex() {
        assert!(check_token(&"a1".repeat(32)).is_ok());
        assert!(check_token(&"A1".repeat(32)).is_err());
        assert!(check_token("abc").is_err());
        assert_ne!(token_hash("x"), "x");
    }
}
