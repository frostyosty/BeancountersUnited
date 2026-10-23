//! AI category suggestions (ADR 009): each business's consent, and the suggestions waiting on the
//! owner. Prompts and responses are never stored.

use acct_core::coding::Coding;
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, from_json, to_json};

/// A business's AI settings. No row means suggestions are off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AiSettings {
    pub client_id: String,
    pub enabled: bool,
    /// The consent version agreed to when it was turned on.
    pub consent_version: Option<String>,
    pub activity: Option<String>,
    pub private_names: Vec<String>,
    pub updated_seq: i64,
}

#[derive(FromRow)]
struct SettingsRow {
    client_id: String,
    enabled: bool,
    consent_version: Option<String>,
    activity: Option<String>,
    private_names: String,
    updated_seq: i64,
}

pub async fn set_settings(conn: &mut SqliteConnection, s: &AiSettings) -> Result<()> {
    sqlx::query(
        "INSERT INTO ai_settings
             (client_id, enabled, consent_version, activity, private_names, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET enabled = excluded.enabled,
             consent_version = excluded.consent_version, activity = excluded.activity,
             private_names = excluded.private_names, updated_seq = excluded.updated_seq",
    )
    .bind(&s.client_id)
    .bind(s.enabled)
    .bind(&s.consent_version)
    .bind(&s.activity)
    .bind(to_json(&s.private_names))
    .bind(s.updated_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn settings(conn: &mut SqliteConnection, client_id: &str) -> Result<Option<AiSettings>> {
    let row: Option<SettingsRow> = sqlx::query_as("SELECT * FROM ai_settings WHERE client_id = ?")
        .bind(client_id)
        .fetch_optional(conn)
        .await?;
    row.map(|r| {
        Ok(AiSettings {
            client_id: r.client_id,
            enabled: r.enabled,
            consent_version: r.consent_version,
            activity: r.activity,
            private_names: from_json(&r.private_names)?,
            updated_seq: r.updated_seq,
        })
    })
    .transpose()
}

/// A suggestion as stored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredSuggestion {
    pub id: String,
    pub client_id: String,
    pub bank_line_id: String,
    pub coding: Coding,
    pub model: String,
    /// `low`, `medium` or `high`.
    pub confidence: String,
    pub created_seq: i64,
    /// Set once the owner accepted it unchanged.
    pub accepted_seq: Option<i64>,
}

#[derive(FromRow)]
struct SuggestionRow {
    id: String,
    client_id: String,
    bank_line_id: String,
    coding: String,
    model: String,
    confidence: String,
    created_seq: i64,
    accepted_seq: Option<i64>,
}

impl TryFrom<SuggestionRow> for StoredSuggestion {
    type Error = crate::StoreError;
    fn try_from(r: SuggestionRow) -> Result<StoredSuggestion> {
        Ok(StoredSuggestion {
            id: r.id,
            client_id: r.client_id,
            bank_line_id: r.bank_line_id,
            coding: from_json(&r.coding)?,
            model: r.model,
            confidence: r.confidence,
            created_seq: r.created_seq,
            accepted_seq: r.accepted_seq,
        })
    }
}

/// Stores a suggestion, replacing any other suggestion still waiting on the same line.
pub async fn insert_suggestion(conn: &mut SqliteConnection, s: &StoredSuggestion) -> Result<()> {
    forget_line(conn, &s.bank_line_id).await?;
    sqlx::query(
        "INSERT INTO ai_suggestions
             (id, client_id, bank_line_id, coding, model, confidence, created_seq, accepted_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&s.id)
    .bind(&s.client_id)
    .bind(&s.bank_line_id)
    .bind(to_json(&s.coding))
    .bind(&s.model)
    .bind(&s.confidence)
    .bind(s.created_seq)
    .bind(s.accepted_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn suggestion(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredSuggestion>> {
    let row: Option<SuggestionRow> = sqlx::query_as("SELECT * FROM ai_suggestions WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(StoredSuggestion::try_from).transpose()
}

/// The suggestions of a business still waiting on the owner, oldest first.
pub async fn live_suggestions(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<StoredSuggestion>> {
    let rows: Vec<SuggestionRow> = sqlx::query_as(
        "SELECT * FROM ai_suggestions WHERE client_id = ? AND accepted_seq IS NULL
         ORDER BY created_seq, id",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(StoredSuggestion::try_from).collect()
}

pub async fn accept(conn: &mut SqliteConnection, id: &str, seq: i64) -> Result<()> {
    sqlx::query("UPDATE ai_suggestions SET accepted_seq = ? WHERE id = ?")
        .bind(seq)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Deletes the suggestion still waiting on a line, if any: the line was sorted some other way.
pub async fn forget_line(conn: &mut SqliteConnection, bank_line_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM ai_suggestions WHERE bank_line_id = ? AND accepted_seq IS NULL")
        .bind(bank_line_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Deletes every suggestion of a business still waiting on the owner.
pub async fn forget_client(conn: &mut SqliteConnection, client_id: &str) -> Result<()> {
    sqlx::query("DELETE FROM ai_suggestions WHERE client_id = ? AND accepted_seq IS NULL")
        .bind(client_id)
        .execute(conn)
        .await?;
    Ok(())
}
