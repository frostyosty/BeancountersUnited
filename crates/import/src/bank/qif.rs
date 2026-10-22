//! QIF: the `!Type:Bank` section, with day-first dates (`dd/mm/yyyy`, `d/m/yy`, `d/m'yy`).
//!
//! A file whose dates only make sense month first (such as `08/29/2025`) is refused whole rather
//! than guessed at. The description is `P` then `M`. QIF has no balances, but many banks start
//! with an `Opening Balance` entry whose category is the account itself in brackets; that entry
//! becomes the opening balance, not a line. The account number comes from the `!Account` header's
//! name, or the opening entry's category, where either holds one.

use chrono::NaiveDate;

use super::text::{find_account, normalise_description, parse_amount};
use super::{Balance, ParserInfo, Problem, Statement, StatementLine};

pub const BANK: ParserInfo = ParserInfo {
    id: "qif-bank-1",
    family: "qif-bank",
    version: 1,
    label: "QIF (bank account)",
};

/// The first non-blank line is a QIF header such as `!Type:Bank` or `!Account`.
pub fn detect(text: &str) -> bool {
    let first = text.lines().map(str::trim).find(|l| !l.is_empty());
    first.is_some_and(|l| {
        let l = l.to_ascii_lowercase();
        l.starts_with("!type:") || l.starts_with("!account") || l.starts_with("!option")
    })
}

#[derive(PartialEq)]
enum Section {
    None,
    Account,
    Bank,
    Ignored,
}

#[derive(Default)]
struct Record {
    row: u32,
    date: Option<String>,
    amount: Option<String>,
    payee: Option<String>,
    memo: Option<String>,
    category: Option<String>,
}

impl Record {
    fn is_empty(&self) -> bool {
        self.date.is_none() && self.amount.is_none() && self.payee.is_none()
    }
}

pub fn parse(text: &str) -> Result<Statement, Vec<Problem>> {
    let mut problems = Vec::new();
    let mut section = Section::None;
    let mut bank_sections = 0;
    let mut account_names = Vec::new();
    let mut records = Vec::new();
    let mut current = Record::default();

    for (i, raw) in text.lines().enumerate() {
        let row = u32::try_from(i + 1).unwrap_or(u32::MAX);
        let line = raw.trim_end();
        if line.trim().is_empty() {
            continue;
        }
        if let Some(header) = line.strip_prefix('!') {
            let header = header.trim();
            let lower = header.to_ascii_lowercase();
            if lower.starts_with("option") || lower.starts_with("clear") {
                continue;
            }
            section = if lower == "account" {
                Section::Account
            } else if let Some(kind) = lower.strip_prefix("type:") {
                match kind.trim() {
                    "bank" => {
                        bank_sections += 1;
                        Section::Bank
                    }
                    "ccard" => return Err(vec![Problem::CreditCard]),
                    _ => {
                        problems.push(Problem::UnsupportedSection {
                            row,
                            section: format!("!{header}"),
                        });
                        Section::Ignored
                    }
                }
            } else {
                problems.push(Problem::UnsupportedSection {
                    row,
                    section: format!("!{header}"),
                });
                Section::Ignored
            };
            current = Record::default();
            continue;
        }
        let (code, value) = line.split_at(line.chars().next().map_or(0, char::len_utf8));
        let value = value.trim();
        match section {
            Section::Account => {
                if code == "N" {
                    account_names.push(value.to_owned());
                }
            }
            Section::Bank => {
                if code == "^" {
                    let record = std::mem::take(&mut current);
                    if !record.is_empty() {
                        records.push(record);
                    }
                    continue;
                }
                if current.row == 0 {
                    current.row = row;
                }
                let field = Some(value.to_owned());
                match code {
                    "D" => current.date = field,
                    "T" => current.amount = field,
                    "U" if current.amount.is_none() => current.amount = field,
                    "P" => current.payee = field,
                    "M" => current.memo = field,
                    "L" => current.category = field,
                    _ => {} // N, C, A, splits: not needed
                }
            }
            Section::None | Section::Ignored => {}
        }
    }
    if section == Section::Bank && !current.is_empty() {
        records.push(current);
    }
    if bank_sections == 0 {
        problems.push(Problem::Missing {
            field: "!Type:Bank".to_owned(),
        });
    }
    if bank_sections > 1 {
        problems.push(Problem::SeveralStatements);
    }

    // Dates first, all together, so a month-first file is refused as a whole.
    let mut dates = Vec::with_capacity(records.len());
    for r in &records {
        let Some(raw) = &r.date else {
            problems.push(Problem::MissingField {
                row: r.row,
                field: "D".to_owned(),
            });
            dates.push(None);
            continue;
        };
        match parse_day_first(raw) {
            DayFirst::Ok(d) => dates.push(Some(d)),
            DayFirst::MonthFirst => {
                problems.push(Problem::MonthFirstDates {
                    row: r.row,
                    value: raw.clone(),
                });
                dates.push(None);
            }
            DayFirst::Bad => {
                problems.push(Problem::BadDate {
                    row: r.row,
                    value: raw.clone(),
                });
                dates.push(None);
            }
        }
    }

    let mut opening = None;
    let mut account = account_names.iter().find_map(|n| find_account(n));
    let mut lines = Vec::with_capacity(records.len());
    for (index, (r, date)) in records.iter().zip(dates).enumerate() {
        let amount = match &r.amount {
            None => {
                problems.push(Problem::MissingField {
                    row: r.row,
                    field: "T".to_owned(),
                });
                None
            }
            Some(raw) => parse_amount(raw)
                .map_err(|message| {
                    problems.push(Problem::BadAmount {
                        row: r.row,
                        value: raw.clone(),
                        message,
                    });
                })
                .ok(),
        };
        let (Some(date), Some(amount)) = (date, amount) else {
            continue;
        };
        let self_category = r.category.as_deref().is_some_and(|c| c.starts_with('['));
        let is_opening = index == 0
            && self_category
            && r.payee
                .as_deref()
                .is_some_and(|p| p.trim().eq_ignore_ascii_case("opening balance"));
        if is_opening {
            opening = Some(Balance { date, amount });
            if account.is_none() {
                account = r.category.as_deref().and_then(find_account);
            }
            continue;
        }
        lines.push(StatementLine {
            row: r.row,
            date,
            amount,
            description: normalise_description([
                r.payee.as_deref().unwrap_or(""),
                r.memo.as_deref().unwrap_or(""),
            ]),
            bank_id: None,
            balance: None,
        });
    }

    if !problems.is_empty() {
        return Err(problems);
    }
    Ok(Statement {
        parser: String::new(),
        account,
        period_start: opening.map(|o| o.date),
        period_end: None,
        opening,
        closing: None,
        lines,
    })
}

