//! Analysis reports: expenses by category, this year against last.
//!
//! Categories are the template's report lines, reached through the year's mapping, so they match
//! the statements. Amounts are exact cents (not rounded to dollars like the statements), and
//! percentages are basis points, so nothing here is floating point.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::chart::{AccountCode, AccountType, Chart};
use crate::ledger::TrialBalance;
use crate::mapping::{Mapping, MappingError};
use crate::money::{Money, div_round_half_away};
use crate::template::{LineKey, Node, Template};

/// What an analysis reads: the year's pinned template and mapping, the client's chart, and the
/// closing balances of this year and (if there is one) the year before.
#[derive(Debug, Clone, Copy)]
pub struct AnalysisInput<'a> {
    pub template: &'a Template,
    pub mapping: &'a Mapping,
    pub chart: &'a Chart,
    pub current: &'a TrialBalance,
    pub prior: Option<&'a TrialBalance>,
}

/// A figure this year and last, and how it moved. Expenses are debit positive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Movement {
    pub current: Money,
    pub prior: Money,
    /// `current − prior`.
    pub change: Money,
    /// The change as a share of last year's figure, in basis points (12.5% = 1250), rounded half
    /// away from zero. `None` when last year's figure is nil.
    pub change_bp: Option<i64>,
}

impl Movement {
    pub fn new(current: Money, prior: Money) -> Movement {
        let change = current - prior;
        let change_bp = (!prior.is_zero()).then(|| {
            let bp = div_round_half_away(
                i128::from(change.cents()) * 10_000,
                i128::from(prior.cents()).abs(),
            );
            i64::try_from(bp).unwrap_or(if bp < 0 { i64::MIN } else { i64::MAX })
        });
        Movement {
            current,
            prior,
            change,
            change_bp,
        }
    }
}

/// Expenses by report line, in template order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseAnalysis {
    pub categories: Vec<ExpenseCategory>,
    pub total: Movement,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpenseCategory {
    pub line: LineKey,
    /// The line's label in the template.
    pub label: String,
    pub movement: Movement,
    /// The accounts behind the line, in code order.
    pub accounts: Vec<(AccountCode, Movement)>,
}

