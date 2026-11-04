//! Businesses and their bank statements (M10): setting a business up, adding bank accounts, and
//! uploading statements, which post every line to the ledger straight away.
//!
//! The rules are in `docs/domain.md` under "Bank statements to the ledger". Core does the
//! arithmetic (`acct_core::bank`); this module decides which journals to post and keeps the
//! store's record of where they came from.

use std::collections::{BTreeMap, BTreeSet};

use acct_core::bank::{Coverage, Gap, HoldingAccounts, gaps, unsorted_lines};
use acct_core::coding::CodingSettings;
use acct_core::reconcile::suspects::{SuspectInput, look_all};
use acct_core::reconcile::{
    BalanceKind, Diagnosis, EvidenceRef, FindingKind, LedgerJournal, Proof, ReconcileAccountKind,
    diagnose, movements, proof, walk,
};
use acct_store::coding::{self as coding_store, LineState};
use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Path, Query, State};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::reconcile;
use acct_core::tax::gst::GstFrequency;
use acct_core::tax::income_tax::IncomeYear;
use acct_core::{
    Account, AccountCode, AccountType, Chart, ClientYear, Journal, JournalLine, Money,
};
use acct_import::bank::{
    SourceSpan, Statement, StatementError, StatementKind, duplicate_keys, kept_copy,
    normalise_account, normalise_card, read_statement,
};
use acct_store::bank::{
    self as bank_store, AccountKind, BalanceSpan, BankAccount, BankLine, Business, GapJournal,
    GstSetting, StatementFile, StoredStatement,
};
use acct_store::clients::Client;
use acct_store::journals::{JournalKind, StoredJournal};
use acct_store::years::{BooksSource, StoredYear, YearStatus};
use acct_store::{SqliteConnection, clients, journals, new_id, templates, tenancy, years};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use crate::error::CommandError;
use crate::save_tax;

/// The practice's default coding settings for sole traders (`docs/domain.md`, "Coding settings").
/// Each business gets a copy at setup, so changing these never reaches back.
const DEFAULT_CODING_SETTINGS: &str =
    include_str!("../../../fixtures/practice/sole-trader-coding-settings.json");

/// The entity type M10 sets businesses up as.
pub const SOLE_TRADER: &str = "sole_trader";

/// The sole-trader chart's fixed accounts (`docs/domain.md`, "Sole-trader chart and template").
const MONEY_IN: &str = "140";
const MONEY_OUT: &str = "965";
const GST: &str = "810";
const CAPITAL: &str = "950";
const OWNERS_EQUITY: &str = "970";
const BANK_PARENT: &str = "600";
/// Credit cards: 850.01, 850.02, ... (liabilities).
const CARD_PARENT: &str = "850";
/// The default rounding priority list for sole traders (`docs/domain.md`, "Rounding priority
/// default"). Each business gets a copy at setup, so changing it never reaches back.
const ROUNDING_PRIORITY: &str =
    include_str!("../../../fixtures/practice/sole-trader-rounding-priority.json");

/// The GST accounting basis. M10 supports payments only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum GstBasis {
    Payments,
    Invoice,
    Hybrid,
}

/// GST details given at setup.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GstSetup {
    #[ts(type = "string")]
    pub registered_from: NaiveDate,
    #[ts(type = "\"monthly\" | \"two_monthly_odd\" | \"two_monthly_even\" | \"six_monthly\"")]
    pub frequency: GstFrequency,
    pub basis: GstBasis,
}

fn code(s: &str) -> AccountCode {
    s.parse().expect("valid built-in account code")
}

/// Sets up a business: a sole-trader client whose chart is a copy of the master chart, plus its
/// business settings. Returns the client's id.
pub async fn set_up(
    tx: &mut SqliteConnection,
    seq: i64,
    name: &str,
    start_date: NaiveDate,
    gst: Option<&GstSetup>,
) -> Result<String, CommandError> {
    if let Some(g) = gst
        && g.basis != GstBasis::Payments
    {
        return Err(CommandError::invalid(
            "gst_basis_not_supported",
            "We work from bank statements, which don't show invoices that haven't been paid yet, \
             so on the invoice or hybrid basis we couldn't promise the figure isn't too low. \
             Choose the payments basis for now.",
        ));
    }
    let master = acct_store::charts::for_entity_type(tx, SOLE_TRADER)
        .await?
        .ok_or_else(|| {
            CommandError::invalid(
                "no_master_chart",
                "There's no sole-trader master chart yet, so a business can't be set up.",
            )
        })?;
    let chart = master.chart;
    let coding_settings = check_master_chart(&chart)?;
    let rounding_priority: Vec<AccountCode> =
        serde_json::from_str::<Vec<AccountCode>>(ROUNDING_PRIORITY)
            .expect("the default rounding priority list parses")
            .into_iter()
            .filter(|c| chart.get(c).is_some())
            .collect();
    let id = new_id();
    clients::insert(
        tx,
        &Client {
            id: id.clone(),
            name: name.trim().to_owned(),
            entity_type: SOLE_TRADER.to_owned(),
            retained_earnings: code(OWNERS_EQUITY),
            rounding_priority,
            created_seq: seq,
        },
    )
    .await?;
    for account in chart.accounts() {
        clients::insert_account(tx, &id, account).await?;
    }
    bank_store::insert_business(
        tx,
        &Business {
            client_id: id.clone(),
            start_date,
            gst: gst.map(|g| GstSetting {
                registered_from: g.registered_from,
                frequency: g.frequency,
            }),
            holding: HoldingAccounts {
                money_in: code(MONEY_IN),
                money_out: code(MONEY_OUT),
                gst: code(GST),
            },
            capital: code(CAPITAL),
            created_seq: seq,
        },
    )
    .await?;
    acct_store::coding::set_settings(tx, &id, &coding_settings, seq).await?;
    Ok(id)
}

