//! The owner's screen: "Tax to pay if submitted", its breakdown by return, and each bank
//! account's statements, gaps and reconciliation.
//!
//! This module loads the ledger totals; core's `tax::position` works out every amount
//! (`docs/domain.md`, "GST" and "Income tax for sole traders"). Nothing here is stored: it's
//! worked out afresh on each read.

use std::collections::{BTreeMap, BTreeSet};

use acct_core::bank::{LineFacts, looks_like_ird, transfer_pairs};
use acct_core::tax::gst::{GstPeriod, GstTotals, gst_period};
use acct_core::tax::income_tax::{IncomeTaxBasis, IncomeYear, StudentLoanBasis, YearAnswers};
use acct_core::tax::{self, position::TaxInputs};
use acct_core::{AccountType, Money};
use acct_store::bank::{self as bank_store, BankAccount};
use acct_store::journals::StoredJournal;
use acct_store::{SqliteConnection, clients, journals, years};
use chrono::{Days, NaiveDate};
use serde::Serialize;
use ts_rs::TS;

use crate::business;
use crate::error::CommandError;

/// Deposits over 12 months above which an unregistered owner may have to register for GST
/// (`docs/domain.md`, GST; **check**).
const GST_REGISTRATION_THRESHOLD: Money = Money::from_cents(6_000_000);

/// One GST return as it would be filed now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct GstReturnView {
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    /// The period hasn't ended yet, so the figure is "so far".
    pub so_far: bool,
    /// The first day it can be filed: the day after the period ends.
    #[ts(type = "string")]
    pub can_file_from: NaiveDate,
    /// Boxes 5 to 15, or `None` with `problem` if there's no GST rate for the period.
    pub boxes: Option<GstBoxes>,
    pub problem: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct GstBoxes {
    pub box5: Money,
    pub box6: Money,
    pub box7: Money,
    pub box8: Money,
    pub box9: Money,
    pub box10: Money,
    pub box11: Money,
    pub box12: Money,
    pub box13: Money,
    pub box14: Money,
    pub box15: Money,
}

/// One income year's income tax and student loan as they'd stand if filed now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct IncomeYearView {
    /// The year it ends in: 2026 is 1 April 2025 to 31 March 2026.
    pub income_year: i32,
    pub so_far: bool,
    #[ts(type = "string")]
    pub can_file_from: NaiveDate,
    pub taxable_income: Money,
    /// `top_rate_flat` until the owner says the business is their only income.
    #[ts(type = "\"top_rate_flat\" | \"bands\" | null")]
    pub basis: Option<IncomeTaxBasis>,
    pub income_tax: Option<Money>,
    #[ts(type = "\"none\" | \"all_income\" | \"over_threshold\" | null")]
    pub student_loan_basis: Option<StudentLoanBasis>,
    pub student_loan: Option<Money>,
    pub problem: Option<String>,
}

/// A notice shown with the figure.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct TaxNotice {
    /// `incomplete`, `may_need_to_register` or `six_monthly_limit`.
    pub code: String,
    pub message: String,
}

/// "Tax to pay if submitted", and what it's made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct TaxPosition {
    pub total: Money,
    pub gst: Vec<GstReturnView>,
    pub income: Vec<IncomeYearView>,
    pub notices: Vec<TaxNotice>,
}

/// Sums the amounts in `journals` on the given accounts, over dates in `[from, to]`.
fn movement(
    journals: &[StoredJournal],
    accounts: &BTreeSet<acct_core::AccountCode>,
    from: NaiveDate,
    to: NaiveDate,
) -> Money {
    journals
        .iter()
        .filter(|j| from <= j.journal.date && j.journal.date <= to)
        .flat_map(|j| &j.journal.lines)
        .filter(|l| accounts.contains(&l.account))
        .map(|l| l.amount)
        .sum()
}

