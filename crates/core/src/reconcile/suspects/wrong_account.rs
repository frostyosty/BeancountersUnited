//! **Wrong account** (suspect 8): a file uploaded to the wrong account. Its lines are in this
//! account's ledger and not the other's, or the other way round.
//!
//! - **Uploaded here**: a statement looked at by the scope, with its lines' net as `explains` and
//!   removing it as the fix. **Likely** when the file names an account number that isn't this
//!   account's, or when it names none, its net is exactly the difference, and one of its own
//!   balances is where a step shows (the file's balances belong to another account, so they jump
//!   away from this one's). **Possible** when it names none and only the net matches. A file that
//!   names this account is never a suspect.
//! - **Uploaded elsewhere** (when the other accounts' files are given): a statement on another
//!   account, overlapping a step's window, whose net is exactly minus a step or the difference:
//!   this account is missing it. Always **Possible**; it `explains` minus that net, and the fix is
//!   to remove it there (and upload it here).

use super::{Scope, Suspect, SuspectInput, different_accounts};
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};

pub struct WrongAccount;

impl Suspect for WrongAccount {
    fn kind(&self) -> FindingKind {
        FindingKind::WrongAccount
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for s in scope.statements(input) {
            let net = input.net_of(&s.id);
            if net.is_zero() {
                continue;
            }
            let confidence = match (&s.account_number, &input.account.account_number) {
                (Some(file), Some(ours)) if different_accounts(file, ours) => Confidence::Likely,
                (Some(_), _) => continue,
                (None, _) if net != scope.difference => continue,
                (None, _) => {
                    let jumps_here = scope.steps.iter().any(|st| {
                        input
                            .checkpoints
                            .get(st.at)
                            .is_some_and(|c| c.source.statement_id == s.id)
                    });
                    if jumps_here {
                        Confidence::Likely
                    } else {
                        Confidence::Possible
                    }
                }
            };
            out.push(Finding {
                kind: FindingKind::WrongAccount,
                explains: net,
                confidence,
                evidence: vec![EvidenceRef::Statement {
                    statement_id: s.id.clone(),
                }],
                fix: Some(SuggestedFix::RemoveStatement {
                    statement_id: s.id.clone(),
                }),
            });
        }

        let mut others: Vec<_> = input.other_accounts.iter().flatten().collect();
        others.sort_by(|a, b| a.statement_id.cmp(&b.statement_id));
        for o in others {
            let explains = -o.net;
            let overlaps = scope
                .steps
                .iter()
                .any(|st| st.contains(o.start) || st.contains(o.end));
            if !overlaps || !scope.hits(explains) {
                continue;
            }
            out.push(Finding {
                kind: FindingKind::WrongAccount,
                explains,
                confidence: Confidence::Possible,
                evidence: vec![EvidenceRef::Statement {
                    statement_id: o.statement_id.clone(),
                }],
                fix: Some(SuggestedFix::RemoveStatement {
                    statement_id: o.statement_id.clone(),
                }),
            });
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::super::OtherStatement;
    use super::super::test_support::*;
    use super::*;

    fn with_file(number: Option<&str>) -> SuspectInput {
        let mut ours = statement("ours", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "ours", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut ours, &mut lines, 10_000);
        let mut theirs = statement("theirs", 2, "2025-08-10", "2025-08-20");
        theirs.account_number = number.map(str::to_owned);
        theirs.stated_opening = Some(m(512));
        lines.push(line("p", "theirs", "2025-08-12", -1_000, "SUPERMARKET"));
        lines.push(line("q", "theirs", "2025-08-15", 300, "TRANSFER IN"));
        input(10_000, vec![ours, theirs], lines, vec![])
    }

    #[test]
    fn a_file_naming_no_account_whose_balance_jumps_away() {
        let found = WrongAccount.look(&with_file(None));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(-700));
        assert_eq!(found[0].confidence, Confidence::Likely);
    }

    #[test]
    fn a_file_naming_another_account() {
        let found = WrongAccount.look(&with_file(Some("99-1001-0000999-00")));
        assert_eq!(found[0].confidence, Confidence::Likely);
    }

    #[test]
    fn a_file_naming_this_account_is_never_a_suspect() {
        assert!(
            WrongAccount
                .look(&with_file(Some("99-1001-0000123-00")))
                .is_empty()
        );
    }

    #[test]
    fn a_file_uploaded_to_another_account() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "s1", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut s, &mut lines, 10_000);
        lines[0].journal_id = None; // as if it had gone to the card instead
        let mut input = input(10_000, vec![s], lines, vec![]);
        input.other_accounts = Some(vec![OtherStatement {
            bank_account_id: "card".into(),
            statement_id: "elsewhere".into(),
            start: d("2025-08-01"),
            end: d("2025-08-31"),
            net: m(-500),
        }]);
        let found = WrongAccount.look(&input);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(500));
        assert_eq!(found[0].confidence, Confidence::Possible);
    }
}
