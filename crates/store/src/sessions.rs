//! Login sessions. Not practice data, so these are written directly, outside the command
//! pipeline (CLAUDE.md hard rule 6). Only a hash of each session token is stored.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqliteConnection};

use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Session {
    pub token_hash: String,
    pub user_id: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

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
