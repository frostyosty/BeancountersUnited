//! AI category suggestions (ADR 009, ADR 011): turning them on or off, asking the suggester for the
//! lines layers 1 to 3 couldn't answer, and turning its answers into pre-fills. They're on by
//! default wherever the server has a suggester; ADR 011 removed the consent screen.
//!
//! The flow, from `POST /api/businesses/{id}/ai-suggestions`:
//! 1. Read the Save tax queue: its categorise cards with no rule or history suggestion are the
//!    lines to ask about. Layers 1 to 3 always win, and cost nothing.
//! 2. Build each request through `acct_ai::redact`, and call the suggester with no transaction
//!    open, because the single writer must never wait on the network.
//! 3. Check every answer: the reference is a line we sent, the category is one we offered, the GST
//!    code fits it, and the confidence isn't low. Anything else is dropped and counted.
//! 4. Submit `record_suggestions`, which stores the pre-fills and changes no figures.
//!
//! Accepting a pre-fill is the ordinary `code_bank_line(s)` with `via` (see [`accept_via`]).

use std::collections::{BTreeMap, BTreeSet, HashMap};

use acct_ai::explain;
use acct_ai::redact::{self, ExampleInput, LineInput};
use acct_ai::{Category, Confidence, RawSuggestion};
use acct_core::coding::{
    BankLine as CoreLine, Coding, CodingContext, DepositCoding, Direction, WithdrawalCoding,
    coded_lines,
};
use acct_core::{AccountType, GstCode, Money};
use acct_store::ai::{self as ai_store, AiSettings, StoredSuggestion};
use acct_store::ai_usage as usage_store;
use acct_store::bank as bank_store;
use acct_store::coding::{self as coding_store, LineStateKind};
use acct_store::users::Role;
use acct_store::{SqliteConnection, clients, new_id};
use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::access;
use crate::ai_limits::{LimitTable, Plan, env_limit, plan_of};
use crate::ai_usage::{AskCtx, Finish, Layers, Metered};
use crate::ai_watch::AiKind;
use crate::auth::CurrentUser;
use crate::business;
use crate::commands::{Command, CommandEnvelope, LineCoding, Via};
use crate::error::CommandError;
use crate::pipeline;
use crate::save_tax::{self, CardKind, SuggestionSource};

/// How many lines go in one request.
const BATCH: usize = 50;

/// How sure the model was of a suggestion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SuggestionConfidence {
    Low,
    Medium,
    High,
}

impl SuggestionConfidence {
    fn of(c: Confidence) -> SuggestionConfidence {
        match c {
            Confidence::Low => SuggestionConfidence::Low,
            Confidence::Medium => SuggestionConfidence::Medium,
            Confidence::High => SuggestionConfidence::High,
        }
    }

    fn text(self) -> &'static str {
        match self {
            SuggestionConfidence::Low => "low",
            SuggestionConfidence::Medium => "medium",
            SuggestionConfidence::High => "high",
        }
    }

    fn parse(s: &str) -> SuggestionConfidence {
        match s {
            "high" => SuggestionConfidence::High,
            "medium" => SuggestionConfidence::Medium,
            _ => SuggestionConfidence::Low,
        }
    }
}

/// One pre-fill in `record_suggestions`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SuggestedCoding {
    pub bank_line_id: String,
    pub coding: Coding,
    pub confidence: SuggestionConfidence,
}

/// A suggestion waiting on the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct AiSuggestion {
    pub id: String,
    pub bank_line_id: String,
    pub coding: Coding,
    pub model: String,
    pub confidence: SuggestionConfidence,
}

