//! Backups (M12): a consistent copy of the database made with `VACUUM INTO`, and the summary of
//! `command_log` that the restore drill compares between a backup and the live database
//! (docs/operations.md).
//!
//! Both work on a read-only connection of their own, so they can run in a separate process
//! (`acctd backup`, `acctd restore-check`) while the server keeps writing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection};
use sqlx::{ConnectOptions, Connection};
use thiserror::Error;

use crate::StoreError;

#[derive(Debug, Error)]
pub enum BackupError {
    #[error("{0} already exists; a backup never overwrites a file")]
    Exists(PathBuf),
    #[error("{0} doesn't exist")]
    Missing(PathBuf),
    #[error("{0} isn't valid UTF-8, which SQLite needs for a file name")]
    BadPath(PathBuf),
    #[error(transparent)]
    Store(#[from] StoreError),
}

impl From<sqlx::Error> for BackupError {
    fn from(e: sqlx::Error) -> Self {
        BackupError::Store(e.into())
    }
}

pub type Result<T, E = BackupError> = std::result::Result<T, E>;

/// Opens the database at `path` read-only. It must already exist; nothing is created or migrated.
pub async fn open_read_only(path: &Path) -> Result<SqliteConnection> {
    if !path.exists() {
        return Err(BackupError::Missing(path.to_owned()));
    }
    Ok(SqliteConnectOptions::new()
        .filename(path)
        .read_only(true)
        .busy_timeout(Duration::from_secs(5))
        .connect()
        .await?)
}

/// Writes a consistent copy of the database `conn` is open on to `dest` with `VACUUM INTO`.
/// `VACUUM INTO` reads inside one transaction, so the copy is a snapshot even while the server
/// commits. Refuses if `dest` already exists. Returns the latest `seq` in the copy.
pub async fn backup_into(conn: &mut SqliteConnection, dest: &Path) -> Result<i64> {
    if dest.exists() {
        return Err(BackupError::Exists(dest.to_owned()));
    }
    let name = dest
        .to_str()
        .ok_or_else(|| BackupError::BadPath(dest.to_owned()))?;
    sqlx::query("VACUUM INTO ?")
        .bind(name)
        .execute(&mut *conn)
        .await?;
    let mut copy = open_read_only(dest).await?;
    let seq = crate::log::head_seq(&mut copy).await?;
    copy.close().await?;
    Ok(seq)
}

/// What the restore drill compares: the latest `seq` and the number of rows in `command_log`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LogSummary {
    pub head_seq: i64,
    pub rows: i64,
}

/// Feeds every row of `command_log`, in `seq` order, to `sink` as bytes, and returns the summary.
/// The caller hashes the bytes (the server uses SHA-256).
///
/// Each row is its `seq` as 8 little-endian bytes, then each column in schema order (`id`, `kind`,
/// `payload`, `result`, `user_id`, `client_id`, `client_year_id`, `at`, `via`): `0` for NULL, or
/// `1`, the length as 8 little-endian bytes, and the stored text. Lengths make the encoding
/// unambiguous, and `at` is the stored text, so the hash covers exactly what's on disk.
/// A migration that adds a column to `command_log` must add it here too.
pub async fn summarise_log(
    conn: &mut SqliteConnection,
    sink: &mut dyn FnMut(&[u8]),
) -> Result<LogSummary> {
    const PAGE: i64 = 1000;
    let mut summary = LogSummary {
        head_seq: 0,
        rows: 0,
    };
    // One read transaction, so the pages all come from the same snapshot.
    let mut tx = conn.begin().await?;
    loop {
        let page: Vec<Row> = sqlx::query_as(
            "SELECT seq, id, kind, payload, result, user_id, client_id, client_year_id,
                    CAST(at AS TEXT) AS at, via
             FROM command_log WHERE seq > ? ORDER BY seq LIMIT ?",
        )
        .bind(summary.head_seq)
        .bind(PAGE)
        .fetch_all(&mut *tx)
        .await?;
        for row in &page {
            sink(&row.seq.to_le_bytes());
            for field in [
                Some(&row.id),
                Some(&row.kind),
                Some(&row.payload),
                Some(&row.result),
                row.user_id.as_ref(),
                row.client_id.as_ref(),
                row.client_year_id.as_ref(),
                Some(&row.at),
                row.via.as_ref(),
            ] {
                match field {
                    None => sink(&[0]),
                    Some(text) => {
                        sink(&[1]);
                        sink(&(text.len() as u64).to_le_bytes());
                        sink(text.as_bytes());
                    }
                }
            }
            summary.head_seq = row.seq;
            summary.rows += 1;
        }
        if (page.len() as i64) < PAGE {
            break;
        }
    }
    tx.commit().await?;
    Ok(summary)
}

/// SQLite's `PRAGMA integrity_check`: `"ok"`, or the problems it found.
pub async fn integrity_check(conn: &mut SqliteConnection) -> Result<String> {
    let lines: Vec<(String,)> = sqlx::query_as("PRAGMA integrity_check")
        .fetch_all(conn)
        .await?;
    Ok(lines
        .into_iter()
        .map(|(l,)| l)
        .collect::<Vec<_>>()
        .join("\n"))
}

#[derive(sqlx::FromRow)]
struct Row {
    seq: i64,
    id: String,
    kind: String,
    payload: String,
    result: String,
    user_id: Option<String>,
    client_id: Option<String>,
    client_year_id: Option<String>,
    at: String,
    via: Option<String>,
}
