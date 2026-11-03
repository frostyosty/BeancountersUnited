//! The proof (M18, Bank vs books): on one date, the balance the bank's file gives beside the
//! ledger's balance on the account, with the last few lines before it and the window where the
//! two part ways, if they do.
//!
//! ## Which balance the bank gives for a date
//! The proof is for the end of `date`. It uses, in this order:
//! 1. a statement's closing balance dated that day (the statement asked for first, then the later
//!    upload);
//! 2. a line's running balance at the end of that day;
//! 3. the opening balance of a statement starting the next day, which is the same moment;
//! 4. else the nearest checkpoint before it ([`ProofAt::Nearest`]), which the card labels as
//!    "the nearest balance your bank gave".
//!
//! The books side is the ledger at the same moment as the bank's balance, so the two always
//! compare like with like.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::account::LedgerJournal;
use super::checkpoints::{BalanceKind, Checkpoint, Compared, Movement, Shape, walk};
use crate::chart::AccountCode;
use crate::money::Money;

/// How many of the ledger's lines the books side shows.
pub const RECENT_LINES: usize = 5;

/// Whether the bank's balance is for the date asked, or the nearest one before it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ProofAt {
    Exact,
    Nearest,
}

/// A checkpoint and the ledger at it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CheckpointAt {
    pub checkpoint: Checkpoint,
    pub compared: Compared,
}

/// One live journal on the account, for the books side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProofLine {
    pub journal_id: String,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub narration: String,
    /// What it puts on the account: debit +, credit −.
    pub amount: Money,
}

/// Where the books and the bank part ways, up to the proof's balance. Only the two checkpoints
/// that bracket the fault are kept, so an upload's result stays small.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ProofWindow {
    pub shape: Shape,
    /// Ledger less stated, at the proof's balance.
    pub difference: Money,
    pub last_agrees: Option<CheckpointAt>,
    pub first_differs: Option<CheckpointAt>,
}

/// Bank vs books on one date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Proof {
    /// The date asked for.
    #[ts(type = "string")]
    pub date: NaiveDate,
    /// The bank's balance used, and the ledger at it. `None` when the bank gives no balance on or
    /// before the date.
    pub bank: Option<CheckpointAt>,
    pub at: ProofAt,
    /// The day the books side is for: the bank balance's moment (the end of this day), or `date`
    /// when there's no bank balance.
    #[ts(type = "string")]
    pub books_date: NaiveDate,
    /// The ledger at the end of `books_date`.
    pub ledger: Money,
    /// Up to [`RECENT_LINES`] live journals on the account up to then, oldest first.
    pub recent: Vec<ProofLine>,
    pub window: ProofWindow,
}

impl Proof {
    /// Ledger less stated, when the bank gives a balance.
    pub fn difference(&self) -> Option<Money> {
        self.bank.as_ref().map(|b| b.compared.difference)
    }
}

/// The day a checkpoint is the end of: its own date, or the day before for an opening balance.
fn end_of(c: &Checkpoint) -> Option<NaiveDate> {
    if c.end_of_day() {
        Some(c.date)
    } else {
        c.date.pred_opt()
    }
}

/// Prefers, among checkpoints at one moment: closing (the statement asked for first), running,
/// then opening.
fn preference(c: &Checkpoint, statement: Option<&str>) -> u8 {
    match c.source.balance {
        BalanceKind::Closing if Some(c.source.statement_id.as_str()) == statement => 3,
        BalanceKind::Closing => 2,
        BalanceKind::Running { .. } => 1,
        BalanceKind::Opening => 0,
    }
}

