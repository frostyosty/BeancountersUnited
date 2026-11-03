//! The suspects (M18): once the checkpoints say *where* the books and the bank part ways, each
//! suspect looks there for one kind of reason and reports what it finds as [`Finding`]s.
//!
//! A suspect only reads. It sets `explains` to the amount its fix would take off the difference
//! (ledger less stated, with the same sign), and `fix` to a command the owner can choose to send.
//! Agent 5's combiner picks the findings that add up to the whole difference.
//!
//! **Where a suspect looks.** The difference moves at some checkpoints and not others. Each move
//! is a [`Step`]: the checkpoint where it shows, the one before it (which agrees with the books up
//! to the move) and the amount it moved by. One fault is one step (PLAN.md's window: last agrees
//! to first differs); two faults are usually two. Suspects look inside the steps' windows, at the
//! statements whose balances moved, and test amounts against the steps and the final difference.
//! Wrong opening balance looks at the first checkpoint instead, and Wrong account may look at
//! other accounts' files.
//!
//! A new suspect is a new module here, a line in [`all_suspects`], a [`FindingKind`] and a
//! fixture in `fixtures/reconcile/`. Nothing else changes.
//!
//! Pure: plain data in, sorted findings out, no HashMaps.

use std::collections::BTreeSet;

use chrono::NaiveDate;

use super::account::ReconcileAccountKind;
use super::checkpoints::{Checkpoint, Compared, Window};
use super::finding::{Finding, FindingKind};
use crate::bank::Gap;
use crate::money::Money;

pub mod amount_read_wrong;
pub mod date_cut_off;
pub mod duplicates;
pub mod entries_by_hand;
pub mod marked_duplicate;
pub mod missing_lines;
pub mod sign_reversed;
pub mod transposed_digits;
pub mod wrong_account;
pub mod wrong_opening_balance;

/// How many days apart two lines can be and still be the same transaction: one file dated by the
/// purchase, the other by the posting, or a weekend in between. Also how far a line can sit from
/// a checkpoint and still be a cut-off.
///
/// Waiting on the NON-CODE-TODOS decision ("M18 suspect thresholds"); change it only here.
pub const NEAR_DAYS: i64 = 3;

/// One kind of reason a difference might have.
pub trait Suspect {
    fn kind(&self) -> FindingKind;
    fn look(&self, input: &SuspectInput) -> Vec<Finding>;
}

/// Every suspect, in PLAN.md's order (most common first).
pub fn all_suspects() -> Vec<Box<dyn Suspect>> {
    vec![
        Box::new(duplicates::Duplicates),
        Box::new(missing_lines::MissingLines),
        Box::new(wrong_opening_balance::WrongOpeningBalance),
        Box::new(sign_reversed::SignReversed),
        Box::new(marked_duplicate::MarkedDuplicateButIsnt),
        Box::new(entries_by_hand::EntriesByHand),
        Box::new(date_cut_off::DateCutOff),
        Box::new(wrong_account::WrongAccount),
        Box::new(amount_read_wrong::AmountReadWrong),
        Box::new(transposed_digits::TransposedDigits),
    ]
}

/// What every suspect finds, sorted by kind (PLAN.md's order), then evidence, then amount.
pub fn look_all(input: &SuspectInput) -> Vec<Finding> {
    let mut out: Vec<Finding> = all_suspects().iter().flat_map(|s| s.look(input)).collect();
    out.sort_by(|a, b| {
        (a.kind, &a.evidence, a.explains, a.confidence).cmp(&(
            b.kind,
            &b.evidence,
            b.explains,
            b.confidence,
        ))
    });
    out
}

// ---- The input: plain data the server loads. ----

