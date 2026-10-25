//! Editing templates and mappings, and moving open years onto their newer versions: the latest
//! mapping always fits the latest template, and a year changes layout only when it's moved.

mod common;

use acct_store::log;
use axum::http::StatusCode;
use common::{MAPPING, Server};
use serde_json::{Value, json};

async fn head(server: &Server) -> i64 {
    let mut conn = server.state.store.reader().await.unwrap();
    log::head_seq(&mut conn).await.unwrap()
}

async fn refused(server: &Server, cookie: &str, kind: &str, payload: Value) -> Value {
    let before = head(server).await;
    let (status, body) = server.command(cookie, kind, payload).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{kind}: {body}");
    assert_eq!(
        head(server).await,
        before,
        "{kind} left something in the log"
    );
    body
}

async fn post(server: &Server, cookie: &str, uri: &str, body: Value) -> (StatusCode, Value) {
    common::split(
        server
            .send(common::post_json(uri, Some(cookie), &body))
            .await,
    )
    .await
}

/// The ids of the company template and mapping.
fn company_defaults(practice: &Value) -> (String, String) {
    (
        practice["templates"][0]["id"].as_str().unwrap().to_owned(),
        practice["mappings"][0]["id"].as_str().unwrap().to_owned(),
    )
}

/// The company mapping with 110–199 (interest received) folded into sales.
fn interest_as_sales() -> Value {
    let mut mapping: Value = serde_json::from_str(MAPPING).unwrap();
    for r in mapping["ranges"].as_array_mut().unwrap() {
        if r["line"] == "interest_income" {
            r["line"] = json!("sales");
        }
    }
    mapping
}

fn row<'a>(doc: &'a Value, key: &str) -> &'a Value {
    doc["statements"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|s| s["rows"].as_array().unwrap())
        .find(|r| r["key"] == key && r["style"] == "line")
        .unwrap_or_else(|| panic!("no line {key}"))
}

