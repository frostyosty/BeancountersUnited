//! Guests: trying it on the home page with no sign-up (M20, ADR 014).
//!
//! A guest is a `business_owner` user with no credentials (`users::User::is_guest`) and a business
//! they own, made by `start_guest` when a visitor drops a file or uses an example. Every owner
//! screen already works for them. This module holds:
//! - the guest commands: `start_guest`, `add_guest_business`, `claim_guest`,
//!   `adopt_guest_business`, `expire_guest` and `set_gst_registration`, applied in their command's
//!   transaction;
//! - GST registration from a business's own statements: detected, else assumed (ADR 014, 3);
//! - the pipeline's refusal step for guests, and the routes a guest may use;
//! - the abuse limits (ADR 014, 8): per address in memory, per guest and for all guests from the
//!   database;
//! - the sweep, which ends trials nobody came back to;
//! - the routes `POST /api/guest`, `POST /api/guest/claim` and `POST /api/guest/adopt`.
//!
//! Deny by default: [`GUEST_ALLOWED`] lists the command kinds a guest may submit. Everything else
//! is refused before it's validated, so a new command is refused for guests until someone adds it
//! there. [`GUEST_REFUSED`] only says why for the ones we expect; `tests/guests.rs` fails unless
//! every kind is on exactly one of the two.
//!
//! A visitor's file never reaches a log line or an error report: nothing here traces a file's
//! name, contents or descriptions.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex};

use acct_core::tax::gst::{
    DEFAULT_FREQUENCY, DetectLine, GstDetection, GstFrequency, detect_registration,
};
use acct_core::tax::income_tax::IncomeYear;
use acct_store::bank::{self as bank_store, GstSetting};
use acct_store::guests::{self as store, GstSource};
use acct_store::tenancy::{self, Access};
use acct_store::users::{self, Role, User};
use acct_store::{SqliteConnection, Store, log, new_id, sessions};
use axum::Json;
use axum::extract::rejection::JsonRejection;
use axum::extract::{ConnectInfo, State};
use axum::http::header::SET_COOKIE;
use axum::http::{Extensions, HeaderMap, Method};
use axum::response::{IntoResponse, Response};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::auth::{self, CurrentUser, Me};
use crate::business::{self, GstBasis, GstSetup};
use crate::commands::{Accepted, Command, CommandEnvelope, ExpireWhy, GuestSource};
use crate::error::CommandError;
use crate::pipeline::{self, Actor, Effect};

/// A guest's trial lasts this long from their last request (ADR 014, 6).
pub const GUEST_DAYS: i64 = 7;
/// An example business lasts this long from when it was made.
pub const EXAMPLE_HOURS: i64 = 24;
/// A guest's session is moved on at most this often.
pub const BUMP_EVERY_MINUTES: i64 = 60;
/// How often the sweep runs, and it runs once at startup too.
pub const SWEEP_EVERY_SECS: u64 = 600;

// The limits (ADR 014, 8).
/// The largest file a guest may upload, checked before it's parsed.
pub const MAX_FILE_BYTES: usize = 1024 * 1024;
/// Statement files one guest may hold.
pub const MAX_GUEST_BYTES: i64 = 5 * 1024 * 1024;
/// Statement files all guests together may hold.
pub const MAX_ALL_GUEST_BYTES: i64 = 200 * 1024 * 1024;
pub const MAX_STATEMENTS: i64 = 12;
pub const MAX_LINES: i64 = 5_000;
/// Bank and card accounts per guest business.
pub const MAX_ACCOUNTS: usize = 4;
pub const MAX_GUESTS_ALIVE: i64 = 1_000;
/// Trials started across every address in an hour.
pub const MAX_STARTS_PER_HOUR: i64 = 300;
/// Trials started with the visitor's own file, per address per hour.
pub const FILE_TRIALS_PER_ADDRESS: u32 = 10;
/// Examples opened, per address per hour.
pub const EXAMPLES_PER_ADDRESS: u32 = 30;
pub const COMMANDS_PER_MINUTE: u32 = 60;

/// Command kinds a guest may submit (ADR 014, 1). `set_gst_registration` with source `owner`
/// only; `expire_guest` for their own business only; `claim_guest` through its route.
pub const GUEST_ALLOWED: &[&str] = &[
    "import_statement",
    "remove_statement",
    "set_opening_balance",
    "add_bank_account",
    "add_card_account",
    "code_bank_line",
    "code_bank_lines",
    "add_rule",
    "remove_rule",
    "answer_question",
    "confirm_transfer",
    "confirm_ird_payment",
    "resolve_duplicate",
    "confirm_supply_info",
    "set_gst_registration",
    "add_guest_business",
    "expire_guest",
    "claim_guest",
];

/// Not on [`GUEST_ALLOWED`], each with the phrase that finishes "Save your work first to …".
/// This list only documents them for the test; any kind not on [`GUEST_ALLOWED`] is refused the
/// same way, as "do this".
pub const GUEST_REFUSED: &[(&str, &str)] = &[
    ("create_invite", "invite your accountant"),
    ("set_ai_suggestions", "use AI suggestions"),
    ("record_suggestions", "use AI suggestions"),
    ("change_own_password", "set a password"),
    (
        "set_history_sharing",
        "share your changes with an accountant",
    ),
    ("set_coding_settings", "change how lines are sorted"),
    ("save_invoice_draft", "make invoices"),
    ("save_invoice_template", "make invoices"),
    ("delete_invoice_template", "make invoices"),
    ("add_invoice_image", "make invoices"),
    ("finalise_year", "do this"),
    ("reopen_year", "do this"),
    ("accept_invite", "do this"),
    ("start_guest", "start another trial"),
    ("adopt_guest_business", "do this"),
    ("sign_up", "do this"),
    ("initialise", "do this"),
    ("create_user", "do this"),
    ("reset_password", "do this"),
    ("set_user_active", "do this"),
    ("install_starter_set", "do this"),
    ("create_master_chart", "do this"),
    ("add_master_account", "do this"),
    ("rename_master_account", "do this"),
    ("set_master_account_active", "do this"),
    ("set_master_account_gst", "do this"),
    ("create_template", "do this"),
    ("revise_template", "do this"),
    ("create_mapping", "do this"),
    ("revise_mapping", "do this"),
    ("move_year_layout", "do this"),
    ("create_client", "do this"),
    ("add_account", "do this"),
    ("rename_account", "do this"),
    ("set_account_active", "do this"),
    ("set_account_gst", "do this"),
    ("set_rounding_priority", "do this"),
    ("create_client_year", "do this"),
    ("post_journal", "do this"),
    ("import_tb", "do this"),
    ("reverse_journal", "do this"),
    ("create_asset_class", "do this"),
    ("update_asset_class", "do this"),
    ("set_client_asset_class", "do this"),
    ("create_asset", "do this"),
    ("update_asset", "do this"),
    ("delete_asset", "do this"),
    ("dispose_asset", "do this"),
    ("reinstate_asset", "do this"),
    ("run_depreciation", "do this"),
    ("apply_asset_class_defaults", "do this"),
    ("set_up_business", "do this"),
    ("add_merchant", "do this"),
    ("remove_merchant", "do this"),
    ("add_paragraph", "do this"),
    ("revise_paragraph", "do this"),
    ("pick_notes", "do this"),
    ("edit_note", "do this"),
    ("push_paragraph", "do this"),
    ("remove_paragraph", "do this"),
    ("start_impersonation", "do this"),
    ("end_impersonation", "do this"),
    ("allow_impersonation_changes", "do this"),
];

