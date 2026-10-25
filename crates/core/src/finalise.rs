//! The checks a year must pass before it's finalised (CLAUDE.md, Finalised years). The server
//! gathers the facts; this decides, so the rules live in one pure place.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::ledger::TrialBalance;
use crate::mapping::{Mapping, MappingError};
use crate::money::Money;

/// The prior year, as far as finalising the current one cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PriorYear<'a> {
    pub end: NaiveDate,
    pub finalised: bool,
    /// Its closing TB as the comparatives will show it: the snapshot's if it's finalised.
    pub tb: &'a TrialBalance,
}

/// Everything the pre-checks look at.
#[derive(Debug, Clone, Copy)]
pub struct FinaliseInput<'a> {
    pub tb: &'a TrialBalance,
    pub prior: Option<PriorYear<'a>>,
    /// The year's pinned mapping.
    pub mapping: &'a Mapping,
    /// Whether the posted depreciation and disposal journals are what the register computes.
    pub depreciation_current: bool,
    /// Bank lines dated in the year that are still unsorted.
    pub uncategorised_lines: u32,
    /// The accountant accepts the unsorted lines as they are.
    pub accept_uncategorised: bool,
}

/// Why a year can't be finalised yet. Each has a plain message for the person finalising.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Error, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum FinaliseProblem {
    #[error("The year before, ending {}, isn't finalised yet. Finalise it first.", long_date(*prior_end))]
    PriorNotFinalised {
        #[ts(type = "string")]
        prior_end: NaiveDate,
    },
    #[error("The trial balance is out of balance by {difference}.")]
    UnbalancedTb { difference: Money },
    #[error("Account {account} has a balance but isn't mapped to a report line.")]
    Unmapped { account: crate::chart::AccountCode },
    #[error("Depreciation isn't up to date. Run depreciation first.")]
    DepreciationStale,
    #[error(
        "{count} bank {} still to be sorted. Sort {it} first, or accept {it} as {}.",
        if *count == 1 { "line is" } else { "lines are" },
        if *count == 1 { "it is" } else { "they are" },
        it = if *count == 1 { "it" } else { "them" },
    )]
    UncategorisedLines { count: u32 },
}

/// One problem with its message, as the API reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FinaliseIssue {
    #[serde(flatten)]
    pub problem: FinaliseProblem,
    pub message: String,
}

impl From<FinaliseProblem> for FinaliseIssue {
    fn from(problem: FinaliseProblem) -> FinaliseIssue {
        FinaliseIssue {
            message: problem.to_string(),
            problem,
        }
    }
}

/// Every reason the year can't be finalised, in a fixed order. Empty means it can be.
pub fn check_finalise(input: &FinaliseInput<'_>) -> Vec<FinaliseProblem> {
    let mut problems = Vec::new();
    if let Some(p) = input.prior
        && !p.finalised
    {
        problems.push(FinaliseProblem::PriorNotFinalised { prior_end: p.end });
    }
    if !input.tb.is_balanced() {
        problems.push(FinaliseProblem::UnbalancedTb {
            difference: input.tb.total(),
        });
    }
    let tbs = std::iter::once(input.tb).chain(input.prior.map(|p| p.tb));
    if let Err(errors) = input.mapping.assign(tbs) {
        for e in errors {
            if let MappingError::Unmapped { account } = e {
                problems.push(FinaliseProblem::Unmapped { account });
            }
        }
    }
    if !input.depreciation_current {
        problems.push(FinaliseProblem::DepreciationStale);
    }
    if input.uncategorised_lines > 0 && !input.accept_uncategorised {
        problems.push(FinaliseProblem::UncategorisedLines {
            count: input.uncategorised_lines,
        });
    }
    problems
}