/// Whether a sole-trader master chart can set up a business: it has the fixed accounts
/// (`docs/domain.md`, "Sole-trader chart and template"), active and of the right types, and fits
/// the default coding settings, which it returns.
pub fn check_master_chart(chart: &Chart) -> Result<CodingSettings, CommandError> {
    for (c, want) in [
        (MONEY_IN, AccountType::Income),
        (MONEY_OUT, AccountType::Equity),
        (GST, AccountType::Liability),
        (CAPITAL, AccountType::Equity),
        (OWNERS_EQUITY, AccountType::Equity),
    ] {
        match chart.get(&code(c)) {
            Some(a) if a.account_type == want && a.active => {}
            _ => {
                return Err(CommandError::invalid(
                    "master_chart_incomplete",
                    format!("The sole-trader master chart needs an active {want:?} account {c}."),
                ));
            }
        }
    }
    let coding_settings: CodingSettings =
        serde_json::from_str(DEFAULT_CODING_SETTINGS).expect("the default coding settings parse");
    coding_settings.validate(chart).map_err(|e| {
        CommandError::invalid_with(
            "master_chart_incomplete",
            format!("The sole-trader master chart doesn't fit the default coding settings: {e}."),
            &e,
        )
    })?;
    Ok(coding_settings)
}

pub async fn business(
    tx: &mut SqliteConnection,
    client_id: &str,
) -> Result<Business, CommandError> {
    bank_store::business(tx, client_id).await?.ok_or_else(|| {
        CommandError::invalid(
            "not_a_business",
            "This client isn't set up as a business, so it has no bank statements.",
        )
    })
}

/// Adds a bank account, with its own asset account (600.01, 600.02, ...) in the chart.
pub async fn add_bank_account(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    name: &str,
    account_number: Option<&str>,
) -> Result<BankAccount, CommandError> {
    let number = account_number
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(normalise_account);
    add_account(tx, seq, client_id, AccountKind::Bank, name, number).await
}

/// Adds a credit card, with its own liability account (850.01, 850.02, ...) in the chart.
/// `card_number` is its last four digits or a card number, masked or not; only the masked form,
/// `XXXX-XXXX-XXXX-1234`, is kept.
pub async fn add_card_account(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    name: &str,
    card_number: Option<&str>,
) -> Result<BankAccount, CommandError> {
    let number = match card_number.map(str::trim).filter(|n| !n.is_empty()) {
        None => None,
        Some(n) if n.len() == 4 && n.bytes().all(|b| b.is_ascii_digit()) => {
            Some(format!("XXXX-XXXX-XXXX-{n}"))
        }
        Some(n) => Some(normalise_card(n).ok_or_else(|| {
            CommandError::invalid(
                "invalid_card_number",
                "Give the card's last four digits, or its number as the statement shows it.",
            )
        })?),
    };
    add_account(tx, seq, client_id, AccountKind::CreditCard, name, number).await
}

async fn add_account(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    kind: AccountKind,
    name: &str,
    number: Option<String>,
) -> Result<BankAccount, CommandError> {
    business(tx, client_id).await?;
    let existing = bank_store::bank_accounts(tx, client_id).await?;
    if let Some(n) = &number
        && existing
            .iter()
            .any(|a| a.account_number.as_ref() == Some(n))
    {
        return Err(CommandError::invalid(
            "bank_account_exists",
            format!("Account {n} is already set up."),
        ));
    }
    let chart = clients::chart(tx, client_id).await?;
    let (parent, account_type) = match kind {
        AccountKind::Bank => (BANK_PARENT, AccountType::Asset),
        AccountKind::CreditCard => (CARD_PARENT, AccountType::Liability),
    };
    let account_code = (1..100)
        .map(|i| code(&format!("{parent}.{i:02}")))
        .find(|c| chart.get(c).is_none())
        .ok_or_else(|| {
            CommandError::invalid(
                "too_many_bank_accounts",
                "A business can have 99 bank accounts and 99 cards.",
            )
        })?;
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::invalid(
            "name_required",
            "Give the account a name.",
        ));
    }
    let account = Account {
        code: account_code.clone(),
        name: name.to_owned(),
        account_type,
        active: true,
        default_gst: None,
    };
    chart
        .with_account(account.clone())
        .map_err(|e| CommandError::invalid("invalid_account", e.to_string()))?;
    clients::insert_account(tx, client_id, &account).await?;
    let bank = BankAccount {
        id: new_id(),
        client_id: client_id.to_owned(),
        kind,
        code: account_code,
        name: name.to_owned(),
        account_number: number,
        opening: None,
        opening_journal_id: None,
        created_seq: seq,
    };
    bank_store::insert_bank_account(tx, &bank).await?;
    Ok(bank)
}

/// What an upload did, for the command's response details.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportOutcome {
    pub bank_account_id: String,
    pub lines_added: u32,
    pub already_imported: u32,
    pub before_start: u32,
}

/// The days and balances a parsed statement covers.
pub fn coverage(s: &Statement) -> Option<Coverage> {
    let first = s.lines.iter().map(|l| l.date).min()?;
    let last = s.lines.iter().map(|l| l.date).max()?;
    let start = s
        .period_start
        .or(s.opening.map(|o| o.date))
        .map_or(first, |d| d.min(first));
    let end = s
        .period_end
        .or(s.closing.map(|c| c.date))
        .map_or(last, |d| d.max(last));
    let net: Money = s.lines.iter().map(|l| l.amount).sum();
    let opening = s
        .opening
        .map(|o| o.amount)
        .or_else(|| s.closing.map(|c| c.amount - net))
        .or_else(|| {
            let line = s.lines.first()?;
            line.balance.map(|b| b - line.amount)
        });
    let closing = s.closing.map(|c| c.amount).or(opening.map(|o| o + net));
    Some(Coverage {
        start,
        end,
        opening,
        closing,
    })
}

/// What's wrong with a file, for the upload screen. A file a parser recognised gives one entry per
/// problem: its fields (`code`, `row` and so on) plus `message`, the problem in plain words, which
/// the web app lists under the error. A file nobody recognised keeps its formats, which the
/// error's own message already lists.
fn unreadable_details(e: &StatementError) -> serde_json::Value {
    match e {
        StatementError::Invalid { problems, .. } => problems
            .iter()
            .map(|p| {
                let mut v = serde_json::to_value(p).expect("serialises");
                v["message"] = p.to_string().into();
                v
            })
            .collect(),
        StatementError::NotRecognised { .. } => serde_json::to_value(e).expect("serialises"),
    }
}

/// Parses a statement file, or says in plain words what's wrong with it.
pub(crate) fn read_statement_or_explain(bytes: &[u8]) -> Result<Statement, CommandError> {
    read_statement(bytes).map_err(|e| {
        CommandError::invalid_with(
            "statement_unreadable",
            e.to_string(),
            unreadable_details(&e),
        )
    })
}