/// Where a command kind stands for a guest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForGuests {
    Allowed,
    /// Refused, with the phrase that finishes "Save your work first to …".
    Refused(&'static str),
}

/// Where `kind` stands for a guest. Anything to do with IRD (M14) is refused: filing needs a saved
/// account. A kind nobody has classified is refused too.
pub fn classify(kind: &str) -> ForGuests {
    if kind.starts_with("ird_") {
        return ForGuests::Refused("file with IRD");
    }
    if GUEST_ALLOWED.contains(&kind) {
        return ForGuests::Allowed;
    }
    match GUEST_REFUSED.iter().find(|(k, _)| *k == kind) {
        Some((_, what)) => ForGuests::Refused(what),
        None => ForGuests::Refused("do this"),
    }
}

/// "Save your work first to invite your accountant."
pub fn save_first(what: &str) -> CommandError {
    CommandError::Guest {
        code: "guest",
        message: format!("Save your work first to {what}."),
    }
}

fn example_refusal() -> CommandError {
    CommandError::Guest {
        code: "example",
        message: "This is an example. Your own statements go in a business of your own: drop one \
                  on the home page."
            .to_owned(),
    }
}

fn not_a_guest() -> CommandError {
    CommandError::invalid(
        "not_a_guest",
        "That's only for a trial that hasn't been saved yet.",
    )
}

/// The routes a guest may use, besides the public ones (ADR 014, 1): their own business's
/// screens, Changes, the change feed, presence, commands and saving their work. Deny by default.
pub fn route_allowed(method: &Method, path: &str) -> bool {
    let get = *method == Method::GET;
    let post = *method == Method::POST;
    match path {
        "/api/me"
        | "/api/clients"
        | "/api/clients/{id}"
        | "/api/clients/{id}/chart"
        | "/api/clients/{id}/asset-classes"
        | "/api/businesses/{id}"
        | "/api/businesses/{id}/tax"
        | "/api/businesses/{id}/save-tax"
        | "/api/businesses/{id}/rules"
        | "/api/businesses/{id}/coding-settings"
        | "/api/statements/{id}/excerpt"
        | "/api/bank-accounts/{id}/proof"
        | "/api/history"
        | "/api/sync" => get,
        "/api/commands" | "/api/presence" | "/api/guest/claim" => post,
        _ => false,
    }
}

/// The refusal for a route a guest can't use, if they can't.
pub fn check_route(method: &Method, path: &str) -> Result<(), CommandError> {
    if route_allowed(method, path) {
        return Ok(());
    }
    let what = if path.contains("ai-suggestions") {
        "use AI suggestions"
    } else if path.starts_with("/api/invoices") {
        "make invoices"
    } else if path.starts_with("/api/ird") {
        "file with IRD"
    } else {
        "do this"
    };
    Err(save_first(what))
}

// ---------------------------------------------------------------------------------------------
// The pipeline's steps.

/// The guest user behind `actor`, if it's a guest: someone submitting as themselves, not the
/// server and not an overseer viewing as someone (who can never view as a guest).
async fn guest_of(tx: &mut SqliteConnection, actor: &Actor) -> Result<Option<User>, CommandError> {
    let Some(id) = actor.user_id.as_deref() else {
        return Ok(None);
    };
    if actor.acting_as.is_some() || actor.role != Role::BusinessOwner {
        return Ok(None);
    }
    Ok(users::get(tx, id).await?.filter(User::is_guest))
}

/// The pipeline's refusal step for guests, before a command is validated: anything not on
/// [`GUEST_ALLOWED`], uploads of their own into an example, and files over the size limit.
pub(crate) async fn refuse_for_guest(
    tx: &mut SqliteConnection,
    actor: &Actor,
    command: &Command,
) -> Result<(), CommandError> {
    if guest_of(tx, actor).await?.is_none() {
        return Ok(());
    }
    if let ForGuests::Refused(what) = classify(command.kind()) {
        return Err(save_first(what));
    }
    let example_client = match command {
        Command::ImportStatement { client_id, .. }
        | Command::AddBankAccount { client_id, .. }
        | Command::AddCardAccount { client_id, .. } => Some(client_id.as_str()),
        _ => None,
    };
    if let Some(client_id) = example_client
        && store::flags(tx, client_id)
            .await?
            .is_some_and(|f| f.example.is_some())
    {
        return Err(example_refusal());
    }
    if let Command::ImportStatement { content_base64, .. } = command {
        check_file_size(content_base64)?;
    }
    Ok(())
}

/// The base64 of a file over [`MAX_FILE_BYTES`] is refused before it's decoded or parsed.
fn check_file_size(content_base64: &str) -> Result<(), CommandError> {
    if content_base64.len() / 4 * 3 > MAX_FILE_BYTES + 2 {
        return Err(CommandError::invalid(
            "file_too_big",
            "That file is over 1 MB. A statement of one to three months is plenty to see your tax.",
        ));
    }
    Ok(())
}

/// After any command is applied, inside its transaction: GST detection on a business whose
/// registration came from its statements, and the per-guest limits on what a guest holds.
pub(crate) async fn after_apply(
    tx: &mut SqliteConnection,
    command: &Command,
    effect: &Effect,
    seq: i64,
) -> Result<(), CommandError> {
    let client_id = match command {
        Command::ImportStatement { .. }
        | Command::RemoveStatement { .. }
        | Command::AddBankAccount { .. }
        | Command::AddCardAccount { .. } => effect.client_id.as_deref(),
        _ => None,
    };
    let Some(client_id) = client_id else {
        return Ok(());
    };
    if matches!(
        command,
        Command::ImportStatement { .. } | Command::RemoveStatement { .. }
    ) {
        redetect(tx, seq, client_id).await?;
    }
    if let Some(owner) = store::guest_owner(tx, client_id).await? {
        check_holding(tx, &owner, client_id).await?;
    }
    Ok(())
}

