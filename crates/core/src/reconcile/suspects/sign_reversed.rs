//! **Sign the wrong way** (suspect 4): money in read as money out, or the other way round. The
//! ledger then has the amount with the wrong sign, so it's out by twice the amount.
//!
//! - **A whole file**: a statement looked at by the scope where twice its lines' net is exactly a
//!   step or the difference (a CSV's debit and credit columns read the wrong way round, or a card
//!   file read as a bank account). It `explains` twice the net, and the fix is to remove the
//!   statement (and upload it again, read the right way). **Likely** when the file's own balances
//!   also disagree with its lines (its balance check breaks), else **Possible**.
//! - **One line**: a posting line inside a step's window where twice its amount is exactly a step
//!   or the difference, outside any file already found. **Likely** when the file's balance check
//!   breaks at that line by exactly twice its amount the other way, else **Possible**. There's no
//!   command that flips one line, so it has no fix.

use std::collections::BTreeSet;

use super::{Scope, Suspect, SuspectInput};
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};

pub struct SignReversed;

impl Suspect for SignReversed {
    fn kind(&self) -> FindingKind {
        FindingKind::SignReversed
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let mut whole: BTreeSet<&str> = BTreeSet::new();
        for s in scope.statements(input) {
            let net = input.net_of(&s.id);
            let twice = net + net;
            if !scope.hits(twice) {
                continue;
            }
            whole.insert(&s.id);
            out.push(Finding {
                kind: FindingKind::SignReversed,
                explains: twice,
                confidence: if s.balance_break.is_some() {
                    Confidence::Likely
                } else {
                    Confidence::Possible
                },
                evidence: vec![EvidenceRef::Statement {
                    statement_id: s.id.clone(),
                }],
                fix: Some(SuggestedFix::RemoveStatement {
                    statement_id: s.id.clone(),
                }),
            });
        }

        for l in input.posting_lines() {
            let twice = l.amount + l.amount;
            if whole.contains(l.statement_id.as_str())
                || !scope.contains(l.date)
                || !scope.hits(twice)
            {
                continue;
            }
            let breaks_here = input
                .statement(&l.statement_id)
                .and_then(|s| s.balance_break.as_ref())
                .is_some_and(|b| {
                    b.bank_line_id.as_deref() == Some(l.id.as_str())
                        && b.stated - b.expected == -twice
                });
            out.push(Finding {
                kind: FindingKind::SignReversed,
                explains: twice,
                confidence: if breaks_here {
                    Confidence::Likely
                } else {
                    Confidence::Possible
                },
                evidence: vec![EvidenceRef::BankLine {
                    bank_line_id: l.id.clone(),
                }],
                fix: None,
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::BalanceBreak;
    use super::super::test_support::*;
    use super::*;

    #[test]
    fn a_file_read_the_wrong_way_round() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![
            line("a", "s1", "2025-08-05", 1_500, "INVOICE 1001"),
            line("b", "s1", "2025-08-12", -400, "KAURI PETROL"),
        ];
        with_balances(&mut s, &mut lines, 1_000);
        // The columns swapped: the ledger has every amount the other way.
        for l in &mut lines {
            l.amount = -l.amount;
        }
        s.balance_break = Some(BalanceBreak {
            bank_line_id: Some("a".into()),
            expected: m(-500),
            stated: m(2_500),
        });
        let found = SignReversed.look(&input(1_000, vec![s], lines, vec![]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(-2_200));
        assert_eq!(found[0].confidence, Confidence::Likely);
    }

    #[test]
    fn one_line_the_wrong_way() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![
            line("a", "s1", "2025-08-05", 1_500, "INVOICE 1001"),
            line("b", "s1", "2025-08-12", -400, "KAURI PETROL"),
            line("c", "s1", "2025-08-20", -100, "BRIGHTPOST"),
        ];
        with_balances(&mut s, &mut lines, 1_000);
        lines[1].amount = m(400);
        let found = SignReversed.look(&input(1_000, vec![s], lines, vec![]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(800));
        assert_eq!(found[0].confidence, Confidence::Possible);
        assert_eq!(
            found[0].evidence,
            vec![EvidenceRef::BankLine {
                bank_line_id: "b".into()
            }]
        );
    }
}
