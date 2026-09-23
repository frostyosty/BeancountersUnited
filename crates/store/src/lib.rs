//! SQLite schema, migrations and repositories for acct.
//!
//! One writer connection serialises every change; a pool of read connections serves queries
//! (ADR 004). Repository functions take a `&mut SqliteConnection`, so the same function works on a
//! read connection or inside the writer's transaction (`&mut *tx`).

use std::path::Path;
use std::str::FromStr;
use std::time::Duration;

use serde::Serialize;
use serde::de::DeserializeOwned;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteSynchronous,
};
use sqlx::{ConnectOptions, Connection};
use thiserror::Error;
use tokio::sync::{Mutex, MutexGuard};

pub mod charts;
pub mod clients;
pub mod journals;
pub mod log;
pub mod practice;
pub mod sessions;
pub mod templates;
pub mod users;
pub mod years;

pub use sqlx;
pub use sqlx::SqliteConnection;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[derive(Debug, Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
    #[error(transparent)]
    Migrate(#[from] sqlx::migrate::MigrateError),
    /// A stored value that doesn't decode, such as an unknown enum name or malformed JSON.
    #[error("stored data is invalid: {0}")]
    Corrupt(String),
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

/// The database: one writer connection and a pool of readers.
pub struct Store {
    writer: Mutex<SqliteConnection>,
    readers: SqlitePool,
}

impl Store {
    /// Opens (creating if needed) the database at `path` and brings its schema up to date.
    pub async fn open(path: &Path) -> Result<Store> {
        let options = SqliteConnectOptions::new()
            .filename(path)
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .synchronous(SqliteSynchronous::Full)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(5));
        let mut writer = options.connect().await?;
        MIGRATOR.run(&mut writer).await?;
        let readers = SqlitePoolOptions::new()
            .max_connections(4)
            .connect_with(options.read_only(true))
            .await?;
        Ok(Store {
            writer: Mutex::new(writer),
            readers,
        })
    }

    /// The writer connection. Holding the guard serialises writers; the command pipeline runs
    /// each command in one transaction on it.
    pub async fn writer(&self) -> MutexGuard<'_, SqliteConnection> {
        self.writer.lock().await
    }

    /// A read connection from the pool.
    pub async fn reader(&self) -> Result<sqlx::pool::PoolConnection<sqlx::Sqlite>> {
        Ok(self.readers.acquire().await?)
    }

    pub async fn close(self) -> Result<()> {
        self.readers.close().await;
        self.writer.into_inner().close().await?;
        Ok(())
    }
}

/// A new entity id: a UUIDv7, so ids sort roughly by creation time.
pub fn new_id() -> String {
    uuid::Uuid::now_v7().to_string()
}

/// Stores a unit enum (such as `AccountType`) as its serde name, e.g. `"asset"`.
pub(crate) fn enum_text<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        other => panic!("not a unit enum: {other:?}"),
    }
}

pub(crate) fn parse_enum<T: DeserializeOwned>(s: &str) -> Result<T> {
    serde_json::from_value(serde_json::Value::String(s.to_owned()))
        .map_err(|e| StoreError::Corrupt(format!("{s:?}: {e}")))
}

pub(crate) fn to_json<T: Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("domain types serialise")
}

pub(crate) fn from_json<T: DeserializeOwned>(s: &str) -> Result<T> {
    serde_json::from_str(s).map_err(|e| StoreError::Corrupt(e.to_string()))
}

pub(crate) fn parse<T: FromStr>(s: &str) -> Result<T>
where
    T::Err: std::fmt::Display,
{
    s.parse()
        .map_err(|e: T::Err| StoreError::Corrupt(format!("{s:?}: {e}")))
}
