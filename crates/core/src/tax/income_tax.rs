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

/// The IETC in full: $10 a week, $520 a year.
pub const IETC_FULL: Money = Money::from_cents(52_000);
/// The lowest income that gets the IETC.
pub const IETC_FROM: Money = Money::from_cents(2_400_000);
/// Income above this abates the IETC.
pub const IETC_ABATES_FROM: Money = Money::from_cents(6_600_000);
/// The highest income that gets the IETC. It has fully abated by here.
pub const IETC_TO: Money = Money::from_cents(7_000_000);
/// The IETC falls by 13 cents for each complete dollar of income over [`IETC_ABATES_FROM`].
pub const IETC_ABATEMENT_CENTS_PER_DOLLAR: i64 = 13;

/// The independent earner tax credit for a year's total income, for `months` whole months of
/// eligibility (0 to 12). Nil outside $24,000 to $70,000.
///
/// `docs/domain.md` ("Income tax for sole traders") has the rule and its sources: $520, less 13c
/// for each complete dollar over $66,000, then the share of whole months eligible, rounded once
/// half away from zero.
pub fn ietc(total_income: Money, months: u8) -> Money {
    if total_income < IETC_FROM || total_income > IETC_TO {
        return Money::ZERO;
    }
    let over_dollars = (total_income - IETC_ABATES_FROM).cents().max(0) / 100;
    let full_year = (IETC_FULL.cents() - over_dollars * IETC_ABATEMENT_CENTS_PER_DOLLAR).max(0);
    let months = i128::from(months.min(12));
    money_from_i128(div_round_half_away(i128::from(full_year) * months, 12))
}

/// The owner's yes/no questions. `None` means not yet answered, which costs the most.
///
/// The rest of what the owner tells us for a year (other income, tax already paid, the IETC) is
/// in [`YearAnswers`], which holds these too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OwnerAnswers {
    /// "Is this business your only income?"
    pub only_income: Option<bool>,
    /// "Do you have a student loan?"
    pub student_loan: Option<bool>,
}

/// Income from outside the business for the year, and the tax already deducted from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OtherIncome {
    /// Before tax: wages, interest, dividends and so on.
    pub income: Money,
    /// PAYE and RWT deducted at source. A credit against the year's income tax.
    pub tax_deducted: Money,
}

/// Everything the owner has told us about one income year. Unanswered costs the most.
///
/// Serialised flat, so it reads as [`OwnerAnswers`] with more fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct YearAnswers {
    #[serde(flatten)]
    pub questions: OwnerAnswers,
    /// The other income and its tax deducted. Used only once `only_income` is `Some(false)`;
    /// until it's entered, the business income stays at the top rate.
    pub other_income: Option<OtherIncome>,
    /// Income tax for the year already paid to IRD (provisional or terminal), as confirmed by
    /// the owner. A credit.
    pub tax_paid: Money,
    /// Whole months of the year the owner is eligible for the IETC: `None` until asked, `Some(0)`
    /// if not eligible (Working for Families, a benefit, NZ Super), `Some(12)` for the whole year.
    pub ietc_months: Option<u8>,
}

impl From<OwnerAnswers> for YearAnswers {
    fn from(questions: OwnerAnswers) -> YearAnswers {
        YearAnswers {
            questions,
            ..YearAnswers::default()
        }
    }
}

impl YearAnswers {
    /// The owner's income from outside the business, if we know it: nil for "this business is
    /// my only income", the amount entered for "no", and `None` until then.
    pub fn known_other_income(&self) -> Option<OtherIncome> {
        match self.questions.only_income {
            Some(true) => Some(OtherIncome::default()),
            Some(false) => self.other_income,
            None => None,
        }
    }
}

/// How the income tax was worked out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IncomeTaxBasis {
    /// The top rate on every dollar, because the owner may have other income.
    TopRateFlat,
    /// The bands from zero, on the business income plus any other income the owner entered.
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
    /// The rate on the business income's share of total income over the year's threshold.
    OverThreshold,
}

