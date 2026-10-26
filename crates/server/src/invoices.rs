//! The invoice maker (Settings › Tools): each user's own invoices, kept with their account.
//!
//! A free extra for anyone signed in. An invoice here is a free-form page the user lays out and
//! saves as a PDF in the browser; it isn't part of any business's books, so nothing here touches a
//! ledger, and only the user who made something can read or change it (`crate::access`). The page is
//! HTML the web app's editor writes; the web app cleans it before showing it, and the server limits
//! its size. Images are stored separately and referred to by URL, so the page stays small.

use acct_store::SqliteConnection;
use acct_store::invoices;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use sha2::{Digest, Sha256};
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::business::decode_base64;
use crate::error::CommandError;

/// The most a page (draft or template) may hold, in bytes. The sample invoice is about 3 KB.
pub const MAX_HTML_BYTES: usize = 200_000;
/// The most an image may hold once decoded. The web app shrinks pictures to well under this.
pub const MAX_IMAGE_BYTES: usize = 1_000_000;
/// The longest template name, in characters.
pub const MAX_NAME_CHARS: usize = 60;

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn check_html(html: &str) -> Result<(), CommandError> {
    if html.len() > MAX_HTML_BYTES {
        return Err(CommandError::invalid(
            "invoice_too_large",
            format!(
                "The invoice is too large to save ({} KB; the most is {} KB).",
                html.len() / 1000,
                MAX_HTML_BYTES / 1000
            ),
        ));
    }
    Ok(())
}

/// A template's name, tidied: trimmed, one line, not empty, not too long.
fn template_name(name: &str) -> Result<String, CommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CommandError::invalid(
            "template_name_missing",
            "Give the template a name.",
        ));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(CommandError::invalid(
            "template_name_too_long",
            format!("A template's name can be at most {MAX_NAME_CHARS} characters."),
        ));
    }
    if name.chars().any(char::is_control) {
        return Err(CommandError::invalid(
            "template_name_invalid",
            "A template's name has to be on one line.",
        ));
    }
    Ok(name.to_owned())
}

/// The image's type, from its first bytes. Only the raster types every browser shows; not SVG,
/// which can carry script.
pub fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

fn user_of(user_id: Option<&str>) -> Result<&str, CommandError> {
    user_id.ok_or(CommandError::Forbidden)
}

pub async fn save_draft(
    conn: &mut SqliteConnection,
    user_id: Option<&str>,
    html: &str,
    seq: i64,
) -> Result<(), CommandError> {
    let user_id = user_of(user_id)?;
    check_html(html)?;
    invoices::set_draft(conn, user_id, html, seq).await?;
    Ok(())
}

/// Returns the template's id, the same one when it replaces a template of the same name.
pub async fn save_template(
    conn: &mut SqliteConnection,
    user_id: Option<&str>,
    name: &str,
    html: &str,
    seq: i64,
) -> Result<String, CommandError> {
    let user_id = user_of(user_id)?;
    let name = template_name(name)?;
    check_html(html)?;
    Ok(invoices::save_template(conn, user_id, &name, html, seq).await?)
}

/// `crate::access` has already checked the template is the user's own.
pub async fn delete_template(
    conn: &mut SqliteConnection,
    template_id: &str,
) -> Result<(), CommandError> {
    invoices::template(conn, template_id)
        .await?
        .ok_or_else(|| CommandError::not_found("invoice template", template_id))?;
    invoices::delete_template(conn, template_id).await?;
    Ok(())
}

/// Returns the image's id, the existing one if the user already uploaded the same image.
pub async fn add_image(
    conn: &mut SqliteConnection,
    user_id: Option<&str>,
    content_base64: &str,
    seq: i64,
) -> Result<String, CommandError> {
    let user_id = user_of(user_id)?;
    let bytes = decode_base64(content_base64).ok_or_else(|| {
        CommandError::invalid("image_unreadable", "The image couldn't be read.")
    })?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(CommandError::invalid(
            "image_too_large",
            format!(
                "The image is too large ({} KB; the most is {} KB).",
                bytes.len() / 1000,
                MAX_IMAGE_BYTES / 1000
            ),
        ));
    }
    let content_type = image_type(&bytes).ok_or_else(|| {
        CommandError::invalid(
            "image_type",
            "Use a PNG, JPEG, GIF or WebP image.",
        )
    })?;
    Ok(invoices::add_image(conn, user_id, content_type, &sha256_hex(&bytes), &bytes, seq).await?)
}

/// `GET /api/invoices/draft`: the invoice the signed-in user is working on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct InvoiceDraft {
    /// The editor's page, or `null` if they haven't saved one (the editor starts from its sample).
    pub html: Option<String>,
}

/// One of the signed-in user's templates, in `GET /api/invoices/templates`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct InvoiceTemplateSummary {
    pub id: String,
    pub name: String,
}

/// `GET /api/invoices/templates/{id}`: one template, with its page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct InvoiceTemplate {
    pub id: String,
    pub name: String,
    pub html: String,
}

pub async fn get_draft(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<InvoiceDraft>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(InvoiceDraft {
        html: invoices::draft(&mut conn, &user.0.id).await?,
    }))
}

pub async fn get_templates(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Result<Json<Vec<InvoiceTemplateSummary>>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(
        invoices::templates(&mut conn, &user.0.id)
            .await?
            .into_iter()
            .map(|(id, name)| InvoiceTemplateSummary { id, name })
            .collect(),
    ))
}

/// `crate::access` has already checked the template is the user's own.
pub async fn get_template(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Json<InvoiceTemplate>, CommandError> {
    let mut conn = state.store.reader().await?;
    let t = invoices::template(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("invoice template", &id))?;
    Ok(Json(InvoiceTemplate {
        id: t.id,
        name: t.name,
        html: t.html,
    }))
}

/// `GET /api/invoices/images/{id}`: an image's bytes. `crate::access` has already checked it's the
/// user's own. An image never changes, so the browser may keep it.
pub async fn get_image(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Response, CommandError> {
    let mut conn = state.store.reader().await?;
    let image = invoices::image(&mut conn, &id)
        .await?
        .ok_or_else(|| CommandError::not_found("invoice image", &id))?;
    let content_type = image_type(&image.data).unwrap_or("application/octet-stream");
    debug_assert_eq!(content_type, image.content_type);
    let mut response = image.data.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_only_raster_images() {
        assert_eq!(image_type(b"\x89PNG\r\n\x1a\nrest"), Some("image/png"));
        assert_eq!(image_type(&[0xFF, 0xD8, 0xFF, 0xE0]), Some("image/jpeg"));
        assert_eq!(image_type(b"GIF89a..."), Some("image/gif"));
        assert_eq!(image_type(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_type(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"), None);
        assert_eq!(image_type(b""), None);
    }

    #[test]
    fn tidies_template_names() {
        assert_eq!(template_name("  Standard  ").unwrap(), "Standard");
        assert!(template_name("   ").is_err());
        assert!(template_name("two\nlines").is_err());
        assert!(template_name(&"x".repeat(MAX_NAME_CHARS + 1)).is_err());
        assert!(template_name(&"ā".repeat(MAX_NAME_CHARS)).is_ok());
    }

    #[test]
    fn limits_a_pages_size() {
        assert!(check_html(&"x".repeat(MAX_HTML_BYTES)).is_ok());
        assert!(check_html(&"x".repeat(MAX_HTML_BYTES + 1)).is_err());
    }
}
