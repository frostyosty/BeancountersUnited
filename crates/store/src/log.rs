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
    /// How the command came about (ADR 009), as JSON, such as accepting an AI suggestion. `None`
    /// for a command the user made alone.
    pub via: Option<String>,
    /// What the command changed (M13), as JSON: the tax figure before and after, and each value
    /// it touched. `None` for commands logged before M13.
    pub changes: Option<String>,
    /// The person an overseer was viewing as when the command was made (M19, ADR 013). `user_id`
    /// stays the overseer. `None` for every command made as oneself.
    pub acting_as: Option<String>,
    /// Set when the row was redacted because the unclaimed guest business it's about was deleted
    /// (M20, ADR 014, 6): the `seq` of the command that deleted it. Its payload, result details
    /// and changes are gone; Changes and the sync feed skip it.
    #[sqlx(default)]
    pub redacted_seq: Option<i64>,
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
             (seq, id, kind, payload, result, user_id, client_id, client_year_id, at, via,
              changes, acting_as)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
    .bind(&entry.via)
    .bind(&entry.changes)
    .bind(&entry.acting_as)
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

/// Every command of one kind, oldest first. The impersonation sweep (M19) uses it to find acting
/// sessions that started and haven't ended; `command_log_kind` keeps it to those rows.
pub async fn of_kind(conn: &mut SqliteConnection, kind: &str) -> Result<Vec<LoggedCommand>> {
    Ok(
        sqlx::query_as("SELECT * FROM command_log WHERE kind = ? ORDER BY seq")
            .bind(kind)
            .fetch_all(conn)
            .await?,
    )
}

/// Up to `limit` commands before `seq`, newest first, for the history panel. `client_id` and
/// `user_id`, when given, keep only that business's or that person's commands: made by them, or
/// made as them by an overseer viewing as them (M19).
pub async fn before(
    conn: &mut SqliteConnection,
    seq: i64,
    client_id: Option<&str>,
    user_id: Option<&str>,
    limit: i64,
) -> Result<Vec<LoggedCommand>> {
    Ok(sqlx::query_as(
        "SELECT * FROM command_log
         WHERE seq < ? AND (?2 IS NULL OR client_id = ?2) AND (?3 IS NULL OR user_id = ?3 OR acting_as = ?3)
         ORDER BY seq DESC LIMIT ?4",
    )
    .bind(seq)
    .bind(client_id)
    .bind(user_id)
    .bind(limit)
    .fetch_all(conn)
    .await?)
}

/// How many commands are about one client: what a deleted trial's entry counts (M20).
pub async fn count_for_client(conn: &mut SqliteConnection, client_id: &str) -> Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM command_log WHERE client_id = ?")
        .bind(client_id)
        .fetch_one(conn)
        .await?;
    Ok(n)
}
