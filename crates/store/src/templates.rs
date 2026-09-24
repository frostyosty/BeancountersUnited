//! Statement templates and mappings, each with immutable numbered versions.

use acct_core::{Mapping, Template};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, from_json, to_json};

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct TemplateInfo {
    pub id: String,
    pub entity_type: String,
    pub name: String,
    pub created_seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct MappingInfo {
    pub id: String,
    pub template_id: String,
    pub name: String,
    pub created_seq: i64,
}

/// One version of a template or mapping.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version<T> {
    pub id: String,
    /// The template or mapping this is a version of.
    pub parent_id: String,
    pub version: i64,
    pub body: T,
    pub created_seq: i64,
}

#[derive(FromRow)]
struct VersionRow {
    id: String,
    parent_id: String,
    version: i64,
    body: String,
    created_seq: i64,
}

impl VersionRow {
    fn decode<T: serde::de::DeserializeOwned>(self) -> Result<Version<T>> {
        Ok(Version {
            id: self.id,
            parent_id: self.parent_id,
            version: self.version,
            body: from_json(&self.body)?,
            created_seq: self.created_seq,
        })
    }
}

pub async fn insert_template(conn: &mut SqliteConnection, t: &TemplateInfo) -> Result<()> {
    sqlx::query("INSERT INTO templates (id, entity_type, name, created_seq) VALUES (?, ?, ?, ?)")
        .bind(&t.id)
        .bind(&t.entity_type)
        .bind(&t.name)
        .bind(t.created_seq)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn get_template(conn: &mut SqliteConnection, id: &str) -> Result<Option<TemplateInfo>> {
    Ok(sqlx::query_as("SELECT * FROM templates WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

pub async fn insert_mapping(conn: &mut SqliteConnection, m: &MappingInfo) -> Result<()> {
    sqlx::query("INSERT INTO mappings (id, template_id, name, created_seq) VALUES (?, ?, ?, ?)")
        .bind(&m.id)
        .bind(&m.template_id)
        .bind(&m.name)
        .bind(m.created_seq)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn get_mapping(conn: &mut SqliteConnection, id: &str) -> Result<Option<MappingInfo>> {
    Ok(sqlx::query_as("SELECT * FROM mappings WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?)
}

/// Writes the next version of a template and returns its number (1 for the first).
/// The mappings onto templates for an entity type, oldest first.
pub async fn mappings_for_entity_type(
    conn: &mut SqliteConnection,
    entity_type: &str,
) -> Result<Vec<MappingInfo>> {
    Ok(sqlx::query_as(
        "SELECT m.* FROM mappings m JOIN templates t ON t.id = m.template_id
         WHERE t.entity_type = ? ORDER BY m.created_seq, m.id",
    )
    .bind(entity_type)
    .fetch_all(conn)
    .await?)
}

/// Which versions table a query runs against. Each SQL statement below is a fixed string.
#[derive(Clone, Copy)]
enum Table {
    Template,
    Mapping,
}

impl Table {
    const fn insert(self) -> &'static str {
        match self {
            Table::Template => {
                "INSERT INTO template_versions (id, template_id, version, body, created_seq)
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(version), 0) + 1 FROM template_versions
                                  WHERE template_id = ?2), ?3, ?4)
                 RETURNING version"
            }
            Table::Mapping => {
                "INSERT INTO mapping_versions (id, mapping_id, version, body, created_seq)
                 VALUES (?1, ?2, (SELECT COALESCE(MAX(version), 0) + 1 FROM mapping_versions
                                  WHERE mapping_id = ?2), ?3, ?4)
                 RETURNING version"
            }
        }
    }

    const fn by_id(self) -> &'static str {
        match self {
            Table::Template => {
                "SELECT id, template_id AS parent_id, version, body, created_seq
                 FROM template_versions WHERE id = ?"
            }
            Table::Mapping => {
                "SELECT id, mapping_id AS parent_id, version, body, created_seq
                 FROM mapping_versions WHERE id = ?"
            }
        }
    }

    const fn latest(self) -> &'static str {
        match self {
            Table::Template => {
                "SELECT id, template_id AS parent_id, version, body, created_seq
                 FROM template_versions WHERE template_id = ? ORDER BY version DESC LIMIT 1"
            }
            Table::Mapping => {
                "SELECT id, mapping_id AS parent_id, version, body, created_seq
                 FROM mapping_versions WHERE mapping_id = ? ORDER BY version DESC LIMIT 1"
            }
        }
    }
}

/// Writes the next version of a template and returns its number (1 for the first).
pub async fn add_template_version(
    conn: &mut SqliteConnection,
    id: &str,
    template_id: &str,
    body: &Template,
    created_seq: i64,
) -> Result<i64> {
    add_version(
        conn,
        Table::Template,
        id,
        template_id,
        &to_json(body),
        created_seq,
    )
    .await
}

/// Writes the next version of a mapping and returns its number (1 for the first).
pub async fn add_mapping_version(
    conn: &mut SqliteConnection,
    id: &str,
    mapping_id: &str,
    body: &Mapping,
    created_seq: i64,
) -> Result<i64> {
    add_version(
        conn,
        Table::Mapping,
        id,
        mapping_id,
        &to_json(body),
        created_seq,
    )
    .await
}

pub async fn template_version(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<Version<Template>>> {
    get_version(conn, Table::Template.by_id(), id).await
}

pub async fn mapping_version(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Option<Version<Mapping>>> {
    get_version(conn, Table::Mapping.by_id(), id).await
}

/// The newest version of a template.
pub async fn latest_template_version(
    conn: &mut SqliteConnection,
    template_id: &str,
) -> Result<Option<Version<Template>>> {
    get_version(conn, Table::Template.latest(), template_id).await
}

/// The newest version of a mapping.
pub async fn latest_mapping_version(
    conn: &mut SqliteConnection,
    mapping_id: &str,
) -> Result<Option<Version<Mapping>>> {
    get_version(conn, Table::Mapping.latest(), mapping_id).await
}

async fn add_version(
    conn: &mut SqliteConnection,
    table: Table,
    id: &str,
    parent_id: &str,
    body: &str,
    created_seq: i64,
) -> Result<i64> {
    let (version,): (i64,) = sqlx::query_as(table.insert())
        .bind(id)
        .bind(parent_id)
        .bind(body)
        .bind(created_seq)
        .fetch_one(conn)
        .await?;
    Ok(version)
}

async fn get_version<T: serde::de::DeserializeOwned>(
    conn: &mut SqliteConnection,
    sql: &'static str,
    value: &str,
) -> Result<Option<Version<T>>> {
    let row: Option<VersionRow> = sqlx::query_as(sql).bind(value).fetch_optional(conn).await?;
    row.map(VersionRow::decode).transpose()
}

/// A template or mapping as listed: its latest version number, and the entity type it's for.
#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Listed {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    /// For a mapping, the template it maps onto; for a template, its own id.
    pub template_id: String,
    pub latest_version: i64,
}

/// Every template, by entity type and then age.
pub async fn list_templates(conn: &mut SqliteConnection) -> Result<Vec<Listed>> {
    Ok(sqlx::query_as(
        "SELECT t.id, t.name, t.entity_type, t.id AS template_id,
                (SELECT COALESCE(MAX(version), 0) FROM template_versions v
                 WHERE v.template_id = t.id) AS latest_version
         FROM templates t ORDER BY t.entity_type, t.created_seq, t.id",
    )
    .fetch_all(conn)
    .await?)
}

/// Every mapping, by entity type and then age.
pub async fn list_mappings(conn: &mut SqliteConnection) -> Result<Vec<Listed>> {
    Ok(sqlx::query_as(
        "SELECT m.id, m.name, t.entity_type, m.template_id,
                (SELECT COALESCE(MAX(version), 0) FROM mapping_versions v
                 WHERE v.mapping_id = m.id) AS latest_version
         FROM mappings m JOIN templates t ON t.id = m.template_id
         ORDER BY t.entity_type, m.created_seq, m.id",
    )
    .fetch_all(conn)
    .await?)
}
