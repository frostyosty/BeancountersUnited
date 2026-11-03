//! Checkpoints: every balance the bank states for an account, in date order, and the ledger's
//! balance at each. The window is where the two part ways (PLAN.md, M18).
//!
//! ## Where a checkpoint sits in a day
//! The ledger has no order inside a day: a journal is dated, not timed. So a checkpoint sits at
//! one of two moments, and every ledger movement dated that day is either all before it or all
//! after it:
//! - an **opening** balance is the balance at the *start* of its date, before any line dated that
//!   day. Its ledger balance counts movements dated strictly before it, plus an account's opening
//!   balance journal dated that day (the balance the owner gave for the start of that day);
//! - a **closing** balance or a line's **running** balance is the balance at the *end* of its
//!   date, after every line dated that day. Its ledger balance counts movements dated on or
//!   before it.
//!
//! ## Only what the file states
//! A checkpoint is a balance the file states: [`StatementFacts::opening`] and
//! [`StatementFacts::closing`] are only those, and a line's running balance is always stated. M10
//! also stores a balance the file doesn't state, worked out from the file's own lines (opening +
//! lines, or closing − lines). That's never evidence from the bank: it can't disagree with its own
//! file, only with a later upload (a download taken mid-day, before a late line posted), which the
//! duplicate and missing-line suspects cover. So it isn't a checkpoint.
//!
//! A stated balance sits on the date the file states it for ([`StatementFacts::opening_date`],
//! [`StatementFacts::closing_date`]), not at the ends of the days the statement covers. Those
//! can differ: an OFX whose `LEDGERBAL` is dated 31 March may list a line it dates 1 April, so
//! the statement covers 1 April, but its closing balance is still the end of 31 March.
//!
//! A running balance is only the end of its day when its line is the last of the day. So a
//! statement gives at most one running checkpoint per date: the last line of that date, in file
//! order, that has a balance. It's kept only when the file confirms nothing follows it that day:
//! the next line with a balance (on a later date) less its amount, or else the statement's closing
//! balance, must equal it. That drops a day whose last line wasn't stored (an exact duplicate of
//! an earlier upload, say), whose balance isn't the end of the day. On the statement's last date
//! the closing balance says the same thing, so no running checkpoint is made there.
//!
//! Checkpoints are sorted by moment (date, then start of day before end of day), then by
//! statement (start, end, upload order, id), then opening, running, closing.

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::money::Money;

/// Where in the uploaded file a stated balance was read: the 1-based line, and the byte range
/// within that line (`start` inclusive, `end` exclusive) of the decoded text. The parsers record
/// it (`acct_import::bank::SourceSpan`, the same fields); core only carries it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SourceSpan {
    pub line: u32,
    pub start: u32,
    pub end: u32,
}

/// Which balance of a statement a checkpoint is.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum BalanceKind {
    /// At the start of the statement's first day.
    Opening,
    /// The running balance after a line, at the end of its day.
    Running { bank_line_id: String },
    /// At the end of the statement's last day.
    Closing,
}

impl BalanceKind {
    /// Opening, running, closing.
    fn rank(&self) -> u8 {
        match self {
            BalanceKind::Opening => 0,
            BalanceKind::Running { .. } => 1,
            BalanceKind::Closing => 2,
        }
    }
}

/// Where a checkpoint's balance came from.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CheckpointSource {
    pub statement_id: String,
    pub balance: BalanceKind,
    /// Where the file states it, if the file was kept and the parser recorded it.
    pub span: Option<SourceSpan>,
}

/// A balance the bank states.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Checkpoint {
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub stated: Money,
    pub source: CheckpointSource,
}

impl Checkpoint {
    /// Whether it's the balance at the end of `date` (closing, running) rather than the start
    /// (opening).
    pub fn end_of_day(&self) -> bool {
        self.source.balance != BalanceKind::Opening
    }
}

