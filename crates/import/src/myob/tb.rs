//! The Trial Balance report, exported as CSV or TSV (AccountRight) or saved as CSV from its
//! Excel export (MYOB Business).
//!
//! Title rows come first; the last date in them is the balance date (`March 2025` means its
//! last day). The report has the month's `Debit` and `Credit` and the year to date's
//! `YTD Debit` and `YTD Credit`; the year-to-date columns win when present. Account numbers
//! need the `Account No.` column, which MYOB leaves off by default, or a combined
//! `1-1110 Name` account cell. `Total` rows are skipped.

use std::collections::BTreeMap;

use acct_core::Money;

use super::fields::{self, bad_row};
use super::{Table, cell};
use crate::history::{HistoryError, HistoryTb, HistoryTbRow};

pub(super) fn parse(table: &Table) -> Result<HistoryTb, Vec<HistoryError>> {
    let code_col = table.col(&["account no.", "account no", "account number"]);
    let account_col = table.col(&["account", "account name"]);
    let name_col = table.col(&["account name"]);
    let (debit_col, credit_col) = if table.has("ytd debit") && table.has("ytd credit") {
        (table.col(&["ytd debit"]), table.col(&["ytd credit"]))
    } else {
        (table.col(&["debit"]), table.col(&["credit"]))
    };

    let mut rows: Vec<HistoryTbRow> = Vec::new();
    let mut errors = Vec::new();
    let mut seen: BTreeMap<String, u32> = BTreeMap::new();
    for (row, cells) in &table.rows {
        let row = *row;
        let first = cells
            .iter()
            .find(|c| !c.is_empty())
            .map_or("", String::as_str);
        if first.to_lowercase().starts_with("total")
            || first.to_lowercase().starts_with("grand total")
        {
            continue;
        }
        let (debit_raw, credit_raw) = (cell(cells, debit_col), cell(cells, credit_col));
        let raw_code = cell(cells, code_col);
        let (code, name) = if !raw_code.is_empty() {
            match fields::account_code(raw_code) {
                Ok(code) => (code, cell(cells, name_col).to_owned()),
                Err(reason) => {
                    errors.push(bad_row(row, "Account No.", raw_code, reason));
                    continue;
                }
            }
        } else if let Some(split) = fields::split_account(cell(cells, account_col)) {
            split
        } else if debit_raw.is_empty() && credit_raw.is_empty() {
            // A heading with no amounts.
            continue;
        } else {
            errors.push(bad_row(
                row,
                "Account No.",
                cell(cells, account_col),
                "no account number: add the Account No. column to the report before exporting",
            ));
            continue;
        };

        if let Some(first) = seen.get(&code) {
            errors.push(bad_row(
                row,
                "Account No.",
                &code,
                format!("the account is already on row {first}"),
            ));
            continue;
        }
        seen.insert(code.clone(), row);

        let mut amount = |raw: &str, column: &str| {
            fields::amount(raw).unwrap_or_else(|reason| {
                errors.push(bad_row(row, column, raw, reason));
                Money::ZERO
            })
        };
        let debit = amount(debit_raw, "Debit");
        let credit = amount(credit_raw, "Credit");
        if !debit.is_zero() && !credit.is_zero() {
            errors.push(bad_row(
                row,
                "Credit",
                credit_raw,
                "a row has a debit or a credit, not both",
            ));
            continue;
        }
        rows.push(HistoryTbRow {
            row,
            code,
            name,
            balance: debit - credit,
        });
    }
    if errors.is_empty() {
        let total: Money = rows.iter().map(|r| r.balance).sum();
        if !total.is_zero() {
            errors.push(HistoryError::Unbalanced { difference: total });
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }
    Ok(HistoryTb {
        as_at: fields::title_dates(&table.preamble).last().copied(),
        rows,
    })
}
