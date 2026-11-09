//! The AI usage table (ADR 016): one row per ask, written directly as metering, and the counts the
//! daily limits and the budget cap read.
//!
//! Nothing here stores a prompt, a response, a description, a name or an address. A row is ids, a
//! time, counts, a model id and short enums. `kind`, `plan` and `outcome` are plain strings the
//! server's enums spell; the table's checks refuse any other value.

use std::collections::BTreeMap;

use chrono::{DateTime, Days, NaiveDate, NaiveTime, Utc};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, Store};

/// One ask, as stored. See migration 0016 for each column.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct UsageRow {
    pub id: String,
    pub at: DateTime<Utc>,
    /// `suggestion` or `explain`.
    pub kind: String,
    pub business_id: String,
    /// The real user; the overseer while viewing as someone.
    pub user_id: Option<String>,
    /// `guest`, `free`, `owner`, `practice` or `practice_plus`.
    pub plan: String,
    pub is_overseer: bool,
    /// The effective user while viewing as someone (M19).
    pub acting_as: Option<String>,
    /// The model id; `None` if no call was made.
    pub model: Option<String>,
    pub model_calls: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    /// Whole US micro-dollars; `None` when the model's prices are unknown.
    pub cost_micro_usd: Option<i64>,
    pub latency_ms: Option<i64>,
    /// `ok`, `declined`, `invalid`, `error`, `refused_limit` or `refused_budget`.
    pub outcome: String,
    // Suggestion runs only.
    pub lines_total: Option<i64>,
    pub by_rules: Option<i64>,
    pub by_history: Option<i64>,
    pub by_merchants: Option<i64>,
    pub lines_asked: Option<i64>,
    pub by_model: Option<i64>,
}

const INSERT: &str = "INSERT INTO ai_usage
    (id, at, kind, business_id, user_id, plan, is_overseer, acting_as, model, model_calls,
     input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micro_usd,
     latency_ms, outcome, lines_total, by_rules, by_history, by_merchants, lines_asked, by_model)
 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/// Writes one row on `conn`. It's one statement, so its own short transaction when no other is
/// open. Prefer [`insert`].
pub async fn insert_on(conn: &mut SqliteConnection, row: &UsageRow) -> Result<()> {
    sqlx::query(INSERT)
        .bind(&row.id)
        .bind(row.at)
        .bind(&row.kind)
        .bind(&row.business_id)
        .bind(&row.user_id)
        .bind(&row.plan)
        .bind(row.is_overseer)
        .bind(&row.acting_as)
        .bind(&row.model)
        .bind(row.model_calls)
        .bind(row.input_tokens)
        .bind(row.output_tokens)
        .bind(row.cache_read_tokens)
        .bind(row.cache_write_tokens)
        .bind(row.cost_micro_usd)
        .bind(row.latency_ms)
        .bind(&row.outcome)
        .bind(row.lines_total)
        .bind(row.by_rules)
        .bind(row.by_history)
        .bind(row.by_merchants)
        .bind(row.lines_asked)
        .bind(row.by_model)
        .execute(conn)
        .await?;
    Ok(())
}

/// Writes one row, after the ask's last model call, on the writer connection. It isn't a command:
/// usage isn't practice or client data, so nothing reaches `command_log` or the sync feed.
pub async fn insert(store: &Store, row: &UsageRow) -> Result<()> {
    let mut writer = store.writer().await;
    insert_on(&mut writer, row).await
}

/// The UTC day `day` as a half-open range of times.
fn day_range(day: NaiveDate) -> (DateTime<Utc>, DateTime<Utc>) {
    let start = day.and_time(NaiveTime::MIN).and_utc();
    let end = day
        .checked_add_days(Days::new(1))
        .unwrap_or(NaiveDate::MAX)
        .and_time(NaiveTime::MIN)
        .and_utc();
    (start, end)
}

// What counts against a limit: asks that weren't refused and weren't an overseer's. A suggestion
// run counts only if it sent something to the model, so a run the first three layers answered
// doesn't spend the allowance. Errors count, because the call was made. (A macro, because sqlx
// wants literal SQL.)
macro_rules! counted {
    ($head:literal) => {
        concat!(
            $head,
            " AND is_overseer = 0
               AND outcome NOT IN ('refused_limit', 'refused_budget')
               AND (kind <> 'suggestion' OR model IS NOT NULL)
               AND at >= ? AND at < ?"
        )
    };
}

