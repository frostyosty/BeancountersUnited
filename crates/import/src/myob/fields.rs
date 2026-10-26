//! Reading MYOB's cells: column names, account numbers, amounts, dates and account types.

use acct_core::Money;
use chrono::{Datelike, NaiveDate};

use crate::history::{HistoryError, SourceAccountType};

/// A header cell, normalised: lower case, single spaces, without MYOB's `*` (required) and
/// `^` (matching) markers or a trailing colon.
pub fn column_name(raw: &str) -> String {
    let s = raw
        .trim()
        .trim_start_matches(['*', '^'])
        .trim_end_matches(':');
    s.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

pub fn bad_row(row: u32, column: &str, value: &str, reason: impl Into<String>) -> HistoryError {
    HistoryError::BadRow {
        row,
        column: column.to_owned(),
        value: value.to_owned(),
        reason: reason.into(),
    }
}

/// The longest account number we accept. AccountRight's are five digits with an optional
/// separator (`1-1110`); MYOB Business allows up to ten characters.
const MAX_CODE_LEN: usize = 10;

/// An account number, verbatim apart from surrounding spaces.
pub fn account_code(raw: &str) -> Result<String, String> {
    let s = raw.trim();
    if s.is_empty() {
        return Err("the account number is blank".into());
    }
    if s.chars().count() > MAX_CODE_LEN {
        return Err(format!(
            "an account number has at most {MAX_CODE_LEN} characters"
        ));
    }
    if !s
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "-./".contains(c))
    {
        return Err("an account number has only letters, digits, '-', '.' and '/'".into());
    }
    Ok(s.to_owned())
}

/// Splits a report's combined account cell, `1-1110 Business Cheque Account`, into number and
/// name. `None` when the cell doesn't start with something that looks like an account number,
/// such as a `Total:` row.
pub fn split_account(cell: &str) -> Option<(String, String)> {
    let cell = cell.trim();
    let (first, rest) = cell.split_once(char::is_whitespace).unwrap_or((cell, ""));
    if !first.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let code = account_code(first).ok()?;
    Some((code, rest.trim().to_owned()))
}

/// The type MYOB's account numbering implies: the first digit is the account's
/// classification (1 asset, 2 liability, 3 equity, 4 income, 5 cost of sales, 6 expense,
/// 8 other income, 9 other expense).
pub fn type_from_code(code: &str) -> Option<SourceAccountType> {
    use SourceAccountType::*;
    Some(match code.chars().next()? {
        '1' => Asset,
        '2' => Liability,
        '3' => Equity,
        '4' => Income,
        '5' => CostOfSales,
        '6' => Expense,
        '8' => OtherIncome,
        '9' => OtherExpense,
        _ => return None,
    })
}

/// An account type as MYOB writes it, in either product, ignoring case.
pub fn type_from_name(name: &str) -> Option<SourceAccountType> {
    use SourceAccountType::*;
    Some(match column_name(name).as_str() {
        "asset"
        | "bank"
        | "accounts receivable"
        | "other current asset"
        | "fixed asset"
        | "other asset" => Asset,
        "liability"
        | "credit card"
        | "accounts payable"
        | "other current liability"
        | "long term liability"
        | "other liability" => Liability,
        "equity" => Equity,
        "income" => Income,
        "cost of sales" => CostOfSales,
        "expense" => Expense,
        "other income" => OtherIncome,
        "other expense" => OtherExpense,
        _ => return None,
    })
}

/// Whether a balance of this type is normally a credit. MYOB's reports show balances as
/// positive on their normal side.
pub fn credit_normal(t: SourceAccountType) -> bool {
    use SourceAccountType::*;
    matches!(t, Liability | Equity | Income | OtherIncome)
}

/// An amount as MYOB's exports write it: `1,234.50`, `$1,234.50`, `-$12.00`, `$-12.00`,
/// `(12.00)`. A blank cell is nil. Zeros past two decimal places are dropped; any other third
/// decimal is an error, never rounded.
pub fn amount(raw: &str) -> Result<Money, String> {
    let s: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    if s.is_empty() {
        return Ok(Money::ZERO);
    }
    let s = match s.strip_prefix("$-") {
        Some(rest) => format!("-{rest}"),
        None => s,
    };
    let s = match s.split_once('.') {
        Some((int, frac))
            if frac.len() > 2 && frac[2..].trim_end_matches(')').bytes().all(|b| b == b'0') =>
        {
            let close = if frac.ends_with(')') { ")" } else { "" };
            format!("{int}.{}{close}", &frac[..2])
        }
        _ => s,
    };
    s.parse::<Money>().map_err(|e| e.to_string())
}

/// A date as MYOB writes it in New Zealand: day first (`1/04/2024`, `01/04/24`), or as Excel
/// saves it (`1-Apr-2024`, `1 Apr 2024`, `2024-04-01`).
pub fn date(raw: &str) -> Option<NaiveDate> {
    let s = raw.trim();
    // Two-digit years first, which chrono's %Y would read as the first century.
    if let [d, m, y] = s.split('/').collect::<Vec<_>>()[..]
        && y.len() == 2
    {
        let (d, m, y) = (d.parse().ok()?, m.parse().ok()?, y.parse::<i32>().ok()?);
        return NaiveDate::from_ymd_opt(2000 + y, m, d);
    }
    ["%d/%m/%Y", "%d-%b-%Y", "%d %b %Y", "%Y-%m-%d", "%d.%m.%Y"]
        .iter()
        .find_map(|format| NaiveDate::parse_from_str(s, format).ok())
}

