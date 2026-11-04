//! Viewing as someone else (M19, ADR 013).
//!
//! An overseer can make their login session act as one active user below them. Every read then
//! answers as that person (`crate::access` runs on the effective identity), and the session is
//! read-only until the overseer turns changes on. It lasts 30 minutes from the start.
//!
//! This module holds:
//! - the three commands that change a session's acting state: `start_impersonation`,
//!   `allow_impersonation_changes` and `end_impersonation`, applied inside their own transaction;
//! - the pipeline's refusal step: what can't be done in someone else's name, decided before a
//!   command is validated;
//! - the sweep, which logs the end of every acting session that ran out or lost its session.
//!
//! Deny by default: [`ALLOWED`] lists the command kinds that may run while acting. Everything
//! else is refused, so a new command is refused while acting until someone adds it there.
//! [`NEVER`] is checked first, so a kind on it stays refused even if it's put on [`ALLOWED`] by
//! mistake. `tests/impersonation.rs` fails unless every kind is in exactly one group.

use std::collections::BTreeSet;
use std::sync::Arc;

use acct_store::users::{self, Role, User};
use acct_store::{SqliteConnection, Store, log, new_id, sessions};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::AppState;
use crate::auth;
use crate::commands::{Accepted, Command, CommandEnvelope};
use crate::error::CommandError;
use crate::pipeline::{self, ActingAs, Actor, Effect};

/// How long viewing as someone lasts, from the start (ADR 013, 5).
pub const MINUTES: i64 = 30;
/// The longest reason, in characters.
pub const MAX_REASON_CHARS: usize = 500;
/// How often the sweep runs, and it runs once at startup too.
pub const SWEEP_EVERY_SECS: u64 = 60;

/// How an acting session ended, when it wasn't the overseer pressing End (which sends none).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename = "ImpersonationEnded")]
pub enum Ended {
    /// The overseer signed out.
    SignedOut,
    /// Its 30 minutes were up. The server ends it.
    TimedOut,
    /// The person was made inactive, or became an overseer. The server ends it.
    PersonChanged,
    /// Its login session went (a password reset, the overseer made inactive, the session
    /// expired). The server ends it.
    SessionGone,
}

impl Ended {
    /// Only the server's sweep says these.
    fn by_server_only(self) -> bool {
        !matches!(self, Ended::SignedOut)
    }
}

/// Command kinds allowed while acting, once changes are on: the work done on one business, where
/// a person's view and role make a difference (ADR 013, 3).
pub const ALLOWED: &[&str] = &[
    // Chart.
    "add_account",
    "rename_account",
    "set_account_active",
    "set_account_gst",
    "set_rounding_priority",
    // Years, journals and notes.
    "create_client_year",
    "post_journal",
    "reverse_journal",
    "import_tb",
    "run_depreciation",
    "move_year_layout",
    "pick_notes",
    "edit_note",
    // Assets.
    "set_client_asset_class",
    "create_asset",
    "update_asset",
    "delete_asset",
    "dispose_asset",
    "reinstate_asset",
    "apply_asset_class_defaults",
    // Bank, uploads and Save tax. Coding a line as a payment to IRD is bookkeeping, not an IRD
    // action, so `confirm_ird_payment` is here.
    "set_coding_settings",
    "add_bank_account",
    "add_card_account",
    "import_statement",
    "set_opening_balance",
    "remove_statement",
    "code_bank_line",
    "code_bank_lines",
    "add_rule",
    "remove_rule",
    "answer_question",
    "confirm_transfer",
    "confirm_ird_payment",
    "resolve_duplicate",
    "confirm_supply_info",
    "record_suggestions",
    // An owner's answer to "Are you GST registered?" (M20); refused for the server's sources.
    "set_gst_registration",
];

/// The two session commands, allowed while acting even with changes off.
pub const SESSION: &[&str] = &["end_impersonation", "allow_impersonation_changes"];

