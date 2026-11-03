//! **Duplicates** (suspect 1): a line uploaded twice, so the ledger has it twice and the bank once.
//!
//! Two posting lines are a pair when they're in different statements, have the same amount, are
//! within [`NEAR_DAYS`] of each other, and either share the bank's id (OFX `FITID`) or have the
//! same description once normalised ([`same_description`]: one file's `NAME` against another's
//! `MEMO`, or text the bank cut short). The duplicate is the one uploaded later; it `explains` its
//! own amount. At least one of the pair must be inside a step's window. Each line is in at most
//! one pair: same bank id first, then the nearest dates.
//!
//! **Likely** when:
//! - the two share a bank id (the bank says it's one transaction), or
//! - the descriptions match and the two files overlap in days, or M10 flagged the later line and
//!   the owner hasn't said it isn't a duplicate.
//!
//! Otherwise **Possible**. Two identical lines in the *same* file are two real purchases (M10 keeps
//! both); they're reported only as Possible, and only when one of them is exactly a step or the
//! difference.
//!
//! When every posting line of a statement (two or more) is the later half of a pair, the whole
//! file was uploaded twice: one finding for the statement, fixed by removing it, instead of one
//! per line. Otherwise one finding per pair, fixed by marking the later line a duplicate, which
//! `resolve_duplicate` allows only for lines M10 flagged; an unflagged line gets no fix.

use std::collections::{BTreeMap, BTreeSet};

use super::{NEAR_DAYS, Scope, Suspect, SuspectInput, SuspectLine, same_description};
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};

pub struct Duplicates;

struct Pair<'a> {
    later: &'a SuspectLine,
    earlier: &'a SuspectLine,
    likely: bool,
}

impl Suspect for Duplicates {
    fn kind(&self) -> FindingKind {
        FindingKind::Duplicate
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        let lines = input.posting_lines();
        let order = |l: &SuspectLine| {
            let seq = input
                .statement(&l.statement_id)
                .map_or(0, |s| s.imported_seq);
            (seq, l.id.clone())
        };
        let overlap = |a: &str, b: &str| match (input.statement(a), input.statement(b)) {
            (Some(a), Some(b)) => a.start <= b.end && b.start <= a.end,
            _ => false,
        };

        // Candidate pairs across files: (same bank id, days apart, earlier id, later id).
        let mut candidates: Vec<(bool, i64, &SuspectLine, &SuspectLine)> = Vec::new();
        for (i, a) in lines.iter().enumerate() {
            for b in lines[i + 1..]
                .iter()
                .take_while(|b| (b.date - a.date).num_days() <= NEAR_DAYS)
            {
                if a.statement_id == b.statement_id || a.amount != b.amount {
                    continue;
                }
                if !scope.contains(a.date) && !scope.contains(b.date) {
                    continue;
                }
                let same_id = a
                    .bank_id
                    .as_ref()
                    .is_some_and(|x| !x.is_empty() && b.bank_id.as_ref() == Some(x));
                if !same_id && !same_description(&a.description, &b.description) {
                    continue;
                }
                let (earlier, later) = if order(a) < order(b) {
                    (*a, *b)
                } else {
                    (*b, *a)
                };
                candidates.push((same_id, (a.date - b.date).num_days().abs(), earlier, later));
            }
        }
        candidates
            .sort_by(|x, y| (!x.0, x.1, &x.3.id, &x.2.id).cmp(&(!y.0, y.1, &y.3.id, &y.2.id)));
        let mut used: BTreeSet<&str> = BTreeSet::new();
        let mut pairs: Vec<Pair<'_>> = Vec::new();
        for (same_id, _, earlier, later) in candidates {
            if used.contains(earlier.id.as_str()) || used.contains(later.id.as_str()) {
                continue;
            }
            used.insert(&earlier.id);
            used.insert(&later.id);
            let flagged = later.possible_duplicate && later.duplicate_answer != Some(false);
            let likely = same_id || overlap(&earlier.statement_id, &later.statement_id) || flagged;
            pairs.push(Pair {
                later,
                earlier,
                likely,
            });
        }

        let mut out = Vec::new();

        // Whole statements uploaded twice.
        let mut by_statement: BTreeMap<&str, Vec<&Pair<'_>>> = BTreeMap::new();
        for p in &pairs {
            by_statement
                .entry(&p.later.statement_id)
                .or_default()
                .push(p);
        }
        let mut whole: BTreeSet<&str> = BTreeSet::new();
        for (statement_id, ps) in &by_statement {
            let posting = lines
                .iter()
                .filter(|l| l.statement_id == *statement_id)
                .count();
            if posting < 2 || ps.len() != posting {
                continue;
            }
            whole.insert(statement_id);
            let mut evidence = vec![EvidenceRef::Statement {
                statement_id: (*statement_id).to_owned(),
            }];
            evidence.extend(ps.iter().map(|p| EvidenceRef::BankLine {
                bank_line_id: p.later.id.clone(),
            }));
            out.push(Finding {
                kind: FindingKind::Duplicate,
                explains: ps.iter().map(|p| p.later.amount).sum(),
                confidence: if ps.iter().all(|p| p.likely) {
                    Confidence::Likely
                } else {
                    Confidence::Possible
                },
                evidence,
                fix: Some(SuggestedFix::RemoveStatement {
                    statement_id: (*statement_id).to_owned(),
                }),
            });
        }

        // The rest, one pair at a time.
        for p in pairs
            .iter()
            .filter(|p| !whole.contains(p.later.statement_id.as_str()))
        {
            out.push(pair_finding(p.later, p.earlier, p.likely));
        }

        // Identical lines in one file: real purchases, unless one is exactly what's out.
        for (i, a) in lines.iter().enumerate() {
            for b in lines[i + 1..].iter().take_while(|b| b.date == a.date) {
                if a.statement_id != b.statement_id
                    || a.amount != b.amount
                    || a.description != b.description
                    || used.contains(a.id.as_str())
                    || used.contains(b.id.as_str())
                    || !scope.contains(b.date)
                    || !scope.hits(b.amount)
                {
                    continue;
                }
                out.push(pair_finding(b, a, false));
            }
        }
        out
    }
}

