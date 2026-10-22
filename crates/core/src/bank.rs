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

/// The days one statement covers, both ends included, with the balances it gives (stated or
/// worked out from its lines).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coverage {
    pub start: NaiveDate,
    pub end: NaiveDate,
    /// The balance before `start`.
    pub opening: Option<Money>,
    /// The balance at the end of `end`.
    pub closing: Option<Money>,
}

/// A run of days no statement covers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gap {
    pub start: NaiveDate,
    pub end: NaiveDate,
    /// The change in balance across the gap, when the balance at both ends is known. A gap
    /// journal posts it on `end`; without it, the gap is only flagged.
    pub change: Option<Money>,
}

/// The gaps in one bank account's statements, from `start` (the account's start date, with
/// `opening` the balance then, if known) to the end of the latest statement. Statements may
/// overlap and arrive in any order; days before `start` are ignored.
pub fn gaps(start: NaiveDate, opening: Option<Money>, statements: &[Coverage]) -> Vec<Gap> {
    let mut sorted: Vec<&Coverage> = statements.iter().filter(|s| s.end >= start).collect();
    sorted.sort_by_key(|s| (s.start, s.end));
    let mut out = Vec::new();
    // The first day not yet covered, and the balance before it.
    let mut cursor = start;
    let mut balance = opening;
    for s in sorted {
        if s.start > cursor {
            let end = s
                .start
                .pred_opt()
                .expect("a date after the cursor has a day before it");
            let change = match (balance, s.opening) {
                (Some(before), Some(after)) => Some(after - before),
                _ => None,
            };
            out.push(Gap {
                start: cursor,
                end,
                change,
            });
        }
        if s.end >= cursor {
            cursor = s
                .end
                .succ_opt()
                .expect("a statement ends before the end of time");
            balance = s.closing;
        }
    }
    out
}

/// A bank line, as the detectors below need it. `account` tells the business's accounts apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineFacts<'a> {
    pub account: &'a str,
    pub date: NaiveDate,
    pub amount: Money,
    pub description: &'a str,
}

/// How far apart, in days, the two sides of a transfer between the owner's accounts can post.
pub const TRANSFER_WINDOW_DAYS: i64 = 3;

/// Likely transfers between the owner's own accounts: the same amount with opposite signs, in two
/// different accounts, posted at most [`TRANSFER_WINDOW_DAYS`] apart. Each line pairs at most
/// once, with the nearest date first. Returns (money out, money in) index pairs, in order.
/// Detected only: until the owner confirms, both lines stay as income and drawings.
pub fn transfer_pairs(lines: &[LineFacts<'_>]) -> Vec<(usize, usize)> {
    let mut candidates: Vec<(i64, usize, usize)> = Vec::new();
    for (o, out) in lines.iter().enumerate() {
        if out.amount >= Money::ZERO {
            continue;
        }
        for (i, inn) in lines.iter().enumerate() {
            let days = (inn.date - out.date).num_days().abs();
            if inn.amount == -out.amount
                && inn.account != out.account
                && days <= TRANSFER_WINDOW_DAYS
            {
                candidates.push((days, o, i));
            }
        }
    }
    candidates.sort();
    let mut used = vec![false; lines.len()];
    let mut pairs = Vec::new();
    for (_, o, i) in candidates {
        if !used[o] && !used[i] {
            used[o] = true;
            used[i] = true;
            pairs.push((o, i));
        }
    }
    pairs.sort();
    pairs
}

/// Whether a normalised description looks like a payment to or from IRD: the word `IRD` or the
/// words `INLAND REVENUE`. Detected only; the owner says what each one was.
pub fn looks_like_ird(description: &str) -> bool {
    description.split_whitespace().any(|w| w == "IRD") || description.contains("INLAND REVENUE")
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

    fn cov(start: &str, end: &str, opening: Option<&str>, closing: Option<&str>) -> Coverage {
        Coverage {
            start: d(start),
            end: d(end),
            opening: opening.map(m),
            closing: closing.map(m),
        }
    }

    /// The worked example's Kowhai account: August, then September from the 10th.
    #[test]
    fn gap_with_known_balances_has_a_change() {
        let statements = [
            cov(
                "2025-09-10",
                "2025-09-30",
                Some("2,480.01"),
                Some("2,830.73"),
            ),
            cov(
                "2025-08-01",
                "2025-08-31",
                Some("1,250.00"),
                Some("2,100.01"),
            ),
        ];
        let found = gaps(d("2025-08-01"), Some(m("1,250.00")), &statements);
        assert_eq!(
            found,
            vec![Gap {
                start: d("2025-09-01"),
                end: d("2025-09-09"),
                change: Some(m("380.00")),
            }]
        );
    }

    /// The worked example's Rimu account: the owner gave the balance on 1 August, but the
    /// statement from 29 August has no balances, so the gap has no amount.
    #[test]
    fn gap_with_an_unknown_end_is_only_flagged() {
        let statements = [cov("2025-08-29", "2025-09-30", None, None)];
        let found = gaps(d("2025-08-01"), Some(m("1,000.00")), &statements);
        assert_eq!(
            found,
            vec![Gap {
                start: d("2025-08-01"),
                end: d("2025-08-28"),
                change: None,
            }]
        );
    }

    /// The worked example's Harbourlight account: OFX for August, then a QIF that overlaps it.
    #[test]
    fn overlapping_statements_leave_no_gap() {
        let statements = [
            cov(
                "2025-08-01",
                "2025-08-31",
                Some("2,000.00"),
                Some("2,022.56"),
            ),
            cov(
                "2025-08-29",
                "2025-09-30",
                Some("1,883.56"),
                Some("2,247.12"),
            ),
        ];
        assert!(gaps(d("2025-08-01"), Some(m("2,000.00")), &statements).is_empty());
        // A statement wholly inside another changes nothing either.
        let mut more = statements.to_vec();
        more.push(cov("2025-08-05", "2025-08-10", None, None));
        assert!(gaps(d("2025-08-01"), Some(m("2,000.00")), &more).is_empty());
    }

    fn facts<'a>(
        account: &'a str,
        date: &str,
        amount: &str,
        description: &'a str,
    ) -> LineFacts<'a> {
        LineFacts {
            account,
            date: d(date),
            amount: m(amount),
            description,
        }
    }

    #[test]
    fn pairs_transfers_between_own_accounts() {
        let lines = [
            facts(
                "600.01",
                "2025-08-22",
                "-500.00",
                "TRANSFER TO 99-5501-0000456-00 OWN ACCOUNT",
            ),
            facts(
                "600.02",
                "2025-08-22",
                "500.00",
                "TRANSFER FROM 99-1001-0000123-00",
            ),
            // Same amount, but in the same account: not a transfer.
            facts("600.02", "2025-08-23", "-500.00", "SOMETHING"),
            // Opposite amount, but four days later.
            facts("600.03", "2025-09-22", "150.00", "X"),
            facts("600.01", "2025-09-18", "-150.00", "Y"),
        ];
        assert_eq!(transfer_pairs(&lines), vec![(0, 1)]);
    }

    #[test]
    fn spots_ird() {
        assert!(looks_like_ird("IRD GST REFUND"));
        assert!(looks_like_ird("PAYMENT TO INLAND REVENUE DEPT"));
        assert!(!looks_like_ird("BIRDSEED SUPPLIES"));
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
