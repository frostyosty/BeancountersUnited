//! M13's "Done when" check, the part that needs a server: two browsers see each other's presence
//! and changes within a few seconds. (The other part, a plain-English description for every
//! command kind, is `history::tests` in the server crate.)
//!
//! Each browser here is its own session. The panel polls `POST /api/presence` and
//! `GET /api/history` every few seconds, so what one does shows in the other's next poll.

mod common;

use acct_server::commands::CommandEnvelope;
use acct_server::pipeline::{Actor, submit};
use acct_store::users::Role;
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

// ---------------------------------------------------------------------------------------------
// Viewing as someone (M19, ADR 013): the audit trail and who sees it.

/// An overseer, which only the server can make.
async fn add_overseer(server: &Server, username: &str) {
    let system = Actor {
        user_id: None,
        role: Role::Overseer,
        acting_as: None,
    };
    let envelope = CommandEnvelope {
        id: new_id(),
        command: serde_json::from_value(json!({
            "kind": "create_user",
            "payload": {
                "username": username, "display_name": username,
                "password": PASSWORD, "role": "overseer",
            },
        }))
        .unwrap(),
    };
    submit(&server.state.store, &system, envelope, chrono::Utc::now())
        .await
        .unwrap();
}

fn kinds_of(page: &Value) -> Vec<String> {
    page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["kind"].as_str().unwrap().to_owned())
        .collect()
}

const SESSION_KINDS: [&str; 3] = [
    "start_impersonation",
    "allow_impersonation_changes",
    "end_impersonation",
];

fn has_no_session_rows(page: &Value) -> bool {
    kinds_of(page)
        .iter()
        .all(|k| !SESSION_KINDS.contains(&k.as_str()))
}

