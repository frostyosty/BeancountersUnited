//! Account codes, accounts and a client's chart of accounts.

use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

/// The longest account code accepted, in characters.
pub const MAX_CODE_LEN: usize = 20;

/// An account code: one or more ASCII alphanumeric segments separated by `.`, such as `200`,
/// `200.01`, `1100` or `A100`. Letters are stored uppercase.
///
/// Codes sort segment by segment (see `docs/domain.md`): an all-digit segment compares as a number
/// and sorts before a segment containing letters, and a code that is a prefix of another sorts
/// first. So `200` < `200.01` < `1100`. Codes that differ only in leading zeros (`0200`, `200`)
/// are different codes; the one with fewer characters sorts first.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[serde(try_from = "String", into = "String")]
#[ts(export, as = "String")]
pub struct AccountCode(String);

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum AccountCodeError {
    #[error("account code is empty")]
    Empty,
    #[error("account code '{0}' is longer than {MAX_CODE_LEN} characters")]
    TooLong(String),
    #[error("account code '{0}' has an empty segment")]
    EmptySegment(String),
    #[error("account code '{0}' may only contain letters, digits and '.'")]
    InvalidCharacter(String),
}

impl AccountCode {
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn segments(&self) -> impl Iterator<Item = &str> {
        self.0.split('.')
    }
}

impl FromStr for AccountCode {
    type Err = AccountCodeError;

    fn from_str(input: &str) -> Result<AccountCode, AccountCodeError> {
        let s = input.trim();
        if s.is_empty() {
            return Err(AccountCodeError::Empty);
        }
        if s.len() > MAX_CODE_LEN {
            return Err(AccountCodeError::TooLong(s.to_owned()));
        }
        if !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.') {
            return Err(AccountCodeError::InvalidCharacter(s.to_owned()));
        }
        if s.split('.').any(str::is_empty) {
            return Err(AccountCodeError::EmptySegment(s.to_owned()));
        }
        Ok(AccountCode(s.to_ascii_uppercase()))
    }
}

impl TryFrom<String> for AccountCode {
    type Error = AccountCodeError;
    fn try_from(s: String) -> Result<AccountCode, AccountCodeError> {
        s.parse()
    }
}

impl From<AccountCode> for String {
    fn from(code: AccountCode) -> String {
        code.0
    }
}

impl fmt::Display for AccountCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

fn is_numeric(segment: &str) -> bool {
    segment.bytes().all(|b| b.is_ascii_digit())
}

/// Compares two segments. Numeric segments compare by value without parsing, so any length works.
fn cmp_segment(a: &str, b: &str) -> Ordering {
    match (is_numeric(a), is_numeric(b)) {
        (true, true) => {
            let a_trim = a.trim_start_matches('0');
            let b_trim = b.trim_start_matches('0');
            a_trim
                .len()
                .cmp(&b_trim.len())
                .then_with(|| a_trim.cmp(b_trim))
        }
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.cmp(b),
    }
}

impl Ord for AccountCode {
    fn cmp(&self, other: &AccountCode) -> Ordering {
        let mut a = self.segments();
        let mut b = other.segments();
        loop {
            match (a.next(), b.next()) {
                (None, None) => break,
                (None, Some(_)) => return Ordering::Less,
                (Some(_), None) => return Ordering::Greater,
                (Some(x), Some(y)) => match cmp_segment(x, y) {
                    Ordering::Equal => {}
                    ord => return ord,
                },
            }
        }
        // Equal by value (e.g. "0200" and "200"): fall back to the text so Ord agrees with Eq.
        self.0
            .len()
            .cmp(&other.0.len())
            .then_with(|| self.0.cmp(&other.0))
    }
}

impl AccountCode {
    /// Compares this code, cut to `other`'s number of segments, with `other`, by value only. So
    /// `299.05` against `299` is `Equal`: a sub-account compares equal to its parent. Mapping
    /// ranges use this so their upper code covers its own sub-accounts.
    pub fn cmp_truncated(&self, other: &AccountCode) -> Ordering {
        let mut a = self.segments();
        for y in other.segments() {
            match a.next() {
                None => return Ordering::Less,
                Some(x) => match cmp_segment(x, y) {
                    Ordering::Equal => {}
                    ord => return ord,
                },
            }
        }
        Ordering::Equal
    }
}

