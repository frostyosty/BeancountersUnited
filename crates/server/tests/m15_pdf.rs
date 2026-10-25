//! The statements PDF over HTTP (ADR 010): the live ReportDoc marked Draft while a year is open,
//! the snapshot once it's finalised.

mod common;

use acct_core::ReportDoc;
use acct_pdf::PrintContext;
use axum::body::to_bytes;
use axum::http::{StatusCode, header};
use common::{Server, get};
use serde_json::json;
use sha2::{Digest, Sha256};

struct Pdf {
    bytes: Vec<u8>,
    sha: String,
    disposition: String,
}

async fn pdf(server: &Server, year: &str, cookie: &str) -> Pdf {
    let response = server
        .send(get(&format!("/api/years/{year}/report.pdf"), Some(cookie)))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let headers = response.headers().clone();
    assert_eq!(headers[header::CONTENT_TYPE], "application/pdf");
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap()
        .to_vec();
    Pdf {
        bytes,
        sha: headers["x-report-sha256"].to_str().unwrap().to_owned(),
        disposition: headers[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .to_owned(),
    }
}

fn hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn render(doc: &[u8], draft: bool, sha: &str) -> Vec<u8> {
    let doc: ReportDoc = serde_json::from_slice(doc).unwrap();
    let ctx = PrintContext {
        client_name: "Example Widgets Limited".into(),
        practice_name: Some("Example Practice".into()),
        draft,
        report_sha256: sha.into(),
    };
    acct_pdf::render(&doc, &ctx).unwrap()
}

#[tokio::test]
async fn an_open_year_prints_a_draft_and_a_finalised_one_prints_its_snapshot() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let val = server.login("val").await;
    let f = server.load_fixture(&boss, &sam).await;
    let year = &f.year_ids[0];
    let client = server
        .get_json(&format!("/api/clients/{}", f.client_id), &boss)
        .await;
    assert_eq!(client["name"], "Example Widgets Limited");

    // Open: the live ReportDoc, marked Draft, footed with its hash.
    let live = server
        .get_bytes(&format!("/api/years/{year}/report"), &boss)
        .await;
    let draft = pdf(&server, year, &val).await;
    assert_eq!(draft.sha, hex(&live));
    assert_eq!(draft.bytes, render(&live, true, &draft.sha));
    assert!(draft.bytes.starts_with(b"%PDF-"));
    assert_eq!(
        draft.disposition,
        "inline; filename=\"Example Widgets Limited 2025-03-31 draft.pdf\""
    );
    // Rendering again gives the same bytes.
    assert_eq!(pdf(&server, year, &boss).await.bytes, draft.bytes);

    // Finalised: the snapshot, unmarked, with the stored hash.
    server
        .ok(
            &boss,
            "finalise_year",
            json!({ "client_year_id": year, "accept_uncategorised": true }),
        )
        .await;
    let signed = server
        .get_bytes(&format!("/api/years/{year}/snapshot"), &boss)
        .await;
    let fin = pdf(&server, year, &val).await;
    assert_eq!(fin.sha, hex(&signed));
    assert_eq!(fin.bytes, render(&signed, false, &fin.sha));
    assert_ne!(fin.bytes, draft.bytes);
    assert_eq!(
        fin.disposition,
        "inline; filename=\"Example Widgets Limited 2025-03-31.pdf\""
    );
}

#[tokio::test]
async fn an_unknown_year_is_not_found() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let response = server
        .send(get("/api/years/no-such-year/report.pdf", Some(&boss)))
        .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}
