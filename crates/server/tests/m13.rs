//! M13's "Done when" check, the part that needs a server: two browsers see each other's presence
//! and changes within a few seconds. (The other part, a plain-English description for every
//! command kind, is `history::tests` in the server crate.)
//!
//! Each browser here is its own session. The panel polls `POST /api/presence` and
//! `GET /api/history` every few seconds, so what one does shows in the other's next poll.

mod common;

use axum::http::{StatusCode, header};
use common::{PASSWORD, Server, get, new_id, post_json, split};
use serde_json::{Value, json};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

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

fn token() -> String {
    let a = uuid::Uuid::now_v7().simple().to_string();
    let b = uuid::Uuid::now_v7().simple().to_string();
    format!("{a}{b}")
}

struct Owner {
    cookie: String,
    business_id: String,
}

async fn sign_up(server: &Server, email: &str, business: &str) -> Owner {
    let response = server
        .send(post_json(
            "/api/signup",
            None,
            &json!({
                "id": new_id(),
                "email": email,
                "display_name": email.split('@').next().unwrap(),
                "password": PASSWORD,
                "business_name": business,
                "start_date": "2025-04-01",
            }),
        ))
        .await;
    let cookie = response.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "sign-up: {body}");
    Owner {
        cookie,
        business_id: body["business_id"].as_str().unwrap().to_owned(),
    }
}

/// Submits a command that must succeed, whether or not it creates anything.
async fn done(server: &Server, cookie: &str, kind: &str, payload: Value) {
    let (status, body) = server.command(cookie, kind, payload).await;
    assert_eq!(status, StatusCode::OK, "{kind}: {body}");
}

