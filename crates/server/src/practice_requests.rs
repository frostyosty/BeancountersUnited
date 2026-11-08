//! Requests for a practice account (M21, ADR 015, 7).
//!
//! An accountant or bookkeeper who tried it asks us to set their practice up:
//! `request_practice_account`, through the pipeline, on the public `POST /api/practice-requests`.
//! The route submits it with no user, whatever session the browser has, so a request is never tied
//! to a trial. Overseers list the requests (`GET /api/practice-requests`) and follow up by hand.
//!
//! The details live only in `practice_requests`: the log entry keeps `[redacted]` in their place
//! (`Command::logged_payload`), so deleting the row deletes them. The guest sweep deletes a
//! request 90 days after it arrived (`delete_practice_request`, `why: expired`); an overseer can
//! sooner (`why: by_overseer`).

use acct_store::practice_requests::{self as store, PracticeRequest};
use acct_store::users::Role;
use acct_store::{SqliteConnection, Store, log, new_id};
use axum::Json;
use axum::extract::State;
use axum::extract::rejection::JsonRejection;
use axum::http::{Extensions, HeaderMap};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::commands::{Accepted, Command, CommandEnvelope};
use crate::error::CommandError;
use crate::guests;
use crate::pipeline::{self, Actor, Effect};

/// Requests from one address in an hour (in memory, `guests::Limits`).
pub const PER_ADDRESS_PER_HOUR: u32 = 5;
/// Requests from every address together in a day, counted from the table so it holds across
/// restarts.
pub const PER_DAY: i64 = 100;
/// How long a request is kept.
pub const KEEP_DAYS: i64 = 90;

/// Roughly how many clients the practice has. PLAN.md asks for "roughly", so it's a band.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub enum PracticeClients {
    #[serde(rename = "up_to_10")]
    UpTo10,
    #[serde(rename = "11_to_50")]
    From11To50,
    #[serde(rename = "51_to_200")]
    From51To200,
    #[serde(rename = "over_200")]
    Over200,
}

impl PracticeClients {
    /// "11–50 clients", for Changes.
    pub fn words(self) -> &'static str {
        match self {
            PracticeClients::UpTo10 => "up to 10 clients",
            PracticeClients::From11To50 => "11–50 clients",
            PracticeClients::From51To200 => "51–200 clients",
            PracticeClients::Over200 => "over 200 clients",
        }
    }
}

/// Where the request was made, shown in the overseer's list.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum PracticeRequestFrom {
    /// "Who are you?" before saving a trial.
    WhoAreYou,
    /// `/accountants`.
    AccountantsPage,
    /// `/signup`.
    SignupPage,
}

/// Why a practice request was deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum DeleteWhy {
    /// 90 days are up. The server's sweep.
    Expired,
    /// An overseer deleted it: spam, or the person asked.
    ByOverseer,
}

/// A stored enum's serde name.
fn name_of<T: Serialize>(value: &T) -> String {
    match serde_json::to_value(value) {
        Ok(serde_json::Value::String(s)) => s,
        other => panic!("not a unit enum: {other:?}"),
    }
}

fn parse<T: for<'de> Deserialize<'de>>(s: &str) -> Result<T, CommandError> {
    serde_json::from_value(serde_json::Value::String(s.to_owned()))
        .map_err(|e| CommandError::Store(acct_store::StoreError::Corrupt(format!("{s:?}: {e}"))))
}

/// The refusal once an address, or everyone together, has sent too many.
pub fn too_many(retry_after_secs: u64) -> CommandError {
    CommandError::Limited {
        code: "too_many_requests",
        message: "We've had a few requests from your network in the last hour. Try again later, \
                  or get in touch through the contact page."
            .to_owned(),
        retry_after_secs,
    }
}

/// `text` trimmed, 1 to `max` characters, or refused with `code`.
fn required(
    text: &str,
    max: usize,
    code: &'static str,
    what: &str,
) -> Result<String, CommandError> {
    let t = text.trim();
    if t.is_empty() || t.chars().count() > max {
        return Err(CommandError::invalid(
            code,
            format!("{what} needs 1 to {max} characters."),
        ));
    }
    Ok(t.to_owned())
}

