//! Accounting policies and notes (M15): the practice paragraph library, each client-year's own
//! copies, and the notes those copies put in the ReportDoc.
//!
//! Defaults never reach back (CLAUDE.md): revising a library paragraph changes no year's copy.
//! `push_paragraph` is the explicit way to bring the latest version onto open years, after
//! [`push_preview`] shows what it will do. It never touches a finalised year or a copy staff have
//! edited. The wording rules are in `docs/domain.md`, "Accounting policies and notes".

use acct_core::depreciation::AssetYear;
use acct_core::notes::{self, NoteError, NoteFields, Paragraph, Placement, ReportNote};
use acct_store::clients::Client;
use acct_store::paragraphs::{self as store, StoredParagraph, YearNote};
use acct_store::years::{StoredYear, YearStatus};
use acct_store::{SqliteConnection, charts, clients, new_id, years};
use axum::Json;
use axum::extract::{Path, State};
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::access;
use crate::assets::Register;
use crate::auth::CurrentUser;
use crate::error::CommandError;
use crate::pipeline::{Actor, Effect};

fn invalid_paragraph(errors: Vec<NoteError>) -> CommandError {
    CommandError::invalid_with("invalid_paragraph", "The paragraph has problems.", errors)
}

/// A year that exists and isn't finalised: a finalised year's notes are part of what was signed.
async fn open_year(tx: &mut SqliteConnection, id: &str) -> Result<StoredYear, CommandError> {
    let year = years::get(tx, id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", id))?;
    if year.status == YearStatus::Finalised {
        return Err(CommandError::invalid(
            "year_finalised",
            "This year is finalised, so its notes can't change.",
        ));
    }
    Ok(year)
}

async fn latest(
    conn: &mut SqliteConnection,
    paragraph_id: &str,
) -> Result<StoredParagraph, CommandError> {
    store::latest(conn, paragraph_id)
        .await?
        .ok_or_else(|| CommandError::not_found("paragraph", paragraph_id))
}

/// A paragraph that's still in the library.
async fn live(
    conn: &mut SqliteConnection,
    paragraph_id: &str,
) -> Result<StoredParagraph, CommandError> {
    let p = latest(conn, paragraph_id).await?;
    if p.removed_seq.is_some() {
        return Err(removed(&p));
    }
    Ok(p)
}

fn removed(p: &StoredParagraph) -> CommandError {
    CommandError::invalid(
        "paragraph_removed",
        format!("“{}” has been removed from the library.", p.paragraph.title),
    )
}

/// `add_paragraph`.
pub(crate) async fn add(
    tx: &mut SqliteConnection,
    seq: i64,
    entity_type: &str,
    paragraph: &Paragraph,
) -> Result<Effect, CommandError> {
    charts::for_entity_type(tx, entity_type)
        .await?
        .ok_or_else(|| CommandError::not_found("master chart", entity_type))?;
    notes::check(paragraph).map_err(invalid_paragraph)?;
    let library = store::library(tx, entity_type).await?;
    if library.iter().any(|p| p.paragraph.key == paragraph.key) {
        return Err(CommandError::invalid(
            "paragraph_exists",
            format!(
                "The {} library already has a paragraph “{}”. Revise that one instead.",
                entity_type.replace('_', " "),
                paragraph.key
            ),
        ));
    }
    let id = new_id();
    store::insert(tx, &id, entity_type, paragraph, seq).await?;
    Ok(Effect {
        entity_id: Some(id),
        ..Effect::default()
    })
}

/// `revise_paragraph`: the next version. Years' copies are left as they are.
pub(crate) async fn revise(
    tx: &mut SqliteConnection,
    seq: i64,
    paragraph_id: &str,
    placement: Placement,
    title: &str,
    body: &str,
) -> Result<Effect, CommandError> {
    let current = live(tx, paragraph_id).await?;
    let revised = Paragraph {
        key: current.paragraph.key.clone(),
        placement,
        title: title.to_owned(),
        body: body.to_owned(),
    };
    notes::check(&revised).map_err(invalid_paragraph)?;
    if revised == current.paragraph {
        return Err(CommandError::invalid(
            "paragraph_unchanged",
            "That's the same as the paragraph's latest version.",
        ));
    }
    store::insert_version(tx, paragraph_id, &revised, seq).await?;
    Ok(Effect::default())
}

/// `remove_paragraph`: takes a paragraph out of the library. Years that picked it keep their
/// copies (defaults never reach back), and no year can newly pick it.
pub(crate) async fn remove(
    tx: &mut SqliteConnection,
    seq: i64,
    paragraph_id: &str,
) -> Result<Effect, CommandError> {
    live(tx, paragraph_id).await?;
    store::remove(tx, paragraph_id, seq).await?;
    Ok(Effect::default())
}

/// `pick_notes`: the year's notes become exactly `paragraph_ids`, in that order.
pub(crate) async fn pick(
    tx: &mut SqliteConnection,
    seq: i64,
    client_year_id: &str,
    paragraph_ids: &[String],
) -> Result<Effect, CommandError> {
    let year = open_year(tx, client_year_id).await?;
    let client = clients::get(tx, &year.client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", &year.client_id))?;
    let mut existing = store::for_year(tx, &year.id).await?;
    let mut picked_keys = Vec::new();
    for (i, id) in paragraph_ids.iter().enumerate() {
        if paragraph_ids[..i].contains(id) {
            return Err(CommandError::invalid(
                "duplicate_paragraph",
                "A paragraph can be picked only once.",
            ));
        }
        let library = latest(tx, id).await?;
        if library.entity_type != client.entity_type {
            return Err(CommandError::invalid(
                "wrong_entity_type",
                format!(
                    "“{}” is in the {} library, but this client is a {}.",
                    library.paragraph.title,
                    library.entity_type.replace('_', " "),
                    client.entity_type.replace('_', " ")
                ),
            ));
        }
        // A removed paragraph and one added later under its key can't both be in a year.
        if picked_keys.contains(&library.paragraph.key) {
            return Err(CommandError::invalid(
                "duplicate_paragraph",
                format!(
                    "Two of the picked paragraphs are both “{}”.",
                    library.paragraph.key
                ),
            ));
        }
        picked_keys.push(library.paragraph.key.clone());
        let position = i64::try_from(i).unwrap_or(i64::MAX);
        match existing.iter().position(|n| &n.paragraph_id == id) {
            Some(at) => {
                let mut note = existing.remove(at);
                if note.position != position {
                    note.position = position;
                    note.updated_seq = seq;
                    store::update_note(tx, &note).await?;
                }
            }
            // A year that already has a copy of a removed paragraph may keep it, but not
            // pick it afresh.
            None if library.removed_seq.is_some() => return Err(removed(&library)),
            None => {
                store::insert_note(
                    tx,
                    &YearNote {
                        id: new_id(),
                        client_year_id: year.id.clone(),
                        paragraph_id: id.clone(),
                        position,
                        from_version: library.version,
                        paragraph: library.paragraph,
                        edited: false,
                        updated_seq: seq,
                    },
                )
                .await?;
            }
        }
    }
    // Whatever's left wasn't picked this time.
    for note in existing {
        store::delete_note(tx, &note.id).await?;
    }
    Ok(year_effect(&year))
}

/// `edit_note`: changes the year's copy and marks it edited.
pub(crate) async fn edit(
    tx: &mut SqliteConnection,
    seq: i64,
    client_year_id: &str,
    paragraph_id: &str,
    title: &str,
    body: &str,
) -> Result<Effect, CommandError> {
    let year = open_year(tx, client_year_id).await?;
    let mut note = store::for_year(tx, &year.id)
        .await?
        .into_iter()
        .find(|n| n.paragraph_id == paragraph_id)
        .ok_or_else(|| CommandError::not_found("note", paragraph_id))?;
    let edited = Paragraph {
        title: title.to_owned(),
        body: body.to_owned(),
        ..note.paragraph.clone()
    };
    notes::check(&edited).map_err(invalid_paragraph)?;
    if edited == note.paragraph {
        return Err(CommandError::invalid(
            "note_unchanged",
            "That's the same as the year's copy.",
        ));
    }
    note.paragraph = edited;
    note.edited = true;
    note.updated_seq = seq;
    store::update_note(tx, &note).await?;
    Ok(year_effect(&year))
}

/// What a push does to one year's copy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum PushAction {
    /// The copy is replaced with the latest version.
    Update,
    /// Staff edited the copy for this client, so it's kept as it is.
    KeepEdited,
}

/// One open year's copy of a paragraph that's behind the library.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PushChange {
    pub client_id: String,
    pub client_name: String,
    pub client_year_id: String,
    #[ts(type = "string")]
    pub year_end: NaiveDate,
    pub from_version: i64,
    pub to_version: i64,
    pub action: PushAction,
    /// The copy's wording now, and what an update would make it.
    pub from: Paragraph,
    pub to: Paragraph,
}