/// Not on [`ALLOWED`]: practice-wide defaults and new businesses. An overseer does these as
/// themselves. This list only documents them for the test; any kind not on [`ALLOWED`] is refused
/// the same way.
pub const AS_YOURSELF: &[&str] = &[
    "install_starter_set",
    "create_master_chart",
    "add_master_account",
    "rename_master_account",
    "set_master_account_active",
    "set_master_account_gst",
    "create_template",
    "revise_template",
    "create_mapping",
    "revise_mapping",
    "create_asset_class",
    "update_asset_class",
    "add_merchant",
    "remove_merchant",
    "add_paragraph",
    "revise_paragraph",
    "remove_paragraph",
    "push_paragraph",
    "create_client",
    "set_up_business",
];

/// Always refused while acting, even with changes on: a person's own signature, identity or
/// consent. Each with the phrase that finishes "Overseers can't … as someone else." Every kind
/// starting `ird_` is refused too (ADR 013, 4).
pub const NEVER: &[(&str, &str)] = &[
    ("finalise_year", "finalise a year"),
    ("reopen_year", "reopen a year"),
    ("create_user", "add users"),
    ("reset_password", "reset a password"),
    ("set_user_active", "make users active or inactive"),
    ("change_own_password", "change a password"),
    ("accept_invite", "accept an invite"),
    ("create_invite", "invite an accountant"),
    ("set_history_sharing", "change who sees an owner's edits"),
    ("set_ai_suggestions", "turn AI suggestions on or off"),
    ("save_invoice_draft", "use someone's invoices"),
    ("save_invoice_template", "use someone's invoices"),
    ("delete_invoice_template", "use someone's invoices"),
    ("add_invoice_image", "use someone's invoices"),
    ("start_impersonation", "view as a second person"),
    ("initialise", "set up the server"),
    ("sign_up", "sign up"),
    // Guests (M20, ADR 014): nobody views as a guest, and these are a visitor's own.
    ("start_guest", "start a trial"),
    ("add_guest_business", "start a trial"),
    ("claim_guest", "save a trial"),
    ("adopt_guest_business", "move a trial into an account"),
    ("expire_guest", "delete a trial"),
];

/// Where a command kind stands while acting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhileActing {
    /// Allowed once changes are on.
    Allowed,
    /// `end_impersonation` and `allow_impersonation_changes`: always allowed.
    Session,
    /// Refused: do it as yourself. Includes every kind nobody has classified yet.
    AsYourself,
    /// Refused even with changes on, with the phrase that says what.
    Never(&'static str),
}

/// Where `kind` stands while acting. [`NEVER`] and the `ird_` prefix are checked first.
pub fn classify(kind: &str) -> WhileActing {
    if kind.starts_with("ird_") {
        return WhileActing::Never("deal with IRD");
    }
    if let Some((_, what)) = NEVER.iter().find(|(k, _)| *k == kind) {
        return WhileActing::Never(what);
    }
    if SESSION.contains(&kind) {
        return WhileActing::Session;
    }
    if ALLOWED.contains(&kind) {
        return WhileActing::Allowed;
    }
    WhileActing::AsYourself
}

/// When an acting state that began at `since` runs out.
pub fn expires_at(since: DateTime<Utc>) -> DateTime<Utc> {
    since + Duration::minutes(MINUTES)
}

/// Whether an acting state that began at `since` is still within its 30 minutes at `now`.
pub fn is_live(since: DateTime<Utc>, now: DateTime<Utc>) -> bool {
    now < expires_at(since)
}

/// Whether `real` may act as `person` (ADR 013, 1): an overseer, as an active user who isn't an
/// overseer (so never themselves), nor a guest who hasn't saved their work (M20, ADR 014): nobody
/// looks at a trial.
pub fn may_act_as(real: &User, person: &User) -> bool {
    real.role == Role::Overseer
        && real.active
        && person.active
        && person.role != Role::Overseer
        && person.id != real.id
        && !person.is_guest()
}