enum DayFirst {
    Ok(NaiveDate),
    /// Not a valid day-first date, but valid month first.
    MonthFirst,
    Bad,
}

/// `d/m/y` with `/`, `-`, `.` or `'` between the parts, two- or four-digit years, and spaces
/// ignored. Two-digit years are 2000–2069 or 1970–1999. `yyyy-mm-dd` is also accepted, since it
/// can't be misread.
fn parse_day_first(raw: &str) -> DayFirst {
    let cleaned: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    let parts: Vec<&str> = cleaned.split(['/', '-', '.', '\'']).collect();
    let nums: Option<Vec<u32>> = parts
        .iter()
        .map(|p| {
            (!p.is_empty() && p.len() <= 4 && p.bytes().all(|b| b.is_ascii_digit()))
                .then(|| p.parse().ok())
                .flatten()
        })
        .collect();
    let (Some(nums), 3) = (nums, parts.len()) else {
        return DayFirst::Bad;
    };
    if parts[0].len() == 4 {
        return NaiveDate::from_ymd_opt(i32::try_from(nums[0]).unwrap_or(0), nums[1], nums[2])
            .map_or(DayFirst::Bad, DayFirst::Ok);
    }
    let year = match parts[2].len() {
        4 => nums[2],
        1 | 2 if nums[2] < 70 => 2000 + nums[2],
        1 | 2 => 1900 + nums[2],
        _ => return DayFirst::Bad,
    };
    let year = i32::try_from(year).unwrap_or(0);
    if let Some(d) = NaiveDate::from_ymd_opt(year, nums[1], nums[0]) {
        return DayFirst::Ok(d);
    }
    if NaiveDate::from_ymd_opt(year, nums[0], nums[1]).is_some() {
        DayFirst::MonthFirst
    } else {
        DayFirst::Bad
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use acct_core::Money;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    #[test]
    fn day_first_dates() {
        let ok = |raw: &str, iso: &str| {
            assert!(
                matches!(parse_day_first(raw), DayFirst::Ok(x) if x == d(iso)),
                "{raw}"
            );
        };
        ok("28/08/2025", "2025-08-28");
        ok("1/8/25", "2025-08-01");
        ok("1/8'25", "2025-08-01");
        ok(" 1/ 8/2025", "2025-08-01");
        ok("03/04/99", "1999-04-03");
        ok("2025-08-29", "2025-08-29");
        assert!(matches!(
            parse_day_first("08/29/2025"),
            DayFirst::MonthFirst
        ));
        assert!(matches!(parse_day_first("32/13/2025"), DayFirst::Bad));
        assert!(matches!(parse_day_first("yesterday"), DayFirst::Bad));
    }

    #[test]
    fn a_month_first_file_is_refused_whole() {
        let qif = "!Type:Bank\nD08/03/2025\nT-1.00\nPA\n^\nD08/29/2025\nT-2.00\nPB\n^\n";
        assert_eq!(
            parse(qif).unwrap_err(),
            vec![Problem::MonthFirstDates {
                row: 6,
                value: "08/29/2025".to_owned()
            }]
        );
    }

    #[test]
    fn without_a_header_or_opening_entry() {
        let qif = "!Type:Bank\nD03/08/2025\nU-1,000.00\nT-1,000.00\nPRent\n^\nD04/08/2025\nT5\n";
        let s = parse(qif).unwrap();
        assert_eq!(s.account, None);
        assert_eq!(s.opening, None);
        assert_eq!(s.lines.len(), 2);
        assert_eq!(s.lines[0].amount, Money::from_cents(-100_000));
        assert_eq!(s.lines[1].description, "");
        assert_eq!(s.lines[1].row, 7);
    }

    #[test]
    fn opening_entry_names_the_account() {
        let qif =
            "!Type:Bank\nD01/08/2025\nT10.00\nPOpening Balance\nL[Cheque 99-1001-0000123-000]\n^\n";
        let s = parse(qif).unwrap();
        assert_eq!(s.account.as_deref(), Some("99-1001-0000123-00"));
        assert_eq!(
            s.opening,
            Some(Balance {
                date: d("2025-08-01"),
                amount: Money::from_cents(1000)
            })
        );
        assert!(s.lines.is_empty());
    }

    #[test]
    fn other_sections_are_refused() {
        assert_eq!(
            parse("!Type:CCard\nD01/08/2025\n").unwrap_err(),
            vec![Problem::CreditCard]
        );
        let problems = parse("!Type:Invst\nD01/08/2025\n^\n").unwrap_err();
        assert!(matches!(
            problems[0],
            Problem::UnsupportedSection { row: 1, .. }
        ));
    }
}