/// What `push_paragraph` would do: every open year (of a client `actor` can see) whose copy is
/// behind the latest version. Finalised years never appear.
pub(crate) async fn push_plan(
    conn: &mut SqliteConnection,
    actor: &Actor,
    paragraph_id: &str,
) -> Result<(StoredParagraph, Vec<PushChange>), CommandError> {
    let library = live(conn, paragraph_id).await?;
    let visible = access::visible(conn, actor).await?;
    let mut changes = Vec::new();
    for note in store::copies_of(conn, paragraph_id).await? {
        if note.from_version >= library.version {
            continue;
        }
        let Some(year) = years::get(conn, &note.client_year_id).await? else {
            continue;
        };
        if year.status == YearStatus::Finalised || !visible.shows(Some(&year.client_id)) {
            continue;
        }
        let Some(client) = clients::get(conn, &year.client_id).await? else {
            continue;
        };
        changes.push(PushChange {
            client_id: client.id,
            client_name: client.name,
            client_year_id: year.id,
            year_end: year.year.end(),
            from_version: note.from_version,
            to_version: library.version,
            action: if note.edited {
                PushAction::KeepEdited
            } else {
                PushAction::Update
            },
            from: note.paragraph,
            to: library.paragraph.clone(),
        });
    }
    changes.sort_by(|a, b| {
        (&a.client_name, &a.client_id, a.year_end).cmp(&(&b.client_name, &b.client_id, b.year_end))
    });
    Ok((library, changes))
}

