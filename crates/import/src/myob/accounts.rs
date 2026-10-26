//! The accounts list: AccountRight's Export Data → Accounts (tab or comma separated, with the
//! fields the user picked) and MYOB Business's chart of accounts export (tab separated).
//!
//! Only the number is required. A blank type falls back to the number's first digit. Header
//! accounts are kept and marked, since MYOB's report layouts hang off them. Balances in the
//! file are ignored: they're whatever the account held on the day of the export, and history
//! comes from the Trial Balance instead.

use std::collections::BTreeMap;

use super::fields::{self, bad_row};
use super::{Table, cell};
use crate::history::{HistoryAccount, HistoryError};

pub(super) fn parse(table: &Table) -> Result<Vec<HistoryAccount>, Vec<HistoryError>> {
    let code_col = table.col(&["account number", "account no."]);
    let name_col = table.col(&["account name", "name"]);
    let header_col = table.col(&["header"]);
    let type_col = table.col(&["account type", "type"]);
    let tax_col = table.header.iter().position(|h| {
        !h.starts_with("freight") && (h.contains("gst code") || h.contains("tax code"))
    });
    let inactive_col = table.col(&["inactive account", "inactive"]);

    let mut accounts = Vec::new();
    let mut errors = Vec::new();
    let mut seen: BTreeMap<String, u32> = BTreeMap::new();
    for (row, cells) in &table.rows {
        let row = *row;
        let raw_code = cell(cells, code_col);
        let code = match fields::account_code(raw_code) {
            Ok(code) => code,
            Err(reason) => {
                errors.push(bad_row(row, "Account Number", raw_code, reason));
                continue;
            }
        };
        if let Some(first) = seen.get(&code) {
            errors.push(bad_row(
                row,
                "Account Number",
                raw_code,
                format!("the account number is already on row {first}"),
            ));
            continue;
        }
        seen.insert(code.clone(), row);

        let source_type = cell(cells, type_col).to_owned();
        let Some(account_type) =
            fields::type_from_name(&source_type).or_else(|| fields::type_from_code(&code))
        else {
            errors.push(bad_row(
                row,
                "Account Type",
                &source_type,
                "neither the type nor the account number's first digit says what kind of \
                 account this is",
            ));
            continue;
        };
        let tax_code = Some(cell(cells, tax_col).to_owned()).filter(|t| !t.is_empty());
        accounts.push(HistoryAccount {
            row,
            code,
            name: cell(cells, name_col).to_owned(),
            account_type,
            source_type,
            tax_code,
            is_header: flag(cell(cells, header_col)),
            active: !flag(cell(cells, inactive_col)),
        });
    }
    if errors.is_empty() {
        Ok(accounts)
    } else {
        Err(errors)
    }
}

/// MYOB's one-character flags: blank or `N` is off; anything else (`Y`, `H`, `X`) is on.
fn flag(value: &str) -> bool {
    !(value.is_empty() || value.eq_ignore_ascii_case("n"))
}
