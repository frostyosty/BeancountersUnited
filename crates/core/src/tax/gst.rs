//! GST: the rate by date, the split of a GST-inclusive amount, filing periods, and the return.
//!
//! The rules are in `docs/domain.md` under "GST". M10 supports the payments basis and a 31 March
//! balance date only.

use chrono::{Datelike, Months, NaiveDate};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::money::{Money, div_round_half_away, money_from_i128};

/// Basis points in 100%.
const BP: i128 = 10_000;

/// The GST rate from each date onward, oldest first. Versioned data, not a practice setting.
/// A date before the first entry has no rate, and gets no GST figure.
const GST_RATES: &[(i32, u32, u32, u32)] = &[
    // (year, month, day, rate_bp)
    (2010, 10, 1, 1500),
];

/// The GST rate in basis points on `date`, or `None` if we hold no rate for it.
pub fn gst_rate_bp(date: NaiveDate) -> Option<u32> {
    GST_RATES
        .iter()
        .rev()
        .find(|&&(y, m, d, _)| date >= ymd(y, m, d))
        .map(|&(_, _, _, rate)| rate)
}

/// The GST inside a GST-inclusive amount: amount Ã— rate Ã· (100% + rate), rounded half away from
/// zero to cents. At 15% that's amount Ã— 3 Ã· 23. Negative amounts give negative GST.
pub fn gst_in_inclusive(amount: Money, rate_bp: u32) -> Money {
    let rate = i128::from(rate_bp);
    money_from_i128(div_round_half_away(
        i128::from(amount.cents()) * rate,
        BP + rate,
    ))
}

/// How often the owner files GST. M10 supports a 31 March balance date only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GstFrequency {
    Monthly,
    /// Two-monthly, ending in January, March, May, July, September and November. What IRD gives a
    /// 31 March balance date.
    TwoMonthlyOdd,
    /// Two-monthly, ending in even months, if that's what IRD has on record.
    TwoMonthlyEven,
    /// Ending 30 September and 31 March.
    SixMonthly,
}

impl GstFrequency {
    fn months(self) -> u32 {
        match self {
            GstFrequency::Monthly => 1,
            GstFrequency::TwoMonthlyOdd | GstFrequency::TwoMonthlyEven => 2,
            GstFrequency::SixMonthly => 6,
        }
    }

    /// Whether a period ends at the end of `month` (1â€“12).
    fn ends_in(self, month: u32) -> bool {
        match self {
            GstFrequency::Monthly => true,
            GstFrequency::TwoMonthlyOdd => month % 2 == 1,
            GstFrequency::TwoMonthlyEven => month.is_multiple_of(2),
            GstFrequency::SixMonthly => month == 3 || month == 9,
        }
    }
}

/// A GST period, both ends included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct GstPeriod {
    pub start: NaiveDate,
    pub end: NaiveDate,
}

/// The GST period containing `date`, or `None` before the owner registered. The first period runs
/// from the registration date to the end of the period it falls in.
pub fn gst_period(
    date: NaiveDate,
    frequency: GstFrequency,
    registered_from: NaiveDate,
) -> Option<GstPeriod> {
    if date < registered_from {
        return None;
    }
    let mut end_month = first_of_month(date);
    while !frequency.ends_in(end_month.month()) {
        end_month = end_month + Months::new(1);
    }
    let end = end_month + Months::new(1) - chrono::Days::new(1);
    let full_start = end_month - Months::new(frequency.months() - 1);
    Some(GstPeriod {
        start: full_start.max(registered_from),
        end,
    })
}

/// A period's totals, as the return needs them. Amounts are GST-inclusive and positive for
/// money in (sales) and money out (purchases) alike.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct GstTotals {
    /// Sales and income, zero-rated included.
    pub sales: Money,
    /// Zero-rated supplies included in `sales`.
    pub zero_rated: Money,
    /// Debit adjustments (box 9).
    pub adjustments: Money,
    /// Purchases and expenses with a standard GST code.
    pub purchases: Money,
    /// Credit adjustments (box 13).
    pub credit_adjustments: Money,
}