/// Groups every expense account with a balance in either year by the report line it maps to.
/// Lines with nothing in either year are left out. An expense account the mapping doesn't place is
/// an error, never dropped.
pub fn expense_analysis(input: &AnalysisInput<'_>) -> Result<ExpenseAnalysis, Vec<MappingError>> {
    let empty = TrialBalance::default();
    let prior = input.prior.unwrap_or(&empty);
    let is_expense = |code: &AccountCode| {
        input
            .chart
            .get(code)
            .is_some_and(|a| a.account_type == AccountType::Expense)
    };
    let mut current = TrialBalance::default();
    let mut last = TrialBalance::default();
    for (tb, out) in [(input.current, &mut current), (prior, &mut last)] {
        for (code, balance) in tb.iter().filter(|(c, _)| is_expense(c)) {
            out.post(code, balance);
        }
    }
    let assigned = input.mapping.assign([&current, &last])?;

    let mut by_line: BTreeMap<&LineKey, Vec<(AccountCode, Movement)>> = BTreeMap::new();
    for (code, line) in &assigned {
        let movement = Movement::new(current.balance(code), last.balance(code));
        by_line
            .entry(line)
            .or_default()
            .push((code.clone(), movement));
    }
    let categories: Vec<ExpenseCategory> = input
        .template
        .nodes()
        .filter_map(|node| match node {
            Node::Line { key, label, .. } => {
                let accounts = by_line.remove(key)?;
                let movement = Movement::new(
                    accounts.iter().map(|(_, m)| m.current).sum(),
                    accounts.iter().map(|(_, m)| m.prior).sum(),
                );
                Some(ExpenseCategory {
                    line: key.clone(),
                    label: label.clone(),
                    movement,
                    accounts,
                })
            }
            _ => None,
        })
        .collect();
    let total = Movement::new(
        categories.iter().map(|c| c.movement.current).sum(),
        categories.iter().map(|c| c.movement.prior).sum(),
    );
    Ok(ExpenseAnalysis { categories, total })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::tests::{account, code};
    use crate::ledger::TbLine;
    use crate::template::Presentation;
    use crate::template::tests::{key, line};

    fn chart() -> Chart {
        Chart::new(vec![
            account("200", "Sales", AccountType::Income),
            account("600", "Bank fees", AccountType::Expense),
            account("610", "Rent", AccountType::Expense),
            account("620", "Power", AccountType::Expense),
            account("630", "Phone", AccountType::Expense),
            account("800", "Bank", AccountType::Asset),
            account("960", "Retained earnings", AccountType::Equity),
        ])
        .unwrap()
    }

    fn template() -> Template {
        Template {
            name: "test".to_owned(),
            statements: vec![crate::template::Statement {
                key: key("pl"),
                title: "Profit and loss".to_owned(),
                body: vec![
                    line("sales", "Sales", Presentation::CreditPositive),
                    line("occupancy", "Occupancy", Presentation::DebitPositive),
                    line("admin", "Administration", Presentation::DebitPositive),
                    line("unused", "Unused", Presentation::DebitPositive),
                    line("bank", "Bank", Presentation::DebitPositive),
                ],
            }],
            checks: vec![],
        }
    }

    fn mapping() -> Mapping {
        use crate::mapping::tests::range;
        Mapping {
            ranges: vec![
                range("200", "299", "sales"),
                range("600", "600", "admin"),
                range("610", "620", "occupancy"),
                range("630", "630", "admin"),
                range("800", "999", "bank"),
            ],
        }
    }

    fn tb(lines: &[(&str, i64)]) -> TrialBalance {
        lines
            .iter()
            .map(|&(c, cents)| TbLine {
                account: code(c),
                balance: Money::from_cents(cents),
            })
            .collect::<Vec<_>>()
            .into()
    }

    #[test]
    fn movement_in_basis_points() {
        let m = |c, p| Movement::new(Money::from_cents(c), Money::from_cents(p));
        assert_eq!(m(150, 100).change_bp, Some(5_000));
        assert_eq!(m(50, 100).change_bp, Some(-5_000));
        assert_eq!(m(100, 0).change_bp, None);
        assert_eq!(m(0, 100).change_bp, Some(-10_000));
        // 1/3 = 33.33%, 2/3 = 66.67%: rounded half away from zero.
        assert_eq!(m(4, 3).change_bp, Some(3_333));
        assert_eq!(m(1, 3).change_bp, Some(-6_667));
        // 0.005% rounds away from zero.
        assert_eq!(m(20_001, 20_000).change_bp, Some(1));
        assert_eq!(m(19_999, 20_000).change_bp, Some(-1));
        // A credit-balance prior year still reads as "up" when the figure rises.
        assert_eq!(m(0, -100).change_bp, Some(10_000));
        assert_eq!(m(250, 100).change, Money::from_cents(150));
    }

    #[test]
    fn expenses_by_report_line_this_year_against_last() {
        let current = tb(&[
            ("200", -100_000),
            ("600", 1_000),
            ("610", 24_000),
            ("620", 3_000),
            ("800", 71_000),
            ("960", 1_000),
        ]);
        let prior = tb(&[
            ("200", -80_000),
            ("610", 20_000),
            ("630", 1_200),
            ("800", 58_800),
        ]);
        let a = expense_analysis(&AnalysisInput {
            template: &template(),
            mapping: &mapping(),
            chart: &chart(),
            current: &current,
            prior: Some(&prior),
        })
        .unwrap();

        // Template order; income and balance-sheet lines, and lines with nothing, are left out.
        let labels: Vec<&str> = a.categories.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(labels, ["Occupancy", "Administration"]);

        let occupancy = &a.categories[0];
        assert_eq!(occupancy.movement.current, Money::from_cents(27_000));
        assert_eq!(occupancy.movement.prior, Money::from_cents(20_000));
        assert_eq!(occupancy.movement.change, Money::from_cents(7_000));
        assert_eq!(occupancy.movement.change_bp, Some(3_500));
        let codes: Vec<&str> = occupancy.accounts.iter().map(|(c, _)| c.as_str()).collect();
        assert_eq!(codes, ["610", "620"]);
        assert_eq!(occupancy.accounts[1].1.change_bp, None);

        // Phone was only last year: it still shows, at nil this year.
        let admin = &a.categories[1];
        assert_eq!(admin.movement.current, Money::from_cents(1_000));
        assert_eq!(admin.movement.prior, Money::from_cents(1_200));
        assert_eq!(admin.movement.change_bp, Some(-1_667));

        assert_eq!(a.total.current, Money::from_cents(28_000));
        assert_eq!(a.total.prior, Money::from_cents(21_200));
    }

    #[test]
    fn no_prior_year_means_no_percentages() {
        let current = tb(&[("610", 24_000), ("800", -24_000)]);
        let a = expense_analysis(&AnalysisInput {
            template: &template(),
            mapping: &mapping(),
            chart: &chart(),
            current: &current,
            prior: None,
        })
        .unwrap();
        assert_eq!(a.total.prior, Money::ZERO);
        assert_eq!(a.total.change_bp, None);
    }

    #[test]
    fn an_unmapped_expense_account_is_an_error() {
        let mut m = mapping();
        m.ranges.retain(|r| r.line != key("admin"));
        let current = tb(&[("630", 500), ("800", -500)]);
        let err = expense_analysis(&AnalysisInput {
            template: &template(),
            mapping: &m,
            chart: &chart(),
            current: &current,
            prior: None,
        })
        .unwrap_err();
        assert_eq!(
            err,
            [MappingError::Unmapped {
                account: code("630")
            }]
        );
    }
}
