//! Editing statement layouts (templates and their mappings), and moving open years onto newer
//! versions of them.
//!
//! A template or mapping version never changes once written, and a year is pinned to the versions
//! it was set up with. Two rules keep that safe:
//! - the latest version of every mapping always fits the latest version of its template, so a new
//!   year can always pin the pair (`revise_template` revises any mappings that wouldn't fit along
//!   with it, or is refused);
//! - an existing year changes only by `move_year_layout`, explicitly, one open year at a time,
//!   after its preview has shown what would change (CLAUDE.md, "Defaults never reach back").

use acct_core::{
    AccountCode, AccountType, LineKey, Mapping, MappingError, Node, ReportDoc, RowChange, Template,
    row_changes,
};
use acct_store::templates::{self, MappingInfo, TemplateInfo, Version};
use acct_store::years::{StoredYear, YearStatus};
use acct_store::{SqliteConnection, charts, clients, new_id, years};
use axum::Json;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::commands::MappingRevision;
use crate::error::CommandError;
use crate::ledger::{self, Layout};

type ApiResult<T> = Result<Json<T>, CommandError>;

/// `GET /api/templates/{id}`: a template's latest version, with the mappings onto it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TemplateDetail {
    pub id: String,
    pub entity_type: String,
    pub name: String,
    pub version: i64,
    pub body: Template,
    /// Each mapping's latest version. Saving the template has to keep every one of them fitting.
    pub mappings: Vec<MappingVersionView>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MappingVersionView {
    pub id: String,
    pub name: String,
    pub version: i64,
    pub body: Mapping,
}

/// `GET /api/mappings/{id}`: a mapping's latest version, and the lines of its template's latest
/// version that ranges can point at.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MappingDetail {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    pub template_id: String,
    pub template_name: String,
    pub version: i64,
    pub body: Mapping,
    pub lines: Vec<TemplateLine>,
}

/// A row that accounts can be mapped to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TemplateLine {
    pub key: LineKey,
    pub label: String,
    /// The title of the statement it's in.
    pub statement: String,
}

/// The body of `POST /api/mappings/check`: a draft mapping onto a template.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MappingCheckRequest {
    pub template_id: String,
    pub body: Mapping,
}

/// What `POST /api/mappings/check` finds, without saving anything.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct MappingCheck {
    /// Empty when the draft fits the template's latest version.
    pub problems: Vec<MappingError>,
    /// The entity type's master chart, with the line each account would map to.
    pub accounts: Vec<CoveredAccount>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CoveredAccount {
    pub code: AccountCode,
    pub name: String,
    pub account_type: AccountType,
    pub active: bool,
    /// `None`: no range covers it, so a balance on it would stop the statements building.
    pub line: Option<LineKey>,
}

/// Which template and mapping versions a year uses, or would use.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LayoutVersions {
    pub template_id: String,
    pub template_name: String,
    pub template_version: i64,
    pub mapping_id: String,
    pub mapping_name: String,
    pub mapping_version: i64,
}

/// A mapping a year could move onto.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LayoutChoice {
    pub mapping_id: String,
    pub mapping_name: String,
    pub template_name: String,
}

/// `GET /api/years/{id}/layout?mapping_id=`: the preview of `move_year_layout`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct YearLayoutView {
    pub current: LayoutVersions,
    /// The latest versions of the chosen mapping (by default the year's own) and its template.
    pub proposed: LayoutVersions,
    /// The year is already on `proposed`, so there's nothing to move.
    pub up_to_date: bool,
    /// Only an open year can move.
    pub open: bool,
    /// The mappings for the year's entity type, oldest first.
    pub choices: Vec<LayoutChoice>,
    /// What the move changes in the statements. Empty when up to date or when it can't move.
    pub changes: Vec<RowChange>,
    /// Why the statements couldn't be built through `proposed`, as the server reports it. A year
    /// with problems can't move until they're fixed.
    #[ts(type = "Array<unknown>")]
    pub problems: Vec<Value>,
    /// Whether the statements build through the year's current versions. When they don't, every
    /// row in `changes` is new.
    pub current_builds: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct LayoutQuery {
    mapping_id: Option<String>,
}