/// A GST return's boxes, computed on the period's totals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GstReturn {
    pub period: GstPeriod,
    pub rate_bp: u32,
    pub box5: Money,
    pub box6: Money,
    pub box7: Money,
    pub box8: Money,
    pub box9: Money,
    pub box10: Money,
    pub box11: Money,
    pub box12: Money,
    pub box13: Money,
    pub box14: Money,
    /// To pay if positive, a refund if negative.
    pub box15: Money,
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum GstError {
    #[error("we don't hold a GST rate for {date}")]
    NoRate { date: NaiveDate },
    #[error("the GST rate changes between {start} and {end}, which this return can't handle")]
    RateChangesInPeriod { start: NaiveDate, end: NaiveDate },
}

/// The return for `period`, from its totals. Boxes 8 and 12 round half away from zero to cents.
pub fn gst_return(period: GstPeriod, totals: &GstTotals) -> Result<GstReturn, GstError> {
    let rate_bp = gst_rate_bp(period.start).ok_or(GstError::NoRate { date: period.start })?;
    let rate_changes = GST_RATES
        .iter()
        .any(|&(y, m, d, _)| period.start < ymd(y, m, d) && ymd(y, m, d) <= period.end);
    if rate_changes {
        return Err(GstError::RateChangesInPeriod {
            start: period.start,
            end: period.end,
        });
    }

    let box5 = totals.sales;
    let box6 = totals.zero_rated;
    let box7 = box5 - box6;
    let box8 = gst_in_inclusive(box7, rate_bp);
    let box9 = totals.adjustments;
    let box10 = box8 + box9;
    let box11 = totals.purchases;
    let box12 = gst_in_inclusive(box11, rate_bp);
    let box13 = totals.credit_adjustments;
    let box14 = box12 + box13;
    Ok(GstReturn {
        period,
        rate_bp,
        box5,
        box6,
        box7,
        box8,
        box9,
        box10,
        box11,
        box12,
        box13,
        box14,
        box15: box10 - box14,
    })
}

fn ymd(y: i32, m: u32, d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(y, m, d).expect("valid date in GST data")
}