impl AiSuggestion {
    fn of(s: StoredSuggestion) -> AiSuggestion {
        AiSuggestion {
            confidence: SuggestionConfidence::parse(&s.confidence),
            id: s.id,
            bank_line_id: s.bank_line_id,
            coding: s.coding,
            model: s.model,
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Commands.

/// `set_ai_suggestions`. Turning it off stops all requests and deletes the suggestions still
/// waiting (ADR 009, "Retention"). `activity` and `private_names`, when absent, keep what's stored.
pub async fn set_ai_suggestions(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    enabled: bool,
    activity: Option<&str>,
    private_names: Option<&[String]>,
) -> Result<(), CommandError> {
    business::business(tx, client_id).await?;
    let current = ai_store::settings(tx, client_id).await?;
    let activity = match activity {
        Some(a) => {
            let a = a.split_whitespace().collect::<Vec<_>>().join(" ");
            if a.chars().count() > redact::MAX_CHARS {
                return Err(CommandError::invalid(
                    "activity_too_long",
                    format!(
                        "Describe the business in {} characters or fewer.",
                        redact::MAX_CHARS
                    ),
                ));
            }
            (!a.is_empty()).then_some(a)
        }
        None => current.as_ref().and_then(|c| c.activity.clone()),
    };
    let private_names = match private_names {
        Some(names) => names
            .iter()
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty())
            .collect(),
        None => current.map(|c| c.private_names).unwrap_or_default(),
    };
    ai_store::set_settings(
        tx,
        &AiSettings {
            client_id: client_id.to_owned(),
            enabled,
            activity,
            private_names,
            updated_seq: seq,
        },
    )
    .await?;
    if !enabled {
        ai_store::forget_client(tx, client_id).await?;
    }
    Ok(())
}

/// The kinds of coding a model may suggest: a category, personal spending, or money in that isn't
/// income. Transfers, IRD payments, asset purchases and partly private lines have their own
/// cards and questions.
pub(crate) fn suggestible(coding: &Coding) -> bool {
    matches!(
        coding,
        Coding::In(
            DepositCoding::Income { .. }
                | DepositCoding::OwnerFunds
                | DepositCoding::Loan
                | DepositCoding::PayeWages
                | DepositCoding::PersonalSale
        ) | Coding::Out(WithdrawalCoding::Expense { .. } | WithdrawalCoding::Personal)
    )
}

/// `record_suggestions`: stores pre-fills for unsorted lines. It changes no figures. Each line
/// must belong to the business and still be unsorted, and each coding must post on it.
pub async fn record_suggestions(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    model: &str,
    suggestions: &[SuggestedCoding],
) -> Result<(), CommandError> {
    let books = save_tax::books(tx, client_id).await?;
    if !ai_store::enabled(tx, client_id).await? {
        return Err(CommandError::invalid(
            "ai_suggestions_off",
            "AI suggestions are turned off for this business.",
        ));
    }
    if model.trim().is_empty() {
        return Err(CommandError::invalid(
            "no_model",
            "Say which model made the suggestions.",
        ));
    }
    let ctx = CodingContext {
        chart: &books.chart,
        settings: &books.settings,
        gst_registered_from: books.business.gst.map(|g| g.registered_from),
    };
    let mut seen = BTreeSet::new();
    for s in suggestions {
        if !seen.insert(s.bank_line_id.as_str()) {
            return Err(CommandError::invalid(
                "line_repeated",
                "The same line has two suggestions.",
            ));
        }
        if s.confidence == SuggestionConfidence::Low {
            return Err(CommandError::invalid(
                "low_confidence",
                "Low-confidence suggestions aren't kept.",
            ));
        }
        if !suggestible(&s.coding) {
            return Err(CommandError::invalid(
                "not_suggestible",
                "Only a category, personal spending or money that isn't income can be suggested.",
            ));
        }
        let line = bank_store::bank_line(tx, &s.bank_line_id)
            .await?
            .ok_or_else(|| CommandError::not_found("bank line", &s.bank_line_id))?;
        let account = books
            .accounts
            .iter()
            .find(|a| a.id == line.bank_account_id)
            .ok_or_else(|| CommandError::not_found("bank line", &s.bank_line_id))?;
        let state = coding_store::line_state(tx, &line.id).await?;
        if state.is_some_and(|st| st.state != LineStateKind::Unsorted) {
            return Err(CommandError::invalid(
                "line_already_sorted",
                "That line has been sorted already.",
            ));
        }
        let core = CoreLine {
            bank: &account.code,
            date: line.date,
            amount: line.amount,
        };
        coded_lines(&core, &s.coding, None, &ctx).map_err(|e| {
            CommandError::invalid_with(
                "invalid_coding",
                "A suggestion doesn't fit this business's chart.",
                &e,
            )
        })?;
        ai_store::insert_suggestion(
            tx,
            &StoredSuggestion {
                id: new_id(),
                client_id: client_id.to_owned(),
                bank_line_id: line.id.clone(),
                coding: s.coding.clone(),
                model: model.to_owned(),
                confidence: s.confidence.text().to_owned(),
                created_seq: seq,
                accepted_seq: None,
            },
        )
        .await?;
    }
    Ok(())
}

/// Checks a `via` inside the command's transaction, before it applies, and marks its suggestions
/// accepted. Each suggestion must be waiting on the owner, made by `via`'s model, and for a line
/// the command codes exactly as suggested. Applying the command then deletes nothing it accepted,
/// and a command that's rejected rolls this back too.
pub async fn accept_via(
    tx: &mut SqliteConnection,
    command: &Command,
    via: &Via,
    seq: i64,
) -> Result<(), CommandError> {
    let Via::Suggestion {
        model,
        suggestion_ids,
    } = via
    else {
        // A finding's fix (M18) accepts no suggestion.
        return Ok(());
    };
    let lines: &[LineCoding] = match command {
        Command::CodeBankLine { line } => std::slice::from_ref(line),
        Command::CodeBankLines { lines } => lines,
        _ => {
            return Err(CommandError::invalid(
                "invalid_via",
                "Only coding bank lines can accept suggestions.",
            ));
        }
    };
    let coded: HashMap<&str, &Coding> = lines
        .iter()
        .map(|l| (l.bank_line_id.as_str(), &l.coding))
        .collect();
    let mut seen = BTreeSet::new();
    for id in suggestion_ids {
        let mismatch = || {
            CommandError::invalid(
                "invalid_via",
                "A suggestion doesn't match what's being saved. Save it without the suggestion.",
            )
        };
        if !seen.insert(id.as_str()) {
            return Err(mismatch());
        }
        let s = ai_store::suggestion(tx, id)
            .await?
            .ok_or_else(|| CommandError::not_found("suggestion", id))?;
        if s.accepted_seq.is_some() || &s.model != model {
            return Err(mismatch());
        }
        match coded.get(s.bank_line_id.as_str()) {
            Some(c) if **c == s.coding => {}
            _ => return Err(mismatch()),
        }
        ai_store::accept(tx, id, seq).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Reads and the request.

/// `GET /api/businesses/{id}/ai-suggestions`: whether suggestions can be asked for, the business's
/// settings, and the suggestions waiting on the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct AiSuggestionsView {
    /// The server has a suggester configured.
    pub available: bool,
    /// The provider's name, as Save tax and the privacy notice show it.
    pub provider: Option<String>,
    pub model: Option<String>,
    /// On unless the business turned it off (ADR 011).
    pub enabled: bool,
    pub activity: Option<String>,
    pub private_names: Vec<String>,
    pub suggestions: Vec<AiSuggestion>,
    /// Asks allowed per day, or `None` for no limit.
    pub daily_limit: Option<u32>,
    /// Asks left today, or `None` for no limit.
    pub remaining_today: Option<u32>,
}

/// A business's settings, or the defaults when it has never changed them: on, with no activity
/// phrase or extra private names (ADR 011).
async fn settings_or_default(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<AiSettings, CommandError> {
    Ok(ai_store::settings(conn, client_id)
        .await?
        .unwrap_or_else(|| AiSettings {
            client_id: client_id.to_owned(),
            enabled: true,
            activity: None,
            private_names: Vec::new(),
            updated_seq: 0,
        }))
}

/// How many times a day each business may ask for suggestions, by plan (ADR 016, 4). This holds
/// only the numbers: the count is today's (UTC) rows in `ai_usage`, read when an ask begins, so a
/// restart doesn't reset anyone's day.
#[derive(Debug, Default)]
pub struct Quota {
    /// No limits unless the server sets some.
    limits: LimitTable,
}

impl Quota {
    pub fn new(limits: LimitTable) -> Quota {
        Quota { limits }
    }

    /// The plan table, with `ACCT_AI_DAILY_LIMIT` overriding the Free plan's number.
    pub fn from_env() -> Quota {
        Quota::new(LimitTable::from_env())
    }

    /// Asks per business per day (UTC) on `plan`; `None` is no limit.
    pub fn limit(&self, plan: Plan) -> Option<u32> {
        self.limits.get(plan, AiKind::Suggestion)
    }
}

/// The server-wide daily cap on explanations: `base`, plus `per_guest` for every guest who signed
/// up in the last 24 hours, so it grows with real interest and bounds the worst-case bill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GlobalCap {
    pub base: u32,
    pub per_guest: u32,
}

impl GlobalCap {
    pub fn for_guests(self, guests: i64) -> u32 {
        let guests = u32::try_from(guests.max(0)).unwrap_or(u32::MAX);
        self.base
            .saturating_add(self.per_guest.saturating_mul(guests))
    }
}

/// The daily limits on "Explain better" (a guest costs us money, so abuse is worth bounding): per
/// business by plan (a trial has its own, lower one), per client address, and one across
/// everyone. `None` is no limit. Every refusal is the same `ai_daily_limit`, so the owner sees one
/// message whichever limit was hit.
///
/// The business and global limits are counted from `ai_usage` (ADR 016, 5). Addresses aren't
/// stored, so the per-address count stays in memory and a restart resets only that one.
#[derive(Debug)]
pub struct ExplainLimits {
    limits: LimitTable,
    per_address: Option<u32>,
    global: Option<GlobalCap>,
    addresses: std::sync::Mutex<BTreeMap<(String, chrono::NaiveDate), u32>>,
}

impl Default for ExplainLimits {
    /// No limits, for tests and tools.
    fn default() -> ExplainLimits {
        ExplainLimits::new(LimitTable::unlimited(), None, None)
    }
}

impl ExplainLimits {
    pub fn new(
        limits: LimitTable,
        per_address: Option<u32>,
        global: Option<GlobalCap>,
    ) -> ExplainLimits {
        ExplainLimits {
            limits,
            per_address,
            global,
            addresses: std::sync::Mutex::default(),
        }
    }

    /// From the environment, per day (UTC); `0` or `off` for none:
    /// - the plan table, with `ACCT_AI_EXPLAIN_LIMIT` (per business, 5) and
    ///   `ACCT_AI_EXPLAIN_GUEST_LIMIT` (per trial, 2) overriding the Free and Guest cells;
    /// - `ACCT_AI_EXPLAIN_IP_LIMIT`: per client address, 10;
    /// - `ACCT_AI_EXPLAIN_GLOBAL_LIMIT`: across everyone, 50 plus
    ///   `ACCT_AI_EXPLAIN_GLOBAL_PER_GUEST` (2) for each guest who signed up in the last 24 hours.
    pub fn from_env() -> ExplainLimits {
        let global = env_limit("ACCT_AI_EXPLAIN_GLOBAL_LIMIT", 50).map(|base| GlobalCap {
            base,
            per_guest: env_limit("ACCT_AI_EXPLAIN_GLOBAL_PER_GUEST", 2).unwrap_or(0),
        });
        ExplainLimits::new(
            LimitTable::from_env(),
            env_limit("ACCT_AI_EXPLAIN_IP_LIMIT", 10),
            global,
        )
    }

    /// Explanations per business per day (UTC) on `plan`; `None` is no limit.
    pub fn limit(&self, plan: Plan) -> Option<u32> {
        self.limits.get(plan, AiKind::Explain)
    }

    pub fn global(&self) -> Option<GlobalCap> {
        self.global
    }

    /// Spends one of `address`'s explanations on `day`. False when none are left. Checked last,
    /// after the limits that are counted from `ai_usage`, because it's the only one that spends
    /// anything when it passes.
    pub fn take_address(&self, address: &str, day: chrono::NaiveDate) -> bool {
        let Some(limit) = self.per_address else {
            return true;
        };
        let mut used = self.addresses.lock().unwrap_or_else(|e| e.into_inner());
        used.retain(|(_, d), _| *d >= day);
        let n = used.entry((address.to_owned(), day)).or_insert(0);
        if *n >= limit {
            return false;
        }
        *n += 1;
        true
    }
}

/// The view for a business, with the server's suggester. The daily limit and what's left of it
/// come from the plan and from `ai_usage`; an overseer has none (ADR 016, 8).
pub async fn view(
    conn: &mut SqliteConnection,
    suggester: Option<&Metered>,
    quota: &Quota,
    user: &CurrentUser,
    client_id: &str,
) -> Result<AiSuggestionsView, CommandError> {
    business::business(conn, client_id).await?;
    let settings = settings_or_default(conn, client_id).await?;
    let suggestions = ai_store::live_suggestions(conn, client_id)
        .await?
        .into_iter()
        .map(AiSuggestion::of)
        .collect();
    let actor = user.actor();
    let (daily_limit, remaining_today) = if actor.role == Role::Overseer {
        (None, None)
    } else {
        let limit = quota.limit(plan_of(conn, &actor, client_id).await?);
        let remaining = match limit {
            Some(limit) => {
                let today = chrono::Utc::now().date_naive();
                let used = usage_store::count_for_business(
                    conn,
                    client_id,
                    AiKind::Suggestion.as_str(),
                    today,
                )
                .await?;
                Some(limit.saturating_sub(used))
            }
            None => None,
        };
        (limit, remaining)
    };
    Ok(AiSuggestionsView {
        available: suggester.is_some(),
        provider: suggester.map(|s| s.provider().to_owned()),
        model: suggester.map(|s| s.model().to_owned()),
        enabled: settings.enabled,
        activity: settings.activity,
        private_names: settings.private_names,
        suggestions,
        daily_limit,
        remaining_today,
    })
}

pub async fn get_ai_suggestions(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<AiSuggestionsView>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(
        view(
            &mut conn,
            state.suggester.as_deref(),
            &state.ai_quota,
            &user,
            &id,
        )
        .await?,
    ))
}

/// What a request for suggestions did.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct AiSuggestRun {
    /// Lines sent to the suggester.
    pub asked: u32,
    /// The new pre-fills.
    pub suggestions: Vec<AiSuggestion>,
    /// Answers dropped: low confidence, or not something we offered.
    pub dropped: u32,
    /// Batches the suggester couldn't answer, such as when the service was unreachable.
    pub failed_batches: u32,
}

/// A line to ask about.
struct Ask {
    bank_line_id: String,
    amount: Money,
    description: String,
}

/// A coded line, as an example for the model.
struct Coded {
    amount: Money,
    description: String,
    key: String,
    gst: GstCode,
}

/// Everything a run reads before calling the suggester.
struct Prepared {
    asks: Vec<Ask>,
    /// What the first three layers answered, counted from the queue (ADR 016, 2).
    layers: Layers,
    categories: Vec<Category>,
    history: Vec<Coded>,
    activity: Option<String>,
    private_names: Vec<String>,
}

/// Special category keys, for codings that name no account.
const SPECIAL: [(&str, &str, Direction); 5] = [
    (
        "personal",
        "Personal spending (not for the business)",
        Direction::Out,
    ),
    (
        "owner_funds",
        "Money the owner put in (not income)",
        Direction::In,
    ),
    ("loan", "A loan received (not income)", Direction::In),
    (
        "paye_wages",
        "Wages already taxed through PAYE (not income)",
        Direction::In,
    ),
    (
        "personal_sale",
        "Sale of a personal item (not income)",
        Direction::In,
    ),
];

/// A coding's category key and GST code, for codings a model may suggest.
fn category_of(coding: &Coding) -> Option<(String, GstCode)> {
    Some(match coding {
        Coding::In(DepositCoding::Income { account, gst })
        | Coding::Out(WithdrawalCoding::Expense { account, gst }) => (account.to_string(), *gst),
        Coding::Out(WithdrawalCoding::Personal) => ("personal".to_owned(), GstCode::None),
        Coding::In(DepositCoding::OwnerFunds) => ("owner_funds".to_owned(), GstCode::None),
        Coding::In(DepositCoding::Loan) => ("loan".to_owned(), GstCode::None),
        Coding::In(DepositCoding::PayeWages) => ("paye_wages".to_owned(), GstCode::None),
        Coding::In(DepositCoding::PersonalSale) => ("personal_sale".to_owned(), GstCode::None),
        _ => return None,
    })
}

/// The coding for a category the model chose, if the GST code fits it.
fn coding_for(category: &Category, gst: GstCode) -> Option<Coding> {
    let account = || category.key.parse().ok();
    Some(match (category.direction, category.key.as_str()) {
        (Direction::Out, "personal") => Coding::Out(WithdrawalCoding::Personal),
        (Direction::In, "owner_funds") => Coding::In(DepositCoding::OwnerFunds),
        (Direction::In, "loan") => Coding::In(DepositCoding::Loan),
        (Direction::In, "paye_wages") => Coding::In(DepositCoding::PayeWages),
        (Direction::In, "personal_sale") => Coding::In(DepositCoding::PersonalSale),
        (Direction::In, _) if gst != GstCode::None => Coding::In(DepositCoding::Income {
            account: account()?,
            gst,
        }),
        (Direction::In, _) => return None,
        (Direction::Out, _) => Coding::Out(WithdrawalCoding::Expense {
            account: account()?,
            gst,
        }),
    })
}

/// The categories a business is offered: its active income and expense accounts, less the "not
/// yet sorted" holding accounts, then the kinds that name no account. `fixtures/ai/labelled-lines.json`
/// holds the sole trader's, and a test keeps the two the same.
fn categories_for(chart: &acct_core::Chart, holding: &[&acct_core::AccountCode]) -> Vec<Category> {
    let mut categories: Vec<Category> = chart
        .accounts()
        .iter()
        .filter(|a| a.active && !holding.contains(&&a.code))
        .filter_map(|a| {
            let direction = match a.account_type {
                AccountType::Income => Direction::In,
                AccountType::Expense => Direction::Out,
                _ => return None,
            };
            Some(Category {
                key: a.code.to_string(),
                name: a.name.clone(),
                direction,
            })
        })
        .collect();
    categories.extend(SPECIAL.iter().map(|(key, name, direction)| Category {
        key: (*key).to_owned(),
        name: (*name).to_owned(),
        direction: *direction,
    }));
    categories
}

async fn prepare(
    conn: &mut SqliteConnection,
    client_id: &str,
    settings: &AiSettings,
) -> Result<Prepared, CommandError> {
    let queue = save_tax::queue(conn, client_id).await?;
    let mut layers = Layers::default();
    for card in queue
        .cards
        .iter()
        .filter(|c| c.kind == CardKind::Categorise)
    {
        layers.lines_total += 1;
        match card.suggestion.as_ref().map(|s| s.source) {
            Some(SuggestionSource::Rule) => layers.by_rules += 1,
            Some(SuggestionSource::History) => layers.by_history += 1,
            Some(SuggestionSource::Merchant) => layers.by_merchants += 1,
            // A pre-fill from an earlier run is already waiting; nothing is asked about it.
            Some(SuggestionSource::Ai) | None => {}
        }
    }
    let asks: Vec<Ask> = queue
        .cards
        .into_iter()
        .filter(|c| c.kind == CardKind::Categorise && c.suggestion.is_none())
        .filter_map(|c| c.lines.into_iter().next())
        .map(|l| Ask {
            bank_line_id: l.bank_line_id,
            amount: l.amount,
            description: l.description,
        })
        .collect();
    layers.lines_asked = u32::try_from(asks.len()).unwrap_or(u32::MAX);

    let books = save_tax::books(conn, client_id).await?;
    let categories = categories_for(
        &books.chart,
        &[
            &books.business.holding.money_in,
            &books.business.holding.money_out,
        ],
    );

    let lines: HashMap<String, (Money, String)> = bank_store::bank_lines(conn, client_id)
        .await?
        .into_iter()
        .map(|l| (l.id, (l.amount, l.description)))
        .collect();
    let history = coding_store::line_states(conn, client_id)
        .await?
        .into_iter()
        .filter(|s| s.state == LineStateKind::Coded)
        .filter_map(|s| {
            let (key, gst) = category_of(s.coding.as_ref()?)?;
            let (amount, description) = lines.get(&s.bank_line_id)?.clone();
            Some(Coded {
                amount,
                description,
                key,
                gst,
            })
        })
        .collect();

    let client = clients::get(conn, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", client_id))?;
    let mut private_names = settings.private_names.clone();
    private_names.push(client.name);
    Ok(Prepared {
        asks,
        layers,
        categories,
        history,
        activity: settings.activity.clone(),
        private_names,
    })
}

fn words(text: &str) -> BTreeSet<String> {
    text.split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() > 2 && !w.chars().all(|c| c.is_ascii_digit()))
        .map(str::to_uppercase)
        .collect()
}

/// Up to five coded lines that share the most words with the batch's descriptions.
fn examples_for<'a>(history: &'a [Coded], batch: &[Ask]) -> Vec<ExampleInput<'a>> {
    let wanted: BTreeSet<String> = batch.iter().flat_map(|a| words(&a.description)).collect();
    let mut scored: Vec<(usize, &Coded)> = history
        .iter()
        .map(|h| (words(&h.description).intersection(&wanted).count(), h))
        .filter(|(score, _)| *score > 0)
        .collect();
    scored.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.description.cmp(&b.1.description))
    });
    let mut seen = BTreeSet::new();
    scored
        .into_iter()
        .filter(|(_, h)| seen.insert(h.description.to_uppercase()))
        .take(redact::MAX_EXAMPLES)
        .map(|(_, h)| ExampleInput {
            amount: h.amount,
            description: &h.description,
            category: &h.key,
            gst: h.gst,
        })
        .collect()
}

