//! M15's analysis reads: the GL listing and expenses by category. Accountants see account codes in
//! both; business owners never do, so their copies leave the codes out.

use std::collections::BTreeMap;

use acct_core::analysis::{AnalysisInput, Movement, expense_analysis};
use acct_core::gl::{GlJournal, gl_listing};
use acct_core::{AccountCode, Chart, Comparatives, Money};
use acct_store::journals::{self, JournalKind};
use acct_store::templates;
use acct_store::users::Role;
use acct_store::years::YearStatus;
use axum::Json;
use axum::extract::{Path, State};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::CommandError;
use crate::ledger;

type ApiResult<T> = Result<Json<T>, CommandError>;

/// `GET /api/years/{id}/gl`: every account with a balance brought forward or a line posted in the
/// year, in code order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GlListing {
    pub accounts: Vec<GlAccountView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GlAccountView {
    /// `None` for business owners, who never see account codes.
    pub code: Option<AccountCode>,
    pub name: String,
    pub opening: Money,
    pub closing: Money,
    /// By date, then posting order.
    pub entries: Vec<GlEntryView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GlEntryView {
    pub journal_id: String,
    pub kind: JournalKind,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub narration: String,
    /// Debit positive, credit negative.
    pub amount: Money,
    /// The balance after this line. The same whether matched reversals are shown or not.
    pub balance: Money,
    /// A journal and its reversal, both posted: hidden unless asked for.
    pub matched_reversal: bool,
}

/// `GET /api/years/{id}/analysis`: expenses by report line, this year against last.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExpenseAnalysisView {
    /// Where last year's figures came from, as on the statements.
    pub comparatives: Comparatives,
    pub categories: Vec<ExpenseCategoryView>,
    pub total: Movement,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ExpenseCategoryView {
    /// The report line's key, as in the ReportDoc.
    pub line: String,
    pub label: String,
    pub movement: Movement,
    pub accounts: Vec<AnalysisAccountView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AnalysisAccountView {
    /// `None` for business owners.
    pub code: Option<AccountCode>,
    pub name: String,
    pub movement: Movement,
}

fn shows_codes(user: &CurrentUser) -> bool {
    user.0.role != Role::BusinessOwner
}

fn name(chart: &Chart, code: &AccountCode) -> String {
    chart
        .get(code)
        .map_or_else(|| code.to_string(), |a| a.name.clone())
}

/// `GET /api/years/{id}/gl`
pub async fn get_gl(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<GlListing> {
    let mut conn = state.store.reader().await?;
    let (_, chart, balances) = ledger::balances_to(&mut conn, &id).await?;
    let this = balances.last().expect("the year itself");
    let stored = journals::for_year(&mut conn, &id).await?;
    let index: BTreeMap<&str, usize> = stored
        .iter()
        .enumerate()
        .map(|(i, j)| (j.id.as_str(), i))
        .collect();
    let input: Vec<GlJournal<'_>> = stored
        .iter()
        .map(|j| GlJournal {
            journal: &j.journal,
            reverses: j
                .reverses_journal_id
                .as_deref()
                .and_then(|r| index.get(r).copied()),
        })
        .collect();
    let codes = shows_codes(&user);
    let accounts = gl_listing(&this.opening, &input)
        .into_iter()
        .map(|a| GlAccountView {
            name: name(&chart, &a.code),
            code: codes.then(|| a.code.clone()),
            opening: a.opening,
            closing: a.closing,
            entries: a
                .entries
                .into_iter()
                .map(|e| GlEntryView {
                    journal_id: stored[e.journal].id.clone(),
                    kind: stored[e.journal].kind,
                    date: e.date,
                    narration: e.narration,
                    amount: e.amount,
                    balance: e.balance,
                    matched_reversal: e.matched_reversal,
                })
                .collect(),
        })
        .collect();
    Ok(Json(GlListing { accounts }))
}

/// `GET /api/years/{id}/analysis`
pub async fn get_analysis(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<ExpenseAnalysisView> {
    let mut conn = state.store.reader().await?;
    let (_, chart, balances) = ledger::balances_to(&mut conn, &id).await?;
    let (current, prior) = match balances.as_slice() {
        [.., prior, current] => (current, Some(prior)),
        [current] => (current, None),
        [] => unreachable!("the year itself"),
    };
    let year = &current.year;
    let template = templates::template_version(&mut conn, &year.template_version_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template version", &year.template_version_id))?;
    let mapping = templates::mapping_version(&mut conn, &year.mapping_version_id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping version", &year.mapping_version_id))?;
    // Until finalisation writes snapshots, last year's figures are its live balances, as on the
    // statements (`ledger::report`).
    let analysis = expense_analysis(&AnalysisInput {
        template: &template.body,
        mapping: &mapping.body,
        chart: &chart,
        current: &current.closing,
        prior: prior.map(|p| &p.closing),
    })
    .map_err(|errors| {
        let details: Vec<serde_json::Value> = errors
            .iter()
            .map(|e| serde_json::to_value(e).expect("serialises"))
            .collect();
        CommandError::invalid_with(
            "analysis_failed",
            "The analysis can't be built until every expense account is mapped to a report line.",
            details,
        )
    })?;
    let comparatives = match prior {
        None => Comparatives::None,
        Some(p) if p.year.status == YearStatus::Finalised => Comparatives::Finalised,
        Some(_) => Comparatives::Unfinalised,
    };
    let codes = shows_codes(&user);
    Ok(Json(ExpenseAnalysisView {
        comparatives,
        categories: analysis
            .categories
            .into_iter()
            .map(|c| ExpenseCategoryView {
                line: c.line.to_string(),
                label: c.label,
                movement: c.movement,
                accounts: c
                    .accounts
                    .into_iter()
                    .map(|(code, movement)| AnalysisAccountView {
                        name: name(&chart, &code),
                        code: codes.then_some(code),
                        movement,
                    })
                    .collect(),
            })
            .collect(),
        total: analysis.total,
    }))
}
