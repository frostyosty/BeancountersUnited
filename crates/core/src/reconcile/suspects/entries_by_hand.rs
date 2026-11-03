//! **Entries by hand** (suspect 6): a journal on the bank account that no statement line stands
//! behind (M15's journals without a line), inside a step's window. The bank never saw it, so it
//! `explains` its own amount, and the fix is to reverse it.
//!
//! **Likely** when its amount is exactly a step or the difference; **Possible** otherwise.

use super::{JournalOrigin, Scope, Suspect, SuspectInput};
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};

pub struct EntriesByHand;

impl Suspect for EntriesByHand {
    fn kind(&self) -> FindingKind {
        FindingKind::EntryByHand
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        let mut journals: Vec<_> = input
            .journals
            .iter()
            .filter(|j| j.origin == JournalOrigin::ByHand)
            .filter(|j| !j.amount.is_zero() && scope.contains(j.date))
            .collect();
        journals.sort_by(|a, b| (a.date, &a.id).cmp(&(b.date, &b.id)));
        journals
            .into_iter()
            .map(|j| Finding {
                kind: FindingKind::EntryByHand,
                explains: j.amount,
                confidence: if scope.hits(j.amount) {
                    Confidence::Likely
                } else {
                    Confidence::Possible
                },
                evidence: vec![EvidenceRef::Journal {
                    journal_id: j.id.clone(),
                }],
                fix: Some(SuggestedFix::ReverseJournal {
                    journal_id: j.id.clone(),
                }),
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::SuspectJournal;
    use super::super::test_support::*;
    use super::*;

    #[test]
    fn a_deposit_no_statement_shows() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![
            line("a", "s1", "2025-08-05", -500, "KAURI PETROL"),
            line("b", "s1", "2025-08-20", -700, "GREENBARROW"),
        ];
        with_balances(&mut s, &mut lines, 10_000);
        let journals = vec![
            SuspectJournal {
                id: "cash".into(),
                date: d("2025-08-14"),
                narration: "Cash sale banked".into(),
                amount: m(35_000),
                origin: JournalOrigin::ByHand,
            },
            // Puts nothing on the account.
            SuspectJournal {
                id: "early".into(),
                date: d("2025-08-02"),
                narration: "Adjustment".into(),
                amount: m(0),
                origin: JournalOrigin::ByHand,
            },
        ];
        let found = EntriesByHand.look(&input(10_000, vec![s], lines, journals));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(35_000));
        assert_eq!(found[0].confidence, Confidence::Likely);
        assert_eq!(
            found[0].fix,
            Some(SuggestedFix::ReverseJournal {
                journal_id: "cash".into()
            })
        );
    }
}
