//! Save tax (M11): coding settings, rules, how each bank line is sorted, supply information
//! confirmations, duplicate answers and the owner's tax answers.

use acct_core::Money;
use acct_core::coding::{Coding, CodingSettings, Rule};
use acct_core::tax::income_tax::{IncomeYear, YearAnswers};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, enum_text, from_json, parse_enum, to_json};

pub async fn set_settings(
    conn: &mut SqliteConnection,
    client_id: &str,
    settings: &CodingSettings,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO coding_settings (client_id, settings, updated_seq) VALUES (?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE SET settings = excluded.settings,
             updated_seq = excluded.updated_seq",
    )
    .bind(client_id)
    .bind(to_json(settings))
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn settings(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Option<CodingSettings>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT settings FROM coding_settings WHERE client_id = ?")
            .bind(client_id)
            .fetch_optional(conn)
            .await?;
    row.map(|(s,)| from_json(&s)).transpose()
}

/// A rule and the business it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredRule {
    pub client_id: String,
    pub rule: Rule,
    pub created_seq: i64,
    pub removed_seq: Option<i64>,
}

#[derive(FromRow)]
struct RuleRow {
    id: String,
    client_id: String,
    description_contains: String,
    min_amount: Option<i64>,
    max_amount: Option<i64>,
    coding: String,
    created_seq: i64,
    removed_seq: Option<i64>,
}

impl TryFrom<RuleRow> for StoredRule {
    type Error = crate::StoreError;
    fn try_from(r: RuleRow) -> Result<StoredRule> {
        Ok(StoredRule {
            client_id: r.client_id,
            rule: Rule {
                id: r.id,
                description_contains: r.description_contains,
                min: r.min_amount.map(Money::from_cents),
                max: r.max_amount.map(Money::from_cents),
                coding: from_json(&r.coding)?,
            },
            created_seq: r.created_seq,
            removed_seq: r.removed_seq,
        })
    }
}

