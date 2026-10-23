//! "Tax to pay if submitted": every unfiled GST period and income year, from in-memory totals.
//!
//! The server loads the totals from the ledger; this works out the returns and the figure. The
//! what-if helpers price one change, which is how M11's Save tax queue sorts its cards.

use std::collections::BTreeMap;

use super::gst::{GstError, GstPeriod, GstReturn, GstTotals, gst_return};
use super::income_tax::{IncomeTaxError, IncomeTaxFigure, IncomeYear, YearAnswers, year_figure};
use crate::money::Money;

/// What the figure is worked out from.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TaxInputs {
    /// Each GST period's totals. Empty for an owner who isn't registered.
    pub gst: BTreeMap<GstPeriod, GstTotals>,
    /// Each income year's taxable business income.
    pub taxable_income: BTreeMap<IncomeYear, Money>,
    /// The owner's answers per income year. A year with no entry has nothing answered.
    pub answers: BTreeMap<IncomeYear, YearAnswers>,
}

/// One GST return as it would be filed now, or why there's no figure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GstLine {
    pub period: GstPeriod,
    pub totals: GstTotals,
    pub result: Result<GstReturn, GstError>,
}

/// One income year as it would be filed now, or why there's no figure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncomeLine {
    pub year: IncomeYear,
    pub taxable_income: Money,
    pub result: Result<IncomeTaxFigure, IncomeTaxError>,
}

/// "Tax to pay if submitted", and what it's made of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Position {
    /// In period order.
    pub gst: Vec<GstLine>,
    /// In year order.
    pub income: Vec<IncomeLine>,
    /// Each GST return's box 15, plus each income year's total (never below nil). A return with
    /// no figure adds nothing; the screen says why.
    pub total: Money,
}

/// The figure and its breakdown.
pub fn position(inputs: &TaxInputs) -> Position {
    let gst: Vec<GstLine> = inputs
        .gst
        .iter()
        .map(|(&period, &totals)| GstLine {
            period,
            totals,
            result: gst_return(period, &totals),
        })
        .collect();
    let income: Vec<IncomeLine> = inputs
        .taxable_income
        .iter()
        .map(|(&year, &taxable_income)| {
            let answers = inputs.answers.get(&year).copied().unwrap_or_default();
            IncomeLine {
                year,
                taxable_income,
                result: year_figure(year, taxable_income, &answers),
            }
        })
        .collect();
    let total = gst
        .iter()
        .filter_map(|g| g.result.as_ref().ok().map(|r| r.box15))
        .chain(
            income
                .iter()
                .filter_map(|i| i.result.as_ref().ok().map(IncomeTaxFigure::total)),
        )
        .sum();
    Position { gst, income, total }
}

/// One change to the inputs, as answering a Save tax card would make it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Change {
    /// The owner's answers for a year, replaced whole.
    Answers {
        year: IncomeYear,
        answers: YearAnswers,
    },
    /// A GST period's totals, replaced whole.
    GstTotals {
        period: GstPeriod,
        totals: GstTotals,
    },
    /// A year's taxable income, replaced.
    TaxableIncome {
        year: IncomeYear,
        taxable_income: Money,
    },
    /// Recoding bank lines: amounts added to a period's GST totals and a year's taxable income
    /// (negative to take away). Either may be `None`, for an unregistered owner, say.
    Moves {
        gst: Option<(GstPeriod, GstTotals)>,
        taxable_income: Option<(IncomeYear, Money)>,
    },
}

impl TaxInputs {
    /// These inputs with `change` made.
    pub fn with(&self, change: &Change) -> TaxInputs {
        let mut next = self.clone();
        match change {
            Change::Answers { year, answers } => {
                next.answers.insert(*year, *answers);
            }
            Change::GstTotals { period, totals } => {
                next.gst.insert(*period, *totals);
            }
            Change::TaxableIncome {
                year,
                taxable_income,
            } => {
                next.taxable_income.insert(*year, *taxable_income);
            }
            Change::Moves {
                gst,
                taxable_income,
            } => {
                if let Some((period, delta)) = gst {
                    let t = next.gst.entry(*period).or_default();
                    t.sales += delta.sales;
                    t.zero_rated += delta.zero_rated;
                    t.adjustments += delta.adjustments;
                    t.purchases += delta.purchases;
                    t.credit_adjustments += delta.credit_adjustments;
                }
                if let Some((year, delta)) = taxable_income {
                    *next.taxable_income.entry(*year).or_default() += *delta;
                }
            }
        }
        next
    }
}

/// How much `change` would take off the figure, in cents. Negative if it would add to it, as
/// entering other income with too little tax deducted can.
pub fn saving(inputs: &TaxInputs, change: &Change) -> Money {
    saving_between(inputs, &inputs.with(change))
}

