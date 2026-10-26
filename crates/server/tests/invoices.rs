//! The invoice maker's storage: each user's draft, templates and images are theirs alone, kept
//! with their account, and stay out of everyone else's Changes and change feed.

mod common;

use axum::http::{StatusCode, header};
use common::{Server, get, new_id, post_json, split};
use serde_json::{Value, json};

/// A 1×1 PNG.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0x0F, 0x00, 0x00,
    0x01, 0x01, 0x00, 0x05, 0x18, 0xD8, 0x4D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE,
    0x42, 0x60, 0x82,
];

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &b)| n | u32::from(b) << (16 - 8 * i));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ABC[(n >> (18 - 6 * i) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

async fn status_of(server: &Server, uri: &str, cookie: &str) -> (StatusCode, Value) {
    split(server.send(get(uri, Some(cookie))).await).await
}

#[tokio::test]
async fn each_user_keeps_their_own_draft() {
    let server = Server::new().await;
    let sam = server.login("sam").await;
    let val = server.login("val").await;
    let boss = server.login("boss").await;

    let draft = server.get_json("/api/invoices/draft", &sam).await;
    assert_eq!(draft, json!({ "html": null }), "nothing saved yet");

    server
        .ok_or_none(&sam, "save_invoice_draft", json!({ "html": "<p>Sam's</p>" }))
        .await;
    server
        .ok_or_none(&sam, "save_invoice_draft", json!({ "html": "<p>Sam's, again</p>" }))
        .await;
    // A viewer can't change the books, but their invoices are their own.
    server
        .ok_or_none(&val, "save_invoice_draft", json!({ "html": "<p>Val's</p>" }))
        .await;

    assert_eq!(
        server.get_json("/api/invoices/draft", &sam).await["html"],
        "<p>Sam's, again</p>"
    );
    assert_eq!(
        server.get_json("/api/invoices/draft", &val).await["html"],
        "<p>Val's</p>"
    );
    assert_eq!(
        server.get_json("/api/invoices/draft", &boss).await["html"],
        Value::Null
    );
}

#[tokio::test]
async fn templates_save_by_name_and_only_their_owner_reaches_them() {
    let server = Server::new().await;
    let sam = server.login("sam").await;
    let boss = server.login("boss").await;

    let id = server
        .ok(
            &sam,
            "save_invoice_template",
            json!({ "name": "  Standard ", "html": "<p>one</p>" }),
        )
        .await;
    // The same name replaces it, keeping its id.
    let again = server
        .ok(
            &sam,
            "save_invoice_template",
            json!({ "name": "Standard", "html": "<p>two</p>" }),
        )
        .await;
    assert_eq!(again, id);
    server
        .ok(
            &sam,
            "save_invoice_template",
            json!({ "name": "another", "html": "<p>three</p>" }),
        )
        .await;

    let list = server.get_json("/api/invoices/templates", &sam).await;
    let names: Vec<&str> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["another", "Standard"]);
    let one = server
        .get_json(&format!("/api/invoices/templates/{id}"), &sam)
        .await;
    assert_eq!(one, json!({ "id": id, "name": "Standard", "html": "<p>two</p>" }));

    // Someone else, even a practice admin, is told it doesn't exist.
    assert!(
        server
            .get_json("/api/invoices/templates", &boss)
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    let (status, body) = status_of(&server, &format!("/api/invoices/templates/{id}"), &boss).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["details"]["id"], id.as_str());
    let (status, body) = server
        .command(&boss, "delete_invoice_template", json!({ "template_id": id }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");

    server
        .ok_or_none(&sam, "delete_invoice_template", json!({ "template_id": id }))
        .await;
    let (status, _) = status_of(&server, &format!("/api/invoices/templates/{id}"), &sam).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn bad_invoices_are_rejected() {
    let server = Server::new().await;
    let sam = server.login("sam").await;
    let rejected = |kind: &'static str, payload: Value, code: &'static str| {
        let server = &server;
        let sam = &sam;
        async move {
            let (status, body) = server.command(sam, kind, payload).await;
            assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{kind}: {body}");
            assert_eq!(body["code"], code, "{body}");
        }
    };
    let huge = "x".repeat(acct_server::invoices::MAX_HTML_BYTES + 1);
    rejected("save_invoice_draft", json!({ "html": huge }), "invoice_too_large").await;
    rejected(
        "save_invoice_template",
        json!({ "name": "big", "html": huge }),
        "invoice_too_large",
    )
    .await;
    rejected(
        "save_invoice_template",
        json!({ "name": "   ", "html": "<p/>" }),
        "template_name_missing",
    )
    .await;
    rejected(
        "add_invoice_image",
        json!({ "content_base64": base64(b"<svg xmlns='http://www.w3.org/2000/svg'/>") }),
        "image_type",
    )
    .await;
    rejected(
        "add_invoice_image",
        json!({ "content_base64": "not base64!" }),
        "image_unreadable",
    )
    .await;
    let mut big = PNG.to_vec();
    big.resize(acct_server::invoices::MAX_IMAGE_BYTES + 1, 0);
    rejected(
        "add_invoice_image",
        json!({ "content_base64": base64(&big) }),
        "image_too_large",
    )
    .await;
    assert_eq!(
        server.get_json("/api/invoices/draft", &sam).await["html"],
        Value::Null
    );
}

#[tokio::test]
async fn images_are_stored_once_and_shown_only_to_their_owner() {
    let server = Server::new().await;
    let sam = server.login("sam").await;
    let val = server.login("val").await;

    let payload = json!({ "content_base64": base64(PNG) });
    let id = server.ok(&sam, "add_invoice_image", payload.clone()).await;
    assert_eq!(server.ok(&sam, "add_invoice_image", payload.clone()).await, id);
    // Someone else uploading the same picture gets their own.
    let vals = server.ok(&val, "add_invoice_image", payload).await;
    assert_ne!(vals, id);

    let uri = format!("/api/invoices/images/{id}");
    let response = server.send(get(&uri, Some(&sam))).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(server.get_bytes(&uri, &sam).await, PNG);

    let (status, body) = status_of(&server, &uri, &val).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    let (status, _) = split(server.send(get(&uri, None)).await).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_log_keeps_a_hash_not_the_invoice_and_others_never_see_it() {
    let server = Server::new().await;
    let sam = server.login("sam").await;
    let boss = server.login("boss").await;
    let head = server.get_json("/api/sync?after=0", &boss).await["head_seq"]
        .as_i64()
        .unwrap();

    // Resubmitting the same id gives the same answer, from the hash in the log.
    let html = "<p>Bill to: A Customer, 1 Private Lane</p>";
    let body = json!({ "id": new_id(), "kind": "save_invoice_template",
        "payload": { "name": "Mine", "html": html } });
    let (status, first) = split(
        server
            .send(post_json("/api/commands", Some(&sam), &body))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{first}");
    let (status, second) = split(
        server
            .send(post_json("/api/commands", Some(&sam), &body))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{second}");
    assert_eq!(first, second);
    server
        .ok(&sam, "add_invoice_image", json!({ "content_base64": base64(PNG) }))
        .await;

    let state = server.state.clone();
    let mut conn = state.store.reader().await.unwrap();
    let entries = acct_store::log::after(&mut conn, head, 100).await.unwrap();
    assert_eq!(entries.len(), 2, "{entries:?}");
    for e in &entries {
        assert!(!e.payload.contains("Private Lane"), "{}", e.payload);
        assert!(!e.payload.contains(&base64(PNG)), "{}", e.payload);
        assert!(e.payload.contains("sha256"), "{}", e.payload);
        assert!(e.client_id.is_none());
    }

    // Not in anyone else's change feed or Changes; in the user's own feed only.
    let feed = server
        .get_json(&format!("/api/sync?after={head}"), &boss)
        .await;
    assert_eq!(feed["changes"], json!([]), "{feed}");
    let own = server
        .get_json(&format!("/api/sync?after={head}"), &sam)
        .await;
    assert_eq!(own["changes"].as_array().unwrap().len(), 2, "{own}");
    for cookie in [&boss, &sam] {
        let history = server.get_json("/api/history", cookie).await.to_string();
        assert!(!history.contains("invoice"), "{history}");
    }
}

trait OkOrNone {
    /// Submits a command that must succeed and creates nothing with an id.
    async fn ok_or_none(&self, cookie: &str, kind: &str, payload: Value);
}

impl OkOrNone for Server {
    async fn ok_or_none(&self, cookie: &str, kind: &str, payload: Value) {
        let (status, body) = self.command(cookie, kind, payload).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {body}");
    }
}
