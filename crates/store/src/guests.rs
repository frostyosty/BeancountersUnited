//! Guests (M20, ADR 014): someone trying it on the home page with no sign-up.
//!
//! A guest is a user with `guest_since` set and `claimed_at` empty (`users::User::is_guest`). Their
//! businesses are ordinary businesses with an owner row in `client_access`. This module keeps what
//! only guests need: which example a business was made from, where its GST registration came from,
//! the counts the abuse limits check, and the deletion when a trial ends.
//!
//! Every function here that writes runs inside a command's transaction (CLAUDE.md hard rule 6).

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqliteConnection};

use crate::bank::GstSetting;
use crate::{Result, enum_text, parse_enum};

/// Where a business's GST registration came from (ADR 014, 3). Stronger sources win:
/// `Ird` > `Owner` > `Detected` > `Assumed`.
#[derive(
    Debug,
    Clone,
    Copy,
    PartialEq,
    Eq,
    PartialOrd,
    Ord,
    serde::Serialize,
    serde::Deserialize,
    ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum GstSource {
    /// Nothing in the statements proved it either way, so it's treated as registered: the higher
    /// figure.
    Assumed,
    /// A GST payment to IRD, or a GST refund from IRD, in the statements.
    Detected,
    /// The owner said so. Businesses set up before M20 count as this.
    Owner,
    /// IRD's filing obligations said so (M14).
    Ird,
}

/// The guest-related settings of one business.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BusinessFlags {
    /// The example it was made from, 1 to 3.
    pub example: Option<u8>,
    /// `None` for a business set up before M20: given at setup, so the owner's.
    pub gst_source: Option<GstSource>,
    /// The bank line that proved registration, when it was detected.
    pub gst_evidence: Option<String>,
}

impl BusinessFlags {
    /// Where its GST registration came from, counting "given at setup" as the owner's.
    pub fn source(&self) -> GstSource {
        self.gst_source.unwrap_or(GstSource::Owner)
    }
}

#[derive(FromRow)]
struct FlagsRow {
    example: Option<i64>,
    gst_source: Option<String>,
    gst_evidence: Option<String>,
}

pub async fn flags(conn: &mut SqliteConnection, client_id: &str) -> Result<Option<BusinessFlags>> {
    let row: Option<FlagsRow> = sqlx::query_as(
        "SELECT example, gst_source, gst_evidence FROM businesses WHERE client_id = ?",
    )
    .bind(client_id)
    .fetch_optional(conn)
    .await?;
    row.map(|r| {
        Ok(BusinessFlags {
            example: r.example.and_then(|n| u8::try_from(n).ok()),
            gst_source: r.gst_source.as_deref().map(parse_enum).transpose()?,
            gst_evidence: r.gst_evidence,
        })
    })
    .transpose()
}