/// The dates in a report's title rows, in order: `1/04/2024 To 31/03/2025` gives two. A month
/// on its own (`March 2025`, as AccountRight's Trial Balance titles its period) gives its last
/// day.
pub fn title_dates(preamble: &[Vec<String>]) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    for cell in preamble.iter().flatten() {
        let words: Vec<&str> = cell.split_whitespace().collect();
        let mut i = 0;
        while i < words.len() {
            let word = words[i].trim_matches(|c: char| c == ',' || c == ':');
            if let Some(d) = date(word) {
                out.push(d);
            } else if let (Some(m), Some(y)) = (
                month(word),
                words.get(i + 1).and_then(|y| y.parse::<i32>().ok()),
            ) && let Some(last) = month_end(y, m)
            {
                out.push(last);
                i += 1;
            }
            i += 1;
        }
    }
    out
}

fn month(word: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = [
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
    ];
    let w = word.to_lowercase();
    MONTHS
        .iter()
        .position(|m| *m == w)
        .and_then(|i| u32::try_from(i + 1).ok())
}

fn month_end(year: i32, month: u32) -> Option<NaiveDate> {
    let first = NaiveDate::from_ymd_opt(year, month, 1)?;
    let next = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)?
    } else {
        NaiveDate::from_ymd_opt(first.year(), month + 1, 1)?
    };
    next.pred_opt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cents(s: &str) -> i64 {
        amount(s).unwrap().cents()
    }

    #[test]
    fn amounts_in_every_style_myob_writes() {
        assert_eq!(cents(""), 0);
        assert_eq!(cents("  "), 0);
        assert_eq!(cents("1234.5"), 123_450);
        assert_eq!(cents("$1,234.50"), 123_450);
        assert_eq!(cents("-$12.00"), -1_200);
        assert_eq!(cents("$-12.00"), -1_200);
        assert_eq!(cents("(12.00)"), -1_200);
        assert_eq!(cents("($1,000.01)"), -100_001);
        assert_eq!(cents("$ 5.00"), 500);
        assert_eq!(cents("0.10"), 10);
        assert_eq!(cents("12.3400"), 1_234);
        assert_eq!(cents("(12.3400)"), -1_234);
        assert_eq!(cents("92233720368547758.07"), i64::MAX);
    }

    #[test]
    fn amounts_myob_never_writes_are_rejected() {
        for bad in [
            "1.234",
            "12.345)",
            "1,23.00",
            "abc",
            "$",
            "92233720368547758.08",
            "1.2.3",
        ] {
            assert!(amount(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn dates_are_day_first() {
        let d = |y, m, day| NaiveDate::from_ymd_opt(y, m, day);
        assert_eq!(date("1/04/2024"), d(2024, 4, 1));
        assert_eq!(date("01/04/24"), d(2024, 4, 1));
        assert_eq!(date("1-Apr-2024"), d(2024, 4, 1));
        assert_eq!(date("1 Apr 2024"), d(2024, 4, 1));
        assert_eq!(date("2024-04-01"), d(2024, 4, 1));
        assert_eq!(date("31/02/2024"), None);
        assert_eq!(date("13/13/2024"), None);
        assert_eq!(date("Total"), None);
    }

    #[test]
    fn title_dates_read_ranges_and_months() {
        let rows = |s: &str| vec![vec![s.to_owned()]];
        let d = |y, m, day| NaiveDate::from_ymd_opt(y, m, day).unwrap();
        assert_eq!(
            title_dates(&rows("1/04/2024 To 31/03/2025")),
            [d(2024, 4, 1), d(2025, 3, 31)]
        );
        assert_eq!(title_dates(&rows("March 2025")), [d(2025, 3, 31)]);
        assert_eq!(title_dates(&rows("February 2024")), [d(2024, 2, 29)]);
        assert_eq!(title_dates(&rows("December 2024")), [d(2024, 12, 31)]);
        assert_eq!(title_dates(&rows("Trial Balance")), []);
    }

    #[test]
    fn account_numbers_and_combined_cells() {
        assert_eq!(account_code(" 1-1110 ").unwrap(), "1-1110");
        assert!(account_code("").is_err());
        assert!(account_code("1-1110 X").is_err());
        assert!(account_code("12345678901").is_err());
        assert_eq!(
            split_account("1-1110 Business Cheque Account"),
            Some(("1-1110".into(), "Business Cheque Account".into()))
        );
        assert_eq!(split_account("Total:"), None);
        assert_eq!(split_account(""), None);
    }

    #[test]
    fn types_from_names_and_numbers() {
        assert_eq!(
            type_from_name("Accounts Receivable"),
            Some(SourceAccountType::Asset)
        );
        assert_eq!(
            type_from_name("long term liability"),
            Some(SourceAccountType::Liability)
        );
        assert_eq!(
            type_from_name("Cost of Sales"),
            Some(SourceAccountType::CostOfSales)
        );
        assert_eq!(type_from_name("Bank Account"), None);
        assert_eq!(
            type_from_code("8-1000"),
            Some(SourceAccountType::OtherIncome)
        );
        assert_eq!(type_from_code("7-1000"), None);
    }
}