/// Checks the suggester's answers for one batch. Returns the pre-fills and how many were dropped.
fn check_answers(
    batch: &[Ask],
    categories: &[Category],
    answers: Vec<RawSuggestion>,
) -> (Vec<SuggestedCoding>, u32) {
    let mut kept: BTreeMap<usize, SuggestedCoding> = BTreeMap::new();
    let mut dropped = 0;
    for answer in answers {
        let index = (answer.reference as usize).checked_sub(1);
        let ask = index.and_then(|i| batch.get(i).map(|a| (i, a)));
        let checked = ask.and_then(|(i, ask)| {
            let direction = Direction::of(ask.amount)?;
            let category = categories
                .iter()
                .find(|c| c.key == answer.category && c.direction == direction)?;
            let coding = coding_for(category, answer.gst)?;
            (answer.confidence != Confidence::Low && !kept.contains_key(&i)).then(|| {
                (
                    i,
                    SuggestedCoding {
                        bank_line_id: ask.bank_line_id.clone(),
                        coding,
                        confidence: SuggestionConfidence::of(answer.confidence),
                    },
                )
            })
        });
        match checked {
            Some((i, s)) => {
                kept.insert(i, s);
            }
            None => dropped += 1,
        }
    }
    (kept.into_values().collect(), dropped)
}