/// The per-guest and all-guest limits on what's held, checked after an upload so they hold
/// across restarts. Refusing rolls the whole command back.
async fn check_holding(
    tx: &mut SqliteConnection,
    user_id: &str,
    client_id: &str,
) -> Result<(), CommandError> {
    let full = |what: String| {
        CommandError::invalid(
            "trial_full",
            format!("That's {what}, the most a trial can hold. Save your work to add more."),
        )
    };
    let h = store::holding(tx, user_id).await?;
    if h.statements > MAX_STATEMENTS {
        return Err(full(format!("{MAX_STATEMENTS} statements")));
    }
    if h.lines > MAX_LINES {
        return Err(full(format!("{} lines", MAX_LINES.separated())));
    }
    if h.file_bytes > MAX_GUEST_BYTES {
        return Err(CommandError::invalid(
            "trial_full",
            "That's as much as a trial can hold. Save your work to add more.",
        ));
    }
    if bank_store::bank_accounts(tx, client_id).await?.len() > MAX_ACCOUNTS {
        return Err(full(format!("{MAX_ACCOUNTS} accounts")));
    }
    let (_, all_bytes) = store::totals(tx).await?;
    if all_bytes > MAX_ALL_GUEST_BYTES {
        return Err(busy());
    }
    Ok(())
}

trait Separated {
    fn separated(self) -> String;
}

impl Separated for i64 {
    /// 5000 as "5,000".
    fn separated(self) -> String {
        let s = self.to_string();
        let mut out = String::new();
        for (i, c) in s.chars().enumerate() {
            if i > 0 && (s.len() - i).is_multiple_of(3) {
                out.push(',');
            }
            out.push(c);
        }
        out
    }
}

fn busy() -> CommandError {
    CommandError::Limited {
        code: "busy",
        message: "We're very busy right now. Try again in a few minutes, or sign up to carry on."
            .to_owned(),
        retry_after_secs: 300,
    }
}

/// Applies the guest commands; `None` for every other command.
pub(crate) async fn apply(
    tx: &mut SqliteConnection,
    actor: &Actor,
    command: &Command,
    seq: i64,
    at: DateTime<Utc>,
) -> Result<Option<Effect>, CommandError> {
    let client = |id: String| Effect {
        entity_id: Some(id.clone()),
        client_id: Some(id),
        client_year_id: None,
    };
    Ok(Some(match command {
        Command::StartGuest { source } => client(start(tx, actor, source, seq, at).await?),
        Command::AddGuestBusiness { source } => {
            client(add_business(tx, actor, source, seq, at).await?)
        }
        Command::ClaimGuest {
            email,
            display_name,
            password,
            business_name,
        } => client(
            claim(
                tx,
                actor,
                Claim {
                    email,
                    display_name,
                    password,
                    business_name: business_name.as_deref(),
                },
                seq,
                at,
            )
            .await?,
        ),
        Command::AdoptGuestBusiness { token } => client(adopt(tx, actor, token, seq, at).await?),
        Command::ExpireGuest { client_id, why } => {
            expire(tx, actor, client_id, *why, seq).await?;
            // The business is gone, so the entry names none: it's the server's, for overseers.
            Effect {
                entity_id: Some(client_id.clone()),
                ..Effect::default()
            }
        }
        Command::SetGstRegistration {
            client_id,
            registered,
            registered_from,
            frequency,
            source,
        } => {
            set_registration(
                tx,
                actor,
                seq,
                client_id,
                Registration {
                    registered: *registered,
                    registered_from: *registered_from,
                    frequency: *frequency,
                    source: *source,
                },
            )
            .await?;
            client(client_id.clone())
        }
        _ => return Ok(None),
    }))
}

/// The user id a command's log entry is recorded under, when it isn't the actor's: `start_guest`
/// is the visitor's own doing, though there was no user until it ran.
pub(crate) async fn logged_user(
    tx: &mut SqliteConnection,
    command: &Command,
    effect: &Effect,
) -> Result<Option<String>, CommandError> {
    match (command, effect.client_id.as_deref()) {
        (Command::StartGuest { .. }, Some(client_id)) => {
            Ok(store::guest_owner(tx, client_id).await?)
        }
        _ => Ok(None),
    }
}

async fn start(
    tx: &mut SqliteConnection,
    actor: &Actor,
    source: &GuestSource,
    seq: i64,
    at: DateTime<Utc>,
) -> Result<String, CommandError> {
    if actor.user_id.is_some() {
        return Err(CommandError::invalid(
            "signed_in",
            "You're signed in already. Open your business instead.",
        ));
    }
    let (alive, all_bytes) = store::totals(tx).await?;
    if alive >= MAX_GUESTS_ALIVE
        || store::started_since(tx, at - Duration::hours(1)).await? >= MAX_STARTS_PER_HOUR
        || (matches!(source, GuestSource::File { .. }) && all_bytes >= MAX_ALL_GUEST_BYTES)
    {
        return Err(busy());
    }
    let user_id = new_id();
    users::insert(
        tx,
        &User {
            id: user_id.clone(),
            // No `@`, so it's never an email anyone signs in with.
            username: format!("guest:{user_id}"),
            display_name: "You".to_owned(),
            // Matches no password: `auth::verify_password` never accepts it.
            password_hash: String::new(),
            role: Role::BusinessOwner,
            active: true,
            created_seq: seq,
            guest_since: Some(at),
            claimed_at: None,
        },
    )
    .await?;
    new_business(tx, &user_id, source, seq, at).await
}

async fn add_business(
    tx: &mut SqliteConnection,
    actor: &Actor,
    source: &GuestSource,
    seq: i64,
    at: DateTime<Utc>,
) -> Result<String, CommandError> {
    let guest = guest_of(tx, actor).await?.ok_or_else(not_a_guest)?;
    let mine = store::businesses_of(tx, &guest.id).await?;
    match source {
        GuestSource::Example(_) => {
            // One example at a time: the new one replaces the old, deleted as expiry would.
            for old in mine.iter().filter(|b| b.example.is_some()) {
                store::delete_business(tx, &old.client_id).await?;
                store::redact_log(tx, &old.client_id, seq).await?;
            }
        }
        GuestSource::File { .. } => {
            if mine.iter().any(|b| b.example.is_none()) {
                return Err(CommandError::invalid(
                    "have_business",
                    "Your trial has a business already: upload this statement to it.",
                ));
            }
            let (_, all_bytes) = store::totals(tx).await?;
            if all_bytes >= MAX_ALL_GUEST_BYTES {
                return Err(busy());
            }
        }
    }
    new_business(tx, &guest.id, source, seq, at).await
}

