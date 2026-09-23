//! `GET` query endpoints and the sync feed. Every one needs a login; any role may read.

use acct_core::{Account, AccountCode, JournalLine, ReportDoc, TbLine};
use acct_store::journals::JournalKind;
use acct_store::years::{BooksSource, StoredYear, YearStatus};
use acct_store::{clients, journals, log, years};
use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::CommandError;
use crate::ledger;

type ApiResult<T> = Result<Json<T>, CommandError>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClientSummary {
    pub id: String,
    pub name: String,
    pub entity_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClientDetail {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    pub retained_earnings: AccountCode,
    pub rounding_priority: Vec<AccountCode>,
    /// Earliest first.
    pub years: Vec<YearSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct YearSummary {
    pub id: String,
    pub client_id: String,
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    pub status: YearStatus,
    pub books_source: Option<BooksSource>,
}

impl From<&StoredYear> for YearSummary {
    fn from(y: &StoredYear) -> YearSummary {
        YearSummary {
            id: y.id.clone(),
            client_id: y.client_id.clone(),
            start: y.year.start(),
            end: y.year.end(),
            status: y.status,
            books_source: y.books_source,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct JournalView {
    pub id: String,
    pub kind: JournalKind,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub narration: String,
    pub lines: Vec<JournalLine>,
    pub reverses_journal_id: Option<String>,
    /// The journal that reverses this one, if any.
    pub reversed_by: Option<String>,
    pub posted_seq: i64,
}

/// A year's trial balance: opening balances (rolled forward, never posted) and closing
/// balances, by account code. Accounts with nil balances are left out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct YearTrialBalance {
    pub opening: Vec<TbLine>,
    pub closing: Vec<TbLine>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Change {
    pub seq: i64,
    pub kind: String,
    pub client_id: Option<String>,
    pub client_year_id: Option<String>,
    #[ts(type = "string")]
    pub at: DateTime<Utc>,
}

/// Changes after `after`, oldest first. If `changes` is full (`limit` long), ask again from
/// `last_seq`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SyncFeed {
    pub changes: Vec<Change>,
    /// The newest `seq` in `changes`, or `after` if there were none.
    pub last_seq: i64,
}

#[derive(Debug, Deserialize)]
pub struct SyncQuery {
    #[serde(default)]
    after: i64,
    limit: Option<i64>,
}

pub const SYNC_MAX: i64 = 500;

/// `GET /api/clients`
pub async fn list_clients(
    State(state): State<AppState>,
    _user: CurrentUser,
) -> ApiResult<Vec<ClientSummary>> {
    let mut conn = state.store.reader().await?;
    let all = clients::list(&mut conn).await?;
    Ok(Json(
        all.into_iter()
            .map(|c| ClientSummary {
                id: c.id,
                name: c.name,
                entity_type: c.entity_type,
            })
            .collect(),
    ))
}

/// `GET /api/clients/{id}`
pub async fn get_client(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<ClientDetail> {
    let mut conn = state.store.reader().await?;
    let c = clients::get(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", &id))?;
    let years = years::for_client(&mut conn, &id).await?;
    Ok(Json(ClientDetail {
        id: c.id,
        name: c.name,
        entity_type: c.entity_type,
        retained_earnings: c.retained_earnings,
        rounding_priority: c.rounding_priority,
        years: years.iter().map(YearSummary::from).collect(),
    }))
}

/// `GET /api/clients/{id}/chart`
pub async fn get_chart(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Vec<Account>> {
    let mut conn = state.store.reader().await?;
    clients::get(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", &id))?;
    let chart = clients::chart(&mut conn, &id).await?;
    Ok(Json(chart.accounts().to_vec()))
}

/// `GET /api/years/{id}`
pub async fn get_year(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<YearSummary> {
    let mut conn = state.store.reader().await?;
    let y = years::get(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", &id))?;
    Ok(Json(YearSummary::from(&y)))
}

/// `GET /api/years/{id}/journals`, in posting order.
pub async fn list_journals(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Vec<JournalView>> {
    let mut conn = state.store.reader().await?;
    years::get(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", &id))?;
    let all = journals::for_year(&mut conn, &id).await?;
    let reversed_by: std::collections::BTreeMap<&str, &str> = all
        .iter()
        .filter_map(|j| Some((j.reverses_journal_id.as_deref()?, j.id.as_str())))
        .collect();
    Ok(Json(
        all.iter()
            .map(|j| JournalView {
                id: j.id.clone(),
                kind: j.kind,
                date: j.journal.date,
                narration: j.journal.narration.clone(),
                lines: j.journal.lines.clone(),
                reverses_journal_id: j.reverses_journal_id.clone(),
                reversed_by: reversed_by.get(j.id.as_str()).map(|s| (*s).to_owned()),
                posted_seq: j.posted_seq,
            })
            .collect(),
    ))
}

/// `GET /api/years/{id}/tb`
pub async fn get_trial_balance(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<YearTrialBalance> {
    let mut conn = state.store.reader().await?;
    let (_, _, balances) = ledger::balances_to(&mut conn, &id).await?;
    let this = balances.last().expect("the year itself");
    let lines = |tb: &acct_core::TrialBalance| -> Vec<TbLine> {
        tb.iter()
            .filter(|(_, b)| !b.is_zero())
            .map(|(account, balance)| TbLine {
                account: account.clone(),
                balance,
            })
            .collect()
    };
    Ok(Json(YearTrialBalance {
        opening: lines(&this.opening),
        closing: lines(&this.closing),
    }))
}

/// `GET /api/years/{id}/report`: the year's ReportDoc.
pub async fn get_report(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<ReportDoc> {
    let mut conn = state.store.reader().await?;
    Ok(Json(ledger::report(&mut conn, &id).await?))
}

/// `GET /api/sync?after=<seq>&limit=<n>`: the change feed for live refresh.
pub async fn sync(
    State(state): State<AppState>,
    _user: CurrentUser,
    query: Result<Query<SyncQuery>, QueryRejection>,
) -> ApiResult<SyncFeed> {
    let Query(q) = query.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let limit = q.limit.unwrap_or(SYNC_MAX).clamp(1, SYNC_MAX);
    let mut conn = state.store.reader().await?;
    let entries = log::after(&mut conn, q.after, limit).await?;
    let last_seq = entries.last().map_or(q.after, |e| e.seq);
    Ok(Json(SyncFeed {
        changes: entries
            .into_iter()
            .map(|e| Change {
                seq: e.seq,
                kind: e.kind,
                client_id: e.client_id,
                client_year_id: e.client_year_id,
                at: e.at,
            })
            .collect(),
        last_seq,
    }))
}