/// One stored statement, as the checkpoints need it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StatementFacts<'a> {
    pub id: &'a str,
    pub file_name: &'a str,
    /// The days the statement covers (M10's coverage: its stated period widened to take in every
    /// line). Gaps and M15's reconciliation use these; checkpoints use the stated dates below.
    pub start: NaiveDate,
    pub end: NaiveDate,
    /// The balance at the start of `opening_date`, where the file states it.
    pub opening: Option<Money>,
    /// The day the file states `opening` for: `start` when it states none.
    pub opening_date: NaiveDate,
    /// The balance at the end of `closing_date`, where the file states it.
    pub closing: Option<Money>,
    /// The day the file states `closing` for, which can be before `end` (an OFX whose
    /// `LEDGERBAL` is dated 31 March but which lists a line dated 1 April): `end` when it states
    /// none.
    pub closing_date: NaiveDate,
    /// The balance at the end of `end` that M10 stored: `closing`, or worked out from the file's
    /// lines when the file doesn't state it. M15's reconciliation compares the ledger with it;
    /// checkpoints don't use it.
    pub stored_closing: Option<Money>,
    /// The upload's command seq: a later upload sorts after an earlier one.
    pub imported_seq: i64,
    pub opening_span: Option<SourceSpan>,
    pub closing_span: Option<SourceSpan>,
}

/// One stored bank line, as the checkpoints and the reconciliation need it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BankLineFacts<'a> {
    pub id: &'a str,
    pub statement_id: &'a str,
    pub date: NaiveDate,
    pub amount: Money,
    pub description: &'a str,
    pub occurrence: u32,
    /// The running balance after this line, where the file gives one.
    pub balance: Option<Money>,
    pub balance_span: Option<SourceSpan>,
    /// The journal that's live for the line now, or `None` if it posts nothing.
    pub journal_id: Option<&'a str>,
    /// The owner said it's a duplicate.
    pub duplicate: bool,
}

/// The checkpoints of one account's statements, in order (see the module docs). `lines` are the
/// account's lines with each statement's in file order; lines of other statements may be mixed
/// in. Checkpoints dated before `from` (the account's start, when it has one) are left out.
pub fn checkpoints(
    statements: &[StatementFacts<'_>],
    lines: &[BankLineFacts<'_>],
    from: Option<NaiveDate>,
) -> Vec<Checkpoint> {
    let mut ordered: Vec<&StatementFacts<'_>> = statements.iter().collect();
    ordered.sort_by_key(|s| (s.start, s.end, s.imported_seq, s.id));

    // (statement position, checkpoint)
    let mut out: Vec<(usize, Checkpoint)> = Vec::new();
    for (pos, s) in ordered.iter().enumerate() {
        let source = |balance: BalanceKind, span: Option<SourceSpan>| CheckpointSource {
            statement_id: s.id.to_owned(),
            balance,
            span,
        };
        if let Some(stated) = s.opening {
            out.push((
                pos,
                Checkpoint {
                    date: s.opening_date,
                    stated,
                    source: source(BalanceKind::Opening, s.opening_span),
                },
            ));
        }
        for (line, stated) in running_ends(s, lines) {
            out.push((
                pos,
                Checkpoint {
                    date: line.date,
                    stated,
                    source: source(
                        BalanceKind::Running {
                            bank_line_id: line.id.to_owned(),
                        },
                        line.balance_span,
                    ),
                },
            ));
        }
        if let Some(stated) = s.closing {
            out.push((
                pos,
                Checkpoint {
                    date: s.closing_date,
                    stated,
                    source: source(BalanceKind::Closing, s.closing_span),
                },
            ));
        }
    }
    out.retain(|(_, c)| from.is_none_or(|f| c.date >= f));
    out.sort_by(|(pa, a), (pb, b)| {
        (a.date, a.end_of_day(), pa, a.source.balance.rank()).cmp(&(
            b.date,
            b.end_of_day(),
            pb,
            b.source.balance.rank(),
        ))
    });
    out.into_iter().map(|(_, c)| c).collect()
}

/// A statement's lines whose running balance is the end of their day, with that balance.
fn running_ends<'l, 'a>(
    s: &StatementFacts<'_>,
    lines: &'l [BankLineFacts<'a>],
) -> Vec<(&'l BankLineFacts<'a>, Money)> {
    let with_balance: Vec<(&BankLineFacts<'_>, Money)> = lines
        .iter()
        .filter(|l| l.statement_id == s.id)
        .filter_map(|l| Some((l, l.balance?)))
        .collect();
    let mut out = Vec::new();
    for (i, &(line, stated)) in with_balance.iter().enumerate() {
        let next = with_balance.get(i + 1);
        if next.is_some_and(|(n, _)| n.date == line.date) {
            continue; // not the last of its day
        }
        let confirmed = match next {
            Some(&(n, balance)) => balance - n.amount == stated,
            None => line.date != s.closing_date && s.closing.is_none_or(|c| c == stated),
        };
        if confirmed {
            out.push((line, stated));
        }
    }
    out
}

/// One movement on the account in the ledger: what one journal puts on it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Movement {
    pub date: NaiveDate,
    pub amount: Money,
    /// The account's opening balance journal: the balance at the start of `date`, so an opening
    /// checkpoint that day counts it.
    pub opening: bool,
}

/// The ledger at one checkpoint.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Compared {
    pub ledger: Money,
    /// Ledger less stated.
    pub difference: Money,
    /// How the difference moved since the checkpoint before (the difference itself, at the
    /// first).
    pub step: Money,
}

