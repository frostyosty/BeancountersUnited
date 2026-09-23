//! The command pipeline: decode, authorise, validate, apply, append to `command_log`, commit.
//!
//! Each command runs in one transaction on the writer connection. Any error drops the
//! transaction, so a rejected command leaves nothing behind.

use acct_core::{AccountType, Chart, ClientYear, Journal, JournalLine};
use acct_store::charts::MasterChart;
use acct_store::clients::Client;
use acct_store::journals::{JournalKind, StoredJournal};
use acct_store::log::LoggedCommand;
use acct_store::practice::Practice;
use acct_store::sqlx::Connection;
use acct_store::templates::{MappingInfo, TemplateInfo};
use acct_store::users::{Role, User};
use acct_store::years::{StoredYear, YearStatus};
use acct_store::{
    SqliteConnection, Store, charts, clients, journals, log, new_id, practice, templates, users,
    years,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

use crate::auth;
use crate::commands::{Accepted, Command, CommandEnvelope};
use crate::error::CommandError;

/// Who is submitting a command. `user_id` is `None` only for `acctd init` on the server itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub user_id: Option<String>,
    pub role: Role,
}

/// What an applied command touched, for its response and the sync feed.
#[derive(Default)]
struct Effect {
    entity_id: Option<String>,
    client_id: Option<String>,
    client_year_id: Option<String>,
}