/// `push_paragraph`: applies [`push_plan`]'s updates.
pub(crate) async fn push(
    tx: &mut SqliteConnection,
    actor: &Actor,
    seq: i64,
    paragraph_id: &str,
) -> Result<Effect, CommandError> {
    let (library, changes) = push_plan(tx, actor, paragraph_id).await?;
    let copies = store::copies_of(tx, paragraph_id).await?;
    for change in changes.iter().filter(|c| c.action == PushAction::Update) {
        let mut note = copies
            .iter()
            .find(|n| n.client_year_id == change.client_year_id)
            .cloned()
            .expect("the plan came from these copies");
        note.paragraph = library.paragraph.clone();
        note.from_version = library.version;
        note.updated_seq = seq;
        store::update_note(tx, &note).await?;
    }
    Ok(Effect::default())
}

/// A new year starts with a copy of its neighbouring year's notes, edits and all.
pub(crate) async fn carry_forward(
    tx: &mut SqliteConnection,
    seq: i64,
    from_year_id: &str,
    to_year_id: &str,
) -> Result<(), CommandError> {
    for note in store::for_year(tx, from_year_id).await? {
        store::insert_note(
            tx,
            &YearNote {
                id: new_id(),
                client_year_id: to_year_id.to_owned(),
                updated_seq: seq,
                ..note
            },
        )
        .await?;
    }
    Ok(())
}