/// Everything the suspects get for one bank account.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuspectInput {
    pub account: AccountSide,
    /// The account's opening balance journal, if it has one.
    pub opening: Option<OpeningFacts>,
    /// As [`super::checkpoints::checkpoints`] orders them.
    pub checkpoints: Vec<Checkpoint>,
    /// One per checkpoint, from [`super::checkpoints::walk`].
    pub compared: Vec<Compared>,
    pub window: Window,
    /// The account's stored lines, in any order.
    pub lines: Vec<SuspectLine>,
    /// The live journals on the account (neither reversed nor a reversal), in any order.
    pub journals: Vec<SuspectJournal>,
    pub statements: Vec<SuspectStatement>,
    /// Runs of days no statement covers.
    pub gaps: Vec<Gap>,
    /// The business's other accounts' statements, for Wrong account. `None` when not loaded.
    pub other_accounts: Option<Vec<OtherStatement>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountSide {
    pub bank_account_id: String,
    pub kind: ReconcileAccountKind,
    /// As stored: `BB-bbbb-AAAAAAA-SS` for a bank account, `XXXX-XXXX-XXXX-1234` for a card.
    pub account_number: Option<String>,
    /// The business's start date: the opening balance is the balance at the start of it.
    pub start: NaiveDate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpeningFacts {
    pub journal_id: String,
    pub date: NaiveDate,
    /// What the journal puts on the account.
    pub amount: Money,
}

/// One stored bank line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuspectLine {
    pub id: String,
    pub statement_id: String,
    /// The bank's own id for it (OFX `FITID`), where the file had one.
    pub bank_id: Option<String>,
    /// The posting date.
    pub date: NaiveDate,
    pub amount: Money,
    pub description: String,
    /// The running balance after it, where the file gives one.
    pub balance: Option<Money>,
    /// The journal live for it now; `None` when it posts nothing.
    pub journal_id: Option<String>,
    /// M10 flagged it: an earlier statement already covered its date.
    pub possible_duplicate: bool,
    /// The owner's answer to that flag: `Some(true)` is a duplicate (it posts nothing),
    /// `Some(false)` isn't, `None` unanswered.
    pub duplicate_answer: Option<bool>,
}

impl SuspectLine {
    /// Whether the line puts its amount on the account.
    pub fn posts(&self) -> bool {
        self.journal_id.is_some() && self.duplicate_answer != Some(true)
    }
}

/// Where a journal on the account came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalOrigin {
    /// The account's opening balance.
    Opening,
    /// A bank line's journal.
    BankLine { bank_line_id: String },
    /// A gap journal: the change across days no statement covers.
    Gap { start: NaiveDate, end: NaiveDate },
    /// Anything else: posted by hand.
    ByHand,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuspectJournal {
    pub id: String,
    pub date: NaiveDate,
    pub narration: String,
    /// What it puts on the account.
    pub amount: Money,
    pub origin: JournalOrigin,
}

/// One stored statement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SuspectStatement {
    pub id: String,
    pub file_name: String,
    /// The days it covers, both ends included.
    pub start: NaiveDate,
    pub end: NaiveDate,
    /// The upload's command seq: later uploads are larger.
    pub imported_seq: i64,
    /// The account the file names, as stored for accounts; `None` when the file names none.
    pub account_number: Option<String>,
    /// The balances the file itself states (not worked out from its lines).
    pub stated_opening: Option<Money>,
    pub stated_closing: Option<Money>,
    /// Where the file's own balances disagree with its lines (`Statement::balance_check`), when the
    /// file was kept and checked.
    pub balance_break: Option<BalanceBreak>,
}

/// The first place a file's own balances disagree with its lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BalanceBreak {
    /// The stored line whose running balance disagrees, or `None` for the closing balance (or a
    /// line that wasn't stored).
    pub bank_line_id: Option<String>,
    /// The balance worked out from the opening and the lines.
    pub expected: Money,
    /// The balance the file states.
    pub stated: Money,
}

/// A statement uploaded to another of the business's accounts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OtherStatement {
    pub bank_account_id: String,
    pub statement_id: String,
    pub start: NaiveDate,
    pub end: NaiveDate,
    /// What its stored lines put on that account.
    pub net: Money,
}

// ---- Shared helpers. ----

/// When something sits in a day: the start (0), the day's lines (1) and the end (2).
type Moment = (NaiveDate, u8);

fn moment(c: &Checkpoint) -> Moment {
    (c.date, if c.end_of_day() { 2 } else { 0 })
}

/// One move of the difference: between `after` (the checkpoint before, or the beginning) and the
/// checkpoint `at`, it moved by `by`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Step {
    /// The checkpoint index where the move shows.
    pub at: usize,
    after: Option<Moment>,
    before: Moment,
    pub by: Money,
}

impl Step {
    /// Whether a line or journal dated `date` falls between the two checkpoints.
    pub fn contains(&self, date: NaiveDate) -> bool {
        let m = (date, 1);
        self.after.is_none_or(|a| a < m) && m < self.before
    }
}

/// Where the suspects look: every step, and the final difference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scope {
    pub steps: Vec<Step>,
    pub difference: Money,
}