/// Sets a guest's business up from a file alone (ADR 014, 3) and imports it: named "Your
/// business" (or the example's name), books from 1 April of the income year holding the file's
/// earliest line, GST registered from then, detected from the lines or else assumed.
async fn new_business(
    tx: &mut SqliteConnection,
    user_id: &str,
    source: &GuestSource,
    seq: i64,
    at: DateTime<Utc>,
) -> Result<String, CommandError> {
    let (name, file_name, bytes, example) = match source {
        GuestSource::File {
            file_name,
            content_base64,
        } => {
            check_file_size(content_base64)?;
            let bytes = business::decode_base64(content_base64).ok_or_else(|| {
                CommandError::invalid("bad_file", "The file didn't arrive intact. Try again.")
            })?;
            ("Your business", file_name.as_str(), bytes, None)
        }
        GuestSource::Example(n) => {
            let (business, file_name, bytes) =
                crate::examples::example_file(*n).ok_or_else(|| {
                    CommandError::invalid("no_such_example", "There are examples 1, 2 and 3.")
                })?;
            (business, file_name, bytes.to_vec(), Some(*n))
        }
    };
    let statement = business::read_statement_or_explain(&bytes)?;
    let earliest = statement
        .lines
        .iter()
        .map(|l| l.date)
        .min()
        .ok_or_else(|| {
            CommandError::invalid("statement_empty", "That file has no transactions in it.")
        })?;
    let start = IncomeYear::containing(earliest).start();
    let client_id = business::set_up(
        tx,
        seq,
        name,
        start,
        Some(&GstSetup {
            registered_from: start,
            frequency: DEFAULT_FREQUENCY,
            basis: GstBasis::Payments,
        }),
    )
    .await?;
    store::set_gst(
        tx,
        &client_id,
        Some(GstSetting {
            registered_from: start,
            frequency: DEFAULT_FREQUENCY,
        }),
        GstSource::Assumed,
        None,
    )
    .await?;
    if let Some(n) = example {
        store::set_example(tx, &client_id, n).await?;
    }
    tenancy::grant(tx, &client_id, user_id, Access::Owner, seq).await?;
    business::import_statement(
        tx,
        seq,
        at.date_naive(),
        &client_id,
        file_name,
        &bytes,
        None,
    )
    .await?;
    redetect(tx, seq, &client_id).await?;
    check_holding(tx, user_id, &client_id).await?;
    Ok(client_id)
}

/// What a business's statements say about its GST registration now, applied when it came from
/// statements in the first place (`detected` or `assumed`); an owner's or IRD's answer is never
/// changed. Proof upgrades `assumed` to `detected`; losing it (the statement was removed) goes
/// back to `assumed`. The registration date doesn't change, so the frequency only decides how the
/// same postings fall into periods; but proof puts back the GST on purchases coded while it was
/// assumed (`save_tax::restore_input_tax`).
pub(crate) async fn redetect(
    tx: &mut SqliteConnection,
    seq: i64,
    client_id: &str,
) -> Result<(), CommandError> {
    let Some(flags) = store::flags(tx, client_id).await? else {
        return Ok(());
    };
    let source = flags.source();
    if !matches!(source, GstSource::Assumed | GstSource::Detected) {
        return Ok(());
    }
    let b = business::business(tx, client_id).await?;
    let Some(current) = b.gst else {
        return Ok(());
    };
    let lines = bank_store::bank_lines(tx, client_id).await?;
    let detect: Vec<DetectLine<'_>> = lines
        .iter()
        .map(|l| DetectLine {
            date: l.date,
            amount: l.amount,
            description: &l.description,
        })
        .collect();
    let (source_now, frequency, evidence) = match detect_registration(&detect) {
        GstDetection::Detected {
            line, frequency, ..
        } => (GstSource::Detected, frequency, Some(lines[line].id.clone())),
        GstDetection::Assumed { frequency } if source == GstSource::Detected => {
            (GstSource::Assumed, frequency, None)
        }
        GstDetection::Assumed { .. } => return Ok(()),
    };
    if source_now == source && frequency == current.frequency && evidence == flags.gst_evidence {
        return Ok(());
    }
    store::set_gst(
        tx,
        client_id,
        Some(GstSetting {
            registered_from: current.registered_from,
            frequency,
        }),
        source_now,
        evidence.as_deref(),
    )
    .await?;
    if source == GstSource::Assumed && source_now == GstSource::Detected {
        crate::save_tax::restore_input_tax(tx, seq, client_id).await?;
    }
    Ok(())
}

/// What `claim_guest` sets.
struct Claim<'a> {
    email: &'a str,
    display_name: &'a str,
    password: &'a str,
    business_name: Option<&'a str>,
}

async fn claim(
    tx: &mut SqliteConnection,
    actor: &Actor,
    c: Claim<'_>,
    seq: i64,
    at: DateTime<Utc>,
) -> Result<String, CommandError> {
    let guest = guest_of(tx, actor).await?.ok_or_else(not_a_guest)?;
    let mine = store::businesses_of(tx, &guest.id).await?;
    let own = mine
        .iter()
        .find(|b| b.example.is_none())
        .ok_or_else(|| {
            CommandError::invalid(
                "example_only",
                "Examples can't be saved. Drop one of your own statements, or sign up.",
            )
        })?
        .client_id
        .clone();
    let email = crate::signup::check_email(c.email)?;
    if users::by_username(tx, &email).await?.is_some() {
        return Err(CommandError::invalid(
            "email_taken",
            "There's already an account with that email. Sign in instead.",
        ));
    }
    pipeline::check_name(c.display_name)?;
    auth::check_password_rules(c.password)?;
    if let Some(name) = c.business_name {
        pipeline::check_name(name)?;
        store::rename_client(tx, &own, name.trim()).await?;
    }
    // An example can never be filed: those are made-up figures.
    for old in mine.iter().filter(|b| b.example.is_some()) {
        store::delete_business(tx, &old.client_id).await?;
        store::redact_log(tx, &old.client_id, seq).await?;
    }
    users::claim(
        tx,
        &guest.id,
        &email,
        c.display_name.trim(),
        &auth::hash_password(c.password),
        at,
    )
    .await?;
    Ok(own)
}

