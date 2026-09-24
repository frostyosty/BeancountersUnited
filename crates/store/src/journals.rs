//! Posted journals and their lines. Rows here are only ever inserted, never updated or deleted.

use acct_core::{Journal, JournalLine, Money};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, StoreError, enum_text, parse, parse_enum};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum JournalKind {
    Manual,
    TbImport,
    /// The year's depreciation journal, posted by the depreciation run.
    Depreciation,
    /// A disposal journal, posted by the depreciation run for an asset disposed of in the year.
    AssetDisposal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredJournal {
    pub id: String,
    pub client_year_id: String,
    pub kind: JournalKind,
    pub reverses_journal_id: Option<String>,
    pub posted_seq: i64,
    pub journal: Journal,
}

#[derive(FromRow)]
struct Row {
    id: String,
    client_year_id: String,
    kind: String,
    date: NaiveDate,
    narration: String,
    reverses_journal_id: Option<String>,
    posted_seq: i64,
}

#[derive(FromRow)]
struct LineRow {
    journal_id: String,
    account: String,
    amount: i64,
}

pub async fn insert(conn: &mut SqliteConnection, j: &StoredJournal) -> Result<()> {
    sqlx::query(
        "INSERT INTO journals
             (id, client_year_id, kind, date, narration, reverses_journal_id, posted_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&j.id)
    .bind(&j.client_year_id)
    .bind(enum_text(&j.kind))
    .bind(j.journal.date)
    .bind(&j.journal.narration)
    .bind(&j.reverses_journal_id)
    .bind(j.posted_seq)
    .execute(&mut *conn)
    .await?;
    for (i, line) in j.journal.lines.iter().enumerate() {
        sqlx::query(
            "INSERT INTO journal_lines (journal_id, line_no, account, amount) VALUES (?, ?, ?, ?)",
        )
        .bind(&j.id)
        .bind(i as i64 + 1)
        .bind(line.account.as_str())
        .bind(line.amount.cents())
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredJournal>> {
    let rows: Vec<Row> = sqlx::query_as("SELECT * FROM journals WHERE id = ?")
        .bind(id)
        .fetch_all(&mut *conn)
        .await?;
    let lines: Vec<LineRow> = sqlx::query_as(
        "SELECT journal_id, account, amount FROM journal_lines WHERE journal_id = ? ORDER BY line_no",
    )
    .bind(id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(assemble(rows, lines)?.pop())
}

/// A year's journals in posting order.
pub async fn for_year(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<Vec<StoredJournal>> {
    let rows: Vec<Row> =
        sqlx::query_as("SELECT * FROM journals WHERE client_year_id = ? ORDER BY posted_seq, id")
            .bind(client_year_id)
            .fetch_all(&mut *conn)
            .await?;
    let lines: Vec<LineRow> = sqlx::query_as(
        "SELECT l.journal_id, l.account, l.amount FROM journal_lines l
         JOIN journals j ON j.id = l.journal_id
         WHERE j.client_year_id = ? ORDER BY l.journal_id, l.line_no",
    )
    .bind(client_year_id)
    .fetch_all(&mut *conn)
    .await?;
    assemble(rows, lines)
}

/// The journal that reverses `id`, if it has been reversed.
pub async fn reversal_of(conn: &mut SqliteConnection, id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT id FROM journals WHERE reverses_journal_id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await?;
    Ok(row.map(|(id,)| id))
}

fn assemble(rows: Vec<Row>, lines: Vec<LineRow>) -> Result<Vec<StoredJournal>> {
    let mut by_journal: std::collections::HashMap<String, Vec<JournalLine>> = Default::default();
    for l in lines {
        by_journal
            .entry(l.journal_id)
            .or_default()
            .push(JournalLine {
                account: parse(&l.account)?,
                amount: Money::from_cents(l.amount),
            });
    }
    rows.into_iter()
        .map(|r| {
            Ok(StoredJournal {
                kind: parse_enum(&r.kind)?,
                journal: Journal {
                    date: r.date,
                    narration: r.narration,
                    lines: by_journal.remove(&r.id).unwrap_or_default(),
                },
                id: r.id,
                client_year_id: r.client_year_id,
                reverses_journal_id: r.reverses_journal_id,
                posted_seq: r.posted_seq,
            })
        })
        .collect::<Result<Vec<_>, StoreError>>()
}