/// Uploads one statement file. Every new line posts as its own journal; lines already imported
/// from an overlapping statement are skipped, so uploading the same file twice changes nothing.
#[allow(clippy::too_many_arguments)]
pub async fn import_statement(
    tx: &mut SqliteConnection,
    seq: i64,
    today: NaiveDate,
    client_id: &str,
    file_name: &str,
    bytes: &[u8],
    bank_account_id: Option<&str>,
) -> Result<ImportOutcome, CommandError> {
    let business = business(tx, client_id).await?;
    let statement = read_statement_or_explain(bytes)?;
    let Some(cover) = coverage(&statement) else {
        return Err(CommandError::invalid(
            "statement_empty",
            "That file has no transactions in it.",
        ));
    };
    if let Some(line) = statement.lines.iter().find(|l| l.date > today) {
        return Err(CommandError::invalid_with(
            "line_in_future",
            format!(
                "The file has a line dated {}, which is after today.",
                line.date
            ),
            json!({ "row": line.row, "date": line.date }),
        ));
    }

    // Which bank account: the one named, else the one with this number, else a new one.
    let accounts = bank_store::bank_accounts(tx, client_id).await?;
    let account = match bank_account_id {
        Some(id) => {
            let a = accounts
                .iter()
                .find(|a| a.id == id)
                .cloned()
                .ok_or_else(|| CommandError::not_found("bank account", id))?;
            if let (Some(file), Some(ours)) = (&statement.account, &a.account_number)
                && file != ours
            {
                return Err(CommandError::invalid(
                    "wrong_bank_account",
                    format!("This file is for account {file}, not {ours}."),
                ));
            }
            if a.kind != kind_of(&statement) {
                return Err(CommandError::invalid(
                    "wrong_account_kind",
                    match a.kind {
                        AccountKind::Bank => "This is a credit card statement, so choose a card.",
                        AccountKind::CreditCard => {
                            "This is a bank statement, so choose a bank account."
                        }
                    },
                ));
            }
            a
        }
        None => match &statement.account {
            Some(number) => match accounts
                .iter()
                .find(|a| a.account_number.as_ref() == Some(number))
            {
                Some(a) => a.clone(),
                None => match statement.kind {
                    StatementKind::Bank => {
                        add_bank_account(
                            tx,
                            seq,
                            client_id,
                            &format!("Account {number}"),
                            Some(number),
                        )
                        .await?
                    }
                    StatementKind::CreditCard => {
                        let last4 = number.rsplit('-').next().unwrap_or(number);
                        add_card_account(
                            tx,
                            seq,
                            client_id,
                            &format!("Credit card ending {last4}"),
                            Some(number),
                        )
                        .await?
                    }
                },
            },
            None => {
                return Err(CommandError::invalid(
                    "bank_account_needed",
                    "This file doesn't say which account it's for, so choose one.",
                ));
            }
        },
    };

    // Work out the start date once: the business start, or the first day of the earliest income
    // year with uploaded lines if the business started before it.
    let mut year_list = years::for_client(tx, client_id).await?;
    let start = match year_list.first() {
        Some(first) => first.year.start(),
        None => {
            let earliest = cover.start.max(business.start_date);
            business
                .start_date
                .max(IncomeYear::containing(earliest).start())
        }
    };

    let previous = bank_store::statements(tx, &account.id).await?;
    let covered_before = |d: NaiveDate| {
        previous
            .iter()
            .any(|s| s.start_date <= d && d <= s.end_date)
    };
    let key_account = account.account_number.clone().unwrap_or(account.id.clone());
    let keys = duplicate_keys(&key_account, &statement.lines);
    let mut outcome = ImportOutcome {
        bank_account_id: account.id.clone(),
        ..ImportOutcome::default()
    };
    let mut new_lines = Vec::new();
    for (line, key) in statement.lines.iter().zip(keys) {
        if line.date < start {
            outcome.before_start += 1;
            continue;
        }
        if bank_store::line_exists(
            tx,
            &account.id,
            line.date,
            line.amount,
            &line.description,
            key.occurrence,
        )
        .await?
        {
            outcome.already_imported += 1;
            continue;
        }
        new_lines.push((line, key.occurrence));
    }

    let inside_earlier = previous
        .iter()
        .any(|s| s.start_date <= cover.start && cover.end <= s.end_date);
    if new_lines.is_empty() && inside_earlier {
        // An overlapping statement that adds nothing changes nothing.
        return Ok(outcome);
    }

    let statement_id = new_id();
    bank_store::insert_statement(
        tx,
        &StoredStatement {
            id: statement_id.clone(),
            bank_account_id: account.id.clone(),
            parser: statement.parser.clone(),
            file_name: file_name.trim().to_owned(),
            start_date: cover.start,
            end_date: cover.end,
            opening_balance: cover.opening.map(Money::cents),
            closing_balance: cover.closing.map(Money::cents),
            lines_in_file: i64::try_from(statement.lines.len()).unwrap_or(i64::MAX),
            lines_added: i64::try_from(new_lines.len()).unwrap_or(i64::MAX),
            imported_seq: seq,
        },
    )
    .await?;

    let gst_from = business.gst.map(|g| g.registered_from);
    let mut new_line_ids = BTreeSet::new();
    let mut running_spans = Vec::new();
    for (line, occurrence) in new_lines {
        let year = ensure_year(tx, &mut year_list, seq, client_id, start, line.date).await?;
        let lines = unsorted_lines(
            &account.code,
            line.date,
            line.amount,
            gst_from,
            &business.holding,
        );
        let journal_id = if lines.is_empty() {
            None
        } else {
            Some(
                post(
                    tx,
                    &year,
                    Journal {
                        date: line.date,
                        narration: line.description.clone(),
                        lines,
                    },
                    JournalKind::BankLine,
                    None,
                    seq,
                )
                .await?,
            )
        };
        // A nil line posts nothing but is still recorded, so it isn't imported again.
        let journal_id = match journal_id {
            Some(id) => id,
            None => continue,
        };
        let line_id = new_id();
        new_line_ids.insert(line_id.clone());
        if let Some(span) = line.balance_span {
            running_spans.push((line_id.clone(), span));
        }
        bank_store::insert_bank_line(
            tx,
            &BankLine {
                id: line_id,
                bank_account_id: account.id.clone(),
                statement_id: statement_id.clone(),
                date: line.date,
                amount: line.amount,
                description: line.description.clone(),
                occurrence,
                bank_id: line.bank_id.clone(),
                balance: line.balance,
                journal_id,
                possible_duplicate: covered_before(line.date),
            },
        )
        .await?;
        outcome.lines_added += 1;
    }
    keep_file(
        tx,
        &account.id,
        &statement_id,
        &statement,
        bytes,
        running_spans,
    )
    .await?;

    // The opening balance, the first time a statement reaches back to the start date.
    if account.opening.is_none()
        && cover.start <= start
        && let Some(before) = cover.opening
    {
        let before_start: Money = statement
            .lines
            .iter()
            .filter(|l| l.date < start)
            .map(|l| l.amount)
            .sum();
        set_opening(
            tx,
            &mut year_list,
            seq,
            &business,
            &account,
            start,
            before + before_start,
        )
        .await?;
    }

    let account = bank_store::bank_account(tx, &account.id)
        .await?
        .expect("just used");
    regenerate_gaps(tx, &mut year_list, seq, &business, &account, start).await?;
    // The business's rules code the new lines they match (M11).
    save_tax::apply_rules(tx, seq, client_id, Some(&new_line_ids)).await?;
    Ok(outcome)
}