/// Asks the suggester about a business's unsorted lines and stores what it suggests as pre-fills.
pub async fn suggest(
    state: &AppState,
    user: &CurrentUser,
    client_id: &str,
) -> Result<AiSuggestRun, CommandError> {
    let actor = user.actor();
    // The route's access layer has checked this already; `suggest` checks again because it's
    // also called directly, and it spends the AI provider's time before any command runs.
    {
        let mut conn = state.store.reader().await?;
        access::check(
            &mut conn,
            &actor,
            &access::Target::Client(access::ClientRef {
                client_id: client_id.to_owned(),
                named: ("client", client_id.to_owned()),
            }),
            access::Need::Owner,
        )
        .await?;
    }
    let Some(metered) = state.suggester.clone() else {
        return Err(CommandError::invalid(
            "ai_unavailable",
            "AI suggestions aren't set up on this server.",
        ));
    };

    // 1. Read, then let the connection go.
    let prepared = {
        let mut conn = state.store.reader().await?;
        business::business(&mut conn, client_id).await?;
        let settings = settings_or_default(&mut conn, client_id).await?;
        if !settings.enabled {
            return Err(CommandError::invalid(
                "ai_suggestions_off",
                "AI suggestions are turned off for this business.",
            ));
        }
        prepare(&mut conn, client_id, &settings).await?
    };

    // Begin the ask (ADR 016, 1). Only a run with something to send is limited: one that layers 1
    // to 3 answered completely costs nothing, and still writes its row for the AI share. Every
    // path from here ends in `finish`, which writes the ask's one row.
    let mut ask = metered
        .begin(
            state,
            AskCtx {
                kind: AiKind::Suggestion,
                user,
                client_id,
                address: None,
                layers: Some(prepared.layers),
                sends_to_model: !prepared.asks.is_empty(),
            },
        )
        .await?;

    // 2 and 3. Ask, with no transaction open, and check the answers.
    let names: Vec<&str> = prepared.private_names.iter().map(String::as_str).collect();
    let mut suggestions = Vec::new();
    let (mut dropped, mut failed_batches) = (0u32, 0u32);
    let (mut answered, mut kept_answers) = (0usize, 0usize);
    for batch in prepared.asks.chunks(BATCH) {
        let lines: Vec<LineInput<'_>> = batch
            .iter()
            .map(|a| LineInput {
                amount: a.amount,
                description: &a.description,
            })
            .collect();
        let examples = examples_for(&prepared.history, batch);
        let request = redact::request(&redact::Input {
            lines: &lines,
            categories: &prepared.categories,
            examples: &examples,
            activity: prepared.activity.as_deref(),
            private_names: &names,
        });
        match ask.suggestions(request).await {
            Ok(answers) => {
                answered += answers.len();
                let (kept, d) = check_answers(batch, &prepared.categories, answers);
                kept_answers += kept.len();
                suggestions.extend(kept);
                dropped += d;
            }
            Err(e) => {
                // The error never holds a body, so it's safe to log.
                tracing::warn!(error = %e, "an AI suggestion request failed");
                failed_batches += 1;
            }
        }
    }
    if dropped > 0 {
        tracing::info!(dropped, "AI suggestions dropped as unusable");
    }

    // 4. Store them through the pipeline, then end the ask: its row says how many pre-fills the
    // run stored, and none if storing them failed.
    let asked = u32::try_from(prepared.asks.len()).unwrap_or(u32::MAX);
    let stored = store_prefills(state, &actor, client_id, metered.model(), suggestions).await;
    let count = |n: usize| u32::try_from(n).unwrap_or(u32::MAX);
    ask.finish(Finish {
        answered: count(answered),
        kept: count(kept_answers),
        by_model: stored.as_ref().map_or(0, |s| count(s.len())),
    })
    .await;
    Ok(AiSuggestRun {
        asked,
        suggestions: stored?,
        dropped,
        failed_batches,
    })
}

