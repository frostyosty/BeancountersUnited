//! Bank reconciliation for a client-year (M15): for each bank account and card, the statement's
//! closing balance against the ledger's balance on that date, and the items that don't match.
//!
//! The arithmetic is in `acct_core::reconcile`; this loads the data and serves it. Nothing here is
//! stored; it's worked out on each read.

use std::collections::BTreeMap;

use acct_core::Money;
use acct_core::reconcile::suspects::{
    AccountSide, BalanceBreak, JournalOrigin, OpeningFacts, OtherStatement, SuspectInput,
    SuspectJournal, SuspectLine, SuspectStatement,
};
use acct_core::reconcile::{
    AccountFacts, AccountInputs, BalanceKind, BankLineFacts, GapJournalFacts, LedgerJournal,
    StatementFacts, checkpoints, movements, reconcile_account, walk,
};
pub use acct_core::reconcile::{
    AccountReconciliation, GapItem, GapJournalItem, ReconcileAccountKind, ReconcileStatus,
    UnmatchedJournal, UnmatchedLine, UnmatchedReason,
};
use acct_import::bank::{Balance, BalanceCheck, Statement, duplicate_keys, read_statement};
use acct_store::bank::{
    self as bank_store, AccountKind, BalanceSpan, BankAccount, BankLine, StoredStatement,
};
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

/// The account as core needs it.
pub fn account_facts(account: &BankAccount) -> AccountFacts<'_> {
    AccountFacts {
        id: &account.id,
        code: &account.code,
        name: &account.name,
        kind: match account.kind {
            AccountKind::Bank => ReconcileAccountKind::Bank,
            AccountKind::CreditCard => ReconcileAccountKind::CreditCard,
        },
        account_number: account.account_number.as_deref(),
        opening_journal_id: account.opening_journal_id.as_deref(),
    }
}

/// Each statement's kept file (M18), read again with the parser that read it on upload: statement
/// id → what the file says. A statement uploaded before M18 has no file kept, so it isn't here.
/// Nor is a file that no longer reads (a parser changed since), which then counts as not kept.
pub async fn kept_statements(
    conn: &mut SqliteConnection,
    stored: &[StoredStatement],
) -> Result<BTreeMap<String, Statement>, CommandError> {
    let mut out = BTreeMap::new();
    for s in stored {
        if let Some(file) = bank_store::statement_file(conn, &s.id).await?
            && let Ok(parsed) = read_statement(&file.bytes)
        {
            out.insert(s.id.clone(), parsed);
        }
    }
    Ok(out)
}

/// A stored statement as core needs it. `kept` is its file read again ([`kept_statements`]);
/// `spans` are the account's balance spans, or just this statement's.
///
/// Checkpoints count only balances the bank states, on the dates it states them (`docs/domain.md`,
/// "Bank vs books"). M10 stores the statement's coverage (its period widened to take in every
/// line) and both ends' balances, working out the one the file doesn't state. So the stated
/// balances and their dates come from the kept file, not from the stored row. A statement uploaded
/// before M18 has no file kept: which of its balances were stated isn't known, so both stored
/// balances count, at the ends of its coverage, as they did before. `stored_closing` is always
/// M10's figure, for M15's reconciliation.
pub fn statement_facts<'a>(
    s: &'a StoredStatement,
    kept: Option<&Statement>,
    spans: &[BalanceSpan],
) -> StatementFacts<'a> {
    let span_of = |kind: BalanceKind| {
        spans
            .iter()
            .find(|b| b.statement_id == s.id && b.balance == kind)
            .map(|b| b.span)
    };
    let stored = |cents: Option<i64>, date: NaiveDate| (cents.map(Money::from_cents), date, None);
    let stated = |b: Option<Balance>, kind: BalanceKind, otherwise: NaiveDate| match b {
        Some(b) => (Some(b.amount), b.date, span_of(kind).or(b.span)),
        None => (None, otherwise, None),
    };
    let ((opening, opening_date, opening_span), (closing, closing_date, closing_span)) = match kept
    {
        Some(file) => (
            stated(file.opening, BalanceKind::Opening, s.start_date),
            stated(file.closing, BalanceKind::Closing, s.end_date),
        ),
        None => (
            stored(s.opening_balance, s.start_date),
            stored(s.closing_balance, s.end_date),
        ),
    };
    StatementFacts {
        id: &s.id,
        file_name: &s.file_name,
        start: s.start_date,
        end: s.end_date,
        opening,
        opening_date,
        closing,
        closing_date,
        stored_closing: s.closing_balance.map(Money::from_cents),
        imported_seq: s.imported_seq,
        opening_span,
        closing_span,
    }
}