impl Scope {
    /// `None` when nothing differs, so there's nothing to look for.
    pub fn of(input: &SuspectInput) -> Option<Scope> {
        input.window.first_differs?;
        let steps = input
            .compared
            .iter()
            .enumerate()
            .filter(|(_, c)| !c.step.is_zero())
            .filter_map(|(i, c)| {
                let cp = input.checkpoints.get(i)?;
                let after = i
                    .checked_sub(1)
                    .and_then(|p| input.checkpoints.get(p))
                    .map(moment);
                Some(Step {
                    at: i,
                    after,
                    before: moment(cp),
                    by: c.step,
                })
            })
            .collect();
        Some(Scope {
            steps,
            difference: input.window.difference,
        })
    }

    /// Whether something dated `date` falls inside any step's window.
    pub fn contains(&self, date: NaiveDate) -> bool {
        self.steps.iter().any(|s| s.contains(date))
    }

    /// Whether `amount` is the final difference or one step: what a single fault would show.
    pub fn hits(&self, amount: Money) -> bool {
        !amount.is_zero()
            && (amount == self.difference || self.steps.iter().any(|s| s.by == amount))
    }

    /// The statements a suspect should look at: those with a posting line inside a step, and those
    /// whose own balance is where a step shows. Sorted by id.
    pub fn statements<'a>(&self, input: &'a SuspectInput) -> Vec<&'a SuspectStatement> {
        let mut ids: BTreeSet<&str> = input
            .lines
            .iter()
            .filter(|l| l.posts() && self.contains(l.date))
            .map(|l| l.statement_id.as_str())
            .collect();
        for s in &self.steps {
            if let Some(cp) = input.checkpoints.get(s.at) {
                ids.insert(&cp.source.statement_id);
            }
        }
        let mut out: Vec<&SuspectStatement> = input
            .statements
            .iter()
            .filter(|s| ids.contains(s.id.as_str()))
            .collect();
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }
}

impl SuspectInput {
    pub fn statement(&self, id: &str) -> Option<&SuspectStatement> {
        self.statements.iter().find(|s| s.id == id)
    }

    /// The lines that put their amount on the account, sorted by date, then id.
    pub fn posting_lines(&self) -> Vec<&SuspectLine> {
        let mut out: Vec<&SuspectLine> = self.lines.iter().filter(|l| l.posts()).collect();
        out.sort_by(|a, b| (a.date, &a.id).cmp(&(b.date, &b.id)));
        out
    }

    /// What a statement's stored lines put on the account.
    pub fn net_of(&self, statement_id: &str) -> Money {
        self.lines
            .iter()
            .filter(|l| l.posts() && l.statement_id == statement_id)
            .map(|l| l.amount)
            .sum()
    }
}

/// Whether two dates are within [`NEAR_DAYS`] of each other.
pub fn near(a: NaiveDate, b: NaiveDate) -> bool {
    (a - b).num_days().abs() <= NEAR_DAYS
}

/// Whether two descriptions name the same transaction once normalised: the same words, or the
/// shorter one's words found in a row in the longer, with its last word allowed to be cut short.
/// That covers a bank adding the transaction type (OFX `NAME` against `MEMO`: "CARD PURCHASE
/// KAURI PETROL" against "KAURI PETROL") and a CSV cutting the text short ("PAYMENT TO
/// HARBOURLI"). The shorter needs two words or eight letters, so "FEE" doesn't match everything.
pub fn same_description(a: &str, b: &str) -> bool {
    let words = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(str::to_ascii_uppercase)
            .collect()
    };
    let (a, b) = (words(a), words(b));
    if a == b {
        return !a.is_empty();
    }
    let (short, long) = if (a.len(), a.concat().len()) <= (b.len(), b.concat().len()) {
        (a, b)
    } else {
        (b, a)
    };
    let Some((last, init)) = short.split_last() else {
        return false;
    };
    if short.len() < 2 && last.len() < 8 {
        return false;
    }
    long.windows(short.len()).any(|run| {
        let (run_last, run_init) = run.split_last().expect("windows are non-empty");
        run_init == init && run_last.starts_with(last.as_str())
    })
}

