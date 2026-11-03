//! **Missing lines** (suspect 2): days whose lines the ledger never got.
//!
//! - **A gap**: days no statement covers, inside a step's window, with no gap journal posting the
//!   change across them. The ledger lacks that change, so the finding `explains` minus it. Likely
//!   when that's exactly a step or the difference; Possible when it isn't, or when the change isn't
//!   known (a balance missing at one end), in which case it `explains` the step it sits in.
//! - **A download cut short**: a statement looked at by the scope whose own closing balance
//!   disagrees with its opening plus its lines (the file's balance check fails at its end). The
//!   lines that would close that gap never arrived, so it `explains` the expected balance less the
//!   stated one. Likely when that's exactly a step or the difference, else Possible.
//! - **A file that stops short**: a statement with no closing balance whose last line is more than
//!   [`NEAR_DAYS`] before the end of the days it says it covers, where a step shows at the next
//!   checkpoint. The amount isn't known, so it's always Possible and `explains` that step.
//!
//! - **A gap the ledger already holds**: days no statement covers where the server posted a gap
//!   journal for the change across them (`docs/domain.md`, "Bank vs books"). The books agree with
//!   the bank, so it explains nothing: the finding `explains` zero, Likely, whether or not anything
//!   differs, and the card shows it as a note ("No statement for 1 Aug to 31 Aug. We put the
//!   change in as one entry."). Its evidence is the gap, the gap journal and the statements either
//!   side. The combiner never counts a zero finding, so it always lands in `other_findings`.
//!
//! The fix is to upload the statement for those days.

use super::{JournalOrigin, NEAR_DAYS, Scope, Suspect, SuspectInput};
use crate::bank::Gap;
use crate::money::Money;
use crate::reconcile::finding::{Confidence, EvidenceRef, Finding, FindingKind, SuggestedFix};

pub struct MissingLines;

impl Suspect for MissingLines {
    fn kind(&self) -> FindingKind {
        FindingKind::MissingLines
    }

    fn look(&self, input: &SuspectInput) -> Vec<Finding> {
        let account = &input.account.bank_account_id;
        let mut out = notes(input);
        let Some(scope) = Scope::of(input) else {
            return out;
        };
        let confidence = |hit: bool| {
            if hit {
                Confidence::Likely
            } else {
                Confidence::Possible
            }
        };
        for gap in &input.gaps {
            let posted = input.journals.iter().any(|j| {
                j.origin
                    == (JournalOrigin::Gap {
                        start: gap.start,
                        end: gap.end,
                    })
            });
            if posted {
                continue;
            }
            let Some(step) = scope
                .steps
                .iter()
                .find(|s| s.contains(gap.start) || s.contains(gap.end))
            else {
                continue;
            };
            let (explains, confidence) = match gap.change {
                Some(change) => (-change, confidence(scope.hits(-change))),
                None => (step.by, Confidence::Possible),
            };
            if explains.is_zero() {
                continue;
            }
            let mut evidence = vec![EvidenceRef::Gap {
                start: gap.start,
                end: gap.end,
            }];
            evidence.extend(beside(input, gap));
            out.push(Finding {
                kind: FindingKind::MissingLines,
                explains,
                confidence,
                evidence,
                fix: Some(SuggestedFix::UploadMissing {
                    bank_account_id: account.clone(),
                    start: gap.start,
                    end: gap.end,
                }),
            });
        }

        for s in scope.statements(input) {
            let last_line = input
                .lines
                .iter()
                .filter(|l| l.statement_id == s.id)
                .map(|l| l.date)
                .max();
            let evidence = vec![EvidenceRef::Statement {
                statement_id: s.id.clone(),
            }];
            let fix = Some(SuggestedFix::UploadMissing {
                bank_account_id: account.clone(),
                start: last_line.unwrap_or(s.start),
                end: s.end,
            });
            if let Some(b) = &s.balance_break
                && b.bank_line_id.is_none()
            {
                let explains = b.expected - b.stated;
                if !explains.is_zero() {
                    out.push(Finding {
                        kind: FindingKind::MissingLines,
                        explains,
                        confidence: confidence(scope.hits(explains)),
                        evidence,
                        fix,
                    });
                }
                continue;
            }
            let Some(last) = last_line else {
                continue;
            };
            if s.stated_closing.is_some() || (s.end - last).num_days() <= NEAR_DAYS {
                continue;
            }
            // The step at the first checkpoint after the file's last line.
            let next = scope.steps.iter().find(|st| {
                input
                    .checkpoints
                    .get(st.at)
                    .is_some_and(|c| c.date > last && c.source.statement_id != s.id)
                    && st.contains(s.end)
            });
            if let Some(step) = next {
                out.push(Finding {
                    kind: FindingKind::MissingLines,
                    explains: step.by,
                    confidence: Confidence::Possible,
                    evidence,
                    fix,
                });
            }
        }
        out
    }
}