/// A year's income tax and student loan, as they'd stand if filed now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IncomeTaxFigure {
    pub year: IncomeYear,
    /// The business's taxable income.
    pub taxable_income: Money,
    /// Income from outside the business, if known (nil when the business is the only income).
    pub other_income: Option<Money>,
    pub basis: IncomeTaxBasis,
    /// Tax on income, before credits: on total income through the bands, or on the business
    /// income at the top rate.
    pub income_tax: Money,
    /// PAYE and RWT already deducted from the other income.
    pub tax_deducted: Money,
    /// Income tax already paid to IRD for the year.
    pub tax_paid: Money,
    /// The independent earner tax credit.
    pub ietc: Money,
    pub student_loan_basis: StudentLoanBasis,
    pub student_loan: Money,
}

impl IncomeTaxFigure {
    /// Tax deducted, tax paid and the IETC.
    pub fn credits(&self) -> Money {
        self.tax_deducted + self.tax_paid + self.ietc
    }

    /// Income tax less credits, floored at nil: the figure never shows a refund
    /// (`docs/domain.md`, "Income tax for sole traders").
    pub fn income_tax_to_pay(&self) -> Money {
        (self.income_tax - self.credits()).max(Money::ZERO)
    }

    /// What the year adds to "Tax to pay if submitted": never below nil.
    pub fn total(&self) -> Money {
        self.income_tax_to_pay() + self.student_loan
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "code", rename_all = "snake_case")]
pub enum IncomeTaxError {
    #[error("we don't hold the tax rates for the {} income year", year.0)]
    NoRateTable { year: IncomeYear },
}

/// The income tax and student loan for `year` on `taxable_income`, given the owner's yes/no
/// answers only. See [`year_figure`] for the rest of what they can tell us.
pub fn income_tax_figure(
    year: IncomeYear,
    taxable_income: Money,
    answers: &OwnerAnswers,
) -> Result<IncomeTaxFigure, IncomeTaxError> {
    year_figure(year, taxable_income, &YearAnswers::from(*answers))
}