fn to_count(n: i64) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// The asks of `kind` that count against the limit for `business_id` on the UTC day `day`.
pub async fn count_for_business(
    conn: &mut SqliteConnection,
    business_id: &str,
    kind: &str,
    day: NaiveDate,
) -> Result<u32> {
    let (from, to) = day_range(day);
    let n: i64 = sqlx::query_scalar(counted!(
        "SELECT COUNT(*) FROM ai_usage WHERE business_id = ? AND kind = ?"
    ))
    .bind(business_id)
    .bind(kind)
    .bind(from)
    .bind(to)
    .fetch_one(conn)
    .await?;
    Ok(to_count(n))
}

/// The asks of `kind` that count against the limit for the real user `user_id` on the UTC day
/// `day`.
pub async fn count_for_user(
    conn: &mut SqliteConnection,
    user_id: &str,
    kind: &str,
    day: NaiveDate,
) -> Result<u32> {
    let (from, to) = day_range(day);
    let n: i64 = sqlx::query_scalar(counted!(
        "SELECT COUNT(*) FROM ai_usage WHERE user_id = ? AND kind = ?"
    ))
    .bind(user_id)
    .bind(kind)
    .bind(from)
    .bind(to)
    .fetch_one(conn)
    .await?;
    Ok(to_count(n))
}

/// The asks of `kind` that count against the limit across every business on the UTC day `day`
/// (the global explanation cap).
pub async fn count_all(conn: &mut SqliteConnection, kind: &str, day: NaiveDate) -> Result<u32> {
    let (from, to) = day_range(day);
    let n: i64 = sqlx::query_scalar(counted!("SELECT COUNT(*) FROM ai_usage WHERE kind = ?"))
        .bind(kind)
        .bind(from)
        .bind(to)
        .fetch_one(conn)
        .await?;
    Ok(to_count(n))
}

/// What the UTC day `day` has cost so far, in micro-dollars, over every row: overseers' too,
/// because it's real money. Rows with unknown prices count as 0.
pub async fn cost_on(conn: &mut SqliteConnection, day: NaiveDate) -> Result<u64> {
    let (from, to) = day_range(day);
    let micro: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(cost_micro_usd), 0) FROM ai_usage WHERE at >= ? AND at < ?",
    )
    .bind(from)
    .bind(to)
    .fetch_one(conn)
    .await?;
    Ok(u64::try_from(micro).unwrap_or(0))
}

// ---------------------------------------------------------------------------------------------
// The overseer's reads (ADR 016, 7, 9 and 10). Nothing here reads a prompt or a description: the
// rows hold none, and the command log is read only for its kind, time, line counts and `via`.
// ---------------------------------------------------------------------------------------------

/// Every row at or after `from`, oldest first.
pub async fn rows_since(conn: &mut SqliteConnection, from: DateTime<Utc>) -> Result<Vec<UsageRow>> {
    Ok(
        sqlx::query_as("SELECT * FROM ai_usage WHERE at >= ? ORDER BY at, rowid")
            .bind(from)
            .fetch_all(conn)
            .await?,
    )
}

/// Whose asks an overseer is looking at.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subject<'a> {
    /// One business's asks, by anyone, overseers included.
    Business(&'a str),
    /// One person's asks: the real user, so an overseer's asks while viewing as someone are the
    /// overseer's.
    User(&'a str),
}

/// A subject's rows with `from <= at < to`, newest first, at most `limit`.
pub async fn rows_for(
    conn: &mut SqliteConnection,
    subject: Subject<'_>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    limit: i64,
) -> Result<Vec<UsageRow>> {
    let (sql, id) = match subject {
        Subject::Business(id) => (
            "SELECT * FROM ai_usage WHERE business_id = ? AND at >= ? AND at < ?
             ORDER BY at DESC, rowid DESC LIMIT ?",
            id,
        ),
        Subject::User(id) => (
            "SELECT * FROM ai_usage WHERE user_id = ? AND at >= ? AND at < ?
             ORDER BY at DESC, rowid DESC LIMIT ?",
            id,
        ),
    };
    Ok(sqlx::query_as(sql)
        .bind(id)
        .bind(from)
        .bind(to)
        .bind(limit)
        .fetch_all(conn)
        .await?)
}

/// The layer columns of one suggestion run, for the AI share by layer.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct LayerRow {
    pub at: DateTime<Utc>,
    pub lines_total: i64,
    pub by_rules: i64,
    pub by_history: i64,
    pub by_merchants: i64,
    pub by_model: i64,
}

