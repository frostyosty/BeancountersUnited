//! Bank reconciliation for a client-year (M15): for each bank account and card, the statement's
//! closing balance against the ledger's balance on that date, and the items that don't match.
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
//! doesn't fit that is `unexplained`. Nothing here is stored; it's worked out on each read.

use std::collections::{BTreeMap, BTreeSet};

use acct_core::bank::Gap;
use acct_core::{ClientYear, Money};
use acct_store::bank::{self as bank_store, AccountKind, BankAccount, BankLine, StoredStatement};
use acct_store::coding::{self as coding_store, LineState, LineStateKind};
use acct_store::journals::StoredJournal;
use acct_store::{SqliteConnection, journals, years};
use axum::Json;
use axum::extract::{Path, State};
use chrono::NaiveDate;
use serde::Serialize;
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::business;
use crate::error::CommandError;

/// `GET /api/years/{id}/reconciliation`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct YearReconciliation {
    pub client_year_id: String,
    /// Bank accounts, then cards, in the order they were added. Empty for a client that isn't
    /// run as a business (its books come from a TB import).
    pub accounts: Vec<AccountReconciliation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
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

/// One bank line with the journal that's live for it now (`None` if it posts nothing).
#[derive(Debug, Clone)]
pub struct LineWithJournal<'a> {
    pub line: &'a BankLine,
    pub journal_id: Option<&'a str>,
    pub duplicate: bool,
}

/// Everything one account's reconciliation needs, already loaded.
pub struct AccountInputs<'a> {
    pub account: &'a BankAccount,
    pub statements: &'a [StoredStatement],
    pub lines: Vec<LineWithJournal<'a>>,
    /// Every journal of the client, in every year.
    pub journals: &'a [StoredJournal],
    /// The account's gap journals that haven't been reversed.
    pub gap_journals: &'a [bank_store::GapJournal],
    pub gaps: &'a [Gap],
}

