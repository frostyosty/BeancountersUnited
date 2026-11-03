//! **Amount read wrong** (suspect 9): a line whose amount isn't what the bank meant. Either our
//! parser or the bank's file is wrong; the owner is told, and the server logs the parser and the
//! row for us (never the content). There's no command that changes a line's amount, so there's no
//! fix.
//!
//! For each posting line inside a step's window, and each line where its file's own running
//! balance breaks:
//! - **Cents read as dollars, or dollars as cents**: the line is 100 times what it should be (it
//!   `explains` 99/100 of it) or a hundredth (it `explains` minus 99 times it).
//! - **The file's running balance breaks at the line**: the balance before it agreed, so the line
//!   should have moved it by the stated balance less the one worked out. It `explains` the worked
//!   out balance less the stated one. A break of exactly twice the line the other way is a sign
//!   read the wrong way round, which Sign the wrong way reports instead.
//!
//! **Likely** when the amount is exactly a step or the difference and the file breaks at that
//! line; **Possible** when only one of the two holds (a 100-times amount that matches, or a break
//! that doesn't).

use std::collections::BTreeMap;

use super::{Scope, Suspect, SuspectInput};
use crate::money::Money;
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind};

pub struct AmountReadWrong;

impl Suspect for AmountReadWrong {
    fn kind(&self) -> FindingKind {
        FindingKind::AmountReadWrong
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let Some(scope) = Scope::of(input) else {
            return Vec::new();
        };
        // line id -> (explains, likely)
        let mut found: BTreeMap<&str, (Money, bool)> = BTreeMap::new();
        for l in input.posting_lines() {
            let a = l.amount.cents();
            let breaks = input
                .statement(&l.statement_id)
                .and_then(|s| s.balance_break.as_ref())
                .filter(|b| b.bank_line_id.as_deref() == Some(l.id.as_str()));
            if let Some(b) = breaks {
                let explains = b.expected - b.stated;
                if !explains.is_zero() && explains != l.amount + l.amount {
                    found.insert(&l.id, (explains, scope.hits(explains)));
                    continue;
                }
            }
            if !scope.contains(l.date) {
                continue;
            }
            let hundredfold = (a % 100 == 0).then(|| Money::from_cents(a / 100 * 99));
            let hundredth = a.checked_mul(-99).map(Money::from_cents);
            if let Some(explains) = [hundredfold, hundredth]
                .into_iter()
                .flatten()
                .find(|e| scope.hits(*e))
            {
                found.insert(&l.id, (explains, false));
            }
        }
        found
            .into_iter()
            .map(|(id, (explains, likely))| Finding {
                kind: FindingKind::AmountReadWrong,
                explains,
                confidence: if likely {
                    Confidence::Likely
                } else {
                    Confidence::Possible
                },
                evidence: vec![EvidenceRef::BankLine {
                    bank_line_id: id.to_owned(),
                }],
                fix: None,
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::BalanceBreak;
    use super::super::test_support::*;
    use super::*;

    fn telewave(breaks: bool) -> SuspectInput {
        let mut s = statement("s1", 1, "2026-02-01", "2026-02-28");
        let mut lines = vec![
            line("a", "s1", "2026-02-05", -500, "KAURI PETROL"),
            line("tel", "s1", "2026-02-18", -3_999, "TELEWAVE MOBILE"),
            line("b", "s1", "2026-02-20", -700, "GREENBARROW"),
        ];
        with_balances(&mut s, &mut lines, 1_000_000);
        // The file printed 39.99 as 3999.
        lines[1].amount = m(-399_900);
        if breaks {
            s.balance_break = Some(BalanceBreak {
                bank_line_id: Some("tel".into()),
                expected: m(1_000_000 - 500 - 399_900),
                stated: m(1_000_000 - 500 - 3_999),
            });
        }
        let mut input = input(1_000_000, vec![s], lines, vec![]);
        input.account.start = d("2026-02-01");
        input
    }

    #[test]
    fn cents_read_as_dollars_where_the_file_breaks() {
        let found = AmountReadWrong.look(&telewave(true));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(-395_901));
        assert_eq!(found[0].confidence, Confidence::Likely);
    }

    #[test]
    fn a_hundredfold_amount_alone_is_possible() {
        let found = AmountReadWrong.look(&telewave(false));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(-395_901));
        assert_eq!(found[0].confidence, Confidence::Possible);
    }
}
