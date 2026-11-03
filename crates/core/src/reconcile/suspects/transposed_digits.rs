//! **Transposed digits** (suspect 10): two digits swapped in an amount a person typed. Only typed
//! amounts: a bank file doesn't swap digits.
//!
//! - **The opening balance**, when the first checkpoint already differs (as for Wrong opening
//!   balance) and swapping two digits of the entered amount gives the one that makes it agree.
//!   It `explains` the difference there, and the fix sets the right amount. **Likely** when Wrong
//!   opening balance's evidence is strong (a Constant shape, or the first checkpoint is an opening
//!   balance on the same date), **Possible** otherwise. An opening balance worked out from a file
//!   isn't typed, but then it agrees with that file, so it's never a suspect here.
//! - **A journal by hand** inside a step's window, where the journal less a step (or the
//!   difference) is its amount with two digits swapped. It `explains` that step. **Likely** when
//!   it's the step its window shows. No fix: reversing it would take off the whole amount, not the
//!   typo, so the owner or their accountant reposts it.
//!
//! Such a difference always divides by 9 ([`is_transposition`]).

use super::wrong_opening_balance::opening_check;
use super::{JournalOrigin, Scope, Suspect, SuspectInput, is_transposition};
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind};

pub struct TransposedDigits;

impl Suspect for TransposedDigits {
    fn kind(&self) -> FindingKind {
        FindingKind::TransposedDigits
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        if let Some(c) = opening_check(input)
            && input.opening.is_some()
            && is_transposition(c.entered, c.meant)
        {
            out.push(Finding {
                kind: FindingKind::TransposedDigits,
                explains: c.difference,
                confidence: if c.strong {
                    Confidence::Likely
                } else {
                    Confidence::Possible
                },
                evidence: c.evidence,
                fix: Some(c.fix),
            });
        }

        let mut journals: Vec<_> = input
            .journals
            .iter()
            .filter(|j| j.origin == JournalOrigin::ByHand)
            .collect();
        journals.sort_by(|a, b| (a.date, &a.id).cmp(&(b.date, &b.id)));
        for j in journals {
            let in_step = scope
                .steps
                .iter()
                .find(|s| s.contains(j.date) && is_transposition(j.amount, j.amount - s.by));
            let (explains, confidence) = match in_step {
                Some(s) => (s.by, Confidence::Likely),
                None if scope.contains(j.date)
                    && is_transposition(j.amount, j.amount - scope.difference) =>
                {
                    (scope.difference, Confidence::Possible)
                }
                None => continue,
            };
            out.push(Finding {
                kind: FindingKind::TransposedDigits,
                explains,
                confidence,
                evidence: vec![EvidenceRef::Journal {
                    journal_id: j.id.clone(),
                }],
                fix: None,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::SuspectJournal;
    use super::super::test_support::*;
    use super::*;
    use crate::reconcile::finding::SuggestedFix;

    #[test]
    fn an_opening_balance_typed_with_two_digits_swapped() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "s1", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut s, &mut lines, -31_860);
        let found = TransposedDigits.look(&input(-38_160, vec![s], lines, vec![]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(-6_300));
        assert_eq!(found[0].confidence, Confidence::Likely);
        let Some(SuggestedFix::SetOpeningBalance { amount, .. }) = found[0].fix else {
            panic!("{:?}", found[0].fix);
        };
        assert_eq!(amount, m(-31_860));
    }

    #[test]
    fn a_journal_typed_with_two_digits_swapped() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![
            line("a", "s1", "2025-08-05", -500, "KAURI PETROL"),
            line("dep", "s1", "2025-08-14", 12_500, "CASH DEPOSIT"),
            line("b", "s1", "2025-08-20", -700, "GREENBARROW"),
        ];
        with_balances(&mut s, &mut lines, 10_000);
        // The deposit came in by hand as 152.00 instead of from the file as 125.00.
        lines[1].journal_id = None;
        let journals = vec![SuspectJournal {
            id: "dep-hand".into(),
            date: d("2025-08-14"),
            narration: "Cash deposit".into(),
            amount: m(15_200),
            origin: JournalOrigin::ByHand,
        }];
        let found = TransposedDigits.look(&input(10_000, vec![s], lines, journals));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(2_700));
        assert_eq!(found[0].confidence, Confidence::Likely);
    }

    #[test]
    fn not_a_transposition() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "s1", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut s, &mut lines, 326_485);
        assert!(
            TransposedDigits
                .look(&input(300_000, vec![s], lines, vec![]))
                .is_empty()
        );
    }
}