/// Runs one command through the pipeline. `at` is when it was received, in UTC.
pub async fn submit(
    store: &Store,
    actor: &Actor,
    envelope: CommandEnvelope,
    at: DateTime<Utc>,
) -> Result<Accepted, CommandError> {
    let id = uuid::Uuid::parse_str(&envelope.id)
        .map_err(|_| CommandError::Malformed(format!("{:?} isn't a UUID", envelope.id)))?
        .hyphenated()
        .to_string();
    let command = envelope.command;
    let payload = command.logged_payload();

    let mut writer = store.writer().await;
    let mut tx = writer.begin().await?;

    // A resubmitted id gets the original result, as long as it's the same command.
    if let Some(prev) = log::find(&mut tx, &id).await? {
        let same_payload = serde_json::from_str::<Value>(&prev.payload).ok() == Some(payload);
        if prev.kind != command.kind() || !same_payload {
            return Err(CommandError::IdReused(id));
        }
        return serde_json::from_str(&prev.result)
            .map_err(|e| CommandError::Store(acct_store::StoreError::Corrupt(e.to_string())));
    }

    if !command.allowed_for(actor) {
        return Err(CommandError::Forbidden);
    }

    let seq = log::next_seq(&mut tx).await?;
    let effect = apply(&mut tx, &command, seq).await?;
    let accepted = Accepted {
        seq,
        entity_id: effect.entity_id,
    };
    log::append(
        &mut tx,
        &LoggedCommand {
            seq,
            id,
            kind: command.kind().to_owned(),
            payload: payload.to_string(),
            result: serde_json::to_string(&accepted).expect("results serialise"),
            user_id: actor.user_id.clone(),
            client_id: effect.client_id,
            client_year_id: effect.client_year_id,
            at,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(accepted)
}

/// Validates the command against the current state, then applies it.
async fn apply(
    tx: &mut SqliteConnection,
    command: &Command,
    seq: i64,
) -> Result<Effect, CommandError> {
    match command {
        Command::Initialise {
            practice_name,
            username,
            display_name,
            password,
        } => {
            check_name(practice_name)?;
            if practice::get(tx).await?.is_some() {
                return Err(CommandError::invalid(
                    "already_initialised",
                    "This server has already been set up.",
                ));
            }
            practice::insert(
                tx,
                &Practice {
                    name: practice_name.trim().to_owned(),
                    created_seq: seq,
                },
            )
            .await?;
            let id = create_user(tx, username, display_name, password, Role::Master, seq).await?;
            Ok(created(id))
        }

        Command::CreateUser {
            username,
            display_name,
            password,
            role,
        } => {
            let id = create_user(tx, username, display_name, password, *role, seq).await?;
            Ok(created(id))
        }

        Command::CreateMasterChart {
            entity_type,
            name,
            accounts,
        } => {
            check_entity_type(entity_type)?;
            check_name(name)?;
            if charts::for_entity_type(tx, entity_type).await?.is_some() {
                return Err(CommandError::invalid(
                    "master_chart_exists",
                    format!("There's already a master chart for {entity_type}."),
                ));
            }
            let chart = Chart::new(accounts.clone())
                .map_err(|e| CommandError::invalid("invalid_chart", e.to_string()))?;
            let id = new_id();
            charts::insert(
                tx,
                &MasterChart {
                    id: id.clone(),
                    entity_type: entity_type.clone(),
                    name: name.clone(),
                    created_seq: seq,
                    chart,
                },
            )
            .await?;
            Ok(created(id))
        }

        Command::CreateTemplate {
            entity_type,
            name,
            body,
        } => {
            check_entity_type(entity_type)?;
            check_name(name)?;
            check_template(body)?;
            let id = new_id();
            templates::insert_template(
                tx,
                &TemplateInfo {
                    id: id.clone(),
                    entity_type: entity_type.clone(),
                    name: name.clone(),
                    created_seq: seq,
                },
            )
            .await?;
            templates::add_template_version(tx, &new_id(), &id, body, seq).await?;
            Ok(created(id))
        }

        Command::ReviseTemplate { template_id, body } => {
            templates::get_template(tx, template_id)
                .await?
                .ok_or_else(|| CommandError::not_found("template", template_id))?;
            check_template(body)?;
            let version_id = new_id();
            templates::add_template_version(tx, &version_id, template_id, body, seq).await?;
            Ok(created(version_id))
        }

        Command::CreateMapping {
            template_id,
            name,
            body,
        } => {
            check_name(name)?;
            let template = templates::latest_template_version(tx, template_id)
                .await?
                .ok_or_else(|| CommandError::not_found("template", template_id))?;
            check_mapping(body, &template.body)?;
            let id = new_id();
            templates::insert_mapping(
                tx,
                &MappingInfo {
                    id: id.clone(),
                    template_id: template_id.clone(),
                    name: name.clone(),
                    created_seq: seq,
                },
            )
            .await?;
            templates::add_mapping_version(tx, &new_id(), &id, body, seq).await?;
            Ok(created(id))
        }

        Command::ReviseMapping { mapping_id, body } => {
            let mapping = templates::get_mapping(tx, mapping_id)
                .await?
                .ok_or_else(|| CommandError::not_found("mapping", mapping_id))?;
            let template = latest_template(tx, &mapping.template_id).await?;
            check_mapping(body, &template)?;
            let version_id = new_id();
            templates::add_mapping_version(tx, &version_id, mapping_id, body, seq).await?;
            Ok(created(version_id))
        }

        Command::CreateClient {
            name,
            entity_type,
            retained_earnings,
            rounding_priority,
        } => {
            check_name(name)?;
            let master = charts::for_entity_type(tx, entity_type)
                .await?
                .ok_or_else(|| {
                    CommandError::invalid(
                        "no_master_chart",
                        format!("There's no master chart for {entity_type} yet."),
                    )
                })?;
            let chart = master.chart;
            match chart.get(retained_earnings) {
                Some(a) if a.account_type == AccountType::Equity && a.active => {}
                _ => {
                    return Err(CommandError::invalid(
                        "invalid_retained_earnings",
                        format!("{retained_earnings} isn't an active equity account in the chart."),
                    ));
                }
            }
            let mut problems = Vec::new();
            for (i, code) in rounding_priority.iter().enumerate() {
                if chart.get(code).is_none() {
                    problems.push(json!({ "code": "unknown_account", "account": code }));
                } else if rounding_priority[..i].contains(code) {
                    problems.push(json!({ "code": "duplicate", "account": code }));
                }
            }
            if !problems.is_empty() {
                return Err(CommandError::invalid_with(
                    "invalid_rounding_priority",
                    "The rounding priority list has accounts that aren't in the chart, or repeats.",
                    problems,
                ));
            }
            let id = new_id();
            clients::insert(
                tx,
                &Client {
                    id: id.clone(),
                    name: name.clone(),
                    entity_type: entity_type.clone(),
                    retained_earnings: retained_earnings.clone(),
                    rounding_priority: rounding_priority.clone(),
                    created_seq: seq,
                },
            )
            .await?;
            for account in chart.accounts() {
                clients::insert_account(tx, &id, account).await?;
            }
            Ok(Effect {
                entity_id: Some(id.clone()),
                client_id: Some(id),
                client_year_id: None,
            })
        }

        Command::CreateClientYear {
            client_id,
            start,
            end,
            mapping_id,
        } => {
            let client = clients::get(tx, client_id)
                .await?
                .ok_or_else(|| CommandError::not_found("client", client_id))?;
            let year = ClientYear::new(*start, *end)
                .map_err(|e| CommandError::invalid("invalid_dates", e.to_string()))?;
            let existing = years::for_client(tx, client_id).await?;
            let neighbour = match (existing.first(), existing.last()) {
                (Some(first), Some(last)) => {
                    if last.year.end().succ_opt() == Some(year.start()) {
                        Some(last)
                    } else if year.end().succ_opt() == Some(first.year.start()) {
                        Some(first)
                    } else {
                        return Err(CommandError::invalid_with(
                            "year_not_adjacent",
                            format!(
                                "A new year must end on {} or start on {}.",
                                first.year.start().pred_opt().unwrap_or(first.year.start()),
                                last.year.end().succ_opt().unwrap_or(last.year.end()),
                            ),
                            json!({ "first_start": first.year.start(), "last_end": last.year.end() }),
                        ));
                    }
                }
                _ => None,
            };
            let (template_version_id, mapping_version_id) = match (mapping_id, neighbour) {
                (Some(mapping_id), _) => {
                    let mapping = templates::get_mapping(tx, mapping_id)
                        .await?
                        .ok_or_else(|| CommandError::not_found("mapping", mapping_id))?;
                    pin_latest(tx, &mapping, &client.entity_type).await?
                }
                (None, Some(n)) => (n.template_version_id.clone(), n.mapping_version_id.clone()),
                (None, None) => {
                    let candidates =
                        templates::mappings_for_entity_type(tx, &client.entity_type).await?;
                    let [mapping] = candidates.as_slice() else {
                        return Err(CommandError::invalid(
                            "mapping_required",
                            format!(
                                "There are {} mappings for {}, so choose one.",
                                candidates.len(),
                                client.entity_type
                            ),
                        ));
                    };
                    pin_latest(tx, mapping, &client.entity_type).await?
                }
            };
            let id = new_id();
            years::insert(
                tx,
                &StoredYear {
                    id: id.clone(),
                    client_id: client_id.clone(),
                    year,
                    template_version_id,
                    mapping_version_id,
                    books_source: None,
                    status: YearStatus::Open,
                    created_seq: seq,
                },
            )
            .await?;
            Ok(Effect {
                entity_id: Some(id.clone()),
                client_id: Some(client_id.clone()),
                client_year_id: Some(id),
            })
        }

        Command::PostJournal {
            client_year_id,
            date,
            narration,
            lines,
        } => {
            let year = open_year(tx, client_year_id).await?;
            let journal = Journal {
                date: *date,
                narration: narration.clone(),
                lines: lines.clone(),
            };
            post(tx, &year, journal, JournalKind::Manual, None, seq).await
        }

        Command::ReverseJournal {
            journal_id,
            date,
            narration,
        } => {
            let original = journals::get(tx, journal_id)
                .await?
                .ok_or_else(|| CommandError::not_found("journal", journal_id))?;
            if original.kind != JournalKind::Manual {
                return Err(CommandError::invalid(
                    "system_journal",
                    "This journal is generated by the system. Change its source instead.",
                ));
            }
            if let Some(by) = journals::reversal_of(tx, journal_id).await? {
                return Err(CommandError::invalid_with(
                    "already_reversed",
                    "This journal has already been reversed.",
                    json!({ "reversed_by": by }),
                ));
            }
            let year = open_year(tx, &original.client_year_id).await?;
            let journal = Journal {
                date: date.unwrap_or(original.journal.date),
                narration: narration
                    .clone()
                    .unwrap_or_else(|| format!("Reversal of: {}", original.journal.narration)),
                lines: original
                    .journal
                    .lines
                    .iter()
                    .map(|l| JournalLine {
                        account: l.account.clone(),
                        amount: -l.amount,
                    })
                    .collect(),
            };
            post(
                tx,
                &year,
                journal,
                JournalKind::Manual,
                Some(original.id),
                seq,
            )
            .await
        }
    }
}

async fn create_user(
    tx: &mut SqliteConnection,
    username: &str,
    display_name: &str,
    password: &str,
    role: Role,
    seq: i64,
) -> Result<String, CommandError> {
    let username = username.trim();
    let ok = !username.is_empty()
        && username.len() <= 64
        && username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if !ok {
        return Err(CommandError::invalid(
            "invalid_username",
            "A username is 1 to 64 letters, digits, dots, dashes or underscores.",
        ));
    }
    check_name(display_name)?;
    auth::check_password_rules(password)?;
    if users::by_username(tx, username).await?.is_some() {
        return Err(CommandError::invalid(
            "username_taken",
            format!("There's already a user called {username}."),
        ));
    }
    let id = new_id();
    users::insert(
        tx,
        &User {
            id: id.clone(),
            username: username.to_owned(),
            display_name: display_name.trim().to_owned(),
            password_hash: auth::hash_password(password),
            role,
            active: true,
            created_seq: seq,
        },
    )
    .await?;
    Ok(id)
}

fn created(id: String) -> Effect {
    Effect {
        entity_id: Some(id),
        ..Effect::default()
    }
}

fn check_name(name: &str) -> Result<(), CommandError> {
    if name.trim().is_empty() {
        return Err(CommandError::invalid("empty_name", "A name is required."));
    }
    Ok(())
}

/// Entity types are lowercase words joined by underscores, such as `company` or `sole_trader`.
fn check_entity_type(entity_type: &str) -> Result<(), CommandError> {
    let ok = !entity_type.is_empty()
        && entity_type
            .split('_')
            .all(|w| !w.is_empty() && w.bytes().all(|b| b.is_ascii_lowercase()));
    if !ok {
        return Err(CommandError::invalid(
            "invalid_entity_type",
            format!("{entity_type:?} isn't a valid entity type (e.g. company, sole_trader)."),
        ));
    }
    Ok(())
}

fn check_template(template: &acct_core::Template) -> Result<(), CommandError> {
    template.validate().map_err(|errors| {
        let messages: Vec<String> = errors.iter().map(ToString::to_string).collect();
        CommandError::invalid_with("invalid_template", "The template has problems.", messages)
    })
}

fn check_mapping(
    mapping: &acct_core::Mapping,
    template: &acct_core::Template,
) -> Result<(), CommandError> {
    mapping.validate(template).map_err(|errors| {
        CommandError::invalid_with("invalid_mapping", "The mapping has problems.", errors)
    })
}

async fn latest_template(
    tx: &mut SqliteConnection,
    template_id: &str,
) -> Result<acct_core::Template, CommandError> {
    Ok(templates::latest_template_version(tx, template_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template", template_id))?
        .body)
}

/// The latest versions of a mapping and its template, checked against each other.
async fn pin_latest(
    tx: &mut SqliteConnection,
    mapping: &MappingInfo,
    entity_type: &str,
) -> Result<(String, String), CommandError> {
    let template = templates::latest_template_version(tx, &mapping.template_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template", &mapping.template_id))?;
    let info = templates::get_template(tx, &mapping.template_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template", &mapping.template_id))?;
    if info.entity_type != entity_type {
        return Err(CommandError::invalid(
            "wrong_entity_type",
            format!(
                "That mapping is for {}, not {entity_type}.",
                info.entity_type
            ),
        ));
    }
    let version = templates::latest_mapping_version(tx, &mapping.id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping", &mapping.id))?;
    check_mapping(&version.body, &template.body)?;
    Ok((template.id, version.id))
}

/// A year that exists and isn't finalised.
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

async fn post(
    tx: &mut SqliteConnection,
    year: &StoredYear,
    journal: Journal,
    kind: JournalKind,
    reverses_journal_id: Option<String>,
    seq: i64,
) -> Result<Effect, CommandError> {
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
    Ok(Effect {
        entity_id: Some(id),
        client_id: Some(year.client_id.clone()),
        client_year_id: Some(year.id.clone()),
    })
}