/// Reconciles one account at the end of the latest statement inside `year`. Pure.
pub fn reconcile_account(year: &ClientYear, input: &AccountInputs<'_>) -> AccountReconciliation {
    let account = input.account;
    let latest = input
        .statements
        .iter()
        .filter(|s| year.contains(s.end_date))
        .max_by_key(|s| (s.end_date, s.imported_seq));
    let mut out = AccountReconciliation {
        bank_account_id: account.id.clone(),
        code: account.code.to_string(),
        name: account.name.clone(),
        kind: match account.kind {
            AccountKind::Bank => ReconcileAccountKind::Bank,
            AccountKind::CreditCard => ReconcileAccountKind::CreditCard,
        },
        account_number: account.account_number.clone(),
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
    let date = latest.end_date;

    // Journals in force: neither a reversal nor reversed.
    let reversed: BTreeSet<&str> = input
        .journals
        .iter()
        .filter_map(|j| j.reverses_journal_id.as_deref())
        .collect();
    let live: BTreeMap<&str, &StoredJournal> = input
        .journals
        .iter()
        .filter(|j| j.reverses_journal_id.is_none() && !reversed.contains(j.id.as_str()))
        .map(|j| (j.id.as_str(), j))
        .collect();
    let on_account = |j: &StoredJournal| -> Money {
        j.journal
            .lines
            .iter()
            .filter(|l| l.account == account.code)
            .map(|l| l.amount)
            .sum()
    };

    let ledger: Money = input
        .journals
        .iter()
        .filter(|j| j.journal.date <= date)
        .map(on_account)
        .sum();

    // Bank lines and the journals that match them.
    let mut matched: BTreeSet<&str> = BTreeSet::new();
    if let Some(id) = account.opening_journal_id.as_deref() {
        matched.insert(id);
    }
    let gap_ids: BTreeSet<&str> = input
        .gap_journals
        .iter()
        .map(|g| g.journal_id.as_str())
        .collect();
    matched.extend(&gap_ids);
    let mut lines: Vec<&LineWithJournal<'_>> = input
        .lines
        .iter()
        .filter(|l| l.line.bank_account_id == account.id && l.line.date <= date)
        .collect();
    lines.sort_by_key(|l| (l.line.date, &l.line.description, l.line.occurrence));
    for l in lines {
        let reason = if l.duplicate {
            Some(UnmatchedReason::Duplicate)
        } else {
            match l.journal_id.and_then(|id| live.get(id)) {
                None => Some(UnmatchedReason::NoJournal),
                Some(j) if on_account(j) != l.line.amount => Some(UnmatchedReason::JournalDiffers),
                Some(j) => {
                    matched.insert(j.id.as_str());
                    None
                }
            }
        };
        if let Some(reason) = reason {
            out.lines_without_journal.push(UnmatchedLine {
                bank_line_id: l.line.id.clone(),
                date: l.line.date,
                description: l.line.description.clone(),
                amount: l.line.amount,
                reason,
            });
        }
    }

    // Live journals on the account that nothing above matched.
    let mut stray: Vec<&StoredJournal> = live
        .values()
        .copied()
        .filter(|j| j.journal.date <= date && !matched.contains(j.id.as_str()))
        .filter(|j| !on_account(j).is_zero())
        .collect();
    stray.sort_by_key(|j| (j.journal.date, j.posted_seq));
    out.journals_without_line = stray
        .into_iter()
        .map(|j| UnmatchedJournal {
            journal_id: j.id.clone(),
            date: j.journal.date,
            narration: j.journal.narration.clone(),
            amount: on_account(j),
        })
        .collect();

    out.gap_journals = input
        .gap_journals
        .iter()
        .filter(|g| g.end_date <= date)
        .filter_map(|g| {
            let j = live.get(g.journal_id.as_str())?;
            Some(GapJournalItem {
                journal_id: g.journal_id.clone(),
                start: g.start_date,
                end: g.end_date,
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
    out.statement_file = Some(latest.file_name.clone());
    out.ledger_balance = Some(ledger);
    let Some(statement) = latest.closing_balance.map(Money::from_cents) else {
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

/// Loads a client-year's bank accounts and reconciles each one.
pub async fn year_reconciliation(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<YearReconciliation, CommandError> {
    let year = years::get(conn, client_year_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client year", client_year_id))?;
    let accounts = bank_store::bank_accounts(conn, &year.client_id).await?;
    if accounts.is_empty() {
        return Ok(YearReconciliation {
            client_year_id: client_year_id.to_owned(),
            accounts: Vec::new(),
        });
    }
    let year_list = years::for_client(conn, &year.client_id).await?;
    let mut all: Vec<StoredJournal> = Vec::new();
    for y in &year_list {
        all.extend(journals::for_year(conn, &y.id).await?);
    }
    let start = year_list
        .first()
        .map_or(year.year.start(), |y| y.year.start());
    let lines = bank_store::bank_lines(conn, &year.client_id).await?;
    let states: BTreeMap<String, LineState> = coding_store::line_states(conn, &year.client_id)
        .await?
        .into_iter()
        .map(|s| (s.bank_line_id.clone(), s))
        .collect();
    let with_journals: Vec<LineWithJournal<'_>> = lines
        .iter()
        .map(|l| match states.get(&l.id) {
            None => LineWithJournal {
                line: l,
                journal_id: Some(l.journal_id.as_str()),
                duplicate: false,
            },
            Some(s) => LineWithJournal {
                line: l,
                journal_id: s.journal_id.as_deref(),
                duplicate: s.state == LineStateKind::Duplicate,
            },
        })
        .collect();

    let mut out = Vec::new();
    for account in &accounts {
        let statements = bank_store::statements(conn, &account.id).await?;
        let gap_journals = bank_store::live_gap_journals(conn, &account.id).await?;
        let gaps = business::account_gaps(conn, account, start).await?;
        out.push(reconcile_account(
            &year.year,
            &AccountInputs {
                account,
                statements: &statements,
                lines: with_journals
                    .iter()
                    .filter(|l| l.line.bank_account_id == account.id)
                    .cloned()
                    .collect(),
                journals: &all,
                gap_journals: &gap_journals,
                gaps: &gaps,
            },
        ));
    }
    // Bank accounts first, then cards; each in the order added.
    out.sort_by_key(|a| a.kind == ReconcileAccountKind::CreditCard);
    Ok(YearReconciliation {
        client_year_id: client_year_id.to_owned(),
        accounts: out,
    })
}

/// `GET /api/years/{id}/reconciliation`
pub async fn get_reconciliation(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<YearReconciliation>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(year_reconciliation(&mut conn, &id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use acct_core::{AccountCode, Journal, JournalLine};
    use acct_store::journals::JournalKind;

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

    fn account() -> BankAccount {
        BankAccount {
            id: "a1".into(),
            client_id: "c1".into(),
            kind: AccountKind::Bank,
            code: code("600.01"),
            name: "Cheque".into(),
            account_number: Some("99-1001-0000123-00".into()),
            opening: Some((d("2025-08-01"), m("100.00"))),
            opening_journal_id: Some("j-open".into()),
            created_seq: 1,
        }
    }

    fn journal(
        id: &str,
        date: &str,
        bank: &str,
        other: &str,
        reverses: Option<&str>,
    ) -> StoredJournal {
        StoredJournal {
            id: id.into(),
            client_year_id: "y1".into(),
            kind: JournalKind::BankLine,
            reverses_journal_id: reverses.map(Into::into),
            posted_seq: 1,
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

    fn line(id: &str, date: &str, amount: &str, journal_id: &str) -> BankLine {
        BankLine {
            id: id.into(),
            bank_account_id: "a1".into(),
            statement_id: "s1".into(),
            date: d(date),
            amount: m(amount),
            description: id.to_uppercase(),
            occurrence: 1,
            bank_id: None,
            balance: None,
            journal_id: journal_id.into(),
            possible_duplicate: false,
        }
    }

    fn statement(end: &str, closing: Option<&str>) -> StoredStatement {
        StoredStatement {
            id: "s1".into(),
            bank_account_id: "a1".into(),
            parser: "ofx".into(),
            file_name: format!("to-{end}.ofx"),
            start_date: d("2025-08-01"),
            end_date: d(end),
            opening_balance: Some(10_000),
            closing_balance: closing.map(|c| m(c).cents()),
            lines_in_file: 2,
            lines_added: 2,
            imported_seq: 1,
        }
    }

    fn run(
        statements: &[StoredStatement],
        lines: &[BankLine],
        dupes: &[&str],
        journals: &[StoredJournal],
    ) -> AccountReconciliation {
        let account = account();
        reconcile_account(
            &year(),
            &AccountInputs {
                account: &account,
                statements,
                lines: lines
                    .iter()
                    .map(|l| LineWithJournal {
                        line: l,
                        journal_id: (!dupes.contains(&l.id.as_str()))
                            .then_some(l.journal_id.as_str()),
                        duplicate: dupes.contains(&l.id.as_str()),
                    })
                    .collect(),
                journals,
                gap_journals: &[],
                gaps: &[],
            },
        )
    }

    fn base() -> (Vec<BankLine>, Vec<StoredJournal>) {
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
        let mut manual = journal("jm", "2025-08-25", "7.00", "290", None);
        manual.kind = JournalKind::Manual;
        journals.push(manual);
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
        let (mut lines, journals) = base();
        // l3 is on the statement but its journal was reversed with nothing in its place.
        lines.push(line("l3", "2025-08-21", "-5.00", "j3"));
        let mut journals = journals;
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
        let mut manual = journal("jm", "2025-09-03", "1.00", "290", None);
        manual.kind = JournalKind::Manual;
        journals.push(manual);
        let r = run(
            &[statement("2025-08-31", Some("120.00"))],
            &lines,
            &[],
            &journals,
        );
        assert_eq!(r.status, ReconcileStatus::Agrees);
    }
}
