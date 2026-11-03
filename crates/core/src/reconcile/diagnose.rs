//! Explaining the whole difference (M18): of everything the suspects found, which findings
//! together account for the difference exactly, and what's left when none do.
//!
//! **Exact.** The search looks for a set of findings whose `explains` add up to the window's
//! difference. Two findings that share any evidence (two suspects pointing at one line, journal,
//! statement or gap) can't both be in it: fixing one would already fix the other. Of the sets that
//! add up, the best is the one with the fewest Possible findings, then the fewest findings, then
//! the earliest in the order the findings came in ([`super::suspects::look_all`]'s). So a set of
//! Likely findings beats a single Possible one that happens to match, and a smaller set wins
//! between findings of equal confidence.
//!
//! The search is exact over at most [`MAX_SEARCH`] findings (about a million sets). With more, it
//! keeps the [`MAX_SEARCH`] best by Likely first, then the largest amount, then the incoming order;
//! the rest still appear in `other_findings`, and the fallback below still sees every Likely one.
//!
//! **No exact set.** Take Likely findings largest first, skipping any that would move the
//! difference away from zero or that share evidence with one already taken, and report what's
//! left as the remainder.
//!
//! **Nothing to explain.** A difference of zero gives an empty explanation; whatever the suspects
//! found goes into `other_findings`.
//!
//! Pure and deterministic: the same window and findings always give the same diagnosis.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::checkpoints::Window;
use super::finding::{Confidence, Finding};
use crate::money::{Money, money_from_i128};

/// How many findings the exact search looks at.
pub const MAX_SEARCH: usize = 20;

/// Why the books and the bank differ, as far as the findings tell.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Diagnosis {
    /// Ledger less stated, from the window.
    pub difference: Money,
    /// The best explanation, in the order the findings came in. Empty when nothing differs or
    /// nothing helps.
    pub explained_by: Vec<Finding>,
    /// `difference` less what `explained_by` explains: zero when the explanation is exact.
    pub remainder: Money,
    /// Every other finding, in the order they came in.
    pub other_findings: Vec<Finding>,
}

/// Explains `window`'s difference from `findings`, given in [`super::suspects::look_all`]'s order.
pub fn diagnose(window: &Window, findings: Vec<Finding>) -> Diagnosis {
    let difference = window.difference;
    let chosen = if difference.is_zero() {
        Vec::new()
    } else {
        exact(difference, &findings).unwrap_or_else(|| closest(difference, &findings))
    };

    let mut explained_by = Vec::new();
    let mut other_findings = Vec::new();
    for (i, f) in findings.into_iter().enumerate() {
        if chosen.contains(&i) {
            explained_by.push(f);
        } else {
            other_findings.push(f);
        }
    }
    let explained: i128 = explained_by
        .iter()
        .map(|f| i128::from(f.explains.cents()))
        .sum();
    Diagnosis {
        difference,
        remainder: money_from_i128(i128::from(difference.cents()) - explained),
        explained_by,
        other_findings,
    }
}

/// Whether two findings point at any of the same things.
fn conflict(a: &Finding, b: &Finding) -> bool {
    a.evidence.iter().any(|e| b.evidence.contains(e))
}

fn likely(f: &Finding) -> bool {
    f.confidence == Confidence::Likely
}

/// Indices into `findings`, Likely first, then largest, then incoming order.
fn by_rank(findings: &[Finding]) -> Vec<usize> {
    let mut order: Vec<usize> = (0..findings.len())
        .filter(|&i| !findings[i].explains.is_zero())
        .collect();
    order.sort_by_key(|&i| {
        let f = &findings[i];
        (
            !likely(f),
            std::cmp::Reverse(f.explains.cents().unsigned_abs()),
            i,
        )
    });
    order
}

/// The best set that adds up to `difference` exactly, as sorted indices into `findings`.
fn exact(difference: Money, findings: &[Finding]) -> Option<Vec<usize>> {
    let mut pool = by_rank(findings);
    pool.truncate(MAX_SEARCH);
    pool.sort_unstable();

    let mut search = Search {
        findings,
        pool: &pool,
        target: i128::from(difference.cents()),
        current: Vec::new(),
        best: None,
    };
    search.go(0, 0, 0);
    search.best.map(|(_, set)| set)
}

/// (Possible findings, findings) of a set: smaller is better.
type Cost = (usize, usize);

struct Search<'a> {
    findings: &'a [Finding],
    /// Candidates, in incoming order, so sets are built in that order too.
    pool: &'a [usize],
    target: i128,
    current: Vec<usize>,
    best: Option<(Cost, Vec<usize>)>,
}

