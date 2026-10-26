//! General ledger detail: Accounting › Reports › Account Transactions › Export.
//!
//! A preamble (`Account Transactions`, the organisation, `For the period 1 April 2024 to
//! 31 March 2025`), then a header row such as `Date, Source, Description, Reference, Debit,
//! Credit, Running Balance, Gross, GST`. Two body layouts are read:
//! - Grouped by account (Xero's default): a heading row per account (`Sales (200)`), an
//!   `Opening Balance` row, the transactions, then `Total …` and `Closing Balance` rows.
//! - Ungrouped, with `Account Code` (and `Account`) columns on every row.
//!
//! An opening balance is read from Debit and Credit, or, when both are blank, from the running
//! balance (debit positive). Total and closing rows are skipped: the TB check covers them.

use acct_core::Money;

use crate::history::{HistoryError, HistoryGl, HistoryGlLine, HistoryTbRow};

use super::text::{Header, Record, amount, bad_row, date, date_in, find_header, split_account};

const DATE: &[&str] = &["date"];
const DEBIT: &[&str] = &["debit"];
const CREDIT: &[&str] = &["credit"];
const SOURCE: &[&str] = &["source", "type"];
const DESCRIPTION: &[&str] = &["description"];
const REFERENCE: &[&str] = &["reference"];
const RUNNING: &[&str] = &["runningbalance", "balance"];
const CODE: &[&str] = &["accountcode", "code"];
const ACCOUNT: &[&str] = &["account", "accountname"];

const PREAMBLE: usize = 10;

fn header(records: &[Record]) -> Option<(usize, Header)> {
    find_header(records, PREAMBLE, &[DATE, DEBIT, CREDIT])
}

pub fn detect(records: &[Record]) -> bool {
    header(records).is_some()
}

pub fn parse(records: &[Record]) -> Result<HistoryGl, Vec<HistoryError>> {
    let Some((at, header)) = header(records) else {
        return Err(vec![HistoryError::Empty]);
    };
    let period = records[..at]
        .iter()
        .flat_map(|r| r.filled())
        .find(|cell| date_in(cell, false).is_some() && date_in(cell, true) != date_in(cell, false));
    let (from, to) = period.map_or((None, None), |p| (date_in(p, false), date_in(p, true)));

    let col = |names| header.find(names);
    let (date_col, debit, credit) = (
        col(DATE).unwrap_or(usize::MAX),
        col(DEBIT).unwrap_or(usize::MAX),
        col(CREDIT).unwrap_or(usize::MAX),
    );
    let text = |r: &Record, names| col(names).map_or(String::new(), |i| r.get(i).to_owned());
    let code_col = col(CODE);
    let account_col = col(ACCOUNT);

    let mut openings: Vec<HistoryTbRow> = Vec::new();
    let mut lines = Vec::new();
    let mut errors = Vec::new();
    // The account the current group is for, in the grouped layout.
    let mut current: Option<(String, String)> = None;
    for r in &records[at + 1..] {
        let first = r.filled().next().unwrap_or("").to_ascii_lowercase();
        if first.starts_with("total") || first.starts_with("closing balance") {
            continue;
        }
        let (d, c) = (r.get(debit), r.get(credit));
        let mut read = |i: usize, v: &str| {
            amount(v).unwrap_or_else(|e| {
                errors.push(bad_row(r.row, &header.name(i), v, e));
                Money::ZERO
            })
        };
        let movement = read(debit, d) - read(credit, c);
        let account = match code_col {
            Some(i) if !r.get(i).is_empty() => Some((
                r.get(i).to_owned(),
                account_col.map_or(String::new(), |a| r.get(a).to_owned()),
            )),
            _ => current.clone(),
        };

        if first.starts_with("opening balance") {
            let balance = if d.is_empty() && c.is_empty() {
                col(RUNNING).map_or(Money::ZERO, |i| {
                    amount(r.get(i)).unwrap_or_else(|e| {
                        errors.push(bad_row(r.row, &header.name(i), r.get(i), e));
                        Money::ZERO
                    })
                })
            } else {
                movement
            };
            let Some((code, name)) = account else {
                errors.push(bad_row(r.row, "", &first, "an opening balance with no account"));
                continue;
            };
            if let Some(o) = openings.iter_mut().find(|o| o.code == code) {
                o.balance += balance;
            } else if !balance.is_zero() {
                openings.push(HistoryTbRow {
                    row: r.row,
                    code,
                    name,
                    balance,
                });
            }
            continue;
        }

        let raw_date = r.get(date_col);
        if raw_date.is_empty() && d.is_empty() && c.is_empty() {
            // An account heading in the grouped layout.
            let label = r.filled().next().unwrap_or("");
            match split_account(label) {
                Some(account) => current = Some(account),
                None => errors.push(bad_row(
                    r.row,
                    &header.name(date_col),
                    label,
                    "an account heading with no code; give the account one in Xero and export again",
                )),
            }
            continue;
        }
        let Some(when) = date(raw_date) else {
            errors.push(bad_row(r.row, &header.name(date_col), raw_date, "not a date"));
            continue;
        };
        let Some((code, account_name)) = account else {
            errors.push(bad_row(
                r.row,
                &header.name(date_col),
                raw_date,
                "a transaction before any account heading",
            ));
            continue;
        };
        lines.push(HistoryGlLine {
            row: r.row,
            code,
            account_name,
            date: when,
            reference: text(r, REFERENCE),
            description: text(r, DESCRIPTION),
            source: text(r, SOURCE),
            amount: movement,
        });
    }
    if errors.is_empty() && lines.is_empty() && openings.is_empty() {
        errors.push(HistoryError::Empty);
    }
    if errors.is_empty() {
        Ok(HistoryGl {
            from,
            to,
            openings,
            lines,
        })
    } else {
        Err(errors)
    }
}