/// Whether `typed` and `meant` differ by swapping two digits: the same sign, the same number of
/// digits, and exactly two places differ, each holding the other's digit. Such a difference
/// always divides by 9.
pub fn is_transposition(typed: Money, meant: Money) -> bool {
    let (t, m) = (typed.cents(), meant.cents());
    if t == m || (t < 0) != (m < 0) || (t - m) % 9 != 0 {
        return false;
    }
    let (t, m) = (t.unsigned_abs().to_string(), m.unsigned_abs().to_string());
    if t.len() != m.len() {
        return false;
    }
    let diff: Vec<(u8, u8)> = t.bytes().zip(m.bytes()).filter(|(x, y)| x != y).collect();
    diff.len() == 2 && diff[0].0 == diff[1].1 && diff[0].1 == diff[1].0
}

/// Whether two account numbers name different accounts. Compares digits only; when one is a
/// masked card number, only its last four.
pub fn different_accounts(a: &str, b: &str) -> bool {
    let digits = |s: &str| -> String { s.chars().filter(char::is_ascii_digit).collect() };
    let masked = |s: &str| s.contains(['X', 'x', '*']);
    let (da, db) = (digits(a), digits(b));
    if masked(a) || masked(b) {
        let tail = |d: &str| d.get(d.len().saturating_sub(4)..).unwrap_or("").to_owned();
        tail(&da) != tail(&db)
    } else {
        da != db
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! A small builder for suspect inputs: lines, journals and statements on one account, walked
    //! through the real checkpoints.

    use super::*;
    use crate::reconcile::checkpoints::{
        BankLineFacts, Movement, StatementFacts, checkpoints, walk,
    };

    pub fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    pub fn m(cents: i64) -> Money {
        Money::from_cents(cents)
    }

    pub fn line(
        id: &str,
        statement: &str,
        date: &str,
        cents: i64,
        description: &str,
    ) -> SuspectLine {
        SuspectLine {
            id: id.into(),
            statement_id: statement.into(),
            bank_id: None,
            date: d(date),
            amount: m(cents),
            description: description.into(),
            balance: None,
            journal_id: Some(format!("j-{id}")),
            possible_duplicate: false,
            duplicate_answer: None,
        }
    }

    pub fn statement(id: &str, seq: i64, start: &str, end: &str) -> SuspectStatement {
        SuspectStatement {
            id: id.into(),
            file_name: format!("{id}.csv"),
            start: d(start),
            end: d(end),
            imported_seq: seq,
            account_number: Some("99-1001-0000123-00".into()),
            stated_opening: None,
            stated_closing: None,
            balance_break: None,
        }
    }

    /// Lines, hand journals and statements, with an opening balance at `opening` on 1 Aug 2025.
    /// The ledger is the lines that post, the journals and the opening.
    pub fn input(
        opening: i64,
        statements: Vec<SuspectStatement>,
        lines: Vec<SuspectLine>,
        journals: Vec<SuspectJournal>,
    ) -> SuspectInput {
        let start = d("2025-08-01");
        let facts: Vec<StatementFacts<'_>> = statements
            .iter()
            .map(|s| StatementFacts {
                id: &s.id,
                file_name: &s.file_name,
                start: s.start,
                end: s.end,
                opening: s.stated_opening,
                opening_date: s.start,
                closing: s.stated_closing,
                closing_date: s.end,
                stored_closing: s.stated_closing,
                imported_seq: s.imported_seq,
                opening_span: None,
                closing_span: None,
            })
            .collect();
        let line_facts: Vec<BankLineFacts<'_>> = lines
            .iter()
            .map(|l| BankLineFacts {
                id: &l.id,
                statement_id: &l.statement_id,
                date: l.date,
                amount: l.amount,
                description: &l.description,
                occurrence: 1,
                balance: l.balance,
                balance_span: None,
                journal_id: l.journal_id.as_deref(),
                duplicate: l.duplicate_answer == Some(true),
            })
            .collect();
        let cps = checkpoints(&facts, &line_facts, Some(start));
        let mut movements = vec![Movement {
            date: start,
            amount: m(opening),
            opening: true,
        }];
        movements.extend(lines.iter().filter(|l| l.posts()).map(|l| Movement {
            date: l.date,
            amount: l.amount,
            opening: false,
        }));
        movements.extend(journals.iter().map(|j| Movement {
            date: j.date,
            amount: j.amount,
            opening: false,
        }));
        let walk = walk(&cps, &movements);
        SuspectInput {
            account: AccountSide {
                bank_account_id: "acct".into(),
                kind: ReconcileAccountKind::Bank,
                account_number: Some("99-1001-0000123-00".into()),
                start,
            },
            opening: Some(OpeningFacts {
                journal_id: "j-open".into(),
                date: start,
                amount: m(opening),
            }),
            checkpoints: cps,
            compared: walk.compared,
            window: walk.window,
            lines,
            journals,
            statements,
            gaps: Vec::new(),
            other_accounts: None,
        }
    }

    /// Gives a statement's lines running balances from `opening`, and the statement its opening and
    /// closing balances.
    pub fn with_balances(s: &mut SuspectStatement, lines: &mut [SuspectLine], opening: i64) {
        let mut balance = m(opening);
        s.stated_opening = Some(balance);
        for l in lines.iter_mut().filter(|l| l.statement_id == s.id) {
            balance += l.amount;
            l.balance = Some(balance);
        }
        s.stated_closing = Some(balance);
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::*;
    use super::*;

    #[test]
    fn descriptions() {
        assert!(same_description(
            "KAURI PETROL NELSON",
            "kauri petrol nelson"
        ));
        assert!(same_description(
            "CARD PURCHASE KAURI PETROL NELSON",
            "KAURI PETROL NELSON"
        ));
        assert!(same_description(
            "PAYMENT TO HARBOURLI",
            "PAYMENT TO HARBOURLIGHT VISA 5290"
        ));
        assert!(!same_description(
            "KAURI PETROL NELSON",
            "GREENBARROW GROCERS"
        ));
        assert!(!same_description("FEE", "ACCOUNT FEE"));
        assert!(!same_description("", ""));
    }

    #[test]
    fn transpositions() {
        assert!(is_transposition(m(-38_160), m(-31_860)));
        assert!(is_transposition(m(1_234), m(1_324)));
        assert!(is_transposition(m(9_012), m(1_092)));
        assert!(!is_transposition(m(300_000), m(326_485)));
        assert!(!is_transposition(m(1_234), m(-1_324)));
        assert!(!is_transposition(m(1_234), m(1_234)));
        // Three places changed, though the difference divides by 9.
        assert!(!is_transposition(m(1_234), m(2_341)));
    }

    #[test]
    fn account_numbers() {
        assert!(!different_accounts("99-5501-0000612-00", "995501000061200"));
        assert!(different_accounts(
            "99-5501-0000612-00",
            "99-5501-0000613-00"
        ));
        assert!(!different_accounts(
            "XXXX-XXXX-XXXX-5290",
            "XXXX-XXXX-XXXX-5290"
        ));
        assert!(different_accounts(
            "XXXX-XXXX-XXXX-5290",
            "XXXX-XXXX-XXXX-1111"
        ));
    }

    #[test]
    fn nothing_differs_nothing_to_look_for() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![line("a", "s1", "2025-08-05", -500, "KAURI PETROL")];
        with_balances(&mut s, &mut lines, 1_000);
        let input = input(1_000, vec![s], lines, vec![]);
        assert!(Scope::of(&input).is_none());
        assert!(look_all(&input).is_empty());
    }

    #[test]
    fn steps_bracket_each_move() {
        let mut s = statement("s1", 1, "2025-08-01", "2025-08-31");
        let mut lines = vec![
            line("a", "s1", "2025-08-05", -500, "KAURI PETROL"),
            line("b", "s1", "2025-08-10", -700, "GREENBARROW GROCERS"),
            line("c", "s1", "2025-08-20", -900, "BRIGHTPOST COURIERS"),
        ];
        with_balances(&mut s, &mut lines, 1_000);
        // The ledger has b twice and is missing c.
        let mut extra = lines[1].clone();
        extra.id = "b2".into();
        extra.statement_id = "s2".into();
        lines.push(extra);
        lines[2].journal_id = None;
        let input = input(1_000, vec![s], lines, vec![]);
        let scope = Scope::of(&input).unwrap();
        let by: Vec<i64> = scope.steps.iter().map(|s| s.by.cents()).collect();
        assert_eq!(by, vec![-700, 900]);
        assert!(scope.steps[0].contains(d("2025-08-10")));
        assert!(!scope.steps[0].contains(d("2025-08-05")));
        assert!(scope.steps[1].contains(d("2025-08-20")));
        assert!(scope.hits(m(200)), "the final difference");
        assert!(scope.hits(m(-700)));
        assert!(!scope.hits(m(-500)));
    }
}