async fn presence(server: &Server, cookie: &str, business: Option<&str>) -> Vec<Value> {
    let (status, body) = split(
        server
            .send(post_json(
                "/api/presence",
                Some(cookie),
                &json!({ "business_id": business }),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK, "presence: {body}");
    body.as_array().unwrap().clone()
}

fn names(here: &[Value]) -> Vec<&str> {
    here.iter()
        .map(|p| p["display_name"].as_str().unwrap())
        .collect()
}

/// The practice's sole-trader defaults, owner Ana's business with one statement, her accountant
/// Sam (through an invite), and a second owner, Ben.
async fn setup() -> (Server, Owner, String, Owner) {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let accounts: Value = serde_json::from_str(CHART).unwrap();
    server
        .ok(
            &boss,
            "create_master_chart",
            json!({ "entity_type": "sole_trader", "name": "Sole trader", "accounts": accounts }),
        )
        .await;
    let template: Value = serde_json::from_str(TEMPLATE).unwrap();
    let template_id = server
        .ok(
            &boss,
            "create_template",
            json!({ "entity_type": "sole_trader", "name": "Sole trader", "body": template }),
        )
        .await;
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    server
        .ok(
            &boss,
            "create_mapping",
            json!({ "template_id": template_id, "name": "Sole trader", "body": mapping }),
        )
        .await;

    let ana = sign_up(&server, "ana@example.nz", "Ana's Gardens").await;
    let ben = sign_up(&server, "ben@example.nz", "Ben's Bikes").await;
    done(
        &server,
        &ana.cookie,
        "import_statement",
        json!({
            "client_id": ana.business_id,
            "file_name": "kowhai-business-2025-08.csv",
            "content_base64": base64(KOWHAI),
        }),
    )
    .await;
    let invite = token();
    done(
        &server,
        &ana.cookie,
        "create_invite",
        json!({ "client_id": ana.business_id, "email": "sam@practice.nz", "token": invite }),
    )
    .await;
    let sam = server.login("sam").await;
    done(&server, &sam, "accept_invite", json!({ "token": invite })).await;
    (server, ana, sam, ben)
}

#[tokio::test]
async fn m13_is_done() {
    let (server, ana, sam, ben) = setup().await;
    let biz = ana.business_id.clone();
    // Ana lets her accountant see her edits (they're private until she does).
    done(
        &server,
        &ana.cookie,
        "set_history_sharing",
        json!({ "client_id": biz, "share_owner_edits": true }),
    )
    .await;

    // Presence: Ana and Sam each have the business open, and see each other.
    let here = presence(&server, &ana.cookie, Some(&biz)).await;
    assert_eq!(names(&here), ["ana"], "Ana sees herself first: {here:?}");
    assert_eq!(here[0]["is_you"], true);
    let here = presence(&server, &sam, Some(&biz)).await;
    assert_eq!(names(&here), ["sam", "ana"], "{here:?}");
    assert_eq!(here[1]["business_name"], "Ana's Gardens");
    let here = presence(&server, &ana.cookie, Some(&biz)).await;
    assert_eq!(names(&here), ["ana", "sam"], "{here:?}");
    // Ben can't see Ana's business, so he sees neither of them.
    let here = presence(&server, &ben.cookie, None).await;
    assert_eq!(names(&here), ["ben"], "{here:?}");
    // Nor can he say he's on it.
    let (status, _) = split(
        server
            .send(post_json(
                "/api/presence",
                Some(&ben.cookie),
                &json!({ "business_id": biz }),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Ana categorises a withdrawal as an expense.
    let queue = server
        .get_json(&format!("/api/businesses/{biz}/save-tax"), &ana.cookie)
        .await;
    let line = queue["cards"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "categorise")
        .flat_map(|c| c["lines"].as_array().unwrap().clone())
        .find(|l| l["amount"].as_i64().unwrap() < 0)
        .unwrap_or_else(|| panic!("a withdrawal to categorise: {queue}"));
    let description = line["description"].as_str().unwrap().trim().to_owned();
    let before_tax = queue["total"].as_i64().unwrap();
    done(
        &server,
        &ana.cookie,
        "code_bank_line",
        json!({
            "bank_line_id": line["bank_line_id"],
            "coding": { "direction": "out", "kind": "expense",
                        "account": "150", "gst": "standard" },
        }),
    )
    .await;
    let after_tax = server
        .get_json(&format!("/api/businesses/{biz}/tax"), &ana.cookie)
        .await["total"]
        .as_i64()
        .unwrap();
    assert!(after_tax < before_tax, "an expense lowers the tax");

    // Sam's next poll shows it: who, what, before and after, and the effect on the tax.
    let page = server
        .get_json(&format!("/api/history?business={biz}"), &sam)
        .await;
    let newest = &page["entries"][0];
    assert_eq!(newest["kind"], "code_bank_line", "{page}");
    assert_eq!(newest["who"], "ana");
    assert_eq!(newest["business_name"], "Ana's Gardens");
    assert_eq!(
        newest["tax_change"].as_i64().unwrap(),
        after_tax - before_tax
    );
    let text = newest["description"].as_str().unwrap();
    assert!(
        text.starts_with(&format!("ana marked {description} on "))
            && text.contains(" as Purchases and materials. Tax to pay went down $"),
        "{text}"
    );
    let field = &newest["changes"]["fields"][0];
    assert_eq!(field["label"], "category");
    assert_eq!(field["before"], "not sorted yet");
    assert_eq!(field["after"], "Purchases and materials");
    assert!(newest["ai"].is_null());
    // The whole log is there, oldest last.
    let kinds: Vec<&str> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        kinds,
        [
            "code_bank_line",
            "set_history_sharing",
            "accept_invite",
            "create_invite",
            "import_statement",
            "sign_up"
        ]
    );
    assert!(page["next_before"].is_null());

    // And Sam's change shows to Ana the same way.
    let year = server.get_json(&format!("/api/clients/{biz}"), &sam).await["years"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let start = server.get_json(&format!("/api/years/{year}"), &sam).await["start"]
        .as_str()
        .unwrap()
        .to_owned();
    server
        .ok(
            &sam,
            "post_journal",
            json!({
                "client_year_id": year, "date": start, "narration": "Accrued fees",
                "lines": [{ "account": "200", "amount": 10000 },
                          { "account": "960", "amount": -10000 }],
            }),
        )
        .await;
    let page = server
        .get_json(&format!("/api/history?business={biz}&limit=1"), &ana.cookie)
        .await;
    assert_eq!(page["entries"][0]["who"], "sam");
    assert!(
        page["entries"][0]["description"]
            .as_str()
            .unwrap()
            .starts_with("sam posted a journal on "),
        "{page}"
    );
    assert!(!page["next_before"].is_null(), "there's more: {page}");

    // Clicking the tax figure: only the changes that moved it.
    let page = server
        .get_json(
            &format!("/api/history?business={biz}&figure=tax"),
            &ana.cookie,
        )
        .await;
    let moved: Vec<&str> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        moved,
        ["post_journal", "code_bank_line", "import_statement"],
        "{page}"
    );
    // Clicking an income year's figure: the same, through the figure's parts.
    let year_part = page["entries"][1]["changes"]["tax"]["after"]["parts"]
        .as_object()
        .unwrap()
        .keys()
        .find(|k| k.starts_with("income:"))
        .unwrap()
        .clone();
    let page = server
        .get_json(
            &format!("/api/history?business={biz}&figure={year_part}"),
            &ana.cookie,
        )
        .await;
    assert_eq!(page["entries"].as_array().unwrap().len(), 3, "{page}");

    // Clicking a statement or TB line: the changes that posted to its accounts.
    let page = server
        .get_json(&format!("/api/history?year={year}&accounts=150"), &sam)
        .await;
    let kinds: Vec<&str> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["code_bank_line"], "{page}");

    // Filters: by person, and by date.
    let ana_id = server.get_json("/api/me", &ana.cookie).await["id"].clone();
    let page = server
        .get_json(
            &format!(
                "/api/history?business={biz}&user={}",
                ana_id.as_str().unwrap()
            ),
            &sam,
        )
        .await;
    assert!(
        page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["who"] == "ana"),
        "{page}"
    );
    let page = server
        .get_json(&format!("/api/history?business={biz}&to=2000-01-01"), &sam)
        .await;
    assert!(page["entries"].as_array().unwrap().is_empty(), "{page}");

    // Ben sees none of it, and can't ask for it.
    let page = server.get_json("/api/history", &ben.cookie).await;
    assert!(!page.to_string().contains(&biz), "{page}");
    assert!(page.to_string().contains(&ben.business_id), "{page}");
    let (status, _) = split(
        server
            .send(get(
                &format!("/api/history?business={biz}"),
                Some(&ben.cookie),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Signing out leaves the room straight away.
    let response = server
        .send(post_json("/api/logout", Some(&sam), &json!({})))
        .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    let here = presence(&server, &ana.cookie, Some(&biz)).await;
    assert_eq!(names(&here), ["ana"], "{here:?}");
}

#[tokio::test]
async fn owner_edits_are_private_until_the_owner_shares_them() {
    let (server, ana, sam, _ben) = setup().await;
    let biz = ana.business_id.clone();
    let kinds = |page: &Value| -> Vec<String> {
        page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["kind"].as_str().unwrap().to_owned())
            .collect()
    };
    let uri = format!("/api/history?business={biz}");

    // The practice sees what its own people did, but none of Ana's edits.
    let page = server.get_json(&uri, &sam).await;
    assert_eq!(kinds(&page), ["accept_invite"], "{page}");
    // Ana sees all of it.
    let page = server.get_json(&uri, &ana.cookie).await;
    assert!(
        kinds(&page).contains(&"import_statement".to_owned()),
        "{page}"
    );
    assert!(kinds(&page).contains(&"create_invite".to_owned()), "{page}");

    // Accountants can't turn it on for her.
    let (status, _) = server
        .command(
            &sam,
            "set_history_sharing",
            json!({ "client_id": biz, "share_owner_edits": true }),
        )
        .await;
    assert_ne!(status, StatusCode::OK);

    done(
        &server,
        &ana.cookie,
        "set_history_sharing",
        json!({ "client_id": biz, "share_owner_edits": true }),
    )
    .await;
    let shared = server
        .get_json(&format!("/api/businesses/{biz}/history-sharing"), &sam)
        .await;
    assert_eq!(shared["share_owner_edits"], true);
    let page = server.get_json(&uri, &sam).await;
    assert!(
        kinds(&page).contains(&"import_statement".to_owned()),
        "{page}"
    );

    // The filters: staff only drops the owner's edits again; ledger keeps the statement.
    let page = server
        .get_json(&format!("{uri}&staff_only=true"), &sam)
        .await;
    assert_eq!(kinds(&page), ["accept_invite"], "{page}");
    let page = server.get_json(&format!("{uri}&ledger=true"), &sam).await;
    assert_eq!(kinds(&page), ["import_statement"], "{page}");
    let page = server.get_json(&format!("{uri}&manual=true"), &sam).await;
    assert!(kinds(&page).is_empty(), "{page}");

    // And she can take it back.
    done(
        &server,
        &ana.cookie,
        "set_history_sharing",
        json!({ "client_id": biz, "share_owner_edits": false }),
    )
    .await;
    let page = server.get_json(&uri, &sam).await;
    assert_eq!(kinds(&page), ["accept_invite"], "{page}");
}
