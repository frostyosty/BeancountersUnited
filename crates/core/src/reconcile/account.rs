//! Bank reconciliation of one account (M15): the statement's closing balance against the ledger's
//! balance on that date, and the items that don't match.
//!
//! The date is the end of the latest statement that ends inside the year. Balances are the
//! ledger's running totals across every year, because a bank account's balance carries forward.
//!
//! An item is unmatched when:
//! - a bank line has no live journal putting exactly its amount on the account (a line the owner
//!   marked as a duplicate is listed too, but it isn't a reconciling item: the bank counted it
//!   once, under the line it duplicates);
//! - a live journal touches the account but isn't any line's journal, the opening balance or a
//!   gap journal (a journal an accountant posted to the bank account by hand, say).
//!
//! Gap journals are listed on their own. They're matched in the sense that the next statement's
//! opening balance already includes them, but each one stands for lines nobody has seen.
//!
//! So: ledger − journals without a line + lines without a journal = statement, and whatever
//! doesn't fit that is `unexplained`.

use std::collections::{BTreeMap, BTreeSet};

use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::checkpoints::{BankLineFacts, Movement, StatementFacts};
use crate::bank::Gap;
use crate::chart::AccountCode;
use crate::ledger::{ClientYear, Journal};
use crate::money::Money;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ReconcileAccountKind {
    Bank,
    CreditCard,
}

/// Where an account's reconciliation stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ReconcileStatus {
    /// The ledger equals the statement, with nothing unmatched.
    Agrees,
    /// The ledger differs from the statement, but the unmatched items account for all of it.
    Explained,
    /// Some of the difference isn't accounted for by any item.
    Differs,
    /// The statements give no closing balance, so it can't be checked.
    NoBalance,
    /// No statement ends inside this year.
    NoStatement,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct AccountReconciliation {
    pub bank_account_id: String,
    pub code: String,
    pub name: String,
    pub kind: ReconcileAccountKind,
    pub account_number: Option<String>,
    pub status: ReconcileStatus,
    /// The date it's reconciled at: the end of the latest statement that ends inside the year.
    #[ts(type = "string | null")]
    pub date: Option<NaiveDate>,
    /// The statement that date comes from.
    pub statement_file: Option<String>,
    pub statement_balance: Option<Money>,
    /// The ledger's balance on the account at the end of `date`. Positive is money held; a card
    /// owing money is negative.
    pub ledger_balance: Option<Money>,
    /// Ledger less statement.
    pub difference: Option<Money>,
    /// The part of `difference` the unmatched items don't account for.
    pub unexplained: Option<Money>,
    pub lines_without_journal: Vec<UnmatchedLine>,
    pub journals_without_line: Vec<UnmatchedJournal>,
    pub gap_journals: Vec<GapJournalItem>,
    /// Runs of days no statement covers, up to `date`, whether or not anything was posted.
    pub gaps: Vec<GapItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum UnmatchedReason {
    /// The owner said it's a duplicate, so it posts nothing. Not a reconciling item.
    Duplicate,
    /// Its journal was reversed with nothing posted in its place.
    NoJournal,
    /// Its journal doesn't put the line's amount on this account.
    JournalDiffers,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct UnmatchedLine {
    pub bank_line_id: String,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub description: String,
    pub amount: Money,
    pub reason: UnmatchedReason,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct UnmatchedJournal {
    pub journal_id: String,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub narration: String,
    /// What it puts on this account.
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct GapJournalItem {
    pub journal_id: String,
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    pub amount: Money,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct GapItem {
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    /// The change posted for it, or `None` when the balance at one end isn't known.
    pub change: Option<Money>,
}

/// The bank account, as the reconciliation needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccountFacts<'a> {
    pub id: &'a str,
    pub code: &'a AccountCode,
    pub name: &'a str,
    pub kind: ReconcileAccountKind,
    pub account_number: Option<&'a str>,
    pub opening_journal_id: Option<&'a str>,
}

/// One posted journal of the client, with the store's id and reversal link.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LedgerJournal<'a> {
    pub id: &'a str,
    pub reverses_journal_id: Option<&'a str>,
    pub posted_seq: i64,
    pub journal: &'a Journal,
}

impl LedgerJournal<'_> {
    /// What it puts on `account`.
    pub fn on_account(&self, account: &AccountCode) -> Money {
        self.journal
            .lines
            .iter()
            .filter(|l| &l.account == account)
            .map(|l| l.amount)
            .sum()
    }
}

/// A gap journal that hasn't been reversed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GapJournalFacts<'a> {
    pub journal_id: &'a str,
    pub start: NaiveDate,
    pub end: NaiveDate,
}

/// Everything one account's reconciliation needs, already loaded.
pub struct AccountInputs<'a> {
    pub account: AccountFacts<'a>,
    pub statements: &'a [StatementFacts<'a>],
    /// The account's lines.
    pub lines: &'a [BankLineFacts<'a>],
    /// Every journal of the client, in every year.
    pub journals: &'a [LedgerJournal<'a>],
    /// The account's gap journals that haven't been reversed.
    pub gap_journals: &'a [GapJournalFacts<'a>],
    pub gaps: &'a [Gap],
}