/// Stores the checked answers as pre-fills and returns the ones now waiting on the owner. A line
/// sorted meanwhile would reject the command, so only the lines still unsorted are kept.
async fn store_prefills(
    state: &AppState,
    actor: &pipeline::Actor,
    client_id: &str,
    model: &str,
    mut suggestions: Vec<SuggestedCoding>,
) -> Result<Vec<AiSuggestion>, CommandError> {
    if !suggestions.is_empty() {
        let unsorted: BTreeSet<String> = {
            let mut conn = state.store.reader().await?;
            let sorted: BTreeSet<String> = coding_store::line_states(&mut conn, client_id)
                .await?
                .into_iter()
                .filter(|s| s.state != LineStateKind::Unsorted)
                .map(|s| s.bank_line_id)
                .collect();
            suggestions
                .iter()
                .map(|s| s.bank_line_id.clone())
                .filter(|id| !sorted.contains(id))
                .collect()
        };
        suggestions.retain(|s| unsorted.contains(&s.bank_line_id));
    }
    if suggestions.is_empty() {
        return Ok(Vec::new());
    }
    let lines: BTreeSet<String> = suggestions.iter().map(|s| s.bank_line_id.clone()).collect();
    pipeline::submit(
        &state.store,
        actor,
        CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command: Command::RecordSuggestions {
                client_id: client_id.to_owned(),
                model: model.to_owned(),
                suggestions,
            },
        },
        chrono::Utc::now(),
    )
    .await?;
    let mut conn = state.store.reader().await?;
    Ok(ai_store::live_suggestions(&mut conn, client_id)
        .await?
        .into_iter()
        .filter(|s| lines.contains(&s.bank_line_id))
        .map(AiSuggestion::of)
        .collect())
}