/// How the difference moves across the checkpoints, which hints at the kind of fault.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Shape {
    /// Zero, then one value from `first_differs` on: one bad line, or a few that net to it.
    Jump,
    /// The same from the first checkpoint on (zero included, when nothing differs): the opening
    /// balance.
    Constant,
    /// Anything else: a pattern, such as a sign or a cut-off, or more than one fault.
    Drifting,
}

/// Where the books and the bank part ways.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Window {
    /// The checkpoint just before `first_differs` (every one before it agrees), or the last
    /// checkpoint when none differs. `None` when the first one differs, or there are none.
    pub last_agrees: Option<usize>,
    /// The first checkpoint that differs; `None` when none does.
    pub first_differs: Option<usize>,
    /// The difference at the last checkpoint, ledger less stated.
    pub difference: Money,
    pub shape: Shape,
}

/// The ledger at each checkpoint, and the window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Walk {
    /// One per checkpoint, in the same order.
    pub compared: Vec<Compared>,
    pub window: Window,
}

/// Walks `checkpoints` (as [`checkpoints`] orders them) against the ledger's `movements` on the
/// account, in any order.
pub fn walk(checkpoints: &[Checkpoint], movements: &[Movement]) -> Walk {
    let mut sorted: Vec<&Movement> = movements.iter().collect();
    sorted.sort_by_key(|m| m.date);
    // prefix[i] = the sum of the first i movements.
    let mut prefix = Vec::with_capacity(sorted.len() + 1);
    prefix.push(Money::ZERO);
    for m in &sorted {
        let last = *prefix.last().unwrap_or(&Money::ZERO);
        prefix.push(last + m.amount);
    }
    let ledger_at = |c: &Checkpoint| -> Money {
        if c.end_of_day() {
            prefix[sorted.partition_point(|m| m.date <= c.date)]
        } else {
            let before = sorted.partition_point(|m| m.date < c.date);
            let opening_that_day: Money = sorted[before..]
                .iter()
                .take_while(|m| m.date == c.date)
                .filter(|m| m.opening)
                .map(|m| m.amount)
                .sum();
            prefix[before] + opening_that_day
        }
    };

    let mut compared = Vec::with_capacity(checkpoints.len());
    let mut previous = Money::ZERO;
    for c in checkpoints {
        let ledger = ledger_at(c);
        let difference = ledger - c.stated;
        compared.push(Compared {
            ledger,
            difference,
            step: difference - previous,
        });
        previous = difference;
    }
    let window = window(&compared);
    Walk { compared, window }
}

