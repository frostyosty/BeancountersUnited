//! Income tax and student loan for a sole trader's income year.
//!
//! The rules are in `docs/domain.md` under "Income tax for sole traders". The figure starts
//! conservative, at the top rate flat and a student loan on every dollar, and only comes down as
//! the owner answers questions.

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::money::{Money, div_round_half_away, money_from_i128};

const BP: i128 = 10_000;

/// The student loan repayment rate on income over the threshold.
pub const STUDENT_LOAN_RATE_BP: u32 = 1200;

/// An income year, named by the year it ends in: 2026 runs from 1 April 2025 to 31 March 2026.
/// M10 supports a 31 March balance date only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct IncomeYear(pub i32);

impl IncomeYear {
    /// The income year containing `date`.
    pub fn containing(date: NaiveDate) -> IncomeYear {
        if date.month() >= 4 {
            IncomeYear(date.year() + 1)
        } else {
            IncomeYear(date.year())
        }
    }

    pub fn start(self) -> NaiveDate {
        NaiveDate::from_ymd_opt(self.0 - 1, 4, 1).expect("valid income year")
    }

    pub fn end(self) -> NaiveDate {
        NaiveDate::from_ymd_opt(self.0, 3, 31).expect("valid income year")
    }
}

/// One band of a rate table: `rate_bp` applies to taxable income above `from`, up to and
/// including `to` (no upper end if `None`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Band {
    pub from: Money,
    pub to: Option<Money>,
    pub rate_bp: u32,
}

const fn band(from: i64, to: Option<i64>, rate_bp: u32) -> Band {
    Band {
        from: Money::from_cents(from),
        to: match to {
            Some(t) => Some(Money::from_cents(t)),
            None => None,
        },
        rate_bp,
    }
}

/// IRD's individual rates from 1 April 2025 (`docs/domain.md` records the source).
const BANDS_FROM_2026: &[Band] = &[
    band(0, Some(1_560_000), 1050),
    band(1_560_000, Some(5_350_000), 1750),
    band(5_350_000, Some(7_810_000), 3000),
    band(7_810_000, Some(18_000_000), 3300),
    band(18_000_000, None, 3900),
];

/// The rate table for an income year, or `None` if we don't hold one. We never guess a rate.
pub fn rate_table(year: IncomeYear) -> Option<&'static [Band]> {
    match year.0 {
        2026 | 2027 => Some(BANDS_FROM_2026),
        _ => None,
    }
}

/// The student loan repayment threshold for a year, or `None` if we don't hold one.
pub fn student_loan_threshold(year: IncomeYear) -> Option<Money> {
    match year.0 {
        2026 | 2027 => Some(Money::from_cents(2_412_800)),
        _ => None,
    }
}

/// Tax on `taxable` through `bands`: each band exactly, summed, then rounded once to cents.
/// A loss pays no tax.
pub fn tax_on_bands(taxable: Money, bands: &[Band]) -> Money {
    let income = i128::from(taxable.cents());
    let exact: i128 = bands
        .iter()
        .map(|b| {
            let from = i128::from(b.from.cents());
            let top = b.to.map_or(income, |t| income.min(i128::from(t.cents())));
            (top - from).max(0) * i128::from(b.rate_bp)
        })
        .sum();
    money_from_i128(div_round_half_away(exact, BP))
}

/// `rate_bp` of `amount`, rounded half away from zero; nil for a negative amount.
fn flat(amount: Money, rate_bp: u32) -> Money {
    let base = i128::from(amount.cents()).max(0);
    money_from_i128(div_round_half_away(base * i128::from(rate_bp), BP))
}

/// What the owner has told us. `None` means not yet answered, which costs the most.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct OwnerAnswers {
    /// "Is this business your only income?"
    pub only_income: Option<bool>,
    /// "Do you have a student loan?"
    pub student_loan: Option<bool>,
}

/// How the income tax was worked out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncomeTaxBasis {
    /// The top rate on every dollar, because the owner may have other income.
    TopRateFlat,
    /// The bands from zero: the business is the owner's only income.
    Bands,
}

/// How the student loan was worked out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StudentLoanBasis {
    /// The owner has no student loan.
    None,
    /// The rate on every dollar, because other income may already be over the threshold.
    AllIncome,
    /// The rate on income over the year's threshold.
    OverThreshold,
}

/// A year's income tax and student loan, as they'd stand if filed now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncomeTaxFigure {
    pub year: IncomeYear,
    pub taxable_income: Money,
    pub basis: IncomeTaxBasis,
    pub income_tax: Money,
    pub student_loan_basis: StudentLoanBasis,
    pub student_loan: Money,
}

