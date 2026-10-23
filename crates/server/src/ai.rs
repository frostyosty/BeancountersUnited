//! AI category suggestions (ADR 009): consent, asking the suggester for the lines layers 1 to 3
//! couldn't answer, and turning its answers into pre-fills.
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
use std::sync::Arc;

use acct_ai::redact::{self, ExampleInput, LineInput};
use acct_ai::{Category, Confidence, Config, RawSuggestion, Suggester};
use acct_core::coding::{
    BankLine as CoreLine, Coding, CodingContext, DepositCoding, Direction, WithdrawalCoding,
    coded_lines,
};
use acct_core::{AccountType, GstCode, Money};
use acct_store::ai::{self as ai_store, AiSettings, StoredSuggestion};
use acct_store::bank as bank_store;
use acct_store::coding::{self as coding_store, LineStateKind};
use acct_store::{SqliteConnection, clients, new_id};
use axum::Json;
use axum::extract::{Path, State};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::access;
use crate::auth::CurrentUser;
use crate::business;
use crate::commands::{Command, CommandEnvelope, LineCoding, Via};
use crate::error::CommandError;
use crate::pipeline;
use crate::save_tax::{self, CardKind};

/// The consent wording's version (ADR 009: accepted 2026-10-23, with the 30-day retention period
/// filled in 2026-10-24). Change it whenever the wording changes; every business is then asked
/// again.
pub const CONSENT_WORDING: &str = "2026-10-24";

/// How many lines go in one request.
const BATCH: usize = 50;

/// The consent version for a provider: the wording's version and the provider's name, so a change
/// of either asks the owner again.
pub fn consent_version(provider: &str) -> String {
    format!("{CONSENT_WORDING}:{provider}")
}

/// The suggester the server's environment names, if any. A bad configuration is logged and
/// leaves suggestions off.
pub fn suggester_from_env() -> Option<Arc<dyn Suggester>> {
    let config = match Config::from_vars(|name| std::env::var(name).ok()) {
        Ok(Some(c)) => c,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!("AI suggestions are off: {e}");
            return None;
        }
    };
    match config.suggester() {
        Ok(s) => {
            tracing::info!(
                provider = %config.provider_name,
                model = %config.model,
                "AI suggestions are available"
            );
            Some(s)
        }
        Err(e) => {
            tracing::warn!("AI suggestions are off: {e}");
            None
        }
    }
}

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

/// Checks a consent version's shape: the current wording, and a provider.
fn check_consent_version(version: &str) -> Result<(), CommandError> {
    match version.split_once(':') {
        Some((wording, provider)) if wording == CONSENT_WORDING && !provider.trim().is_empty() => {
            Ok(())
        }
        _ => Err(CommandError::invalid(
            "consent_out_of_date",
            "That's not the current wording of the consent. Show the owner the current wording \
             and ask again.",
        )),
    }
}

/// `set_ai_suggestions`. Turning it on needs the consent version the owner agreed to. Turning it
/// off stops all requests and deletes the suggestions still waiting (ADR 009, "Retention").
/// `activity` and `private_names`, when absent, keep what's stored.
pub async fn set_ai_suggestions(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
    enabled: bool,
    consent_version: Option<&str>,
    activity: Option<&str>,
    private_names: Option<&[String]>,
) -> Result<(), CommandError> {
    business::business(tx, client_id).await?;
    let current = ai_store::settings(tx, client_id).await?;
    let consent_version = if enabled {
        let v = consent_version.ok_or_else(|| {
            CommandError::invalid(
                "consent_needed",
                "Turning suggestions on needs the owner's agreement to the consent wording.",
            )
        })?;
        check_consent_version(v)?;
        Some(v.to_owned())
    } else {
        None
    };
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
            consent_version,
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
    let enabled = ai_store::settings(tx, client_id)
        .await?
        .is_some_and(|s| s.enabled);
    if !enabled {
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
    } = via;
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

/// `GET /api/businesses/{id}/ai-suggestions`: whether suggestions can be asked for, the consent
/// state, and the suggestions waiting on the owner.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct AiSuggestionsView {
    /// The server has a suggester configured.
    pub available: bool,
    /// The provider's name, for the consent text.
    pub provider: Option<String>,
    pub model: Option<String>,
    /// The version to send with `set_ai_suggestions` once the owner agrees to the wording.
    pub consent_version: Option<String>,
    pub enabled: bool,
    /// On, but agreed to an older wording or another provider: ask again before any request.
    pub needs_consent: bool,
    pub activity: Option<String>,
    pub private_names: Vec<String>,
    pub suggestions: Vec<AiSuggestion>,
}

