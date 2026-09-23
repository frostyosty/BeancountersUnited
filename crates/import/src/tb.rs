//! Trial balance CSVs.
//!
//! A header row, then one row per account. Two layouts are accepted, told apart by the header
//! (decided 2026-09-23, PLAN.md M2):
//! - `code, name, debit, credit`: the balance is debit − credit.
//! - `code, name, amount`: a signed balance, debit positive.
//!
//! Header names ignore case and surrounding spaces, and a few common alternatives are accepted
//! (see [`Layout::detect`]). Blank amount cells count as nil. Blank rows are skipped.

use acct_core::{AccountCode, Money};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// One account's balance from the file. `row` is the file's line number, counting the header
/// as row 1, for messages.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TbRow {
    pub row: u32,
    pub code: AccountCode,
    /// The name in the file. It's shown for checking, never used to match accounts.
    pub name: String,
    pub balance: Money,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum TbCsvError {
    /// The file couldn't be read as CSV at all.
    Unreadable {
        message: String,
    },
    /// The header has neither `debit` and `credit` nor `amount`, or lacks `code`.
    UnknownLayout {
        header: Vec<String>,
    },
    BadCode {
        row: u32,
        value: String,
        message: String,
    },
    BadAmount {
        row: u32,
        column: String,
        value: String,
        message: String,
    },
    /// Both debit and credit have an amount on the same row.
    DebitAndCredit {
        row: u32,
    },
    DuplicateCode {
        row: u32,
        account: AccountCode,
        first_row: u32,
    },
    Unbalanced {
        difference: Money,
    },
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Amounts {
    DebitCredit { debit: usize, credit: usize },
    Signed(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Layout {
    code: usize,
    name: Option<usize>,
    amounts: Amounts,
}

impl Layout {
    fn detect(header: &[String]) -> Option<Layout> {
        let find = |names: &[&str]| {
            header
                .iter()
                .position(|h| names.contains(&h.trim().to_ascii_lowercase().as_str()))
        };
        let code = find(&["code", "account", "account code", "acc code"])?;
        let name = find(&["name", "account name", "description"]);
        let amounts = match (find(&["debit", "dr"]), find(&["credit", "cr"])) {
            (Some(debit), Some(credit)) => Amounts::DebitCredit { debit, credit },
            _ => Amounts::Signed(find(&["amount", "balance"])?),
        };
        Some(Layout {
            code,
            name,
            amounts,
        })
    }
}

/// Parses a TB CSV. Returns every problem found, so they can all be shown at once.
pub fn parse(text: &str) -> Result<Vec<TbRow>, Vec<TbCsvError>> {
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(false)
        .flexible(true)
        .trim(csv::Trim::All)
        .from_reader(text.trim_start_matches('\u{feff}').as_bytes());
    let mut records = Vec::new();
    for record in reader.records() {
        match record {
            Ok(r) => records.push(r),
            Err(e) => {
                return Err(vec![TbCsvError::Unreadable {
                    message: e.to_string(),
                }]);
            }
        }
    }
    let mut records = records
        .into_iter()
        .filter(|r| r.iter().any(|cell| !cell.is_empty()));
    let Some(header) = records.next() else {
        return Err(vec![TbCsvError::Empty]);
    };
    let header: Vec<String> = header.iter().map(str::to_owned).collect();
    let Some(layout) = Layout::detect(&header) else {
        return Err(vec![TbCsvError::UnknownLayout { header }]);
    };

    let mut rows: Vec<TbRow> = Vec::new();
    let mut errors = Vec::new();
    for record in records {
        let row = record
            .position()
            .map_or(0, |p| u32::try_from(p.line()).unwrap_or(u32::MAX));
        let cell = |i: usize| record.get(i).unwrap_or("");
        let amount = |i: usize, errors: &mut Vec<TbCsvError>| -> Money {
            let value = cell(i);
            if value.is_empty() {
                return Money::ZERO;
            }
            value
                .parse()
                .unwrap_or_else(|e: acct_core::ParseMoneyError| {
                    errors.push(TbCsvError::BadAmount {
                        row,
                        column: header[i].clone(),
                        value: value.to_owned(),
                        message: e.to_string(),
                    });
                    Money::ZERO
                })
        };
        let balance = match layout.amounts {
            Amounts::Signed(i) => amount(i, &mut errors),
            Amounts::DebitCredit { debit, credit } => {
                let (d, c) = (amount(debit, &mut errors), amount(credit, &mut errors));
                if !d.is_zero() && !c.is_zero() {
                    errors.push(TbCsvError::DebitAndCredit { row });
                }
                d - c
            }
        };
        let code: AccountCode = match cell(layout.code).parse() {
            Ok(code) => code,
            Err(e) => {
                errors.push(TbCsvError::BadCode {
                    row,
                    value: cell(layout.code).to_owned(),
                    message: format!("{e}"),
                });
                continue;
            }
        };
        if let Some(first) = rows.iter().find(|r| r.code == code) {
            errors.push(TbCsvError::DuplicateCode {
                row,
                account: code,
                first_row: first.row,
            });
            continue;
        }
        rows.push(TbRow {
            row,
            code,
            name: layout.name.map(cell).unwrap_or_default().to_owned(),
            balance,
        });
    }
    if errors.is_empty() {
        let total: Money = rows.iter().map(|r| r.balance).sum();
        if !total.is_zero() {
            errors.push(TbCsvError::Unbalanced { difference: total });
        }
    }
    if errors.is_empty() {
        Ok(rows)
    } else {
        Err(errors)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn code(s: &str) -> AccountCode {
        s.parse().unwrap()
    }

    fn balances(rows: &[TbRow]) -> Vec<(String, i64)> {
        rows.iter()
            .map(|r| (r.code.to_string(), r.balance.cents()))
            .collect()
    }

    #[test]
    fn reads_debit_and_credit_columns() {
        let csv = "Code,Name,Debit,Credit\n\
                   600,Bank,\"1,500.00\",\n\
                   100,\"Sales, retail\",,1500\n";
        let rows = parse(csv).unwrap();
        assert_eq!(
            balances(&rows),
            [("600".into(), 150_000), ("100".into(), -150_000)]
        );
        assert_eq!(rows[1].name, "Sales, retail");
        assert_eq!(rows[1].row, 3);
    }

    #[test]
    fn reads_a_signed_amount_column() {
        let csv = "account,description,balance\n600,Bank,$25.50\n100,Sales,(25.50)\n";
        assert_eq!(
            balances(&parse(csv).unwrap()),
            [("600".into(), 2_550), ("100".into(), -2_550)]
        );
    }

    #[test]
    fn tolerates_a_bom_blank_rows_spaces_and_no_name_column() {
        let csv = "\u{feff} CODE , AMOUNT \n\n600, 10\n,,\n225.01,-10\n";
        let rows = parse(csv).unwrap();
        assert_eq!(
            balances(&rows),
            [("600".into(), 1_000), ("225.01".into(), -1_000)]
        );
        assert_eq!(rows[0].name, "");
    }

    #[test]
    fn blank_amounts_are_nil() {
        let csv = "code,name,debit,credit\n600,Bank,10,\n610,Debtors,,\n100,Sales,,10\n";
        let rows = parse(csv).unwrap();
        assert_eq!(rows[1].balance, Money::ZERO);
    }

    #[test]
    fn an_unknown_header_is_rejected() {
        assert_eq!(
            parse("acct,dollars\n600,10\n").unwrap_err(),
            vec![TbCsvError::UnknownLayout {
                header: vec!["acct".into(), "dollars".into()]
            }]
        );
        assert_eq!(parse("\n\n").unwrap_err(), vec![TbCsvError::Empty]);
    }

    #[test]
    fn every_row_problem_is_reported_with_its_row() {
        let csv = "code,name,debit,credit\n\
                   600,Bank,10,5\n\
                   bad code!,X,1,\n\
                   610,Debtors,1.234,\n\
                   600,Bank again,,1\n";
        let errors = parse(csv).unwrap_err();
        assert_eq!(errors.len(), 4, "{errors:?}");
        assert_eq!(errors[0], TbCsvError::DebitAndCredit { row: 2 });
        assert!(matches!(&errors[1], TbCsvError::BadCode { row: 3, .. }));
        assert!(
            matches!(&errors[2], TbCsvError::BadAmount { row: 4, column, .. } if column == "debit")
        );
        assert_eq!(
            errors[3],
            TbCsvError::DuplicateCode {
                row: 5,
                account: code("600"),
                first_row: 2
            }
        );
    }

    #[test]
    fn the_tb_must_balance() {
        let csv = "code,amount\n600,10.00\n100,-9.99\n";
        assert_eq!(
            parse(csv).unwrap_err(),
            vec![TbCsvError::Unbalanced {
                difference: Money::from_cents(1)
            }]
        );
    }
}