pub async fn insert_rule(
    conn: &mut SqliteConnection,
    client_id: &str,
    rule: &Rule,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO coding_rules
             (id, client_id, description_contains, min_amount, max_amount, coding, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&rule.id)
    .bind(client_id)
    .bind(&rule.description_contains)
    .bind(rule.min.map(Money::cents))
    .bind(rule.max.map(Money::cents))
    .bind(to_json(&rule.coding))
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get_rule(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredRule>> {
    let row: Option<RuleRow> = sqlx::query_as("SELECT * FROM coding_rules WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(StoredRule::try_from).transpose()
}

/// A business's rules that haven't been removed, oldest first.
pub async fn live_rules(conn: &mut SqliteConnection, client_id: &str) -> Result<Vec<Rule>> {
    let rows: Vec<RuleRow> = sqlx::query_as(
        "SELECT * FROM coding_rules WHERE client_id = ? AND removed_seq IS NULL
         ORDER BY created_seq, id",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter()
        .map(|r| StoredRule::try_from(r).map(|s| s.rule))
        .collect()
}

pub async fn remove_rule(conn: &mut SqliteConnection, id: &str, seq: i64) -> Result<()> {
    sqlx::query("UPDATE coding_rules SET removed_seq = ? WHERE id = ?")
        .bind(seq)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Where a bank line stands in Save tax.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineStateKind {
    /// Posted as imported: money in as income, money out as not yet sorted.
    Unsorted,
    Coded,
    /// The owner said it's a duplicate, so it posts nothing.
    Duplicate,
}

/// How a bank line is sorted now. A line with no stored state is unsorted, and its live journal
/// is the one it was imported with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineState {
    pub bank_line_id: String,
    pub state: LineStateKind,
    /// Set when `state` is `Coded`.
    pub coding: Option<Coding>,
    /// The live journal, if the line posts one.
    pub journal_id: Option<String>,
    pub rule_id: Option<String>,
    /// The other line of a confirmed transfer, which shares `journal_id`.
    pub pair_line_id: Option<String>,
    /// The income year an income tax payment was for.
    pub ird_income_year: Option<IncomeYear>,
    /// The asset an asset purchase added to the register.
    pub asset_id: Option<String>,
    pub updated_seq: i64,
}

#[derive(FromRow)]
struct LineStateRow {
    bank_line_id: String,
    state: String,
    coding: Option<String>,
    journal_id: Option<String>,
    rule_id: Option<String>,
    pair_line_id: Option<String>,
    ird_income_year: Option<i32>,
    asset_id: Option<String>,
    updated_seq: i64,
}

impl TryFrom<LineStateRow> for LineState {
    type Error = crate::StoreError;
    fn try_from(r: LineStateRow) -> Result<LineState> {
        Ok(LineState {
            bank_line_id: r.bank_line_id,
            state: parse_enum(&r.state)?,
            coding: r.coding.as_deref().map(from_json).transpose()?,
            journal_id: r.journal_id,
            rule_id: r.rule_id,
            pair_line_id: r.pair_line_id,
            ird_income_year: r.ird_income_year.map(IncomeYear),
            asset_id: r.asset_id,
            updated_seq: r.updated_seq,
        })
    }
}

pub async fn set_line_state(conn: &mut SqliteConnection, s: &LineState) -> Result<()> {
    sqlx::query(
        "INSERT INTO bank_line_states
             (bank_line_id, state, coding, journal_id, rule_id, pair_line_id, ird_income_year,
              asset_id, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bank_line_id) DO UPDATE SET
             state = excluded.state, coding = excluded.coding, journal_id = excluded.journal_id,
             rule_id = excluded.rule_id, pair_line_id = excluded.pair_line_id,
             ird_income_year = excluded.ird_income_year, asset_id = excluded.asset_id,
             updated_seq = excluded.updated_seq",
    )
    .bind(&s.bank_line_id)
    .bind(enum_text(&s.state))
    .bind(s.coding.as_ref().map(to_json))
    .bind(&s.journal_id)
    .bind(&s.rule_id)
    .bind(&s.pair_line_id)
    .bind(s.ird_income_year.map(|y| y.0))
    .bind(&s.asset_id)
    .bind(s.updated_seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// The stored state of every line of a business that has one.
pub async fn line_states(conn: &mut SqliteConnection, client_id: &str) -> Result<Vec<LineState>> {
    let rows: Vec<LineStateRow> = sqlx::query_as(
        "SELECT s.* FROM bank_line_states s
         JOIN bank_lines l ON l.id = s.bank_line_id
         JOIN bank_accounts a ON a.id = l.bank_account_id
         WHERE a.client_id = ?",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(LineState::try_from).collect()
}

pub async fn line_state(
    conn: &mut SqliteConnection,
    bank_line_id: &str,
) -> Result<Option<LineState>> {
    let row: Option<LineStateRow> =
        sqlx::query_as("SELECT * FROM bank_line_states WHERE bank_line_id = ?")
            .bind(bank_line_id)
            .fetch_optional(conn)
            .await?;
    row.map(LineState::try_from).transpose()
}

pub async fn confirm_supply_info(
    conn: &mut SqliteConnection,
    bank_line_id: &str,
    on: NaiveDate,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO supply_info_confirmations (bank_line_id, confirmed_on, confirmed_seq)
         VALUES (?, ?, ?) ON CONFLICT (bank_line_id) DO NOTHING",
    )
    .bind(bank_line_id)
    .bind(on)
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// (bank line id, date confirmed) for every confirmation of a business.
pub async fn supply_info(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<(String, NaiveDate)>> {
    Ok(sqlx::query_as(
        "SELECT c.bank_line_id, c.confirmed_on FROM supply_info_confirmations c
         JOIN bank_lines l ON l.id = c.bank_line_id
         JOIN bank_accounts a ON a.id = l.bank_account_id
         WHERE a.client_id = ?",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?)
}

pub async fn answer_duplicate(
    conn: &mut SqliteConnection,
    bank_line_id: &str,
    is_duplicate: bool,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO duplicate_answers (bank_line_id, is_duplicate, answered_seq) VALUES (?, ?, ?)
         ON CONFLICT (bank_line_id) DO UPDATE SET is_duplicate = excluded.is_duplicate,
             answered_seq = excluded.answered_seq",
    )
    .bind(bank_line_id)
    .bind(is_duplicate)
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// (bank line id, is a duplicate) for every answered line of a business.
pub async fn duplicate_answers(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<(String, bool)>> {
    Ok(sqlx::query_as(
        "SELECT d.bank_line_id, d.is_duplicate FROM duplicate_answers d
         JOIN bank_lines l ON l.id = d.bank_line_id
         JOIN bank_accounts a ON a.id = l.bank_account_id
         WHERE a.client_id = ?",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?)
}

pub async fn set_answers(
    conn: &mut SqliteConnection,
    client_id: &str,
    year: IncomeYear,
    answers: &YearAnswers,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO tax_answers (client_id, income_year, answers, updated_seq) VALUES (?, ?, ?, ?)
         ON CONFLICT (client_id, income_year) DO UPDATE SET answers = excluded.answers,
             updated_seq = excluded.updated_seq",
    )
    .bind(client_id)
    .bind(year.0)
    .bind(to_json(answers))
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// The owner's answers for each income year they've answered something for, by year.
pub async fn answers(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<(IncomeYear, YearAnswers)>> {
    let rows: Vec<(i32, String)> = sqlx::query_as(
        "SELECT income_year, answers FROM tax_answers WHERE client_id = ? ORDER BY income_year",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter()
        .map(|(y, a)| Ok((IncomeYear(y), from_json(&a)?)))
        .collect()
}
