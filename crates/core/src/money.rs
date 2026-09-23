//! Money as whole cents.
//!
//! Amounts are signed: debits are positive and credits negative. Arithmetic panics on overflow
//! rather than wrapping, because a wrong amount is worse than a stopped command.

use std::fmt;
use std::iter::Sum;
use std::ops::{Add, AddAssign, Neg, Sub, SubAssign};
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

/// An amount in cents.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS,
)]
#[ts(export)]
pub struct Money(i64);

impl Money {
    pub const ZERO: Money = Money(0);

    pub const fn from_cents(cents: i64) -> Money {
        Money(cents)
    }

    pub const fn cents(self) -> i64 {
        self.0
    }

    pub const fn is_zero(self) -> bool {
        self.0 == 0
    }

    pub fn checked_add(self, rhs: Money) -> Option<Money> {
        self.0.checked_add(rhs.0).map(Money)
    }

    pub fn checked_sub(self, rhs: Money) -> Option<Money> {
        self.0.checked_sub(rhs.0).map(Money)
    }

    pub fn checked_neg(self) -> Option<Money> {
        self.0.checked_neg().map(Money)
    }

    /// Whole dollars, rounding half away from zero: 0.50 → 1, −0.50 → −1, 0.49 → 0.
    pub const fn round_to_dollars(self) -> i64 {
        let dollars = self.0 / 100;
        let rem = self.0 % 100; // same sign as self.0
        if rem >= 50 {
            dollars + 1
        } else if rem <= -50 {
            dollars - 1
        } else {
            dollars
        }
    }
}

impl Add for Money {
    type Output = Money;
    fn add(self, rhs: Money) -> Money {
        self.checked_add(rhs).expect("Money overflow in add")
    }
}

impl Sub for Money {
    type Output = Money;
    fn sub(self, rhs: Money) -> Money {
        self.checked_sub(rhs).expect("Money overflow in sub")
    }
}

impl Neg for Money {
    type Output = Money;
    fn neg(self) -> Money {
        self.checked_neg().expect("Money overflow in neg")
    }
}

impl AddAssign for Money {
    fn add_assign(&mut self, rhs: Money) {
        *self = *self + rhs;
    }
}

impl SubAssign for Money {
    fn sub_assign(&mut self, rhs: Money) {
        *self = *self - rhs;
    }
}

impl Sum for Money {
    fn sum<I: Iterator<Item = Money>>(iter: I) -> Money {
        iter.fold(Money::ZERO, Add::add)
    }
}

impl<'a> Sum<&'a Money> for Money {
    fn sum<I: Iterator<Item = &'a Money>>(iter: I) -> Money {
        iter.copied().sum()
    }
}

/// Formats as `-1,234.56`: a leading minus, thousands commas and always two decimals.
/// [`Money::from_str`] accepts this format back.
impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let abs = self.0.unsigned_abs();
        let digits = (abs / 100).to_string();
        let mut grouped = String::with_capacity(digits.len() + digits.len() / 3);
        for (i, ch) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i).is_multiple_of(3) {
                grouped.push(',');
            }
            grouped.push(ch);
        }
        let sign = if self.0 < 0 { "-" } else { "" };
        write!(f, "{sign}{grouped}.{:02}", abs % 100)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ParseMoneyError {
    #[error("amount is empty")]
    Empty,
    #[error("'{0}' is not an amount")]
    Invalid(String),
    #[error("'{0}' has misplaced thousands separators")]
    BadGrouping(String),
    #[error("'{0}' has more than two decimal places")]
    TooManyDecimals(String),
    #[error("'{0}' is too large")]
    Overflow(String),
}

/// Parses amounts as people type them or accounting exports write them:
/// `1234.5`, `-1,234.56`, `$1,234.56`, `-$5`, `(1,234.56)` (brackets mean negative), `.75`.
///
/// Surrounding whitespace is ignored. More than two decimal places is an error, never rounded.
impl FromStr for Money {
    type Err = ParseMoneyError;

