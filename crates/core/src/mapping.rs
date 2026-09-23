//! Mappings: account-code ranges pointing at template lines.

use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::chart::AccountCode;
use crate::ledger::TrialBalance;
use crate::template::{LineKey, Node, Template};

/// An inclusive range of account codes mapped to one template line.
///
/// `to` also covers its own sub-accounts, so `200`–`299` includes `299.05`. See `docs/domain.md`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MappingRange {
    pub from: AccountCode,
    pub to: AccountCode,
    pub line: LineKey,
}

impl MappingRange {
    pub fn contains(&self, code: &AccountCode) -> bool {
        *code >= self.from && code.cmp_truncated(&self.to) != Ordering::Greater
    }
}

/// The ranges that place accounts on a template's lines. Versions are tracked by the store; a
/// finalised year pins the version it used.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Mapping {
    pub ranges: Vec<MappingRange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum MappingError {
    #[error("the range {from}–{to} ends before it starts")]
    ReversedRange { from: AccountCode, to: AccountCode },
    #[error("the range {from}–{to} points at {line}, which isn't a line in the template")]
    UnknownLine {
        from: AccountCode,
        to: AccountCode,
        line: LineKey,
    },
    #[error("the ranges {first_from}–{first_to} and {second_from}–{second_to} overlap")]
    Overlap {
        first_from: AccountCode,
        first_to: AccountCode,
        second_from: AccountCode,
        second_to: AccountCode,
    },
    #[error("account {account} has a balance but isn't mapped to any line")]
    Unmapped { account: AccountCode },
}