/// `POST /api/businesses/{id}/ai-suggestions`: asks for suggestions for the business's unsorted
/// lines. They're stored as pre-fills and never applied until the owner accepts them.
pub async fn post_ai_suggestions(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<AiSuggestRun>, CommandError> {
    Ok(Json(suggest(&state, &user, &id).await?))
}

// ---------------------------------------------------------------------------------------------
// "Explain better".

/// `POST /api/businesses/{id}/explain`: which card to explain.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct ExplainRequest {
    /// A card's `id` in the business's Save tax queue.
    pub card_id: String,
}

/// An explanation of one card, written for this owner's situation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct Explanation {
    pub text: String,
    pub model: String,
}

fn whole_dollars(m: Money) -> i64 {
    m.cents().abs() / 100
}

/// Our own words for what a card asks and why it matters. The model gets these, never the
/// browser's text.
fn card_wording(card: &save_tax::SaveTaxCard) -> (String, String) {
    use save_tax::Question;
    let money_in = card.lines.first().is_some_and(|l| l.amount.cents() >= 0);
    let (heading, background) = match card.kind {
        CardKind::Question => match card.question {
            Some(Question::OnlyIncome) => (
                "Was this business the owner's only income for the year?",
                "Until answered, tax is worked out as if the owner earns enough elsewhere to pay the top rate of 39%.",
            ),
            Some(Question::StudentLoan) => (
                "Did the owner have a student loan during the year?",
                "Until answered, 12% is set aside for student loan repayments.",
            ),
            Some(Question::OtherIncome) => (
                "What other income did the owner have for the year?",
                "Wages, benefits or interest from elsewhere change which tax rates apply to the business profit, and tax already deducted from it is credited.",
            ),
            Some(Question::Ietc) => (
                "How many months could the owner get the independent earner tax credit?",
                "The credit is up to $10 a week, but is not available for months with Working for Families, NZ Super, a main benefit or a student allowance.",
            ),
            Some(Question::GstRegistered) => (
                "Is the business registered for GST?",
                "Registration is only assumed from the statements. If the business is not registered, GST is not claimed or charged.",
            ),
            None => (
                "A question about the owner",
                "The answer changes the tax worked out.",
            ),
        },
        CardKind::Transfer => (
            "Did this money move between the owner's own accounts?",
            "Money moved between your own accounts is not income or spending, so it should not be taxed or claimed.",
        ),
        CardKind::IrdPayment => (
            if money_in {
                "Is this a GST refund from IRD?"
            } else {
                "Is this a payment to IRD?"
            },
            "A refund of GST is not income. Tax already paid to IRD is credited against what is owed, and which tax it was for matters.",
        ),
        CardKind::Duplicate => (
            "Is this the same transaction listed twice?",
            "Two statements both seem to have this line. A real duplicate should be counted once.",
        ),
        CardKind::Gap => (
            "A bank statement is missing for some days",
            "The rise in the balance over the gap is counted as income until the statement shows what it was.",
        ),
        CardKind::SupplyInfo => (
            "Does the owner have the tax invoice for this purchase?",
            "For spending over $200, GST can be claimed back only with the supplier's tax invoice showing their GST number, kept for seven years.",
        ),
        CardKind::Categorise => (
            if money_in {
                "What was this money?"
            } else {
                "What was this spending?"
            },
            if money_in {
                "Until sorted, money in is counted as income the business earned, so it is taxed."
            } else {
                "Until sorted, spending does not count as a business cost, so it brings nothing off the tax."
            },
        ),
        CardKind::Reconcile => (
            "The books and the bank do not agree",
            "Until they agree, the tax figure could be off, so it is worth sorting first.",
        ),
    };
    let mut background = background.to_owned();
    if let Some(gap) = &card.gap {
        background.push_str(&format!(
            " The balance rose by ${} over the missing days.",
            whole_dollars(gap.change)
        ));
    }
    if let Some(r) = &card.reconcile {
        background.push_str(&format!(
            " The difference is ${}.",
            whole_dollars(r.difference)
        ));
    }
    (heading.to_owned(), background)
}