    fn from_str(input: &str) -> Result<Money, ParseMoneyError> {
        let invalid = || ParseMoneyError::Invalid(input.to_owned());
        let s = input.trim();
        if s.is_empty() {
            return Err(ParseMoneyError::Empty);
        }

        let (negative, s) = if let Some(inner) = s.strip_prefix('(') {
            (true, inner.strip_suffix(')').ok_or_else(invalid)?.trim())
        } else if let Some(rest) = s.strip_prefix('-') {
            (true, rest)
        } else {
            (false, s)
        };
        let s = s.strip_prefix('$').unwrap_or(s);

        let (int_part, frac_part) = match s.split_once('.') {
            Some((i, f)) => (i, Some(f)),
            None => (s, None),
        };

        let int_digits: String = if int_part.contains(',') {
            let mut groups = int_part.split(',');
            let first = groups.next().unwrap_or_default();
            let first_ok = (1..=3).contains(&first.len());
            if !first_ok || groups.clone().any(|g| g.len() != 3) {
                return Err(ParseMoneyError::BadGrouping(input.to_owned()));
            }
            int_part.chars().filter(|&c| c != ',').collect()
        } else {
            int_part.to_owned()
        };

        let frac = frac_part.unwrap_or("");
        if int_digits.is_empty() && frac.is_empty() {
            return Err(invalid());
        }
        if frac_part.is_some() && frac.is_empty() {
            return Err(invalid());
        }
        if !int_digits.bytes().all(|b| b.is_ascii_digit())
            || !frac.bytes().all(|b| b.is_ascii_digit())
        {
            return Err(invalid());
        }
        if frac.len() > 2 {
            return Err(ParseMoneyError::TooManyDecimals(input.to_owned()));
        }

        let overflow = || ParseMoneyError::Overflow(input.to_owned());
        let dollars: i64 = if int_digits.is_empty() {
            0
        } else {
            int_digits.parse().map_err(|_| overflow())?
        };
        let cents: i64 = match frac.len() {
            0 => 0,
            1 => frac.parse::<i64>().map_err(|_| invalid())? * 10,
            _ => frac.parse().map_err(|_| invalid())?,
        };
        let total = dollars
            .checked_mul(100)
            .and_then(|d| d.checked_add(cents))
            .ok_or_else(overflow)?;
        Ok(Money(if negative { -total } else { total }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    #[test]
    fn rounds_half_away_from_zero() {
        let cases = [
            (0, 0),
            (49, 0),
            (50, 1),
            (99, 1),
            (150, 2),
            (-49, 0),
            (-50, -1),
            (-150, -2),
            (12_049, 120),
            (12_050, 121),
        ];
        for (cents, dollars) in cases {
            assert_eq!(
                Money::from_cents(cents).round_to_dollars(),
                dollars,
                "{cents} cents"
            );
        }
    }

    #[test]
    fn arithmetic() {
        let a = Money::from_cents(1_050);
        let b = Money::from_cents(-300);
        assert_eq!(a + b, Money::from_cents(750));
        assert_eq!(a - b, Money::from_cents(1_350));
        assert_eq!(-a, Money::from_cents(-1_050));
        assert_eq!([a, b, b].iter().sum::<Money>(), Money::from_cents(450));
        assert_eq!(
            Money::from_cents(i64::MAX).checked_add(Money::from_cents(1)),
            None
        );
    }

    #[test]
    #[should_panic(expected = "Money overflow")]
    fn overflow_panics_instead_of_wrapping() {
        let _ = Money::from_cents(i64::MAX) + Money::from_cents(1);
    }

    #[test]
    fn formats_with_commas_and_two_decimals() {
        assert_eq!(Money::ZERO.to_string(), "0.00");
        assert_eq!(Money::from_cents(5).to_string(), "0.05");
        assert_eq!(Money::from_cents(-5).to_string(), "-0.05");
        assert_eq!(Money::from_cents(123_456).to_string(), "1,234.56");
        assert_eq!(Money::from_cents(-100_000_000).to_string(), "-1,000,000.00");
        assert_eq!(
            Money::from_cents(i64::MIN).to_string(),
            "-92,233,720,368,547,758.08"
        );
    }

    #[test]
    fn parses_common_forms() {
        assert_eq!(m("0"), Money::ZERO);
        assert_eq!(m("-0"), Money::ZERO);
        assert_eq!(m("12"), Money::from_cents(1_200));
        assert_eq!(m("12.5"), Money::from_cents(1_250));
        assert_eq!(m("12.05"), Money::from_cents(1_205));
        assert_eq!(m(".75"), Money::from_cents(75));
        assert_eq!(m("-.75"), Money::from_cents(-75));
        assert_eq!(m("1,234.56"), Money::from_cents(123_456));
        assert_eq!(m("  -1,234,567.8 "), Money::from_cents(-123_456_780));
        assert_eq!(m("$1,234.56"), Money::from_cents(123_456));
        assert_eq!(m("-$5"), Money::from_cents(-500));
        assert_eq!(m("(1,234.56)"), Money::from_cents(-123_456));
        assert_eq!(m("( $20.00 )"), Money::from_cents(-2_000));
    }

    #[test]
    fn rejects_bad_input() {
        use ParseMoneyError::*;
        let err = |s: &str| s.parse::<Money>().unwrap_err();
        assert_eq!(err(""), Empty);
        assert_eq!(err("   "), Empty);
        for bad in [
            "abc", "1.2.3", "--5", "1e5", "12.", ".", "-", "(5", "5)", "(-5)", "1 000", "+5", "$-5",
        ] {
            assert!(
                matches!(err(bad), Invalid(_)),
                "{bad:?} gave {:?}",
                err(bad)
            );
        }
        for bad in ["1,23", "12,345,67", ",123", "1234,567", "1,,234"] {
            assert!(
                matches!(err(bad), BadGrouping(_)),
                "{bad:?} gave {:?}",
                err(bad)
            );
        }
        assert!(matches!(err("1.234"), TooManyDecimals(_)));
        assert!(matches!(err("99999999999999999999"), Overflow(_)));
        assert!(matches!(err("92233720368547758.08"), Overflow(_)));
    }

    #[test]
    fn serialises_as_plain_cents() {
        assert_eq!(
            serde_json::to_string(&Money::from_cents(-1_250)).unwrap(),
            "-1250"
        );
        assert_eq!(
            serde_json::from_str::<Money>("1250").unwrap(),
            Money::from_cents(1_250)
        );
    }

    proptest! {
        #[test]
        fn format_then_parse_round_trips(cents in (i64::MIN + 1)..=i64::MAX) {
            let money = Money::from_cents(cents);
            prop_assert_eq!(money.to_string().parse::<Money>().unwrap(), money);
        }

        #[test]
        fn rounding_matches_reference(cents in any::<i64>()) {
            // Reference: add half a dollar towards the sign, then truncate, in i128.
            let c = i128::from(cents);
            let expected = (c + if c < 0 { -50 } else { 50 }) / 100;
            prop_assert_eq!(i128::from(Money::from_cents(cents).round_to_dollars()), expected);
        }

        #[test]
        fn rounding_is_symmetric(cents in (i64::MIN + 1)..=i64::MAX) {
            let m = Money::from_cents(cents);
            prop_assert_eq!((-m).round_to_dollars(), -m.round_to_dollars());
        }
    }
}