/// Keeps the uploaded file and where each balance sits in it (M18), as evidence for the owner:
/// the bank's own words beside the books. A card statement's full card number, if the file has
/// one, is masked in the copy kept (`acct_import::bank::kept_copy`); `sha256` is of that copy.
/// The same file uploaded to this account before isn't kept again: this statement points at it. The command's log entry holds
/// only the SHA-256 of the file as it arrived (`Command::logged_payload`).
async fn keep_file(
    tx: &mut SqliteConnection,
    bank_account_id: &str,
    statement_id: &str,
    statement: &Statement,
    bytes: &[u8],
    running_spans: Vec<(String, SourceSpan)>,
) -> Result<(), CommandError> {
    let kept = kept_copy(bytes, statement);
    let sha256 = crate::invoices::sha256_hex(&kept);
    match bank_store::kept_file(tx, bank_account_id, &sha256).await? {
        // Kept already: point at it, and still record this statement's spans, which index the
        // same text, so its stated balances keep their place as checkpoints.
        Some(earlier) => {
            bank_store::insert_statement_file_same_as(tx, statement_id, &earlier).await?;
        }
        None => {
            bank_store::insert_statement_file(
                tx,
                &StatementFile {
                    statement_id: statement_id.to_owned(),
                    sha256,
                    media_type: media_type(&statement.parser).to_owned(),
                    bytes: kept,
                },
            )
            .await?;
        }
    }
    let stated = [
        (BalanceKind::Opening, statement.opening),
        (BalanceKind::Closing, statement.closing),
    ];
    let stated = stated
        .into_iter()
        .filter_map(|(kind, b)| Some((kind, b?.span?)));
    let running = running_spans
        .into_iter()
        .map(|(bank_line_id, span)| (BalanceKind::Running { bank_line_id }, span));
    for (balance, span) in stated.chain(running) {
        bank_store::insert_balance_span(
            tx,
            &BalanceSpan {
                statement_id: statement_id.to_owned(),
                balance,
                span,
            },
        )
        .await?;
    }
    Ok(())
}

/// The media type of a file one of our parsers read, by the parser's family.
pub fn media_type(parser: &str) -> &'static str {
    if parser.starts_with("ofx") {
        "application/x-ofx"
    } else if parser.starts_with("qif") {
        "application/qif"
    } else {
        "text/csv"
    }
}

fn kind_of(statement: &Statement) -> AccountKind {
    match statement.kind {
        StatementKind::Bank => AccountKind::Bank,
        StatementKind::CreditCard => AccountKind::CreditCard,
    }
}

/// Bank vs books for one account on one date (M18): `GET /api/bank-accounts/{id}/proof`, and
/// each part of an upload's [`UploadCheck`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AccountProof {
    pub business_name: String,
    pub bank_account_id: String,
    pub code: String,
    pub name: String,
    pub kind: ReconcileAccountKind,
    pub account_number: Option<String>,
    /// The file the bank's balance comes from, if there is one.
    pub statement_file: Option<String>,
    pub proof: Proof,
    /// What might explain a difference, when the bank gives a balance (M18, Agent 6). A zero
    /// difference still carries the findings that explain nothing, such as a gap the server
    /// filled, for the card's notes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub findings: Option<AccountFindings>,
}

/// What an upload found when it checked itself (M18): Bank vs books at the end of the statement,
/// and at the balance date (31 March) when the statement runs past it. Worked out inside the
/// upload's transaction, after it applied, without writing anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UploadCheck {
    pub bank_account_id: String,
    /// The statement the upload stored; `None` when the file added nothing (it had all been
    /// uploaded before), in which case the check is at the account's latest statement.
    pub statement_id: Option<String>,
    pub at_end: AccountProof,
    pub at_balance_date: Option<AccountProof>,
}

/// The read-only check after `import_statement` applies, for the command's result. `seq` is the
/// upload's; `bank_account_id` the account it touched. `None` if the account has no statements.
pub async fn upload_check(
    conn: &mut SqliteConnection,
    seq: i64,
    bank_account_id: &str,
) -> Result<Option<UploadCheck>, CommandError> {
    let statements = bank_store::statements(conn, bank_account_id).await?;
    let uploaded = statements.iter().find(|s| s.imported_seq == seq);
    let Some(statement) = uploaded.or_else(|| {
        statements
            .iter()
            .max_by_key(|s| (s.end_date, s.imported_seq))
    }) else {
        return Ok(None);
    };
    let at_end = account_proof(
        conn,
        bank_account_id,
        statement.end_date,
        Some(&statement.id),
    )
    .await?;
    // The latest 31 March the statement runs past (one ending on it is `at_end` already).
    let balance_date = IncomeYear::containing(statement.end_date)
        .start()
        .pred_opt()
        .filter(|d| statement.start_date <= *d);
    let at_balance_date = match balance_date {
        Some(d) => Some(account_proof(conn, bank_account_id, d, Some(&statement.id)).await?),
        None => None,
    };
    // Only after an upload, so each file is logged once rather than on every look at the card.
    log_amount_read_wrong(conn, &at_end).await?;
    Ok(Some(UploadCheck {
        bank_account_id: bank_account_id.to_owned(),
        statement_id: uploaded.map(|s| s.id.clone()),
        at_end,
        at_balance_date,
    }))
}

