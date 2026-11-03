//! **Marked duplicate but isn't** (suspect 5): a line the owner said was a duplicate, so it posts
//! nothing, when there's nothing for it to duplicate. The ledger lacks it, so the finding
//! `explains` minus its amount, and the fix is to say it isn't a duplicate after all.
//!
//! Looks at lines inside a step's window. **Likely** when no posting line of the same amount is
//! within [`NEAR_DAYS`](super::NEAR_DAYS) of it. **Possible** when there is one but its description
//! doesn't match. When one matches, the mark was right and there's no finding.

use super::{Scope, Suspect, SuspectInput, near, same_description};
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};

pub struct MarkedDuplicateButIsnt;

impl Suspect for MarkedDuplicateButIsnt {
    fn kind(&self) -> FindingKind {
        FindingKind::MarkedDuplicateButIsnt
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        let posting = input.posting_lines();
        let mut marked: Vec<_> = input
            .lines
            .iter()
            .filter(|l| l.duplicate_answer == Some(true) && scope.contains(l.date))
            .collect();
        marked.sort_by(|a, b| (a.date, &a.id).cmp(&(b.date, &b.id)));
        let mut out = Vec::new();
        for l in marked {
            let alike: Vec<_> = posting
                .iter()
                .filter(|p| p.id != l.id && p.amount == l.amount && near(p.date, l.date))
                .collect();
            if alike
                .iter()
                .any(|p| same_description(&p.description, &l.description))
            {
                continue;
            }
            let mut evidence = vec![EvidenceRef::BankLine {
                bank_line_id: l.id.clone(),
            }];
            evidence.extend(alike.iter().map(|p| EvidenceRef::BankLine {
                bank_line_id: p.id.clone(),
            }));
            out.push(Finding {
                kind: FindingKind::MarkedDuplicateButIsnt,
                explains: -l.amount,
                confidence: if alike.is_empty() {
                    Confidence::Likely
                } else {
                    Confidence::Possible
                },
                evidence,
                fix: Some(SuggestedFix::UnmarkDuplicate {
                    bank_line_id: l.id.clone(),
                }),
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    fn marked(other: Option<&str>) -> SuspectInput {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "s1", "2025-08-05", -6_480, "WOODMILL HARDWARE")];
        if let Some(text) = other {
            lines.push(line("b", "s1", "2025-08-06", -6_480, text));
        }
        with_balances(&mut s, &mut lines, 100_000);
        lines[0].possible_duplicate = true;
        lines[0].duplicate_answer = Some(true);
        lines[0].journal_id = None;
        input(100_000, vec![s], lines, vec![])
    }

    #[test]
    fn nothing_to_duplicate() {
        let found = MarkedDuplicateButIsnt.look(&marked(None));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].explains, m(6_480));
        assert_eq!(found[0].confidence, Confidence::Likely);
        assert_eq!(
            found[0].fix,
            Some(SuggestedFix::UnmarkDuplicate {
                bank_line_id: "a".into()
            })
        );
    }

    #[test]
    fn the_same_amount_under_another_name() {
        let found = MarkedDuplicateButIsnt.look(&marked(Some("KAURI PETROL")));
        assert_eq!(found[0].confidence, Confidence::Possible);
    }
}
