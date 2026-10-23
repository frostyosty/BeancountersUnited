//! Save tax (M11): coding bank lines, rules, the owner's answers, and the queue of cards that
//! brings "Tax to pay if submitted" down.
//!
//! Every recode reverses the line's live journal and posts the new one inside the command, so
//! posted journals never change (`docs/domain.md`, "Bank statements to the ledger"). Core works
//! out every posting (`acct_core::coding`) and every figure and saving (`acct_core::tax`); this
//! module decides what to post and keeps the record of how each line is sorted.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use acct_core::bank::{LineFacts, looks_like_ird, transfer_pairs, unsorted_lines};
use acct_core::coding::{
    self, BankLine as CoreLine, Coding, CodingContext, CodingSettings, DepositCoding, Direction,
    Rule, SUPPLY_INFO_THRESHOLD, WithdrawalCoding, best_rule, coded_lines, from_history,
    from_merchants, gst_totals, taxable_income_of,
};
use acct_core::tax::gst::{GstTotals, gst_period};
use acct_core::tax::income_tax::{IETC_FROM, IETC_TO, IncomeYear, OtherIncome, YearAnswers};
use acct_core::tax::position::{Change, TaxInputs, position};
use acct_core::{AccountCode, AccountType, Chart, GstCode, Journal, JournalLine, Money};
use acct_store::assets as asset_store;
use acct_store::bank::{self as bank_store, BankAccount, BankLine, Business};
use acct_store::coding::{self as coding_store, LineState, LineStateKind};
use acct_store::journals::{JournalKind, StoredJournal};
use acct_store::years::{StoredYear, YearStatus};
use acct_store::{SqliteConnection, clients, journals, new_id, years};
use chrono::NaiveDate;
use serde::Serialize;
use ts_rs::TS;

use crate::assets;
use crate::business;
use crate::commands::{Answer, IrdPayment, LineCoding};
use crate::error::CommandError;
use crate::pipeline::{self, NewAsset};

/// A business with what coding needs: its chart, coding settings and bank and card accounts.
pub(crate) struct Books {
    pub client_id: String,
    pub entity_type: String,
    pub business: Business,
    pub chart: Chart,
    pub settings: CodingSettings,
    pub accounts: Vec<BankAccount>,
}

impl Books {
    fn context(&self) -> CodingContext<'_> {
        CodingContext {
            chart: &self.chart,
            settings: &self.settings,
            gst_registered_from: self.gst_from(),
        }
    }

    fn gst_from(&self) -> Option<NaiveDate> {
        self.business.gst.map(|g| g.registered_from)
    }
}

pub(crate) async fn books(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Books, CommandError> {
    let business = business::business(conn, client_id).await?;
    let client = clients::get(conn, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", client_id))?;
    let chart = clients::chart(conn, client_id).await?;
    let settings = coding_store::settings(conn, client_id)
        .await?
        .ok_or_else(|| {
            CommandError::invalid(
                "no_coding_settings",
                "This business has no coding settings yet.",
            )
        })?;
    let accounts = bank_store::bank_accounts(conn, client_id).await?;
    Ok(Books {
        client_id: client_id.to_owned(),
        entity_type: client.entity_type,
        business,
        chart,
        settings,
        accounts,
    })
}

/// A bank line and how it's sorted now.
#[derive(Debug, Clone)]
pub(crate) struct LineInfo {
    pub line: BankLine,
    pub account: BankAccount,
    pub state: LineState,
    /// When the owner confirmed they hold the supplier's taxable supply information.
    pub confirmed: Option<NaiveDate>,
    /// The owner's answer to "is this a duplicate?", if asked.
    pub duplicate_answer: Option<bool>,
}

impl LineInfo {
    fn core(&self) -> CoreLine<'_> {
        CoreLine {
            bank: &self.account.code,
            date: self.line.date,
            amount: self.line.amount,
        }
    }

    fn posting(&self) -> Posting {
        match (self.state.state, &self.state.coding) {
            (LineStateKind::Coded, Some(c)) => Posting::Coded(c.clone()),
            (LineStateKind::Duplicate, _) => Posting::Nothing,
            _ => Posting::Unsorted,
        }
    }

    fn is_unsorted(&self) -> bool {
        self.state.state == LineStateKind::Unsorted
    }

    fn view(&self) -> CardLine {
        CardLine {
            bank_line_id: self.line.id.clone(),
            bank_account_id: self.account.id.clone(),
            account_name: self.account.name.clone(),
            date: self.line.date,
            amount: self.line.amount,
            description: self.line.description.clone(),
        }
    }
}

/// What a line posts.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Posting {
    /// As imported: money in as income, money out as not yet sorted.
    Unsorted,
    Coded(Coding),
    /// A duplicate: nothing.
    Nothing,
}

/// Every line of a business, by date then account.
async fn load_lines(
    conn: &mut SqliteConnection,
    books: &Books,
) -> Result<Vec<LineInfo>, CommandError> {
    let lines = bank_store::bank_lines(conn, &books.client_id).await?;
    let mut states: HashMap<String, LineState> = coding_store::line_states(conn, &books.client_id)
        .await?
        .into_iter()
        .map(|s| (s.bank_line_id.clone(), s))
        .collect();
    let confirmed: HashMap<String, NaiveDate> = coding_store::supply_info(conn, &books.client_id)
        .await?
        .into_iter()
        .collect();
    let duplicates: HashMap<String, bool> = coding_store::duplicate_answers(conn, &books.client_id)
        .await?
        .into_iter()
        .collect();
    let accounts: HashMap<&str, &BankAccount> =
        books.accounts.iter().map(|a| (a.id.as_str(), a)).collect();
    Ok(lines
        .into_iter()
        .map(|line| {
            let state = states.remove(&line.id).unwrap_or_else(|| LineState {
                bank_line_id: line.id.clone(),
                state: LineStateKind::Unsorted,
                coding: None,
                journal_id: Some(line.journal_id.clone()),
                rule_id: None,
                pair_line_id: None,
                ird_income_year: None,
                asset_id: None,
                updated_seq: 0,
            });
            LineInfo {
                account: (*accounts
                    .get(line.bank_account_id.as_str())
                    .expect("every line's account is the business's"))
                .clone(),
                confirmed: confirmed.get(&line.id).copied(),
                duplicate_answer: duplicates.get(&line.id).copied(),
                state,
                line,
            }
        })
        .collect())
}

/// One line of a business, checked to belong to it.
async fn load_line(
    conn: &mut SqliteConnection,
    books: &Books,
    bank_line_id: &str,
) -> Result<LineInfo, CommandError> {
    load_lines(conn, books)
        .await?
        .into_iter()
        .find(|l| l.line.id == bank_line_id)
        .ok_or_else(|| CommandError::not_found("bank line", bank_line_id))
}

/// The business a line belongs to.
async fn books_for_line(
    conn: &mut SqliteConnection,
    bank_line_id: &str,
) -> Result<Books, CommandError> {
    let line = bank_store::bank_line(conn, bank_line_id)
        .await?
        .ok_or_else(|| CommandError::not_found("bank line", bank_line_id))?;
    let account = bank_store::bank_account(conn, &line.bank_account_id)
        .await?
        .ok_or_else(|| CommandError::not_found("bank account", &line.bank_account_id))?;
    books(conn, &account.client_id).await
}

fn coding_error(e: coding::CodingError) -> CommandError {
    let mut message = e.to_string();
    if let Some(first) = message.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    CommandError::invalid_with("invalid_coding", format!("{message}."), &e)
}