pub async fn set_example(conn: &mut SqliteConnection, client_id: &str, example: u8) -> Result<()> {
    sqlx::query("UPDATE businesses SET example = ? WHERE client_id = ?")
        .bind(i64::from(example))
        .bind(client_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Sets a business's GST registration (`None`: not registered) and where that came from.
pub async fn set_gst(
    conn: &mut SqliteConnection,
    client_id: &str,
    gst: Option<GstSetting>,
    source: GstSource,
    evidence: Option<&str>,
) -> Result<()> {
    sqlx::query(
        "UPDATE businesses SET gst_registered_from = ?, gst_frequency = ?, gst_source = ?,
                               gst_evidence = ?
         WHERE client_id = ?",
    )
    .bind(gst.map(|g| g.registered_from))
    .bind(gst.map(|g| enum_text(&g.frequency)))
    .bind(enum_text(&source))
    .bind(evidence)
    .bind(client_id)
    .execute(conn)
    .await?;
    Ok(())
}

/// A business whose owner is a guest who hasn't saved their work.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct GuestBusiness {
    pub client_id: String,
    pub user_id: String,
    /// The example it was made from, if it's an example.
    pub example: Option<i64>,
    /// When the command that made it was accepted. `None` inside that command, before it's logged.
    pub created_at: Option<DateTime<Utc>>,
}

/// Every business owned by a guest who hasn't saved their work, oldest first.
pub async fn guest_businesses(conn: &mut SqliteConnection) -> Result<Vec<GuestBusiness>> {
    Ok(sqlx::query_as(
        "SELECT b.client_id, a.user_id, b.example, l.at AS created_at
         FROM businesses b
         JOIN client_access a ON a.client_id = b.client_id AND a.access = 'owner'
         JOIN users u ON u.id = a.user_id
         LEFT JOIN command_log l ON l.seq = b.created_seq
         WHERE u.guest_since IS NOT NULL AND u.claimed_at IS NULL
         ORDER BY b.created_seq, b.client_id",
    )
    .fetch_all(conn)
    .await?)
}

/// The businesses one guest owns, oldest first.
pub async fn businesses_of(conn: &mut SqliteConnection, user_id: &str) -> Result<Vec<GuestBusiness>> {
    Ok(sqlx::query_as(
        "SELECT b.client_id, a.user_id, b.example, l.at AS created_at
         FROM businesses b
         JOIN client_access a ON a.client_id = b.client_id AND a.access = 'owner'
         LEFT JOIN command_log l ON l.seq = b.created_seq
         WHERE a.user_id = ?
         ORDER BY b.created_seq, b.client_id",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await?)
}

/// Whether `client_id` is a business owned by a guest who hasn't saved their work, and if so, who.
pub async fn guest_owner(conn: &mut SqliteConnection, client_id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT a.user_id FROM client_access a JOIN users u ON u.id = a.user_id
         WHERE a.client_id = ? AND a.access = 'owner'
           AND u.guest_since IS NOT NULL AND u.claimed_at IS NULL",
    )
    .bind(client_id)
    .fetch_optional(conn)
    .await?;
    Ok(row.map(|(u,)| u))
}

/// What a guest holds, for the per-guest limits.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Holding {
    pub statements: i64,
    pub lines: i64,
    /// Bytes of kept statement files.
    pub file_bytes: i64,
}

/// What the businesses one user owns hold between them.
pub async fn holding(conn: &mut SqliteConnection, user_id: &str) -> Result<Holding> {
    let (statements, lines, file_bytes): (i64, i64, i64) = sqlx::query_as(
        "SELECT
             (SELECT COUNT(*) FROM statements s JOIN bank_accounts ba ON ba.id = s.bank_account_id
                  JOIN client_access a ON a.client_id = ba.client_id
              WHERE a.user_id = ?1 AND a.access = 'owner'),
             (SELECT COUNT(*) FROM bank_lines l JOIN bank_accounts ba ON ba.id = l.bank_account_id
                  JOIN client_access a ON a.client_id = ba.client_id
              WHERE a.user_id = ?1 AND a.access = 'owner'),
             (SELECT COALESCE(SUM(LENGTH(f.bytes)), 0) FROM statement_files f
                  JOIN statements s ON s.id = f.statement_id
                  JOIN bank_accounts ba ON ba.id = s.bank_account_id
                  JOIN client_access a ON a.client_id = ba.client_id
              WHERE a.user_id = ?1 AND a.access = 'owner')",
    )
    .bind(user_id)
    .fetch_one(conn)
    .await?;
    Ok(Holding {
        statements,
        lines,
        file_bytes,
    })
}

/// Guests alive now, and the bytes of statement files all of them hold together.
pub async fn totals(conn: &mut SqliteConnection) -> Result<(i64, i64)> {
    let (guests, bytes): (i64, i64) = sqlx::query_as(
        "SELECT
             (SELECT COUNT(*) FROM users
              WHERE guest_since IS NOT NULL AND claimed_at IS NULL AND active),
             (SELECT COALESCE(SUM(LENGTH(f.bytes)), 0) FROM statement_files f
                  JOIN statements s ON s.id = f.statement_id
                  JOIN bank_accounts ba ON ba.id = s.bank_account_id
                  JOIN client_access a ON a.client_id = ba.client_id AND a.access = 'owner'
                  JOIN users u ON u.id = a.user_id
              WHERE u.guest_since IS NOT NULL AND u.claimed_at IS NULL)",
    )
    .fetch_one(conn)
    .await?;
    Ok((guests, bytes))
}

/// How many guests were started since `since`, across everyone.
pub async fn started_since(conn: &mut SqliteConnection, since: DateTime<Utc>) -> Result<i64> {
    // Compared in Rust, as `sessions` does, so the stored timestamp format can't matter.
    let all: Vec<(DateTime<Utc>,)> =
        sqlx::query_as("SELECT guest_since FROM users WHERE guest_since IS NOT NULL")
            .fetch_all(conn)
            .await?;
    Ok(all.iter().filter(|(at,)| *at >= since).count() as i64)
}

/// What [`delete_business`] removed, for the log entry of the command that did it.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Deleted {
    pub statements: i64,
    pub lines: i64,
}

