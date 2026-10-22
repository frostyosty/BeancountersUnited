//! How an imported bank line reaches the ledger, before anyone sorts it.
//!
//! The rules are in `docs/domain.md` under "Bank statements to the ledger". Every line posts
//! straight away, conservatively:
//! - money in counts as income, split for GST when the owner is registered on that date;
//! - money out counts as nothing claimed: it goes to an equity holding account, never to an
//!   expense, and isn't split for GST.
//!
//! Save tax (M11) recodes lines by reversing and reposting them, so the figure only comes down.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};

use crate::chart::AccountCode;
use crate::ledger::JournalLine;
use crate::money::Money;
use crate::tax::gst::{gst_in_inclusive, gst_rate_bp};

/// The business's "not yet sorted" accounts, and its GST account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HoldingAccounts {
    /// Money in, not yet sorted: an income account.
    pub money_in: AccountCode,
    /// Money out, not yet sorted: an equity account, so nothing is claimed.
    pub money_out: AccountCode,
    /// GST collected and paid.
    pub gst: AccountCode,
}

/// The journal lines for one unsorted bank line (or a gap's change in balance), dated `date`.
/// `amount` is signed as the bank shows it: positive is money in. `gst_registered_from` is the
/// owner's GST registration date, if they're registered. A nil amount posts nothing.
pub fn unsorted_lines(
    bank: &AccountCode,
    date: NaiveDate,
    amount: Money,
    gst_registered_from: Option<NaiveDate>,
    holding: &HoldingAccounts,
) -> Vec<JournalLine> {
    let line = |account: &AccountCode, amount: Money| JournalLine {
        account: account.clone(),
        amount,
    };
    if amount.is_zero() {
        return Vec::new();
    }
    if amount < Money::ZERO {
        // Money out: debit "not yet sorted" (equity), credit the bank. Nothing is claimed.
        return vec![line(&holding.money_out, -amount), line(bank, amount)];
    }
    // Money in: debit the bank, credit income, less GST if registered on this date.
    let rate = gst_registered_from
        .filter(|&from| date >= from)
        .and_then(|_| gst_rate_bp(date));
    let gst = rate.map_or(Money::ZERO, |r| gst_in_inclusive(amount, r));
    let mut lines = vec![line(bank, amount)];
    if !gst.is_zero() {
        lines.push(line(&holding.gst, -gst));
    }
    lines.push(line(&holding.money_in, -(amount - gst)));
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn code(s: &str) -> AccountCode {
        s.parse().unwrap()
    }

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn holding() -> HoldingAccounts {
        HoldingAccounts {
            money_in: code("140"),
            money_out: code("965"),
            gst: code("810"),
        }
    }

    fn pairs(lines: &[JournalLine]) -> Vec<(&str, Money)> {
        lines
            .iter()
            .map(|l| (l.account.as_str(), l.amount))
            .collect()
    }

    /// The worked example's gap journal: a rise of 380.00 on 9 September, GST registered.
    #[test]
    fn money_in_is_income_less_gst() {
        let lines = unsorted_lines(
            &code("600.02"),
            d("2025-09-09"),
            m("380.00"),
            Some(d("2025-08-01")),
            &holding(),
        );
        assert_eq!(
            pairs(&lines),
            vec![
                ("600.02", m("380.00")),
                ("810", m("-49.57")),
                ("140", m("-330.43")),
            ]
        );
    }

    #[test]
    fn money_in_before_registering_is_all_income() {
        let reg = Some(d("2025-08-01"));
        let lines = unsorted_lines(
            &code("600.01"),
            d("2025-07-31"),
            m("115.00"),
            reg,
            &holding(),
        );
        assert_eq!(
            pairs(&lines),
            vec![("600.01", m("115.00")), ("140", m("-115.00"))]
        );
        let lines = unsorted_lines(
            &code("600.01"),
            d("2025-07-31"),
            m("115.00"),
            None,
            &holding(),
        );
        assert_eq!(
            pairs(&lines),
            vec![("600.01", m("115.00")), ("140", m("-115.00"))]
        );
    }

    /// Money out is never an expense and never claims GST until someone sorts it.
    #[test]
    fn money_out_claims_nothing() {
        let lines = unsorted_lines(
            &code("600.01"),
            d("2025-08-29"),
            m("-6.50"),
            Some(d("2025-08-01")),
            &holding(),
        );
        assert_eq!(
            pairs(&lines),
            vec![("965", m("6.50")), ("600.01", m("-6.50"))]
        );
    }

    #[test]
    fn nil_posts_nothing() {
        let lines = unsorted_lines(
            &code("600.01"),
            d("2025-08-29"),
            Money::ZERO,
            None,
            &holding(),
        );
        assert!(lines.is_empty());
    }

    proptest! {
        /// Every posting balances, touches the bank by exactly the amount, and never touches
        /// anything but the bank and the holding accounts.
        #[test]
        fn postings_balance(cents in -1_000_000_000i64..1_000_000_000, registered in any::<bool>()) {
            let h = holding();
            let bank = code("600.01");
            let reg = registered.then(|| d("2025-08-01"));
            let lines = unsorted_lines(&bank, d("2025-09-01"), Money::from_cents(cents), reg, &h);
            let total: Money = lines.iter().map(|l| l.amount).sum();
            prop_assert_eq!(total, Money::ZERO);
            let on_bank: Money = lines.iter().filter(|l| l.account == bank).map(|l| l.amount).sum();
            prop_assert_eq!(on_bank, Money::from_cents(cents));
            for l in &lines {
                prop_assert!([&bank, &h.money_in, &h.money_out, &h.gst].contains(&&l.account));
            }
            // Money out never reaches income or GST; money in never reaches "money out".
            if cents < 0 {
                prop_assert!(lines.iter().all(|l| l.account != h.money_in && l.account != h.gst));
            } else {
                prop_assert!(lines.iter().all(|l| l.account != h.money_out));
            }
        }
    }
}
