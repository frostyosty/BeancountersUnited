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