fn first_of_month(date: NaiveDate) -> NaiveDate {
    ymd(date.year(), date.month(), 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    #[test]
    fn rate_by_date() {
        assert_eq!(gst_rate_bp(d("2010-09-30")), None);
        assert_eq!(gst_rate_bp(d("2010-10-01")), Some(1500));
        assert_eq!(gst_rate_bp(d("2025-08-01")), Some(1500));
    }

    #[test]
    fn splits_inclusive_amounts_at_three_twenty_thirds() {
        // The worked example's gap journal: 380.00 holds 49.57 of GST (49.565 rounds up).
        assert_eq!(gst_in_inclusive(m("380.00"), 1500), m("49.57"));
        assert_eq!(gst_in_inclusive(m("115.00"), 1500), m("15.00"));
        assert_eq!(gst_in_inclusive(m("-380.00"), 1500), m("-49.57"));
        assert_eq!(gst_in_inclusive(Money::ZERO, 1500), Money::ZERO);
    }

    #[test]
    fn periods_two_monthly_odd() {
        let reg = d("2025-08-01");
        let f = GstFrequency::TwoMonthlyOdd;
        // Registered on 1 August: the first period is 1 August to 30 September.
        let p = gst_period(d("2025-08-15"), f, reg).unwrap();
        assert_eq!((p.start, p.end), (d("2025-08-01"), d("2025-09-30")));
        let p = gst_period(d("2025-09-30"), f, reg).unwrap();
        assert_eq!((p.start, p.end), (d("2025-08-01"), d("2025-09-30")));
        let p = gst_period(d("2025-12-31"), f, reg).unwrap();
        assert_eq!((p.start, p.end), (d("2025-12-01"), d("2026-01-31")));
        assert_eq!(gst_period(d("2025-07-31"), f, reg), None);
        // Registered mid-month: the first period starts on that day.
        let p = gst_period(d("2025-08-20"), f, d("2025-08-10")).unwrap();
        assert_eq!((p.start, p.end), (d("2025-08-10"), d("2025-09-30")));
    }

    #[test]
    fn periods_other_frequencies() {
        let reg = d("2020-01-01");
        let p = gst_period(d("2024-02-10"), GstFrequency::Monthly, reg).unwrap();
        assert_eq!((p.start, p.end), (d("2024-02-01"), d("2024-02-29")));
        let p = gst_period(d("2025-08-15"), GstFrequency::TwoMonthlyEven, reg).unwrap();
        assert_eq!((p.start, p.end), (d("2025-07-01"), d("2025-08-31")));
        let p = gst_period(d("2025-08-15"), GstFrequency::SixMonthly, reg).unwrap();
        assert_eq!((p.start, p.end), (d("2025-04-01"), d("2025-09-30")));
        let p = gst_period(d("2025-11-15"), GstFrequency::SixMonthly, reg).unwrap();
        assert_eq!((p.start, p.end), (d("2025-10-01"), d("2026-03-31")));
    }

    /// The worked example's first period: every deposit is a sale, nothing is claimed.
    #[test]
    fn worked_example_return() {
        let period = GstPeriod {
            start: d("2025-08-01"),
            end: d("2025-09-30"),
        };
        let totals = GstTotals {
            sales: m("4,367.08"),
            ..GstTotals::default()
        };
        let r = gst_return(period, &totals).unwrap();
        assert_eq!(r.box5, m("4,367.08"));
        assert_eq!(r.box7, m("4,367.08"));
        assert_eq!(r.box8, m("569.62"));
        assert_eq!(r.box10, m("569.62"));
        assert_eq!(r.box12, Money::ZERO);
        assert_eq!(r.box15, m("569.62"));
    }

    #[test]
    fn purchases_reduce_the_return() {
        let period = GstPeriod {
            start: d("2025-08-01"),
            end: d("2025-09-30"),
        };
        let totals = GstTotals {
            sales: m("1,150.00"),
            zero_rated: m("150.00"),
            purchases: m("2,300.00"),
            ..GstTotals::default()
        };
        let r = gst_return(period, &totals).unwrap();
        assert_eq!(r.box7, m("1,000.00"));
        assert_eq!(r.box8, m("130.43"));
        assert_eq!(r.box12, m("300.00"));
        assert_eq!(r.box15, m("-169.57"));
    }

    #[test]
    fn no_rate_before_the_table() {
        let period = GstPeriod {
            start: d("2009-04-01"),
            end: d("2009-05-31"),
        };
        assert_eq!(
            gst_return(period, &GstTotals::default()),
            Err(GstError::NoRate {
                date: d("2009-04-01")
            })
        );
        // A period that straddles the start of the table also has a rate change in it.
        let period = GstPeriod {
            start: d("2010-09-01"),
            end: d("2010-10-31"),
        };
        assert!(gst_return(period, &GstTotals::default()).is_err());
    }

    proptest! {
        /// The split never takes more than the amount, and keeps its sign.
        #[test]
        fn split_is_bounded(cents in -1_000_000_000_000i64..1_000_000_000_000) {
            let gst = gst_in_inclusive(Money::from_cents(cents), 1500).cents();
            prop_assert!(gst.abs() <= cents.abs());
            prop_assert!(gst == 0 || gst.signum() == cents.signum());
        }

        /// Every date after registration is in exactly the period it reports, and periods tile:
        /// the next day is in the next period or the same one.
        #[test]
        fn periods_tile(offset in 0u64..4000, freq in 0usize..4) {
            let f = [GstFrequency::Monthly, GstFrequency::TwoMonthlyOdd,
                     GstFrequency::TwoMonthlyEven, GstFrequency::SixMonthly][freq];
            let reg = d("2015-05-17");
            let date = reg + chrono::Days::new(offset);
            let p = gst_period(date, f, reg).unwrap();
            prop_assert!(p.start <= date && date <= p.end);
            let next = gst_period(date + chrono::Days::new(1), f, reg).unwrap();
            prop_assert!(next == p || next.start == p.end + chrono::Days::new(1));
        }
    }
}