/// The journal lines a line would post.
fn posting_lines(
    books: &Books,
    info: &LineInfo,
    posting: &Posting,
    confirmed: Option<NaiveDate>,
) -> Result<Vec<JournalLine>, CommandError> {
    match posting {
        Posting::Unsorted => Ok(unsorted_lines(
            &info.account.code,
            info.line.date,
            info.line.amount,
            books.gst_from(),
            &books.business.holding,
        )),
        Posting::Coded(c) => {
            coded_lines(&info.core(), c, confirmed, &books.context()).map_err(coding_error)
        }
        Posting::Nothing => Ok(Vec::new()),
    }
}

/// The open year containing `date`.
async fn line_year(
    tx: &mut SqliteConnection,
    client_id: &str,
    date: NaiveDate,
) -> Result<StoredYear, CommandError> {
    let year = years::for_client(tx, client_id)
        .await?
        .into_iter()
        .find(|y| y.year.contains(date))
        .ok_or_else(|| {
            CommandError::invalid(
                "no_year_for_date",
                format!("The business has no year containing {date}."),
            )
        })?;
    business::open_year(tx, &year.id).await
}

/// Posts the reversal of a journal, in the journal's own year.
async fn reverse(
    tx: &mut SqliteConnection,
    seq: i64,
    journal_id: &str,
) -> Result<(), CommandError> {
    let original = journals::get(tx, journal_id)
        .await?
        .ok_or_else(|| CommandError::not_found("journal", journal_id))?;
    let year = business::open_year(tx, &original.client_year_id).await?;
    business::post(
        tx,
        &year,
        Journal {
            date: original.journal.date,
            narration: format!("Reversal of: {}", original.journal.narration),
            lines: original
                .journal
                .lines
                .iter()
                .map(|l| JournalLine {
                    account: l.account.clone(),
                    amount: -l.amount,
                })
                .collect(),
        },
        original.kind,
        Some(original.id.clone()),
        seq,
    )
    .await?;
    Ok(())
}

/// Posts `lines` for a line, dated its date; `None` if there are none.
async fn post_line(
    tx: &mut SqliteConnection,
    seq: i64,
    books: &Books,
    info: &LineInfo,
    narration: String,
    lines: Vec<JournalLine>,
) -> Result<Option<String>, CommandError> {
    if lines.is_empty() {
        return Ok(None);
    }
    let year = line_year(tx, &books.client_id, info.line.date).await?;
    let id = business::post(
        tx,
        &year,
        Journal {
            date: info.line.date,
            narration,
            lines,
        },
        JournalKind::BankLine,
        None,
        seq,
    )
    .await?;
    Ok(Some(id))
}

/// Takes a line's current posting out of the ledger: reverses its live journal, and if it was one
/// side of a confirmed transfer, puts the other side back to unsorted. Removes the asset an asset
/// purchase added, unless `keep_asset`.
async fn release(
    tx: &mut SqliteConnection,
    seq: i64,
    books: &Books,
    info: &LineInfo,
    keep_asset: bool,
) -> Result<(), CommandError> {
    if let Some(journal_id) = &info.state.journal_id {
        reverse(tx, seq, journal_id).await?;
    }
    if let Some(partner_id) = &info.state.pair_line_id {
        let partner = load_line(tx, books, partner_id).await?;
        let lines = posting_lines(books, &partner, &Posting::Unsorted, None)?;
        let journal_id = post_line(
            tx,
            seq,
            books,
            &partner,
            partner.line.description.clone(),
            lines,
        )
        .await?;
        coding_store::set_line_state(
            tx,
            &LineState {
                bank_line_id: partner.line.id.clone(),
                state: LineStateKind::Unsorted,
                coding: None,
                journal_id,
                rule_id: None,
                pair_line_id: None,
                ird_income_year: None,
                asset_id: None,
                updated_seq: seq,
            },
        )
        .await?;
    }
    if !keep_asset && let Some(asset_id) = &info.state.asset_id {
        pipeline::delete_asset(tx, asset_id).await?;
    }
    Ok(())
}

/// What a line should post next, and why.
struct Target {
    posting: Posting,
    rule_id: Option<String>,
    ird_income_year: Option<IncomeYear>,
    asset_class_id: Option<String>,
}

impl Target {
    fn posting(posting: Posting) -> Target {
        Target {
            posting,
            rule_id: None,
            ird_income_year: None,
            asset_class_id: None,
        }
    }
}

/// The asset class an asset purchase to `cost_account` goes into: `wanted` if given, else the
/// only class (as the client resolves it) whose cost account that is.
async fn asset_class_for(
    tx: &mut SqliteConnection,
    books: &Books,
    cost_account: &AccountCode,
    wanted: Option<&str>,
) -> Result<String, CommandError> {
    let overrides = asset_store::overrides_for_client(tx, &books.client_id).await?;
    let candidates: Vec<String> = asset_store::classes_for_entity_type(tx, &books.entity_type)
        .await?
        .into_iter()
        .filter(|c| {
            let over = overrides.iter().find(|o| o.class_id == c.id);
            assets::resolve(c, over).accounts.cost == *cost_account
        })
        .map(|c| c.id)
        .collect();
    match (wanted, candidates.as_slice()) {
        (Some(w), _) if candidates.iter().any(|c| c == w) => Ok(w.to_owned()),
        (Some(w), _) => Err(CommandError::invalid(
            "wrong_asset_class",
            format!("Asset class {w} doesn't use account {cost_account} for cost."),
        )),
        (None, [only]) => Ok(only.clone()),
        (None, []) => Err(CommandError::invalid(
            "no_asset_class",
            format!("No asset class uses account {cost_account} for cost."),
        )),
        (None, _) => Err(CommandError::invalid(
            "asset_class_required",
            format!("More than one asset class uses account {cost_account}, so choose one."),
        )),
    }
}