impl PartialOrd for AccountCode {
    fn partial_cmp(&self, other: &AccountCode) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AccountType {
    Asset,
    Liability,
    Equity,
    Income,
    Expense,
}

impl AccountType {
    /// Balance-sheet accounts carry forward at year end; the rest close to equity.
    pub const fn is_balance_sheet(self) -> bool {
        matches!(
            self,
            AccountType::Asset | AccountType::Liability | AccountType::Equity
        )
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Account {
    pub code: AccountCode,
    pub name: String,
    pub account_type: AccountType,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ChartError {
    #[error("account code {0} appears more than once")]
    DuplicateCode(AccountCode),
    #[error("account {0} has no name")]
    EmptyName(AccountCode),
}

/// A client's chart of accounts, kept sorted by code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(try_from = "Vec<Account>", into = "Vec<Account>")]
#[ts(export, as = "Vec<Account>")]
pub struct Chart {
    accounts: Vec<Account>,
}

impl Chart {
    pub fn new(mut accounts: Vec<Account>) -> Result<Chart, ChartError> {
        accounts.sort_by(|a, b| a.code.cmp(&b.code));
        if let Some(pair) = accounts.windows(2).find(|w| w[0].code == w[1].code) {
            return Err(ChartError::DuplicateCode(pair[0].code.clone()));
        }
        if let Some(account) = accounts.iter().find(|a| a.name.trim().is_empty()) {
            return Err(ChartError::EmptyName(account.code.clone()));
        }
        Ok(Chart { accounts })
    }

    pub fn get(&self, code: &AccountCode) -> Option<&Account> {
        self.accounts
            .binary_search_by(|a| a.code.cmp(code))
            .ok()
            .map(|i| &self.accounts[i])
    }

    /// Accounts in code order.
    pub fn accounts(&self) -> &[Account] {
        &self.accounts
    }
}

impl TryFrom<Vec<Account>> for Chart {
    type Error = ChartError;
    fn try_from(accounts: Vec<Account>) -> Result<Chart, ChartError> {
        Chart::new(accounts)
    }
}

impl From<Chart> for Vec<Account> {
    fn from(chart: Chart) -> Vec<Account> {
        chart.accounts
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use proptest::prelude::*;

    pub fn code(s: &str) -> AccountCode {
        s.parse().unwrap()
    }

    pub fn account(c: &str, name: &str, account_type: AccountType) -> Account {
        Account {
            code: code(c),
            name: name.to_owned(),
            account_type,
            active: true,
        }
    }

    #[test]
    fn parses_and_normalises_codes() {
        assert_eq!(code(" 200.01 ").as_str(), "200.01");
        assert_eq!(code("a100").as_str(), "A100");
        use AccountCodeError::*;
        let err = |s: &str| s.parse::<AccountCode>().unwrap_err();
        assert_eq!(err(""), Empty);
        assert!(matches!(err("200."), EmptySegment(_)));
        assert!(matches!(err(".5"), EmptySegment(_)));
        assert!(matches!(err("2..1"), EmptySegment(_)));
        assert!(matches!(err("200-01"), InvalidCharacter(_)));
        assert!(matches!(err("20 0"), InvalidCharacter(_)));
        assert!(matches!(err("1234567890.1234567890"), TooLong(_)));
    }

    #[test]
    fn sorts_by_numeric_segments() {
        let mut codes: Vec<AccountCode> = [
            "1100", "200.01", "A100", "200", "90", "200.2", "200.10", "200.A", "0200", "B",
            "200.01.5",
        ]
        .into_iter()
        .map(code)
        .collect();
        codes.sort();
        let sorted: Vec<&str> = codes.iter().map(AccountCode::as_str).collect();
        assert_eq!(
            sorted,
            [
                "90", "200", "0200", "200.01", "200.01.5", "200.2", "200.10", "200.A", "1100",
                "A100", "B"
            ]
        );
    }

    #[test]
    fn chart_sorts_and_rejects_duplicates_and_blank_names() {
        let chart = Chart::new(vec![
            account("1100", "Bank", AccountType::Asset),
            account("200", "Sales", AccountType::Income),
        ])
        .unwrap();
        let codes: Vec<&str> = chart.accounts().iter().map(|a| a.code.as_str()).collect();
        assert_eq!(codes, ["200", "1100"]);
        assert_eq!(chart.get(&code("1100")).unwrap().name, "Bank");
        assert!(chart.get(&code("300")).is_none());

        let dup = Chart::new(vec![
            account("200", "Sales", AccountType::Income),
            account("200", "Other sales", AccountType::Income),
        ]);
        assert_eq!(dup, Err(ChartError::DuplicateCode(code("200"))));

        let blank = Chart::new(vec![account("200", "  ", AccountType::Income)]);
        assert_eq!(blank, Err(ChartError::EmptyName(code("200"))));
    }

    #[test]
    fn chart_json_is_a_sorted_list_and_validates_on_read() {
        let chart = Chart::new(vec![
            account("1100", "Bank", AccountType::Asset),
            account("200", "Sales", AccountType::Income),
        ])
        .unwrap();
        let json = serde_json::to_string(&chart).unwrap();
        assert_eq!(
            json,
            r#"[{"code":"200","name":"Sales","account_type":"income","active":true},{"code":"1100","name":"Bank","account_type":"asset","active":true}]"#
        );
        assert_eq!(serde_json::from_str::<Chart>(&json).unwrap(), chart);

        let dup = r#"[{"code":"200","name":"A","account_type":"income","active":true},{"code":"200","name":"B","account_type":"income","active":true}]"#;
        assert!(serde_json::from_str::<Chart>(dup).is_err());
        assert!(serde_json::from_str::<AccountCode>(r#""2..0""#).is_err());
    }

    fn arb_code() -> impl Strategy<Value = AccountCode> {
        proptest::collection::vec("[0-9]{1,4}|[A-Z][0-9A-Z]{0,2}", 1..4)
            .prop_map(|segs| segs.join("."))
            .prop_filter("fits", |s| s.len() <= MAX_CODE_LEN)
            .prop_map(|s| s.parse().unwrap())
    }

    proptest! {
        #[test]
        fn ord_is_a_total_order_consistent_with_eq(a in arb_code(), b in arb_code(), c in arb_code()) {
            prop_assert_eq!(a.cmp(&b) == Ordering::Equal, a == b);
            prop_assert_eq!(a.cmp(&b), b.cmp(&a).reverse());
            if a <= b && b <= c {
                prop_assert!(a <= c);
            }
        }

        #[test]
        fn single_numeric_segments_sort_as_numbers(x in 0u32..100_000, y in 0u32..100_000) {
            prop_assert_eq!(code(&x.to_string()).cmp(&code(&y.to_string())), x.cmp(&y));
        }
    }
}