#[tokio::test]
async fn a_template_revision_must_keep_its_mappings_fitting() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    server.load_fixture(&boss, &sam).await;
    let practice = server.get_json("/api/practice", &boss).await;
    let (template_id, mapping_id) = company_defaults(&practice);

    let detail = server
        .get_json(&format!("/api/templates/{template_id}"), &boss)
        .await;
    assert_eq!(detail["version"], 1);
    assert_eq!(detail["mappings"][0]["id"], mapping_id.as_str());
    let mapping = server
        .get_json(&format!("/api/mappings/{mapping_id}"), &boss)
        .await;
    let lines: Vec<&str> = mapping["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["key"].as_str().unwrap())
        .collect();
    assert!(lines.contains(&"interest_income"), "{lines:?}");

    // Drop the interest line. The mapping still points 110–199 at it, so that's refused...
    let mut template = detail["body"].clone();
    let revenue = &mut template["statements"][0]["body"][0]["children"];
    revenue
        .as_array_mut()
        .unwrap()
        .retain(|n| n["key"] != "interest_income");
    let body = refused(
        &server,
        &boss,
        "revise_template",
        json!({ "template_id": template_id, "body": template }),
    )
    .await;
    assert_eq!(body["code"], "mapping_breaks");
    assert!(
        body["details"][0]
            .as_str()
            .unwrap()
            .contains("interest_income"),
        "{body}"
    );

    // ...unless the same command points those ranges somewhere else.
    server
        .ok(
            &boss,
            "revise_template",
            json!({ "template_id": template_id, "body": template,
                    "mappings": [{ "mapping_id": mapping_id, "body": interest_as_sales() }] }),
        )
        .await;
    let detail = server
        .get_json(&format!("/api/templates/{template_id}"), &boss)
        .await;
    assert_eq!(detail["version"], 2);
    assert_eq!(detail["mappings"][0]["version"], 2);

    // A mapping from another template can't ride along. Staff can't revise templates at all.
    let body = refused(
        &server,
        &boss,
        "revise_template",
        json!({ "template_id": template_id, "body": template,
                "mappings": [{ "mapping_id": template_id, "body": interest_as_sales() }] }),
    )
    .await;
    assert_eq!(body["code"], "wrong_template");
    let (status, _) = server
        .command(
            &sam,
            "revise_template",
            json!({ "template_id": template_id, "body": template }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn checking_a_draft_mapping_shows_problems_and_coverage() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    server
        .ok(&boss, "install_starter_set", json!({ "set": "company" }))
        .await;
    let practice = server.get_json("/api/practice", &boss).await;
    let (template_id, _) = company_defaults(&practice);
    let draft = json!({ "ranges": [
        { "from": "100", "to": "109", "line": "sales" },
        { "from": "105", "to": "199", "line": "nowhere" },
    ] });
    let (status, check) = post(
        &server,
        &boss,
        "/api/mappings/check",
        json!({ "template_id": template_id, "body": draft }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{check}");
    let codes: Vec<&str> = check["problems"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["code"].as_str().unwrap())
        .collect();
    assert_eq!(codes, ["unknown_line", "overlap"]);
    let accounts = check["accounts"].as_array().unwrap();
    assert_eq!(accounts.len(), 28);
    assert_eq!(accounts[0]["code"], "100");
    assert_eq!(accounts[0]["line"], "sales");
    let rent = accounts.iter().find(|a| a["code"] == "230").unwrap();
    assert_eq!(rent["line"], Value::Null);
}

#[tokio::test]
async fn an_open_year_moves_onto_a_newer_layout_only_when_asked() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let fixture = server.load_fixture(&boss, &sam).await;
    let year = fixture.year_ids.last().unwrap().clone();
    let practice = server.get_json("/api/practice", &boss).await;
    let (_, mapping_id) = company_defaults(&practice);
    let report = server
        .get_json(&format!("/api/years/{year}/report"), &sam)
        .await;
    let interest = row(&report, "interest_income")["current"].as_i64().unwrap();
    let sales = row(&report, "sales")["current"].as_i64().unwrap();

    let layout = server
        .get_json(&format!("/api/years/{year}/layout"), &sam)
        .await;
    assert_eq!(layout["up_to_date"], true);
    let body = refused(
        &server,
        &sam,
        "move_year_layout",
        json!({ "client_year_id": year }),
    )
    .await;
    assert_eq!(body["code"], "layout_current");

    // A new mapping version doesn't reach back into the year...
    server
        .ok(
            &boss,
            "revise_mapping",
            json!({ "mapping_id": mapping_id, "body": interest_as_sales() }),
        )
        .await;
    let unchanged = server
        .get_json(&format!("/api/years/{year}/report"), &sam)
        .await;
    assert_eq!(unchanged, report);

    // ...but the preview shows what moving would do.
    let layout = server
        .get_json(&format!("/api/years/{year}/layout"), &sam)
        .await;
    assert_eq!(layout["up_to_date"], false);
    assert_eq!(layout["current"]["mapping_version"], 1);
    assert_eq!(layout["proposed"]["mapping_version"], 2);
    assert_eq!(layout["problems"], json!([]));
    let changes = layout["changes"].as_array().unwrap();
    let sales_change = changes
        .iter()
        .find(|c| c["key"] == "sales" && c["after"]["style"] == "line")
        .unwrap();
    assert_eq!(sales_change["before"]["current"], sales);
    assert_eq!(sales_change["after"]["current"], sales + interest);

    // Staff move it. Only then does the report change, and the history says so.
    let (status, body) = server
        .command(&sam, "move_year_layout", json!({ "client_year_id": year }))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let moved = server
        .get_json(&format!("/api/years/{year}/report"), &sam)
        .await;
    assert_eq!(
        row(&moved, "sales")["current"].as_i64().unwrap(),
        sales + interest
    );
    let layout = server
        .get_json(&format!("/api/years/{year}/layout"), &sam)
        .await;
    assert_eq!(layout["up_to_date"], true);
    let history = server.get_json("/api/history", &boss).await;
    let entry = history["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "move_year_layout")
        .unwrap();
    assert_eq!(
        entry["description"],
        "sam moved the year ending 31 Mar 2026 onto Company (standard) v1, mapping Company \
         (standard) v2."
    );

    // The earlier year is still on the first versions.
    let first = &fixture.year_ids[0];
    let layout = server
        .get_json(&format!("/api/years/{first}/layout"), &sam)
        .await;
    assert_eq!(layout["current"]["mapping_version"], 1);
}

#[tokio::test]
async fn a_year_whose_statements_wouldnt_build_cant_move() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let fixture = server.load_fixture(&boss, &sam).await;
    let year = fixture.year_ids.last().unwrap().clone();
    let practice = server.get_json("/api/practice", &boss).await;
    let (_, mapping_id) = company_defaults(&practice);
    let mut mapping: Value = serde_json::from_str(MAPPING).unwrap();
    mapping["ranges"]
        .as_array_mut()
        .unwrap()
        .retain(|r| r["line"] != "sales");
    server
        .ok(
            &boss,
            "revise_mapping",
            json!({ "mapping_id": mapping_id, "body": mapping }),
        )
        .await;

    let layout = server
        .get_json(&format!("/api/years/{year}/layout"), &sam)
        .await;
    assert_eq!(layout["changes"], json!([]));
    assert_eq!(layout["problems"][0]["code"], "unmapped");
    assert_eq!(layout["problems"][0]["account"], "100");
    let body = refused(
        &server,
        &sam,
        "move_year_layout",
        json!({ "client_year_id": year }),
    )
    .await;
    assert_eq!(body["code"], "report_failed");

    // Nor onto a mapping for another entity type.
    server
        .ok(
            &boss,
            "install_starter_set",
            json!({ "set": "sole_trader" }),
        )
        .await;
    let practice = server.get_json("/api/practice", &boss).await;
    let sole = practice["mappings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["entity_type"] == "sole_trader")
        .unwrap()["id"]
        .clone();
    let body = refused(
        &server,
        &sam,
        "move_year_layout",
        json!({ "client_year_id": year, "mapping_id": sole }),
    )
    .await;
    assert_eq!(body["code"], "wrong_entity_type");
}