impl Search<'_> {
    /// Tries adding each candidate from `from` on to the current set, whose sum is `sum` and which
    /// holds `possible` Possible findings.
    fn go(&mut self, from: usize, sum: i128, possible: usize) {
        for k in from..self.pool.len() {
            let i = self.pool[k];
            let f = &self.findings[i];
            let cost = (possible + usize::from(!likely(f)), self.current.len() + 1);
            // Adding more only costs more, and an equal cost with this set is no better: a set
            // found earlier comes first in incoming order.
            if self.best.as_ref().is_some_and(|(b, _)| cost >= *b) {
                continue;
            }
            if self.current.iter().any(|&j| conflict(&self.findings[j], f)) {
                continue;
            }
            let sum = sum + i128::from(f.explains.cents());
            self.current.push(i);
            if sum == self.target {
                self.best = Some((cost, self.current.clone()));
            } else {
                self.go(k + 1, sum, cost.0);
            }
            self.current.pop();
        }
    }
}

/// No exact set: Likely findings, largest first, while each brings the difference closer to zero.
fn closest(difference: Money, findings: &[Finding]) -> Vec<usize> {
    let mut left = i128::from(difference.cents());
    let mut chosen: Vec<usize> = Vec::new();
    for i in by_rank(findings) {
        let f = &findings[i];
        if !likely(f) || chosen.iter().any(|&j| conflict(&findings[j], f)) {
            continue;
        }
        let after = left - i128::from(f.explains.cents());
        if after.abs() < left.abs() {
            left = after;
            chosen.push(i);
        }
    }
    chosen.sort_unstable();
    chosen
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::reconcile::checkpoints::Shape;
    use crate::reconcile::finding::{EvidenceRef, FindingKind};

    fn window(cents: i64) -> Window {
        Window {
            last_agrees: None,
            first_differs: if cents == 0 { None } else { Some(0) },
            difference: Money::from_cents(cents),
            shape: Shape::Jump,
        }
    }

    fn finding(kind: FindingKind, cents: i64, likely: bool, lines: &[&str]) -> Finding {
        Finding {
            kind,
            explains: Money::from_cents(cents),
            confidence: if likely {
                Confidence::Likely
            } else {
                Confidence::Possible
            },
            evidence: lines
                .iter()
                .map(|l| EvidenceRef::BankLine {
                    bank_line_id: (*l).to_owned(),
                })
                .collect(),
            fix: None,
        }
    }

    fn kinds(fs: &[Finding]) -> Vec<(FindingKind, i64)> {
        fs.iter().map(|f| (f.kind, f.explains.cents())).collect()
    }

    use FindingKind::*;

    #[test]
    fn nothing_differs_nothing_explained() {
        let found = vec![finding(Duplicate, -500, true, &["a"])];
        let d = diagnose(&window(0), found.clone());
        assert!(d.explained_by.is_empty());
        assert_eq!(d.remainder, Money::ZERO);
        assert_eq!(d.other_findings, found);
    }

    #[test]
    fn one_finding_explains_it() {
        let d = diagnose(
            &window(-500),
            vec![
                finding(Duplicate, -300, true, &["a"]),
                finding(EntryByHand, -500, true, &["b"]),
            ],
        );
        assert_eq!(kinds(&d.explained_by), vec![(EntryByHand, -500)]);
        assert_eq!(d.remainder, Money::ZERO);
        assert_eq!(kinds(&d.other_findings), vec![(Duplicate, -300)]);
    }

    #[test]
    fn two_findings_add_up() {
        let d = diagnose(
            &window(-800),
            vec![
                finding(Duplicate, -300, true, &["a"]),
                finding(WrongOpeningBalance, -500, true, &["open"]),
                finding(EntryByHand, 200, true, &["c"]),
            ],
        );
        assert_eq!(
            kinds(&d.explained_by),
            vec![(Duplicate, -300), (WrongOpeningBalance, -500)]
        );
        assert_eq!(d.remainder, Money::ZERO);
    }

    #[test]
    fn findings_on_the_same_line_cant_both_count() {
        // -300 twice would add up, but both point at line a.
        let d = diagnose(
            &window(-600),
            vec![
                finding(Duplicate, -300, true, &["a"]),
                finding(MarkedDuplicateButIsnt, -300, true, &["a"]),
            ],
        );
        assert!(d.remainder != Money::ZERO);
        assert_eq!(d.explained_by.len(), 1);
    }

    #[test]
    fn likely_beats_possible_then_fewer_wins() {
        // A Possible finding matches alone, but two Likely ones add up too: Likely wins.
        let d = diagnose(
            &window(-800),
            vec![
                finding(Duplicate, -300, true, &["a"]),
                finding(WrongOpeningBalance, -500, true, &["open"]),
                finding(SignReversed, -800, false, &["s"]),
            ],
        );
        assert_eq!(d.explained_by.len(), 2);

        // All Likely: the single finding beats the pair.
        let d = diagnose(
            &window(-800),
            vec![
                finding(Duplicate, -300, true, &["a"]),
                finding(WrongOpeningBalance, -500, true, &["open"]),
                finding(SignReversed, -800, true, &["s"]),
            ],
        );
        assert_eq!(kinds(&d.explained_by), vec![(SignReversed, -800)]);
    }

    #[test]
    fn equal_sets_go_by_incoming_order() {
        let d = diagnose(
            &window(-6_300),
            vec![
                finding(WrongOpeningBalance, -6_300, true, &["open"]),
                finding(TransposedDigits, -6_300, true, &["open2"]),
            ],
        );
        assert_eq!(kinds(&d.explained_by), vec![(WrongOpeningBalance, -6_300)]);
    }

    #[test]
    fn no_exact_set_gets_closest_with_likely() {
        let d = diagnose(
            &window(-1_000),
            vec![
                finding(Duplicate, -300, true, &["a"]),
                finding(EntryByHand, -2_500, true, &["b"]),
                finding(WrongOpeningBalance, -400, true, &["open"]),
                finding(SignReversed, -250, false, &["s"]),
            ],
        );
        // -2500 overshoots further than -1000, so it's skipped; -400 then -300 help.
        assert_eq!(
            kinds(&d.explained_by),
            vec![(Duplicate, -300), (WrongOpeningBalance, -400)]
        );
        assert_eq!(d.remainder, Money::from_cents(-300));
    }

    #[test]
    fn nothing_helps() {
        let d = diagnose(&window(-1_000), vec![finding(Duplicate, 300, true, &["a"])]);
        assert!(d.explained_by.is_empty());
        assert_eq!(d.remainder, Money::from_cents(-1_000));
        assert_eq!(d.other_findings.len(), 1);
    }

    #[test]
    fn only_the_best_twenty_are_searched() {
        // 25 Possible -1 findings, and two Likely findings that add up to the difference.
        let mut found: Vec<Finding> = (0..25)
            .map(|i| finding(EntryByHand, -1, false, &[&format!("p{i}")]))
            .collect();
        found.push(finding(Duplicate, -40, true, &["a"]));
        found.push(finding(Duplicate, -2, true, &["b"]));
        let d = diagnose(&window(-42), found);
        assert_eq!(
            kinds(&d.explained_by),
            vec![(Duplicate, -40), (Duplicate, -2)]
        );
        assert_eq!(d.other_findings.len(), 25);
    }

    #[test]
    fn the_same_findings_give_the_same_diagnosis() {
        let found = vec![
            finding(Duplicate, -300, true, &["a"]),
            finding(Duplicate, -200, true, &["b"]),
            finding(EntryByHand, -500, true, &["c"]),
        ];
        assert_eq!(
            diagnose(&window(-500), found.clone()),
            diagnose(&window(-500), found)
        );
    }

    fn arb_finding() -> impl Strategy<Value = Finding> {
        (0usize..10, -5_000i64..5_000, any::<bool>(), 0usize..8).prop_map(
            |(kind, cents, likely, line)| {
                let kinds = [
                    Duplicate,
                    MissingLines,
                    WrongOpeningBalance,
                    SignReversed,
                    MarkedDuplicateButIsnt,
                    EntryByHand,
                    DateCutOff,
                    WrongAccount,
                    AmountReadWrong,
                    TransposedDigits,
                ];
                finding(kinds[kind], cents, likely, &[&format!("l{line}")])
            },
        )
    }

    proptest! {
        #[test]
        fn explained_plus_remainder_is_the_difference(
            difference in -20_000i64..20_000,
            found in prop::collection::vec(arb_finding(), 0..24),
        ) {
            let d = diagnose(&window(difference), found.clone());
            let explained: i64 = d.explained_by.iter().map(|f| f.explains.cents()).sum();
            prop_assert_eq!(explained, difference - d.remainder.cents());
            prop_assert_eq!(d.difference.cents(), difference);
            // Every finding is in exactly one list.
            prop_assert_eq!(d.explained_by.len() + d.other_findings.len(), found.len());
            // No two chosen findings share evidence.
            for (i, a) in d.explained_by.iter().enumerate() {
                for b in &d.explained_by[i + 1..] {
                    prop_assert!(!conflict(a, b));
                }
            }
            if difference == 0 {
                prop_assert!(d.explained_by.is_empty());
            }
            // The fallback never makes things worse.
            prop_assert!(d.remainder.cents().abs() <= difference.abs());
        }
    }
}