/// A phone number: at most 30 of digits, spaces and `+()-`. Blank is none.
fn phone(text: Option<&str>) -> Result<Option<String>, CommandError> {
    let Some(t) = text.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let ok = t.chars().count() <= 30
        && t.chars().any(|c| c.is_ascii_digit())
        && t.chars()
            .all(|c| c.is_ascii_digit() || matches!(c, ' ' | '+' | '(' | ')' | '-'));
    if !ok {
        return Err(CommandError::invalid(
            "invalid_phone",
            "A phone number is up to 30 digits, spaces and + ( ) -.",
        ));
    }
    Ok(Some(t.to_owned()))
}

/// Applies the practice request commands; `None` for every other command.
pub(crate) async fn apply(
    tx: &mut SqliteConnection,
    actor: &Actor,
    command: &Command,
    seq: i64,
    at: DateTime<Utc>,
) -> Result<Option<Effect>, CommandError> {
    let id = match command {
        Command::RequestPracticeAccount {
            name,
            email,
            practice_name,
            clients,
            phone: given_phone,
            from,
        } => {
            let name = required(name, 100, "invalid_name", "Your name")?;
            let email = email.trim();
            if email.chars().count() > 254 {
                return Err(CommandError::invalid(
                    "invalid_email",
                    "That email address is too long.",
                ));
            }
            let email = crate::signup::check_email(email)?;
            let practice_name = required(
                practice_name,
                120,
                "invalid_practice_name",
                "The practice name",
            )?;
            let phone = phone(given_phone.as_deref())?;
            if store::count_since(tx, at - Duration::days(1)).await? >= PER_DAY {
                return Err(too_many(3600));
            }
            let id = new_id();
            store::insert(
                tx,
                &PracticeRequest {
                    id: id.clone(),
                    name,
                    email,
                    practice_name,
                    clients: name_of(clients),
                    phone,
                    came_from: from.as_ref().map(name_of),
                    created_seq: seq,
                    created_at: at,
                },
            )
            .await?;
            id
        }
        Command::DeletePracticeRequest { request_id, why } => {
            let request = store::get(tx, request_id)
                .await?
                .ok_or_else(|| CommandError::not_found("practice request", request_id))?;
            match (actor.user_id.as_deref(), why) {
                // The server's sweep, once it's due.
                (None, DeleteWhy::Expired)
                    if request.created_at + Duration::days(KEEP_DAYS) <= at => {}
                (None, DeleteWhy::Expired) => {
                    return Err(CommandError::invalid(
                        "not_due",
                        "That request isn't 90 days old yet.",
                    ));
                }
                // An overseer, as themselves (the access check makes sure).
                (Some(_), DeleteWhy::ByOverseer) => {}
                _ => {
                    return Err(CommandError::invalid(
                        "server_only",
                        "Only the server deletes a request for being 90 days old.",
                    ));
                }
            }
            store::delete(tx, request_id).await?;
            request_id.clone()
        }
        _ => return Ok(None),
    };
    // About no business, so its log row is for overseers only (`history::row_shown`).
    Ok(Some(Effect {
        entity_id: Some(id),
        ..Effect::default()
    }))
}

/// Deletes, through the pipeline as the server, every request past its 90 days. The guest sweep
/// runs it. Returns how many it deleted.
pub async fn sweep(store: &Store, now: DateTime<Utc>) -> Result<usize, CommandError> {
    let due = {
        let mut conn = store.reader().await?;
        store::older_than(&mut conn, now - Duration::days(KEEP_DAYS)).await?
    };
    let server = Actor {
        user_id: None,
        role: Role::Overseer,
        acting_as: None,
    };
    let mut n = 0;
    for request_id in due {
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command: Command::DeletePracticeRequest {
                request_id,
                why: DeleteWhy::Expired,
            },
        };
        match pipeline::submit(store, &server, envelope, now).await {
            Ok(_) => n += 1,
            // Deleted by an overseer meanwhile.
            Err(CommandError::NotFound { .. }) => {}
            Err(e) => tracing::warn!(error = %e.body().code, "couldn't delete a practice request"),
        }
    }
    Ok(n)
}

// ---------------------------------------------------------------------------------------------
// Routes.