/// Makes a line post `target`. Everything that can be refused is checked before anything is
/// written. A target that posts what the line already posts writes nothing new to the ledger.
async fn set_posting(
    tx: &mut SqliteConnection,
    seq: i64,
    books: &Books,
    info: &LineInfo,
    target: Target,
) -> Result<(), CommandError> {
    line_year(tx, &books.client_id, info.line.date).await?;
    let new_lines = posting_lines(books, info, &target.posting, info.confirmed)?;
    let (kind, coding) = match &target.posting {
        Posting::Unsorted => (LineStateKind::Unsorted, None),
        Posting::Coded(c) => (LineStateKind::Coded, Some(c.clone())),
        Posting::Nothing => (LineStateKind::Duplicate, None),
    };
    let asset_class = match &coding {
        Some(Coding::Out(WithdrawalCoding::AssetPurchase { account, .. })) => Some((
            account.clone(),
            asset_class_for(tx, books, account, target.asset_class_id.as_deref()).await?,
        )),
        _ => None,
    };

    let same_coding = info.state.state == kind && info.state.coding == coding;
    let live_lines = match &info.state.journal_id {
        Some(id) => journals::get(tx, id)
            .await?
            .map(|j| j.journal.lines)
            .unwrap_or_default(),
        None => Vec::new(),
    };
    let keep_asset = same_coding && info.state.asset_id.is_some();
    let (journal_id, asset_id) =
        if same_coding && info.state.pair_line_id.is_none() && live_lines == new_lines {
            // Nothing to repost: only why it's coded may have changed.
            (info.state.journal_id.clone(), info.state.asset_id.clone())
        } else {
            release(tx, seq, books, info, keep_asset).await?;
            let journal_id = post_line(
                tx,
                seq,
                books,
                info,
                info.line.description.clone(),
                new_lines.clone(),
            )
            .await?;
            let asset_id = match (&asset_class, keep_asset) {
                (Some(_), true) => info.state.asset_id.clone(),
                (Some((account, class_id)), false) => {
                    let cost: Money = new_lines
                        .iter()
                        .filter(|l| l.account == *account)
                        .map(|l| l.amount)
                        .sum();
                    let name = match info.line.description.trim() {
                        "" => format!("Bought {}", info.line.date),
                        d => d.to_owned(),
                    };
                    Some(
                        pipeline::create_asset(
                            tx,
                            seq,
                            NewAsset {
                                client_id: &books.client_id,
                                class_id,
                                name: &name,
                                cost,
                                residual: Money::ZERO,
                                acquired: info.line.date,
                                settings: None,
                                opening: None,
                            },
                        )
                        .await?,
                    )
                }
                (None, _) => None,
            };
            (journal_id, asset_id)
        };
    if kind != LineStateKind::Unsorted {
        // Sorted some other way than an AI suggestion still waiting (ADR 009, "Retention").
        acct_store::ai::forget_line(tx, &info.line.id).await?;
    }
    coding_store::set_line_state(
        tx,
        &LineState {
            bank_line_id: info.line.id.clone(),
            state: kind,
            coding,
            journal_id,
            rule_id: target.rule_id,
            pair_line_id: None,
            ird_income_year: target.ird_income_year,
            asset_id,
            updated_seq: seq,
        },
    )
    .await?;
    Ok(())
}

fn refuse_duplicate(info: &LineInfo) -> Result<(), CommandError> {
    if info.state.state == LineStateKind::Duplicate {
        return Err(CommandError::invalid(
            "line_is_duplicate",
            "This line was marked as a duplicate, so it can't be coded. Say it isn't one first.",
        ));
    }
    Ok(())
}

/// A transfer coded on one line, to or from another of the business's accounts, would count the
/// money twice once that account's own line is coded too. Those go through `confirm_transfer`.
async fn refuse_one_sided_transfer(
    tx: &mut SqliteConnection,
    books: &Books,
    info: &LineInfo,
    coding: &Coding,
) -> Result<(), CommandError> {
    let other = match coding {
        Coding::In(DepositCoding::Transfer { from }) => from,
        Coding::Out(WithdrawalCoding::Transfer { to }) => to,
        _ => return Ok(()),
    };
    let Some(account) = books.accounts.iter().find(|a| a.code == *other) else {
        return Ok(());
    };
    let covered = bank_store::statements(tx, &account.id)
        .await?
        .iter()
        .any(|s| s.start_date <= info.line.date && info.line.date <= s.end_date);
    if covered {
        return Err(CommandError::invalid(
            "use_confirm_transfer",
            format!(
                "{} has a statement for {}, so its side of this transfer is in the books too. \
                 Confirm the two lines as a transfer instead.",
                account.name, info.line.date
            ),
        ));
    }
    Ok(())
}

/// `code_bank_line` and `code_bank_lines`. Every line must belong to the same business.
pub async fn code_lines(
    tx: &mut SqliteConnection,
    seq: i64,
    today: NaiveDate,
    lines: &[LineCoding],
) -> Result<String, CommandError> {
    let Some(first) = lines.first() else {
        return Err(CommandError::invalid(
            "no_lines",
            "Choose at least one line to code.",
        ));
    };
    let books = books_for_line(tx, &first.bank_line_id).await?;
    let mut seen = BTreeSet::new();
    for entry in lines {
        if !seen.insert(entry.bank_line_id.as_str()) {
            return Err(CommandError::invalid(
                "line_repeated",
                "The same line is in the batch twice.",
            ));
        }
        // Reload each time: an earlier line may have undone a transfer this one was part of.
        let info = load_line(tx, &books, &entry.bank_line_id).await?;
        refuse_duplicate(&info)?;
        refuse_one_sided_transfer(tx, &books, &info, &entry.coding).await?;
        let info = if entry.supply_info_confirmed == Some(true) && info.confirmed.is_none() {
            coding_store::confirm_supply_info(tx, &info.line.id, today, seq).await?;
            LineInfo {
                confirmed: Some(today),
                ..info
            }
        } else {
            info
        };
        let ird_income_year = match &entry.coding {
            Coding::Out(WithdrawalCoding::IrdIncomeTax) => Some(
                info.state
                    .ird_income_year
                    .unwrap_or(IncomeYear::containing(info.line.date)),
            ),
            _ => None,
        };
        set_posting(
            tx,
            seq,
            &books,
            &info,
            Target {
                posting: Posting::Coded(entry.coding.clone()),
                rule_id: None,
                ird_income_year,
                asset_class_id: entry.asset_class_id.clone(),
            },
        )
        .await?;
    }
    Ok(books.client_id)
}

/// Checks a coding against the business's chart and settings, as it would post on a line of its
/// direction in one of the business's accounts.
async fn check_coding(
    tx: &mut SqliteConnection,
    books: &Books,
    coding: &Coding,
) -> Result<(), CommandError> {
    let other = match coding {
        Coding::In(DepositCoding::Transfer { from }) => Some(from),
        Coding::Out(WithdrawalCoding::Transfer { to }) => Some(to),
        _ => None,
    };
    let Some(bank) = books
        .accounts
        .iter()
        .map(|a| &a.code)
        .find(|c| Some(*c) != other)
    else {
        return Err(CommandError::invalid(
            "no_bank_accounts",
            "Add a bank account before adding rules.",
        ));
    };
    let amount = match coding.direction() {
        Direction::In => Money::from_cents(100),
        Direction::Out => Money::from_cents(-100),
    };
    let line = CoreLine {
        bank,
        date: books.business.start_date,
        amount,
    };
    coded_lines(&line, coding, None, &books.context()).map_err(coding_error)?;
    if let Coding::Out(WithdrawalCoding::AssetPurchase { account, .. }) = coding {
        asset_class_for(tx, books, account, None).await?;
    }
    Ok(())
}

/// `add_rule`: stores the rule and codes the unsorted lines it matches. Returns the rule's id.
pub async fn add_rule(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    description_contains: &str,
    min: Option<Money>,
    max: Option<Money>,
    coding: &Coding,
) -> Result<String, CommandError> {
    let books = books(tx, client_id).await?;
    let text = description_contains.split_whitespace().collect::<Vec<_>>();
    if text.is_empty() {
        return Err(CommandError::invalid(
            "empty_rule",
            "Say what text the description must contain.",
        ));
    }
    let rule = Rule {
        id: new_id(),
        description_contains: text.join(" "),
        min,
        max,
        coding: coding.clone(),
    };
    rule.validate().map_err(|e| {
        let code = match e {
            coding::RuleError::NegativeAmount => "negative_amount",
            coding::RuleError::MinAboveMax => "min_above_max",
        };
        CommandError::invalid(code, e.to_string())
    })?;
    check_coding(tx, &books, coding).await?;
    coding_store::insert_rule(tx, client_id, &rule, seq).await?;
    apply_rules(tx, seq, client_id, None).await?;
    Ok(rule.id)
}