/// How much lower the figure is on `after` than on `before`.
pub fn saving_between(before: &TaxInputs, after: &TaxInputs) -> Money {
    position(before).total - position(after).total
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tax::income_tax::{OtherIncome, OwnerAnswers, rate_table, tax_on_bands};
    use chrono::NaiveDate;
    use proptest::prelude::*;

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    const Y2026: IncomeYear = IncomeYear(2026);

    fn aug_sep() -> GstPeriod {
        GstPeriod {
            start: d("2025-08-01"),
            end: d("2025-09-30"),
        }
    }

    /// The synthetic sole trader's worked example (`docs/domain.md`).
    fn worked_example() -> TaxInputs {
        TaxInputs {
            gst: [(
                aug_sep(),
                GstTotals {
                    sales: m("4,367.08"),
                    ..GstTotals::default()
                },
            )]
            .into(),
            taxable_income: [(Y2026, m("3,797.45"))].into(),
            answers: BTreeMap::new(),
        }
    }

    fn only_income() -> YearAnswers {
        OwnerAnswers {
            only_income: Some(true),
            student_loan: None,
        }
        .into()
    }

    #[test]
    fn worked_example_conservative() {
        let p = position(&worked_example());
        assert_eq!(p.gst[0].result.as_ref().unwrap().box15, m("569.62"));
        let f = *p.income[0].result.as_ref().unwrap();
        assert_eq!((f.income_tax, f.student_loan), (m("1,481.01"), m("455.69")));
        assert_eq!(p.total, m("2,506.32"));
    }

    #[test]
    fn worked_example_only_income_saves_1537_97() {
        let change = Change::Answers {
            year: Y2026,
            answers: only_income(),
        };
        let inputs = worked_example();
        assert_eq!(position(&inputs.with(&change)).total, m("968.35"));
        assert_eq!(saving(&inputs, &change), m("1,537.97"));
    }

    #[test]
    fn a_year_without_rates_adds_nothing_and_says_why() {
        let mut inputs = worked_example();
        inputs
            .taxable_income
            .insert(IncomeYear(2025), m("10,000.00"));
        let p = position(&inputs);
        assert_eq!(p.income.len(), 2);
        assert!(p.income[0].result.is_err());
        assert_eq!(p.total, m("2,506.32"));
    }

    #[test]
    fn credits_never_make_a_refund() {
        let mut answers = only_income();
        answers.tax_paid = m("5,000.00");
        let inputs = TaxInputs {
            answers: [(Y2026, answers)].into(),
            ..worked_example()
        };
        let p = position(&inputs);
        let f = *p.income[0].result.as_ref().unwrap();
        assert_eq!(f.income_tax, m("398.73"));
        assert_eq!(f.income_tax_to_pay(), Money::ZERO);
        assert_eq!(f.total(), Money::ZERO);
        assert_eq!(p.total, m("569.62"), "GST only");
    }

    #[test]
    fn moves_add_to_totals() {
        // Coding a $230 purchase with standard GST: $30 GST claimed, $200 off taxable income.
        let change = Change::Moves {
            gst: Some((
                aug_sep(),
                GstTotals {
                    purchases: m("230.00"),
                    ..GstTotals::default()
                },
            )),
            taxable_income: Some((Y2026, m("-200.00"))),
        };
        let inputs = worked_example();
        let after = inputs.with(&change);
        assert_eq!(after.gst[&aug_sep()].sales, m("4,367.08"));
        assert_eq!(after.gst[&aug_sep()].purchases, m("230.00"));
        assert_eq!(after.taxable_income[&Y2026], m("3,597.45"));
        // $30 of GST, plus 39% and 12% of $200.
        assert_eq!(saving(&inputs, &change), m("132.00"));
    }

    #[test]
    fn under_taxed_other_income_raises_the_figure() {
        let answers = YearAnswers {
            questions: OwnerAnswers {
                only_income: Some(false),
                student_loan: Some(false),
            },
            other_income: Some(OtherIncome {
                income: m("30,000.00"),
                tax_deducted: Money::ZERO,
            }),
            ..YearAnswers::default()
        };
        let change = Change::Answers {
            year: Y2026,
            answers,
        };
        assert!(saving(&worked_example(), &change) < Money::ZERO);
    }

    fn answers() -> impl Strategy<Value = YearAnswers> {
        let yes_no = prop_oneof![Just(None), Just(Some(true)), Just(Some(false))];
        let other = prop_oneof![
            Just(None),
            (0i64..20_000_000, 0i64..2_000_000).prop_map(|(income, extra)| {
                Some((Money::from_cents(income), Money::from_cents(extra)))
            }),
        ];
        let months = prop_oneof![Just(None), (0u8..=12).prop_map(Some)];
        (yes_no.clone(), yes_no, other, 0i64..1_000_000, months).prop_map(
            |(only_income, student_loan, other, paid, ietc_months)| YearAnswers {
                questions: OwnerAnswers {
                    only_income,
                    student_loan,
                },
                // Other income with at least its own tax deducted (plus a cent for rounding):
                // less than that rightly raises the figure.
                other_income: other.map(|(income, extra)| OtherIncome {
                    income,
                    tax_deducted: tax_on_bands(income, rate_table(Y2026).unwrap())
                        + Money::from_cents(1)
                        + extra,
                }),
                tax_paid: Money::from_cents(paid),
                ietc_months,
            },
        )
    }

    proptest! {
        /// Answering questions never raises the figure, as long as any other income entered
        /// has had its own tax deducted.
        #[test]
        fn answering_never_raises_the_figure(
            income in -10_000_000i64..100_000_000,
            sales in 0i64..100_000_000,
            a in answers(),
        ) {
            let inputs = TaxInputs {
                gst: [(aug_sep(), GstTotals { sales: Money::from_cents(sales), ..GstTotals::default() })].into(),
                taxable_income: [(Y2026, Money::from_cents(income))].into(),
                answers: BTreeMap::new(),
            };
            let change = Change::Answers { year: Y2026, answers: a };
            prop_assert!(saving(&inputs, &change) >= Money::ZERO);
        }
    }
}
