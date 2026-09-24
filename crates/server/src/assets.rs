//! The asset register on the server: resolving class defaults, computing each asset's movements
//! across the client's years, regenerating the depreciation and disposal journals, and the
//! register reads.

use std::collections::BTreeMap;

use acct_core::{
    AccountType, AssetAccounts, AssetSchedule, AssetYear, Chart, DepreciationSettings, Journal,
    Money, RateSource, ReconciliationLine, RegisterAsset, ScheduleClass, TrialBalance,
    YearJournals, asset_years, build_asset_schedule, reconcile, year_journals,
};
use acct_store::assets::{self, AssetClass, ClassOverride, StoredAsset};
use acct_store::journals::{self, JournalKind, StoredJournal};
use acct_store::years::{StoredYear, YearStatus};
use acct_store::{SqliteConnection, clients, years};
use axum::Json;
use axum::extract::{Path, State};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::CommandError;
use crate::ledger;

/// A class's defaults for one client: the client's override where there is one, else the
/// practice's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ResolvedClass {
    pub settings: DepreciationSettings,
    /// `practice` or `client`.
    pub source: RateSource,
    pub accounts: AssetAccounts,
}

pub fn resolve(class: &AssetClass, over: Option<&ClassOverride>) -> ResolvedClass {
    let settings = over.and_then(|o| o.settings);
    ResolvedClass {
        settings: settings.unwrap_or(class.settings),
        source: if settings.is_some() {
            RateSource::Client
        } else {
            RateSource::Practice
        },
        accounts: over
            .and_then(|o| o.accounts.clone())
            .unwrap_or_else(|| class.accounts.clone()),
    }
}