/// Codes unsorted lines by the business's rules: every line, or only those in `only`. Lines in a
/// finalised year, and lines a rule's coding doesn't fit, are left as they are.
pub async fn apply_rules(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    only: Option<&BTreeSet<String>>,
) -> Result<(), CommandError> {
    let rules = coding_store::live_rules(tx, client_id).await?;
    if rules.is_empty() {
        return Ok(());
    }
    let books = books(tx, client_id).await?;
    let year_list = years::for_client(tx, client_id).await?;
    for info in load_lines(tx, &books).await? {
        if only.is_some_and(|o| !o.contains(&info.line.id)) || !info.is_unsorted() {
            continue;
        }
        let open = year_list
            .iter()
            .any(|y| y.year.contains(info.line.date) && y.status == YearStatus::Open);
        let Some(rule) = best_rule(&rules, &info.line.description, info.line.amount) else {
            continue;
        };
        if !open {
            continue;
        }
        let target = Target {
            posting: Posting::Coded(rule.coding.clone()),
            rule_id: Some(rule.id.clone()),
            ird_income_year: matches!(rule.coding, Coding::Out(WithdrawalCoding::IrdIncomeTax))
                .then(|| IncomeYear::containing(info.line.date)),
            asset_class_id: None,
        };
        match set_posting(tx, seq, &books, &info, target).await {
            Ok(()) | Err(CommandError::Invalid { .. }) => {}
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// `remove_rule`. Returns the business's id.
pub async fn remove_rule(
    tx: &mut SqliteConnection,
    seq: i64,
    rule_id: &str,
) -> Result<String, CommandError> {
    let stored = coding_store::get_rule(tx, rule_id)
        .await?
        .filter(|r| r.removed_seq.is_none())
        .ok_or_else(|| CommandError::not_found("rule", rule_id))?;
    coding_store::remove_rule(tx, rule_id, seq).await?;
    Ok(stored.client_id)
}

/// `answer_question`.
pub async fn answer_question(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    income_year: i32,
    answer: &Answer,
) -> Result<(), CommandError> {
    business::business(tx, client_id).await?;
    let year = IncomeYear(income_year);
    let has_year = years::for_client(tx, client_id)
        .await?
        .iter()
        .any(|y| IncomeYear::containing(y.year.end()) == year);
    if !has_year {
        return Err(CommandError::invalid(
            "no_such_year",
            format!("The business has no lines in the {income_year} income year."),
        ));
    }
    let mut answers = coding_store::answers(tx, client_id)
        .await?
        .into_iter()
        .find(|(y, _)| *y == year)
        .map(|(_, a)| a)
        .unwrap_or_default();
    match *answer {
        Answer::OnlyIncome { yes } => {
            answers.questions.only_income = Some(yes);
            if yes {
                answers.other_income = None;
            }
        }
        Answer::OtherIncome {
            income,
            tax_deducted,
        } => {
            if income < Money::ZERO || tax_deducted < Money::ZERO {
                return Err(CommandError::invalid(
                    "negative_amount",
                    "Income and tax deducted can't be negative.",
                ));
            }
            answers.questions.only_income = Some(false);
            answers.other_income = Some(OtherIncome {
                income,
                tax_deducted,
            });
        }
        Answer::StudentLoan { yes } => answers.questions.student_loan = Some(yes),
        Answer::Ietc { months } => {
            if months > 12 {
                return Err(CommandError::invalid(
                    "invalid_months",
                    "A year has 12 months.",
                ));
            }
            answers.ietc_months = Some(months);
        }
    }
    // Income tax paid comes from the confirmed IRD payments, not from here.
    answers.tax_paid = Money::ZERO;
    coding_store::set_answers(tx, client_id, year, &answers, seq).await?;
    Ok(())
}

/// `confirm_transfer`: one journal moves the money between the two accounts, dated the money-out
/// line's date. Returns the business's id.
pub async fn confirm_transfer(
    tx: &mut SqliteConnection,
    seq: i64,
    out_line_id: &str,
    in_line_id: &str,
) -> Result<String, CommandError> {
    let books = books_for_line(tx, out_line_id).await?;
    let out = load_line(tx, &books, out_line_id).await?;
    let inn = load_line(tx, &books, in_line_id).await?;
    if out.line.amount >= Money::ZERO
        || inn.line.amount != -out.line.amount
        || out.account.id == inn.account.id
    {
        return Err(CommandError::invalid(
            "not_a_transfer",
            "A transfer is money out of one of the business's accounts and the same amount into \
             another.",
        ));
    }
    refuse_duplicate(&out)?;
    refuse_duplicate(&inn)?;
    if out.state.pair_line_id.as_deref() == Some(in_line_id) {
        return Ok(books.client_id);
    }
    let out_year = line_year(tx, &books.client_id, out.line.date).await?;
    let in_year = line_year(tx, &books.client_id, inn.line.date).await?;
    if out_year.id != in_year.id {
        return Err(CommandError::invalid(
            "transfer_across_years",
            "The two lines are in different years, so they can't be one transfer.",
        ));
    }
    let out_coding = Coding::Out(WithdrawalCoding::Transfer {
        to: inn.account.code.clone(),
    });
    let in_coding = Coding::In(DepositCoding::Transfer {
        from: out.account.code.clone(),
    });
    // Both codings must suit the chart, though the journal is one.
    posting_lines(&books, &out, &Posting::Coded(out_coding.clone()), None)?;
    posting_lines(&books, &inn, &Posting::Coded(in_coding.clone()), None)?;

    release(tx, seq, &books, &out, false).await?;
    // Releasing `out` may have put `inn` back to unsorted, so reload it.
    let inn = load_line(tx, &books, in_line_id).await?;
    release(tx, seq, &books, &inn, false).await?;
    let amount = inn.line.amount;
    let journal_id = post_line(
        tx,
        seq,
        &books,
        &out,
        format!("Transfer: {}", out.line.description),
        vec![
            JournalLine {
                account: inn.account.code.clone(),
                amount,
            },
            JournalLine {
                account: out.account.code.clone(),
                amount: -amount,
            },
        ],
    )
    .await?;
    for (line, coding, partner) in [
        (&out, out_coding, in_line_id),
        (&inn, in_coding, out_line_id),
    ] {
        acct_store::ai::forget_line(tx, &line.line.id).await?;
        coding_store::set_line_state(
            tx,
            &LineState {
                bank_line_id: line.line.id.clone(),
                state: LineStateKind::Coded,
                coding: Some(coding),
                journal_id: journal_id.clone(),
                rule_id: None,
                pair_line_id: Some(partner.to_owned()),
                ird_income_year: None,
                asset_id: None,
                updated_seq: seq,
            },
        )
        .await?;
    }
    Ok(books.client_id)
}

/// `confirm_ird_payment`. Returns the business's id.
pub async fn confirm_ird_payment(
    tx: &mut SqliteConnection,
    seq: i64,
    bank_line_id: &str,
    payment: &IrdPayment,
) -> Result<String, CommandError> {
    let books = books_for_line(tx, bank_line_id).await?;
    let info = load_line(tx, &books, bank_line_id).await?;
    refuse_duplicate(&info)?;
    let money_in = info.line.amount > Money::ZERO;
    let (coding, year) = match (payment, money_in) {
        (IrdPayment::Gst, true) => (Coding::In(DepositCoding::GstRefund), None),
        (IrdPayment::Gst, false) => (Coding::Out(WithdrawalCoding::IrdGst), None),
        (IrdPayment::IncomeTax { income_year }, false) => {
            let line_year = IncomeYear::containing(info.line.date);
            // Tax is paid for the year it's in, an earlier one (terminal tax), or the next
            // (provisional tax paid early).
            if !(line_year.0 - 2..=line_year.0 + 1).contains(income_year) {
                return Err(CommandError::invalid(
                    "unlikely_income_year",
                    format!(
                        "A payment on {} can't be income tax for the {income_year} income year.",
                        info.line.date
                    ),
                ));
            }
            (
                Coding::Out(WithdrawalCoding::IrdIncomeTax),
                Some(IncomeYear(*income_year)),
            )
        }
        (IrdPayment::IncomeTax { .. }, true) => {
            return Err(CommandError::invalid(
                "income_tax_refund_not_supported",
                "Income tax refunds can't be recorded yet. Leave this line for your accountant.",
            ));
        }
    };
    set_posting(
        tx,
        seq,
        &books,
        &info,
        Target {
            ird_income_year: year,
            ..Target::posting(Posting::Coded(coding))
        },
    )
    .await?;
    Ok(books.client_id)
}

/// `resolve_duplicate`. Returns the business's id.
pub async fn resolve_duplicate(
    tx: &mut SqliteConnection,
    seq: i64,
    bank_line_id: &str,
    is_duplicate: bool,
) -> Result<String, CommandError> {
    let books = books_for_line(tx, bank_line_id).await?;
    let info = load_line(tx, &books, bank_line_id).await?;
    if !info.line.possible_duplicate {
        return Err(CommandError::invalid(
            "not_a_possible_duplicate",
            "This line wasn't flagged as a possible duplicate.",
        ));
    }
    coding_store::answer_duplicate(tx, bank_line_id, is_duplicate, seq).await?;
    if is_duplicate {
        set_posting(tx, seq, &books, &info, Target::posting(Posting::Nothing)).await?;
    } else if info.state.state == LineStateKind::Duplicate {
        set_posting(tx, seq, &books, &info, Target::posting(Posting::Unsorted)).await?;
    }
    Ok(books.client_id)
}

/// `confirm_supply_info`: records today as the date, and recodes the line if it's coded, which
/// moves any GST waiting to be claimed into the GST account. Returns the business's id.
pub async fn confirm_supply_info(
    tx: &mut SqliteConnection,
    seq: i64,
    today: NaiveDate,
    bank_line_id: &str,
) -> Result<String, CommandError> {
    let books = books_for_line(tx, bank_line_id).await?;
    let info = load_line(tx, &books, bank_line_id).await?;
    if info.line.amount >= Money::ZERO {
        return Err(CommandError::invalid(
            "not_spending",
            "Supply information is only needed for money out.",
        ));
    }
    if info.confirmed.is_some() {
        return Ok(books.client_id);
    }
    // Recoding needs an open year; check before recording anything.
    line_year(tx, &books.client_id, info.line.date).await?;
    coding_store::confirm_supply_info(tx, bank_line_id, today, seq).await?;
    if let Posting::Coded(coding) = info.posting() {
        let info = LineInfo {
            confirmed: Some(today),
            ..info
        };
        if info.state.pair_line_id.is_none() {
            let target = Target {
                posting: Posting::Coded(coding),
                rule_id: info.state.rule_id.clone(),
                ird_income_year: info.state.ird_income_year,
                asset_class_id: None,
            };
            set_posting(tx, seq, &books, &info, target).await?;
        }
    }
    Ok(books.client_id)
}

/// `set_coding_settings`.
pub async fn set_coding_settings(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    settings: &CodingSettings,
) -> Result<(), CommandError> {
    business::business(tx, client_id).await?;
    let chart = clients::chart(tx, client_id).await?;
    settings.validate(&chart).map_err(|e| {
        CommandError::invalid_with(
            "invalid_coding_settings",
            format!("The coding settings don't fit the chart: {e}."),
            &e,
        )
    })?;
    coding_store::set_settings(tx, client_id, settings, seq).await?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// What the figure is worked out from, and what each card would save.

/// What one line, or one gap journal, adds to the tax engine's inputs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Effect {
    gst: GstTotals,
    taxable_income: Money,
    /// Income tax paid to IRD, and the year it's a credit for.
    tax_paid: Option<(IncomeYear, Money)>,
}

fn effect_of(
    books: &Books,
    info: &LineInfo,
    posting: &Posting,
    lines: &[JournalLine],
    confirmed: Option<NaiveDate>,
    ird_income_year: Option<IncomeYear>,
) -> Effect {
    let (gst, tax_paid) = match posting {
        Posting::Unsorted => (
            gst_totals(&info.core(), None, confirmed, books.gst_from()),
            None,
        ),
        Posting::Coded(c) => (
            gst_totals(&info.core(), Some(c), confirmed, books.gst_from()),
            match c {
                Coding::Out(WithdrawalCoding::IrdIncomeTax) => Some((
                    ird_income_year.unwrap_or(IncomeYear::containing(info.line.date)),
                    -info.line.amount,
                )),
                _ => None,
            },
        ),
        Posting::Nothing => (GstTotals::default(), None),
    };
    Effect {
        gst,
        taxable_income: taxable_income_of(lines, &books.chart),
        tax_paid,
    }
}

/// A line's effect as it's posted now, from its live journal.
fn current_effect(
    books: &Books,
    info: &LineInfo,
    journals: &HashMap<String, StoredJournal>,
) -> Effect {
    let lines = info
        .state
        .journal_id
        .as_ref()
        .and_then(|id| journals.get(id))
        .map(|j| j.journal.lines.as_slice())
        .unwrap_or_default();
    effect_of(
        books,
        info,
        &info.posting(),
        lines,
        info.confirmed,
        info.state.ird_income_year,
    )
}

/// A line's effect if it posted `posting` instead, or `None` if that coding doesn't fit.
fn target_effect(
    books: &Books,
    info: &LineInfo,
    posting: &Posting,
    confirmed: Option<NaiveDate>,
    ird_income_year: Option<IncomeYear>,
) -> Option<Effect> {
    let lines = posting_lines(books, info, posting, confirmed).ok()?;
    Some(effect_of(
        books,
        info,
        posting,
        &lines,
        confirmed,
        ird_income_year,
    ))
}

fn minus(a: GstTotals, b: GstTotals) -> GstTotals {
    GstTotals {
        sales: a.sales - b.sales,
        zero_rated: a.zero_rated - b.zero_rated,
        adjustments: a.adjustments - b.adjustments,
        purchases: a.purchases - b.purchases,
        credit_adjustments: a.credit_adjustments - b.credit_adjustments,
    }
}

/// `inputs` with an effect dated `date` replaced: `before` taken out, `after` put in.
fn shift(
    inputs: &TaxInputs,
    books: &Books,
    date: NaiveDate,
    before: &Effect,
    after: &Effect,
) -> TaxInputs {
    let period = books
        .business
        .gst
        .and_then(|g| gst_period(date, g.frequency, g.registered_from));
    let gst = minus(after.gst, before.gst);
    let mut next = inputs.with(&Change::Moves {
        gst: period
            .filter(|_| gst != GstTotals::default())
            .map(|p| (p, gst)),
        taxable_income: Some((
            IncomeYear::containing(date),
            after.taxable_income - before.taxable_income,
        )),
    });
    let paid = [before.tax_paid.map(|(y, m)| (y, -m)), after.tax_paid];
    for (year, amount) in paid.into_iter().flatten() {
        {
            let mut answers = next.answers.get(&year).copied().unwrap_or_default();
            answers.tax_paid += amount;
            next = next.with(&Change::Answers { year, answers });
        }
    }
    next
}

/// Every journal of a business, by id.
async fn client_journals(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<(Vec<StoredYear>, HashMap<String, StoredJournal>), CommandError> {
    let year_list = years::for_client(conn, client_id).await?;
    let mut all = HashMap::new();
    for y in &year_list {
        for j in journals::for_year(conn, &y.id).await? {
            all.insert(j.id.clone(), j);
        }
    }
    Ok((year_list, all))
}

/// A gap journal still in force: its date and lines.
struct LiveGap {
    bank_account_id: String,
    start: NaiveDate,
    end: NaiveDate,
    change: Money,
    lines: Vec<JournalLine>,
}

/// Everything the figure and the queue are worked out from.
struct Snapshot {
    books: Books,
    lines: Vec<LineInfo>,
    journals: HashMap<String, StoredJournal>,
    gaps: Vec<LiveGap>,
    inputs: TaxInputs,
}

async fn snapshot(conn: &mut SqliteConnection, client_id: &str) -> Result<Snapshot, CommandError> {
    let books = books(conn, client_id).await?;
    let lines = load_lines(conn, &books).await?;
    let (year_list, journals) = client_journals(conn, client_id).await?;
    let mut gaps = Vec::new();
    for account in &books.accounts {
        for g in bank_store::live_gap_journals(conn, &account.id).await? {
            if let Some(j) = journals.get(&g.journal_id) {
                let change = j
                    .journal
                    .lines
                    .iter()
                    .filter(|l| l.account == account.code)
                    .map(|l| l.amount)
                    .sum();
                gaps.push(LiveGap {
                    bank_account_id: account.id.clone(),
                    start: g.start_date,
                    end: g.end_date,
                    change,
                    lines: j.journal.lines.clone(),
                });
            }
        }
    }

    let mut inputs = TaxInputs::default();
    // GST: every period from registration with an uploaded line, from each line as it's posted.
    if let Some(gst) = books.business.gst {
        for info in &lines {
            if let Some(period) = gst_period(info.line.date, gst.frequency, gst.registered_from) {
                let effect = current_effect(&books, info, &journals);
                let totals = inputs.gst.entry(period).or_default();
                *totals = add(*totals, effect.gst);
            }
        }
        for g in &gaps {
            if let Some(period) = gst_period(g.end, gst.frequency, gst.registered_from) {
                let account = books
                    .accounts
                    .iter()
                    .find(|a| a.id == g.bank_account_id)
                    .expect("the gap's account");
                let line = CoreLine {
                    bank: &account.code,
                    date: g.end,
                    amount: g.change,
                };
                let totals = inputs.gst.entry(period).or_default();
                *totals = add(*totals, gst_totals(&line, None, None, books.gst_from()));
            }
        }
    }
    // Income tax: each client-year with lines is one income year (31 March balance date), its
    // taxable income the profit in the ledger.
    for y in &year_list {
        if lines.iter().any(|l| y.year.contains(l.line.date)) {
            let in_year: Vec<JournalLine> = journals
                .values()
                .filter(|j| j.client_year_id == y.id)
                .flat_map(|j| j.journal.lines.iter().cloned())
                .collect();
            inputs.taxable_income.insert(
                IncomeYear::containing(y.year.end()),
                taxable_income_of(&in_year, &books.chart),
            );
        }
    }
    // The owner's answers, and income tax paid from the confirmed IRD payments.
    inputs.answers = coding_store::answers(conn, client_id)
        .await?
        .into_iter()
        .map(|(y, a)| {
            (
                y,
                YearAnswers {
                    tax_paid: Money::ZERO,
                    ..a
                },
            )
        })
        .collect();
    for info in &lines {
        if let Some((year, paid)) = current_effect(&books, info, &journals).tax_paid {
            inputs.answers.entry(year).or_default().tax_paid += paid;
        }
    }
    Ok(Snapshot {
        books,
        lines,
        journals,
        gaps,
        inputs,
    })
}

fn add(a: GstTotals, b: GstTotals) -> GstTotals {
    GstTotals {
        sales: a.sales + b.sales,
        zero_rated: a.zero_rated + b.zero_rated,
        adjustments: a.adjustments + b.adjustments,
        purchases: a.purchases + b.purchases,
        credit_adjustments: a.credit_adjustments + b.credit_adjustments,
    }
}

/// The ledger totals and answers core's tax engine works from: each GST period with an uploaded
/// line, each income year with one, and what the owner has told us.
pub async fn tax_inputs(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<TaxInputs, CommandError> {
    Ok(snapshot(conn, client_id).await?.inputs)
}

// ---------------------------------------------------------------------------------------------
// The queue.

/// Which kind of card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum CardKind {
    /// A question about the owner (`question` says which), answered with `answer_question`.
    Question,
    /// A likely transfer between the owner's own accounts: `confirm_transfer`, or code the lines.
    Transfer,
    /// A payment to or from IRD: `confirm_ird_payment`.
    IrdPayment,
    /// A line that may be a duplicate: `resolve_duplicate`.
    Duplicate,
    /// Days with no statement whose rise in balance is counted as income: upload the statement.
    Gap,
    /// GST over $200 waiting on the supplier's taxable supply information: `confirm_supply_info`.
    SupplyInfo,
    /// A line to categorise: `code_bank_line`, or `add_rule` for "always do this".
    Categorise,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Question {
    /// "Is this business your only income?"
    OnlyIncome,
    /// The other income and the tax deducted from it.
    OtherIncome,
    /// "Do you have a student loan?"
    StudentLoan,
    /// The independent earner tax credit: how many months the owner is eligible.
    Ietc,
}

/// A bank line on a card.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct CardLine {
    pub bank_line_id: String,
    pub bank_account_id: String,
    pub account_name: String,
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub amount: Money,
    pub description: String,
}

/// Where a suggested coding came from (ADR 009's layers 1 to 4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SuggestionSource {
    Rule,
    /// Earlier lines with the same description were all coded this way.
    History,
    /// The practice's merchant list.
    Merchant,
    /// An AI model, from the description and rounded amount. Accepting it unchanged sends
    /// `via: { kind: "suggestion", model, suggestion_ids: [id] }` with the coding.
    Ai,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Suggestion {
    pub coding: Coding,
    pub source: SuggestionSource,
    /// For an AI suggestion: its id, for `via`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<String>,
    /// For an AI suggestion: the model that made it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub model: Option<String>,
}

/// The days a gap covers and its change in balance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct CardGap {
    pub bank_account_id: String,
    #[ts(type = "string")]
    pub start: NaiveDate,
    #[ts(type = "string")]
    pub end: NaiveDate,
    pub change: Money,
}

/// One card in the Save tax queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SaveTaxCard {
    /// Stable while the card stands, such as `line:<id>` or `question:only_income:2026`.
    pub id: String,
    pub kind: CardKind,
    pub question: Option<Question>,
    pub income_year: Option<i32>,
    /// The line or lines the card is about (a transfer has two, money out first).
    pub lines: Vec<CardLine>,
    pub suggestion: Option<Suggestion>,
    pub gap: Option<CardGap>,
    /// How much lower "Tax to pay if submitted" would be, in cents.
    pub saving: Money,
    /// `saving` is the most the card could save, because the answer isn't known yet: a deposit
    /// that turns out not to be income, spending that's all business, a gap with no income.
    pub best_case: bool,
}

/// `GET /api/businesses/{id}/save-tax`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct SaveTaxQueue {
    /// "Tax to pay if submitted" now.
    pub total: Money,
    /// The figure with nothing answered and nothing sorted.
    pub conservative_total: Money,
    /// `conservative_total` less `total`.
    pub saved_so_far: Money,
    /// Biggest saving first. Cards that would save nothing are left out.
    pub cards: Vec<SaveTaxCard>,
}

struct Builder<'a> {
    snap: &'a Snapshot,
    base: Money,
    cards: Vec<SaveTaxCard>,
}

