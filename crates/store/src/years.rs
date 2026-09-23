//! Client-years.

use acct_core::ClientYear;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, StoreError, enum_text, parse_enum};

/// Where a year's books come from. Never both: that would double-count (CLAUDE.md).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum BooksSource {
    TbImport,
    BankCoding,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum YearStatus {
    Open,
    Finalised,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredYear {
    pub id: String,
    pub client_id: String,
    pub year: ClientYear,
    pub template_version_id: String,
    pub mapping_version_id: String,
    pub books_source: Option<BooksSource>,
    pub status: YearStatus,
    pub created_seq: i64,
}

#[derive(FromRow)]
struct Row {
    id: String,
    client_id: String,
    start_date: NaiveDate,
    end_date: NaiveDate,
    template_version_id: String,
    mapping_version_id: String,
    books_source: Option<String>,
    status: String,
    created_seq: i64,
}

impl TryFrom<Row> for StoredYear {
    type Error = StoreError;
    fn try_from(r: Row) -> Result<StoredYear> {
        Ok(StoredYear {
            id: r.id,
            client_id: r.client_id,
            year: ClientYear::new(r.start_date, r.end_date)
                .map_err(|e| StoreError::Corrupt(e.to_string()))?,
            template_version_id: r.template_version_id,
            mapping_version_id: r.mapping_version_id,
            books_source: r.books_source.as_deref().map(parse_enum).transpose()?,
            status: parse_enum(&r.status)?,
            created_seq: r.created_seq,
        })
    }
}

pub async fn insert(conn: &mut SqliteConnection, y: &StoredYear) -> Result<()> {
    sqlx::query(
        "INSERT INTO client_years
             (id, client_id, start_date, end_date, template_version_id, mapping_version_id,
              books_source, status, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&y.id)
    .bind(&y.client_id)
    .bind(y.year.start())
    .bind(y.year.end())
    .bind(&y.template_version_id)
    .bind(&y.mapping_version_id)
    .bind(y.books_source.map(|s| enum_text(&s)))
    .bind(enum_text(&y.status))
    .bind(y.created_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredYear>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM client_years WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(StoredYear::try_from).transpose()
}

/// A client's years, earliest first.
pub async fn for_client(conn: &mut SqliteConnection, client_id: &str) -> Result<Vec<StoredYear>> {
    let rows: Vec<Row> =
        sqlx::query_as("SELECT * FROM client_years WHERE client_id = ? ORDER BY start_date")
            .bind(client_id)
            .fetch_all(conn)
            .await?;
    rows.into_iter().map(StoredYear::try_from).collect()
}

pub async fn set_books_source(
    conn: &mut SqliteConnection,
    id: &str,
    source: BooksSource,
) -> Result<()> {
    sqlx::query("UPDATE client_years SET books_source = ? WHERE id = ?")
        .bind(enum_text(&source))
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
