//! Businesses and their bank statements (M10): setting a business up, adding bank accounts, and
//! uploading statements, which post every line to the ledger straight away.
//!
//! The rules are in `docs/domain.md` under "Bank statements to the ledger". Core does the
//! arithmetic (`acct_core::bank`); this module decides which journals to post and keeps the
//! store's record of where they came from.

use acct_core::bank::{Coverage, Gap, HoldingAccounts, gaps, unsorted_lines};
use acct_core::tax::gst::GstFrequency;
use acct_core::tax::income_tax::IncomeYear;
use acct_core::{Account, AccountCode, AccountType, ClientYear, Journal, JournalLine, Money};
use acct_import::bank::{Statement, duplicate_keys, normalise_account, read_statement};
use acct_store::bank::{
    self as bank_store, BankAccount, BankLine, Business, GapJournal, GstSetting, StoredStatement,
};
use acct_store::clients::Client;
use acct_store::journals::{JournalKind, StoredJournal};
use acct_store::years::{BooksSource, StoredYear, YearStatus};
use acct_store::{SqliteConnection, clients, journals, new_id, templates, years};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use crate::error::CommandError;

/// The entity type M10 sets businesses up as.
pub const SOLE_TRADER: &str = "sole_trader";

/// The sole-trader chart's fixed accounts (`docs/domain.md`, "Sole-trader chart and template").
const MONEY_IN: &str = "140";
const MONEY_OUT: &str = "965";
const GST: &str = "810";
const CAPITAL: &str = "950";
const OWNERS_EQUITY: &str = "970";
const BANK_PARENT: &str = "600";
/// The default rounding priority list for sole traders.
const ROUNDING_PRIORITY: &[&str] = &["290", "205", "120", "960", "810"];

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
    let rounding_priority: Vec<AccountCode> = ROUNDING_PRIORITY
        .iter()
        .map(|c| code(c))
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
    Ok(id)
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
    business(tx, client_id).await?;
    let number = account_number
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(normalise_account);
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
    let account_code = (1..100)
        .map(|i| code(&format!("{BANK_PARENT}.{i:02}")))
        .find(|c| chart.get(c).is_none())
        .ok_or_else(|| {
            CommandError::invalid(
                "too_many_bank_accounts",
                "A business can have 99 bank accounts.",
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
        account_type: AccountType::Asset,
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
    let statement = read_statement(bytes).map_err(|e| {
        CommandError::invalid_with(
            "statement_unreadable",
            e.to_string(),
            serde_json::to_value(&e).expect("serialises"),
        )
    })?;
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
            a
        }
        None => match &statement.account {
            Some(number) => match accounts
                .iter()
                .find(|a| a.account_number.as_ref() == Some(number))
            {
                Some(a) => a.clone(),
                None => {
                    add_bank_account(
                        tx,
                        seq,
                        client_id,
                        &format!("Account {number}"),
                        Some(number),
                    )
                    .await?
                }
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
        bank_store::insert_bank_line(
            tx,
            &BankLine {
                id: new_id(),
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
    Ok(outcome)
}

/// Records a bank account's balance on the start date and posts the opening-balance journal.
pub async fn set_opening_balance(
    tx: &mut SqliteConnection,
    seq: i64,
    bank_account_id: &str,
    balance: Money,
) -> Result<String, CommandError> {
    let account = bank_store::bank_account(tx, bank_account_id)
        .await?
        .ok_or_else(|| CommandError::not_found("bank account", bank_account_id))?;
    if account.opening.is_some() {
        return Err(CommandError::invalid(
            "opening_balance_set",
            "This account's opening balance is already set.",
        ));
    }
    let business = business(tx, &account.client_id).await?;
    let mut year_list = years::for_client(tx, &account.client_id).await?;
    let start = year_list
        .first()
        .map_or(business.start_date, |y| y.year.start());
    set_opening(tx, &mut year_list, seq, &business, &account, start, balance).await?;
    let account = bank_store::bank_account(tx, &account.id)
        .await?
        .expect("just used");
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
    let same = live_amounts.len() == wanted.len()
        && live_amounts
            .iter()
            .zip(&wanted)
            .all(|((s, e, m, _), (g, c))| *s == g.start && *e == g.end && m == c);
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
    let gst_from = business.gst.map(|g| g.registered_from);
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

async fn open_year(tx: &mut SqliteConnection, id: &str) -> Result<StoredYear, CommandError> {
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
async fn post(
    tx: &mut SqliteConnection,
    year: &StoredYear,
    journal: Journal,
    kind: JournalKind,
    reverses_journal_id: Option<String>,
    seq: i64,
) -> Result<String, CommandError> {
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