/// The income tax, credits and student loan for `year` on the business's `taxable_income`.
///
/// - Until the owner's other income is known, the business income is taxed at the top rate and
///   no IETC is given, since we can't tell whether they qualify.
/// - Once it's known, the bands run on business plus other income, and the tax deducted from the
///   other income is a credit. If less was deducted than that income's own tax, the figure rises
///   above the conservative one, which is right: IRD would ask for it.
/// - The student loan is charged on the business income's share of total income over the
///   threshold: the other income's share is taken to have had its repayments deducted at source.
pub fn year_figure(
    year: IncomeYear,
    taxable_income: Money,
    answers: &YearAnswers,
) -> Result<IncomeTaxFigure, IncomeTaxError> {
    let bands = rate_table(year).ok_or(IncomeTaxError::NoRateTable { year })?;
    let threshold = student_loan_threshold(year).ok_or(IncomeTaxError::NoRateTable { year })?;
    let other = answers.known_other_income();

    let (basis, income_tax, tax_deducted, ietc_credit) = match other {
        Some(o) => {
            let total = taxable_income + o.income;
            let months = answers.ietc_months.unwrap_or(0);
            (
                IncomeTaxBasis::Bands,
                tax_on_bands(total, bands),
                o.tax_deducted.max(Money::ZERO),
                ietc(total, months),
            )
        }
        None => {
            let top = bands.last().map_or(0, |b| b.rate_bp);
            (
                IncomeTaxBasis::TopRateFlat,
                flat(taxable_income, top),
                Money::ZERO,
                Money::ZERO,
            )
        }
    };

    let (student_loan_basis, student_loan) = match (answers.questions.student_loan, other) {
        (Some(false), _) => (StudentLoanBasis::None, Money::ZERO),
        (_, Some(o)) => {
            let over = |income: Money| (income - threshold).max(Money::ZERO);
            let business_share = over(taxable_income + o.income) - over(o.income);
            (
                StudentLoanBasis::OverThreshold,
                flat(business_share, STUDENT_LOAN_RATE_BP),
            )
        }
        (_, None) => (
            StudentLoanBasis::AllIncome,
            flat(taxable_income, STUDENT_LOAN_RATE_BP),
        ),
    };

    Ok(IncomeTaxFigure {
        year,
        taxable_income,
        other_income: other.map(|o| o.income),
        basis,
        income_tax,
        tax_deducted,
        tax_paid: answers.tax_paid.max(Money::ZERO),
        ietc: ietc_credit,
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

#[cfg(test)]
mod credit_tests {
    use super::*;
    use proptest::prelude::*;

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    const Y2026: IncomeYear = IncomeYear(2026);

    fn answered(other: Money, deducted: Money, months: Option<u8>) -> YearAnswers {
        YearAnswers {
            questions: OwnerAnswers {
                only_income: Some(false),
                student_loan: Some(true),
            },
            other_income: Some(OtherIncome {
                income: other,
                tax_deducted: deducted,
            }),
            tax_paid: Money::ZERO,
            ietc_months: months,
        }
    }

    #[test]
    fn ietc_amounts() {
        assert_eq!(ietc(m("23,999.99"), 12), Money::ZERO);
        assert_eq!(ietc(m("24,000.00"), 12), m("520.00"));
        assert_eq!(ietc(m("66,000.00"), 12), m("520.00"));
        // 13c for each complete dollar over $66,000.
        assert_eq!(ietc(m("66,000.99"), 12), m("520.00"));
        assert_eq!(ietc(m("66,001.00"), 12), m("519.87"));
        assert_eq!(ietc(m("68,000.00"), 12), m("260.00"));
        assert_eq!(ietc(m("70,000.00"), 12), Money::ZERO);
        assert_eq!(ietc(m("70,000.01"), 12), Money::ZERO);
        // Whole months: 7 of 12 of $520 is $303.333..., rounded to $303.33.
        assert_eq!(ietc(m("40,000.00"), 7), m("303.33"));
        assert_eq!(ietc(m("40,000.00"), 0), Money::ZERO);
    }

    #[test]
    fn no_ietc_until_total_income_is_known() {
        let mut a = YearAnswers {
            ietc_months: Some(12),
            ..YearAnswers::default()
        };
        let f = year_figure(Y2026, m("40,000.00"), &a).unwrap();
        assert_eq!(
            (f.basis, f.ietc),
            (IncomeTaxBasis::TopRateFlat, Money::ZERO)
        );
        a.questions.only_income = Some(true);
        let f = year_figure(Y2026, m("40,000.00"), &a).unwrap();
        assert_eq!(f.ietc, m("520.00"));
        // 1,638.00 + 17.5% of 24,400.00 = 5,908.00, less the IETC.
        assert_eq!(f.income_tax_to_pay(), m("5,388.00"));
    }

    #[test]
    fn other_income_and_its_tax() {
        // Wages of $50,000 with exactly their own tax deducted, plus $10,000 from the business.
        let bands = rate_table(Y2026).unwrap();
        let wages_tax = tax_on_bands(m("50,000.00"), bands);
        let f = year_figure(
            Y2026,
            m("10,000.00"),
            &answered(m("50,000.00"), wages_tax, Some(0)),
        )
        .unwrap();
        assert_eq!(f.other_income, Some(m("50,000.00")));
        assert_eq!(f.income_tax, tax_on_bands(m("60,000.00"), bands));
        // $3,500 at 17.5%, then $6,500 at 30%.
        assert_eq!(f.income_tax_to_pay(), m("2,562.50"));
        // All $10,000 is over the student loan threshold, since the wages already are.
        assert_eq!(f.student_loan, m("1,200.00"));
        assert_eq!(f.total(), m("3,762.50"));
    }

    #[test]
    fn entered_but_not_other_income_stays_conservative() {
        let a = YearAnswers {
            questions: OwnerAnswers {
                only_income: Some(false),
                student_loan: None,
            },
            ..YearAnswers::default()
        };
        assert_eq!(
            year_figure(Y2026, m("3,797.45"), &a).unwrap(),
            income_tax_figure(Y2026, m("3,797.45"), &OwnerAnswers::default()).unwrap()
        );
    }

    #[test]
    fn the_ietc_cliff_at_24000() {
        // The law gives the whole $520 from $24,000, so a cent more income can mean less tax.
        let a = answered(Money::ZERO, Money::ZERO, Some(12));
        let below = year_figure(Y2026, m("23,999.99"), &a).unwrap();
        let at = year_figure(Y2026, m("24,000.00"), &a).unwrap();
        assert!(at.income_tax_to_pay() < below.income_tax_to_pay());
    }

    #[test]
    fn answers_read_flat_and_default_when_missing() {
        let a: YearAnswers =
            serde_json::from_str(r#"{"only_income":true,"tax_paid":1000}"#).unwrap();
        assert_eq!(a.questions.only_income, Some(true));
        assert_eq!(a.tax_paid, Money::from_cents(1000));
        assert_eq!(a.ietc_months, None);
        let json = serde_json::to_value(a).unwrap();
        assert_eq!(json["only_income"], true);
    }

    fn any_answers() -> impl Strategy<Value = YearAnswers> {
        let yes_no = prop_oneof![Just(None), Just(Some(true)), Just(Some(false))];
        let other = prop_oneof![
            Just(None),
            (0i64..20_000_000, 0i64..5_000_000).prop_map(|(i, t)| Some(OtherIncome {
                income: Money::from_cents(i),
                tax_deducted: Money::from_cents(t),
            })),
        ];
        let months = prop_oneof![Just(None), (0u8..=12).prop_map(Some)];
        (yes_no.clone(), yes_no, other, 0i64..1_000_000, months).prop_map(
            |(only_income, student_loan, other_income, paid, ietc_months)| YearAnswers {
                questions: OwnerAnswers {
                    only_income,
                    student_loan,
                },
                other_income,
                tax_paid: Money::from_cents(paid),
                ietc_months,
            },
        )
    }

    proptest! {
        /// More business income never means less to pay, whatever the answers, except across
        /// the IETC's $24,000 cliff, which is the law (`the_ietc_cliff_at_24000`).
        #[test]
        fn the_figure_is_monotonic_in_income(
            a in -5_000_000i64..30_000_000,
            extra in 0i64..10_000_000,
            answers in any_answers(),
        ) {
            let lo = year_figure(Y2026, Money::from_cents(a), &answers).unwrap();
            let hi = year_figure(Y2026, Money::from_cents(a + extra), &answers).unwrap();
            let other = answers.known_other_income().map_or(0, |o| o.income.cents());
            let crosses_cliff = answers.ietc_months.unwrap_or(0) > 0
                && lo.basis == IncomeTaxBasis::Bands
                && a + other < IETC_FROM.cents()
                && a + extra + other >= IETC_FROM.cents();
            prop_assume!(!crosses_cliff);
            prop_assert!(lo.income_tax <= hi.income_tax);
            prop_assert!(lo.student_loan <= hi.student_loan);
            prop_assert!(lo.total() <= hi.total());
        }

        /// The IETC never goes up with income inside its range.
        #[test]
        fn ietc_only_abates(a in 2_400_000i64..7_100_000, extra in 0i64..1_000_000, months in 0u8..=12) {
            prop_assert!(ietc(Money::from_cents(a + extra), months) <= ietc(Money::from_cents(a), months));
        }
    }
}