fn window(compared: &[Compared]) -> Window {
    let first_differs = compared.iter().position(|c| !c.difference.is_zero());
    let last_agrees = match first_differs {
        Some(i) => i.checked_sub(1),
        None => compared.len().checked_sub(1),
    };
    let difference = compared.last().map_or(Money::ZERO, |c| c.difference);
    let shape = match first_differs {
        None | Some(0) if compared.iter().all(|c| c.difference == difference) => Shape::Constant,
        Some(i) if i > 0 && compared[i..].iter().all(|c| c.difference == difference) => Shape::Jump,
        _ => Shape::Drifting,
    };
    Window {
        last_agrees,
        first_differs,
        difference,
        shape,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn m(cents: i64) -> Money {
        Money::from_cents(cents)
    }

    fn closing(date: &str, stated: i64) -> Checkpoint {
        Checkpoint {
            date: d(date),
            stated: m(stated),
            source: CheckpointSource {
                statement_id: "s".into(),
                balance: BalanceKind::Closing,
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

    fn shape_of(stated: &[i64]) -> Window {
        // The ledger is 100 on the 1st and doesn't move; each checkpoint a day apart.
        let cps: Vec<Checkpoint> = stated
            .iter()
            .enumerate()
            .map(|(i, s)| closing(&format!("2025-08-{:02}", i + 1), *s))
            .collect();
        walk(&cps, &[mv("2025-08-01", 100)]).window
    }

    #[test]
    fn agreeing_everywhere() {
        let w = shape_of(&[100, 100, 100]);
        assert_eq!(w.first_differs, None);
        assert_eq!(w.last_agrees, Some(2));
        assert_eq!(w.difference, Money::ZERO);
        assert_eq!(w.shape, Shape::Constant);
    }

    #[test]
    fn no_checkpoints() {
        let w = walk(&[], &[mv("2025-08-01", 100)]).window;
        assert_eq!((w.last_agrees, w.first_differs), (None, None));
        assert_eq!(w.shape, Shape::Constant);
    }

    #[test]
    fn constant_from_the_start() {
        let w = shape_of(&[90, 90, 90]);
        assert_eq!((w.last_agrees, w.first_differs), (None, Some(0)));
        assert_eq!(w.difference, m(10));
        assert_eq!(w.shape, Shape::Constant);
    }

    #[test]
    fn a_jump() {
        let w = shape_of(&[100, 100, 95, 95]);
        assert_eq!((w.last_agrees, w.first_differs), (Some(1), Some(2)));
        assert_eq!(w.difference, m(5));
        assert_eq!(w.shape, Shape::Jump);
    }

    #[test]
    fn drifting() {
        let w = shape_of(&[100, 98, 96, 94]);
        assert_eq!((w.last_agrees, w.first_differs), (Some(0), Some(1)));
        assert_eq!(w.difference, m(6));
        assert_eq!(w.shape, Shape::Drifting);
        // Differs from the start but not by a constant.
        assert_eq!(shape_of(&[90, 80]).shape, Shape::Drifting);
        // A cut-off: out, then back.
        let w = shape_of(&[100, 90, 100]);
        assert_eq!(w.shape, Shape::Drifting);
        assert_eq!(w.difference, Money::ZERO);
        assert_eq!(w.first_differs, Some(1));
    }

    #[test]
    fn steps() {
        let cps = [closing("2025-08-01", 100), closing("2025-08-02", 97)];
        let walk = walk(&cps, &[mv("2025-08-01", 100)]);
        let steps: Vec<Money> = walk.compared.iter().map(|c| c.step).collect();
        assert_eq!(steps, vec![Money::ZERO, m(3)]);
    }

    /// An opening balance is the start of its day; a closing balance the end.
    #[test]
    fn start_and_end_of_day() {
        let mut open = closing("2025-08-05", 100);
        open.source.balance = BalanceKind::Opening;
        let close = closing("2025-08-05", 130);
        let opening_journal = Movement {
            opening: true,
            ..mv("2025-08-05", 100)
        };
        let w = walk(&[open, close], &[opening_journal, mv("2025-08-05", 30)]);
        assert_eq!(w.compared[0].ledger, m(100));
        assert_eq!(w.compared[1].ledger, m(130));
        assert_eq!(w.window.difference, Money::ZERO);
    }

    fn statement<'a>(id: &'a str, start: &str, end: &str, o: i64, c: i64) -> StatementFacts<'a> {
        StatementFacts {
            id,
            file_name: "f.csv",
            start: d(start),
            end: d(end),
            opening: Some(m(o)),
            opening_date: d(start),
            closing: Some(m(c)),
            closing_date: d(end),
            stored_closing: Some(m(c)),
            imported_seq: 1,
            opening_span: None,
            closing_span: Some(SourceSpan {
                line: 9,
                start: 3,
                end: 8,
            }),
        }
    }

    fn line<'a>(id: &'a str, s: &'a str, date: &str, amount: i64, bal: i64) -> BankLineFacts<'a> {
        BankLineFacts {
            id,
            statement_id: s,
            date: d(date),
            amount: m(amount),
            description: id,
            occurrence: 1,
            balance: Some(m(bal)),
            balance_span: None,
            journal_id: None,
            duplicate: false,
        }
    }

    fn kinds(cps: &[Checkpoint]) -> Vec<(String, String)> {
        cps.iter()
            .map(|c| {
                let k = match &c.source.balance {
                    BalanceKind::Opening => "open".to_owned(),
                    BalanceKind::Closing => "close".to_owned(),
                    BalanceKind::Running { bank_line_id } => bank_line_id.clone(),
                };
                (c.date.to_string(), k)
            })
            .collect()
    }

    #[test]
    fn checkpoints_in_order_one_running_balance_a_day() {
        let s = [statement("s1", "2025-08-01", "2025-08-31", 100, 70)];
        let lines = [
            line("a", "s1", "2025-08-03", 10, 110),
            line("b", "s1", "2025-08-03", -20, 90),
            line("c", "s1", "2025-08-10", -5, 85),
            line("e", "s1", "2025-08-31", -15, 70),
        ];
        let cps = checkpoints(&s, &lines, None);
        let p = |a: &str, b: &str| (a.to_owned(), b.to_owned());
        assert_eq!(
            kinds(&cps),
            vec![
                p("2025-08-01", "open"),
                p("2025-08-03", "b"),
                p("2025-08-10", "c"),
                p("2025-08-31", "close"),
            ]
        );
        assert_eq!(cps[3].source.span.map(|s| s.line), Some(9));
        // Before the account's start: left out.
        let cps = checkpoints(&s, &lines, Some(d("2025-08-05")));
        assert_eq!(cps.len(), 2);
    }

    /// The day's real last line wasn't stored (an exact duplicate of an earlier upload), so the
    /// stored last line's balance isn't the end of the day.
    #[test]
    fn a_running_balance_that_isnt_the_end_of_its_day_is_dropped() {
        let s = [statement("s1", "2025-08-01", "2025-08-31", 100, 75)];
        // Not stored: 2025-08-03, -5, balance 85.
        let lines = [
            line("a", "s1", "2025-08-03", -10, 90),
            line("c", "s1", "2025-08-10", -10, 75),
        ];
        let cps = checkpoints(&s, &lines, None);
        assert!(
            kinds(&cps).iter().all(|(_, k)| k != "a"),
            "{:?}",
            kinds(&cps)
        );
        assert!(kinds(&cps).iter().any(|(_, k)| k == "c"));
    }

    /// An OFX whose LEDGERBAL is dated 31 Mar lists a line dated 1 Apr: the statement covers
    /// 1 Apr, but its closing balance is the end of 31 Mar, so the ledger at it leaves the 1 Apr
    /// line out and the cut-off shows.
    #[test]
    fn a_stated_balance_sits_on_its_own_date() {
        let mut s = statement("s1", "2026-01-01", "2026-04-01", 100, 70);
        s.closing_date = d("2026-03-31");
        let cps = checkpoints(&[s], &[], None);
        assert_eq!(cps[1].date, d("2026-03-31"));
        let w = walk(
            &cps,
            &[
                Movement {
                    opening: true,
                    ..mv("2026-01-01", 100)
                },
                mv("2026-03-10", -20),
                mv("2026-04-01", -10),
            ],
        );
        assert_eq!(w.compared[1].ledger, m(80));
        assert_eq!(w.window.difference, m(10));
    }

    #[test]
    fn statements_on_the_same_day_sort_by_statement_then_kind() {
        let s = [
            statement("s2", "2025-09-01", "2025-09-30", 70, 60),
            statement("s1", "2025-08-01", "2025-09-01", 100, 70),
        ];
        let cps = checkpoints(&s, &[], None);
        let order: Vec<(&str, u8)> = cps
            .iter()
            .map(|c| (c.source.statement_id.as_str(), c.source.balance.rank()))
            .collect();
        // s2's opening (start of 1 Sep) comes before s1's closing (end of 1 Sep).
        assert_eq!(order, vec![("s1", 0), ("s2", 0), ("s1", 2), ("s2", 2)]);
    }

    // ---- The property: one fault always falls inside the window. ----

    #[derive(Debug, Clone)]
    enum Fault {
        Missing,
        Doubled,
        Changed(i64),
    }

    fn fault() -> impl Strategy<Value = Fault> {
        prop_oneof![
            Just(Fault::Missing),
            Just(Fault::Doubled),
            (1i64..50_000)
                .prop_flat_map(|c| prop_oneof![Just(c), Just(-c)])
                .prop_map(Fault::Changed),
        ]
    }

    /// (day, amount) per line, the days new statements start, whether each statement gives running
    /// balances, which line is faulty, and the fault.
    type Books = (Vec<(u32, i64)>, Vec<u32>, Vec<bool>, usize, Fault);

    /// Up to 60 lines over 90 days, as consecutive statements; each statement may or may not give
    /// running balances. One fault in the ledger, on one line.
    fn books() -> impl Strategy<Value = Books> {
        (
            prop::collection::vec(
                (
                    0u32..90,
                    (1i64..100_000).prop_flat_map(|c| prop_oneof![Just(c), Just(-c)]),
                ),
                1..60,
            ),
            prop::collection::btree_set(1u32..90, 0..4),
        )
            .prop_flat_map(|(mut lines, cuts)| {
                lines.sort_by_key(|l| l.0);
                let n = lines.len();
                let cuts: Vec<u32> = cuts.into_iter().collect();
                let runs = prop::collection::vec(any::<bool>(), cuts.len() + 1);
                (Just(lines), Just(cuts), runs, 0..n, fault())
            })
    }

    proptest! {
        #[test]
        fn one_fault_falls_inside_the_window(
            (lines, cuts, running, faulty, fault) in books(),
            opening in -100_000i64..100_000,
        ) {
            let day0 = d("2025-04-01");
            let day = |n: u32| day0 + chrono::Days::new(u64::from(n));
            // Statements: [0, cut1-1], [cut1, cut2-1], ..., [last cut, 89].
            let mut bounds = vec![0u32];
            bounds.extend(&cuts);
            bounds.push(90);
            let ids: Vec<String> = (0..bounds.len() - 1).map(|i| format!("s{i}")).collect();
            let line_ids: Vec<String> = (0..lines.len()).map(|i| format!("l{i}")).collect();

            let mut balance = opening;
            let mut facts = Vec::new();
            let mut statements = Vec::new();
            for (k, w) in bounds.windows(2).enumerate() {
                let (start, end) = (w[0], w[1] - 1);
                let open = balance;
                for (i, &(date, amount)) in lines.iter().enumerate() {
                    if date < start || date > end {
                        continue;
                    }
                    balance += amount;
                    facts.push(BankLineFacts {
                        id: &line_ids[i],
                        statement_id: &ids[k],
                        date: day(date),
                        amount: m(amount),
                        description: "",
                        occurrence: 1,
                        balance: running[k].then_some(m(balance)),
                        balance_span: None,
                        journal_id: None,
                        duplicate: false,
                    });
                }
                statements.push(StatementFacts {
                    id: &ids[k],
                    file_name: "f",
                    start: day(start),
                    end: day(end),
                    opening: Some(m(open)),
                    opening_date: day(start),
                    closing: Some(m(balance)),
                    closing_date: day(end),
                    stored_closing: Some(m(balance)),
                    imported_seq: i64::try_from(k).unwrap_or(0),
                    opening_span: None,
                    closing_span: None,
                });
            }

            // The ledger: the opening balance, then every line, with the fault in one of them.
            let mut movements = vec![Movement { date: day0, amount: m(opening), opening: true }];
            for (i, &(date, amount)) in lines.iter().enumerate() {
                let date = day(date);
                if i != faulty {
                    movements.push(mv_at(date, amount));
                    continue;
                }
                match fault {
                    Fault::Missing => {}
                    Fault::Doubled => {
                        movements.push(mv_at(date, amount));
                        movements.push(mv_at(date, amount));
                    }
                    Fault::Changed(by) => movements.push(mv_at(date, amount + by)),
                }
            }

            let cps = checkpoints(&statements, &facts, Some(day0));
            let walk = walk(&cps, &movements);
            let w = walk.window;
            // The fault sits inside its day: after that day's start, before its end.
            let fault_at = (day(lines[faulty].0), 1u8);
            let at = |i: usize| (cps[i].date, if cps[i].end_of_day() { 2u8 } else { 0 });
            if let Some(i) = w.last_agrees {
                prop_assert!(at(i) < fault_at, "last agreeing {:?} isn't before {:?}", at(i), fault_at);
            }
            match w.first_differs {
                Some(i) => prop_assert!(fault_at < at(i), "first differing {:?} isn't after {:?}", at(i), fault_at),
                None => prop_assert!(cps.iter().enumerate().all(|(i, _)| at(i) < fault_at)),
            }
            // One fault is one jump, or a constant when it's before every checkpoint.
            prop_assert!(w.shape != Shape::Drifting);
        }
    }

    fn mv_at(date: NaiveDate, cents: i64) -> Movement {
        Movement {
            date,
            amount: m(cents),
            opening: false,
        }
    }
}