fn check_template(template: &Template) -> Result<(), CommandError> {
    template.validate().map_err(|errors| {
        let messages: Vec<String> = errors.iter().map(ToString::to_string).collect();
        CommandError::invalid_with("invalid_template", "The template has problems.", messages)
    })
}

/// The rows of a template that mappings can point at, in document order.
pub fn lines(template: &Template) -> Vec<TemplateLine> {
    template
        .statements
        .iter()
        .flat_map(|s| {
            s.body.iter().flat_map(Node::walk).filter_map(|n| match n {
                Node::Line { key, label, .. } => Some(TemplateLine {
                    key: key.clone(),
                    label: label.clone(),
                    statement: s.title.clone(),
                }),
                _ => None,
            })
        })
        .collect()
}

async fn template_info(
    conn: &mut SqliteConnection,
    template_id: &str,
) -> Result<TemplateInfo, CommandError> {
    templates::get_template(conn, template_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template", template_id))
}

async fn latest_template(
    conn: &mut SqliteConnection,
    template_id: &str,
) -> Result<Version<Template>, CommandError> {
    templates::latest_template_version(conn, template_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template", template_id))
}

async fn latest_mapping(
    conn: &mut SqliteConnection,
    mapping_id: &str,
) -> Result<Version<Mapping>, CommandError> {
    templates::latest_mapping_version(conn, mapping_id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping", mapping_id))
}

/// `revise_template`. Returns the new version's id.
pub async fn revise_template(
    tx: &mut SqliteConnection,
    seq: i64,
    template_id: &str,
    body: &Template,
    revisions: &[MappingRevision],
) -> Result<String, CommandError> {
    template_info(tx, template_id).await?;
    check_template(body)?;
    let onto = templates::mappings_for_template(tx, template_id).await?;
    for (i, r) in revisions.iter().enumerate() {
        if !onto.iter().any(|m| m.id == r.mapping_id) {
            return Err(CommandError::invalid(
                "wrong_template",
                format!("{} isn't a mapping onto this template.", r.mapping_id),
            ));
        }
        if revisions[..i].iter().any(|o| o.mapping_id == r.mapping_id) {
            return Err(CommandError::invalid(
                "duplicate_revision",
                format!("The mapping {} is revised twice.", r.mapping_id),
            ));
        }
    }
    let mut problems = Vec::new();
    for m in &onto {
        let mapping = match revisions.iter().find(|r| r.mapping_id == m.id) {
            Some(r) => r.body.clone(),
            None => latest_mapping(tx, &m.id).await?.body,
        };
        if let Err(errors) = mapping.validate(body) {
            problems.extend(errors.iter().map(|e| format!("{}: {e}.", m.name)));
        }
    }
    if !problems.is_empty() {
        return Err(CommandError::invalid_with(
            "mapping_breaks",
            "Every mapping onto the template has to fit the new version. Point the ranges these \
             name at lines the template still has.",
            problems,
        ));
    }
    let version_id = new_id();
    templates::add_template_version(tx, &version_id, template_id, body, seq).await?;
    for r in revisions {
        templates::add_mapping_version(tx, &new_id(), &r.mapping_id, &r.body, seq).await?;
    }
    Ok(version_id)
}

/// Where `move_year_layout` would take a year: the latest versions of `mapping_id` (or the year's
/// own mapping) and its template.
struct Target {
    template: TemplateInfo,
    template_version: Version<Template>,
    mapping: MappingInfo,
    mapping_version: Version<Mapping>,
}

impl Target {
    fn versions(&self) -> LayoutVersions {
        LayoutVersions {
            template_id: self.template.id.clone(),
            template_name: self.template.name.clone(),
            template_version: self.template_version.version,
            mapping_id: self.mapping.id.clone(),
            mapping_name: self.mapping.name.clone(),
            mapping_version: self.mapping_version.version,
        }
    }

    fn is_pinned_by(&self, year: &StoredYear) -> bool {
        self.template_version.id == year.template_version_id
            && self.mapping_version.id == year.mapping_version_id
    }
}

async fn target(
    conn: &mut SqliteConnection,
    year: &StoredYear,
    mapping_id: Option<&str>,
) -> Result<Target, CommandError> {
    let mapping_id = match mapping_id {
        Some(id) => id.to_owned(),
        None => pinned_mapping(conn, year).await?.parent_id,
    };
    let mapping = templates::get_mapping(conn, &mapping_id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping", &mapping_id))?;
    let template = template_info(conn, &mapping.template_id).await?;
    let client = clients::get(conn, &year.client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", &year.client_id))?;
    if template.entity_type != client.entity_type {
        return Err(CommandError::invalid(
            "wrong_entity_type",
            format!(
                "That mapping is for {}, not {}.",
                template.entity_type.replace('_', " "),
                client.entity_type.replace('_', " ")
            ),
        ));
    }
    Ok(Target {
        template_version: latest_template(conn, &template.id).await?,
        mapping_version: latest_mapping(conn, &mapping.id).await?,
        template,
        mapping,
    })
}

async fn pinned_mapping(
    conn: &mut SqliteConnection,
    year: &StoredYear,
) -> Result<Version<Mapping>, CommandError> {
    templates::mapping_version(conn, &year.mapping_version_id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping version", &year.mapping_version_id))
}

/// The versions a year is pinned to, by name.
async fn current(
    conn: &mut SqliteConnection,
    year: &StoredYear,
) -> Result<LayoutVersions, CommandError> {
    let template_version = templates::template_version(conn, &year.template_version_id)
        .await?
        .ok_or_else(|| CommandError::not_found("template version", &year.template_version_id))?;
    let mapping_version = pinned_mapping(conn, year).await?;
    let template = template_info(conn, &template_version.parent_id).await?;
    let mapping = templates::get_mapping(conn, &mapping_version.parent_id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping", &mapping_version.parent_id))?;
    Ok(LayoutVersions {
        template_id: template.id,
        template_name: template.name,
        template_version: template_version.version,
        mapping_id: mapping.id,
        mapping_name: mapping.name,
        mapping_version: mapping_version.version,
    })
}

/// A year's layout in words, for the history: "Company (standard) v2, mapping Standard v3".
pub async fn label(conn: &mut SqliteConnection, year: &StoredYear) -> Result<String, CommandError> {
    let v = current(conn, year).await?;
    Ok(format!(
        "{} v{}, mapping {} v{}",
        v.template_name, v.template_version, v.mapping_name, v.mapping_version
    ))
}

async fn report_through(
    conn: &mut SqliteConnection,
    year: &StoredYear,
    target: &Target,
) -> Result<ReportDoc, CommandError> {
    ledger::report_with(
        conn,
        &year.id,
        Some(Layout {
            template: &target.template_version.body,
            mapping: &target.mapping_version.body,
        }),
    )
    .await
}

/// `move_year_layout` on an open year.
pub async fn move_year(
    tx: &mut SqliteConnection,
    year: &StoredYear,
    mapping_id: Option<&str>,
) -> Result<(), CommandError> {
    let target = target(tx, year, mapping_id).await?;
    if target.is_pinned_by(year) {
        return Err(CommandError::invalid(
            "layout_current",
            "This year already uses the latest versions of that template and mapping.",
        ));
    }
    if let Err(errors) = target
        .mapping_version
        .body
        .validate(&target.template_version.body)
    {
        return Err(CommandError::invalid_with(
            "invalid_mapping",
            "The mapping has problems.",
            errors,
        ));
    }
    report_through(tx, year, &target).await?;
    years::set_layout(
        tx,
        &year.id,
        &target.template_version.id,
        &target.mapping_version.id,
    )
    .await?;
    Ok(())
}

/// `GET /api/templates/{id}`
pub async fn get_template(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<TemplateDetail> {
    let mut conn = state.store.reader().await?;
    let info = template_info(&mut conn, &id).await?;
    let latest = latest_template(&mut conn, &id).await?;
    let mut mappings = Vec::new();
    for m in templates::mappings_for_template(&mut conn, &id).await? {
        let v = latest_mapping(&mut conn, &m.id).await?;
        mappings.push(MappingVersionView {
            id: m.id,
            name: m.name,
            version: v.version,
            body: v.body,
        });
    }
    Ok(Json(TemplateDetail {
        id: info.id,
        entity_type: info.entity_type,
        name: info.name,
        version: latest.version,
        body: latest.body,
        mappings,
    }))
}

/// `GET /api/mappings/{id}`
pub async fn get_mapping(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<MappingDetail> {
    let mut conn = state.store.reader().await?;
    let info = templates::get_mapping(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("mapping", &id))?;
    let latest = latest_mapping(&mut conn, &id).await?;
    let template = template_info(&mut conn, &info.template_id).await?;
    let template_version = latest_template(&mut conn, &info.template_id).await?;
    Ok(Json(MappingDetail {
        id: info.id,
        name: info.name,
        entity_type: template.entity_type,
        template_id: template.id,
        template_name: template.name,
        version: latest.version,
        body: latest.body,
        lines: lines(&template_version.body),
    }))
}

/// `POST /api/mappings/check`: checks a draft mapping against its template's latest version and
/// the entity type's master chart. Saves nothing.
pub async fn check_mapping(
    State(state): State<AppState>,
    _user: CurrentUser,
    body: Result<Json<MappingCheckRequest>, JsonRejection>,
) -> ApiResult<MappingCheck> {
    let Json(request) = body.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let mut conn = state.store.reader().await?;
    let info = template_info(&mut conn, &request.template_id).await?;
    let template = latest_template(&mut conn, &info.id).await?;
    let problems = request
        .body
        .validate(&template.body)
        .err()
        .unwrap_or_default();
    let accounts = match charts::for_entity_type(&mut conn, &info.entity_type).await? {
        Some(master) => master
            .chart
            .accounts()
            .iter()
            .map(|a| CoveredAccount {
                code: a.code.clone(),
                name: a.name.clone(),
                account_type: a.account_type,
                active: a.active,
                line: request.body.line_for(&a.code).cloned(),
            })
            .collect(),
        None => Vec::new(),
    };
    Ok(Json(MappingCheck { problems, accounts }))
}

/// `GET /api/years/{id}/layout`
pub async fn get_year_layout(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
    query: Result<Query<LayoutQuery>, QueryRejection>,
) -> ApiResult<YearLayoutView> {
    let Query(q) = query.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let mut conn = state.store.reader().await?;
    let year = years::get(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", &id))?;
    let target = target(&mut conn, &year, q.mapping_id.as_deref()).await?;
    let client = clients::get(&mut conn, &year.client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", &year.client_id))?;
    let mut choices = Vec::new();
    for m in templates::mappings_for_entity_type(&mut conn, &client.entity_type).await? {
        let t = template_info(&mut conn, &m.template_id).await?;
        choices.push(LayoutChoice {
            mapping_id: m.id,
            mapping_name: m.name,
            template_name: t.name,
        });
    }
    let up_to_date = target.is_pinned_by(&year);
    let before = ledger::report(&mut conn, &year.id).await;
    let (changes, problems) = if up_to_date {
        (Vec::new(), Vec::new())
    } else {
        match report_through(&mut conn, &year, &target).await {
            Ok(after) => {
                let was = match &before {
                    Ok(b) => b.clone(),
                    Err(_) => ReportDoc {
                        statements: Vec::new(),
                        ..after.clone()
                    },
                };
                (row_changes(&was, &after), Vec::new())
            }
            Err(e) => (Vec::new(), problems_of(e)?),
        }
    };
    Ok(Json(YearLayoutView {
        current: current(&mut conn, &year).await?,
        proposed: target.versions(),
        up_to_date,
        open: year.status == YearStatus::Open,
        choices,
        changes,
        problems,
        current_builds: before.is_ok(),
    }))
}

/// A report that won't build, or a mapping that doesn't fit, is a preview's answer, not its
/// failure. Anything else is.
fn problems_of(e: CommandError) -> Result<Vec<Value>, CommandError> {
    match e {
        CommandError::Invalid {
            code: "report_failed",
            details,
            ..
        } => Ok(details.as_array().cloned().unwrap_or_default()),
        CommandError::Invalid { code, message, .. } => Ok(vec![
            serde_json::json!({ "code": code, "message": message }),
        ]),
        other => Err(other),
    }
}
