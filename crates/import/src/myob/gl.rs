//! The General Ledger [Detail] report, exported as CSV or TSV (AccountRight) or saved as CSV
//! from its Excel export (MYOB Business).
//!
//! Title rows come first; their first and last dates are the period. The report is grouped by
//! account: a row naming the account (in `Account No.` and `Account Name`, or a combined
//! `1-1110 Name` account cell) carries its beginning balance, then one row per posting with
//! its `ID No.`, `Src`, `Date`, `Memo`, `Debit` and `Credit`, then the account's totals.
//! A file reformatted to repeat the account on every posting row reads the same way.
//!
//! The beginning balance is taken from `Debit`/`Credit` when either is filled, otherwise from
//! the balance column, which shows it positive on the account's normal side (a credit, for
//! liabilities, equity and income). When the export has the running `Ending Balance`, every
//! posting row is checked against it, which also catches a file that signs balances another
//! way.

use std::collections::BTreeMap;

use acct_core::Money;

use super::fields::{self, bad_row};
use super::{cell, Table};
use crate::history::{HistoryError, HistoryGl, HistoryGlLine, HistoryTbRow};

struct Account {
    name: String,
    /// The running balance as the report shows it, once known.
    shown: Option<Money>,
    credit_normal: Option<bool>,
}