fn long_date(d: NaiveDate) -> String {
    d.format("%-d %B %Y").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chart::AccountCode;
    use crate::ledger::TbLine;
    use crate::mapping::MappingRange;

    fn code(s: &str) -> AccountCode {
        s.parse().unwrap()
    }

    fn tb(lines: &[(&str, i64)]) -> TrialBalance {
        lines
            .iter()
            .map(|(c, cents)| TbLine {
                account: code(c),
                balance: Money::from_cents(*cents),
            })
            .collect::<Vec<_>>()
            .into()
    }

    fn mapping() -> Mapping {
        Mapping {
            ranges: vec![MappingRange {
                from: code("100"),
                to: code("299"),
                line: "sales".parse().unwrap(),
            }],
        }
    }

    fn input<'a>(tb: &'a TrialBalance, mapping: &'a Mapping) -> FinaliseInput<'a> {
        FinaliseInput {
            tb,
            prior: None,
            mapping,
            depreciation_current: true,
            uncategorised_lines: 0,
            accept_uncategorised: false,
        }
    }

    #[test]
    fn a_clean_year_passes() {
        let (t, m) = (tb(&[("100", -500), ("200", 500)]), mapping());
        assert_eq!(check_finalise(&input(&t, &m)), vec![]);
    }

    #[test]
    fn the_prior_year_must_be_finalised_first() {
        let (t, m) = (tb(&[]), mapping());
        let prior_tb = tb(&[]);
        let end: NaiveDate = "2025-03-31".parse().unwrap();
        let mut i = input(&t, &m);
        i.prior = Some(PriorYear {
            end,
            finalised: false,
            tb: &prior_tb,
        });
        let problems = check_finalise(&i);
        assert_eq!(
            problems,
            vec![FinaliseProblem::PriorNotFinalised { prior_end: end }]
        );
        assert_eq!(
            problems[0].to_string(),
            "The year before, ending 31 March 2025, isn't finalised yet. Finalise it first."
        );
        i.prior = Some(PriorYear {
            end,
            finalised: true,
            tb: &prior_tb,
        });
        assert_eq!(check_finalise(&i), vec![]);
    }

    #[test]
    fn an_unbalanced_tb_is_refused() {
        let (t, m) = (tb(&[("100", -500), ("200", 400)]), mapping());
        assert_eq!(
            check_finalise(&input(&t, &m)),
            vec![FinaliseProblem::UnbalancedTb {
                difference: Money::from_cents(-100)
            }]
        );
    }

    #[test]
    fn unmapped_accounts_in_either_year_are_refused() {
        let m = mapping();
        let t = tb(&[("100", -500), ("300", 500)]);
        let prior_tb = tb(&[("400", -1), ("200", 1)]);
        let mut i = input(&t, &m);
        i.prior = Some(PriorYear {
            end: "2025-03-31".parse().unwrap(),
            finalised: true,
            tb: &prior_tb,
        });
        assert_eq!(
            check_finalise(&i),
            vec![
                FinaliseProblem::Unmapped {
                    account: code("300")
                },
                FinaliseProblem::Unmapped {
                    account: code("400")
                },
            ]
        );
    }

    #[test]
    fn stale_depreciation_is_refused() {
        let (t, m) = (tb(&[]), mapping());
        let mut i = input(&t, &m);
        i.depreciation_current = false;
        assert_eq!(check_finalise(&i), vec![FinaliseProblem::DepreciationStale]);
    }

    #[test]
    fn unsorted_lines_are_refused_unless_accepted() {
        let (t, m) = (tb(&[]), mapping());
        let mut i = input(&t, &m);
        i.uncategorised_lines = 3;
        let problems = check_finalise(&i);
        assert_eq!(
            problems,
            vec![FinaliseProblem::UncategorisedLines { count: 3 }]
        );
        assert_eq!(
            problems[0].to_string(),
            "3 bank lines are still to be sorted. Sort them first, or accept them as they are."
        );
        i.uncategorised_lines = 1;
        assert_eq!(
            check_finalise(&i)[0].to_string(),
            "1 bank line is still to be sorted. Sort it first, or accept it as it is."
        );
        i.accept_uncategorised = true;
        assert_eq!(check_finalise(&i), vec![]);
    }
}
