//! TB import: the imported trial balance less the computed opening balances, posted as one
//! system journal (CLAUDE.md, TB import).
//!
//! Re-importing reverses the current TB-import journal and posts the new one, inside one
//! command, so every other journal (the practice's adjustments) survives. Re-importing an
//! identical TB posts nothing.

use std::collections::BTreeMap;

use acct_core::{AccountCode, JournalLine, Money, TbLine};
use acct_import::tb::{TbCsvError, TbRow};
use acct_store::journals::{JournalKind, StoredJournal};
use acct_store::users::Role;
use acct_store::years::{BooksSource, YearStatus};
use acct_store::{SqliteConnection, journals};
use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::CommandError;
use crate::ledger;

pub const NARRATION: &str = "Trial balance import";

/// Something that stops the import.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum TbImportProblem {
    UnknownAccount {
        account: AccountCode,
    },
    InactiveAccount {
        account: AccountCode,
    },
    DuplicateAccount {
        account: AccountCode,
    },
    Unbalanced {
        difference: Money,
    },
    /// This year's books come from bank coding, and both would double-count.
    BooksFromBankCoding,
    YearFinalised,
}

/// The imported retained earnings differ from the figure rolled forward from last year. That
/// usually means last year's adjustments were never posted in the client's own books.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RetainedEarningsGap {
    pub account: AccountCode,
    pub imported: Money,
    pub rolled_forward: Money,
    /// `imported − rolled_forward`.
    pub difference: Money,
}

/// What importing a TB would do.
pub struct Plan {
    /// The TB-import journal's lines: imported balance less opening balance, per account, in
    /// code order, nil differences left out.
    pub lines: Vec<JournalLine>,
    /// The TB-import journal in force now, which the import would replace.
    pub current: Option<StoredJournal>,
    pub problems: Vec<TbImportProblem>,
    pub retained_earnings_gap: Option<RetainedEarningsGap>,
}

impl Plan {
    /// Whether importing would leave the books exactly as they are.
    pub fn unchanged(&self) -> bool {
        let current = self
            .current
            .as_ref()
            .map_or(&[][..], |j| &j.journal.lines[..]);
        as_map(current) == as_map(&self.lines)
    }
}

fn as_map(lines: &[JournalLine]) -> BTreeMap<&AccountCode, Money> {
    let mut m = BTreeMap::new();
    for l in lines {
        *m.entry(&l.account).or_insert(Money::ZERO) += l.amount;
    }
    m.retain(|_, v| !v.is_zero());
    m
}

pub async fn plan(
    conn: &mut SqliteConnection,
    client_year_id: &str,
    rows: &[TbLine],
) -> Result<Plan, CommandError> {
    let (client, chart, balances) = ledger::balances_to(conn, client_year_id).await?;
    let this = balances.last().expect("the year itself");
    let mut problems = Vec::new();
    if this.year.status == YearStatus::Finalised {
        problems.push(TbImportProblem::YearFinalised);
    }
    if this.year.books_source == Some(BooksSource::BankCoding) {
        problems.push(TbImportProblem::BooksFromBankCoding);
    }

    let mut imported: BTreeMap<AccountCode, Money> = BTreeMap::new();
    for row in rows {
        if imported.insert(row.account.clone(), row.balance).is_some() {
            problems.push(TbImportProblem::DuplicateAccount {
                account: row.account.clone(),
            });
        }
        // Accounts at nil don't need to be in the chart: exports often list every account.
        if row.balance.is_zero() {
            continue;
        }
        match chart.get(&row.account) {
            None => problems.push(TbImportProblem::UnknownAccount {
                account: row.account.clone(),
            }),
            Some(a) if !a.active => problems.push(TbImportProblem::InactiveAccount {
                account: row.account.clone(),
            }),
            Some(_) => {}
        }
    }
    let total: Money = rows.iter().map(|r| r.balance).sum();
    if !total.is_zero() {
        problems.push(TbImportProblem::Unbalanced { difference: total });
    }

    let mut diff: BTreeMap<AccountCode, Money> = imported.clone();
    for (code, opening) in this.opening.iter() {
        *diff.entry(code.clone()).or_insert(Money::ZERO) -= opening;
    }
    let lines = diff
        .into_iter()
        .filter(|(_, amount)| !amount.is_zero())
        .map(|(account, amount)| JournalLine { account, amount })
        .collect();

    // Only meaningful when there's a prior year to roll forward from.
    let retained_earnings_gap = (balances.len() > 1)
        .then(|| {
            let re = &client.retained_earnings;
            let imported = imported.get(re).copied().unwrap_or(Money::ZERO);
            let rolled_forward = this.opening.balance(re);
            (imported != rolled_forward).then(|| RetainedEarningsGap {
                account: re.clone(),
                imported,
                rolled_forward,
                difference: imported - rolled_forward,
            })
        })
        .flatten();

    let current = current_journal(conn, client_year_id).await?;
    Ok(Plan {
        lines,
        current,
        problems,
        retained_earnings_gap,
    })
}

/// The TB-import journal in force: the one that isn't a reversal and hasn't been reversed.
async fn current_journal(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<Option<StoredJournal>, CommandError> {
    let all = journals::for_year(conn, client_year_id).await?;
    let reversed: Vec<&str> = all
        .iter()
        .filter_map(|j| j.reverses_journal_id.as_deref())
        .collect();
    Ok(all
        .iter()
        .rfind(|j| {
            j.kind == JournalKind::TbImport
                && j.reverses_journal_id.is_none()
                && !reversed.contains(&j.id.as_str())
        })
        .cloned())
}

/// The response to `POST /api/years/{id}/tb-import/preview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TbImportPreview {
    /// The file's rows, to show for checking. Empty if the file couldn't be read.
    pub rows: Vec<TbRow>,
    /// Problems with the file itself. If there are any, nothing else is worked out.
    pub file_errors: Vec<TbCsvError>,
    /// Problems that stop the import.
    pub problems: Vec<TbImportProblem>,
    /// The journal the import would post.
    pub lines: Vec<JournalLine>,
    /// The TB-import journal this would replace, if there is one.
    pub replaces_journal_id: Option<String>,
    /// Importing would change nothing.
    pub unchanged: bool,
    pub retained_earnings_gap: Option<RetainedEarningsGap>,
}

/// `POST /api/years/{id}/tb-import/preview`, with the CSV as the body. Changes nothing: the
/// `import_tb` command does the import.
pub async fn preview(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    body: String,
) -> Result<Json<TbImportPreview>, CommandError> {
    if user.0.role == Role::Viewer {
        return Err(CommandError::Forbidden);
    }
    let rows = match acct_import::tb::parse(&body) {
        Ok(rows) => rows,
        Err(file_errors) => {
            return Ok(Json(TbImportPreview {
                rows: Vec::new(),
                file_errors,
                problems: Vec::new(),
                lines: Vec::new(),
                replaces_journal_id: None,
                unchanged: false,
                retained_earnings_gap: None,
            }));
        }
    };
    let lines: Vec<TbLine> = rows
        .iter()
        .map(|r| TbLine {
            account: r.code.clone(),
            balance: r.balance,
        })
        .collect();
    let mut conn = state.store.reader().await?;
    let plan = plan(&mut conn, &id, &lines).await?;
    Ok(Json(TbImportPreview {
        unchanged: plan.unchanged(),
        rows,
        file_errors: Vec::new(),
        problems: plan.problems,
        lines: plan.lines,
        replaces_journal_id: plan.current.map(|j| j.id),
        retained_earnings_gap: plan.retained_earnings_gap,
    }))
}
