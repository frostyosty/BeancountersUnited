//! Requests for a practice account (M21, ADR 015, 7): an accountant or bookkeeper asks us to set
//! their practice up. The personal details live only here; the command's log entry has
//! `[redacted]` in their place, so deleting a row deletes them.
//!
//! Every function here that writes runs inside a command's transaction (CLAUDE.md hard rule 6).

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqliteConnection};

use crate::Result;

/// One request, as stored. `clients` and `came_from` are the server's enum names.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct PracticeRequest {
    pub id: String,
    pub name: String,
    pub email: String,
    pub practice_name: String,
    pub clients: String,
    pub phone: Option<String>,
    pub came_from: Option<String>,
    pub created_seq: i64,
    pub created_at: DateTime<Utc>,
}

pub async fn insert(conn: &mut SqliteConnection, r: &PracticeRequest) -> Result<()> {
    sqlx::query(
        "INSERT INTO practice_requests
             (id, name, email, practice_name, clients, phone, came_from, created_seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&r.id)
    .bind(&r.name)
    .bind(&r.email)
    .bind(&r.practice_name)
    .bind(&r.clients)
    .bind(&r.phone)
    .bind(&r.came_from)
    .bind(r.created_seq)
    .bind(r.created_at)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<PracticeRequest>> {
    Ok(
        sqlx::query_as("SELECT * FROM practice_requests WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await?,
    )
}

/// Every request, newest first.
pub async fn list(conn: &mut SqliteConnection) -> Result<Vec<PracticeRequest>> {
    Ok(
        sqlx::query_as("SELECT * FROM practice_requests ORDER BY created_seq DESC")
            .fetch_all(conn)
            .await?,
    )
}

/// How many requests arrived at or after `since`.
pub async fn count_since(conn: &mut SqliteConnection, since: DateTime<Utc>) -> Result<i64> {
    // Compared in Rust, as `guests::started_since` does, so the stored format can't matter. The
    // table is small: rows go after 90 days.
    let all: Vec<(DateTime<Utc>,)> = sqlx::query_as("SELECT created_at FROM practice_requests")
        .fetch_all(conn)
        .await?;
    Ok(all.iter().filter(|(at,)| *at >= since).count() as i64)
}

/// The ids of requests that arrived before `cutoff`, oldest first: the sweep deletes these.
pub async fn older_than(conn: &mut SqliteConnection, cutoff: DateTime<Utc>) -> Result<Vec<String>> {
    let all: Vec<(String, DateTime<Utc>)> =
        sqlx::query_as("SELECT id, created_at FROM practice_requests ORDER BY created_seq")
            .fetch_all(conn)
            .await?;
    Ok(all
        .into_iter()
        .filter(|(_, at)| *at < cutoff)
        .map(|(id, _)| id)
        .collect())
}

/// Deletes one request. Returns whether there was one.
pub async fn delete(conn: &mut SqliteConnection, id: &str) -> Result<bool> {
    let done = sqlx::query("DELETE FROM practice_requests WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(done.rows_affected() > 0)
}