/// Every account must be in the chart and active, and of the right type: cost and accumulated
/// depreciation are assets, depreciation is an expense, and gain or loss on disposal is income or
/// an expense.
pub fn check_accounts(chart: &Chart, accounts: &AssetAccounts) -> Result<(), CommandError> {
    let wanted: [(&str, &acct_core::AccountCode, &[AccountType]); 4] = [
        ("cost", &accounts.cost, &[AccountType::Asset]),
        ("accumulated", &accounts.accumulated, &[AccountType::Asset]),
        ("expense", &accounts.expense, &[AccountType::Expense]),
        (
            "gain_loss",
            &accounts.gain_loss,
            &[AccountType::Income, AccountType::Expense],
        ),
    ];
    let mut problems = Vec::new();
    for (role, code, types) in wanted {
        match chart.get(code) {
            None => {
                problems.push(json!({ "role": role, "account": code, "code": "unknown_account" }))
            }
            Some(a) if !a.active => {
                problems.push(json!({ "role": role, "account": code, "code": "inactive_account" }));
            }
            Some(a) if !types.contains(&a.account_type) => {
                problems
                    .push(json!({ "role": role, "account": code, "code": "wrong_account_type" }));
            }
            Some(_) => {}
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(CommandError::invalid_with(
            "invalid_asset_accounts",
            "The asset accounts must be in the chart, active and of the right type.",
            problems,
        ))
    }
}

pub fn check_settings(settings: &DepreciationSettings) -> Result<(), CommandError> {
    settings
        .method
        .validate()
        .map_err(|e| CommandError::invalid_with("invalid_asset", e.to_string(), [e]))
}

/// A client's register computed across all its years.
pub struct Register {
    pub years: Vec<StoredYear>,
    pub classes: Vec<AssetClass>,
    pub assets: Vec<StoredAsset>,
    /// For each asset (parallel to `assets`), its movements in each year (parallel to `years`).
    pub rows: Vec<Vec<AssetYear>>,
}

impl Register {
    fn register_assets(&self) -> Vec<RegisterAsset> {
        self.assets
            .iter()
            .map(|a| RegisterAsset {
                name: a.name.clone(),
                class: self
                    .classes
                    .iter()
                    .find(|c| c.id == a.class_id)
                    .map_or_else(|| a.class_id.clone(), |c| c.key.clone()),
                accounts: a.accounts.clone(),
                asset: a.asset.clone(),
            })
            .collect()
    }

    fn year_rows(&self, i: usize) -> Vec<AssetYear> {
        self.rows.iter().map(|r| r[i]).collect()
    }

    pub fn year_index(&self, client_year_id: &str) -> Option<usize> {
        self.years.iter().position(|y| y.id == client_year_id)
    }

    /// The journals the register wants in year `i`.
    pub fn desired_journals(&self, i: usize) -> YearJournals {
        year_journals(
            &self.years[i].year,
            &self.register_assets(),
            &self.year_rows(i),
        )
    }

    pub fn reconcile(&self, i: usize, tb: &TrialBalance) -> Vec<ReconciliationLine> {
        reconcile(&self.register_assets(), &self.year_rows(i), tb)
    }

    /// The schedule for year `i`, with year `i − 1` as comparatives. `None` if the client has no
    /// assets.
    pub fn schedule(&self, i: usize) -> Option<AssetSchedule> {
        if self.assets.is_empty() {
            return None;
        }
        let classes: Vec<ScheduleClass> = self
            .classes
            .iter()
            .map(|c| ScheduleClass {
                code: c.key.clone(),
                name: c.name.clone(),
            })
            .collect();
        let prior = i.checked_sub(1).map(|p| self.year_rows(p));
        Some(build_asset_schedule(
            &classes,
            &self.register_assets(),
            &self.year_rows(i),
            prior.as_deref(),
        ))
    }

    /// Whether asset `a` is held in any finalised year, which fixes its cost and dates.
    pub fn in_finalised_year(&self, a: usize) -> bool {
        self.years.iter().enumerate().any(|(i, y)| {
            y.status == YearStatus::Finalised && self.rows[a][i] != AssetYear::default()
        })
    }
}

/// Loads a client's register and computes it. Charges recorded for finalised years are used as
/// they are, so settings changes only apply from the first open year.
pub async fn load(conn: &mut SqliteConnection, client_id: &str) -> Result<Register, CommandError> {
    let client = clients::get(conn, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", client_id))?;
    let years = years::for_client(conn, client_id).await?;
    let classes = assets::classes_for_entity_type(conn, &client.entity_type).await?;
    let stored = assets::assets_for_client(conn, client_id).await?;
    let charges = assets::charges_for_client(conn, client_id).await?;
    let core_years: Vec<acct_core::ClientYear> = years.iter().map(|y| y.year).collect();
    let mut rows = Vec::with_capacity(stored.len());
    for a in &stored {
        let locked: BTreeMap<NaiveDate, Money> = charges
            .iter()
            .filter(|c| c.asset_id == a.id)
            .filter_map(|c| {
                let y = years.iter().find(|y| y.id == c.client_year_id)?;
                (y.status == YearStatus::Finalised).then_some((y.year.start(), c.amount))
            })
            .collect();
        let r = asset_years(&a.asset, &core_years, &locked).map_err(|e| {
            CommandError::invalid_with(
                "invalid_asset",
                format!("{}: {e}", a.name),
                json!({ "asset_id": a.id, "error": e }),
            )
        })?;
        rows.push(r);
    }
    Ok(Register {
        years,
        classes,
        assets: stored,
        rows,
    })
}

/// The asset journals in force in a year: posted by the register and not reversed.
pub async fn current_journals(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<Vec<StoredJournal>, CommandError> {
    let all = journals::for_year(conn, client_year_id).await?;
    let reversed: Vec<&str> = all
        .iter()
        .filter_map(|j| j.reverses_journal_id.as_deref())
        .collect();
    Ok(all
        .iter()
        .filter(|j| {
            matches!(
                j.kind,
                JournalKind::Depreciation | JournalKind::AssetDisposal
            )
        })
        .filter(|j| j.reverses_journal_id.is_none() && !reversed.contains(&j.id.as_str()))
        .cloned()
        .collect())
}

/// Whether the posted journals already say what the register wants.
pub fn journals_match(current: &[StoredJournal], desired: &YearJournals) -> bool {
    let key = |j: &Journal| {
        let mut lines: Vec<(String, i64)> = j
            .lines
            .iter()
            .map(|l| (l.account.to_string(), l.amount.cents()))
            .collect();
        lines.sort();
        (j.date, j.narration.clone(), lines)
    };
    let mut a: Vec<_> = current.iter().map(|j| key(&j.journal)).collect();
    let mut b: Vec<_> = desired.all().map(key).collect();
    a.sort();
    b.sort();
    a == b
}

/// One asset in a year, for the register view.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssetView {
    pub id: String,
    pub class_id: String,
    pub name: String,
    pub cost: Money,
    pub residual: Money,
    #[ts(type = "string")]
    pub acquired: NaiveDate,
    pub settings: DepreciationSettings,
    pub rate_source: RateSource,
    pub accounts: AssetAccounts,
    pub opening: Option<acct_core::OpeningBalance>,
    pub disposal: Option<acct_core::Disposal>,
    /// Held in a finalised year, so cost, dates and the brought-forward balance are fixed.
    pub fixed: bool,
}

impl From<&StoredAsset> for AssetView {
    fn from(a: &StoredAsset) -> AssetView {
        AssetView {
            id: a.id.clone(),
            class_id: a.class_id.clone(),
            name: a.name.clone(),
            cost: a.asset.cost,
            residual: a.asset.residual,
            acquired: a.asset.acquired,
            settings: a.asset.settings,
            rate_source: a.rate_source,
            accounts: a.accounts.clone(),
            opening: a.asset.opening,
            disposal: a.asset.disposal.clone(),
            fixed: false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssetClassView {
    pub id: String,
    pub entity_type: String,
    pub key: String,
    pub name: String,
    pub settings: DepreciationSettings,
    pub accounts: AssetAccounts,
}

impl From<&AssetClass> for AssetClassView {
    fn from(c: &AssetClass) -> AssetClassView {
        AssetClassView {
            id: c.id.clone(),
            entity_type: c.entity_type.clone(),
            key: c.key.clone(),
            name: c.name.clone(),
            settings: c.settings,
            accounts: c.accounts.clone(),
        }
    }
}

/// A practice class as one client sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ClientClassView {
    pub class: AssetClassView,
    pub override_settings: Option<DepreciationSettings>,
    pub override_accounts: Option<AssetAccounts>,
    pub resolved: ResolvedClass,
}

/// `GET /api/asset-classes`: every practice class.
pub async fn list_classes(
    State(state): State<AppState>,
    _user: CurrentUser,
) -> Result<Json<Vec<AssetClassView>>, CommandError> {
    let mut conn = state.store.reader().await?;
    let all = assets::all_classes(&mut conn).await?;
    Ok(Json(all.iter().map(AssetClassView::from).collect()))
}

/// `GET /api/clients/{id}/asset-classes`: the classes for the client's entity type, with its
/// overrides.
pub async fn client_classes(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Vec<ClientClassView>>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(client_class_views(&mut conn, &id).await?))
}

pub async fn client_class_views(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<ClientClassView>, CommandError> {
    let client = clients::get(conn, client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", client_id))?;
    let classes = assets::classes_for_entity_type(conn, &client.entity_type).await?;
    let overrides = assets::overrides_for_client(conn, client_id).await?;
    Ok(classes
        .iter()
        .map(|c| {
            let o = overrides.iter().find(|o| o.class_id == c.id);
            ClientClassView {
                class: AssetClassView::from(c),
                override_settings: o.and_then(|o| o.settings),
                override_accounts: o.and_then(|o| o.accounts.clone()),
                resolved: resolve(c, o),
            }
        })
        .collect())
}

/// One asset's line in a year's register.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssetYearView {
    pub asset: AssetView,
    pub movements: AssetYear,
}

/// Whether the posted asset journals match the register.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum DepreciationStatus {
    /// The posted journals are what the register computes.
    Current,
    /// The register has changed since the journals were posted; run depreciation.
    Stale,
    /// The year is finalised; its journals don't change.
    Finalised,
}

/// `GET /api/years/{id}/assets`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct YearAssets {
    /// Every asset in the register. Those not held in the year have nil movements.
    pub assets: Vec<AssetYearView>,
    pub status: DepreciationStatus,
    /// Earlier open years whose asset journals are stale.
    pub stale_earlier_years: Vec<String>,
    /// What the depreciation run would post in this year.
    pub journals: Vec<Journal>,
    /// The register against the ledger at the end of the year.
    pub reconciliation: Vec<ReconciliationLine>,
}

pub async fn year_assets(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<YearAssets>, CommandError> {
    let mut conn = state.store.reader().await?;
    let year = years::get(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", &id))?;
    let register = load(&mut conn, &year.client_id).await?;
    let i = register
        .year_index(&id)
        .expect("the year belongs to the client");
    let mut stale_earlier_years = Vec::new();
    let mut status = DepreciationStatus::Finalised;
    for (j, y) in register.years.iter().enumerate().take(i + 1) {
        if y.status == YearStatus::Finalised {
            continue;
        }
        let current = current_journals(&mut conn, &y.id).await?;
        let ok = journals_match(&current, &register.desired_journals(j));
        if j == i {
            status = if ok {
                DepreciationStatus::Current
            } else {
                DepreciationStatus::Stale
            };
        } else if !ok {
            stale_earlier_years.push(y.id.clone());
        }
    }
    let (_, _, balances) = ledger::balances_to(&mut conn, &id).await?;
    let tb = &balances.last().expect("the year itself").closing;
    let views = register
        .assets
        .iter()
        .enumerate()
        .map(|(a, stored)| AssetYearView {
            asset: AssetView {
                fixed: register.in_finalised_year(a),
                ..AssetView::from(stored)
            },
            movements: register.rows[a][i],
        })
        .collect();
    Ok(Json(YearAssets {
        assets: views,
        status,
        stale_earlier_years,
        journals: register.desired_journals(i).all().cloned().collect(),
        reconciliation: register.reconcile(i, tb),
    }))
}

/// One asset whose settings or accounts would change if the class's current defaults were
/// applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ApplyDefaultsChange {
    pub asset_id: String,
    pub name: String,
    pub rate_source: RateSource,
    pub settings_from: DepreciationSettings,
    pub settings_to: DepreciationSettings,
    pub accounts_from: AssetAccounts,
    pub accounts_to: AssetAccounts,
}

/// What `apply_asset_class_defaults` would change: assets in the class whose settings (unless
/// custom) or accounts differ from the class's resolved defaults.
pub async fn apply_defaults_plan(
    conn: &mut SqliteConnection,
    client_id: &str,
    class_id: &str,
) -> Result<(ResolvedClass, Vec<ApplyDefaultsChange>), CommandError> {
    let views = client_class_views(conn, client_id).await?;
    let view = views
        .iter()
        .find(|v| v.class.id == class_id)
        .ok_or_else(|| CommandError::not_found("asset class", class_id))?;
    let resolved = view.resolved.clone();
    let changes = assets::assets_for_client(conn, client_id)
        .await?
        .into_iter()
        .filter(|a| a.class_id == class_id)
        .filter_map(|a| {
            let settings_to = if a.rate_source == RateSource::Custom {
                a.asset.settings
            } else {
                resolved.settings
            };
            let change = ApplyDefaultsChange {
                asset_id: a.id,
                name: a.name,
                rate_source: a.rate_source,
                settings_from: a.asset.settings,
                settings_to,
                accounts_from: a.accounts,
                accounts_to: resolved.accounts.clone(),
            };
            let differs = change.settings_from != change.settings_to
                || change.accounts_from != change.accounts_to
                || (a.rate_source != RateSource::Custom && a.rate_source != resolved.source);
            differs.then_some(change)
        })
        .collect();
    Ok((resolved, changes))
}

/// `GET /api/clients/{id}/asset-classes/{class_id}/apply-preview`
pub async fn apply_defaults_preview(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path((id, class_id)): Path<(String, String)>,
) -> Result<Json<Vec<ApplyDefaultsChange>>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(
        apply_defaults_plan(&mut conn, &id, &class_id).await?.1,
    ))
}