/// "You're viewing as Sam Staff, read-only": a write while changes are off.
pub fn read_only(name: &str) -> CommandError {
    CommandError::Impersonating {
        code: "impersonating",
        message: format!(
            "You're viewing as {name}, read-only. Turn on Allow changes to make this change."
        ),
    }
}

/// Something nobody may do in someone else's name. `what` finishes "Overseers can't …".
pub fn never(name: &str, what: &str) -> CommandError {
    CommandError::Impersonating {
        code: "impersonating",
        message: format!("You're viewing as {name}. Overseers can't {what} as someone else."),
    }
}

fn as_yourself(name: &str) -> CommandError {
    CommandError::Impersonating {
        code: "impersonating",
        message: format!(
            "You're viewing as {name}. Practice-wide changes and new businesses are made as \
             yourself: press End first."
        ),
    }
}

fn nested(name: &str) -> CommandError {
    CommandError::Impersonating {
        code: "impersonating",
        message: format!(
            "You're viewing as {name} already. End that before viewing as someone else."
        ),
    }
}

fn ended(name: &str) -> CommandError {
    CommandError::Impersonating {
        code: "impersonation_ended",
        message: format!("Your view as {name} has ended. Reload to carry on as yourself."),
    }
}

fn not_acting() -> CommandError {
    CommandError::invalid("not_impersonating", "You're not viewing as anyone now.")
}

/// The pipeline's refusal step, for an actor who's acting as someone, before the command is
/// validated (ADR 013, Consequences). In order:
/// 1. A person's acting session must still be live: it exists, it's this overseer's, its 30
///    minutes aren't up, and the person may still be acted as. Checked here, inside the command's
///    transaction, so a session ended in another tab can't be acted through.
/// 2. [`NEVER`] and the `ird_` prefix, whatever else.
/// 3. Anything not on [`ALLOWED`] (the session commands aside).
/// 4. With changes off, everything but the session commands.
pub(crate) async fn refuse_while_acting(
    tx: &mut SqliteConnection,
    actor: &Actor,
    acting: &ActingAs,
    command: &Command,
    at: DateTime<Utc>,
) -> Result<(), CommandError> {
    let person = users::get(tx, &acting.user_id).await?;
    let name = person
        .as_ref()
        .map_or_else(|| "someone".to_owned(), |p| p.display_name.clone());
    let allow_changes = match actor.user_id.as_deref() {
        // The server, ending an acting session that ran out. Nothing else is allowed it.
        None => false,
        Some(real_id) => {
            let session = sessions::by_acting_id(tx, &acting.acting_id)
                .await?
                .filter(|s| {
                    s.user_id == real_id
                        && s.acting_as.as_deref() == Some(acting.user_id.as_str())
                        && s.expires_at > at
                        && s.acting_since.is_some_and(|since| is_live(since, at))
                });
            let real = users::get(tx, real_id).await?;
            let still = match (&session, &real, &person) {
                (Some(_), Some(real), Some(person)) => may_act_as(real, person),
                _ => false,
            };
            match session {
                Some(s) if still => s.allow_changes,
                _ => return Err(ended(&name)),
            }
        }
    };
    match classify(command.kind()) {
        WhileActing::Never(_) if matches!(command, Command::StartImpersonation { .. }) => {
            Err(nested(&name))
        }
        WhileActing::Never(what) => Err(never(&name, what)),
        WhileActing::AsYourself => Err(as_yourself(&name)),
        WhileActing::Allowed if !allow_changes => Err(read_only(&name)),
        WhileActing::Allowed | WhileActing::Session => Ok(()),
    }
}

/// Applies the three session commands; `None` for every other command. `session` is the token
/// hash of the login session that sent it, if one did.
pub(crate) async fn apply(
    tx: &mut SqliteConnection,
    actor: &Actor,
    session: Option<&str>,
    command: &Command,
    at: DateTime<Utc>,
) -> Result<Option<Effect>, CommandError> {
    let acting_id = match command {
        Command::StartImpersonation { user_id, reason } => {
            start(tx, actor, session, user_id, reason, at).await?
        }
        Command::EndImpersonation {
            reason,
            acting_id,
            ended,
        } => end(tx, actor, reason.as_deref(), acting_id.as_deref(), *ended).await?,
        Command::AllowImpersonationChanges { reason } => allow(tx, actor, reason).await?,
        _ => return Ok(None),
    };
    // None of them names a business: they're about one login session.
    Ok(Some(Effect {
        entity_id: Some(acting_id),
        ..Effect::default()
    }))
}