/// Loads an account's statements, lines and ledger, and works out Bank vs books at the end of
/// `date` (`acct_core::reconcile::proof`), preferring `statement`'s closing balance, with what
/// might explain a difference (M18, Agent 6).
///
/// The checkpoints are the suspects' own ([`reconcile::suspect_input`]), so the card and its
/// findings always see the same books. The findings are as at the proof's balance: the suspects
/// look only at the checkpoints up to it, so their difference is the card's.
pub async fn account_proof(
    conn: &mut SqliteConnection,
    bank_account_id: &str,
    date: NaiveDate,
    statement: Option<&str>,
) -> Result<AccountProof, CommandError> {
    let account = bank_store::bank_account(conn, bank_account_id)
        .await?
        .ok_or_else(|| CommandError::not_found("bank account", bank_account_id))?;
    let client = clients::get(conn, &account.client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("business", &account.client_id))?;
    let year_list = years::for_client(conn, &account.client_id).await?;
    let mut all: Vec<StoredJournal> = Vec::new();
    for y in &year_list {
        all.extend(journals::for_year(conn, &y.id).await?);
    }
    let ledger: Vec<LedgerJournal<'_>> = all.iter().map(reconcile::ledger_journal).collect();
    let stored = bank_store::statements(conn, &account.id).await?;
    let mut input = reconcile::suspect_input(conn, &account.client_id, &account.id).await?;
    let facts = reconcile::account_facts(&account);
    let movements = movements(&facts, &ledger);
    let proof = proof(
        date,
        statement,
        &input.checkpoints,
        &movements,
        &account.code,
        account.opening_journal_id.as_deref(),
        &ledger,
    );
    let statement_file = proof.bank.as_ref().and_then(|b| {
        stored
            .iter()
            .find(|s| s.id == b.checkpoint.source.statement_id)
            .map(|s| s.file_name.clone())
    });
    let findings = match &proof.bank {
        Some(bank) => {
            if let Some(i) = input.checkpoints.iter().position(|c| c == &bank.checkpoint) {
                input.checkpoints.truncate(i + 1);
                input.compared.truncate(i + 1);
                input.window = walk(&input.checkpoints, &movements).window;
            }
            let diagnosis = diagnose(&input.window, look_all(&input));
            let has_accountant = tenancy::has_accountant(conn, &account.client_id).await?;
            Some(account_findings(
                &account,
                &input,
                diagnosis,
                has_accountant,
            ))
        }
        None => None,
    };
    Ok(AccountProof {
        business_name: client.name,
        bank_account_id: account.id.clone(),
        code: account.code.to_string(),
        name: account.name.clone(),
        kind: facts.kind,
        account_number: account.account_number.clone(),
        statement_file,
        proof,
        findings,
    })
}

/// What might explain a difference on the card (M18, Agent 6): the diagnosis, with the lines,
/// journals and statements its findings point at, so the card can name them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AccountFindings {
    pub client_id: String,
    pub diagnosis: Diagnosis,
    /// Every bank line a finding points at, by date.
    pub lines: Vec<EvidenceLine>,
    /// Every journal a finding points at, by date.
    pub journals: Vec<EvidenceJournal>,
    /// Every statement a finding points at, and each of `lines`' own, by start date.
    pub statements: Vec<EvidenceStatement>,
    /// The opening balance entered for the account, for a fix that corrects it.
    pub opening: Option<Money>,
    /// An accountant has accepted the owner's invite (M12), so the owner can ask them.
    pub has_accountant: bool,
}

/// A bank line a finding points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EvidenceLine {
    pub bank_line_id: String,
    pub statement_id: String,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub description: String,
    pub amount: Money,
}

/// A journal a finding points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EvidenceJournal {
    pub journal_id: String,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub narration: String,
    /// What it puts on the account: debit +, credit −.
    pub amount: Money,
}

/// A statement a finding points at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct EvidenceStatement {
    pub statement_id: String,
    pub file_name: String,
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    /// What its lines put on the account.
    pub net: Money,
}

fn account_findings(
    account: &BankAccount,
    input: &SuspectInput,
    diagnosis: Diagnosis,
    has_accountant: bool,
) -> AccountFindings {
    let mut line_ids = BTreeSet::new();
    let mut journal_ids = BTreeSet::new();
    let mut statement_ids = BTreeSet::new();
    for f in diagnosis
        .explained_by
        .iter()
        .chain(&diagnosis.other_findings)
    {
        for e in &f.evidence {
            match e {
                EvidenceRef::BankLine { bank_line_id } => {
                    line_ids.insert(bank_line_id.as_str());
                }
                EvidenceRef::Journal { journal_id } => {
                    journal_ids.insert(journal_id.as_str());
                }
                EvidenceRef::Statement { statement_id } => {
                    statement_ids.insert(statement_id.as_str());
                }
                EvidenceRef::Gap { .. } => {}
            }
        }
    }
    let mut lines: Vec<EvidenceLine> = input
        .lines
        .iter()
        .filter(|l| line_ids.contains(l.id.as_str()))
        .map(|l| EvidenceLine {
            bank_line_id: l.id.clone(),
            statement_id: l.statement_id.clone(),
            date: l.date,
            description: l.description.clone(),
            amount: l.amount,
        })
        .collect();
    lines.sort_by(|a, b| (a.date, &a.bank_line_id).cmp(&(b.date, &b.bank_line_id)));
    // The file each line came in, so two copies of one line can be told apart.
    statement_ids.extend(lines.iter().map(|l| l.statement_id.as_str()));
    let mut journals: Vec<EvidenceJournal> = input
        .journals
        .iter()
        .filter(|j| journal_ids.contains(j.id.as_str()))
        .map(|j| EvidenceJournal {
            journal_id: j.id.clone(),
            date: j.date,
            narration: j.narration.clone(),
            amount: j.amount,
        })
        .collect();
    journals.sort_by(|a, b| (a.date, &a.journal_id).cmp(&(b.date, &b.journal_id)));
    let mut statements: Vec<EvidenceStatement> = input
        .statements
        .iter()
        .filter(|s| statement_ids.contains(s.id.as_str()))
        .map(|s| EvidenceStatement {
            statement_id: s.id.clone(),
            file_name: s.file_name.clone(),
            start: s.start,
            end: s.end,
            net: input
                .lines
                .iter()
                .filter(|l| l.statement_id == s.id && l.posts())
                .map(|l| l.amount)
                .sum(),
        })
        .collect();
    statements.sort_by(|a, b| (a.start, &a.statement_id).cmp(&(b.start, &b.statement_id)));
    AccountFindings {
        client_id: account.client_id.clone(),
        diagnosis,
        lines,
        journals,
        statements,
        opening: account.opening.map(|(_, m)| m),
        has_accountant,
    }
}