async fn adopt(
    tx: &mut SqliteConnection,
    actor: &Actor,
    token: &str,
    seq: i64,
    at: DateTime<Utc>,
) -> Result<String, CommandError> {
    let nothing = || {
        CommandError::invalid(
            "nothing_to_move",
            "There's no trial in this browser to move into your account.",
        )
    };
    let me = match actor.user_id.as_deref() {
        Some(id) if actor.acting_as.is_none() && actor.role == Role::BusinessOwner => {
            users::get(tx, id).await?.ok_or(CommandError::Forbidden)?
        }
        _ => return Err(CommandError::Forbidden),
    };
    if me.is_guest() {
        return Err(nothing());
    }
    let session = sessions::get(tx, &auth::token_hash(token))
        .await?
        .filter(|s| s.expires_at > at)
        .ok_or_else(nothing)?;
    let guest = users::get(tx, &session.user_id)
        .await?
        .filter(User::is_guest)
        .ok_or_else(nothing)?;
    let mine = store::businesses_of(tx, &guest.id).await?;
    let own = mine
        .iter()
        .find(|b| b.example.is_none())
        .ok_or_else(nothing)?
        .client_id
        .clone();
    for old in mine.iter().filter(|b| b.example.is_some()) {
        store::delete_business(tx, &old.client_id).await?;
        store::redact_log(tx, &old.client_id, seq).await?;
    }
    store::move_owner(tx, &own, &guest.id, &me.id, seq).await?;
    sessions::delete_for_user(tx, &guest.id).await?;
    // The trial's earlier changes read under the owner's name from now on.
    store::retire_guest(tx, &guest.id, &me.display_name).await?;
    Ok(own)
}

async fn expire(
    tx: &mut SqliteConnection,
    actor: &Actor,
    client_id: &str,
    why: ExpireWhy,
    seq: i64,
) -> Result<(), CommandError> {
    let owner = store::guest_owner(tx, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("trial", client_id))?;
    match (actor.user_id.as_deref(), why) {
        // The server's sweep.
        (None, ExpireWhy::Unused | ExpireWhy::ExampleFinished) => {}
        // "Delete it now", by the guest whose trial it is.
        (Some(me), ExpireWhy::ByYou) if me == owner => {}
        _ => {
            return Err(CommandError::invalid(
                "server_only",
                "Only the server ends a trial for being unused or finished.",
            ));
        }
    }
    store::delete_business(tx, client_id).await?;
    store::redact_log(tx, client_id, seq).await?;
    if store::businesses_of(tx, &owner).await?.is_empty() {
        sessions::delete_for_user(tx, &owner).await?;
        store::retire_guest(tx, &owner, "Expired guest").await?;
    }
    Ok(())
}

/// What `set_gst_registration` asks for.
struct Registration {
    registered: bool,
    registered_from: Option<chrono::NaiveDate>,
    frequency: Option<GstFrequency>,
    source: GstSource,
}

fn frequency_words(f: GstFrequency) -> &'static str {
    match f {
        GstFrequency::Monthly => "monthly",
        GstFrequency::TwoMonthlyOdd | GstFrequency::TwoMonthlyEven => "two-monthly",
        GstFrequency::SixMonthly => "six-monthly",
    }
}