/// The ledger's movements on the account: one per journal that touches it, in any order. Reversed
/// journals and their reversals are both included, so they cancel.
pub fn movements(account: &AccountFacts<'_>, journals: &[LedgerJournal<'_>]) -> Vec<Movement> {
    journals
        .iter()
        .filter(|j| j.journal.lines.iter().any(|l| &l.account == account.code))
        .map(|j| Movement {
            date: j.journal.date,
            amount: j.on_account(account.code),
            opening: account.opening_journal_id == Some(j.id),
        })
        .collect()
}

/// Reconciles one account at the end of the latest statement inside `year`.
pub fn reconcile_account(year: &ClientYear, input: &AccountInputs<'_>) -> AccountReconciliation {
    let account = &input.account;
    let latest = input
        .statements
        .iter()
        .filter(|s| year.contains(s.end))
        .max_by_key(|s| (s.end, s.imported_seq));
    let mut out = AccountReconciliation {
        bank_account_id: account.id.to_owned(),
        code: account.code.to_string(),
        name: account.name.to_owned(),
        kind: account.kind,
        account_number: account.account_number.map(str::to_owned),
        status: ReconcileStatus::NoStatement,
        date: None,
        statement_file: None,
        statement_balance: None,
        ledger_balance: None,
        difference: None,
        unexplained: None,
        lines_without_journal: Vec::new(),
        journals_without_line: Vec::new(),
        gap_journals: Vec::new(),
        gaps: Vec::new(),
    };
    let Some(latest) = latest else {
        return out;
    };
    let date = latest.end;
    let on_account = |j: &LedgerJournal<'_>| j.on_account(account.code);

    // Journals in force: neither a reversal nor reversed.
    let reversed: BTreeSet<&str> = input
        .journals
        .iter()
        .filter_map(|j| j.reverses_journal_id)
        .collect();
    let live: BTreeMap<&str, &LedgerJournal<'_>> = input
        .journals
        .iter()
        .filter(|j| j.reverses_journal_id.is_none() && !reversed.contains(j.id))
        .map(|j| (j.id, j))
        .collect();

    let ledger: Money = input
        .journals
        .iter()
        .filter(|j| j.journal.date <= date)
        .map(on_account)
        .sum();

    // Bank lines and the journals that match them.
    let mut matched: BTreeSet<&str> = BTreeSet::new();
    if let Some(id) = account.opening_journal_id {
        matched.insert(id);
    }
    matched.extend(input.gap_journals.iter().map(|g| g.journal_id));
    let mut lines: Vec<&BankLineFacts<'_>> =
        input.lines.iter().filter(|l| l.date <= date).collect();
    lines.sort_by_key(|l| (l.date, l.description, l.occurrence));
    for l in lines {
        let reason = if l.duplicate {
            Some(UnmatchedReason::Duplicate)
        } else {
            match l.journal_id.and_then(|id| live.get(id)) {
                None => Some(UnmatchedReason::NoJournal),
                Some(j) if on_account(j) != l.amount => Some(UnmatchedReason::JournalDiffers),
                Some(j) => {
                    matched.insert(j.id);
                    None
                }
            }
        };
        if let Some(reason) = reason {
            out.lines_without_journal.push(UnmatchedLine {
                bank_line_id: l.id.to_owned(),
                date: l.date,
                description: l.description.to_owned(),
                amount: l.amount,
                reason,
            });
        }
    }

    // Live journals on the account that nothing above matched.
    let mut stray: Vec<&LedgerJournal<'_>> = live
        .values()
        .copied()
        .filter(|j| j.journal.date <= date && !matched.contains(j.id))
        .filter(|j| !on_account(j).is_zero())
        .collect();
    stray.sort_by_key(|j| (j.journal.date, j.posted_seq));
    out.journals_without_line = stray
        .into_iter()
        .map(|j| UnmatchedJournal {
            journal_id: j.id.to_owned(),
            date: j.journal.date,
            narration: j.journal.narration.clone(),
            amount: on_account(j),
        })
        .collect();

    out.gap_journals = input
        .gap_journals
        .iter()
        .filter(|g| g.end <= date)
        .filter_map(|g| {
            let j = live.get(g.journal_id)?;
            Some(GapJournalItem {
                journal_id: g.journal_id.to_owned(),
                start: g.start,
                end: g.end,
                amount: on_account(j),
            })
        })
        .collect();
    out.gaps = input
        .gaps
        .iter()
        .filter(|g| g.start <= date)
        .map(|g| GapItem {
            start: g.start,
            end: g.end,
            change: g.change,
        })
        .collect();

    out.date = Some(date);
    out.statement_file = Some(latest.file_name.to_owned());
    out.ledger_balance = Some(ledger);
    let Some(statement) = latest.stored_closing else {
        out.status = ReconcileStatus::NoBalance;
        return out;
    };
    let lines_total: Money = out
        .lines_without_journal
        .iter()
        .filter(|l| l.reason != UnmatchedReason::Duplicate)
        .map(|l| l.amount)
        .sum();
    let journals_total: Money = out.journals_without_line.iter().map(|j| j.amount).sum();
    let difference = ledger - statement;
    let unexplained = difference - journals_total + lines_total;
    out.statement_balance = Some(statement);
    out.difference = Some(difference);
    out.unexplained = Some(unexplained);
    out.status = if !unexplained.is_zero() {
        ReconcileStatus::Differs
    } else if difference.is_zero() && lines_total.is_zero() && journals_total.is_zero() {
        ReconcileStatus::Agrees
    } else {
        ReconcileStatus::Explained
    };
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ledger::JournalLine;

    fn d(s: &str) -> NaiveDate {
        s.parse().unwrap()
    }

    fn m(s: &str) -> Money {
        s.parse().unwrap()
    }

    fn code(s: &str) -> AccountCode {
        s.parse().unwrap()
    }

    fn year() -> ClientYear {
        ClientYear::new(d("2025-08-01"), d("2026-03-31")).unwrap()
    }

    struct J {
        id: String,
        reverses: Option<String>,
        journal: Journal,
    }

    fn journal(id: &str, date: &str, bank: &str, other: &str, reverses: Option<&str>) -> J {
        J {
            id: id.into(),
            reverses: reverses.map(Into::into),
            journal: Journal {
                date: d(date),
                narration: id.into(),
                lines: vec![
                    JournalLine {
                        account: code("600.01"),
                        amount: m(bank),
                    },
                    JournalLine {
                        account: code(other),
                        amount: -m(bank),
                    },
                ],
            },
        }
    }

    struct L {
        id: String,
        date: NaiveDate,
        amount: Money,
        description: String,
        journal_id: String,
    }

    fn line(id: &str, date: &str, amount: &str, journal_id: &str) -> L {
        L {
            id: id.into(),
            date: d(date),
            amount: m(amount),
            description: id.to_uppercase(),
            journal_id: journal_id.into(),
        }
    }

    fn statement(end: &str, closing: Option<&str>) -> (String, NaiveDate, Option<Money>) {
        (format!("to-{end}.ofx"), d(end), closing.map(m))
    }

    fn run(
        statements: &[(String, NaiveDate, Option<Money>)],
        lines: &[L],
        dupes: &[&str],
        journals: &[J],
    ) -> AccountReconciliation {
        let bank = code("600.01");
        let statements: Vec<StatementFacts<'_>> = statements
            .iter()
            .map(|(file, end, closing)| StatementFacts {
                id: "s1",
                file_name: file,
                start: d("2025-08-01"),
                end: *end,
                opening: Some(m("100.00")),
                opening_date: d("2025-08-01"),
                closing: *closing,
                closing_date: *end,
                stored_closing: *closing,
                imported_seq: 1,
                opening_span: None,
                closing_span: None,
            })
            .collect();
        let lines: Vec<BankLineFacts<'_>> = lines
            .iter()
            .map(|l| {
                let duplicate = dupes.contains(&l.id.as_str());
                BankLineFacts {
                    id: &l.id,
                    statement_id: "s1",
                    date: l.date,
                    amount: l.amount,
                    description: &l.description,
                    occurrence: 1,
                    balance: None,
                    balance_span: None,
                    journal_id: (!duplicate).then_some(l.journal_id.as_str()),
                    duplicate,
                }
            })
            .collect();
        let journals: Vec<LedgerJournal<'_>> = journals
            .iter()
            .map(|j| LedgerJournal {
                id: &j.id,
                reverses_journal_id: j.reverses.as_deref(),
                posted_seq: 1,
                journal: &j.journal,
            })
            .collect();
        reconcile_account(
            &year(),
            &AccountInputs {
                account: AccountFacts {
                    id: "a1",
                    code: &bank,
                    name: "Cheque",
                    kind: ReconcileAccountKind::Bank,
                    account_number: Some("99-1001-0000123-00"),
                    opening_journal_id: Some("j-open"),
                },
                statements: &statements,
                lines: &lines,
                journals: &journals,
                gap_journals: &[],
                gaps: &[],
            },
        )
    }

    fn base() -> (Vec<L>, Vec<J>) {
        (
            vec![
                line("l1", "2025-08-05", "50.00", "j1"),
                line("l2", "2025-08-20", "-30.00", "j2"),
            ],
            vec![
                journal("j-open", "2025-08-01", "100.00", "950", None),
                journal("j1", "2025-08-05", "50.00", "140", None),
                journal("j2", "2025-08-20", "-30.00", "965", None),
            ],
        )
    }

    #[test]
    fn agrees_when_every_line_has_its_journal() {
        let (lines, journals) = base();
        let r = run(
            &[statement("2025-08-31", Some("120.00"))],
            &lines,
            &[],
            &journals,
        );
        assert_eq!(r.status, ReconcileStatus::Agrees);
        assert_eq!(r.ledger_balance, Some(m("120.00")));
        assert_eq!(r.difference, Some(Money::ZERO));
        assert!(r.lines_without_journal.is_empty() && r.journals_without_line.is_empty());
    }

    /// A recode reverses and reposts: the reversal pair is neither unmatched nor counted twice.
    #[test]
    fn recoded_lines_still_match() {
        let (mut lines, mut journals) = base();
        journals.push(journal("j2r", "2025-08-20", "30.00", "965", Some("j2")));
        journals.push(journal("j2b", "2025-08-20", "-30.00", "960", None));
        lines[1].journal_id = "j2b".into();
        let r = run(
            &[statement("2025-08-31", Some("120.00"))],
            &lines,
            &[],
            &journals,
        );
        assert_eq!(r.status, ReconcileStatus::Agrees);
    }

    #[test]
    fn a_hand_journal_on_the_bank_is_listed_and_explains_the_difference() {
        let (lines, mut journals) = base();
        journals.push(journal("jm", "2025-08-25", "7.00", "290", None));
        let r = run(
            &[statement("2025-08-31", Some("120.00"))],
            &lines,
            &[],
            &journals,
        );
        assert_eq!(r.status, ReconcileStatus::Explained);
        assert_eq!(r.difference, Some(m("7.00")));
        assert_eq!(r.unexplained, Some(Money::ZERO));
        assert_eq!(r.journals_without_line.len(), 1);
        assert_eq!(r.journals_without_line[0].amount, m("7.00"));
    }

    #[test]
    fn a_line_with_no_journal_is_listed_and_a_duplicate_isnt_a_reconciling_item() {
        let (mut lines, mut journals) = base();
        // l3 is on the statement but its journal was reversed with nothing in its place.
        lines.push(line("l3", "2025-08-21", "-5.00", "j3"));
        journals.push(journal("j3", "2025-08-21", "-5.00", "965", None));
        journals.push(journal("j3r", "2025-08-21", "5.00", "965", Some("j3")));
        // l4 is a duplicate of l1: the bank counted it once, under l1.
        lines.push(line("l4", "2025-08-05", "50.00", "j4"));
        let r = run(
            &[statement("2025-08-31", Some("115.00"))],
            &lines,
            &["l4"],
            &journals,
        );
        let reasons: Vec<_> = r
            .lines_without_journal
            .iter()
            .map(|l| (l.bank_line_id.as_str(), l.reason))
            .collect();
        assert_eq!(
            reasons,
            vec![
                ("l4", UnmatchedReason::Duplicate),
                ("l3", UnmatchedReason::NoJournal)
            ]
        );
        assert_eq!(r.difference, Some(m("5.00")));
        assert_eq!(r.unexplained, Some(Money::ZERO));
        assert_eq!(r.status, ReconcileStatus::Explained);
    }

    #[test]
    fn a_difference_nothing_explains() {
        let (lines, journals) = base();
        let r = run(
            &[statement("2025-08-31", Some("121.00"))],
            &lines,
            &[],
            &journals,
        );
        assert_eq!(r.status, ReconcileStatus::Differs);
        assert_eq!(r.unexplained, Some(m("-1.00")));
    }

    #[test]
    fn no_balance_and_no_statement() {
        let (lines, journals) = base();
        let r = run(&[statement("2025-08-31", None)], &lines, &[], &journals);
        assert_eq!(r.status, ReconcileStatus::NoBalance);
        assert_eq!(r.ledger_balance, Some(m("120.00")));
        // A statement ending after the year isn't used.
        let r = run(
            &[statement("2026-04-30", Some("120.00"))],
            &lines,
            &[],
            &journals,
        );
        assert_eq!(r.status, ReconcileStatus::NoStatement);
        assert_eq!(r.date, None);
    }

    /// Items after the reconciliation date aren't in it.
    #[test]
    fn only_items_up_to_the_date() {
        let (mut lines, mut journals) = base();
        lines.push(line("l5", "2025-09-02", "9.00", "j5"));
        journals.push(journal("j5", "2025-09-02", "9.00", "140", None));
        journals.push(journal("jm", "2025-09-03", "1.00", "290", None));
        let r = run(
            &[statement("2025-08-31", Some("120.00"))],
            &lines,
            &[],
            &journals,
        );
        assert_eq!(r.status, ReconcileStatus::Agrees);
    }

    /// The opening journal is a movement at the start of its day; others aren't.
    #[test]
    fn movements_on_the_account() {
        let (_, journals) = base();
        let bank = code("600.01");
        let account = AccountFacts {
            id: "a1",
            code: &bank,
            name: "Cheque",
            kind: ReconcileAccountKind::Bank,
            account_number: None,
            opening_journal_id: Some("j-open"),
        };
        let ledger: Vec<LedgerJournal<'_>> = journals
            .iter()
            .map(|j| LedgerJournal {
                id: &j.id,
                reverses_journal_id: None,
                posted_seq: 1,
                journal: &j.journal,
            })
            .collect();
        let got: Vec<(Money, bool)> = movements(&account, &ledger)
            .iter()
            .map(|mv| (mv.amount, mv.opening))
            .collect();
        assert_eq!(
            got,
            vec![
                (m("100.00"), true),
                (m("50.00"), false),
                (m("-30.00"), false)
            ]
        );
    }
}
