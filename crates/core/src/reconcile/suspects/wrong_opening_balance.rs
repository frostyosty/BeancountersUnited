//! **Wrong opening balance** (suspect 3): the balance the account starts from isn't the bank's.
//!
//! Looks at the first checkpoint, not a step's window: when it already differs, the opening balance
//! (or its absence) is the first suspect. It `explains` the difference there, and the fix sets the
//! opening balance to the entered one less that difference.
//!
//! **Likely** when the difference is the same from the first checkpoint on (a Constant shape), or
//! the first checkpoint is a statement's opening balance on the opening balance's own date, where
//! nothing else can stand between them. **Possible** otherwise, and also when swapping two digits
//! of the entered amount gives the right one: Transposed digits is the more specific finding then,
//! and takes the lead.

use super::{OpeningFacts, Suspect, SuspectInput, is_transposition};
use crate::money::Money;
use crate::reconcile::checkpoints::{BalanceKind, Shape};
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};

pub struct WrongOpeningBalance;

/// What the first checkpoint says about the opening balance: the amount entered (zero when none
/// was), the one that would make the first checkpoint agree, whether the evidence is strong, and
/// the evidence. `None` when the first checkpoint agrees.
pub(super) struct OpeningCheck {
    pub entered: Money,
    pub meant: Money,
    pub strong: bool,
    pub evidence: Vec<EvidenceRef>,
    pub fix: SuggestedFix,
    pub difference: Money,
}

pub(super) fn opening_check(input: &SuspectInput) -> Option<OpeningCheck> {
    if input.window.first_differs != Some(0) {
        return None;
    }
    let first = input.checkpoints.first()?;
    let difference = input.compared.first()?.difference;
    if difference.is_zero() {
        return None;
    }
    let entered = input.opening.as_ref().map_or(Money::ZERO, |o| o.amount);
    let date = input
        .opening
        .as_ref()
        .map_or(input.account.start, |o: &OpeningFacts| o.date);
    let strong = input.window.shape == Shape::Constant
        || (first.source.balance == BalanceKind::Opening && first.date == date);
    let mut evidence = Vec::new();
    if let Some(o) = &input.opening {
        evidence.push(EvidenceRef::Journal {
            journal_id: o.journal_id.clone(),
        });
    }
    evidence.push(EvidenceRef::Statement {
        statement_id: first.source.statement_id.clone(),
    });
    let meant = entered - difference;
    Some(OpeningCheck {
        entered,
        meant,
        strong,
        evidence,
        fix: SuggestedFix::SetOpeningBalance {
            bank_account_id: input.account.bank_account_id.clone(),
            date,
            amount: meant,
        },
        difference,
    })
}

impl Suspect for WrongOpeningBalance {
    fn kind(&self) -> FindingKind {
        FindingKind::WrongOpeningBalance
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(c) = opening_check(input) else {
            return Vec::new();
        };
        let transposed = input.opening.is_some() && is_transposition(c.entered, c.meant);
        vec![Finding {
            kind: FindingKind::WrongOpeningBalance,
            explains: c.difference,
            confidence: if c.strong && !transposed {
                Confidence::Likely
            } else {
                Confidence::Possible
            },
            evidence: c.evidence,
            fix: Some(c.fix),
        }]
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::*;

    fn typed(opening: i64) -> SuspectInput {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "s1", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut s, &mut lines, 326_485);
        input(opening, vec![s], lines, vec![])
    }

    #[test]
    fn a_typed_opening_balance_that_isnt_the_banks() {
        let found = WrongOpeningBalance.look(&typed(300_000));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].explains, m(-26_485));
        assert_eq!(found[0].confidence, Confidence::Likely);
        let Some(SuggestedFix::SetOpeningBalance { amount, date, .. }) = found[0].fix else {
            panic!("{:?}", found[0].fix);
        };
        assert_eq!((amount, date), (m(326_485), d("2025-08-01")));
    }

    #[test]
    fn a_transposition_leaves_the_lead_to_transposed_digits() {
        let found = WrongOpeningBalance.look(&typed(362_485));
        assert_eq!(found[0].confidence, Confidence::Possible);
    }

    #[test]
    fn nothing_when_the_first_checkpoint_agrees() {
        assert!(WrongOpeningBalance.look(&typed(326_485)).is_empty());
    }
}
