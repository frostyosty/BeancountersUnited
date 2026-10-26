//! Trial Balance: Accounting › Reports › Trial Balance › Export (CSV or Excel saved as CSV).
//!
//! A preamble (`Trial Balance`, the organisation, `As at 31 March 2025`), then a header row,
//! then one row per account, with section headings (`Revenue`, `Assets`…) and `Total` rows in
//! between. Two header layouts are read:
//! - `Account Code, Account, Account Type, Debit, Credit, YTD Debit, YTD Credit`.
//! - `Account, Debit, Credit, YTD Debit, YTD Credit`, with the code in the account cell, as
//!   `Sales (200)`.
//!
//! The YTD columns are the balances at the report date, so they're used when present; the plain
//! Debit and Credit columns (the month's movement) are used only when there are no YTD ones.

use acct_core::Money;

use crate::history::{HistoryError, HistoryTb, HistoryTbRow};

use super::text::{Header, Record, amount, bad_row, date_in, find_header, split_account};

const ACCOUNT: &[&str] = &["account", "accountname"];
const CODE: &[&str] = &["accountcode", "code"];
const DEBIT: &[&str] = &["debit"];
const CREDIT: &[&str] = &["credit"];
const YTD_DEBIT: &[&str] = &["ytddebit", "debityeartodate", "debitytd"];
const YTD_CREDIT: &[&str] = &["ytdcredit", "credityeartodate", "creditytd"];

/// How far into the file the header row may be.
const PREAMBLE: usize = 10;

fn header(records: &[Record]) -> Option<(usize, Header)> {
    find_header(records, PREAMBLE, &[ACCOUNT, DEBIT, CREDIT])
        .or_else(|| find_header(records, PREAMBLE, &[ACCOUNT, YTD_DEBIT, YTD_CREDIT]))
}

pub fn detect(records: &[Record]) -> bool {
    header(records).is_some()
}

pub fn parse(records: &[Record]) -> Result<HistoryTb, Vec<HistoryError>> {
    let Some((at, header)) = header(records) else {
        return Err(vec![HistoryError::Empty]);
    };
    let as_at = records[..at]
        .iter()
        .flat_map(|r| r.filled())
        .filter(|cell| cell.to_ascii_lowercase().contains("as at"))
        .find_map(|cell| date_in(cell, false));
    let account = header.find(ACCOUNT).unwrap_or(usize::MAX);
    let code_col = header.find(CODE);
    let (debit, credit) = match (header.find(YTD_DEBIT), header.find(YTD_CREDIT)) {
        (Some(d), Some(c)) => (d, c),
        _ => (
            header.find(DEBIT).unwrap_or(usize::MAX),
            header.find(CREDIT).unwrap_or(usize::MAX),
        ),
    };

    let mut rows: Vec<HistoryTbRow> = Vec::new();
    let mut errors = Vec::new();
    for r in &records[at + 1..] {
        let label = r.get(account);
        let first = r.filled().next().unwrap_or("");
        if first.to_ascii_lowercase().starts_with("total") || label.eq_ignore_ascii_case("total") {
            continue;
        }
        let (d, c) = (r.get(debit), r.get(credit));
        let coded = match code_col {
            Some(i) if !r.get(i).is_empty() => Some((r.get(i).to_owned(), label.to_owned())),
            _ => split_account(label),
        };
        let Some((code, name)) = coded else {
            if d.is_empty() && c.is_empty() {
                continue; // a section heading
            }
            errors.push(bad_row(
                r.row,
                &header.name(account),
                label,
                "the account has no code; give it one in Xero and export again",
            ));
            continue;
        };
        let mut read = |i: usize, v: &str| {
            amount(v).unwrap_or_else(|e| {
                errors.push(bad_row(r.row, &header.name(i), v, e));
                Money::ZERO
            })
        };
        let balance = read(debit, d) - read(credit, c);
        if let Some(first) = rows.iter().find(|x| x.code == code) {
            errors.push(bad_row(
                r.row,
                &header.name(code_col.unwrap_or(account)),
                &code,
                format!("code already used on row {}", first.row),
            ));
            continue;
        }
        rows.push(HistoryTbRow {
            row: r.row,
            code,
            name,
            balance,
        });
    }
    if errors.is_empty() {
        if rows.is_empty() {
            errors.push(HistoryError::Empty);
        } else {
            let total: Money = rows.iter().map(|r| r.balance).sum();
            if !total.is_zero() {
                errors.push(HistoryError::Unbalanced { difference: total });
            }
        }
    }
    if errors.is_empty() {
        Ok(HistoryTb { as_at, rows })
    } else {
        Err(errors)
    }
}
