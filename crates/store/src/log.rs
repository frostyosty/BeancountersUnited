//! The command log: every accepted command, in `seq` order.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqliteConnection};

use crate::Result;

/// One accepted command. `payload` and `result` are JSON text.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct LoggedCommand {
    pub seq: i64,
    pub id: String,
    pub kind: String,
    pub payload: String,
    pub result: String,
    pub user_id: Option<String>,
    pub client_id: Option<String>,
    pub client_year_id: Option<String>,
    pub at: DateTime<Utc>,
}

/// The newest `seq` in the log, or 0 if it's empty.
pub async fn head_seq(conn: &mut SqliteConnection) -> Result<i64> {
    let (last,): (Option<i64>,) = sqlx::query_as("SELECT MAX(seq) FROM command_log")
        .fetch_one(conn)
        .await?;
    Ok(last.unwrap_or(0))
}

/// The `seq` the next accepted command will get. Only meaningful on the writer connection, inside
/// the command's transaction, where nothing else can append in between.
pub async fn next_seq(conn: &mut SqliteConnection) -> Result<i64> {
    let (last,): (Option<i64>,) = sqlx::query_as("SELECT MAX(seq) FROM command_log")
        .fetch_one(conn)
        .await?;
    Ok(last.unwrap_or(0) + 1)
}

pub async fn append(conn: &mut SqliteConnection, entry: &LoggedCommand) -> Result<()> {
    sqlx::query(
        "INSERT INTO command_log
             (seq, id, kind, payload, result, user_id, client_id, client_year_id, at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(entry.seq)
    .bind(&entry.id)
    .bind(&entry.kind)
    .bind(&entry.payload)
    .bind(&entry.result)
    .bind(&entry.user_id)
    .bind(&entry.client_id)
    .bind(&entry.client_year_id)
    .bind(entry.at)
    .execute(conn)
    .await?;
    Ok(())
}

/// The command accepted under `id`, if any, for idempotent resubmission.
pub async fn find(conn: &mut SqliteConnection, id: &str) -> Result<Option<LoggedCommand>> {
    Ok(sqlx::query_as("SELECT * FROM command_log WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

/// Up to `limit` commands after `seq`, oldest first: the sync feed.
pub async fn after(
    conn: &mut SqliteConnection,
    seq: i64,
    limit: i64,
) -> Result<Vec<LoggedCommand>> {
    Ok(
        sqlx::query_as("SELECT * FROM command_log WHERE seq > ? ORDER BY seq LIMIT ?")
            .bind(seq)
            .bind(limit)
            .fetch_all(conn)
            .await?,
    )
}
