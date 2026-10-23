//! `pohutukawa-card-csv-1`: the Pohutukawa Card Services credit card CSV (layout C in
//! `fixtures/bank-statements`).
//!
//! This layout is invented, standing in until real card layouts are copied (`docs/domain.md`,
//! "Bank statement formats").
//! - Preamble: the issuer's name line, then `key,value` rows: `Cardholder`, `Card number` (masked
//!   by the issuer), `Statement period,dd/mm/yyyy,dd/mm/yyyy`, `Opening balance`,
//!   `Closing balance` and `Credit limit` (ignored).
//! - Header row `Processed,Transaction date,Details,Amount`, then one row per transaction.
//! - Amounts and balances are written the way a card statement shows them, from the cardholder's
//!   bill: unsigned, a charge as a plain amount, and a credit (a payment or refund) suffixed `CR`.
//!   A balance owed is plain; a balance in credit ends in `CR`. Both are flipped to our sign
//!   convention, the card's point of view: a charge or a balance owed is negative, a credit
//!   positive. A sign in front of the amount is refused rather than guessed at.
//! - The posting date is `Processed`. `Transaction date` is checked but not used.
//! - Text column: `Details` only. Dates `dd/mm/yyyy`. Encoding UTF-8 or Windows-1252.
//! - No running balance. Ends with an `End of statement` line.

use acct_core::Money;

use super::text::{csv_records, is_header, normalise_card, normalise_description};
use super::text::{parse_amount, parse_dmy};
use super::{Balance, ParserInfo, Problem, Statement, StatementKind, StatementLine};

pub const V1: ParserInfo = ParserInfo {
    id: "pohutukawa-card-csv-1",
    family: "pohutukawa-card-csv",
    version: 1,
    label: "Pohutukawa Card Services credit card CSV",
};

const ISSUER_LINE: &str = "Pohutukawa Card Services";
const HEADER: &[&str] = &["Processed", "Transaction date", "Details", "Amount"];
const TRAILER: &str = "End of statement";

pub fn detect(text: &str) -> bool {
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or_default();
    first.starts_with(ISSUER_LINE)
        && lines.any(|l| {
            let fields: Vec<String> = l.split(',').map(|f| f.trim().to_owned()).collect();
            is_header(&fields, HEADER)
        })
}

/// A statement amount (`436.20`, `250.00 CR`) signed from the card's point of view: a charge or a
/// balance owed is negative, a credit positive.
fn card_amount(raw: &str) -> Result<Money, String> {
    let s = raw.trim();
    let (number, credit) = match s
        .len()
        .checked_sub(2)
        .and_then(|i| s.get(i..).map(|t| (i, t)))
    {
        Some((i, suffix)) if suffix.eq_ignore_ascii_case("CR") => (s[..i].trim_end(), true),
        _ => (s, false),
    };
    if number.starts_with(['-', '+']) {
        return Err("this layout writes amounts without a sign; credits end in CR".to_owned());
    }
    let m = parse_amount(number)?;
    Ok(if credit { m } else { -m })
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
        card_amount(value)
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
            "card number" => match normalise_card(value(1)) {
                Some(card) => account = Some(card),
                None => problems.push(Problem::Unreadable {
                    row: Some(row),
                    message: "the card number should end in its last four digits".to_owned(),
                }),
            },
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
        if parse_dmy(&fields[1]).is_none() {
            problems.push(Problem::BadDate {
                row,
                value: fields[1].clone(),
            });
        }
        let signed = amount(row, &fields[3], &mut problems);
        if let (Some(date), Some(amount)) = (date, signed) {
            lines.push(StatementLine {
                row,
                date,
                amount,
                description: normalise_description([fields[2].as_str()]),
                bank_id: None,
                balance: None,
            });
        }
    }

    if account.is_none()
        && !problems
            .iter()
            .any(|p| matches!(p, Problem::Unreadable { .. }))
    {
        problems.push(Problem::Missing {
            field: "Card number".to_owned(),
        });
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let at = |date: Option<chrono::NaiveDate>, amount: Option<Money>| {
        Some(Balance {
            date: date?,
            amount: amount?,
        })
    };
    Ok(Statement {
        parser: String::new(),
        kind: StatementKind::CreditCard,
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

    const HEAD: &str = "Pohutukawa Card Services - Card statement\n\
        Card number,XXXX XXXX XXXX 8802\n\
        Statement period,15/08/2025,14/09/2025\n\
        Opening balance,10.00\nClosing balance,5.00 CR\n\n\
        Processed,Transaction date,Details,Amount\n";

    #[test]
    fn charges_are_money_out_and_credits_money_in() {
        assert_eq!(card_amount("436.20"), Ok(Money::from_cents(-43_620)));
        assert_eq!(card_amount("250.00 CR"), Ok(Money::from_cents(25_000)));
        assert_eq!(card_amount("1,250.00cr"), Ok(Money::from_cents(125_000)));
        assert!(card_amount("-250.00").is_err());
        assert!(card_amount("CR").is_err());
    }

    #[test]
    fn balances_owed_are_negative() {
        let text =
            format!("{HEAD}16/08/2025,15/08/2025,SHOP,5.00\n17/08/2025,17/08/2025,PAY,20.00 CR\n");
        let s = parse(&text).unwrap();
        assert_eq!(s.kind, StatementKind::CreditCard);
        assert_eq!(s.account.as_deref(), Some("XXXX-XXXX-XXXX-8802"));
        assert_eq!(s.opening.unwrap().amount, Money::from_cents(-1000));
        assert_eq!(s.closing.unwrap().amount, Money::from_cents(500));
        assert_eq!(s.balance_check(), super::super::BalanceCheck::Passes);
    }

    #[test]
    fn bad_rows_are_reported_with_their_row() {
        let text = format!("{HEAD}31/02/2025,01/08/2025,A,1.00\n01/09/2025,01/09/2025,B,-1.00\n");
        let problems = parse(&text).unwrap_err();
        assert!(
            matches!(problems[0], Problem::BadDate { row: 8, .. }),
            "{problems:?}"
        );
        assert!(
            matches!(problems[1], Problem::BadAmount { row: 9, .. }),
            "{problems:?}"
        );
    }

    #[test]
    fn needs_the_card_number() {
        let text = HEAD.replace("Card number,XXXX XXXX XXXX 8802\n", "");
        assert!(detect(&text));
        assert_eq!(
            parse(&text).unwrap_err(),
            vec![Problem::Missing {
                field: "Card number".to_owned()
            }]
        );
    }
}