/// The line the server logs for us when a finding says an amount may have been read wrong (M18,
/// suspect 9): the parser and the row of the file, so we can look at the parser. Never anything
/// from the file itself: no amounts, descriptions or account numbers.
pub fn amount_read_wrong_log(parser: &str, row: Option<u32>) -> String {
    match row {
        Some(row) => format!("reconcile: an amount may be read wrong, parser {parser}, row {row}"),
        None => format!("reconcile: an amount may be read wrong, parser {parser}, row unknown"),
    }
}

/// Logs each Amount read wrong finding on the card (see [`amount_read_wrong_log`]). The row is
/// the file line of the line's running balance, where the file gives one.
async fn log_amount_read_wrong(
    conn: &mut SqliteConnection,
    proof: &AccountProof,
) -> Result<(), CommandError> {
    let Some(findings) = &proof.findings else {
        return Ok(());
    };
    let d = &findings.diagnosis;
    for f in d.explained_by.iter().chain(&d.other_findings) {
        if f.kind != FindingKind::AmountReadWrong {
            continue;
        }
        for e in &f.evidence {
            let EvidenceRef::BankLine { bank_line_id } = e else {
                continue;
            };
            let Some(line) = findings
                .lines
                .iter()
                .find(|l| &l.bank_line_id == bank_line_id)
            else {
                continue;
            };
            let Some(statement) = bank_store::statement(conn, &line.statement_id).await? else {
                continue;
            };
            let running = BalanceKind::Running {
                bank_line_id: bank_line_id.clone(),
            };
            let row = bank_store::balance_spans(conn, &statement.id)
                .await?
                .into_iter()
                .find(|s| s.balance == running)
                .map(|s| s.span.line);
            tracing::warn!("{}", amount_read_wrong_log(&statement.parser, row));
        }
    }
    Ok(())
}

/// `?date=2026-03-31`; without it, the end of the account's latest statement.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProofQuery {
    pub date: Option<NaiveDate>,
}

/// `GET /api/bank-accounts/{id}/proof`. The access layer has already checked the account, as for
/// reading its business (`access::RouteRule::BankAccount`).
pub async fn get_proof(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
    query: Result<Query<ProofQuery>, QueryRejection>,
) -> Result<Json<AccountProof>, CommandError> {
    let Query(q) = query.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let mut conn = state.store.reader().await?;
    let date = match q.date {
        Some(d) => d,
        None => bank_store::statements(&mut conn, &id)
            .await?
            .iter()
            .map(|s| s.end_date)
            .max()
            .ok_or_else(|| {
                CommandError::invalid(
                    "no_statement",
                    "This account has no statements yet, so there's nothing to check.",
                )
            })?,
    };
    Ok(Json(account_proof(&mut conn, &id, date, None).await?))
}

/// Records a bank account's balance on the start date and posts the opening-balance journal, or
/// corrects one already set (M18): the old journal is reversed and the new one posted.
pub async fn set_opening_balance(
    tx: &mut SqliteConnection,
    seq: i64,
    bank_account_id: &str,
    balance: Money,
) -> Result<String, CommandError> {
    let account = bank_store::bank_account(tx, bank_account_id)
        .await?
        .ok_or_else(|| CommandError::not_found("bank account", bank_account_id))?;
    let business = business(tx, &account.client_id).await?;
    let mut year_list = years::for_client(tx, &account.client_id).await?;
    let start = year_list
        .first()
        .map_or(business.start_date, |y| y.year.start());
    // A correction (M18): reverse the old opening journal, then post the new one on the same
    // date. Reversing refuses a finalised year, so a signed-off year keeps its opening balance.
    let date = match account.opening {
        Some((date, old)) => {
            if old == balance {
                return Err(CommandError::invalid(
                    "opening_balance_same",
                    "That's the opening balance already.",
                ));
            }
            if let Some(journal_id) = &account.opening_journal_id {
                save_tax::reverse(tx, seq, journal_id).await?;
            }
            date
        }
        None => start,
    };
    set_opening(tx, &mut year_list, seq, &business, &account, date, balance).await?;
    let account = bank_store::bank_account(tx, &account.id)
        .await?
        .expect("just used");
    regenerate_gaps(tx, &mut year_list, seq, &business, &account, start).await?;
    Ok(account.client_id)
}

