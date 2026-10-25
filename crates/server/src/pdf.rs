//! The statements PDF (ADR 010): `GET /api/years/{id}/report.pdf`.
//!
//! A finalised year prints its snapshot, the ReportDoc that was signed, never rebuilt. An open
//! year prints its live ReportDoc with "Draft" on every page. The PDF bytes aren't stored: the
//! same ReportDoc always renders to the same bytes, so the snapshot is the record.

use acct_core::ReportDoc;
use acct_pdf::PrintContext;
use acct_store::years::YearStatus;
use acct_store::{SqliteConnection, StoreError, clients, practice, tenancy, years};
use axum::extract::{Path, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use sha2::{Digest, Sha256};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::error::CommandError;
use crate::finalise::{self, SHA256_HEADER};
use crate::ledger;

/// The ReportDoc to print and what goes around it.
async fn printable(
    conn: &mut SqliteConnection,
    client_year_id: &str,
) -> Result<(ReportDoc, PrintContext), CommandError> {
    let year = years::get(conn, client_year_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client-year", client_year_id))?;
    let (doc, report_sha256, draft) = if year.status == YearStatus::Finalised {
        let (json, sha) = finalise::signed_report(conn, client_year_id).await?;
        let doc: ReportDoc = serde_json::from_str(&json).map_err(|e| {
            StoreError::Corrupt(format!("snapshot of {client_year_id} doesn't parse: {e}"))
        })?;
        (doc, sha, false)
    } else {
        let doc = ledger::report(conn, client_year_id).await?;
        let json = serde_json::to_string(&doc).expect("ReportDocs serialise");
        (doc, sha256_hex(json.as_bytes()), true)
    };
    let client = clients::get(conn, &year.client_id)
        .await?
        .ok_or_else(|| CommandError::not_found("client", &year.client_id))?;
    // An owner's business is the owner's own until an accountant accepts their invite; only then
    // does the practice's name go on its statements.
    let practice_prepares = !tenancy::has_owner(conn, &client.id).await?
        || tenancy::has_accountant(conn, &client.id).await?;
    let practice_name = if practice_prepares {
        practice::get(conn).await?.map(|p| p.name)
    } else {
        None
    };
    let ctx = PrintContext {
        client_name: client.name,
        practice_name,
        draft,
        report_sha256,
    };
    Ok((doc, ctx))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A download name such as `Example Widgets Limited 2026-03-31 draft.pdf`, kept to characters that
/// are safe in a header.
fn file_name(client_name: &str, doc: &ReportDoc, draft: bool) -> String {
    let name: String = client_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == ' ' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let suffix = if draft { " draft" } else { "" };
    format!("{} {}{suffix}.pdf", name.trim(), doc.current_period.end)
}

/// `GET /api/years/{id}/report.pdf`: the statements, schedule and notes as a PDF.
pub async fn get_report_pdf(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(id): Path<String>,
) -> Result<Response, CommandError> {
    let (doc, ctx) = {
        let mut conn = state.store.reader().await?;
        printable(&mut conn, &id).await?
    };
    let name = file_name(&ctx.client_name, &doc, ctx.draft);
    let sha = ctx.report_sha256.clone();
    // Laying out pages is CPU work; keep it off the async threads.
    let bytes = tokio::task::spawn_blocking(move || acct_pdf::render(&doc, &ctx))
        .await
        .map_err(|e| StoreError::Corrupt(format!("the PDF render stopped: {e}")))?
        .map_err(|e| StoreError::Corrupt(e.to_string()))?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/pdf"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("inline; filename=\"{name}\""))
            .expect("the file name is header-safe"),
    );
    headers.insert(
        SHA256_HEADER,
        HeaderValue::from_str(&sha).expect("hex is a valid header value"),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names_keep_to_safe_characters() {
        let doc: ReportDoc = serde_json::from_str(
            include_str!("../../core/tests/snapshots/fixture__fy2026_reportdoc.snap")
                .split_once("\n---\n")
                .expect("an insta header")
                .1,
        )
        .expect("a ReportDoc");
        assert_eq!(
            file_name("Tui \"Street\" Joinery/Ltd", &doc, true),
            "Tui _Street_ Joinery_Ltd 2026-03-31 draft.pdf"
        );
    }
}