/// The ReportDoc's notes for a year: its copies filled in with its fields. A copy that can't be
/// filled (say, the depreciation policy in a year with no assets) fails the whole report, so a
/// note never goes out with a gap in it.
pub(crate) async fn report_notes(
    conn: &mut SqliteConnection,
    client: &Client,
    year: &StoredYear,
    register: &Register,
) -> Result<Vec<ReportNote>, CommandError> {
    let copies = store::for_year(conn, &year.id).await?;
    if copies.is_empty() {
        return Ok(Vec::new());
    }
    let i = register
        .year_index(&year.id)
        .expect("the year belongs to the client");
    let held: Vec<(String, acct_core::Method)> = register
        .assets
        .iter()
        .zip(&register.rows)
        .filter(|(_, rows)| rows[i] != AssetYear::default())
        .map(|(a, _)| {
            let class = register
                .classes
                .iter()
                .find(|c| c.id == a.class_id)
                .map_or_else(|| a.class_id.clone(), |c| c.name.clone());
            (class, a.asset.settings.method)
        })
        .collect();
    let fields = NoteFields {
        business_name: client.name.clone(),
        period_start: year.year.start(),
        balance_date: year.year.end(),
        depreciation_methods: notes::depreciation_methods(&held),
    };
    let paragraphs: Vec<Paragraph> = copies.into_iter().map(|n| n.paragraph).collect();
    notes::build_notes(&paragraphs, &fields).map_err(|errors| {
        CommandError::invalid_with(
            "notes_failed",
            "The notes can't be filled in until these are fixed.",
            errors,
        )
    })
}

fn year_effect(year: &StoredYear) -> Effect {
    Effect {
        entity_id: None,
        client_id: Some(year.client_id.clone()),
        client_year_id: Some(year.id.clone()),
    }
}

/// A library paragraph at its latest version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LibraryParagraph {
    pub id: String,
    pub entity_type: String,
    pub version: i64,
    pub paragraph: Paragraph,
}

/// `GET /api/paragraph-library/{entity_type}`: the library, oldest paragraph first.
pub async fn get_library(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(entity_type): Path<String>,
) -> Result<Json<Vec<LibraryParagraph>>, CommandError> {
    let mut conn = state.store.reader().await?;
    let library = store::library(&mut conn, &entity_type).await?;
    Ok(Json(
        library
            .into_iter()
            .map(|p| LibraryParagraph {
                id: p.id,
                entity_type: p.entity_type,
                version: p.version,
                paragraph: p.paragraph,
            })
            .collect(),
    ))
}

/// `GET /api/paragraphs/{id}/push-preview`: what `push_paragraph` would change.
pub async fn push_preview(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Vec<PushChange>>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(push_plan(&mut conn, &user.actor(), &id).await?.1))
}

/// A year's copy of a paragraph, and whether the library has moved on since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct YearNoteView {
    pub paragraph_id: String,
    pub from_version: i64,
    pub latest_version: i64,
    pub edited: bool,
    /// The paragraph has since been removed from the library; this copy stays.
    pub removed: bool,
    pub paragraph: Paragraph,
}

/// `GET /api/years/{id}/notes`: the year's notes, in order.
pub async fn get_year_notes(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<Vec<YearNoteView>>, CommandError> {
    let mut conn = state.store.reader().await?;
    let mut out = Vec::new();
    for note in store::for_year(&mut conn, &id).await? {
        let library = latest(&mut conn, &note.paragraph_id).await?;
        out.push(YearNoteView {
            paragraph_id: note.paragraph_id,
            from_version: note.from_version,
            latest_version: library.version,
            edited: note.edited,
            removed: library.removed_seq.is_some(),
            paragraph: note.paragraph,
        });
    }
    Ok(Json(out))
}