fn check_reason(reason: &str) -> Result<(), CommandError> {
    if reason.trim().is_empty() {
        return Err(CommandError::invalid(
            "reason_needed",
            "Say why. The person reads it in their own Changes.",
        ));
    }
    check_reason_length(reason)
}

fn check_reason_length(reason: &str) -> Result<(), CommandError> {
    if reason.chars().count() > MAX_REASON_CHARS {
        return Err(CommandError::invalid(
            "reason_too_long",
            format!("A reason is at most {MAX_REASON_CHARS} characters."),
        ));
    }
    Ok(())
}

async fn start(
    tx: &mut SqliteConnection,
    actor: &Actor,
    session: Option<&str>,
    user_id: &str,
    reason: &str,
    at: DateTime<Utc>,
) -> Result<String, CommandError> {
    check_reason(reason)?;
    let no_session = || {
        CommandError::invalid(
            "no_session",
            "Viewing as someone starts from a signed-in browser.",
        )
    };
    let (Some(real_id), Some(session)) = (actor.user_id.as_deref(), session) else {
        return Err(no_session());
    };
    if actor.acting_as.is_some() {
        // The refusal step says so first, with the person's name; this is the backstop.
        return Err(nested("someone"));
    }
    sessions::get(tx, session)
        .await?
        .filter(|s| s.user_id == real_id)
        .ok_or_else(no_session)?;
    let person = users::get(tx, user_id)
        .await?
        .ok_or_else(|| CommandError::not_found("user", user_id))?;
    if person.role == Role::Overseer {
        return Err(CommandError::invalid(
            "cannot_view_as",
            "Nobody can view as an overseer.",
        ));
    }
    if !person.active {
        return Err(CommandError::invalid(
            "user_inactive",
            format!(
                "{} is inactive, so there's no view of theirs to see.",
                person.display_name
            ),
        ));
    }
    let acting_id = new_id();
    sessions::start_acting(tx, session, user_id, &acting_id, at).await?;
    Ok(acting_id)
}

async fn allow(
    tx: &mut SqliteConnection,
    actor: &Actor,
    reason: &str,
) -> Result<String, CommandError> {
    check_reason(reason)?;
    let (Some(_), Some(acting)) = (&actor.user_id, &actor.acting_as) else {
        return Err(not_acting());
    };
    let session = sessions::by_acting_id(tx, &acting.acting_id)
        .await?
        .ok_or_else(not_acting)?;
    if session.allow_changes {
        return Err(CommandError::invalid(
            "already_allowed",
            "Changes are already on for this view.",
        ));
    }
    sessions::allow_changes(tx, &acting.acting_id).await?;
    Ok(acting.acting_id.clone())
}

async fn end(
    tx: &mut SqliteConnection,
    actor: &Actor,
    reason: Option<&str>,
    acting_id: Option<&str>,
    ended: Option<Ended>,
) -> Result<String, CommandError> {
    if let Some(r) = reason {
        check_reason_length(r)?;
    }
    let id = match actor.user_id {
        // The overseer, ending their own session's: they name neither which nor how.
        Some(_) => {
            if acting_id.is_some() || ended.is_some_and(Ended::by_server_only) {
                return Err(CommandError::invalid(
                    "server_only",
                    "Only the server ends a view that ran out, or names one by its id.",
                ));
            }
            let Some(acting) = &actor.acting_as else {
                return Err(not_acting());
            };
            acting.acting_id.clone()
        }
        // The server's sweep: it names the acting session and says how it ended.
        None => {
            let (Some(id), Some(_)) = (acting_id, ended) else {
                return Err(CommandError::invalid(
                    "acting_id_needed",
                    "The server names the acting session it ends, and how it ended.",
                ));
            };
            if actor.acting_as.as_ref().is_some_and(|a| a.acting_id != id) {
                return Err(CommandError::invalid(
                    "acting_id_mismatch",
                    "That isn't the acting session named.",
                ));
            }
            id.to_owned()
        }
    };
    // Every start has exactly one end.
    if !open_ids(tx).await?.contains(&id) {
        return Err(CommandError::invalid(
            "not_viewing",
            "That view has already ended.",
        ));
    }
    sessions::stop_acting(tx, &id).await?;
    Ok(id)
}