/// Deletes one business and everything about it (ADR 014, 6): its kept files, its books, what the
/// owner told us, its assets, AI suggestions, settings, access and the business itself. Only for
/// an unclaimed guest's business; the caller checks. `command_log` is left to [`redact_log`].
pub async fn delete_business(conn: &mut SqliteConnection, client_id: &str) -> Result<Deleted> {
    let (statements, lines): (i64, i64) = sqlx::query_as(
        "SELECT
             (SELECT COUNT(*) FROM statements s JOIN bank_accounts ba ON ba.id = s.bank_account_id
              WHERE ba.client_id = ?1),
             (SELECT COUNT(*) FROM bank_lines l JOIN bank_accounts ba ON ba.id = l.bank_account_id
              WHERE ba.client_id = ?1)",
    )
    .bind(client_id)
    .fetch_one(&mut *conn)
    .await?;

    // Children before parents, so every foreign key holds after each statement.
    const STEPS: &[&str] = &[
        "UPDATE businesses SET gst_evidence = NULL WHERE client_id = ?1",
        "UPDATE bank_accounts SET opening_journal_id = NULL WHERE id IN (SELECT id FROM bank_accounts WHERE client_id = ?1)",
        // The files.
        "DELETE FROM balance_spans WHERE statement_id IN (SELECT s.id FROM statements s JOIN bank_accounts ba ON ba.id = s.bank_account_id WHERE ba.client_id = ?1)",
        "DELETE FROM statement_files WHERE statement_id IN (SELECT s.id FROM statements s JOIN bank_accounts ba ON ba.id = s.bank_account_id WHERE ba.client_id = ?1) OR same_as IN (SELECT s.id FROM statements s JOIN bank_accounts ba ON ba.id = s.bank_account_id WHERE ba.client_id = ?1)",
        // What the owner told us about lines, and AI's suggestions for them.
        "DELETE FROM ai_suggestions WHERE client_id = ?1",
        "DELETE FROM bank_line_states WHERE bank_line_id IN (SELECT l.id FROM bank_lines l JOIN bank_accounts ba ON ba.id = l.bank_account_id WHERE ba.client_id = ?1)",
        "DELETE FROM supply_info_confirmations WHERE bank_line_id IN (SELECT l.id FROM bank_lines l JOIN bank_accounts ba ON ba.id = l.bank_account_id WHERE ba.client_id = ?1)",
        "DELETE FROM duplicate_answers WHERE bank_line_id IN (SELECT l.id FROM bank_lines l JOIN bank_accounts ba ON ba.id = l.bank_account_id WHERE ba.client_id = ?1)",
        // The books.
        "DELETE FROM bank_lines WHERE id IN (SELECT l.id FROM bank_lines l JOIN bank_accounts ba ON ba.id = l.bank_account_id WHERE ba.client_id = ?1)",
        "DELETE FROM gap_journals WHERE bank_account_id IN (SELECT id FROM bank_accounts WHERE client_id = ?1)",
        "DELETE FROM statements WHERE id IN (SELECT s.id FROM statements s JOIN bank_accounts ba ON ba.id = s.bank_account_id WHERE ba.client_id = ?1)",
        // Assets.
        "DELETE FROM asset_charges WHERE asset_id IN (SELECT id FROM assets WHERE client_id = ?1)",
        "DELETE FROM assets WHERE client_id = ?1",
        "DELETE FROM client_asset_classes WHERE client_id = ?1",
        // Years: notes, snapshots, journals.
        "DELETE FROM year_notes WHERE client_year_id IN (SELECT id FROM client_years WHERE client_id = ?1)",
        "DELETE FROM snapshots WHERE client_year_id IN (SELECT id FROM client_years WHERE client_id = ?1)",
        "DELETE FROM journal_lines WHERE journal_id IN (SELECT j.id FROM journals j JOIN client_years y ON y.id = j.client_year_id WHERE y.client_id = ?1)",
        "DELETE FROM journals WHERE id IN (SELECT j.id FROM journals j JOIN client_years y ON y.id = j.client_year_id WHERE y.client_id = ?1)",
        // Settings, rules and answers.
        "DELETE FROM coding_rules WHERE client_id = ?1",
        "DELETE FROM coding_settings WHERE client_id = ?1",
        "DELETE FROM tax_answers WHERE client_id = ?1",
        "DELETE FROM ai_settings WHERE client_id = ?1",
        "DELETE FROM history_sharing WHERE client_id = ?1",
        // Access.
        "DELETE FROM invites WHERE client_id = ?1",
        "DELETE FROM client_access WHERE client_id = ?1",
        // The business itself.
        "DELETE FROM bank_accounts WHERE client_id = ?1",
        "DELETE FROM client_years WHERE client_id = ?1",
        "DELETE FROM accounts WHERE client_id = ?1",
        "DELETE FROM businesses WHERE client_id = ?1",
        "DELETE FROM clients WHERE id = ?1",
    ];
    for sql in STEPS {
        sqlx::query(*sql).bind(client_id).execute(&mut *conn).await?;
    }
    Ok(Deleted { statements, lines })
}