/// The ledger totals core's tax engine works from: each GST period with an uploaded line, and
/// each income year with one. The answers are left empty for the caller to fill.
pub async fn tax_inputs(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<TaxInputs, CommandError> {
    let business = business::business(conn, client_id).await?;
    let chart = clients::chart(conn, client_id).await?;
    let of_type = |t: AccountType| -> BTreeSet<_> {
        chart
            .accounts()
            .iter()
            .filter(|a| a.account_type == t)
            .map(|a| a.code.clone())
            .collect()
    };
    let income_accounts = of_type(AccountType::Income);
    let mut pl_accounts = income_accounts.clone();
    pl_accounts.extend(of_type(AccountType::Expense));
    let mut income_and_gst = income_accounts.clone();
    income_and_gst.insert(business.holding.gst.clone());

    let year_list = years::for_client(conn, client_id).await?;
    let mut all: Vec<StoredJournal> = Vec::new();
    for y in &year_list {
        all.extend(journals::for_year(conn, &y.id).await?);
    }
    let lines = bank_store::bank_lines(conn, client_id).await?;
    let mut inputs = TaxInputs::default();

    // GST: every period from registration that has an uploaded line.
    if let Some(gst) = business.gst {
        let periods: BTreeSet<GstPeriod> = lines
            .iter()
            .filter_map(|l| gst_period(l.date, gst.frequency, gst.registered_from))
            .collect();
        for period in periods {
            // GST-inclusive sales: what was credited to income and GST in the period. In M10
            // nothing is claimed, so purchases are nil.
            let sales = -movement(&all, &income_and_gst, period.start, period.end);
            let totals = GstTotals {
                sales,
                ..GstTotals::default()
            };
            inputs.gst.insert(period, totals);
        }
    }

    // Income tax: each client-year with lines is one income year (31 March balance date).
    for y in &year_list {
        if lines.iter().any(|l| y.year.contains(l.date)) {
            let taxable = -movement(&all, &pl_accounts, y.year.start(), y.year.end());
            inputs
                .taxable_income
                .insert(IncomeYear::containing(y.year.end()), taxable);
        }
    }
    Ok(inputs)
}

/// "Tax to pay if submitted" with nothing answered yet.
pub async fn position(
    conn: &mut SqliteConnection,
    client_id: &str,
    today: NaiveDate,
) -> Result<TaxPosition, CommandError> {
    position_with(conn, client_id, today, &BTreeMap::new()).await
}

/// "Tax to pay if submitted" given the owner's answers, worked out by core.
pub async fn position_with(
    conn: &mut SqliteConnection,
    client_id: &str,
    today: NaiveDate,
    answers: &BTreeMap<IncomeYear, YearAnswers>,
) -> Result<TaxPosition, CommandError> {
    let business = business::business(conn, client_id).await?;
    let inputs = TaxInputs {
        answers: answers.clone(),
        ..tax_inputs(conn, client_id).await?
    };
    let computed = tax::position::position(&inputs);
    let mut notices = Vec::new();

    let gst = computed
        .gst
        .iter()
        .map(|g| {
            let (boxes, problem) = match &g.result {
                Ok(r) => (
                    Some(GstBoxes {
                        box5: r.box5,
                        box6: r.box6,
                        box7: r.box7,
                        box8: r.box8,
                        box9: r.box9,
                        box10: r.box10,
                        box11: r.box11,
                        box12: r.box12,
                        box13: r.box13,
                        box14: r.box14,
                        box15: r.box15,
                    }),
                    None,
                ),
                Err(e) => (None, Some(e.to_string())),
            };
            GstReturnView {
                start: g.period.start,
                end: g.period.end,
                so_far: g.period.end >= today,
                can_file_from: g.period.end + Days::new(1),
                boxes,
                problem,
            }
        })
        .collect();

    if business.gst.is_none() {
        // An unregistered owner sees no GST, but is told if deposits suggest they should be.
        let lines = bank_store::bank_lines(conn, client_id).await?;
        let deposits: Vec<_> = lines.iter().filter(|l| l.amount > Money::ZERO).collect();
        let over = deposits.iter().any(|first| {
            let until = first.date + Days::new(364);
            let sum: Money = deposits
                .iter()
                .filter(|l| first.date <= l.date && l.date <= until)
                .map(|l| l.amount)
                .sum();
            sum > GST_REGISTRATION_THRESHOLD
        });
        if over {
            notices.push(TaxNotice {
                code: "may_need_to_register".into(),
                message: "Your deposits in a 12-month stretch are over $60,000, so you may have \
                          to register for GST."
                    .into(),
            });
        }
    }

    let income = computed
        .income
        .iter()
        .map(|i| {
            let end = i.year.end();
            let figure = i.result.as_ref().ok();
            IncomeYearView {
                income_year: i.year.0,
                so_far: end >= today,
                can_file_from: end + Days::new(1),
                taxable_income: i.taxable_income,
                basis: figure.map(|f| f.basis),
                income_tax: figure.map(|f| f.income_tax),
                student_loan_basis: figure.map(|f| f.student_loan_basis),
                student_loan: figure.map(|f| f.student_loan),
                problem: i.result.as_ref().err().map(ToString::to_string),
            }
        })
        .collect();

    // Gaps without an amount leave the figure incomplete.
    let year_list = years::for_client(conn, client_id).await?;
    let start = year_list
        .first()
        .map_or(business.start_date, |y| y.year.start());
    for account in bank_store::bank_accounts(conn, client_id).await? {
        let unknown = business::account_gaps(conn, &account, start)
            .await?
            .into_iter()
            .filter(|g| g.change.is_none())
            .count();
        if unknown > 0 {
            notices.push(TaxNotice {
                code: "incomplete".into(),
                message: format!(
                    "{} has {unknown} stretch(es) with no statement and no balance to go on, so \
                     this figure is missing whatever happened then.",
                    account.name
                ),
            });
        }
    }

    Ok(TaxPosition {
        total: computed.total,
        gst,
        income,
        notices,
    })
}

/// A statement as uploaded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct StatementView {
    pub file_name: String,
    pub parser: String,
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    pub opening_balance: Option<Money>,
    pub closing_balance: Option<Money>,
    pub lines_in_file: i64,
    pub lines_added: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct GapView {
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    /// The change in balance posted for the gap, or `None` if it's only flagged.
    pub change: Option<Money>,
}

/// The ledger's bank balance against the latest statement's closing balance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Reconciliation {
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub ledger: Money,
    /// `None` when the statements give no closing balance, so it can't be checked.
    pub statement: Option<Money>,
    pub agrees: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct BankAccountView {
    pub id: String,
    pub code: String,
    pub name: String,
    pub account_number: Option<String>,
    #[ts(type = "string | null")]
    pub opening_date: Option<NaiveDate>,
    pub opening_balance: Option<Money>,
    /// The first statement doesn't reach back to the start date, so the owner is asked for the
    /// balance on that date.
    pub needs_opening_balance: bool,
    pub statements: Vec<StatementView>,
    pub gaps: Vec<GapView>,
    pub reconciliation: Option<Reconciliation>,
}

/// A line detected for Save tax, not applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct DetectedLine {
    pub bank_account_id: String,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub amount: Money,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct BusinessView {
    pub client_id: String,
    pub name: String,
    #[ts(type = "string")]
    pub start_date: NaiveDate,
    #[ts(type = "string | null")]
    pub gst_registered_from: Option<NaiveDate>,
    pub gst_frequency: Option<String>,
    pub bank_accounts: Vec<BankAccountView>,
    /// Likely transfers between the owner's accounts: (money out, money in).
    pub transfers: Vec<(DetectedLine, DetectedLine)>,
    /// Likely payments to or from IRD.
    pub ird_payments: Vec<DetectedLine>,
    pub possible_duplicates: Vec<DetectedLine>,
}

/// The balance of `account` in the ledger at the end of `date`.
fn ledger_balance(journals: &[StoredJournal], account: &BankAccount, date: NaiveDate) -> Money {
    journals
        .iter()
        .filter(|j| j.journal.date <= date)
        .flat_map(|j| &j.journal.lines)
        .filter(|l| l.account == account.code)
        .map(|l| l.amount)
        .sum()
}

pub async fn business_view(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<BusinessView, CommandError> {
    let business = business::business(conn, client_id).await?;
    let client = clients::get(conn, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", client_id))?;
    let year_list = years::for_client(conn, client_id).await?;
    let mut all: Vec<StoredJournal> = Vec::new();
    for y in &year_list {
        all.extend(journals::for_year(conn, &y.id).await?);
    }
    let start = year_list
        .first()
        .map_or(business.start_date, |y| y.year.start());

    let mut accounts = Vec::new();
    for account in bank_store::bank_accounts(conn, client_id).await? {
        let statements = bank_store::statements(conn, &account.id).await?;
        let gaps = business::account_gaps(conn, &account, start).await?;
        let latest = statements
            .iter()
            .max_by_key(|s| (s.end_date, s.imported_seq));
        let reconciliation = latest.map(|s| {
            let ledger = ledger_balance(&all, &account, s.end_date);
            let statement = s.closing_balance.map(Money::from_cents);
            Reconciliation {
                date: s.end_date,
                ledger,
                statement,
                agrees: statement.map(|m| m == ledger),
            }
        });
        let reaches_start = statements.iter().any(|s| s.start_date <= start);
        accounts.push(BankAccountView {
            id: account.id.clone(),
            code: account.code.to_string(),
            name: account.name.clone(),
            account_number: account.account_number.clone(),
            opening_date: account.opening.map(|(d, _)| d),
            opening_balance: account.opening.map(|(_, m)| m),
            needs_opening_balance: account.opening.is_none()
                && !statements.is_empty()
                && !reaches_start,
            statements: statements
                .iter()
                .map(|s| StatementView {
                    file_name: s.file_name.clone(),
                    parser: s.parser.clone(),
                    start: s.start_date,
                    end: s.end_date,
                    opening_balance: s.opening_balance.map(Money::from_cents),
                    closing_balance: s.closing_balance.map(Money::from_cents),
                    lines_in_file: s.lines_in_file,
                    lines_added: s.lines_added,
                })
                .collect(),
            gaps: gaps
                .iter()
                .map(|g| GapView {
                    start: g.start,
                    end: g.end,
                    change: g.change,
                })
                .collect(),
            reconciliation,
        });
    }

    let lines = bank_store::bank_lines(conn, client_id).await?;
    let detected = |l: &bank_store::BankLine| DetectedLine {
        bank_account_id: l.bank_account_id.clone(),
        date: l.date,
        amount: l.amount,
        description: l.description.clone(),
    };
    let facts: Vec<LineFacts<'_>> = lines
        .iter()
        .map(|l| LineFacts {
            account: &l.bank_account_id,
            date: l.date,
            amount: l.amount,
            description: &l.description,
        })
        .collect();
    let transfers = transfer_pairs(&facts)
        .into_iter()
        .map(|(o, i)| (detected(&lines[o]), detected(&lines[i])))
        .collect();
    let ird_payments = lines
        .iter()
        .filter(|l| looks_like_ird(&l.description))
        .map(detected)
        .collect();
    let possible_duplicates = lines
        .iter()
        .filter(|l| l.possible_duplicate)
        .map(detected)
        .collect();

    Ok(BusinessView {
        client_id: client_id.to_owned(),
        name: client.name,
        start_date: business.start_date,
        gst_registered_from: business.gst.map(|g| g.registered_from),
        gst_frequency: business.gst.map(|g| {
            serde_json::to_value(g.frequency)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default()
        }),
        bank_accounts: accounts,
        transfers,
        ird_payments,
        possible_duplicates,
    })
}

/// `GET /api/businesses/{id}`: a business's settings, bank accounts and detected lines.
pub async fn get_business(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    _user: crate::auth::CurrentUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<axum::Json<BusinessView>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(axum::Json(business_view(&mut conn, &id).await?))
}

/// `GET /api/businesses/{id}/tax`: "Tax to pay if submitted", by return.
pub async fn get_tax(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    _user: crate::auth::CurrentUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<axum::Json<TaxPosition>, CommandError> {
    let mut conn = state.store.reader().await?;
    let today = chrono::Utc::now().date_naive();
    Ok(axum::Json(position(&mut conn, &id, today).await?))
}