impl Mapping {
    /// Checks the mapping on its own: ranges run forwards, point at `Line` rows in the template,
    /// and don't overlap. Returns every problem found.
    pub fn validate(&self, template: &Template) -> Result<(), Vec<MappingError>> {
        let mut errors = Vec::new();
        for r in &self.ranges {
            if r.from.cmp_truncated(&r.to) == Ordering::Greater {
                errors.push(MappingError::ReversedRange {
                    from: r.from.clone(),
                    to: r.to.clone(),
                });
            }
            if !matches!(template.find(&r.line), Some(Node::Line { .. })) {
                errors.push(MappingError::UnknownLine {
                    from: r.from.clone(),
                    to: r.to.clone(),
                    line: r.line.clone(),
                });
            }
        }
        // Each range is an interval in code order, so sorted by start, two ranges overlap exactly
        // when the later one's start falls inside an earlier one.
        let mut sorted: Vec<&MappingRange> = self.ranges.iter().collect();
        sorted.sort_by(|a, b| a.from.cmp(&b.from));
        for (i, later) in sorted.iter().enumerate() {
            for earlier in &sorted[..i] {
                if earlier.contains(&later.from) {
                    errors.push(MappingError::Overlap {
                        first_from: earlier.from.clone(),
                        first_to: earlier.to.clone(),
                        second_from: later.from.clone(),
                        second_to: later.to.clone(),
                    });
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    /// The line an account maps to, if any. Assumes a validated mapping (no overlaps).
    pub fn line_for(&self, code: &AccountCode) -> Option<&LineKey> {
        self.ranges
            .iter()
            .find(|r| r.contains(code))
            .map(|r| &r.line)
    }

    /// Places every account with a non-zero balance in any of `tbs` (typically the current and
    /// prior year) on its line. Accounts that don't map anywhere are errors, never dropped.
    pub fn assign<'a>(
        &self,
        tbs: impl IntoIterator<Item = &'a TrialBalance>,
    ) -> Result<BTreeMap<AccountCode, LineKey>, Vec<MappingError>> {
        let mut assigned = BTreeMap::new();
        let mut errors = Vec::new();
        for tb in tbs {
            for (code, _) in tb.iter() {
                if assigned.contains_key(code) {
                    continue;
                }
                match self.line_for(code) {
                    Some(line) => {
                        assigned.insert(code.clone(), line.clone());
                    }
                    None => {
                        let e = MappingError::Unmapped {
                            account: code.clone(),
                        };
                        if !errors.contains(&e) {
                            errors.push(e);
                        }
                    }
                }
            }
        }
        errors.sort_by(|a, b| match (a, b) {
            (MappingError::Unmapped { account: x }, MappingError::Unmapped { account: y }) => {
                x.cmp(y)
            }
            _ => Ordering::Equal,
        });
        if errors.is_empty() {
            Ok(assigned)
        } else {
            Err(errors)
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::chart::tests::code;
    use crate::ledger::TbLine;
    use crate::money::Money;
    use crate::template::tests::{company_template, key};
    use proptest::prelude::*;

    pub fn range(from: &str, to: &str, line: &str) -> MappingRange {
        MappingRange {
            from: code(from),
            to: code(to),
            line: key(line),
        }
    }

    pub fn company_mapping() -> Mapping {
        Mapping {
            ranges: vec![
                range("100", "199", "sales"),
                range("200", "299", "other_income"),
                range("400", "404", "bank_fees"),
                range("405", "409", "repairs"),
                range("410", "599", "other_expenses"),
                range("600", "619", "bank"),
                range("620", "699", "receivables"),
                range("800", "849", "payables"),
                range("850", "899", "loans"),
                range("900", "949", "share_capital"),
                range("950", "999", "retained_earnings"),
            ],
        }
    }

    fn tb(entries: &[(&str, i64)]) -> TrialBalance {
        entries
            .iter()
            .map(|&(c, cents)| TbLine {
                account: code(c),
                balance: Money::from_cents(cents),
            })
            .collect::<Vec<_>>()
            .into()
    }

    #[test]
    fn ranges_include_sub_accounts_of_the_upper_code() {
        let r = range("200", "299", "sales");
        for inside in ["200", "0200", "200.01", "250", "299", "299.05", "299.A.1"] {
            assert!(r.contains(&code(inside)), "{inside}");
        }
        for outside in ["199", "199.99", "300", "1000", "A200"] {
            assert!(!r.contains(&code(outside)), "{outside}");
        }
        assert!(range("200.01", "200.01", "sales").contains(&code("200.01.3")));
        assert!(!range("200.01", "200.01", "sales").contains(&code("200.02")));
    }

    #[test]
    fn company_mapping_is_valid() {
        assert_eq!(company_mapping().validate(&company_template()), Ok(()));
    }

    #[test]
    fn rejects_reversed_ranges_and_unknown_or_non_line_targets() {
        let m = Mapping {
            ranges: vec![
                range("300", "200", "sales"),
                range("1000", "1099", "nope"),
                range("1100", "1199", "income"), // a group, not a line
                range("1200", "1299", "profit_for_year"), // a link, not a line
            ],
        };
        let errors = m.validate(&company_template()).unwrap_err();
        assert_eq!(
            errors,
            vec![
                MappingError::ReversedRange {
                    from: code("300"),
                    to: code("200")
                },
                MappingError::UnknownLine {
                    from: code("1000"),
                    to: code("1099"),
                    line: key("nope")
                },
                MappingError::UnknownLine {
                    from: code("1100"),
                    to: code("1199"),
                    line: key("income")
                },
                MappingError::UnknownLine {
                    from: code("1200"),
                    to: code("1299"),
                    line: key("profit_for_year")
                },
            ]
        );
    }

    #[test]
    fn rejects_overlaps() {
        let overlaps = |ranges: Vec<MappingRange>| {
            Mapping { ranges }
                .validate(&company_template())
                .unwrap_err()
        };
        assert_eq!(
            overlaps(vec![
                range("100", "199", "sales"),
                range("150", "250", "other_income")
            ]),
            vec![MappingError::Overlap {
                first_from: code("100"),
                first_to: code("199"),
                second_from: code("150"),
                second_to: code("250"),
            }]
        );
        // Touching ends overlap: 199 is in both.
        assert_eq!(
            overlaps(vec![
                range("199", "250", "sales"),
                range("100", "199", "other_income")
            ])
            .len(),
            1
        );
        // A sub-account start inside the earlier range's upper code.
        assert_eq!(
            overlaps(vec![
                range("100", "199", "sales"),
                range("199.5", "205", "other_income")
            ])
            .len(),
            1
        );
        // Nested ranges.
        assert_eq!(
            overlaps(vec![
                range("100", "999", "sales"),
                range("300", "400", "other_income")
            ])
            .len(),
            1
        );
    }

    #[test]
    fn adjacent_ranges_are_fine() {
        let m = Mapping {
            ranges: vec![
                range("100", "199", "sales"),
                range("200", "299", "other_income"),
            ],
        };
        assert_eq!(m.validate(&company_template()), Ok(()));
    }

    #[test]
    fn assigns_accounts_across_years_and_reports_unmapped() {
        let current = tb(&[("100", -500), ("610", 500)]);
        let prior = tb(&[("405", 300), ("610", -300)]);
        let assigned = company_mapping().assign([&current, &prior]).unwrap();
        let pairs: Vec<(&str, &str)> = assigned
            .iter()
            .map(|(c, l)| (c.as_str(), l.as_str()))
            .collect();
        assert_eq!(
            pairs,
            [("100", "sales"), ("405", "repairs"), ("610", "bank")]
        );

        let current = tb(&[("100", -500), ("3000", 500), ("700", 1)]);
        let prior = tb(&[("700", 2), ("100", -2)]);
        assert_eq!(
            company_mapping().assign([&current, &prior]),
            Err(vec![
                MappingError::Unmapped {
                    account: code("700")
                },
                MappingError::Unmapped {
                    account: code("3000")
                },
            ])
        );
    }

    fn arb_code() -> impl Strategy<Value = AccountCode> {
        proptest::collection::vec("[0-9]{1,3}|[A-C]", 1..3).prop_map(|s| code(&s.join(".")))
    }

    proptest! {
        /// A validated mapping gives each account at most one line, and every line_for hit is in
        /// exactly one range.
        #[test]
        fn validated_ranges_never_share_a_code(
            bounds in proptest::collection::vec((arb_code(), arb_code()), 1..6),
            probe in arb_code(),
        ) {
            let m = Mapping {
                ranges: bounds
                    .into_iter()
                    .map(|(a, b)| MappingRange { from: a.clone().min(b.clone()), to: a.max(b), line: key("sales") })
                    .collect(),
            };
            let hits = m.ranges.iter().filter(|r| r.contains(&probe)).count();
            if m.validate(&company_template()).is_ok() {
                prop_assert!(hits <= 1);
            } else if hits > 1 {
                // An overlap that contains the probe must have been reported.
                let errors = m.validate(&company_template()).unwrap_err();
                let reported = errors.iter().any(|e| matches!(e, MappingError::Overlap { .. }));
                prop_assert!(reported);
            }
        }
    }
}