#[tokio::test]
async fn viewing_as_someone_is_logged_with_both_names_and_the_person_sees_it() {
    let (server, ana, sam, ben) = setup().await;
    let biz = ana.business_id.clone();
    add_overseer(&server, "olive").await;
    let olive = server.login("olive").await;
    let ana_id = server.get_json("/api/me", &ana.cookie).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let olive_id = server.get_json("/api/me", &olive).await["id"]
        .as_str()
        .unwrap()
        .to_owned();

    // Olive views as Ana.
    server
        .ok(
            &olive,
            "start_impersonation",
            json!({ "user_id": ana_id, "reason": "Ana can't find her tax figure" }),
        )
        .await;

    // Presence: Olive shows by both names to whoever could see Ana there, and Ana isn't made to
    // look present by it. Ben can't see Ana's business, so he sees none of it.
    let here = presence(&server, &olive, Some(&biz)).await;
    assert_eq!(names(&here), ["olive (Overseer, as ana)"], "{here:?}");
    assert_eq!(here[0]["is_you"], true);
    assert_eq!(here[0]["user_id"], olive_id);
    assert_eq!(here[0]["role"], "overseer");
    assert_eq!(here[0]["acting_as"], "ana");
    let here = presence(&server, &ana.cookie, Some(&biz)).await;
    assert_eq!(
        names(&here),
        ["ana", "olive (Overseer, as ana)"],
        "{here:?}"
    );
    let here = presence(&server, &sam, Some(&biz)).await;
    assert_eq!(
        names(&here),
        ["sam", "ana", "olive (Overseer, as ana)"],
        "{here:?}"
    );
    let here = presence(&server, &ben.cookie, None).await;
    assert_eq!(names(&here), ["ben"], "{here:?}");

    // She turns changes on, recodes a line as Ana, and stops.
    server
        .ok(
            &olive,
            "allow_impersonation_changes",
            json!({ "reason": "To sort the line Ana asked about" }),
        )
        .await;
    let queue = server
        .get_json(&format!("/api/businesses/{biz}/save-tax"), &olive)
        .await;
    let line = queue["cards"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "categorise")
        .flat_map(|c| c["lines"].as_array().unwrap().clone())
        .find(|l| l["amount"].as_i64().unwrap() < 0)
        .unwrap_or_else(|| panic!("a withdrawal to categorise: {queue}"));
    done(
        &server,
        &olive,
        "code_bank_line",
        json!({
            "bank_line_id": line["bank_line_id"],
            "coding": { "direction": "out", "kind": "expense",
                        "account": "150", "gst": "standard" },
        }),
    )
    .await;
    server
        .ok(&olive, "end_impersonation", json!({ "reason": "Sorted" }))
        .await;

    // The log keeps both: `user_id` is Olive, `acting_as` is Ana, on all four rows.
    let rows: Vec<_> = {
        let mut conn = server.state.store.reader().await.unwrap();
        acct_store::log::after(&mut conn, 0, 1000)
            .await
            .unwrap()
            .into_iter()
            .filter(|r| r.acting_as.is_some())
            .collect()
    };
    let logged: Vec<&str> = rows.iter().map(|r| r.kind.as_str()).collect();
    assert_eq!(
        logged,
        [
            "start_impersonation",
            "allow_impersonation_changes",
            "code_bank_line",
            "end_impersonation"
        ]
    );
    for r in &rows {
        assert_eq!(r.user_id.as_deref(), Some(olive_id.as_str()), "{}", r.kind);
        assert_eq!(r.acting_as.as_deref(), Some(ana_id.as_str()), "{}", r.kind);
    }
    // The reasons are kept in the stored payloads.
    assert!(rows[0].payload.contains("Ana can't find her tax figure"));
    assert!(rows[1].payload.contains("To sort the line Ana asked about"));
    assert!(rows[3].payload.contains("Sorted"));
    // Ana's own Changes shows the whole session, with both names, though her edits are private
    // (sharing is off) and the start names no business.
    let page = server.get_json("/api/history?limit=20", &ana.cookie).await;
    let sessions: Vec<&Value> = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["acting_as"].is_object())
        .collect();
    let seen: Vec<&str> = sessions
        .iter()
        .map(|e| e["kind"].as_str().unwrap())
        .collect();
    assert_eq!(
        seen,
        [
            "end_impersonation",
            "code_bank_line",
            "allow_impersonation_changes",
            "start_impersonation"
        ],
        "{page}"
    );
    for e in &sessions {
        assert_eq!(e["user_id"], olive_id);
        assert_eq!(e["who"], "olive");
        assert_eq!(e["acting_as"]["user_id"], ana_id);
        assert_eq!(e["acting_as"]["name"], "ana");
    }
    let text = |i: usize| sessions[i]["description"].as_str().unwrap();
    assert_eq!(text(0), "olive stopped viewing as ana: Sorted.");
    assert!(
        text(1).starts_with("olive (as ana) marked ")
            && text(1).contains(" as Purchases and materials. Tax to pay went down $"),
        "{}",
        text(1)
    );
    assert_eq!(
        text(2),
        "olive turned on changes while viewing as ana: To sort the line Ana asked about."
    );
    assert_eq!(
        text(3),
        "olive started viewing as ana: Ana can't find her tax figure."
    );
    assert!(sessions[3]["business_id"].is_null());
    // The sync feed tells her tabs about the session too.
    let feed = server.get_json("/api/sync?after=0", &ana.cookie).await;
    let feed_kinds: Vec<&str> = feed["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["kind"].as_str().unwrap())
        .collect();
    for kind in SESSION_KINDS {
        assert!(feed_kinds.contains(&kind), "{kind} in {feed_kinds:?}");
    }

    // Olive sees all of it in her own Changes, and finds it by her own name.
    let page = server.get_json("/api/history?limit=20", &olive).await;
    for kind in SESSION_KINDS {
        assert!(kinds_of(&page).contains(&kind.to_owned()), "{page}");
    }
    let page = server
        .get_json(&format!("/api/history?user={olive_id}"), &olive)
        .await;
    for kind in SESSION_KINDS {
        assert!(kinds_of(&page).contains(&kind.to_owned()), "{page}");
    }

    // Sam is in the practice and sees none of the session rows. Ana's sharing is off, and a change
    // made as her counts as hers, so the recoding is hidden from him too.
    let page = server
        .get_json(&format!("/api/history?business={biz}"), &sam)
        .await;
    assert_eq!(kinds_of(&page), ["accept_invite"], "{page}");
    assert!(has_no_session_rows(
        &server.get_json("/api/history?limit=20", &sam).await
    ));
    let feed = server.get_json("/api/sync?after=0", &sam).await;
    assert!(
        feed["changes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|c| !SESSION_KINDS.contains(&c["kind"].as_str().unwrap())),
        "{feed}"
    );

    // Once Ana shares her edits, Sam sees the recoding with both names, still not the session
    // rows, and picking Ana in the person filter finds it, as it was made as her.
    done(
        &server,
        &ana.cookie,
        "set_history_sharing",
        json!({ "client_id": biz, "share_owner_edits": true }),
    )
    .await;
    let last = {
        let mut conn = server.state.store.reader().await.unwrap();
        let head = acct_store::log::head_seq(&mut conn).await.unwrap();
        acct_store::log::after(&mut conn, head - 1, 10)
            .await
            .unwrap()
    };
    assert_eq!(last[0].user_id.as_deref(), Some(ana_id.as_str()));
    assert_eq!(
        last[0].acting_as, None,
        "what Ana does herself isn't as anyone"
    );
    let page = server
        .get_json(&format!("/api/history?business={biz}"), &sam)
        .await;
    let recoding = page["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "code_bank_line")
        .unwrap_or_else(|| panic!("{page}"));
    assert_eq!(recoding["who"], "olive");
    assert_eq!(recoding["acting_as"]["name"], "ana");
    assert!(
        recoding["description"]
            .as_str()
            .unwrap()
            .starts_with("olive (as ana) marked ")
    );
    assert!(has_no_session_rows(&page));
    let page = server
        .get_json(&format!("/api/history?business={biz}&user={ana_id}"), &sam)
        .await;
    assert!(
        kinds_of(&page).contains(&"code_bank_line".to_owned()),
        "{page}"
    );

    // Ben, another owner, sees none of it.
    let page = server.get_json("/api/history", &ben.cookie).await;
    assert!(has_no_session_rows(&page), "{page}");
    assert!(
        page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .all(|e| e["acting_as"].is_null())
    );
}

#[tokio::test]
async fn a_view_as_staff_reads_changes_as_that_person_would() {
    let (server, ana, sam, _ben) = setup().await;
    let biz = ana.business_id.clone();
    add_overseer(&server, "olive").await;
    let olive = server.login("olive").await;
    let sam_id = server.get_json("/api/me", &sam).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Ana's edits are private (sharing is off): Sam can't see them, so neither can Olive as Sam.
    let uri = format!("/api/history?business={biz}");
    assert_eq!(
        kinds_of(&server.get_json(&uri, &sam).await),
        ["accept_invite"]
    );
    let own = kinds_of(&server.get_json(&uri, &olive).await);
    assert!(own.contains(&"import_statement".to_owned()), "{own:?}");

    server
        .ok(
            &olive,
            "start_impersonation",
            json!({ "user_id": sam_id, "reason": "Sam can't load the TB" }),
        )
        .await;
    let page = server.get_json("/api/history?limit=20", &olive).await;
    let kinds = kinds_of(&page);
    assert_eq!(kinds[0], "start_impersonation", "{page}");
    assert!(
        !kinds.contains(&"import_statement".to_owned())
            && !kinds.contains(&"create_invite".to_owned()),
        "as Sam, Ana's private edits stay hidden: {page}"
    );
    assert_eq!(page["entries"][0]["acting_as"]["name"], "sam");
    // Olive shows by both names to Ana (and to herself), and Sam isn't made present by it.
    let here = presence(&server, &olive, Some(&biz)).await;
    assert_eq!(names(&here), ["olive (Overseer, as sam)"], "{here:?}");
    let here = presence(&server, &ana.cookie, Some(&biz)).await;
    assert_eq!(
        names(&here),
        ["ana", "olive (Overseer, as sam)"],
        "{here:?}"
    );

    // Ending puts her back to her own view; Sam's own Changes keeps the session.
    server.ok(&olive, "end_impersonation", json!({})).await;
    let own = kinds_of(&server.get_json(&uri, &olive).await);
    assert!(own.contains(&"import_statement".to_owned()), "{own:?}");
    let sams = kinds_of(&server.get_json("/api/history?limit=20", &sam).await);
    assert!(sams.contains(&"start_impersonation".to_owned()), "{sams:?}");
    assert!(sams.contains(&"end_impersonation".to_owned()), "{sams:?}");
    // Ana is in the same business but isn't the person viewed as, so she sees neither.
    let anas = server.get_json("/api/history?limit=20", &ana.cookie).await;
    assert!(has_no_session_rows(&anas), "{anas}");
}