impl IncomeTaxFigure {
    pub fn total(&self) -> Money {
        self.income_tax + self.student_loan
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum IncomeTaxError {
    #[error("we don't hold the tax rates for the {} income year", year.0)]
    NoRateTable { year: IncomeYear },
}

/// The income tax and student loan for `year` on `taxable_income`, given the owner's answers.
pub fn income_tax_figure(
    year: IncomeYear,
    taxable_income: Money,
    answers: &OwnerAnswers,
) -> Result<IncomeTaxFigure, IncomeTaxError> {
    let bands = rate_table(year).ok_or(IncomeTaxError::NoRateTable { year })?;
    let threshold = student_loan_threshold(year).ok_or(IncomeTaxError::NoRateTable { year })?;
    let only_income = answers.only_income == Some(true);

    let (basis, income_tax) = if only_income {
        (IncomeTaxBasis::Bands, tax_on_bands(taxable_income, bands))
    } else {
        let top = bands.last().map_or(0, |b| b.rate_bp);
        (IncomeTaxBasis::TopRateFlat, flat(taxable_income, top))
    };

    let (student_loan_basis, student_loan) = match answers.student_loan {
        Some(false) => (StudentLoanBasis::None, Money::ZERO),
        _ if only_income => (
            StudentLoanBasis::OverThreshold,
            flat(taxable_income - threshold, STUDENT_LOAN_RATE_BP),
        ),
        _ => (
            StudentLoanBasis::AllIncome,
            flat(taxable_income, STUDENT_LOAN_RATE_BP),
        ),
    };

    Ok(IncomeTaxFigure {
        year,
        taxable_income,
        basis,
        income_tax,
        student_loan_basis,
        student_loan,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    const Y2026: IncomeYear = IncomeYear(2026);

    #[test]
    fn income_years() {
        assert_eq!(IncomeYear::containing(d("2025-08-01")), Y2026);
        assert_eq!(IncomeYear::containing(d("2026-03-31")), Y2026);
        assert_eq!(IncomeYear::containing(d("2026-04-01")), IncomeYear(2027));
        assert_eq!(Y2026.start(), d("2025-04-01"));
        assert_eq!(Y2026.end(), d("2026-03-31"));
    }

    #[test]
    fn bands_at_their_edges() {
        let b = rate_table(Y2026).unwrap();
        assert_eq!(tax_on_bands(Money::ZERO, b), Money::ZERO);
        assert_eq!(tax_on_bands(m("-5,000.00"), b), Money::ZERO);
        assert_eq!(tax_on_bands(m("15,600.00"), b), m("1,638.00"));
        assert_eq!(tax_on_bands(m("53,500.00"), b), m("8,270.50"));
        assert_eq!(tax_on_bands(m("78,100.00"), b), m("15,650.50"));
        assert_eq!(tax_on_bands(m("100,000.00"), b), m("22,877.50"));
        assert_eq!(tax_on_bands(m("180,000.00"), b), m("49,277.50"));
        assert_eq!(tax_on_bands(m("200,000.00"), b), m("57,077.50"));
    }

    #[test]
    fn no_table_no_figure() {
        let err = income_tax_figure(IncomeYear(2025), m("1,000.00"), &OwnerAnswers::default());
        assert_eq!(
            err,
            Err(IncomeTaxError::NoRateTable {
                year: IncomeYear(2025)
            })
        );
        assert!(rate_table(IncomeYear(2028)).is_none());
    }

    /// The worked example, before the owner answers anything.
    #[test]
    fn worked_example_conservative() {
        let f = income_tax_figure(Y2026, m("3,797.45"), &OwnerAnswers::default()).unwrap();
        assert_eq!(f.basis, IncomeTaxBasis::TopRateFlat);
        assert_eq!(f.income_tax, m("1,481.01"));
        assert_eq!(f.student_loan_basis, StudentLoanBasis::AllIncome);
        assert_eq!(f.student_loan, m("455.69"));
        // With GST of 569.62, that's the worked example's 2,506.32.
        assert_eq!(m("569.62") + f.total(), m("2,506.32"));
    }

    /// The worked example, after "This business is my only income".
    #[test]
    fn worked_example_only_income() {
        let answers = OwnerAnswers {
            only_income: Some(true),
            student_loan: None,
        };
        let f = income_tax_figure(Y2026, m("3,797.45"), &answers).unwrap();
        assert_eq!(f.basis, IncomeTaxBasis::Bands);
        assert_eq!(f.income_tax, m("398.73"));
        assert_eq!(f.student_loan_basis, StudentLoanBasis::OverThreshold);
        assert_eq!(f.student_loan, Money::ZERO);
        assert_eq!(m("569.62") + f.total(), m("968.35"));
    }

    #[test]
    fn student_loan_over_the_threshold() {
        let answers = OwnerAnswers {
            only_income: Some(true),
            student_loan: Some(true),
        };
        let f = income_tax_figure(Y2026, m("34,128.00"), &answers).unwrap();
        assert_eq!(f.student_loan, m("1,200.00"));
        let none = OwnerAnswers {
            student_loan: Some(false),
            ..answers
        };
        let f = income_tax_figure(Y2026, m("34,128.00"), &none).unwrap();
        assert_eq!(f.student_loan, Money::ZERO);
    }

    #[test]
    fn a_loss_pays_nothing() {
        let f = income_tax_figure(Y2026, m("-1,000.00"), &OwnerAnswers::default()).unwrap();
        assert_eq!(f.total(), Money::ZERO);
    }

    fn answers() -> impl Strategy<Value = OwnerAnswers> {
        let ans = prop_oneof![Just(None), Just(Some(true)), Just(Some(false))];
        (ans.clone(), ans).prop_map(|(only_income, student_loan)| OwnerAnswers {
            only_income,
            student_loan,
        })
    }

    proptest! {
        /// The figure with nothing answered is never lower than with any answers: answering
        /// questions only ever brings the figure down.
        #[test]
        fn unanswered_is_never_lower(cents in -10_000_000i64..10_000_000_000, a in answers()) {
            let income = Money::from_cents(cents);
            let worst = income_tax_figure(Y2026, income, &OwnerAnswers::default()).unwrap();
            let answered = income_tax_figure(Y2026, income, &a).unwrap();
            prop_assert!(answered.income_tax <= worst.income_tax);
            prop_assert!(answered.student_loan <= worst.student_loan);
        }

        /// More income never means less tax.
        #[test]
        fn tax_is_monotonic(a in 0i64..5_000_000_000, extra in 0i64..100_000_000) {
            let b = rate_table(Y2026).unwrap();
            let lo = tax_on_bands(Money::from_cents(a), b);
            let hi = tax_on_bands(Money::from_cents(a + extra), b);
            prop_assert!(lo <= hi);
        }
    }
}