/// An acting session that started and hasn't ended, from the log.
#[derive(Debug, Clone)]
struct Open {
    acting_id: String,
    person: String,
    started: DateTime<Utc>,
}

fn entity_id(result: &str) -> Option<String> {
    serde_json::from_str::<Accepted>(result).ok()?.entity_id
}

async fn open_sessions(conn: &mut SqliteConnection) -> Result<Vec<Open>, CommandError> {
    let ended: BTreeSet<String> = log::of_kind(conn, "end_impersonation")
        .await?
        .iter()
        .filter_map(|e| entity_id(&e.result))
        .collect();
    Ok(log::of_kind(conn, "start_impersonation")
        .await?
        .into_iter()
        .filter_map(|e| {
            let acting_id = entity_id(&e.result)?;
            if ended.contains(&acting_id) {
                return None;
            }
            let payload: Value = serde_json::from_str(&e.payload).ok()?;
            Some(Open {
                acting_id,
                person: payload["user_id"].as_str()?.to_owned(),
                started: e.at,
            })
        })
        .collect())
}

async fn open_ids(conn: &mut SqliteConnection) -> Result<BTreeSet<String>, CommandError> {
    Ok(open_sessions(conn)
        .await?
        .into_iter()
        .map(|o| o.acting_id)
        .collect())
}

/// Whether an open acting session is over at `now`, and how.
async fn over(
    conn: &mut SqliteConnection,
    open: &Open,
    now: DateTime<Utc>,
) -> Result<Option<Ended>, CommandError> {
    let person = users::get(conn, &open.person).await?;
    let Some(session) = sessions::by_acting_id(conn, &open.acting_id).await? else {
        // Its session went, or started viewing as someone else after this one ran out.
        return Ok(Some(if !is_live(open.started, now) {
            Ended::TimedOut
        } else if person
            .as_ref()
            .is_none_or(|p| !p.active || p.role == Role::Overseer)
        {
            Ended::PersonChanged
        } else {
            Ended::SessionGone
        }));
    };
    if !is_live(session.acting_since.unwrap_or(open.started), now) {
        return Ok(Some(Ended::TimedOut));
    }
    let real = users::get(conn, &session.user_id)
        .await?
        .filter(|u| u.active);
    let Some(real) = real.filter(|_| session.expires_at > now) else {
        return Ok(Some(Ended::SessionGone));
    };
    match person {
        Some(p) if may_act_as(&real, &p) => Ok(None),
        _ => Ok(Some(Ended::PersonChanged)),
    }
}