/// Bank vs books at the end of `date` for the account `code`. `checkpoints` are in the order
/// [`super::checkpoints`] gives; `movements` and `journals` are the ledger's on the account (as
/// [`super::movements`] gives, and every journal, in any order). `statement` is the statement
/// whose closing balance to prefer, such as the one just uploaded.
pub fn proof(
    date: NaiveDate,
    statement: Option<&str>,
    checkpoints: &[Checkpoint],
    movements: &[Movement],
    code: &AccountCode,
    opening_journal_id: Option<&str>,
    journals: &[LedgerJournal<'_>],
) -> Proof {
    // The last checkpoint at or before the end of `date`, best first at the latest moment.
    let chosen = checkpoints
        .iter()
        .enumerate()
        .filter_map(|(i, c)| Some((i, c, end_of(c)?)))
        .filter(|(_, _, end)| *end <= date)
        .max_by_key(|(i, c, end)| (*end, preference(c, statement), *i));

    let (bank, at, books_date, upto) = match chosen {
        Some((i, _, end)) => {
            // Walk the checkpoints up to it, so the window is as at the proof's balance.
            let walked = walk(&checkpoints[..=i], movements);
            let at_i = |j: Option<usize>| {
                j.map(|j| CheckpointAt {
                    checkpoint: checkpoints[j].clone(),
                    compared: walked.compared[j],
                })
            };
            let window = ProofWindow {
                shape: walked.window.shape,
                difference: walked.window.difference,
                last_agrees: at_i(walked.window.last_agrees),
                first_differs: at_i(walked.window.first_differs),
            };
            let at = if end == date {
                ProofAt::Exact
            } else {
                ProofAt::Nearest
            };
            let bank = at_i(Some(i));
            (bank.map(|b| (b, window)), at, end, end)
        }
        None => (None, ProofAt::Nearest, date, date),
    };
    let ledger: Money = movements
        .iter()
        .filter(|m| m.date <= upto)
        .map(|m| m.amount)
        .sum();
    let (bank, window) = match bank {
        Some((b, w)) => (Some(b), w),
        None => (
            None,
            ProofWindow {
                shape: Shape::Constant,
                difference: Money::ZERO,
                last_agrees: None,
                first_differs: None,
            },
        ),
    };
    let ledger = bank.as_ref().map_or(ledger, |b| b.compared.ledger);
    Proof {
        date,
        bank,
        at,
        books_date,
        ledger,
        recent: recent(code, opening_journal_id, journals, books_date),
        window,
    }
}

/// The last [`RECENT_LINES`] journals in force on the account dated on or before `upto`, oldest
/// first. A reversal and the journal it reverses cancel out, so neither is shown.
fn recent(
    code: &AccountCode,
    opening_journal_id: Option<&str>,
    journals: &[LedgerJournal<'_>],
    upto: NaiveDate,
) -> Vec<ProofLine> {
    let reversed: std::collections::BTreeSet<&str> = journals
        .iter()
        .filter_map(|j| j.reverses_journal_id)
        .collect();
    let mut live: Vec<&LedgerJournal<'_>> = journals
        .iter()
        .filter(|j| j.reverses_journal_id.is_none() && !reversed.contains(j.id))
        .filter(|j| j.journal.date <= upto)
        .filter(|j| j.journal.lines.iter().any(|l| &l.account == code))
        .collect();
    // The opening balance first on its day, then the order they were posted.
    live.sort_by_key(|j| {
        (
            j.journal.date,
            Some(j.id) != opening_journal_id,
            j.posted_seq,
            j.id,
        )
    });
    let skip = live.len().saturating_sub(RECENT_LINES);
    live.into_iter()
        .skip(skip)
        .map(|j| ProofLine {
            journal_id: j.id.to_owned(),
            date: j.journal.date,
            narration: j.journal.narration.clone(),
            amount: j.on_account(code),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::{Journal, JournalLine};
    use crate::reconcile::checkpoints::CheckpointSource;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn m(cents: i64) -> Money {
        Money::from_cents(cents)
    }

    fn cp(date: &str, stated: i64, statement: &str, balance: BalanceKind) -> Checkpoint {
        Checkpoint {
            date: d(date),
            stated: m(stated),
            source: CheckpointSource {
                statement_id: statement.into(),
                balance,
                span: None,
            },
        }
    }

    fn mv(date: &str, cents: i64) -> Movement {
        Movement {
            date: d(date),
            amount: m(cents),
            opening: false,
        }
    }

    fn bank() -> AccountCode {
        "601".parse().unwrap()
    }

    fn journal(date: &str, narration: &str, cents: i64) -> Journal {
        Journal {
            date: d(date),
            narration: narration.into(),
            lines: vec![
                JournalLine {
                    account: bank(),
                    amount: m(cents),
                },
                JournalLine {
                    account: "999".parse().unwrap(),
                    amount: m(-cents),
                },
            ],
        }
    }

    fn running(id: &str) -> BalanceKind {
        BalanceKind::Running {
            bank_line_id: id.into(),
        }
    }

    fn at(p: &Proof) -> (Option<&str>, ProofAt, NaiveDate) {
        (
            p.bank
                .as_ref()
                .map(|b| b.checkpoint.source.statement_id.as_str()),
            p.at,
            p.books_date,
        )
    }

    #[test]
    fn a_closing_balance_that_day_comes_first() {
        let cps = [
            cp("2026-03-01", 0, "a", BalanceKind::Opening),
            cp("2026-03-31", 500, "b", running("l1")),
            cp("2026-03-31", 500, "a", BalanceKind::Closing),
        ];
        let mvs = [mv("2026-03-10", 500)];
        let p = proof(d("2026-03-31"), None, &cps, &mvs, &bank(), None, &[]);
        assert_eq!(at(&p), (Some("a"), ProofAt::Exact, d("2026-03-31")));
        assert!(matches!(
            p.bank.unwrap().checkpoint.source.balance,
            BalanceKind::Closing
        ));
        assert_eq!(p.ledger, m(500));
    }

    #[test]
    fn the_statement_asked_for_wins_a_tie() {
        let cps = [
            cp("2026-03-31", 500, "a", BalanceKind::Closing),
            cp("2026-03-31", 500, "b", BalanceKind::Closing),
        ];
        let p = proof(d("2026-03-31"), Some("a"), &cps, &[], &bank(), None, &[]);
        assert_eq!(at(&p).0, Some("a"));
        let p = proof(d("2026-03-31"), None, &cps, &[], &bank(), None, &[]);
        assert_eq!(at(&p).0, Some("b"), "else the later upload");
    }

    #[test]
    fn then_a_running_balance_then_the_next_days_opening() {
        let cps = [
            cp("2026-03-31", 700, "a", running("l9")),
            cp("2026-04-01", 700, "b", BalanceKind::Opening),
        ];
        let p = proof(d("2026-03-31"), None, &cps, &[], &bank(), None, &[]);
        assert!(matches!(
            p.bank.as_ref().unwrap().checkpoint.source.balance,
            BalanceKind::Running { .. }
        ));
        assert_eq!(p.at, ProofAt::Exact);
        let p = proof(d("2026-03-31"), None, &cps[1..], &[], &bank(), None, &[]);
        assert_eq!(at(&p), (Some("b"), ProofAt::Exact, d("2026-03-31")));
    }

    #[test]
    fn else_the_nearest_before() {
        let cps = [
            cp("2026-03-28", 300, "a", BalanceKind::Closing),
            cp("2026-04-30", 900, "b", BalanceKind::Closing),
        ];
        let mvs = [mv("2026-03-27", 300), mv("2026-03-30", 50)];
        let p = proof(d("2026-03-31"), None, &cps, &mvs, &bank(), None, &[]);
        assert_eq!(at(&p), (Some("a"), ProofAt::Nearest, d("2026-03-28")));
        assert_eq!(
            p.ledger,
            m(300),
            "the books at the same moment, not the 31st"
        );
        assert_eq!(p.difference(), Some(Money::ZERO));
    }

    #[test]
    fn no_balance_at_all() {
        let mvs = [mv("2026-03-01", 120)];
        let p = proof(d("2026-03-31"), None, &[], &mvs, &bank(), None, &[]);
        assert_eq!(p.bank, None);
        assert_eq!(p.difference(), None);
        assert_eq!(p.ledger, m(120));
        assert_eq!(p.books_date, d("2026-03-31"));
    }

    #[test]
    fn the_window_is_up_to_the_proofs_balance() {
        let cps = [
            cp("2026-01-31", 100, "a", BalanceKind::Closing),
            cp("2026-02-28", 100, "b", BalanceKind::Closing),
            cp("2026-03-31", 100, "c", BalanceKind::Closing),
        ];
        // A doubled line in February.
        let mvs = [mv("2026-01-10", 100), mv("2026-02-10", 4125)];
        let p = proof(d("2026-02-28"), None, &cps, &mvs, &bank(), None, &[]);
        assert_eq!(p.difference(), Some(m(4125)));
        assert_eq!(p.window.shape, Shape::Jump);
        assert_eq!(p.window.difference, m(4125));
        let last = p.window.last_agrees.unwrap();
        let first = p.window.first_differs.unwrap();
        assert_eq!(last.checkpoint.date, d("2026-01-31"));
        assert_eq!(first.checkpoint.date, d("2026-02-28"));
        let p = proof(d("2026-01-31"), None, &cps, &mvs, &bank(), None, &[]);
        assert_eq!(p.window.first_differs, None);
    }

    #[test]
    fn the_last_five_live_lines_oldest_first() {
        let js: Vec<(String, Journal, Option<String>)> = (1..=7)
            .map(|n| {
                (
                    format!("j{n}"),
                    journal(&format!("2026-03-{n:02}"), &format!("line {n}"), n * 100),
                    None,
                )
            })
            .chain([
                // j7 reversed and reposted, and a line after the date.
                (
                    "r7".into(),
                    journal("2026-03-07", "reverse 7", -700),
                    Some("j7".into()),
                ),
                (
                    "k7".into(),
                    journal("2026-03-07", "line 7 coded", 700),
                    None,
                ),
                ("j9".into(), journal("2026-04-02", "later", 1), None),
            ])
            .collect();
        let ledger: Vec<LedgerJournal<'_>> = js
            .iter()
            .enumerate()
            .map(|(seq, (id, j, rev))| LedgerJournal {
                id,
                reverses_journal_id: rev.as_deref(),
                posted_seq: i64::try_from(seq).unwrap(),
                journal: j,
            })
            .collect();
        let lines = recent(&bank(), None, &ledger, d("2026-03-31"));
        let names: Vec<&str> = lines.iter().map(|l| l.narration.as_str()).collect();
        assert_eq!(
            names,
            ["line 3", "line 4", "line 5", "line 6", "line 7 coded"]
        );
        assert_eq!(lines[4].amount, m(700));
    }
}