/// A stored line with the journal live for it now (`None` if it posts nothing). Lines are stored
/// in file order with UUIDv7 ids, so sorting a statement's lines by id gives the file's order.
pub fn line_facts<'a>(line: &'a BankLine, state: Option<&'a LineState>) -> BankLineFacts<'a> {
    let (journal_id, duplicate) = match state {
        None => (Some(line.journal_id.as_str()), false),
        Some(s) => (s.journal_id.as_deref(), s.state == LineStateKind::Duplicate),
    };
    BankLineFacts {
        id: &line.id,
        statement_id: &line.statement_id,
        date: line.date,
        amount: line.amount,
        description: &line.description,
        occurrence: line.occurrence,
        balance: line.balance,
        balance_span: None,
        journal_id,
        duplicate,
    }
}

/// A stored journal as core needs it.
pub fn ledger_journal(j: &StoredJournal) -> LedgerJournal<'_> {
    LedgerJournal {
        id: &j.id,
        reverses_journal_id: j.reverses_journal_id.as_deref(),
        posted_seq: j.posted_seq,
        journal: &j.journal,
    }
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
    let ledger: Vec<LedgerJournal<'_>> = all.iter().map(ledger_journal).collect();
    let start = year_list
        .first()
        .map_or(year.year.start(), |y| y.year.start());
    let mut lines = bank_store::bank_lines(conn, &year.client_id).await?;
    lines.sort_by(|a, b| (&a.statement_id, &a.id).cmp(&(&b.statement_id, &b.id)));
    let states: BTreeMap<String, LineState> = coding_store::line_states(conn, &year.client_id)
        .await?
        .into_iter()
        .map(|s| (s.bank_line_id.clone(), s))
        .collect();

    let mut out = Vec::new();
    for account in &accounts {
        let statements = bank_store::statements(conn, &account.id).await?;
        let spans = bank_store::balance_spans_for_account(conn, &account.id).await?;
        let kept = kept_statements(conn, &statements).await?;
        let statements: Vec<StatementFacts<'_>> = statements
            .iter()
            .map(|s| statement_facts(s, kept.get(&s.id), &spans))
            .collect();
        let gap_journals = bank_store::live_gap_journals(conn, &account.id).await?;
        let gap_journals: Vec<GapJournalFacts<'_>> = gap_journals
            .iter()
            .map(|g| GapJournalFacts {
                journal_id: &g.journal_id,
                start: g.start_date,
                end: g.end_date,
            })
            .collect();
        let gaps = business::account_gaps(conn, account, start).await?;
        let account_lines: Vec<BankLineFacts<'_>> = lines
            .iter()
            .filter(|l| l.bank_account_id == account.id)
            .map(|l| line_facts(l, states.get(&l.id)))
            .collect();
        out.push(reconcile_account(
            &year.year,
            &AccountInputs {
                account: account_facts(account),
                statements: &statements,
                lines: &account_lines,
                journals: &ledger,
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

/// What the suspects (M18, `acct_core::reconcile::suspects`) look at for one bank account: its
/// checkpoints walked against the ledger, its stored lines with M10's flag and the owner's answer,
/// the live journals on it and where each came from, its statements with what their kept files
/// state, its gaps, and the business's other accounts' statements. Read only.
///
/// The books are the app's own: gap journals are in the ledger like any other journal
/// (`docs/domain.md`, "Bank vs books"), and checkpoints are the balances the files state, on
/// their own dates.
pub async fn suspect_input(
    conn: &mut SqliteConnection,
    client_id: &str,
    bank_account_id: &str,
) -> Result<SuspectInput, CommandError> {
    let account = bank_store::bank_account(conn, bank_account_id)
        .await?
        .filter(|a| a.client_id == client_id)
        .ok_or_else(|| CommandError::not_found("bank account", bank_account_id))?;
    let business = business::business(conn, client_id).await?;
    let year_list = years::for_client(conn, client_id).await?;
    let start = year_list
        .first()
        .map_or(business.start_date, |y| y.year.start());

    // The ledger: every journal of the client, and the live ones on this account.
    let mut all: Vec<StoredJournal> = Vec::new();
    for y in &year_list {
        all.extend(journals::for_year(conn, &y.id).await?);
    }
    let ledger: Vec<LedgerJournal<'_>> = all.iter().map(ledger_journal).collect();
    let facts = account_facts(&account);
    let reversed: std::collections::BTreeSet<&str> = all
        .iter()
        .filter_map(|j| j.reverses_journal_id.as_deref())
        .collect();

    // The account's statements, lines and what the owner said about them.
    let stored = bank_store::statements(conn, &account.id).await?;
    let spans = bank_store::balance_spans_for_account(conn, &account.id).await?;
    let kept = kept_statements(conn, &stored).await?;
    let all_lines = bank_store::bank_lines(conn, client_id).await?;
    let states: BTreeMap<String, LineState> = coding_store::line_states(conn, client_id)
        .await?
        .into_iter()
        .map(|s| (s.bank_line_id.clone(), s))
        .collect();
    let answers: BTreeMap<String, bool> = coding_store::duplicate_answers(conn, client_id)
        .await?
        .into_iter()
        .collect();
    let suspect_line = |l: &BankLine| {
        let f = line_facts(l, states.get(&l.id));
        SuspectLine {
            id: l.id.clone(),
            statement_id: l.statement_id.clone(),
            bank_id: l.bank_id.clone(),
            date: l.date,
            amount: l.amount,
            description: l.description.clone(),
            balance: l.balance,
            journal_id: f.journal_id.map(str::to_owned),
            possible_duplicate: l.possible_duplicate,
            duplicate_answer: answers.get(&l.id).copied(),
        }
    };
    let mut lines: Vec<&BankLine> = all_lines
        .iter()
        .filter(|l| l.bank_account_id == account.id)
        .collect();
    // Each statement's lines in file order (UUIDv7 ids are in the order stored).
    lines.sort_by(|a, b| (&a.statement_id, &a.id).cmp(&(&b.statement_id, &b.id)));

    // The checkpoints, walked.
    let statement_facts: Vec<StatementFacts<'_>> = stored
        .iter()
        .map(|s| statement_facts(s, kept.get(&s.id), &spans))
        .collect();
    let line_facts_: Vec<BankLineFacts<'_>> = lines
        .iter()
        .map(|l| BankLineFacts {
            balance_span: spans
                .iter()
                .find(|b| {
                    b.statement_id == l.statement_id
                        && matches!(&b.balance, BalanceKind::Running { bank_line_id } if bank_line_id == &l.id)
                })
                .map(|b| b.span),
            ..line_facts(l, states.get(&l.id))
        })
        .collect();
    let checkpoints = checkpoints(
        &statement_facts,
        &line_facts_,
        year_list.first().map(|_| start),
    );
    let walked = walk(&checkpoints, &movements(&facts, &ledger));

    // Where each live journal on the account came from.
    let gap_journals = bank_store::live_gap_journals(conn, &account.id).await?;
    let line_of_journal: BTreeMap<&str, &str> = line_facts_
        .iter()
        .filter_map(|l| Some((l.journal_id?, l.id)))
        .collect();
    let journals: Vec<SuspectJournal> = all
        .iter()
        .filter(|j| j.reverses_journal_id.is_none() && !reversed.contains(j.id.as_str()))
        .filter(|j| j.journal.lines.iter().any(|l| l.account == account.code))
        .map(|j| {
            let origin = if account.opening_journal_id.as_deref() == Some(j.id.as_str()) {
                JournalOrigin::Opening
            } else if let Some(g) = gap_journals.iter().find(|g| g.journal_id == j.id) {
                JournalOrigin::Gap {
                    start: g.start_date,
                    end: g.end_date,
                }
            } else if let Some(line) = line_of_journal.get(j.id.as_str()) {
                JournalOrigin::BankLine {
                    bank_line_id: (*line).to_owned(),
                }
            } else {
                JournalOrigin::ByHand
            };
            SuspectJournal {
                id: j.id.clone(),
                date: j.journal.date,
                narration: j.journal.narration.clone(),
                amount: ledger_journal(j).on_account(&account.code),
                origin,
            }
        })
        .collect();

    // The statements: what each file states, and where its own balances break.
    let key_account = account
        .account_number
        .clone()
        .unwrap_or_else(|| account.id.clone());
    let statements: Vec<SuspectStatement> = stored
        .iter()
        .zip(&statement_facts)
        .map(|(s, f)| {
            let file = kept.get(&s.id);
            SuspectStatement {
                id: s.id.clone(),
                file_name: s.file_name.clone(),
                start: s.start_date,
                end: s.end_date,
                imported_seq: s.imported_seq,
                account_number: file.and_then(|p| p.account.clone()),
                stated_opening: f.opening,
                stated_closing: f.closing,
                balance_break: file.and_then(|p| balance_break(p, &key_account, &s.id, &lines)),
            }
        })
        .collect();

    // The business's other accounts' statements, and what their lines put on those accounts.
    let mut other_accounts = Vec::new();
    for other in bank_store::bank_accounts(conn, client_id).await? {
        if other.id == account.id {
            continue;
        }
        for s in bank_store::statements(conn, &other.id).await? {
            let net = all_lines
                .iter()
                .filter(|l| l.statement_id == s.id)
                .map(&suspect_line)
                .filter(SuspectLine::posts)
                .map(|l| l.amount)
                .sum();
            other_accounts.push(OtherStatement {
                bank_account_id: other.id.clone(),
                statement_id: s.id,
                start: s.start_date,
                end: s.end_date,
                net,
            });
        }
    }

    let opening = match (&account.opening, &account.opening_journal_id) {
        (Some((date, amount)), Some(journal_id)) => Some(OpeningFacts {
            journal_id: journal_id.clone(),
            date: *date,
            amount: *amount,
        }),
        _ => None,
    };
    Ok(SuspectInput {
        account: AccountSide {
            bank_account_id: account.id.clone(),
            kind: facts.kind,
            account_number: account.account_number.clone(),
            start,
        },
        opening,
        checkpoints,
        compared: walked.compared,
        window: walked.window,
        lines: lines.iter().map(|l| suspect_line(l)).collect(),
        journals,
        statements,
        gaps: business::account_gaps(conn, &account, start).await?,
        other_accounts: Some(other_accounts),
    })
}

/// Where a kept file's own balances first disagree with its lines (`Statement::balance_check`),
/// with the stored line for the row that breaks, found by its duplicate key (date, amount,
/// description, occurrence) among `statement_id`'s lines. A row that wasn't stored with this
/// statement (it was already imported) gives no line.
fn balance_break(
    file: &Statement,
    key_account: &str,
    statement_id: &str,
    lines: &[&BankLine],
) -> Option<BalanceBreak> {
    let BalanceCheck::Fails {
        row,
        expected,
        stated,
    } = file.balance_check()
    else {
        return None;
    };
    let bank_line_id = row.and_then(|row| {
        let keys = duplicate_keys(key_account, &file.lines);
        let (line, key) = file.lines.iter().zip(keys).find(|(l, _)| l.row == row)?;
        lines
            .iter()
            .find(|l| {
                l.statement_id == statement_id
                    && l.date == line.date
                    && l.amount == line.amount
                    && l.description == line.description
                    && l.occurrence == key.occurrence
            })
            .map(|l| l.id.clone())
    });
    Some(BalanceBreak {
        bank_line_id,
        expected,
        stated,
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
    use acct_core::reconcile::SourceSpan;

    fn statement() -> StoredStatement {
        let d = |s: &str| s.parse().unwrap();
        StoredStatement {
            id: "s1".into(),
            bank_account_id: "a1".into(),
            parser: "qif".into(),
            file_name: "visa.qif".into(),
            start_date: d("2025-07-01"),
            end_date: d("2025-09-28"),
            opening_balance: Some(-10_000),
            closing_balance: Some(-25_000),
            lines_in_file: 3,
            lines_added: 3,
            imported_seq: 1,
        }
    }

    fn span(statement_id: &str, balance: BalanceKind) -> BalanceSpan {
        BalanceSpan {
            statement_id: statement_id.into(),
            balance,
            span: SourceSpan {
                line: 2,
                start: 1,
                end: 8,
            },
        }
    }

    fn file(opening: Option<(&str, i64)>, closing: Option<(&str, i64)>) -> Statement {
        let balance = |(date, cents): (&str, i64)| Balance {
            date: date.parse().unwrap(),
            amount: Money::from_cents(cents),
            span: None,
        };
        Statement {
            parser: "qif".into(),
            kind: acct_import::bank::StatementKind::CreditCard,
            account: None,
            period_start: None,
            period_end: None,
            opening: opening.map(balance),
            closing: closing.map(balance),
            lines: Vec::new(),
        }
    }

    /// A QIF states only its opening balance: the closing M10 worked out isn't a checkpoint, but
    /// M15 still reconciles against it.
    #[test]
    fn only_balances_the_file_states_reach_the_checkpoints() {
        let s = statement();
        let spans = [
            span("s1", BalanceKind::Opening),
            span("other", BalanceKind::Closing),
        ];
        let kept = file(Some(("2025-07-01", -10_000)), None);
        let f = statement_facts(&s, Some(&kept), &spans);
        assert_eq!(f.opening, Some(Money::from_cents(-10_000)));
        assert!(f.opening_span.is_some());
        assert_eq!((f.closing, f.closing_span), (None, None));
        assert_eq!(f.stored_closing, Some(Money::from_cents(-25_000)));
    }

    /// A stated balance sits on the date the file gives it, not at the end of the days the
    /// statement covers (the coverage takes in a line dated after the closing balance).
    #[test]
    fn a_stated_balance_keeps_its_own_date() {
        let s = statement();
        let kept = file(None, Some(("2025-09-27", -25_000)));
        let f = statement_facts(&s, Some(&kept), &[]);
        assert_eq!(f.opening, None);
        assert_eq!(f.closing, Some(Money::from_cents(-25_000)));
        assert_eq!(f.closing_date, "2025-09-27".parse::<NaiveDate>().unwrap());
        assert_eq!(f.end, "2025-09-28".parse::<NaiveDate>().unwrap());
    }

    /// Uploaded before M18 kept files: which balances were stated isn't known, so both count, at
    /// the ends of the statement's coverage.
    #[test]
    fn a_statement_without_a_kept_file_keeps_both_balances() {
        let s = statement();
        let f = statement_facts(&s, None, &[span("other", BalanceKind::Opening)]);
        assert_eq!(f.opening, Some(Money::from_cents(-10_000)));
        assert_eq!(f.closing, Some(Money::from_cents(-25_000)));
        assert_eq!((f.opening_date, f.closing_date), (s.start_date, s.end_date));
    }
}
