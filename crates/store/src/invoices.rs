//! The invoice maker's storage: each user's draft, templates and images (migration 0011). All of it
//! belongs to one user and none of it to a business.

use sqlx::{FromRow, SqliteConnection};

use crate::Result;

/// The draft a user is working on, if they've saved one.
pub async fn draft(conn: &mut SqliteConnection, user_id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT html FROM invoice_drafts WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(conn)
            .await?;
    Ok(row.map(|(html,)| html))
}

pub async fn set_draft(
    conn: &mut SqliteConnection,
    user_id: &str,
    html: &str,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO invoice_drafts (user_id, html, updated_seq) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET html = excluded.html, updated_seq = excluded.updated_seq",
    )
    .bind(user_id)
    .bind(html)
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Template {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub html: String,
}

/// A user's templates by name, without their pages: `(id, name)`.
pub async fn templates(
    conn: &mut SqliteConnection,
    user_id: &str,
) -> Result<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT id, name FROM invoice_templates WHERE user_id = ? ORDER BY name COLLATE NOCASE, name",
    )
    .bind(user_id)
    .fetch_all(conn)
    .await?)
}

pub async fn template(conn: &mut SqliteConnection, id: &str) -> Result<Option<Template>> {
    Ok(
        sqlx::query_as("SELECT id, user_id, name, html FROM invoice_templates WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await?,
    )
}

/// Saves a template under `name`, replacing the user's template of that name if there is one.
/// Returns its id, which stays the same when it's replaced.
pub async fn save_template(
    conn: &mut SqliteConnection,
    user_id: &str,
    name: &str,
    html: &str,
    seq: i64,
) -> Result<String> {
    let (id,): (String,) = sqlx::query_as(
        "INSERT INTO invoice_templates (id, user_id, name, html, created_seq, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, name) DO UPDATE SET html = excluded.html, updated_seq = excluded.updated_seq
         RETURNING id",
    )
    .bind(crate::new_id())
    .bind(user_id)
    .bind(name)
    .bind(html)
    .bind(seq)
    .bind(seq)
    .fetch_one(conn)
    .await?;
    Ok(id)
}

pub async fn delete_template(conn: &mut SqliteConnection, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM invoice_templates WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Image {
    pub id: String,
    pub user_id: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

pub async fn image(conn: &mut SqliteConnection, id: &str) -> Result<Option<Image>> {
    Ok(
        sqlx::query_as("SELECT id, user_id, content_type, data FROM invoice_images WHERE id = ?")
            .bind(id)
            .fetch_optional(conn)
            .await?,
    )
}

/// Who an image belongs to, without reading its bytes.
pub async fn image_owner(conn: &mut SqliteConnection, id: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT user_id FROM invoice_images WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    Ok(row.map(|(u,)| u))
}

/// Stores an image for the user, or finds the one they already have with the same content.
/// Returns its id.
pub async fn add_image(
    conn: &mut SqliteConnection,
    user_id: &str,
    content_type: &str,
    sha256: &str,
    data: &[u8],
    seq: i64,
) -> Result<String> {
    let existing: Option<(String,)> =
        sqlx::query_as("SELECT id FROM invoice_images WHERE user_id = ? AND sha256 = ?")
            .bind(user_id)
            .bind(sha256)
            .fetch_optional(&mut *conn)
            .await?;
    if let Some((id,)) = existing {
        return Ok(id);
    }
    let id = crate::new_id();
    sqlx::query(
        "INSERT INTO invoice_images (id, user_id, content_type, sha256, data, created_seq)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(user_id)
    .bind(content_type)
    .bind(sha256)
    .bind(data)
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(id)
}