impl Builder<'_> {
    fn saving_of(&self, after: &TaxInputs) -> Money {
        self.base - position(after).total
    }

    /// The saving of recoding lines, each to a posting.
    fn recode_saving(&self, moves: &[(&LineInfo, Posting, Option<IncomeYear>)]) -> Option<Money> {
        let snap = self.snap;
        let mut inputs = snap.inputs.clone();
        for (info, posting, year) in moves {
            let before = current_effect(&snap.books, info, &snap.journals);
            let after = target_effect(&snap.books, info, posting, info.confirmed, *year)?;
            inputs = shift(&inputs, &snap.books, info.line.date, &before, &after);
        }
        Some(self.saving_of(&inputs))
    }

    fn push(&mut self, card: SaveTaxCard) {
        if card.saving > Money::ZERO {
            self.cards.push(card);
        }
    }
}

fn card(id: String, kind: CardKind, saving: Money) -> SaveTaxCard {
    SaveTaxCard {
        id,
        kind,
        question: None,
        income_year: None,
        lines: Vec::new(),
        suggestion: None,
        gap: None,
        saving,
        best_case: false,
    }
}

/// The first active expense account that defaults to standard-rated GST: what a withdrawal with
/// no suggestion is priced as, at best.
fn estimate_account(chart: &Chart) -> Option<AccountCode> {
    let expenses = || {
        chart
            .accounts()
            .iter()
            .filter(|a| a.active && a.account_type == AccountType::Expense)
    };
    expenses()
        .find(|a| a.default_gst == Some(GstCode::Standard))
        .or_else(|| expenses().next())
        .map(|a| a.code.clone())
}

