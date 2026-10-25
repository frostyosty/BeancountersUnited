//! The practice paragraph library (with immutable numbered versions) and each client-year's own
//! copies of the paragraphs it picked.

use acct_core::notes::{Paragraph, Placement};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, StoreError, enum_text, parse, parse_enum};

/// A library paragraph at one version.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredParagraph {
    pub id: String,
    pub entity_type: String,
    pub version: i64,
    pub paragraph: Paragraph,
    /// When the paragraph was added, and when this version was written.
    pub created_seq: i64,
    pub version_seq: i64,
    /// Set once the paragraph is removed from the library. Years keep their copies.
    pub removed_seq: Option<i64>,
}

#[derive(FromRow)]
struct ParagraphRow {
    id: String,
    entity_type: String,
    key: String,
    created_seq: i64,
    version: i64,
    placement: String,
    title: String,
    body: String,
    version_seq: i64,
    removed_seq: Option<i64>,
}

impl TryFrom<ParagraphRow> for StoredParagraph {
    type Error = StoreError;
    fn try_from(r: ParagraphRow) -> Result<StoredParagraph> {
        Ok(StoredParagraph {
            id: r.id,
            entity_type: r.entity_type,
            version: r.version,
            paragraph: Paragraph {
                key: parse(&r.key)?,
                placement: parse_enum(&r.placement)?,
                title: r.title,
                body: r.body,
            },
            created_seq: r.created_seq,
            version_seq: r.version_seq,
            removed_seq: r.removed_seq,
        })
    }
}

/// Each paragraph's latest version, then `$tail`. A macro, so every query stays a fixed string.
macro_rules! latest {
    ($tail:literal) => {
        concat!(
            "SELECT p.id, p.entity_type, p.key, p.created_seq, v.version, v.placement,
            v.title, v.body, v.created_seq AS version_seq, p.removed_seq
     FROM paragraphs p
     JOIN paragraph_versions v ON v.paragraph_id = p.id
     WHERE v.version = (SELECT MAX(version) FROM paragraph_versions WHERE paragraph_id = p.id) ",
            $tail
        )
    };
}

/// Adds a paragraph with its first version.
pub async fn insert(
    conn: &mut SqliteConnection,
    id: &str,
    entity_type: &str,
    paragraph: &Paragraph,
    seq: i64,
) -> Result<()> {
    sqlx::query("INSERT INTO paragraphs (id, entity_type, key, created_seq) VALUES (?, ?, ?, ?)")
        .bind(id)
        .bind(entity_type)
        .bind(paragraph.key.as_str())
        .bind(seq)
        .execute(&mut *conn)
        .await?;
    insert_version(conn, id, paragraph, seq).await?;
    Ok(())
}

/// Writes a paragraph's next version (its key never changes) and returns its number.
pub async fn insert_version(
    conn: &mut SqliteConnection,
    paragraph_id: &str,
    paragraph: &Paragraph,
    seq: i64,
) -> Result<i64> {
    let (version,): (i64,) = sqlx::query_as(
        "INSERT INTO paragraph_versions (id, paragraph_id, version, placement, title, body,
                                         created_seq)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(version), 0) + 1 FROM paragraph_versions
                          WHERE paragraph_id = ?2), ?3, ?4, ?5, ?6)
         RETURNING version",
    )
    .bind(crate::new_id())
    .bind(paragraph_id)
    .bind(enum_text(&paragraph.placement))
    .bind(&paragraph.title)
    .bind(&paragraph.body)
    .bind(seq)
    .fetch_one(conn)
    .await?;
    Ok(version)
}