/// `remove_statement` (M18): takes an uploaded statement out. Each of its lines' live journals is
/// reversed (so posted journals never change), then the statement, its lines and its kept file are
/// deleted (`bank_store::delete_statement`), and the account's gap journals are brought in line
/// with what's left. Returns the business's id.
///
/// Refused when one of its lines is half of a confirmed transfer or bought an asset: undoing
/// those touches another line or the asset register, so the owner sorts that line another way
/// first. Reversing refuses a finalised year, so a signed-off year keeps its lines.
pub async fn remove_statement(
    tx: &mut SqliteConnection,
    seq: i64,
    statement_id: &str,
) -> Result<String, CommandError> {
    let statement = bank_store::statement(tx, statement_id)
        .await?
        .ok_or_else(|| CommandError::not_found("statement", statement_id))?;
    let account = bank_store::bank_account(tx, &statement.bank_account_id)
        .await?
        .ok_or_else(|| CommandError::not_found("bank account", &statement.bank_account_id))?;
    let business = business(tx, &account.client_id).await?;
    let lines: Vec<BankLine> = bank_store::bank_lines(tx, &account.client_id)
        .await?
        .into_iter()
        .filter(|l| l.statement_id == statement.id)
        .collect();
    let states: BTreeMap<String, LineState> = coding_store::line_states(tx, &account.client_id)
        .await?
        .into_iter()
        .map(|s| (s.bank_line_id.clone(), s))
        .collect();
    let live: BTreeSet<&str> = lines
        .iter()
        .filter_map(|l| reconcile::line_facts(l, states.get(&l.id)).journal_id)
        .collect();
    // The lock first, so a finalised year is the reason given whatever else is in the way.
    for journal_id in &live {
        let j = journals::get(tx, journal_id)
            .await?
            .ok_or_else(|| CommandError::not_found("journal", journal_id))?;
        open_year(tx, &j.client_year_id).await?;
    }
    for l in &lines {
        let Some(state) = states.get(&l.id) else {
            continue;
        };
        let what = format!(
            "{} on {} ({})",
            l.description.trim(),
            l.date,
            crate::history::dollars(l.amount)
        );
        if state.pair_line_id.is_some() {
            return Err(CommandError::invalid_with(
                "statement_line_in_transfer",
                format!(
                    "{what} is half of a transfer you confirmed. Sort it another way first, \
                     then remove the statement."
                ),
                json!({ "bank_line_id": l.id }),
            ));
        }
        if state.asset_id.is_some() {
            return Err(CommandError::invalid_with(
                "statement_line_bought_asset",
                format!(
                    "{what} added an asset to the register. Sort it another way first, then \
                     remove the statement."
                ),
                json!({ "bank_line_id": l.id }),
            ));
        }
    }
    for journal_id in live {
        save_tax::reverse(tx, seq, journal_id).await?;
    }
    bank_store::delete_statement(tx, &statement.id).await?;

    let mut year_list = years::for_client(tx, &account.client_id).await?;
    let start = year_list
        .first()
        .map_or(business.start_date, |y| y.year.start());
    regenerate_gaps(tx, &mut year_list, seq, &business, &account, start).await?;
    Ok(account.client_id)
}

async fn set_opening(
    tx: &mut SqliteConnection,
    year_list: &mut Vec<StoredYear>,
    seq: i64,
    business: &Business,
    account: &BankAccount,
    start: NaiveDate,
    balance: Money,
) -> Result<(), CommandError> {
    let year = ensure_year(tx, year_list, seq, &account.client_id, start, start).await?;
    // Capital if the business started in this year, owner's equity if it started earlier.
    let credit = if business.start_date >= year.year.start() {
        business.capital.clone()
    } else {
        code(OWNERS_EQUITY)
    };
    let journal_id = if balance.is_zero() {
        None
    } else {
        Some(
            post(
                tx,
                &year,
                Journal {
                    date: start,
                    narration: format!("Opening balance: {}", account.name),
                    lines: vec![
                        JournalLine {
                            account: account.code.clone(),
                            amount: balance,
                        },
                        JournalLine {
                            account: credit,
                            amount: -balance,
                        },
                    ],
                },
                JournalKind::BankOpening,
                None,
                seq,
            )
            .await?,
        )
    };
    bank_store::set_opening(tx, &account.id, start, balance, journal_id.as_deref()).await?;
    Ok(())
}

/// A bank account's gaps, from its statements.
pub async fn account_gaps(
    tx: &mut SqliteConnection,
    account: &BankAccount,
    start: NaiveDate,
) -> Result<Vec<Gap>, CommandError> {
    let statements = bank_store::statements(tx, &account.id).await?;
    let covers: Vec<Coverage> = statements
        .iter()
        .map(|s| Coverage {
            start: s.start_date,
            end: s.end_date,
            opening: s.opening_balance.map(Money::from_cents),
            closing: s.closing_balance.map(Money::from_cents),
        })
        .collect();
    let opening = account.opening.map(|(_, m)| m);
    Ok(gaps(start, opening, &covers))
}

/// Brings the account's gap journals in line with its gaps: if anything changed, reverses the
/// live ones and posts one per gap with a known change. Unchanged gaps post nothing.
async fn regenerate_gaps(
    tx: &mut SqliteConnection,
    year_list: &mut Vec<StoredYear>,
    seq: i64,
    business: &Business,
    account: &BankAccount,
    start: NaiveDate,
) -> Result<(), CommandError> {
    let wanted: Vec<(Gap, Money)> = account_gaps(tx, account, start)
        .await?
        .into_iter()
        .filter_map(|g| g.change.filter(|c| !c.is_zero()).map(|c| (g, c)))
        .collect();
    let live = bank_store::live_gap_journals(tx, &account.id).await?;
    let mut live_amounts = Vec::new();
    for g in &live {
        let j = journals::get(tx, &g.journal_id)
            .await?
            .expect("gap journals exist");
        let on_bank: Money = j
            .journal
            .lines
            .iter()
            .filter(|l| l.account == account.code)
            .map(|l| l.amount)
            .sum();
        live_amounts.push((g.start_date, g.end_date, on_bank, j));
    }
    let gst_from = business.gst.map(|g| g.registered_from);
    // The same gaps, posted the same way: a change of GST registration (M20) reposts them.
    let same = live_amounts.len() == wanted.len()
        && live_amounts
            .iter()
            .zip(&wanted)
            .all(|((s, e, m, j), (g, c))| {
                *s == g.start
                    && *e == g.end
                    && m == c
                    && j.journal.lines
                        == unsorted_lines(&account.code, g.end, *c, gst_from, &business.holding)
            });
    if same {
        return Ok(());
    }
    for (_, _, _, j) in live_amounts {
        let year = open_year(tx, &j.client_year_id).await?;
        post(
            tx,
            &year,
            Journal {
                date: j.journal.date,
                narration: format!("Reversal of: {}", j.journal.narration),
                lines: j
                    .journal
                    .lines
                    .iter()
                    .map(|l| JournalLine {
                        account: l.account.clone(),
                        amount: -l.amount,
                    })
                    .collect(),
            },
            JournalKind::BankGap,
            Some(j.id.clone()),
            seq,
        )
        .await?;
    }
    for (gap, change) in wanted {
        let year = ensure_year(tx, year_list, seq, &account.client_id, start, gap.end).await?;
        let lines = unsorted_lines(&account.code, gap.end, change, gst_from, &business.holding);
        let journal_id = post(
            tx,
            &year,
            Journal {
                date: gap.end,
                narration: format!(
                    "No statement from {} to {}: change in balance, {}",
                    gap.start, gap.end, account.name
                ),
                lines,
            },
            JournalKind::BankGap,
            None,
            seq,
        )
        .await?;
        bank_store::insert_gap_journal(
            tx,
            &GapJournal {
                journal_id,
                bank_account_id: account.id.clone(),
                start_date: gap.start,
                end_date: gap.end,
            },
        )
        .await?;
    }
    Ok(())
}

