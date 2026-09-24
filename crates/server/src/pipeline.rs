//! The command pipeline: decode, authorise, validate, apply, append to `command_log`, commit.
//!
//! Each command runs in one transaction on the writer connection. Any error drops the
//! transaction, so a rejected command leaves nothing behind.

use acct_core::{
    Account, AccountCode, AccountType, Asset, Chart, ChartError, ClientYear, DepreciationSettings,
    Journal, JournalLine, RateSource,
};
use acct_store::assets::{self as asset_store, AssetClass, ClassOverride, StoredAsset};
use acct_store::charts::MasterChart;
use acct_store::clients::Client;
use acct_store::journals::{JournalKind, StoredJournal};
use acct_store::log::LoggedCommand;
use acct_store::practice::Practice;
use acct_store::sqlx::Connection;
use acct_store::templates::{MappingInfo, TemplateInfo};
use acct_store::users::{Role, User};
use acct_store::years::{BooksSource, StoredYear, YearStatus};
use acct_store::{
    SqliteConnection, Store, charts, clients, journals, log, new_id, practice, sessions, templates,
    users, years,
};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};

use crate::assets;
use crate::auth;
use crate::commands::{Accepted, Command, CommandEnvelope};
use crate::error::CommandError;
use crate::ledger;
use crate::tb_import;

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
    let effect = apply(&mut tx, actor, &command, seq).await?;
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
    actor: &Actor,
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

        Command::ChangeOwnPassword {
            current_password,
            new_password,
        } => {
            let user_id = actor.user_id.as_deref().ok_or(CommandError::Forbidden)?;
            let user = users::get(tx, user_id)
                .await?
                .ok_or_else(|| CommandError::not_found("user", user_id))?;
            if !auth::verify_password(current_password, &user.password_hash) {
                return Err(CommandError::invalid(
                    "wrong_password",
                    "The current password isn't right.",
                ));
            }
            auth::check_password_rules(new_password)?;
            users::set_password_hash(tx, user_id, &auth::hash_password(new_password)).await?;
            Ok(no_effect())
        }

        Command::ResetPassword {
            user_id,
            new_password,
        } => {
            users::get(tx, user_id)
                .await?
                .ok_or_else(|| CommandError::not_found("user", user_id))?;
            auth::check_password_rules(new_password)?;
            users::set_password_hash(tx, user_id, &auth::hash_password(new_password)).await?;
            sessions::delete_for_user(tx, user_id).await?;
            Ok(no_effect())
        }

        Command::SetUserActive { user_id, active } => {
            let user = users::get(tx, user_id)
                .await?
                .ok_or_else(|| CommandError::not_found("user", user_id))?;
            if !*active {
                if actor.user_id.as_deref() == Some(user_id.as_str()) {
                    return Err(CommandError::invalid(
                        "cannot_deactivate_self",
                        "You can't make yourself inactive.",
                    ));
                }
                if user.active
                    && user.role == Role::Master
                    && users::count_active(tx, Role::Master).await? <= 1
                {
                    return Err(CommandError::invalid(
                        "last_master",
                        "The practice needs at least one active master user.",
                    ));
                }
                sessions::delete_for_user(tx, user_id).await?;
            }
            users::set_active(tx, user_id, *active).await?;
            Ok(no_effect())
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
            check_rounding_priority(&chart, rounding_priority)?;
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

        Command::AddAccount { client_id, account } => {
            let chart = client_chart(tx, client_id).await?;
            let account = Account {
                name: account.name.trim().to_owned(),
                ..account.clone()
            };
            chart.with_account(account.clone()).map_err(chart_error)?;
            clients::insert_account(tx, client_id, &account).await?;
            Ok(client_effect(client_id))
        }

        Command::RenameAccount {
            client_id,
            code,
            name,
        } => {
            let chart = client_chart(tx, client_id).await?;
            let edited = chart.renamed(code, name.trim()).map_err(chart_error)?;
            let account = edited.get(code).expect("just renamed");
            clients::update_account(tx, client_id, account).await?;
            Ok(client_effect(client_id))
        }

        Command::SetAccountActive {
            client_id,
            code,
            active,
        } => {
            let client = clients::get(tx, client_id)
                .await?
                .ok_or_else(|| CommandError::not_found("client", client_id))?;
            let chart = clients::chart(tx, client_id).await?;
            let edited = chart.with_active(code, *active).map_err(chart_error)?;
            if !*active {
                if *code == client.retained_earnings {
                    return Err(CommandError::invalid(
                        "account_in_use",
                        format!("{code} is the retained earnings account, so it stays active."),
                    ));
                }
                let open_with_balance: Vec<Value> = ledger::client_balances(tx, &client, &chart)
                    .await?
                    .iter()
                    .filter(|b| b.year.status == YearStatus::Open)
                    .filter(|b| !b.closing.balance(code).is_zero())
                    .map(|b| json!({ "client_year_id": b.year.id, "end": b.year.year.end() }))
                    .collect();
                if !open_with_balance.is_empty() {
                    return Err(CommandError::invalid_with(
                        "account_in_use",
                        format!(
                            "{code} has a balance in an open year, so it can't be made inactive."
                        ),
                        open_with_balance,
                    ));
                }
            }
            let account = edited.get(code).expect("just edited");
            clients::update_account(tx, client_id, account).await?;
            Ok(client_effect(client_id))
        }

        Command::SetRoundingPriority {
            client_id,
            rounding_priority,
        } => {
            let chart = client_chart(tx, client_id).await?;
            check_rounding_priority(&chart, rounding_priority)?;
            clients::set_rounding_priority(tx, client_id, rounding_priority).await?;
            Ok(client_effect(client_id))
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

        Command::ImportTb {
            client_year_id,
            rows,
        } => {
            let year = open_year(tx, client_year_id).await?;
            let plan = tb_import::plan(tx, client_year_id, rows).await?;
            if !plan.problems.is_empty() {
                return Err(CommandError::invalid_with(
                    "tb_import_rejected",
                    "The trial balance can't be imported until these are fixed.",
                    &plan.problems,
                ));
            }
            years::set_books_source(tx, client_year_id, BooksSource::TbImport).await?;
            let mut effect = Effect {
                entity_id: None,
                client_id: Some(year.client_id.clone()),
                client_year_id: Some(year.id.clone()),
            };
            if plan.unchanged() {
                return Ok(effect);
            }
            if let Some(current) = plan.current {
                let reversal = Journal {
                    date: current.journal.date,
                    narration: format!("Reversal of: {}", current.journal.narration),
                    lines: negated(&current.journal.lines),
                };
                post(
                    tx,
                    &year,
                    reversal,
                    JournalKind::TbImport,
                    Some(current.id),
                    seq,
                )
                .await?;
            }
            if !plan.lines.is_empty() {
                let journal = Journal {
                    date: year.year.end(),
                    narration: tb_import::NARRATION.to_owned(),
                    lines: plan.lines,
                };
                effect = post(tx, &year, journal, JournalKind::TbImport, None, seq).await?;
            }
            Ok(effect)
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
                lines: negated(&original.journal.lines),
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

        Command::CreateAssetClass {
            entity_type,
            key,
            name,
            settings,
            accounts,
        } => {
            check_entity_type(entity_type)?;
            check_class_key(key)?;
            check_name(name)?;
            assets::check_settings(settings)?;
            let master = charts::for_entity_type(tx, entity_type)
                .await?
                .ok_or_else(|| {
                    CommandError::invalid(
                        "no_master_chart",
                        format!("There's no master chart for {entity_type} yet."),
                    )
                })?;
            assets::check_accounts(&master.chart, accounts)?;
            let existing = asset_store::classes_for_entity_type(tx, entity_type).await?;
            if existing.iter().any(|c| c.key == *key) {
                return Err(CommandError::invalid(
                    "asset_class_exists",
                    format!("There's already an asset class {key} for {entity_type}."),
                ));
            }
            let id = new_id();
            asset_store::insert_class(
                tx,
                &AssetClass {
                    id: id.clone(),
                    entity_type: entity_type.clone(),
                    key: key.clone(),
                    name: name.trim().to_owned(),
                    settings: *settings,
                    accounts: accounts.clone(),
                    created_seq: seq,
                    updated_seq: seq,
                },
            )
            .await?;
            Ok(created(id))
        }

        Command::UpdateAssetClass {
            class_id,
            name,
            settings,
            accounts,
        } => {
            let class = asset_store::get_class(tx, class_id)
                .await?
                .ok_or_else(|| CommandError::not_found("asset class", class_id))?;
            check_name(name)?;
            assets::check_settings(settings)?;
            let master = charts::for_entity_type(tx, &class.entity_type)
                .await?
                .ok_or_else(|| CommandError::not_found("master chart", &class.entity_type))?;
            assets::check_accounts(&master.chart, accounts)?;
            asset_store::update_class(
                tx,
                &AssetClass {
                    name: name.trim().to_owned(),
                    settings: *settings,
                    accounts: accounts.clone(),
                    updated_seq: seq,
                    ..class
                },
            )
            .await?;
            Ok(created(class_id.clone()))
        }

        Command::SetClientAssetClass {
            client_id,
            class_id,
            settings,
            accounts,
        } => {
            let (_, chart, _) = client_class(tx, client_id, class_id).await?;
            if let Some(s) = settings {
                assets::check_settings(s)?;
            }
            if let Some(a) = accounts {
                assets::check_accounts(&chart, a)?;
            }
            asset_store::set_override(
                tx,
                &ClassOverride {
                    client_id: client_id.clone(),
                    class_id: class_id.clone(),
                    settings: *settings,
                    accounts: accounts.clone(),
                    updated_seq: seq,
                },
            )
            .await?;
            Ok(client_effect(client_id))
        }

        Command::CreateAsset {
            client_id,
            class_id,
            name,
            cost,
            residual,
            acquired,
            settings,
            opening,
        } => {
            let (class, chart, over) = client_class(tx, client_id, class_id).await?;
            check_name(name)?;
            let resolved = assets::resolve(&class, over.as_ref());
            assets::check_accounts(&chart, &resolved.accounts)?;
            let (settings, rate_source) = pick_settings(&resolved, settings.as_ref());
            let asset = Asset {
                cost: *cost,
                residual: *residual,
                acquired: *acquired,
                settings,
                opening: *opening,
                disposal: None,
            };
            check_asset(tx, client_id, &asset).await?;
            let id = new_id();
            asset_store::insert_asset(
                tx,
                &StoredAsset {
                    id: id.clone(),
                    client_id: client_id.clone(),
                    class_id: class_id.clone(),
                    name: name.trim().to_owned(),
                    rate_source,
                    accounts: resolved.accounts,
                    asset,
                    created_seq: seq,
                    updated_seq: seq,
                },
            )
            .await?;
            Ok(Effect {
                entity_id: Some(id),
                client_id: Some(client_id.clone()),
                client_year_id: None,
            })
        }

        Command::UpdateAsset {
            asset_id,
            name,
            cost,
            residual,
            acquired,
            settings,
            opening,
        } => {
            let (stored, fixed) = asset_in_register(tx, asset_id).await?;
            check_name(name)?;
            let a = &stored.asset;
            if fixed
                && (a.cost != *cost
                    || a.residual != *residual
                    || a.acquired != *acquired
                    || a.opening != *opening)
            {
                return Err(CommandError::invalid(
                    "asset_fixed",
                    "A finalised year holds this asset, so its cost, residual, acquisition date \
                     and brought-forward balance can't change.",
                ));
            }
            let (class, _, over) = client_class(tx, &stored.client_id, &stored.class_id).await?;
            let resolved = assets::resolve(&class, over.as_ref());
            let (settings, rate_source) = pick_settings(&resolved, settings.as_ref());
            let asset = Asset {
                cost: *cost,
                residual: *residual,
                acquired: *acquired,
                settings,
                opening: *opening,
                disposal: stored.asset.disposal.clone(),
            };
            check_asset(tx, &stored.client_id, &asset).await?;
            asset_store::update_asset(
                tx,
                &StoredAsset {
                    name: name.trim().to_owned(),
                    rate_source,
                    asset,
                    updated_seq: seq,
                    ..stored.clone()
                },
            )
            .await?;
            Ok(client_effect(&stored.client_id))
        }

        Command::DeleteAsset { asset_id } => {
            let (stored, fixed) = asset_in_register(tx, asset_id).await?;
            if fixed {
                return Err(CommandError::invalid(
                    "asset_fixed",
                    "A finalised year holds this asset, so it can't be deleted.",
                ));
            }
            asset_store::delete_asset(tx, asset_id).await?;
            Ok(client_effect(&stored.client_id))
        }

        Command::DisposeAsset { asset_id, disposal } => {
            let (stored, _) = asset_in_register(tx, asset_id).await?;
            if stored.asset.disposal.is_some() {
                return Err(CommandError::invalid(
                    "already_disposed",
                    "This asset has already been disposed of. Reinstate it first to change the \
                     disposal.",
                ));
            }
            let year = year_containing(tx, &stored.client_id, disposal.date).await?;
            let chart = clients::chart(tx, &stored.client_id).await?;
            match chart.get(&disposal.proceeds_account) {
                Some(a) if a.active => {}
                _ => {
                    return Err(CommandError::invalid(
                        "invalid_proceeds_account",
                        format!(
                            "{} isn't an active account in the chart.",
                            disposal.proceeds_account
                        ),
                    ));
                }
            }
            let asset = Asset {
                disposal: Some(disposal.clone()),
                ..stored.asset.clone()
            };
            check_asset(tx, &stored.client_id, &asset).await?;
            asset_store::update_asset(
                tx,
                &StoredAsset {
                    asset,
                    updated_seq: seq,
                    ..stored.clone()
                },
            )
            .await?;
            regenerate(tx, &year, seq).await?;
            Ok(Effect {
                entity_id: None,
                client_id: Some(stored.client_id),
                client_year_id: Some(year.id),
            })
        }

        Command::ReinstateAsset { asset_id } => {
            let (stored, _) = asset_in_register(tx, asset_id).await?;
            let Some(disposal) = &stored.asset.disposal else {
                return Err(CommandError::invalid(
                    "not_disposed",
                    "This asset hasn't been disposed of.",
                ));
            };
            let year = year_containing(tx, &stored.client_id, disposal.date).await?;
            asset_store::update_asset(
                tx,
                &StoredAsset {
                    asset: Asset {
                        disposal: None,
                        ..stored.asset.clone()
                    },
                    updated_seq: seq,
                    ..stored.clone()
                },
            )
            .await?;
            regenerate(tx, &year, seq).await?;
            Ok(Effect {
                entity_id: None,
                client_id: Some(stored.client_id),
                client_year_id: Some(year.id),
            })
        }

        Command::RunDepreciation { client_year_id } => {
            let year = open_year(tx, client_year_id).await?;
            for y in years::for_client(tx, &year.client_id).await? {
                if y.status == YearStatus::Open && y.year.start() <= year.year.start() {
                    regenerate(tx, &y, seq).await?;
                }
            }
            Ok(Effect {
                entity_id: None,
                client_id: Some(year.client_id),
                client_year_id: Some(year.id),
            })
        }

        Command::ApplyAssetClassDefaults {
            client_id,
            class_id,
        } => {
            let (resolved, changes) = assets::apply_defaults_plan(tx, client_id, class_id).await?;
            let chart = clients::chart(tx, client_id).await?;
            if !changes.is_empty() {
                assets::check_accounts(&chart, &resolved.accounts)?;
            }
            for change in &changes {
                let stored = asset_store::get_asset(tx, &change.asset_id)
                    .await?
                    .ok_or_else(|| CommandError::not_found("asset", &change.asset_id))?;
                let rate_source = if stored.rate_source == RateSource::Custom {
                    RateSource::Custom
                } else {
                    resolved.source
                };
                asset_store::update_asset(
                    tx,
                    &StoredAsset {
                        rate_source,
                        accounts: change.accounts_to.clone(),
                        asset: Asset {
                            settings: change.settings_to,
                            ..stored.asset.clone()
                        },
                        updated_seq: seq,
                        ..stored
                    },
                )
                .await?;
            }
            Ok(client_effect(client_id))
        }
    }
}

/// Asset class keys are lowercase words joined by underscores, such as `plant` or
/// `motor_vehicles`.
fn check_class_key(key: &str) -> Result<(), CommandError> {
    let ok = !key.is_empty()
        && key.len() <= 40
        && key.split('_').all(|w| {
            !w.is_empty()
                && w.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        });
    if !ok {
        return Err(CommandError::invalid(
            "invalid_class_key",
            format!("{key:?} isn't a valid class key (e.g. plant, motor_vehicles)."),
        ));
    }
    Ok(())
}

/// A client, a class for its entity type, the client's chart and its override of the class.
async fn client_class(
    tx: &mut SqliteConnection,
    client_id: &str,
    class_id: &str,
) -> Result<(AssetClass, Chart, Option<ClassOverride>), CommandError> {
    let client = clients::get(tx, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", client_id))?;
    let class = asset_store::get_class(tx, class_id)
        .await?
        .filter(|c| c.entity_type == client.entity_type)
        .ok_or_else(|| CommandError::not_found("asset class", class_id))?;
    let chart = clients::chart(tx, client_id).await?;
    let over = asset_store::overrides_for_client(tx, client_id)
        .await?
        .into_iter()
        .find(|o| o.class_id == class_id);
    Ok((class, chart, over))
}

/// The settings to put on an asset, and where they came from: `requested` if it's given and
/// differs from the class's defaults, else the defaults.
fn pick_settings(
    resolved: &assets::ResolvedClass,
    requested: Option<&DepreciationSettings>,
) -> (DepreciationSettings, RateSource) {
    match requested {
        Some(s) if *s != resolved.settings => (*s, RateSource::Custom),
        _ => (resolved.settings, resolved.source),
    }
}

/// Checks an asset on its own and against the client's years.
async fn check_asset(
    tx: &mut SqliteConnection,
    client_id: &str,
    asset: &Asset,
) -> Result<(), CommandError> {
    asset.validate().map_err(|errors| {
        CommandError::invalid_with("invalid_asset", "The asset has problems.", errors)
    })?;
    let years: Vec<ClientYear> = years::for_client(tx, client_id)
        .await?
        .iter()
        .map(|y| y.year)
        .collect();
    acct_core::asset_years(asset, &years, &Default::default())
        .map_err(|e| CommandError::invalid_with("invalid_asset", e.to_string(), [e]))?;
    Ok(())
}

/// An asset, and whether a finalised year holds it.
async fn asset_in_register(
    tx: &mut SqliteConnection,
    asset_id: &str,
) -> Result<(StoredAsset, bool), CommandError> {
    let stored = asset_store::get_asset(tx, asset_id)
        .await?
        .ok_or_else(|| CommandError::not_found("asset", asset_id))?;
    let register = assets::load(tx, &stored.client_id).await?;
    let i = register
        .assets
        .iter()
        .position(|a| a.id == asset_id)
        .expect("the asset is in its client's register");
    Ok((stored, register.in_finalised_year(i)))
}

/// The client's open year containing `date`.
async fn year_containing(
    tx: &mut SqliteConnection,
    client_id: &str,
    date: chrono::NaiveDate,
) -> Result<StoredYear, CommandError> {
    let year = years::for_client(tx, client_id)
        .await?
        .into_iter()
        .find(|y| y.year.contains(date))
        .ok_or_else(|| {
            CommandError::invalid(
                "no_year_for_date",
                format!("The client has no year containing {date}."),
            )
        })?;
    open_year(tx, &year.id).await
}

/// Brings an open year's asset journals into line with the register: if they differ, reverses
/// the ones in force and posts the new ones, and records each asset's charge. Posts nothing if
/// they already match.
async fn regenerate(
    tx: &mut SqliteConnection,
    year: &StoredYear,
    seq: i64,
) -> Result<(), CommandError> {
    if year.status == YearStatus::Finalised {
        return Ok(());
    }
    let register = assets::load(tx, &year.client_id).await?;
    let i = register
        .year_index(&year.id)
        .expect("the year belongs to the client");
    let desired = register.desired_journals(i);
    let current = assets::current_journals(tx, &year.id).await?;
    if !assets::journals_match(&current, &desired) {
        for j in current {
            let reversal = Journal {
                date: j.journal.date,
                narration: format!("Reversal of: {}", j.journal.narration),
                lines: negated(&j.journal.lines),
            };
            post(tx, year, reversal, j.kind, Some(j.id), seq).await?;
        }
        if let Some(j) = desired.depreciation {
            post(tx, year, j, JournalKind::Depreciation, None, seq).await?;
        }
        for j in desired.disposals {
            post(tx, year, j, JournalKind::AssetDisposal, None, seq).await?;
        }
    }
    let charges: Vec<asset_store::Charge> = register
        .assets
        .iter()
        .zip(&register.rows)
        .filter(|(_, rows)| !rows[i].depreciation.is_zero())
        .map(|(a, rows)| asset_store::Charge {
            asset_id: a.id.clone(),
            client_year_id: year.id.clone(),
            amount: rows[i].depreciation,
        })
        .collect();
    asset_store::set_charges(tx, &year.id, &charges, seq).await?;
    Ok(())
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

fn negated(lines: &[JournalLine]) -> Vec<JournalLine> {
    lines
        .iter()
        .map(|l| JournalLine {
            account: l.account.clone(),
            amount: -l.amount,
        })
        .collect()
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
/// A client's chart; not found if the client doesn't exist.
async fn client_chart(tx: &mut SqliteConnection, client_id: &str) -> Result<Chart, CommandError> {
    clients::get(tx, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", client_id))?;
    Ok(clients::chart(tx, client_id).await?)
}

fn no_effect() -> Effect {
    Effect {
        entity_id: None,
        client_id: None,
        client_year_id: None,
    }
}

fn client_effect(client_id: &str) -> Effect {
    Effect {
        entity_id: None,
        client_id: Some(client_id.to_owned()),
        client_year_id: None,
    }
}

fn chart_error(e: ChartError) -> CommandError {
    let code = match e {
        ChartError::DuplicateCode(_) => "duplicate_account",
        ChartError::EmptyName(_) => "empty_name",
        ChartError::UnknownAccount(_) => "unknown_account",
    };
    let mut message = e.to_string();
    if let Some(first) = message.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    CommandError::invalid(code, format!("{message}."))
}

/// Every account on the list must be in the chart, once.
fn check_rounding_priority(
    chart: &Chart,
    rounding_priority: &[AccountCode],
) -> Result<(), CommandError> {
    let mut problems = Vec::new();
    for (i, code) in rounding_priority.iter().enumerate() {
        if chart.get(code).is_none() {
            problems.push(json!({ "code": "unknown_account", "account": code }));
        } else if rounding_priority[..i].contains(code) {
            problems.push(json!({ "code": "duplicate", "account": code }));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(CommandError::invalid_with(
            "invalid_rounding_priority",
            "The rounding priority list has accounts that aren't in the chart, or repeats.",
            problems,
        ))
    }
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