fn pair_finding(later: &SuspectLine, earlier: &SuspectLine, likely: bool) -> Finding {
    Finding {
        kind: FindingKind::Duplicate,
        explains: later.amount,
        confidence: if likely {
            Confidence::Likely
        } else {
            Confidence::Possible
        },
        evidence: vec![
            EvidenceRef::BankLine {
                bank_line_id: later.id.clone(),
            },
            EvidenceRef::BankLine {
                bank_line_id: earlier.id.clone(),
            },
        ],
        fix: later
            .possible_duplicate
            .then(|| SuggestedFix::MarkDuplicate {
                bank_line_id: later.id.clone(),
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    fn cafe_pair_input(same_file: bool) -> SuspectInput {
        let mut s1 = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![
            line("a", "s1", "2025-08-05", -720, "PIKORUA CAFE WELLINGTON"),
            line("b", "s1", "2025-08-05", -720, "PIKORUA CAFE WELLINGTON"),
        ];
        with_balances(&mut s1, &mut lines, 1_000);
        // The bank says the second wasn't there: the ledger is out by exactly one of them.
        s1.stated_closing = Some(m(1_000 - 720));
        lines[1].balance = None;
        let mut statements = vec![s1];
        if !same_file {
            lines[1].statement_id = "s2".into();
            statements.push(statement("s2", 2, "2025-08-01", "2025-08-31"));
        }
        input(1_000, statements, lines, vec![])
    }

    #[test]
    fn identical_lines_in_one_file_are_never_likely() {
        let found = Duplicates.look(&cafe_pair_input(true));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].confidence, Confidence::Possible);
        assert_eq!(found[0].explains, m(-720));
    }

    #[test]
    fn the_same_line_in_two_overlapping_files_is_likely() {
        let found = Duplicates.look(&cafe_pair_input(false));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].confidence, Confidence::Likely);
        assert_eq!(
            found[0].evidence[0],
            EvidenceRef::BankLine {
                bank_line_id: "b".into()
            }
        );
    }

    #[test]
    fn the_same_bank_id_is_always_likely() {
        let mut s1 = statement("s1", 1, "2025-08-01", "2025-08-10");
        s1.stated_opening = Some(m(1_000));
        s1.stated_closing = Some(m(500));
        let mut s2 = statement("s2", 2, "2025-09-01", "2025-09-30");
        s2.stated_opening = Some(m(500));
        s2.stated_closing = Some(m(500));
        let mut a = line("a", "s1", "2025-08-08", -500, "KAURI PETROL NELSON");
        a.bank_id = Some("F1".into());
        // A different date and text, in a file that doesn't overlap, but the same FITID.
        let mut b = line("b", "s2", "2025-08-10", -500, "EFTPOS PURCHASE 0451");
        b.bank_id = Some("F1".into());
        let found = Duplicates.look(&input(1_000, vec![s1, s2], vec![a, b], vec![]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].confidence, Confidence::Likely);
        assert_eq!(
            found[0].fix, None,
            "b wasn't flagged, so it can't be marked"
        );
    }

    #[test]
    fn a_whole_file_uploaded_twice_is_one_finding() {
        let mut s1 = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![
            line("a", "s1", "2025-08-05", -500, "KAURI PETROL NELSON"),
            line("b", "s1", "2025-08-12", -700, "GREENBARROW GROCERS"),
        ];
        with_balances(&mut s1, &mut lines, 1_000);
        let s2 = statement("s2", 2, "2025-08-01", "2025-08-31");
        for (id, from) in [("a2", 0), ("b2", 1)] {
            let mut l = lines[from].clone();
            l.id = id.into();
            l.statement_id = "s2".into();
            l.balance = None;
            l.description = format!("CARD PURCHASE {}", l.description);
            l.possible_duplicate = true;
            lines.push(l);
        }
        let found = Duplicates.look(&input(1_000, vec![s1, s2], lines, vec![]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(-1_200));
        assert_eq!(found[0].confidence, Confidence::Likely);
        assert_eq!(
            found[0].fix,
            Some(SuggestedFix::RemoveStatement {
                statement_id: "s2".into()
            })
        );
    }

    #[test]
    fn lines_the_owner_marked_are_left_alone() {
        let mut input = cafe_pair_input(false);
        input.lines[1].duplicate_answer = Some(true);
        assert!(Duplicates.look(&input).is_empty());
    }
}