/// What [`redact_log`] redacted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Redacted {
    pub rows: i64,
    pub first_seq: Option<i64>,
    pub last_seq: Option<i64>,
}

/// The one exception to `command_log` being append-only (ADR 014, 6): the rows about a deleted
/// guest business keep their `seq`, `id`, `kind`, `user_id`, `client_id`, `client_year_id` and
/// `at`, but lose the payload, the result's details and the changes, which can hold descriptions
/// and amounts from a real person's bank file. `by_seq` is the command doing it. Only an unclaimed
/// guest's business, in the command that deletes it.
pub async fn redact_log(
    conn: &mut SqliteConnection,
    client_id: &str,
    by_seq: i64,
) -> Result<Redacted> {
    let (rows, first_seq, last_seq): (i64, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT COUNT(*), MIN(seq), MAX(seq) FROM command_log
         WHERE client_id = ? AND redacted_seq IS NULL",
    )
    .bind(client_id)
    .fetch_one(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE command_log
         SET payload = '{\"redacted\":\"guest\"}',
             result = json_object('seq', seq, 'entity_id', json_extract(result, '$.entity_id')),
             changes = NULL,
             via = NULL,
             redacted_seq = ?
         WHERE client_id = ? AND redacted_seq IS NULL",
    )
    .bind(by_seq)
    .bind(client_id)
    .execute(conn)
    .await?;
    Ok(Redacted {
        rows,
        first_seq,
        last_seq,
    })
}

/// How many of a user's login sessions are still live at `now`.
pub async fn live_sessions(
    conn: &mut SqliteConnection,
    user_id: &str,
    now: DateTime<Utc>,
) -> Result<i64> {
    let all: Vec<(DateTime<Utc>,)> =
        sqlx::query_as("SELECT expires_at FROM sessions WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(conn)
            .await?;
    Ok(all.iter().filter(|(at,)| *at > now).count() as i64)
}

/// Moves a session's expiry, for a guest's sliding seven days. Login state, so outside the
/// pipeline (CLAUDE.md hard rule 6).
pub async fn extend_session(
    conn: &mut SqliteConnection,
    token_hash: &str,
    expires_at: DateTime<Utc>,
) -> Result<()> {
    sqlx::query("UPDATE sessions SET expires_at = ? WHERE token_hash = ?")
        .bind(expires_at)
        .bind(token_hash)
        .execute(conn)
        .await?;
    Ok(())
}

/// When the last of a user's login sessions ends, if they have any.
pub async fn latest_session_expiry(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> Result<Option<DateTime<Utc>>> {
    let all: Vec<(DateTime<Utc>,)> =
        sqlx::query_as("SELECT expires_at FROM sessions WHERE user_id = ?")
            .bind(user_id)
            .fetch_all(conn)
            .await?;
    Ok(all.into_iter().map(|(at,)| at).max())
}

/// Renames a client: a guest naming their business as they save their work.
pub async fn rename_client(conn: &mut SqliteConnection, client_id: &str, name: &str) -> Result<()> {
    sqlx::query("UPDATE clients SET name = ? WHERE id = ?")
        .bind(name)
        .bind(client_id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Makes `to` the owner of a guest's business in place of the guest `from` (`adopt_guest_business`).
pub async fn move_owner(
    conn: &mut SqliteConnection,
    client_id: &str,
    from: &str,
    to: &str,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "UPDATE client_access SET user_id = ?, granted_seq = ?
         WHERE client_id = ? AND user_id = ? AND access = 'owner'",
    )
    .bind(to)
    .bind(seq)
    .bind(client_id)
    .bind(from)
    .execute(conn)
    .await?;
    Ok(())
}

/// A guest whose trial has ended, or been moved into an account: the row stays, because
/// `command_log` refers to it, but holds nothing of theirs: username `expired:<id>`, no password,
/// inactive. `display_name` is what their earlier changes read under: "Expired guest", or the
/// name of the owner who moved the trial in.
pub async fn retire_guest(conn: &mut SqliteConnection, id: &str, display_name: &str) -> Result<()> {
    sqlx::query(
        "UPDATE users SET username = 'expired:' || id, display_name = ?, password_hash = '',
                          active = 0
         WHERE id = ? AND guest_since IS NOT NULL AND claimed_at IS NULL",
    )
    .bind(display_name)
    .bind(id)
    .execute(conn)
    .await?;
    Ok(())
}