/// Ends, through the pipeline as the server, every acting session that's over at `now`: its 30
/// minutes are up, its person may no longer be acted as, or its login session has gone. Returns
/// how many it ended. `acctd` runs it at startup and once a minute ([`spawn_sweep`]); tests call
/// it with the `now` they want.
pub async fn sweep(store: &Store, now: DateTime<Utc>) -> Result<usize, CommandError> {
    let open = {
        let mut conn = store.reader().await?;
        open_sessions(&mut conn).await?
    };
    let mut n = 0;
    for o in open {
        let (how, role) = {
            let mut conn = store.reader().await?;
            let how = over(&mut conn, &o, now).await?;
            let role = users::get(&mut conn, &o.person).await?.map(|u| u.role);
            (how, role)
        };
        let Some(how) = how else {
            continue;
        };
        let server = Actor {
            user_id: None,
            role: Role::Overseer,
            acting_as: Some(ActingAs {
                user_id: o.person.clone(),
                role: role.unwrap_or(Role::Viewer),
                acting_id: o.acting_id.clone(),
            }),
        };
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command: Command::EndImpersonation {
                reason: None,
                acting_id: Some(o.acting_id.clone()),
                ended: Some(how),
            },
        };
        match pipeline::submit(store, &server, envelope, now).await {
            Ok(_) => n += 1,
            // Ended meanwhile, by the overseer: nothing left to do.
            Err(CommandError::Invalid {
                code: "not_viewing",
                ..
            }) => {}
            Err(e) => {
                tracing::warn!(
                    acting_id = %o.acting_id,
                    error = %e.body().message,
                    "couldn't end an acting session"
                );
            }
        }
    }
    Ok(n)
}

/// Runs [`sweep`] now and then every minute, until the task is dropped or aborted.
pub fn spawn_sweep(store: Arc<Store>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(SWEEP_EVERY_SECS));
        loop {
            // The first tick is immediate, so this runs at startup too.
            tick.tick().await;
            if let Err(e) = sweep(&store, Utc::now()).await {
                tracing::warn!(error = %e.body().message, "the impersonation sweep failed");
            }
        }
    })
}

/// Signing out of a session that's viewing as someone ends that first, as the overseer. If it
/// fails, the sweep ends it later, as the session will have gone.
pub(crate) async fn end_on_sign_out(state: &AppState, token_hash: &str) {
    let now = Utc::now();
    let user = match state.store.reader().await {
        Ok(mut conn) => auth::load(&mut conn, token_hash, now).await,
        Err(e) => Err(e.into()),
    };
    let user = match user {
        Ok(Some(user)) if user.acting().is_some() => user,
        Ok(_) => return,
        Err(e) => {
            tracing::warn!(error = %e.body().message, "couldn't read the session signing out");
            return;
        }
    };
    let envelope = CommandEnvelope {
        id: uuid::Uuid::now_v7().to_string(),
        command: Command::EndImpersonation {
            reason: None,
            acting_id: None,
            ended: Some(Ended::SignedOut),
        },
    };
    if let Err(e) =
        pipeline::submit_in_session(&state.store, &user.actor(), token_hash, envelope, None, now)
            .await
    {
        tracing::warn!(error = %e.body().message, "couldn't end viewing as someone at sign-out");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_wins_over_allowed_and_ird_is_never() {
        assert_eq!(
            classify("finalise_year"),
            WhileActing::Never("finalise a year")
        );
        assert_eq!(
            classify("ird_file_return"),
            WhileActing::Never("deal with IRD")
        );
        assert_eq!(classify("post_journal"), WhileActing::Allowed);
        assert_eq!(classify("end_impersonation"), WhileActing::Session);
        assert_eq!(classify("create_template"), WhileActing::AsYourself);
        // Deny by default: a kind nobody classified is refused.
        assert_eq!(classify("some_new_command"), WhileActing::AsYourself);
        assert!(!ALLOWED.iter().any(|k| k.starts_with("ird_")));
    }

    #[test]
    fn it_lasts_thirty_minutes_from_the_start() {
        let since = DateTime::parse_from_rfc3339("2026-11-04T10:00:00Z")
            .unwrap()
            .to_utc();
        assert!(is_live(since, since + Duration::minutes(29)));
        assert!(!is_live(since, since + Duration::minutes(30)));
        assert_eq!(expires_at(since), since + Duration::minutes(30));
    }

    #[test]
    fn refusals_name_the_person() {
        let e = never("Sam Staff", "finalise a year").body();
        assert_eq!(e.code, "impersonating");
        assert_eq!(
            e.message,
            "You're viewing as Sam Staff. Overseers can't finalise a year as someone else."
        );
        assert!(read_only("Sam Staff").body().message.contains("read-only"));
    }
}