/// Writes a longer explanation of one Save tax card, within the day's explanation allowance.
pub async fn explain_card(
    state: &AppState,
    user: &CurrentUser,
    client_id: &str,
    card_id: &str,
    address: &str,
) -> Result<Explanation, CommandError> {
    let actor = user.actor();
    {
        let mut conn = state.store.reader().await?;
        access::check(
            &mut conn,
            &actor,
            &access::Target::Client(access::ClientRef {
                client_id: client_id.to_owned(),
                named: ("client", client_id.to_owned()),
            }),
            access::Need::Owner,
        )
        .await?;
    }
    let Some(metered) = state.suggester.clone() else {
        return Err(CommandError::invalid(
            "ai_unavailable",
            "Explanations aren't set up on this server.",
        ));
    };
    let (card, settings, private_names) = {
        let mut conn = state.store.reader().await?;
        let settings = settings_or_default(&mut conn, client_id).await?;
        if !settings.enabled {
            return Err(CommandError::invalid(
                "ai_suggestions_off",
                "The experts are turned off for this business.",
            ));
        }
        let queue = save_tax::queue(&mut conn, client_id).await?;
        let card = queue
            .cards
            .into_iter()
            .find(|c| c.id == card_id)
            .ok_or_else(|| CommandError::not_found("card", card_id))?;
        let client = clients::get(&mut conn, client_id)
            .await?
            .ok_or_else(|| CommandError::not_found("client", client_id))?;
        let mut names = settings.private_names.clone();
        names.push(client.name);
        (card, settings, names)
    };

    // Begin the ask (ADR 016, 1): the limits and the budget cap are checked here, and a refusal
    // writes its row. From here every path ends in `finish`.
    let mut ask = metered
        .begin(
            state,
            AskCtx {
                kind: AiKind::Explain,
                user,
                client_id,
                address: Some(address),
                layers: None,
                sends_to_model: true,
            },
        )
        .await?;

    let (heading, background) = card_wording(&card);
    let lines: Vec<(Money, &str)> = card
        .lines
        .iter()
        .map(|l| (l.amount, l.description.as_str()))
        .collect();
    let names: Vec<&str> = private_names.iter().map(String::as_str).collect();
    let request = explain::request(&explain::Input {
        heading: &heading,
        background: &background,
        lines: &lines,
        saving_dollars: whole_dollars(card.saving),
        best_case: card.best_case,
        activity: settings.activity.as_deref(),
        private_names: &names,
    });
    let answer = ask.explanation(request).await;
    ask.finish(Finish::default()).await;
    match answer {
        Ok(text) => Ok(Explanation {
            text,
            model: metered.model().to_owned(),
        }),
        Err(e) => {
            // The error never holds a body, so it's safe to log.
            tracing::warn!(error = %e, "an AI explanation request failed");
            Err(CommandError::invalid(
                "ai_failed",
                "The experts couldn't be reached. Try again in a minute.",
            ))
        }
    }
}