/// The body of `POST /api/practice-requests`. `id` is the command id, from `newId()`.
#[derive(Debug, Clone, Deserialize, TS)]
#[ts(export)]
pub struct PracticeRequestBody {
    pub id: String,
    pub name: String,
    pub email: String,
    pub practice_name: String,
    pub clients: PracticeClients,
    #[serde(default)]
    #[ts(optional)]
    pub phone: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub from: Option<PracticeRequestFrom>,
}

/// `POST /api/practice-requests`: a visitor, signed out or a guest, asks for a practice account.
/// Submitted with no user, so it's never tied to the browser's trial. Five per address an hour.
pub async fn post_request(
    State(state): State<AppState>,
    headers: HeaderMap,
    extensions: Extensions,
    body: Result<Json<PracticeRequestBody>, JsonRejection>,
) -> Result<Json<Accepted>, CommandError> {
    let Json(req) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let now = Utc::now();
    let replay = {
        let mut conn = state.store.reader().await?;
        let id = uuid::Uuid::parse_str(&req.id)
            .map_err(|_| CommandError::Malformed(format!("{:?} isn't a UUID", req.id)))?
            .hyphenated()
            .to_string();
        log::find(&mut conn, &id).await?.is_some()
    };
    if !replay {
        let address = guests::client_address(&headers, &extensions);
        state
            .guest_limits
            .take_practice_request(&address, now)
            .inspect_err(|e| guests::log_refusal(e, &address))?;
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
            command: Command::RequestPracticeAccount {
                name: req.name,
                email: req.email,
                practice_name: req.practice_name,
                clients: req.clients,
                phone: req.phone,
                from: req.from,
            },
        },
        now,
    )
    .await?;
    Ok(Json(accepted))
}

/// One request, for the overseer's list in Settings → Admin.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PracticeRequestView {
    pub id: String,
    pub name: String,
    pub email: String,
    pub practice_name: String,
    pub clients: PracticeClients,
    pub phone: Option<String>,
    pub from: Option<PracticeRequestFrom>,
    #[ts(type = "string")]
    pub created_at: DateTime<Utc>,
    /// When the sweep deletes it: 90 days after it arrived.
    #[ts(type = "string")]
    pub delete_after: DateTime<Utc>,
}

/// `GET /api/practice-requests`: every request, newest first. Overseers only.
pub async fn list_requests(
    State(state): State<AppState>,
    _user: CurrentUser,
) -> Result<Json<Vec<PracticeRequestView>>, CommandError> {
    let mut conn = state.store.reader().await?;
    let mut out = Vec::new();
    for r in store::list(&mut conn).await? {
        out.push(PracticeRequestView {
            clients: parse(&r.clients)?,
            from: r.came_from.as_deref().map(parse).transpose()?,
            delete_after: r.created_at + Duration::days(KEEP_DAYS),
            id: r.id,
            name: r.name,
            email: r.email,
            practice_name: r.practice_name,
            phone: r.phone,
            created_at: r.created_at,
        });
    }
    Ok(Json(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_and_sources_have_their_wire_names() {
        assert_eq!(name_of(&PracticeClients::From11To50), "11_to_50");
        assert_eq!(name_of(&PracticeClients::UpTo10), "up_to_10");
        assert_eq!(name_of(&PracticeRequestFrom::WhoAreYou), "who_are_you");
        assert_eq!(
            parse::<PracticeClients>("over_200").unwrap(),
            PracticeClients::Over200
        );
    }

    #[test]
    fn phones_are_digits_spaces_and_a_few_signs() {
        assert_eq!(phone(None).unwrap(), None);
        assert_eq!(phone(Some("  ")).unwrap(), None);
        assert_eq!(
            phone(Some(" +64 (9) 555-0100 ")).unwrap().as_deref(),
            Some("+64 (9) 555-0100")
        );
        assert!(phone(Some("call me")).is_err());
        assert!(phone(Some("()-+")).is_err());
        assert!(phone(Some(&"1".repeat(31))).is_err());
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(required(" Ana ", 100, "x", "Your name").unwrap(), "Ana");
        assert!(required("   ", 100, "x", "Your name").is_err());
        assert!(required(&"a".repeat(101), 100, "x", "Your name").is_err());
    }
}