async fn set_registration(
    tx: &mut SqliteConnection,
    actor: &Actor,
    seq: i64,
    client_id: &str,
    r: Registration,
) -> Result<(), CommandError> {
    // A browser speaks for the owner; the rest are the server's own (ADR 014, 3).
    if actor.user_id.is_some() && r.source != GstSource::Owner {
        return Err(CommandError::invalid(
            "server_only",
            "Only the server records GST registration as detected, assumed or from IRD.",
        ));
    }
    let b = business::business(tx, client_id).await?;
    let flags = store::flags(tx, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("business", client_id))?;
    if flags.source() == GstSource::Ird && r.source != GstSource::Ird {
        let says = match b.gst {
            Some(g) => format!("GST registered, {}", frequency_words(g.frequency)),
            None => "not GST registered".to_owned(),
        };
        return Err(CommandError::invalid(
            "ird_says",
            format!("IRD has you as {says}. If that's wrong, contact IRD."),
        ));
    }
    let gst = r.registered.then(|| GstSetting {
        registered_from: r
            .registered_from
            .or(b.gst.map(|g| g.registered_from))
            .unwrap_or(b.start_date),
        frequency: r
            .frequency
            .or(b.gst.map(|g| g.frequency))
            .unwrap_or(DEFAULT_FREQUENCY),
    });
    if r.registered_from.is_some() && !r.registered {
        return Err(CommandError::invalid(
            "not_registered",
            "A business that isn't GST registered has no registration date.",
        ));
    }
    let evidence = (r.source == GstSource::Detected)
        .then_some(flags.gst_evidence.as_deref())
        .flatten();
    store::set_gst(tx, client_id, gst, r.source, evidence).await?;
    // Lines and gap journals whose posting changes are reversed and reposted, as any recode is.
    if gst.map(|g| g.registered_from) != b.gst.map(|g| g.registered_from) {
        crate::save_tax::repost_all(tx, seq, client_id).await?;
        business::regenerate_all_gaps(tx, seq, client_id).await?;
    }
    // Confirmed at last: the GST on purchases coded while it was assumed is claimed now.
    if flags.source() == GstSource::Assumed && r.source != GstSource::Assumed && gst.is_some() {
        crate::save_tax::restore_input_tax(tx, seq, client_id).await?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The per-address limits (ADR 014, 8), in memory: one machine is all there is (ADR 008).

/// Per-address and per-guest counts, in fixed windows. A deploy resets them, which is fine.
pub struct Limits {
    files_per_address: u32,
    examples_per_address: u32,
    state: Mutex<Counts>,
}

#[derive(Default)]
struct Counts {
    /// The hour the address counts are for, as hours since the epoch.
    hour: i64,
    files: HashMap<String, u32>,
    examples: HashMap<String, u32>,
    /// The minute the command counts are for.
    minute: i64,
    commands: HashMap<String, u32>,
}

impl Default for Limits {
    fn default() -> Limits {
        Limits::new(FILE_TRIALS_PER_ADDRESS, EXAMPLES_PER_ADDRESS)
    }
}

impl Limits {
    pub fn new(files_per_address: u32, examples_per_address: u32) -> Limits {
        Limits {
            files_per_address,
            examples_per_address,
            state: Mutex::default(),
        }
    }

    /// The defaults, or `ACCT_GUEST_TRIALS_PER_ADDRESS` trials per address per hour (examples
    /// three times that). Dev and the desktop app, where everyone is one address, raise it.
    pub fn from_env() -> Limits {
        match std::env::var("ACCT_GUEST_TRIALS_PER_ADDRESS")
            .ok()
            .and_then(|v| v.trim().parse::<u32>().ok())
        {
            Some(n) => Limits::new(n, n.saturating_mul(3)),
            None => Limits::default(),
        }
    }

    /// Counts a trial started (or a business added) from `address`, or refuses it.
    pub fn take_trial(
        &self,
        address: &str,
        example: bool,
        now: DateTime<Utc>,
    ) -> Result<(), CommandError> {
        let mut s = self.state.lock().expect("the limits lock isn't poisoned");
        let hour = now.timestamp().div_euclid(3600);
        if s.hour != hour {
            s.hour = hour;
            s.files.clear();
            s.examples.clear();
        }
        let (limit, counts) = if example {
            (self.examples_per_address, &mut s.examples)
        } else {
            (self.files_per_address, &mut s.files)
        };
        let n = counts.entry(address.to_owned()).or_default();
        if *n >= limit {
            let left = 3600 - now.timestamp().rem_euclid(3600);
            let minutes = (left + 59) / 60;
            let what = if example { "the examples" } else { "this" };
            return Err(CommandError::Limited {
                code: "too_many_trials",
                message: format!(
                    "Lots of people on your network have tried {what} in the last hour. Try \
                     again in about {minutes} minutes, or sign up to carry on."
                ),
                retry_after_secs: u64::try_from(left).unwrap_or(3600),
            });
        }
        *n += 1;
        Ok(())
    }

    /// Counts one command from a guest, or refuses it.
    pub fn take_command(&self, user_id: &str, now: DateTime<Utc>) -> Result<(), CommandError> {
        let mut s = self.state.lock().expect("the limits lock isn't poisoned");
        let minute = now.timestamp().div_euclid(60);
        if s.minute != minute {
            s.minute = minute;
            s.commands.clear();
        }
        let n = s.commands.entry(user_id.to_owned()).or_default();
        if *n >= COMMANDS_PER_MINUTE {
            return Err(CommandError::Limited {
                code: "slow_down",
                message: "Slow down a little. Try that again in a moment.".to_owned(),
                retry_after_secs: u64::try_from(60 - now.timestamp().rem_euclid(60)).unwrap_or(60),
            });
        }
        *n += 1;
        Ok(())
    }
}

/// Logs a refusal by the in-memory limits (`docs/security.md`, "What we log"): which limit, and the
/// address or the guest's user id. Never the file or its name.
pub(crate) fn log_refusal(e: &CommandError, who: &str) {
    tracing::info!(limit = %e.body().code, who, "refused by the guest limits");
}

/// The client's address for the limits: an IPv4 address, or an IPv6 /64. `Fly-Client-IP` only
/// on Fly (`FLY_APP_NAME` is set there), else the socket's peer; never `X-Forwarded-For`.
pub fn client_address(headers: &HeaderMap, extensions: &Extensions) -> String {
    let behind_fly = std::env::var_os("FLY_APP_NAME").is_some();
    let from_fly = behind_fly
        .then(|| {
            headers
                .get("fly-client-ip")?
                .to_str()
                .ok()?
                .parse::<IpAddr>()
                .ok()
        })
        .flatten();
    let peer = extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip());
    match from_fly.or(peer) {
        Some(IpAddr::V4(v4)) => v4.to_string(),
        Some(IpAddr::V6(v6)) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
        None => "unknown".to_owned(),
    }
}

// ---------------------------------------------------------------------------------------------
// The sweep (ADR 014, 6).

/// Ends, through the pipeline as the server, every trial that's over at `now`: a guest's business
/// whose guest has no live session (7 days without a request), and an example past its 24 hours.
/// Returns how many it ended. `acctd` runs it at startup and every 10 minutes ([`spawn_sweep`]);
/// tests call it with the `now` they want.
pub async fn sweep(store: &Store, now: DateTime<Utc>) -> Result<usize, CommandError> {
    let list = {
        let mut conn = store.reader().await?;
        let mut out = Vec::new();
        for b in store::guest_businesses(&mut conn).await? {
            let finished = b.example.is_some()
                && b.created_at
                    .is_some_and(|at| at + Duration::hours(EXAMPLE_HOURS) <= now);
            let why = if finished {
                Some(ExpireWhy::ExampleFinished)
            } else if store::live_sessions(&mut conn, &b.user_id, now).await? == 0 {
                Some(ExpireWhy::Unused)
            } else {
                None
            };
            if let Some(why) = why {
                out.push((b.client_id, why));
            }
        }
        out
    };
    let server = Actor {
        user_id: None,
        role: Role::Overseer,
        acting_as: None,
    };
    let mut n = 0;
    for (client_id, why) in list {
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command: Command::ExpireGuest {
                client_id: client_id.clone(),
                why,
            },
        };
        match pipeline::submit(store, &server, envelope, now).await {
            Ok(_) => n += 1,
            // Saved, moved or deleted meanwhile: nothing left to do.
            Err(CommandError::NotFound { .. }) => {}
            Err(e) => {
                tracing::warn!(error = %e.body().code, "couldn't end a trial");
            }
        }
    }
    Ok(n)
}

/// Runs [`sweep`] now and then every 10 minutes, until the task is dropped or aborted.
pub fn spawn_sweep(store: Arc<Store>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(SWEEP_EVERY_SECS));
        loop {
            tick.tick().await;
            if let Err(e) = sweep(&store, Utc::now()).await {
                tracing::warn!(error = %e.body().code, "the guest sweep failed");
            }
        }
    })
}

// ---------------------------------------------------------------------------------------------
// What `GET /api/me` says about a guest.

/// [`Me::guest`]: a guest's trial, for the banner and the home page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MeGuest {
    /// When the trial goes if they don't come back: 7 days after their last request.
    #[ts(type = "string")]
    pub expires_at: DateTime<Utc>,
    /// Their own business, once they've dropped a file of their own.
    pub business_id: Option<String>,
    /// Their example business, if they have one.
    pub example: Option<MeGuestExample>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MeGuestExample {
    pub business_id: String,
    pub number: u8,
    /// 24 hours after it was made, or when the trial goes, if that's sooner.
    #[ts(type = "string")]
    pub expires_at: DateTime<Utc>,
}

/// [`Me::moveable_trial`]: a signed-in owner whose browser was a guest a moment ago, with a
/// business of their own they could move in (`POST /api/guest/adopt`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MoveableTrial {
    pub statements: i64,
    pub lines: i64,
}

/// The guest part of `Me`, for a guest.
pub(crate) async fn me_guest(
    conn: &mut SqliteConnection,
    user: &User,
    session_expires: DateTime<Utc>,
) -> Result<Option<MeGuest>, CommandError> {
    if !user.is_guest() {
        return Ok(None);
    }
    let mine = store::businesses_of(conn, &user.id).await?;
    let example = mine
        .iter()
        .find_map(|b| Some((b, u8::try_from(b.example?).ok()?)))
        .map(|(b, number)| MeGuestExample {
            business_id: b.client_id.clone(),
            number,
            expires_at: b
                .created_at
                .map_or(session_expires, |at| at + Duration::hours(EXAMPLE_HOURS))
                .min(session_expires),
        });
    Ok(Some(MeGuest {
        expires_at: session_expires,
        business_id: mine
            .iter()
            .find(|b| b.example.is_none())
            .map(|b| b.client_id.clone()),
        example,
    }))
}

/// The cookie that keeps a guest's session token for a moment after its browser signs in to an
/// account, so the owner can move the trial in (ADR 014, 4).
pub const MOVE_COOKIE: &str = "acct_guest";