pub async fn queue(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<SaveTaxQueue, CommandError> {
    let snap = snapshot(conn, client_id).await?;
    let rules = coding_store::live_rules(conn, client_id).await?;
    let books = &snap.books;
    let total = position(&snap.inputs).total;

    // The conservative figure: every line back as imported, nothing answered.
    let mut conservative = TaxInputs {
        answers: BTreeMap::new(),
        ..snap.inputs.clone()
    };
    for info in &snap.lines {
        let before = Effect {
            tax_paid: None,
            ..current_effect(books, info, &snap.journals)
        };
        if let Some(after) = target_effect(books, info, &Posting::Unsorted, None, None) {
            conservative = shift(&conservative, books, info.line.date, &before, &after);
        }
    }
    let conservative_total = position(&conservative).total;

    let mut b = Builder {
        snap: &snap,
        base: total,
        cards: Vec::new(),
    };

    // Questions, per income year.
    for &year in snap.inputs.taxable_income.keys() {
        let current = snap.inputs.answers.get(&year).copied().unwrap_or_default();
        let ask = |b: &mut Builder<'_>, q: Question, answers: YearAnswers, best_case: bool| {
            let after = b.snap.inputs.with(&Change::Answers { year, answers });
            let key = serde_json::to_value(q).expect("serialises");
            b.push(SaveTaxCard {
                question: Some(q),
                income_year: Some(year.0),
                best_case,
                ..card(
                    format!("question:{}:{}", key.as_str().unwrap_or_default(), year.0),
                    CardKind::Question,
                    b.saving_of(&after),
                )
            });
        };
        match current.questions.only_income {
            None => {
                let mut a = current;
                a.questions.only_income = Some(true);
                ask(&mut b, Question::OnlyIncome, a, false);
            }
            Some(false) if current.other_income.is_none() => {
                let mut a = current;
                a.other_income = Some(OtherIncome::default());
                ask(&mut b, Question::OtherIncome, a, true);
            }
            _ => {}
        }
        if current.questions.student_loan.is_none() {
            let mut a = current;
            a.questions.student_loan = Some(false);
            ask(&mut b, Question::StudentLoan, a, false);
        }
        if current.ietc_months.is_none()
            && let Some(other) = current.known_other_income()
        {
            let income = snap.inputs.taxable_income[&year] + other.income;
            if (IETC_FROM..=IETC_TO).contains(&income) {
                let mut a = current;
                a.ietc_months = Some(12);
                ask(&mut b, Question::Ietc, a, true);
            }
        }
    }

    // Lines that are on a card already.
    let mut taken: BTreeSet<&str> = BTreeSet::new();
    let unsorted: Vec<&LineInfo> = snap.lines.iter().filter(|l| l.is_unsorted()).collect();

    // Possible duplicates the owner hasn't answered.
    for info in &snap.lines {
        if info.line.possible_duplicate
            && info.duplicate_answer.is_none()
            && info.state.state != LineStateKind::Duplicate
        {
            taken.insert(&info.line.id);
            if let Some(saving) = b.recode_saving(&[(info, Posting::Nothing, None)]) {
                b.push(SaveTaxCard {
                    lines: vec![info.view()],
                    ..card(
                        format!("line:{}", info.line.id),
                        CardKind::Duplicate,
                        saving,
                    )
                });
            }
        }
    }

    // Likely transfers between the owner's accounts.
    let facts: Vec<LineFacts<'_>> = unsorted
        .iter()
        .map(|l| LineFacts {
            account: &l.account.id,
            date: l.line.date,
            amount: l.line.amount,
            description: &l.line.description,
        })
        .collect();
    for (o, i) in transfer_pairs(&facts) {
        let (out, inn) = (unsorted[o], unsorted[i]);
        if taken.contains(out.line.id.as_str()) || taken.contains(inn.line.id.as_str()) {
            continue;
        }
        taken.insert(&out.line.id);
        taken.insert(&inn.line.id);
        let moves = [
            (
                out,
                Posting::Coded(Coding::Out(WithdrawalCoding::Transfer {
                    to: inn.account.code.clone(),
                })),
                None,
            ),
            (
                inn,
                Posting::Coded(Coding::In(DepositCoding::Transfer {
                    from: out.account.code.clone(),
                })),
                None,
            ),
        ];
        if let Some(saving) = b.recode_saving(&moves) {
            b.push(SaveTaxCard {
                lines: vec![out.view(), inn.view()],
                ..card(
                    format!("transfer:{}:{}", out.line.id, inn.line.id),
                    CardKind::Transfer,
                    saving,
                )
            });
        }
    }

    // Payments to and from IRD.
    for info in &unsorted {
        if taken.contains(info.line.id.as_str()) || !looks_like_ird(&info.line.description) {
            continue;
        }
        taken.insert(&info.line.id);
        let saving = if info.line.amount > Money::ZERO {
            b.recode_saving(&[(
                info,
                Posting::Coded(Coding::In(DepositCoding::GstRefund)),
                None,
            )])
        } else {
            let gst = b.recode_saving(&[(
                info,
                Posting::Coded(Coding::Out(WithdrawalCoding::IrdGst)),
                None,
            )]);
            let income_tax = b.recode_saving(&[(
                info,
                Posting::Coded(Coding::Out(WithdrawalCoding::IrdIncomeTax)),
                Some(IncomeYear::containing(info.line.date)),
            )]);
            gst.max(income_tax)
        };
        if let Some(saving) = saving {
            b.push(SaveTaxCard {
                lines: vec![info.view()],
                best_case: info.line.amount < Money::ZERO,
                ..card(
                    format!("line:{}", info.line.id),
                    CardKind::IrdPayment,
                    saving,
                )
            });
        }
    }

    // Gaps whose rise in balance counts as income.
    for g in &snap.gaps {
        if g.change <= Money::ZERO {
            continue;
        }
        let account = books
            .accounts
            .iter()
            .find(|a| a.id == g.bank_account_id)
            .expect("the gap's account");
        let line = CoreLine {
            bank: &account.code,
            date: g.end,
            amount: g.change,
        };
        let before = Effect {
            gst: gst_totals(&line, None, None, books.gst_from()),
            taxable_income: taxable_income_of(&g.lines, &books.chart),
            tax_paid: None,
        };
        let after = shift(&snap.inputs, books, g.end, &before, &Effect::default());
        let saving = b.saving_of(&after);
        b.push(SaveTaxCard {
            gap: Some(CardGap {
                bank_account_id: g.bank_account_id.clone(),
                start: g.start,
                end: g.end,
                change: g.change,
            }),
            best_case: true,
            ..card(
                format!("gap:{}:{}", g.bank_account_id, g.start),
                CardKind::Gap,
                saving,
            )
        });
    }

    // GST over $200 waiting on the supply information.
    for info in &snap.lines {
        let Posting::Coded(coding) = info.posting() else {
            continue;
        };
        let standard_spend = matches!(
            coding,
            Coding::Out(
                WithdrawalCoding::Expense {
                    gst: GstCode::Standard,
                    ..
                } | WithdrawalCoding::AssetPurchase {
                    gst: GstCode::Standard,
                    ..
                } | WithdrawalCoding::PartPrivate {
                    gst: GstCode::Standard,
                    ..
                }
            )
        );
        if !standard_spend || info.confirmed.is_some() || -info.line.amount <= SUPPLY_INFO_THRESHOLD
        {
            continue;
        }
        let before = current_effect(books, info, &snap.journals);
        let Some(after) = target_effect(
            books,
            info,
            &Posting::Coded(coding),
            Some(info.line.date),
            info.state.ird_income_year,
        ) else {
            continue;
        };
        let inputs = shift(&snap.inputs, books, info.line.date, &before, &after);
        let saving = b.saving_of(&inputs);
        b.push(SaveTaxCard {
            lines: vec![info.view()],
            ..card(
                format!("supply:{}", info.line.id),
                CardKind::SupplyInfo,
                saving,
            )
        });
    }

    // Everything else that's unsorted: categorise.
    let history: Vec<(&str, &Coding)> = snap
        .lines
        .iter()
        .filter(|l| l.state.pair_line_id.is_none())
        .filter_map(|l| match (&l.state.state, &l.state.coding) {
            (LineStateKind::Coded, Some(c)) => Some((l.line.description.as_str(), c)),
            _ => None,
        })
        .collect();
    let estimate = estimate_account(&books.chart);
    // Layer 3: the practice's merchant list for this entity type.
    let merchant_list = acct_store::merchants::live(conn, &books.entity_type).await?;
    // Layer 4: AI suggestions waiting on the owner. Layers 1 to 3 win over them.
    let ai_suggestions: HashMap<String, acct_store::ai::StoredSuggestion> =
        acct_store::ai::live_suggestions(conn, client_id)
            .await?
            .into_iter()
            .map(|s| (s.bank_line_id.clone(), s))
            .collect();
    for info in &unsorted {
        if taken.contains(info.line.id.as_str()) {
            continue;
        }
        let Some(direction) = Direction::of(info.line.amount) else {
            continue;
        };
        let suggestion = best_rule(&rules, &info.line.description, info.line.amount)
            .map(|r| Suggestion {
                coding: r.coding.clone(),
                source: SuggestionSource::Rule,
                id: None,
                model: None,
            })
            .or_else(|| {
                from_history(history.iter().copied(), &info.line.description, direction).map(|c| {
                    Suggestion {
                        coding: c.clone(),
                        source: SuggestionSource::History,
                        id: None,
                        model: None,
                    }
                })
            })
            .or_else(|| {
                from_merchants(&merchant_list, &info.line.description, info.line.amount).map(|m| {
                    Suggestion {
                        coding: m.coding.clone(),
                        source: SuggestionSource::Merchant,
                        id: None,
                        model: None,
                    }
                })
            })
            .or_else(|| {
                ai_suggestions
                    .get(info.line.id.as_str())
                    .map(|s| Suggestion {
                        coding: s.coding.clone(),
                        source: SuggestionSource::Ai,
                        id: Some(s.id.clone()),
                        model: Some(s.model.clone()),
                    })
            });
        let suggested = suggestion.as_ref().and_then(|s| {
            let year = matches!(s.coding, Coding::Out(WithdrawalCoding::IrdIncomeTax))
                .then(|| IncomeYear::containing(info.line.date));
            b.recode_saving(&[(info, Posting::Coded(s.coding.clone()), year)])
        });
        let (saving, best_case) = match suggested {
            Some(saving) => (Some(saving), false),
            None => {
                // At best, money in isn't income, and money out is all business spending.
                let best = match direction {
                    Direction::In => Some(Coding::In(DepositCoding::OwnerFunds)),
                    Direction::Out => estimate.clone().map(|account| {
                        Coding::Out(WithdrawalCoding::Expense {
                            account,
                            gst: GstCode::Standard,
                        })
                    }),
                };
                (
                    best.and_then(|c| b.recode_saving(&[(info, Posting::Coded(c), None)])),
                    true,
                )
            }
        };
        if let Some(saving) = saving {
            b.push(SaveTaxCard {
                lines: vec![info.view()],
                suggestion: if suggested.is_some() {
                    suggestion
                } else {
                    None
                },
                best_case,
                ..card(
                    format!("line:{}", info.line.id),
                    CardKind::Categorise,
                    saving,
                )
            });
        }
    }

    let mut cards = b.cards;
    cards.sort_by(|x, y| y.saving.cmp(&x.saving).then_with(|| x.id.cmp(&y.id)));
    Ok(SaveTaxQueue {
        total,
        conservative_total,
        saved_so_far: conservative_total - total,
        cards,
    })
}

/// `GET /api/businesses/{id}/save-tax`: the queue, biggest saving first.
pub async fn get_save_tax(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    _user: crate::auth::CurrentUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<axum::Json<SaveTaxQueue>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(axum::Json(queue(&mut conn, &id).await?))
}

/// A business's coding settings, for the accountant's settings form.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct CodingSettingsView {
    pub client_id: String,
    pub settings: CodingSettings,
}

/// `GET /api/businesses/{id}/coding-settings`.
pub async fn get_coding_settings(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    _user: crate::auth::CurrentUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<axum::Json<CodingSettingsView>, CommandError> {
    let mut conn = state.store.reader().await?;
    let books = books(&mut conn, &id).await?;
    Ok(axum::Json(CodingSettingsView {
        client_id: id,
        settings: books.settings,
    }))
}

/// `GET /api/businesses/{id}/rules`: the business's rules, oldest first.
pub async fn get_rules(
    axum::extract::State(state): axum::extract::State<crate::AppState>,
    _user: crate::auth::CurrentUser,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<axum::Json<Vec<Rule>>, CommandError> {
    let mut conn = state.store.reader().await?;
    business::business(&mut conn, &id).await?;
    Ok(axum::Json(coding_store::live_rules(&mut conn, &id).await?))
}
