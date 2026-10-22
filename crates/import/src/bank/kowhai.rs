//! `kowhai-csv-1`: the Kowhai Co-operative Bank CSV (layout A in `fixtures/bank-statements`).
//!
//! This layout is invented, standing in until real bank layouts are copied (`docs/domain.md`,
//! "Bank statement formats").
//! - Preamble: the bank's name line, then `key,value` rows: `Account name`, `Account number`,
//!   `Statement period,dd/mm/yyyy,dd/mm/yyyy`, `Opening balance`, `Closing balance`.
//! - Header row `Date,Description,Debit,Credit,Balance`, then one row per transaction.
//! - Separate debit (money out) and credit (money in) columns, exactly one filled per row, and
//!   a running balance.
//! - Text column: `Description` only. Dates `dd/mm/yyyy`. Encoding UTF-8 or Windows-1252.
//! - Ends with an `End of statement` line.

use super::text::{csv_records, is_header, normalise_account, normalise_description};
use super::text::{parse_amount, parse_dmy};
use super::{Balance, ParserInfo, Problem, Statement, StatementLine};

pub const V1: ParserInfo = ParserInfo {
    id: "kowhai-csv-1",
    family: "kowhai-csv",
    version: 1,
    label: "Kowhai Co-operative Bank CSV",
};

const BANK_LINE: &str = "Kowhai Co-operative Bank";
const HEADER: &[&str] = &["Date", "Description", "Debit", "Credit", "Balance"];
const TRAILER: &str = "End of statement";

pub fn detect(text: &str) -> bool {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or_default();
    first.starts_with(BANK_LINE)
        && lines.any(|l| {
            let fields: Vec<String> = l.split(',').map(|f| f.trim().to_owned()).collect();
            is_header(&fields, HEADER)
        })
}

pub fn parse(text: &str) -> Result<Statement, Vec<Problem>> {
    let records = csv_records(text).map_err(|p| vec![p])?;
    let mut problems = Vec::new();
    let mut account = None;
    let mut period = None;
    let mut opening = None;
    let mut closing = None;
    let mut lines = Vec::new();

    let amount = |row: u32, value: &str, problems: &mut Vec<Problem>| {
        if value.is_empty() {
            return None;
        }
        parse_amount(value)
            .map_err(|message| {
                problems.push(Problem::BadAmount {
                    row,
                    value: value.to_owned(),
                    message,
                });
            })
            .ok()
    };

    let mut records = records.into_iter();
    // Preamble, up to the header row.
    for (row, fields) in records.by_ref() {
        if is_header(&fields, HEADER) {
            break;
        }
        let value = |i: usize| fields.get(i).map_or("", String::as_str);
        match fields[0].to_ascii_lowercase().as_str() {
            "account number" => account = Some(normalise_account(value(1))),
            "statement period" => match (parse_dmy(value(1)), parse_dmy(value(2))) {
                (Some(start), Some(end)) => period = Some((start, end)),
                _ => problems.push(Problem::BadDate {
                    row,
                    value: format!("{},{}", value(1), value(2)),
                }),
            },
            "opening balance" => opening = amount(row, value(1), &mut problems),
            "closing balance" => closing = amount(row, value(1), &mut problems),
            _ => {}
        }
    }
    // Transactions, up to the trailer.
    for (row, fields) in records {
        if fields[0].eq_ignore_ascii_case(TRAILER) {
            break;
        }
        if fields.len() != HEADER.len() {
            problems.push(Problem::Unreadable {
                row: Some(row),
                message: format!("expected {} fields, found {}", HEADER.len(), fields.len()),
            });
            continue;
        }
        let date = parse_dmy(&fields[0]);
        if date.is_none() {
            problems.push(Problem::BadDate {
                row,
                value: fields[0].clone(),
            });
        }
        let debit = amount(row, &fields[2], &mut problems);
        let credit = amount(row, &fields[3], &mut problems);
        let balance = amount(row, &fields[4], &mut problems);
        let signed = match (debit, credit, fields[2].is_empty(), fields[3].is_empty()) {
            (Some(d), None, false, true) => Some(-d),
            (None, Some(c), true, false) => Some(c),
            (None, None, true, true) | (Some(_), Some(_), _, _) => {
                problems.push(Problem::DebitAndCredit { row });
                None
            }
            _ => None, // a bad amount, already reported
        };
        if let (Some(date), Some(amount)) = (date, signed) {
            lines.push(StatementLine {
                row,
                date,
                amount,
                description: normalise_description([fields[1].as_str()]),
                bank_id: None,
                balance,
            });
        }
    }

    if account.is_none() {
        problems.push(Problem::Missing {
            field: "Account number".to_owned(),
        });
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let at = |date: Option<chrono::NaiveDate>, amount: Option<acct_core::Money>| {
        Some(Balance {
            date: date?,
            amount: amount?,
        })
    };
    Ok(Statement {
        parser: String::new(),
        account,
        period_start: period.map(|p| p.0),
        period_end: period.map(|p| p.1),
        opening: at(period.map(|p| p.0), opening),
        closing: at(period.map(|p| p.1), closing),
        lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEAD: &str = "Kowhai Co-operative Bank - Account statement\n\
        Account number,99-5501-0000456-00\n\
        Statement period,01/08/2025,31/08/2025\n\
        Opening balance,10.00\nClosing balance,5.00\n\n\
        Date,Description,Debit,Credit,Balance\n";

    #[test]
    fn debit_and_credit_must_be_exactly_one() {
        let text = format!("{HEAD}05/08/2025,A,1.00,2.00,11.00\n06/08/2025,B,,,11.00\n");
        assert_eq!(
            parse(&text).unwrap_err(),
            vec![
                Problem::DebitAndCredit { row: 8 },
                Problem::DebitAndCredit { row: 9 }
            ]
        );
    }

    #[test]
    fn bad_rows_are_reported_with_their_row() {
        let text = format!("{HEAD}31/02/2025,A,1.00,,9.00\n01/08/2025,B,x,,9.00\n");
        let problems = parse(&text).unwrap_err();
        assert!(matches!(problems[0], Problem::BadDate { row: 8, .. }));
        assert!(matches!(problems[1], Problem::BadAmount { row: 9, .. }));
    }

    #[test]
    fn needs_the_account_number() {
        let text = HEAD.replace("Account number,99-5501-0000456-00\n", "");
        assert!(detect(&text));
        assert!(parse(&text).unwrap_err().contains(&Problem::Missing {
            field: "Account number".to_owned()
        }));
    }
}
