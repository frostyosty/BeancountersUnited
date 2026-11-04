//! Login sessions. Not practice data, so these are written directly, outside the command
//! pipeline (CLAUDE.md hard rule 6). Only a hash of each session token is stored.
//!
//! A session can also be acting as someone else (M19, ADR 013): an overseer viewing as one of
//! the users below them. Only the impersonation commands change that, inside their own
//! transaction, so it's logged like any other change.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqliteConnection};

use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Session {
    pub token_hash: String,
    pub user_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    /// Who this session is acting as, if anyone.
    #[sqlx(default)]
    pub acting_as: Option<String>,
    /// The acting session's id: the `entity_id` of the `start_impersonation` that began it.
    #[sqlx(default)]
    pub acting_id: Option<String>,
    /// When the acting began.
    #[sqlx(default)]
    pub acting_since: Option<DateTime<Utc>>,
    /// Whether changes have been turned on while acting.
    #[sqlx(default)]
    pub allow_changes: bool,
}

impl Session {
    /// A new session, acting as no one.
    pub fn new(
        token_hash: String,
        user_id: String,
        created_at: DateTime<Utc>,
        expires_at: DateTime<Utc>,
    ) -> Session {
        Session {
            token_hash,
            user_id,
            created_at,
            expires_at,
            acting_as: None,
            acting_id: None,
            acting_since: None,
            allow_changes: false,
        }
    }

    /// The acting state, when all of it is there: who, which acting session, and since when.
    pub fn acting(&self) -> Option<(&str, &str, DateTime<Utc>)> {
        match (&self.acting_as, &self.acting_id, self.acting_since) {
            (Some(who), Some(id), Some(since)) => Some((who, id, since)),
            _ => None,
        }
    }
}

/// Adds a session. It starts acting as no one, whatever `s` says.
pub async fn insert(conn: &mut SqliteConnection, s: &Session) -> Result<()> {
    sqlx::query(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    )
    .bind(&s.token_hash)
    .bind(&s.user_id)
    .bind(s.created_at)
    .bind(s.expires_at)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get(conn: &mut SqliteConnection, token_hash: &str) -> Result<Option<Session>> {
    Ok(
        sqlx::query_as("SELECT * FROM sessions WHERE token_hash = ?")
            .bind(token_hash)
            .fetch_optional(conn)
            .await?,
    )
}

pub async fn delete(conn: &mut SqliteConnection, token_hash: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE token_hash = ?")
        .bind(token_hash)
        .execute(conn)
        .await?;
    Ok(())
}

/// Removes every session that expired before `now`, returning how many went.
pub async fn delete_expired(conn: &mut SqliteConnection, now: DateTime<Utc>) -> Result<u64> {
    // Timestamps are compared in Rust rather than as SQL text, so their stored format can't
    // affect the result.
    let all: Vec<Session> = sqlx::query_as("SELECT * FROM sessions")
        .fetch_all(&mut *conn)
        .await?;
    let mut n = 0;
    for s in all.iter().filter(|s| s.expires_at <= now) {
        delete(conn, &s.token_hash).await?;
        n += 1;
    }
    Ok(n)
}

/// Ends every session a user has, so they must log in again.
pub async fn delete_for_user(conn: &mut SqliteConnection, user_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM sessions WHERE user_id = ?")
        .bind(user_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Makes a session act as `acting_as` from `since`, read-only, replacing any acting state it had.
/// Only `start_impersonation` calls this.
pub async fn start_acting(
    conn: &mut SqliteConnection,
    token_hash: &str,
    acting_as: &str,
    acting_id: &str,
    since: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "UPDATE sessions SET acting_as = ?, acting_id = ?, acting_since = ?, allow_changes = 0
         WHERE token_hash = ?",
    )
    .bind(acting_as)
    .bind(acting_id)
    .bind(since)
    .bind(token_hash)
    .execute(conn)
    .await?;
    Ok(())
}

/// The session doing the acting `acting_id` names, if it still exists and still is.
pub async fn by_acting_id(conn: &mut SqliteConnection, acting_id: &str) -> Result<Option<Session>> {
    Ok(sqlx::query_as("SELECT * FROM sessions WHERE acting_id = ?")
        .bind(acting_id)
        .fetch_optional(conn)
        .await?)
}

/// Turns changes on for the acting session `acting_id`. Only `allow_impersonation_changes` calls
/// this.
pub async fn allow_changes(conn: &mut SqliteConnection, acting_id: &str) -> Result<()> {
    sqlx::query("UPDATE sessions SET allow_changes = 1 WHERE acting_id = ?")
        .bind(acting_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Ends the acting session `acting_id`: its session, if it still exists, goes back to its own
/// user's view. Only `end_impersonation` calls this.
pub async fn stop_acting(conn: &mut SqliteConnection, acting_id: &str) -> Result<()> {
    sqlx::query(
        "UPDATE sessions SET acting_as = NULL, acting_id = NULL, acting_since = NULL,
                             allow_changes = 0
         WHERE acting_id = ?",
    )
    .bind(acting_id)
    .execute(conn)
    .await?;
    Ok(())
}