/// Brings every account's gap journals in line with the business as it is now: after its GST
/// registration changes (M20), so a gap's rise in balance is split for GST, or not, as the lines
/// are.
pub(crate) async fn regenerate_all_gaps(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
) -> Result<(), CommandError> {
    let business = business(tx, client_id).await?;
    let mut year_list = years::for_client(tx, client_id).await?;
    let Some(start) = year_list.first().map(|y| y.year.start()) else {
        return Ok(());
    };
    for account in bank_store::bank_accounts(tx, client_id).await? {
        regenerate_gaps(tx, &mut year_list, seq, &business, &account, start).await?;
    }
    Ok(())
}

/// The open, bank-coded client-year containing `date`, creating it and any years before it.
/// Years run 1 April to 31 March; the first starts on `start`.
async fn ensure_year(
    tx: &mut SqliteConnection,
    year_list: &mut Vec<StoredYear>,
    seq: i64,
    client_id: &str,
    start: NaiveDate,
    date: NaiveDate,
) -> Result<StoredYear, CommandError> {
    loop {
        if let Some(y) = year_list.iter().find(|y| y.year.contains(date)) {
            let y = y.clone();
            if y.status == YearStatus::Finalised {
                return Err(CommandError::invalid(
                    "year_finalised",
                    format!(
                        "The year ending {} is finalised, so its numbers can't change.",
                        y.year.end()
                    ),
                ));
            }
            match y.books_source {
                Some(BooksSource::BankCoding) => {}
                Some(BooksSource::TbImport) => {
                    return Err(CommandError::invalid(
                        "books_from_tb_import",
                        "That year's books come from a trial balance import, so bank lines \
                         would count twice.",
                    ));
                }
                None => years::set_books_source(tx, &y.id, BooksSource::BankCoding).await?,
            }
            return Ok(y);
        }
        let next_start = year_list
            .last()
            .map_or(start, |y| y.year.end().succ_opt().expect("a next day"));
        if date < start || next_start > date {
            return Err(CommandError::invalid(
                "before_start",
                format!("{date} is before the business's start date, {start}."),
            ));
        }
        let end = IncomeYear::containing(next_start).end();
        let (template_version_id, mapping_version_id) = match year_list.last() {
            Some(prior) => (
                prior.template_version_id.clone(),
                prior.mapping_version_id.clone(),
            ),
            None => pin_sole_trader(tx).await?,
        };
        let year = StoredYear {
            id: new_id(),
            client_id: client_id.to_owned(),
            year: ClientYear::new(next_start, end).expect("ends after it starts"),
            template_version_id,
            mapping_version_id,
            books_source: Some(BooksSource::BankCoding),
            status: YearStatus::Open,
            created_seq: seq,
        };
        years::insert(tx, &year).await?;
        year_list.push(year);
    }
}

/// The latest versions of the only sole-trader mapping and its template.
async fn pin_sole_trader(tx: &mut SqliteConnection) -> Result<(String, String), CommandError> {
    let mappings = templates::mappings_for_entity_type(tx, SOLE_TRADER).await?;
    let [mapping] = mappings.as_slice() else {
        return Err(CommandError::invalid(
            "mapping_required",
            format!(
                "There are {} sole-trader mappings, and a business needs exactly one.",
                mappings.len()
            ),
        ));
    };
    let template = templates::latest_template_version(tx, &mapping.template_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template", &mapping.template_id))?;
    let version = templates::latest_mapping_version(tx, &mapping.id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping", &mapping.id))?;
    Ok((template.id, version.id))
}

pub(crate) async fn open_year(
    tx: &mut SqliteConnection,
    id: &str,
) -> Result<StoredYear, CommandError> {
    let year = years::get(tx, id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", id))?;
    if year.status == YearStatus::Finalised {
        return Err(CommandError::invalid(
            "year_finalised",
            "This year is finalised, so its numbers can't change.",
        ));
    }
    Ok(year)
}

/// Validates and posts a journal; returns its id.
pub(crate) async fn post(
    tx: &mut SqliteConnection,
    year: &StoredYear,
    journal: Journal,
    kind: JournalKind,
    reverses_journal_id: Option<String>,
    seq: i64,
) -> Result<String, CommandError> {
    crate::finalise::ensure_open(tx, &year.id).await?;
    let chart = clients::chart(tx, &year.client_id).await?;
    journal.validate(&chart, &year.year).map_err(|errors| {
        CommandError::invalid_with("invalid_journal", "The journal has problems.", errors)
    })?;
    let id = new_id();
    journals::insert(
        tx,
        &StoredJournal {
            id: id.clone(),
            client_year_id: year.id.clone(),
            kind,
            reverses_journal_id,
            posted_seq: seq,
            journal,
        },
    )
    .await?;
    Ok(id)
}

/// Decodes standard base64 (with or without padding), as the browser sends file contents.
pub fn decode_base64(s: &str) -> Option<Vec<u8>> {
    fn value(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let clean: Vec<u8> = s.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    let body = clean
        .strip_suffix(b"==")
        .or_else(|| clean.strip_suffix(b"="))
        .unwrap_or(&clean);
    if body.len() % 4 == 1 {
        return None;
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c)? << (18 - 6 * i);
        }
        let bytes = n.to_be_bytes();
        out.extend_from_slice(&bytes[1..chunk.len()]);
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64("aGVsbG8").unwrap(), b"hello");
        assert_eq!(decode_base64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_base64("YQ==").unwrap(), b"a");
        assert_eq!(decode_base64("").unwrap(), b"");
        assert!(decode_base64("a").is_none());
        assert!(decode_base64("a*bc").is_none());
    }
}
