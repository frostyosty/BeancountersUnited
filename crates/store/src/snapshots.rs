//! Finalisation snapshots: what was signed when a year was finalised (CLAUDE.md, Snapshots).
//! Never updated or deleted. A reopened year keeps its old snapshots, and finalising it again adds
//! a new one, so every signed version stays on record.

use acct_core::TrialBalance;
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, from_json, to_json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub id: String,
    pub client_year_id: String,
    pub tb: TrialBalance,
    pub template_version_id: String,
    pub mapping_version_id: String,
    /// The ReportDoc's JSON exactly as it was signed. Served as stored, never rebuilt.
    pub report_doc: String,
    /// SHA-256 of `report_doc`'s bytes, as lowercase hex.
    pub report_sha256: String,
    pub finalised_seq: i64,
    pub finalised_by: String,
}

#[derive(FromRow)]
struct Row {
    id: String,
    client_year_id: String,
    tb: String,
    template_version_id: String,
    mapping_version_id: String,
    report_doc: String,
    report_sha256: String,
    finalised_seq: i64,
    finalised_by: String,
}

impl TryFrom<Row> for Snapshot {
    type Error = crate::StoreError;
    fn try_from(r: Row) -> Result<Snapshot> {
        Ok(Snapshot {
            id: r.id,
            client_year_id: r.client_year_id,
            tb: from_json(&r.tb)?,
            template_version_id: r.template_version_id,
            mapping_version_id: r.mapping_version_id,
            report_doc: r.report_doc,
            report_sha256: r.report_sha256,
            finalised_seq: r.finalised_seq,
            finalised_by: r.finalised_by,
        })
    }
}

pub async fn insert(conn: &mut SqliteConnection, s: &Snapshot) -> Result<()> {
    sqlx::query(
        "INSERT INTO snapshots
             (id, client_year_id, tb, template_version_id, mapping_version_id, report_doc,
              report_sha256, finalised_seq, finalised_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.id)
    .bind(&s.client_year_id)
    .bind(to_json(&s.tb))
    .bind(&s.template_version_id)
    .bind(&s.mapping_version_id)
    .bind(&s.report_doc)
    .bind(&s.report_sha256)
    .bind(s.finalised_seq)
    .bind(&s.finalised_by)
    .execute(conn)
    .await?;
    Ok(())
}

/// A year's snapshots, oldest first.
pub async fn for_year(conn: &mut SqliteConnection, client_year_id: &str) -> Result<Vec<Snapshot>> {
    let rows: Vec<Row> =
        sqlx::query_as("SELECT * FROM snapshots WHERE client_year_id = ? ORDER BY finalised_seq")
            .bind(client_year_id)
            .fetch_all(conn)
            .await?;
    rows.into_iter().map(Snapshot::try_from).collect()
}

/// The year's most recent snapshot: the one in force while the year is finalised.
pub async fn latest(conn: &mut SqliteConnection, client_year_id: &str) -> Result<Option<Snapshot>> {
    let row: Option<Row> = sqlx::query_as(
        "SELECT * FROM snapshots WHERE client_year_id = ? ORDER BY finalised_seq DESC LIMIT 1",
    )
    .bind(client_year_id)
    .fetch_optional(conn)
    .await?;
    row.map(Snapshot::try_from).transpose()
}