/// `POST /api/businesses/{id}/explain`.
pub async fn post_explain(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    parts: axum::http::request::Parts,
    Json(req): Json<ExplainRequest>,
) -> Result<Json<Explanation>, CommandError> {
    let address = crate::guests::client_address(&parts.headers, &parts.extensions);
    Ok(Json(
        explain_card(&state, &user, &id, &req.card_id, &address).await?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_quota_takes_its_numbers_from_the_plan_table() {
        let q =
            Quota::new(LimitTable::standard().with(Plan::Practice, AiKind::Suggestion, Some(4)));
        assert_eq!(q.limit(Plan::Free), Some(1));
        assert_eq!(q.limit(Plan::Practice), Some(4));
        assert_eq!(Quota::default().limit(Plan::Free), None);
    }

    #[test]
    fn explanation_limits_are_looked_up_by_plan() {
        let l = ExplainLimits::new(LimitTable::standard(), None, None);
        assert_eq!(l.limit(Plan::Free), Some(5));
        assert_eq!(
            l.limit(Plan::Guest),
            Some(2),
            "a trial has fewer than an owner"
        );
        assert_eq!(ExplainLimits::default().limit(Plan::Guest), None);
    }

    #[test]
    fn the_address_limit_is_per_address_and_per_day() {
        let day = chrono::NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
        let next = day.succ_opt().unwrap();
        let l = ExplainLimits::new(LimitTable::unlimited(), Some(2), None);
        assert!(l.take_address("ip", day) && l.take_address("ip", day));
        assert!(!l.take_address("ip", day), "the address is used up");
        assert!(l.take_address("other", day), "another address has its own");
        assert!(l.take_address("ip", next), "tomorrow is a fresh day");
        let none = ExplainLimits::default();
        assert!(none.take_address("ip", day) && none.take_address("ip", day));
    }

    #[test]
    fn the_global_cap_grows_with_the_guests_who_signed_up() {
        let cap = GlobalCap {
            base: 2,
            per_guest: 3,
        };
        assert_eq!(cap.for_guests(0), 2);
        assert_eq!(cap.for_guests(4), 14);
        assert_eq!(cap.for_guests(-1), 2);
    }

    fn cat(key: &str, direction: Direction) -> Category {
        Category {
            key: key.to_owned(),
            name: key.to_owned(),
            direction,
        }
    }

    fn ask(id: &str, cents: i64) -> Ask {
        Ask {
            bank_line_id: id.to_owned(),
            amount: Money::from_cents(cents),
            description: "X".to_owned(),
        }
    }

    fn raw(reference: u32, category: &str, gst: GstCode, confidence: Confidence) -> RawSuggestion {
        RawSuggestion {
            reference,
            category: category.to_owned(),
            gst,
            confidence,
        }
    }

    #[test]
    fn answers_are_checked_against_what_was_sent() {
        use Confidence::{High, Low, Medium};
        let batch = [ask("a", -1000), ask("b", 2000), ask("c", -500)];
        let categories = [
            cat("255", Direction::Out),
            cat("100", Direction::In),
            cat("personal", Direction::Out),
        ];
        let answers = vec![
            raw(1, "255", GstCode::Standard, High),
            raw(1, "personal", GstCode::None, High), // a second answer for line 1
            raw(2, "255", GstCode::Standard, High),  // an out category for money in
            raw(2, "100", GstCode::None, High),      // income outside GST
            raw(3, "999", GstCode::Standard, High),  // not offered
            raw(4, "255", GstCode::Standard, High),  // no such line
            raw(0, "255", GstCode::Standard, High),  // no such line
            raw(3, "personal", GstCode::None, Low),  // low confidence
            raw(3, "personal", GstCode::Standard, Medium),
        ];
        let (kept, dropped) = check_answers(&batch, &categories, answers);
        assert_eq!(dropped, 7);
        assert_eq!(kept.len(), 2);
        assert_eq!(kept[0].bank_line_id, "a");
        assert_eq!(
            kept[1].coding,
            Coding::Out(WithdrawalCoding::Personal),
            "personal ignores the GST code"
        );
    }

    #[test]
    fn the_labelled_set_offers_what_save_tax_offers_a_sole_trader() {
        let accounts: Vec<acct_core::Account> = serde_json::from_str(include_str!(
            "../../../fixtures/practice/sole-trader-chart.json"
        ))
        .unwrap();
        let chart = acct_core::Chart::new(accounts).unwrap();
        let holding: [acct_core::AccountCode; 2] = ["140".parse().unwrap(), "965".parse().unwrap()];
        let offered: Vec<(String, String, Direction)> =
            categories_for(&chart, &[&holding[0], &holding[1]])
                .into_iter()
                .map(|c| (c.key, c.name, c.direction))
                .collect();
        let set = acct_ai::eval::LabelledSet::parse(include_str!(
            "../../../fixtures/ai/labelled-lines.json"
        ))
        .unwrap();
        let labelled: Vec<(String, String, Direction)> = set
            .categories
            .into_iter()
            .map(|c| (c.key, c.name, c.direction))
            .collect();
        assert_eq!(
            labelled, offered,
            "rebuild the set with tools/ai-labelled-lines/generate.py"
        );
    }
}
