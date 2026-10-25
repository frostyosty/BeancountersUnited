//! Starter sets (`install_starter_set`) and editing master charts: a new practice can create
//! clients without hand-loading JSON, and changing a master chart never reaches back into the
//! clients already copied from it.

mod common;

use acct_store::log;
use axum::http::StatusCode;
use common::Server;
use serde_json::{Value, json};

async fn head(server: &Server) -> i64 {
    let mut conn = server.state.store.reader().await.unwrap();
    log::head_seq(&mut conn).await.unwrap()
}

fn account<'a>(chart: &'a Value, code: &str) -> Option<&'a Value> {
    chart.as_array().unwrap().iter().find(|a| a["code"] == code)
}

fn master<'a>(practice: &'a Value, entity_type: &str) -> &'a Value {
    practice["master_charts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["entity_type"] == entity_type)
        .unwrap_or_else(|| panic!("no {entity_type} master chart"))
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

#[tokio::test]
async fn a_starter_set_sets_up_an_entity_type_in_one_command() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;

    // Staff can't install one: it's a practice default.
    let (status, _) = server
        .command(&sam, "install_starter_set", json!({ "set": "company" }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let before = head(&server).await;
    let chart_id = server
        .ok(&boss, "install_starter_set", json!({ "set": "company" }))
        .await;
    assert_eq!(head(&server).await, before + 1, "one command, one entry");

    let practice = server.get_json("/api/practice", &boss).await;
    let chart = master(&practice, "company");
    assert_eq!(chart["id"], chart_id.as_str());
    assert_eq!(chart["name"], "Company");
    assert_eq!(chart["accounts"].as_array().unwrap().len(), 28);
    assert_eq!(practice["templates"][0]["name"], "Company (standard)");
    assert_eq!(practice["mappings"][0]["name"], "Company (standard)");
    let classes = server.get_json("/api/asset-classes", &boss).await;
    assert_eq!(classes.as_array().unwrap().len(), 2);

    // Staff can now set up a client and its first year, which pins the new mapping.
    let client = server
        .ok(
            &sam,
            "create_client",
            json!({ "name": "Kahu Ltd", "entity_type": "company",
                    "retained_earnings": "960", "rounding_priority": [] }),
        )
        .await;
    server
        .ok(
            &sam,
            "create_client_year",
            json!({ "client_id": client, "start": "2025-04-01", "end": "2026-03-31" }),
        )
        .await;

    // It reads as one change in the history.
    let history = server.get_json("/api/history", &boss).await;
    let entry = history["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["kind"] == "install_starter_set")
        .unwrap();
    assert_eq!(
        entry["description"],
        "Bo Boss installed the company starter set: a master chart, statement template, mapping \
         and asset classes."
    );

    // Defaults never reach back: it can't go on again over what's there.
    let body = refused(
        &server,
        &boss,
        "install_starter_set",
        json!({ "set": "company" }),
    )
    .await;
    assert_eq!(body["code"], "starter_set_installed");
}

#[tokio::test]
async fn a_starter_set_wont_merge_into_defaults_already_there() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let template: Value = serde_json::from_str(include_str!(
        "../../../fixtures/practice/sole-trader-template.json"
    ))
    .unwrap();
    server
        .ok(
            &boss,
            "create_template",
            json!({ "entity_type": "sole_trader", "name": "Ours", "body": template }),
        )
        .await;
    let body = refused(
        &server,
        &boss,
        "install_starter_set",
        json!({ "set": "sole_trader" }),
    )
    .await;
    assert_eq!(body["code"], "starter_set_installed");
    assert_eq!(body["details"][0]["code"], "templates_exist");
    let practice = server.get_json("/api/practice", &boss).await;
    assert_eq!(practice["master_charts"], json!([]));
}

#[tokio::test]
async fn editing_a_master_chart_reaches_new_clients_only() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    server
        .ok(
            &boss,
            "install_starter_set",
            json!({ "set": "sole_trader" }),
        )
        .await;
    let before = server
        .ok(
            &sam,
            "set_up_business",
            json!({ "name": "Kōwhai Gardens", "start_date": "2025-04-01" }),
        )
        .await;

    let st = |extra: Value| {
        let mut payload = json!({ "entity_type": "sole_trader" });
        payload
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        payload
    };
    for (kind, extra) in [
        (
            "add_master_account",
            json!({ "account": { "code": "299", "name": " Koha ",
                                 "account_type": "expense", "active": true } }),
        ),
        (
            "rename_master_account",
            json!({ "code": "204", "name": "Marketing" }),
        ),
        (
            "set_master_account_gst",
            json!({ "code": "290", "default_gst": "exempt" }),
        ),
        (
            "set_master_account_active",
            json!({ "code": "275", "active": false }),
        ),
    ] {
        let (status, body) = server.command(&boss, kind, st(extra)).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {body}");
    }

    // Staff can't edit the master chart.
    let (status, _) = server
        .command(
            &sam,
            "rename_master_account",
            st(json!({ "code": "204", "name": "Ads" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let practice = server.get_json("/api/practice", &boss).await;
    let chart = &master(&practice, "sole_trader")["accounts"];
    assert_eq!(account(chart, "299").unwrap()["name"], "Koha");
    assert_eq!(account(chart, "204").unwrap()["name"], "Marketing");
    assert_eq!(account(chart, "290").unwrap()["default_gst"], "exempt");
    assert_eq!(account(chart, "275").unwrap()["active"], false);

    // The business set up before keeps its copy as it was.
    let old = server
        .get_json(&format!("/api/clients/{before}/chart"), &sam)
        .await;
    assert!(account(&old, "299").is_none());
    assert_eq!(
        account(&old, "204").unwrap()["name"],
        "Advertising and marketing"
    );
    assert_eq!(account(&old, "290").unwrap()["default_gst"], "standard");
    assert_eq!(account(&old, "275").unwrap()["active"], true);

    // One set up after gets the edited chart.
    let after = server
        .ok(
            &sam,
            "set_up_business",
            json!({ "name": "Rimu Plumbing", "start_date": "2025-04-01" }),
        )
        .await;
    let new = server
        .get_json(&format!("/api/clients/{after}/chart"), &sam)
        .await;
    assert_eq!(account(&new, "299").unwrap()["name"], "Koha");
    assert_eq!(account(&new, "204").unwrap()["name"], "Marketing");
    assert_eq!(account(&new, "275").unwrap()["active"], false);

    let history = server.get_json("/api/history", &boss).await;
    let said: Vec<&str> = history["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["description"].as_str().unwrap())
        .collect();
    assert!(
        said.contains(
            &"Bo Boss renamed account 204 in the sole trader master chart from “Advertising and \
              marketing” to “Marketing”."
        ),
        "{said:?}"
    );
}

#[tokio::test]
async fn a_master_chart_edit_that_would_break_a_default_is_refused() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    server
        .ok(
            &boss,
            "install_starter_set",
            json!({ "set": "sole_trader" }),
        )
        .await;
    let st = |code: &str| json!({ "entity_type": "sole_trader", "code": code, "active": false });

    // An asset class's cost account.
    let body = refused(&server, &boss, "set_master_account_active", st("700")).await;
    assert_eq!(body["code"], "account_in_use");
    assert_eq!(body["details"][0]["asset_class"], "Tools and equipment");

    // A merchant entry's category.
    server
        .ok(
            &boss,
            "add_merchant",
            json!({ "entity_type": "sole_trader", "description_contains": "Z ENERGY",
                    "coding": { "direction": "out", "kind": "expense",
                                "account": "225", "gst": "standard" } }),
        )
        .await;
    let body = refused(&server, &boss, "set_master_account_active", st("225")).await;
    assert_eq!(body["details"][0]["merchant"], "Z ENERGY");

    // An account setting up a business needs.
    let body = refused(&server, &boss, "set_master_account_active", st("970")).await;
    assert_eq!(body["code"], "master_chart_incomplete");

    // A code already in the chart, and a chart that isn't there.
    let body = refused(
        &server,
        &boss,
        "add_master_account",
        json!({ "entity_type": "sole_trader",
                "account": { "code": "100", "name": "X", "account_type": "income", "active": true } }),
    )
    .await;
    assert_eq!(body["code"], "duplicate_account");
    let body = refused(
        &server,
        &boss,
        "set_master_account_gst",
        json!({ "entity_type": "sole_trader", "code": "950", "default_gst": "standard" }),
    )
    .await;
    assert_eq!(body["code"], "gst_on_balance_sheet");
    let (status, _) = server
        .command(
            &boss,
            "rename_master_account",
            json!({ "entity_type": "trust", "code": "100", "name": "X" }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