/// The view for a business, with the server's suggester.
pub async fn view(
    conn: &mut SqliteConnection,
    suggester: Option<&dyn Suggester>,
    client_id: &str,
) -> Result<AiSuggestionsView, CommandError> {
    business::business(conn, client_id).await?;
    let settings = ai_store::settings(conn, client_id).await?;
    let current = suggester.map(|s| consent_version(s.provider()));
    let enabled = settings.as_ref().is_some_and(|s| s.enabled);
    let needs_consent = enabled
        && current.is_some()
        && settings.as_ref().and_then(|s| s.consent_version.as_ref()) != current.as_ref();
    let suggestions = ai_store::live_suggestions(conn, client_id)
        .await?
        .into_iter()
        .map(AiSuggestion::of)
        .collect();
    Ok(AiSuggestionsView {
        available: suggester.is_some(),
        provider: suggester.map(|s| s.provider().to_owned()),
        model: suggester.map(|s| s.model().to_owned()),
        consent_version: current,
        enabled,
        needs_consent,
        activity: settings.as_ref().and_then(|s| s.activity.clone()),
        private_names: settings.map(|s| s.private_names).unwrap_or_default(),
        suggestions,
    })
}

pub async fn get_ai_suggestions(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<AiSuggestionsView>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(
        view(&mut conn, state.suggester.as_deref(), &id).await?,
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
    let Some(suggester) = state.suggester.clone() else {
        return Err(CommandError::invalid(
            "ai_unavailable",
            "AI suggestions aren't set up on this server.",
        ));
    };

    // 1. Read, then let the connection go.
    let prepared = {
        let mut conn = state.store.reader().await?;
        business::business(&mut conn, client_id).await?;
        let settings = ai_store::settings(&mut conn, client_id)
            .await?
            .filter(|s| s.enabled)
            .ok_or_else(|| {
                CommandError::invalid(
                    "ai_suggestions_off",
                    "AI suggestions are turned off for this business.",
                )
            })?;
        if settings.consent_version.as_deref() != Some(&consent_version(suggester.provider())) {
            return Err(CommandError::invalid(
                "consent_out_of_date",
                "The owner needs to agree to the current consent wording first.",
            ));
        }
        prepare(&mut conn, client_id, &settings).await?
    };

    // 2 and 3. Ask, with no transaction open, and check the answers.
    let names: Vec<&str> = prepared.private_names.iter().map(String::as_str).collect();
    let mut suggestions = Vec::new();
    let (mut dropped, mut failed_batches) = (0u32, 0u32);
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
        match suggester.suggest(request).await {
            Ok(answers) => {
                let (kept, d) = check_answers(batch, &prepared.categories, answers);
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

    // 4. Store them through the pipeline. A line sorted meanwhile rejects the command, so keep
    // only the lines still unsorted.
    let asked = u32::try_from(prepared.asks.len()).unwrap_or(u32::MAX);
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
        return Ok(AiSuggestRun {
            asked,
            suggestions: Vec::new(),
            dropped,
            failed_batches,
        });
    }
    let lines: BTreeSet<String> = suggestions.iter().map(|s| s.bank_line_id.clone()).collect();
    pipeline::submit(
        &state.store,
        &actor,
        CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command: Command::RecordSuggestions {
                client_id: client_id.to_owned(),
                model: suggester.model().to_owned(),
                suggestions,
            },
        },
        chrono::Utc::now(),
    )
    .await?;
    let mut conn = state.store.reader().await?;
    let suggestions = ai_store::live_suggestions(&mut conn, client_id)
        .await?
        .into_iter()
        .filter(|s| lines.contains(&s.bank_line_id))
        .map(AiSuggestion::of)
        .collect();
    Ok(AiSuggestRun {
        asked,
        suggestions,
        dropped,
        failed_batches,
    })
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

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn consent_versions_name_the_wording_and_provider() {
        assert_eq!(consent_version("Anthropic"), "2026-10-24:Anthropic");
        assert!(check_consent_version("2026-10-24:Anthropic").is_ok());
        assert!(check_consent_version("2026-10-23:Anthropic").is_err());
        assert!(check_consent_version("2026-01-01:Anthropic").is_err());
        assert!(check_consent_version("2026-10-24:").is_err());
        assert!(check_consent_version("yes").is_err());
    }
}