/// The statements either side of a gap, by id.
fn beside(input: &SuspectInput, gap: &Gap) -> Vec<EvidenceRef> {
    let mut ids: Vec<&str> = input
        .statements
        .iter()
        .filter(|s| s.end.succ_opt() == Some(gap.start) || gap.end.succ_opt() == Some(s.start))
        .map(|s| s.id.as_str())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    ids.into_iter()
        .map(|id| EvidenceRef::Statement {
            statement_id: id.to_owned(),
        })
        .collect()
}

/// A note for each gap a live gap journal already puts in the ledger.
fn notes(input: &SuspectInput) -> Vec<Finding> {
    let mut out = Vec::new();
    for gap in &input.gaps {
        let mut journals: Vec<&str> = input
            .journals
            .iter()
            .filter(|j| {
                j.origin
                    == (JournalOrigin::Gap {
                        start: gap.start,
                        end: gap.end,
                    })
            })
            .map(|j| j.id.as_str())
            .collect();
        if journals.is_empty() {
            continue;
        }
        journals.sort_unstable();
        let mut evidence = vec![EvidenceRef::Gap {
            start: gap.start,
            end: gap.end,
        }];
        evidence.extend(journals.into_iter().map(|id| EvidenceRef::Journal {
            journal_id: id.to_owned(),
        }));
        evidence.extend(beside(input, gap));
        out.push(Finding {
            kind: FindingKind::MissingLines,
            explains: Money::ZERO,
            confidence: Confidence::Likely,
            evidence,
            fix: Some(SuggestedFix::UploadMissing {
                bank_account_id: input.account.bank_account_id.clone(),
                start: gap.start,
                end: gap.end,
            }),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::super::test_support::*;
    use super::super::{BalanceBreak, SuspectJournal};
    use super::*;
    use crate::bank::Gap;

    /// Two monthly statements with September missing between them.
    fn missing_september(gap_journal: bool) -> SuspectInput {
        let mut aug = statement("aug", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "aug", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut aug, &mut lines, 1_000);
        let mut oct = statement("oct", 2, "2025-10-01", "2025-10-31");
        oct.stated_opening = Some(m(2_500));
        oct.stated_closing = Some(m(2_500));
        let mut journals = Vec::new();
        if gap_journal {
            journals.push(SuspectJournal {
                id: "gap".into(),
                date: d("2025-09-30"),
                narration: "No statement".into(),
                amount: m(2_000),
                origin: JournalOrigin::Gap {
                    start: d("2025-09-01"),
                    end: d("2025-09-30"),
                },
            });
        }
        let mut input = input(1_000, vec![aug, oct], lines, journals);
        input.gaps = vec![Gap {
            start: d("2025-09-01"),
            end: d("2025-09-30"),
            change: Some(m(2_000)),
        }];
        input
    }

    #[test]
    fn a_gap_with_nothing_posted() {
        let found = MissingLines.look(&missing_september(false));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(-2_000));
        assert_eq!(found[0].confidence, Confidence::Likely);
        assert_eq!(
            found[0].evidence.len(),
            3,
            "the gap and the statements either side"
        );
    }

    /// The gap journal puts the change in the ledger, so the books agree: the gap is a note that
    /// explains nothing, with the upload as its fix.
    #[test]
    fn a_gap_journal_already_covers_it() {
        let input = missing_september(true);
        assert_eq!(input.window.first_differs, None, "the books agree");
        let found = MissingLines.look(&input);
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, Money::ZERO);
        assert_eq!(found[0].confidence, Confidence::Likely);
        assert!(
            found[0].evidence.contains(&EvidenceRef::Journal {
                journal_id: "gap".into()
            }),
            "{found:?}"
        );
        assert!(matches!(
            found[0].fix,
            Some(SuggestedFix::UploadMissing { .. })
        ));
    }

    #[test]
    fn a_download_cut_short_at_its_end() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "s1", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut s, &mut lines, 1_000);
        // The file's closing balance has a 300 payment the lines don't.
        s.stated_closing = Some(m(200));
        s.balance_break = Some(BalanceBreak {
            bank_line_id: None,
            expected: m(500),
            stated: m(200),
        });
        let found = MissingLines.look(&input(1_000, vec![s], lines, vec![]));
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].explains, m(300));
        assert_eq!(found[0].confidence, Confidence::Likely);
    }
}