pub(super) fn parse(table: &Table) -> Result<HistoryGl, Vec<HistoryError>> {
    let code_col = table.col(&["account no.", "account no", "account number"]);
    let account_col = table.col(&["account"]);
    let name_col = table.col(&["account name"]);
    let id_col = table.col(&["id no.", "id no", "id #", "reference"]);
    let src_col = table.col(&["src", "source"]);
    let date_col = table.col(&["date"]);
    let memo_col = table.col(&["memo", "description"]);
    let card_col = table.col(&["name", "card name", "contact"]);
    let debit_col = table.col(&["debit"]);
    let credit_col = table.col(&["credit"]);
    let balance_col = table.col(&["ending balance", "balance", "running balance"]);

    let mut accounts: BTreeMap<String, Account> = BTreeMap::new();
    let mut current: Option<String> = None;
    let mut openings = Vec::new();
    let mut lines = Vec::new();
    let mut errors = Vec::new();

    for (row, cells) in &table.rows {
        let row = *row;
        let date_raw = cell(cells, date_col);
        let named = match named_account(cells, code_col, account_col, name_col) {
            Ok(named) => named,
            Err(e) => {
                errors.push(bad_row(row, "Account No.", e.0, e.1));
                continue;
            }
        };
        let (debit_raw, credit_raw) = (cell(cells, debit_col), cell(cells, credit_col));
        let balance_raw = cell(cells, balance_col);
        let mut amount = |raw: &str, column: &str, errors: &mut Vec<HistoryError>| {
            fields::amount(raw).unwrap_or_else(|reason| {
                errors.push(bad_row(row, column, raw, reason));
                Money::ZERO
            })
        };

        if date_raw.is_empty() {
            let memo = cell(cells, memo_col).to_lowercase();
            let is_opening_row = memo.contains("beginning balance") || memo.contains("opening balance");
            let code = match (named, &current) {
                // A heading: the account starts here.
                (Some((code, name)), _) => {
                    if accounts.contains_key(&code) && current.as_deref() != Some(code.as_str()) {
                        errors.push(bad_row(
                            row,
                            "Account No.",
                            &code,
                            "the account appears twice in the report",
                        ));
                        continue;
                    }
                    accounts.entry(code.clone()).or_insert(Account {
                        name,
                        shown: None,
                        credit_normal: fields::type_from_code(&code).map(fields::credit_normal),
                    });
                    current = Some(code.clone());
                    code
                }
                // A separate `Beginning Balance` row under the heading.
                (None, Some(code)) if is_opening_row => code.clone(),
                // Totals, blank separators and anything else without a date.
                _ => continue,
            };
            let account = accounts.get_mut(&code).expect("inserted above");
            if account.shown.is_some() {
                continue;
            }
            let debit = amount(debit_raw, "Debit", &mut errors);
            let credit = amount(credit_raw, "Credit", &mut errors);
            let opening = if !debit_raw.is_empty() || !credit_raw.is_empty() {
                debit - credit
            } else if balance_raw.is_empty() {
                continue;
            } else {
                let shown = amount(balance_raw, "Ending Balance", &mut errors);
                match account.credit_normal {
                    Some(true) => -shown,
                    Some(false) => shown,
                    None if shown.is_zero() => shown,
                    None => {
                        errors.push(bad_row(
                            row,
                            "Ending Balance",
                            balance_raw,
                            "can't tell whether the balance is a debit or a credit: the account \
                             number doesn't start with MYOB's classification digit",
                        ));
                        continue;
                    }
                }
            };
            account.shown = Some(match account.credit_normal {
                Some(true) => -opening,
                _ => opening,
            });
            if !opening.is_zero() {
                openings.push(HistoryTbRow {
                    row,
                    code,
                    name: account.name.clone(),
                    balance: opening,
                });
            }
            continue;
        }

        let Some(date) = fields::date(date_raw) else {
            errors.push(bad_row(row, "Date", date_raw, "not a day-first date such as 31/03/2025"));
            continue;
        };
        let code = match named {
            Some((code, name)) => {
                accounts.entry(code.clone()).or_insert(Account {
                    name,
                    shown: None,
                    credit_normal: fields::type_from_code(&code).map(fields::credit_normal),
                });
                current = Some(code.clone());
                code
            }
            None => match &current {
                Some(code) => code.clone(),
                None => {
                    errors.push(bad_row(
                        row,
                        "Account No.",
                        "",
                        "a posting comes before any account heading",
                    ));
                    continue;
                }
            },
        };
        let debit = amount(debit_raw, "Debit", &mut errors);
        let credit = amount(credit_raw, "Credit", &mut errors);
        if !debit.is_zero() && !credit.is_zero() {
            errors.push(bad_row(row, "Credit", credit_raw, "a row has a debit or a credit, not both"));
            continue;
        }
        let posting = debit - credit;
        let account = accounts.get_mut(&code).expect("inserted above");
        if !balance_raw.is_empty() {
            let shown = amount(balance_raw, "Ending Balance", &mut errors);
            if let (Some(before), Some(credit_normal)) = (account.shown, account.credit_normal) {
                let expected = if credit_normal { before - posting } else { before + posting };
                if shown != expected {
                    errors.push(bad_row(
                        row,
                        "Ending Balance",
                        balance_raw,
                        format!(
                            "the running balance should be {expected}, from the rows above"
                        ),
                    ));
                }
            }
            account.shown = Some(shown);
        } else if let Some(shown) = account.shown.as_mut() {
            *shown = if account.credit_normal == Some(true) {
                *shown - posting
            } else {
                *shown + posting
            };
        }
        let memo = cell(cells, memo_col);
        let description = if memo.is_empty() { cell(cells, card_col) } else { memo };
        lines.push(HistoryGlLine {
            row,
            code,
            account_name: account.name.clone(),
            date,
            reference: cell(cells, id_col).to_owned(),
            description: description.to_owned(),
            source: cell(cells, src_col).to_owned(),
            amount: posting,
        });
    }

    if !errors.is_empty() {
        return Err(errors);
    }
    let dates = fields::title_dates(&table.preamble);
    Ok(HistoryGl {
        from: dates.first().copied().filter(|_| dates.len() > 1),
        to: dates.last().copied(),
        openings,
        lines,
    })
}

/// The account a row names, if any: `Account No.` (with `Account Name`), or a combined
/// account cell. An unreadable number is an error: the value and the reason.
fn named_account<'a>(
    cells: &'a [String],
    code_col: Option<usize>,
    account_col: Option<usize>,
    name_col: Option<usize>,
) -> Result<Option<(String, String)>, (&'a str, String)> {
    let raw = cell(cells, code_col);
    if !raw.is_empty() {
        let lower = raw.to_lowercase();
        if lower.starts_with("total") || lower.starts_with("grand total") {
            return Ok(None);
        }
        return match fields::account_code(raw) {
            Ok(code) => Ok(Some((code, cell(cells, name_col).to_owned()))),
            Err(reason) => Err((raw, reason)),
        };
    }
    Ok(fields::split_account(cell(cells, account_col)))
}
