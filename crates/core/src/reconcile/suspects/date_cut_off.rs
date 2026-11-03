//! **Date cut-off** (suspect 7): a line on the other side of a checkpoint in the ledger from where
//! the file puts it. A statement's closing balance includes every line in the file, but a line the
//! file dates after that balance's date is after it in the ledger too; an opening balance excludes
//! the file's lines, but one dated before it is before it in the ledger.
//!
//! Looks at each checkpoint where a step shows, and the lines of that checkpoint's own statement
//! within [`NEAR_DAYS`](super::NEAR_DAYS) on the wrong side of it. Lines after a closing or running
//! balance `explain` minus their total; lines before an opening balance `explain` their total.
//! **Likely** when that's exactly the step; **Possible** when it's the difference. There's nothing
//! to undo, so no fix: the owner or their accountant decides (a journal, or a timing difference).

use super::{Scope, Suspect, SuspectInput, near};
use crate::money::Money;
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind};

pub struct DateCutOff;

impl Suspect for DateCutOff {
    fn kind(&self) -> FindingKind {
        FindingKind::DateCutOff
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        let lines = input.posting_lines();
        let mut out = Vec::new();
        for step in &scope.steps {
            let Some(cp) = input.checkpoints.get(step.at) else {
                continue;
            };
            let wrong_side: Vec<_> = lines
                .iter()
                .filter(|l| l.statement_id == cp.source.statement_id && near(l.date, cp.date))
                .filter(|l| {
                    if cp.end_of_day() {
                        l.date > cp.date
                    } else {
                        l.date < cp.date
                    }
                })
                .collect();
            if wrong_side.is_empty() {
                continue;
            }
            let total: Money = wrong_side.iter().map(|l| l.amount).sum();
            let explains = if cp.end_of_day() { -total } else { total };
            let confidence = if explains == step.by {
                Confidence::Likely
            } else if scope.hits(explains) {
                Confidence::Possible
            } else {
                continue;
            };
            out.push(Finding {
                kind: FindingKind::DateCutOff,
                explains,
                confidence,
                evidence: wrong_side
                    .iter()
                    .map(|l| EvidenceRef::BankLine {
                        bank_line_id: l.id.clone(),
                    })
                    .collect(),
                fix: None,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    #[test]
    fn a_line_dated_after_the_closing_balance_that_includes_it() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        s.stated_opening = Some(m(10_000));
        s.stated_closing = Some(m(10_000 - 500 - 8_590));
        let lines = vec![
            line("a", "s1", "2025-08-05", -500, "KAURI PETROL"),
            line("late", "s1", "2025-09-01", -8_590, "GREENBARROW GROCERS"),
        ];
        let found = DateCutOff.look(&input(10_000, vec![s], lines, vec![]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(8_590));
        assert_eq!(found[0].confidence, Confidence::Likely);
    }
}