/// The suggestion runs at or after `from`, oldest first. Overseers' runs are included, because they
/// pre-fill real cards, and so are refused ones, because the first three layers still ran.
pub async fn layer_rows_since(
    conn: &mut SqliteConnection,
    from: DateTime<Utc>,
) -> Result<Vec<LayerRow>> {
    Ok(sqlx::query_as(
        "SELECT at, COALESCE(lines_total, 0) AS lines_total, COALESCE(by_rules, 0) AS by_rules,
                COALESCE(by_history, 0) AS by_history, COALESCE(by_merchants, 0) AS by_merchants,
                COALESCE(by_model, 0) AS by_model
         FROM ai_usage
         WHERE kind = 'suggestion' AND lines_total IS NOT NULL AND at >= ?
         ORDER BY at, rowid",
    )
    .bind(from)
    .fetch_all(conn)
    .await?)
}

/// One bank-line coding command, for the AI share by week.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct CodingEvent {
    pub at: DateTime<Utc>,
    /// Lines coded: 1 for `code_bank_line`, the number of lines for `code_bank_lines`.
    pub codings: i64,
    /// Of those, the lines accepted from an AI pre-fill (`via.suggestion_ids`).
    pub via_suggestion: i64,
}

/// The `code_bank_line` and `code_bank_lines` commands from `since` on, oldest first.
///
/// Redacted rows (an expired trial's cleared payloads) and the commands of a live unsaved trial
/// aren't counted (ADR 016, 10). Only the line count and the `via` suggestion count are read out
/// of a payload, never a line's content.
pub async fn coding_events(
    conn: &mut SqliteConnection,
    since: DateTime<Utc>,
) -> Result<Vec<CodingEvent>> {
    // The SQL bound is a day early and only narrows the read; the exact cut is made in Rust, so
    // the stored time format can't matter (as `log::trial_events` does).
    let rows: Vec<CodingEvent> = sqlx::query_as(
        "SELECT l.at AS at,
                CASE l.kind WHEN 'code_bank_line' THEN 1
                            ELSE COALESCE(json_array_length(l.payload, '$.lines'), 0) END AS codings,
                CASE WHEN json_extract(l.via, '$.kind') = 'suggestion'
                     THEN COALESCE(json_array_length(l.via, '$.suggestion_ids'), 0)
                     ELSE 0 END AS via_suggestion
         FROM command_log l
         WHERE l.kind IN ('code_bank_line', 'code_bank_lines')
           AND l.redacted_seq IS NULL
           AND l.at >= ?
           AND (l.client_id IS NULL OR l.client_id NOT IN (
                SELECT b.client_id
                FROM businesses b
                JOIN client_access a ON a.client_id = b.client_id AND a.access = 'owner'
                JOIN users u ON u.id = a.user_id
                WHERE u.guest_since IS NOT NULL AND u.claimed_at IS NULL))
         ORDER BY l.seq",
    )
    .bind(since - chrono::Duration::days(1))
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().filter(|r| r.at >= since).collect())
}

#[derive(FromRow)]
struct NameRow {
    id: String,
    name: String,
}

async fn names_from(
    conn: &mut SqliteConnection,
    sql: &'static str,
    ids: &[String],
) -> Result<BTreeMap<String, String>> {
    if ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let json = serde_json::to_string(ids).expect("a list of strings is JSON");
    let rows: Vec<NameRow> = sqlx::query_as(sql).bind(json).fetch_all(conn).await?;
    Ok(rows.into_iter().map(|r| (r.id, r.name)).collect())
}

/// The names of these businesses, read live. A business that no longer exists (an expired trial)
/// has none.
pub async fn business_names(
    conn: &mut SqliteConnection,
    ids: &[String],
) -> Result<BTreeMap<String, String>> {
    names_from(
        conn,
        "SELECT id, name FROM clients WHERE id IN (SELECT value FROM json_each(?))",
        ids,
    )
    .await
}

/// The display names of these users, read live.
pub async fn user_names(
    conn: &mut SqliteConnection,
    ids: &[String],
) -> Result<BTreeMap<String, String>> {
    names_from(
        conn,
        "SELECT id, display_name AS name FROM users WHERE id IN (SELECT value FROM json_each(?))",
        ids,
    )
    .await
}