/// A guest session token's trial, if it has a business of its own worth moving.
pub(crate) async fn moveable(
    conn: &mut SqliteConnection,
    token: &str,
    now: DateTime<Utc>,
) -> Result<Option<MoveableTrial>, CommandError> {
    let Some(session) = sessions::get(conn, &auth::token_hash(token))
        .await?
        .filter(|s| s.expires_at > now)
    else {
        return Ok(None);
    };
    let Some(guest) = users::get(conn, &session.user_id)
        .await?
        .filter(User::is_guest)
    else {
        return Ok(None);
    };
    if !store::businesses_of(conn, &guest.id)
        .await?
        .iter()
        .any(|b| b.example.is_none())
    {
        return Ok(None);
    }
    let h = store::holding(conn, &guest.id).await?;
    Ok(Some(MoveableTrial {
        statements: h.statements,
        lines: h.lines,
    }))
}

// ---------------------------------------------------------------------------------------------
// Routes.

/// The body of `POST /api/guest`. `id` is the command id, from `newId()`.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct StartGuestRequest {
    pub id: String,
    pub source: GuestSource,
}

/// The response to `POST /api/guest`: who the visitor is now, and the business the file or
/// example went into.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct GuestStarted {
    pub me: Me,
    pub business_id: String,
    pub accepted: Accepted,
}

/// `POST /api/guest`: a visitor drops a file or uses an example.
/// - No session: `start_guest`, then a guest session, 7 days and sliding.
/// - A guest's session: `add_guest_business` for an example, or for their first file of their
///   own; a later file of their own is an ordinary `import_statement` into their business.
/// - Anyone signed in to an account is told to open their business instead.
pub async fn start_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    extensions: Extensions,
    body: Result<Json<StartGuestRequest>, JsonRejection>,
) -> Result<Response, CommandError> {
    let Json(req) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let now = Utc::now();
    let example = matches!(req.source, GuestSource::Example(_));
    let session = match auth::token_from(&headers) {
        Some(token) => {
            let mut conn = state.store.reader().await?;
            auth::load(&mut conn, &auth::token_hash(&token), now)
                .await?
                .map(|u| (token, u))
        }
        None => None,
    };
    let replay = {
        let mut conn = state.store.reader().await?;
        let id = uuid::Uuid::parse_str(&req.id)
            .map_err(|_| CommandError::Malformed(format!("{:?} isn't a UUID", req.id)))?
            .hyphenated()
            .to_string();
        log::find(&mut conn, &id).await?.is_some()
    };
    let address = client_address(&headers, &extensions);

    if let Some((token, user)) = session {
        if !user.0.is_guest() || user.acting().is_some() {
            return Err(CommandError::invalid(
                "signed_in",
                "You're signed in already. Open your business instead.",
            ));
        }
        let own = {
            let mut conn = state.store.reader().await?;
            store::businesses_of(&mut conn, &user.0.id)
                .await?
                .into_iter()
                .find(|b| b.example.is_none())
                .map(|b| b.client_id)
        };
        let command = match (&req.source, own) {
            (
                GuestSource::File {
                    file_name,
                    content_base64,
                },
                Some(client_id),
            ) => Command::ImportStatement {
                client_id,
                file_name: file_name.clone(),
                content_base64: content_base64.clone(),
                bank_account_id: None,
            },
            (source, _) => Command::AddGuestBusiness {
                source: source.clone(),
            },
        };
        let adds = matches!(command, Command::AddGuestBusiness { .. });
        if adds && !replay {
            state
                .guest_limits
                .take_trial(&address, example, now)
                .inspect_err(|e| log_refusal(e, &address))?;
        }
        state
            .guest_limits
            .take_command(&user.0.id, now)
            .inspect_err(|e| log_refusal(e, &user.0.id))?;
        let accepted = pipeline::submit_in_session(
            &state.store,
            &user.actor(),
            user.session(),
            CommandEnvelope {
                id: req.id,
                command: command.clone(),
            },
            None,
            now,
        )
        .await?;
        let business_id = match &command {
            Command::ImportStatement { client_id, .. } => client_id.clone(),
            _ => accepted
                .entity_id
                .clone()
                .ok_or_else(|| CommandError::Malformed("nothing was made".to_owned()))?,
        };
        let cookie = auth::slide_guest_session(&state, &token, now).await?;
        let me = guest_me(&state, &user.0.id, now).await?;
        let mut response = Json(GuestStarted {
            me,
            business_id,
            accepted,
        })
        .into_response();
        response.headers_mut().append(SET_COOKIE, cookie);
        return Ok(response);
    }

    if !replay {
        state
            .guest_limits
            .take_trial(&address, example, now)
            .inspect_err(|e| log_refusal(e, &address))?;
    }
    let anonymous = Actor {
        user_id: None,
        role: Role::BusinessOwner,
        acting_as: None,
    };
    let accepted = pipeline::submit(
        &state.store,
        &anonymous,
        CommandEnvelope {
            id: req.id,
            command: Command::StartGuest { source: req.source },
        },
        now,
    )
    .await?;
    let business_id = accepted
        .entity_id
        .clone()
        .ok_or_else(|| CommandError::Malformed("nothing was made".to_owned()))?;
    let guest = {
        let mut conn = state.store.reader().await?;
        let id = store::guest_owner(&mut conn, &business_id).await?;
        match id {
            Some(id) => users::get(&mut conn, &id).await?,
            None => None,
        }
    }
    .filter(User::is_guest)
    .ok_or(CommandError::Unauthenticated)?;
    // A resubmitted id gets a session only if the first answer never arrived: no session was
    // ever used. Otherwise the id alone would be a way in.
    if replay {
        let mut conn = state.store.reader().await?;
        if store::live_sessions(&mut conn, &guest.id, now).await? > 0 {
            return Err(CommandError::invalid(
                "already_started",
                "That trial has started already. Reload the page to carry on with it.",
            ));
        }
    }
    let cookie = auth::start_guest_session(&state, &guest.id).await?;
    let me = guest_me(&state, &guest.id, now).await?;
    let mut response = Json(GuestStarted {
        me,
        business_id,
        accepted,
    })
    .into_response();
    response.headers_mut().append(SET_COOKIE, cookie);
    Ok(response)
}

/// A guest's `Me`, read fresh.
async fn guest_me(state: &AppState, user_id: &str, now: DateTime<Utc>) -> Result<Me, CommandError> {
    let mut conn = state.store.reader().await?;
    let user = users::get(&mut conn, user_id)
        .await?
        .ok_or(CommandError::Unauthenticated)?;
    let expires = auth::latest_session_expiry(&mut conn, user_id)
        .await?
        .unwrap_or(now + Duration::days(GUEST_DAYS));
    let mut me = Me::from(&user);
    me.guest = me_guest(&mut conn, &user, expires).await?;
    Ok(me)
}

