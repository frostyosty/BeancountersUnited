//! `rimu-csv-1`: the Rimu Savings Society CSV (layout B in `fixtures/bank-statements`).
//!
//! This layout is invented, standing in until real bank layouts are copied (`docs/domain.md`,
//! "Bank statement formats").
//! - No preamble or trailer: the header row `Account,Posted,Type,Payee,Particulars,Reference,Amount`
//!   then one row per transaction.
//! - One signed amount column (negative is money out); no balances anywhere.
//! - The account number is in every row; a file holding more than one account is refused.
//! - Text columns, joined in this order: `Payee`, `Particulars`, `Reference`. `Type` (INT, DEP,
//!   WD) is a transaction code, not text, so it's left out.
//! - Dates `yyyy-mm-dd`. Encoding UTF-8 or Windows-1252.

use super::text::{csv_records, is_header, normalise_account, normalise_description};
use super::text::{parse_amount, parse_iso};
use super::{ParserInfo, Problem, Statement, StatementLine};

pub const V1: ParserInfo = ParserInfo {
    id: "rimu-csv-1",
    family: "rimu-csv",
    version: 1,
    label: "Rimu Savings Society CSV",
};

const HEADER: &[&str] = &[
    "Account",
    "Posted",
    "Type",
    "Payee",
    "Particulars",
    "Reference",
    "Amount",
];

pub fn detect(text: &str) -> bool {
    csv_records(
        text.lines()
            .find(|l| !l.trim().is_empty())
            .unwrap_or_default(),
    )
    .ok()
    .and_then(|r| r.into_iter().next())
    .is_some_and(|(_, fields)| is_header(&fields, HEADER))
}

pub fn parse(text: &str) -> Result<Statement, Vec<Problem>> {
    let records = csv_records(text).map_err(|p| vec![p])?;
    let mut problems = Vec::new();
    let mut account: Option<String> = None;
    let mut lines = Vec::new();

    for (row, fields) in records.into_iter().skip(1) {
        if fields.len() != HEADER.len() {
            problems.push(Problem::Unreadable {
                row: Some(row),
                message: format!("expected {} fields, found {}", HEADER.len(), fields.len()),
            });
            continue;
        }
        let this_account = normalise_account(&fields[0]);
        match &account {
            None => account = Some(this_account),
            Some(first) if *first != this_account => {
                problems.push(Problem::SeveralAccounts {
                    row,
                    account: this_account,
                });
            }
            Some(_) => {}
        }
        let date = parse_iso(&fields[1]);
        if date.is_none() {
            problems.push(Problem::BadDate {
                row,
                value: fields[1].clone(),
            });
        }
        let amount = parse_amount(&fields[6])
            .map_err(|message| {
                problems.push(Problem::BadAmount {
                    row,
                    value: fields[6].clone(),
                    message,
                });
            })
            .ok();
        if let (Some(date), Some(amount)) = (date, amount) {
            lines.push(StatementLine {
                row,
                date,
                amount,
                description: normalise_description([
                    fields[3].as_str(),
                    fields[4].as_str(),
                    fields[5].as_str(),
                ]),
                bank_id: None,
                balance: None,
            });
        }
    }
    if account.is_none() {
        problems.push(Problem::Missing {
            field: "Account".to_owned(),
        });
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(Statement {
        kind: super::StatementKind::Bank,
        parser: String::new(),
        account,
        period_start: None,
        period_end: None,
        opening: None,
        closing: None,
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "Account,Posted,Type,Payee,Particulars,Reference,Amount\n";

    #[test]
    fn several_accounts_are_refused() {
        let text = format!(
            "{HEAD}99-7702-0000789-00,2025-08-29,INT,A,,,1.00\n\
             99-7702-0000790-00,2025-08-30,INT,A,,,1.00\n"
        );
        assert!(matches!(
            parse(&text).unwrap_err()[..],
            [Problem::SeveralAccounts { row: 3, .. }]
        ));
    }

    #[test]
    fn a_header_alone_has_no_account() {
        assert!(detect(HEAD));
        assert_eq!(
            parse(HEAD).unwrap_err(),
            vec![Problem::Missing {
                field: "Account".to_owned()
            }]
        );
    }
}