/// A paragraph at its latest version, removed or not.
pub async fn latest(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredParagraph>> {
    let row: Option<ParagraphRow> = sqlx::query_as(latest!("AND p.id = ?"))
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(StoredParagraph::try_from).transpose()
}

/// An entity type's library (without removed paragraphs) at the latest versions, oldest first.
pub async fn library(
    conn: &mut SqliteConnection,
    entity_type: &str,
) -> Result<Vec<StoredParagraph>> {
    let rows: Vec<ParagraphRow> = sqlx::query_as(latest!(
        "AND p.entity_type = ? AND p.removed_seq IS NULL ORDER BY p.created_seq, p.id"
    ))
    .bind(entity_type)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(StoredParagraph::try_from).collect()
}

/// Takes a paragraph out of the library. Its versions and every year's copy stay.
pub async fn remove(conn: &mut SqliteConnection, id: &str, seq: i64) -> Result<()> {
    sqlx::query("UPDATE paragraphs SET removed_seq = ? WHERE id = ? AND removed_seq IS NULL")
        .bind(seq)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// A client-year's copy of a library paragraph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct YearNote {
    pub id: String,
    pub client_year_id: String,
    pub paragraph_id: String,
    /// Order in the year's notes, from 0.
    pub position: i64,
    /// The library version last copied in.
    pub from_version: i64,
    /// The copy; its key is the library paragraph's.
    pub paragraph: Paragraph,
    /// Staff have changed this copy, so a push leaves it alone.
    pub edited: bool,
    pub updated_seq: i64,
}

#[derive(FromRow)]
struct NoteRow {
    id: String,
    client_year_id: String,
    paragraph_id: String,
    key: String,
    position: i64,
    from_version: i64,
    placement: String,
    title: String,
    body: String,
    edited: bool,
    updated_seq: i64,
}

impl TryFrom<NoteRow> for YearNote {
    type Error = StoreError;
    fn try_from(r: NoteRow) -> Result<YearNote> {
        let placement: Placement = parse_enum(&r.placement)?;
        Ok(YearNote {
            id: r.id,
            client_year_id: r.client_year_id,
            paragraph_id: r.paragraph_id,
            position: r.position,
            from_version: r.from_version,
            paragraph: Paragraph {
                key: parse(&r.key)?,
                placement,
                title: r.title,
                body: r.body,
            },
            edited: r.edited,
            updated_seq: r.updated_seq,
        })
    }
}

/// Year notes with their keys, then `$tail`.
macro_rules! notes {
    ($tail:literal) => {
        concat!(
            "SELECT n.id, n.client_year_id, n.paragraph_id, p.key, n.position,
            n.from_version, n.placement, n.title, n.body, n.edited, n.updated_seq
     FROM year_notes n JOIN paragraphs p ON p.id = n.paragraph_id ",
            $tail
        )
    };
}

/// A year's notes, in order.
pub async fn for_year(conn: &mut SqliteConnection, client_year_id: &str) -> Result<Vec<YearNote>> {
    let rows: Vec<NoteRow> = sqlx::query_as(notes!(
        "WHERE n.client_year_id = ? ORDER BY n.position, n.id"
    ))
    .bind(client_year_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(YearNote::try_from).collect()
}

/// Every year's copy of a library paragraph, in year id order.
pub async fn copies_of(conn: &mut SqliteConnection, paragraph_id: &str) -> Result<Vec<YearNote>> {
    let rows: Vec<NoteRow> = sqlx::query_as(notes!(
        "WHERE n.paragraph_id = ? ORDER BY n.client_year_id, n.id"
    ))
    .bind(paragraph_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(YearNote::try_from).collect()
}

pub async fn insert_note(conn: &mut SqliteConnection, n: &YearNote) -> Result<()> {
    sqlx::query(
        "INSERT INTO year_notes (id, client_year_id, paragraph_id, position, from_version,
                                 placement, title, body, edited, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&n.id)
    .bind(&n.client_year_id)
    .bind(&n.paragraph_id)
    .bind(n.position)
    .bind(n.from_version)
    .bind(enum_text(&n.paragraph.placement))
    .bind(&n.paragraph.title)
    .bind(&n.paragraph.body)
    .bind(n.edited)
    .bind(n.updated_seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// Rewrites a copy: its position, wording, version and edited flag.
pub async fn update_note(conn: &mut SqliteConnection, n: &YearNote) -> Result<()> {
    sqlx::query(
        "UPDATE year_notes SET position = ?, from_version = ?, placement = ?, title = ?, body = ?,
                               edited = ?, updated_seq = ?
         WHERE id = ?",
    )
    .bind(n.position)
    .bind(n.from_version)
    .bind(enum_text(&n.paragraph.placement))
    .bind(&n.paragraph.title)
    .bind(&n.paragraph.body)
    .bind(n.edited)
    .bind(n.updated_seq)
    .bind(&n.id)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn delete_note(conn: &mut SqliteConnection, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM year_notes WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