/// The body of `POST /api/guest/claim`. `id` is the command id, from `newId()`.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct ClaimRequest {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub password: String,
    #[ts(optional)]
    pub business_name: Option<String>,
}

/// `POST /api/guest/claim`: a guest saves their work. Submits `claim_guest`, then ends the guest's
/// sessions and starts an ordinary one with a new token, so the browser carries on signed in.
/// Changing the token as the session gains credentials closes off session fixation.
pub async fn claim_route(
    State(state): State<AppState>,
    user: CurrentUser,
    body: Result<Json<ClaimRequest>, JsonRejection>,
) -> Result<Response, CommandError> {
    let Json(req) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    if !user.0.is_guest() {
        return Err(not_a_guest());
    }
    let password = req.password.clone();
    let accepted = pipeline::submit_in_session(
        &state.store,
        &user.actor(),
        user.session(),
        CommandEnvelope {
            id: req.id,
            command: Command::ClaimGuest {
                email: req.email,
                display_name: req.display_name,
                password: req.password,
                business_name: req.business_name,
            },
        },
        None,
        Utc::now(),
    )
    .await?;
    let business_id = accepted
        .entity_id
        .ok_or_else(|| CommandError::Malformed("nothing was saved".to_owned()))?;
    let claimed = {
        let mut conn = state.store.reader().await?;
        users::get(&mut conn, &user.0.id).await?
    }
    .filter(|u| u.active && u.claimed_at.is_some())
    .ok_or(CommandError::BadCredentials)?;
    let hash = claimed.password_hash.clone();
    let matches = tokio::task::spawn_blocking(move || auth::verify_password(&password, &hash))
        .await
        .unwrap_or(false);
    if !matches {
        return Err(CommandError::BadCredentials);
    }
    {
        let mut w = state.store.writer().await;
        sessions::delete_for_user(&mut w, &claimed.id).await?;
    }
    let cookie = auth::start_session(&state, &claimed.id).await?;
    let mut response = Json(crate::signup::SignedUp {
        me: Me::from(&claimed),
        business_id,
    })
    .into_response();
    response.headers_mut().append(SET_COOKIE, cookie);
    Ok(response)
}

/// The body of `POST /api/guest/adopt`. `id` is the command id, from `newId()`. `move_it`:
/// `true` moves the trial into the signed-in account; `false` leaves it, and it ends at the next
/// sweep.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct AdoptRequest {
    pub id: String,
    pub move_it: bool,
}

/// The response to `POST /api/guest/adopt`: the business moved in, if one was.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Adopted {
    pub business_id: Option<String>,
}

/// `POST /api/guest/adopt`: after signing in from a browser that was a guest, move the trial into
/// the account (ADR 014, 4), or leave it to end. Either way the remembered guest cookie goes.
pub async fn adopt_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    user: CurrentUser,
    body: Result<Json<AdoptRequest>, JsonRejection>,
) -> Result<Response, CommandError> {
    let Json(req) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let token = auth::cookie(&headers, MOVE_COOKIE).ok_or_else(|| {
        CommandError::invalid(
            "nothing_to_move",
            "There's no trial in this browser to move into your account.",
        )
    })?;
    let business_id = if req.move_it {
        let accepted = pipeline::submit_in_session(
            &state.store,
            &user.actor(),
            user.session(),
            CommandEnvelope {
                id: req.id,
                command: Command::AdoptGuestBusiness { token },
            },
            None,
            Utc::now(),
        )
        .await?;
        accepted.entity_id
    } else {
        // Login state, not data: without its session the sweep ends the trial.
        let mut w = state.store.writer().await;
        sessions::delete(&mut w, &auth::token_hash(&token)).await?;
        None
    };
    let mut response = Json(Adopted { business_id }).into_response();
    response
        .headers_mut()
        .append(SET_COOKIE, auth::named_cookie(MOVE_COOKIE, "", 0));
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deny_by_default() {
        assert_eq!(classify("import_statement"), ForGuests::Allowed);
        assert_eq!(
            classify("create_invite"),
            ForGuests::Refused("invite your accountant")
        );
        assert_eq!(
            classify("ird_file_return"),
            ForGuests::Refused("file with IRD")
        );
        assert_eq!(classify("some_new_command"), ForGuests::Refused("do this"));
        assert_eq!(
            save_first("invite your accountant").body().message,
            "Save your work first to invite your accountant."
        );
    }

    #[test]
    fn routes_are_deny_by_default() {
        assert!(route_allowed(&Method::GET, "/api/businesses/{id}/save-tax"));
        assert!(route_allowed(&Method::POST, "/api/commands"));
        assert!(!route_allowed(
            &Method::GET,
            "/api/businesses/{id}/ai-suggestions"
        ));
        assert!(!route_allowed(
            &Method::POST,
            "/api/businesses/{id}/ai-suggestions"
        ));
        assert!(!route_allowed(&Method::GET, "/api/years/{id}"));
        assert!(!route_allowed(&Method::GET, "/api/invoices/draft"));
        assert!(!route_allowed(&Method::GET, "/api/users"));
    }

    #[test]
    fn per_address_limits_count_files_and_examples_apart() {
        let limits = Limits::new(2, 3);
        let now = DateTime::parse_from_rfc3339("2026-11-05T10:40:00Z")
            .unwrap()
            .to_utc();
        limits.take_trial("1.2.3.4", false, now).unwrap();
        limits.take_trial("1.2.3.4", false, now).unwrap();
        let e = limits.take_trial("1.2.3.4", false, now).unwrap_err();
        assert_eq!(e.status(), axum::http::StatusCode::TOO_MANY_REQUESTS);
        assert!(
            e.body().message.contains("about 20 minutes"),
            "{}",
            e.body().message
        );
        // Examples have their own count, and another address its own.
        limits.take_trial("1.2.3.4", true, now).unwrap();
        limits.take_trial("5.6.7.8", false, now).unwrap();
        // A new hour starts afresh.
        limits
            .take_trial("1.2.3.4", false, now + Duration::minutes(20))
            .unwrap();
    }

    #[test]
    fn thousands_are_separated() {
        assert_eq!(5000_i64.separated(), "5,000");
        assert_eq!(12_i64.separated(), "12");
        assert_eq!(1_234_567_i64.separated(), "1,234,567");
    }

    #[test]
    fn ird_kinds_reach_detection() {
        // `ird_kind` is core's; this checks the server reads the same words.
        assert!(matches!(
            acct_core::bank::ird_kind("INLAND REVENUE GST AUG-SEP"),
            Some(acct_core::bank::IrdKind::Gst { .. })
        ));
    }
}
