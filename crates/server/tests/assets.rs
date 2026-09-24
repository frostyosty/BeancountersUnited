//! The asset register over HTTP: classes and overrides, the register commands, the depreciation
//! run, disposals, finalised years, and PLAN.md M4's "Done when".

mod common;

use axum::http::StatusCode;
use common::{LoadedFixture, Server};
use serde_json::{Value, json};

/// Row counts of the tables asset commands write, so a rejection can be shown to write nothing.
async fn counts(server: &Server) -> Vec<i64> {
    let mut r = server.state.store.reader().await.unwrap();
    let mut out = Vec::new();
    for sql in [
        "SELECT COUNT(*) FROM command_log",
        "SELECT COUNT(*) FROM asset_classes",
        "SELECT COUNT(*) FROM client_asset_classes",
        "SELECT COUNT(*) FROM assets",
        "SELECT COUNT(*) FROM asset_charges",
        "SELECT COUNT(*) FROM journals",
        "SELECT COUNT(*) FROM journal_lines",
    ] {
        let (n,): (i64,) = acct_store::sqlx::query_as(sql)
            .fetch_one(&mut *r)
            .await
            .unwrap();
        out.push(n);
    }
    out
}

fn lines(journal: &Value) -> Vec<(String, i64)> {
    journal["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["account"].as_str().unwrap().to_owned(),
                l["amount"].as_i64().unwrap(),
            )
        })
        .collect()
}

fn pairs(v: &[(&str, i64)]) -> Vec<(String, i64)> {
    v.iter().map(|(a, n)| ((*a).to_owned(), *n)).collect()
}

async fn year_assets(server: &Server, cookie: &str, year_id: &str) -> Value {
    server
        .get_json(&format!("/api/years/{year_id}/assets"), cookie)
        .await
}

async fn fixture() -> (Server, String, String, LoadedFixture) {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let f = server.load_fixture(&boss, &sam).await;
    (server, boss, sam, f)
}

fn class_id<'a>(f: &'a LoadedFixture, key: &str) -> &'a str {
    &f.class_ids.iter().find(|(k, _)| k == key).unwrap().1
}

async fn rejected(
    server: &Server,
    cookie: &str,
    kind: &str,
    payload: Value,
) -> (StatusCode, Value) {
    let before = counts(server).await;
    let (status, body) = server.command(cookie, kind, payload).await;
    assert_ne!(status, StatusCode::OK, "{kind} was accepted: {body}");
    assert_eq!(counts(server).await, before, "{kind} left partial writes");
    (status, body)
}

/// PLAN.md M4 "Done when": the fixture's assets produce a schedule and a depreciation journal
/// that reconcile to the balance sheet.
#[tokio::test]
async fn m4_is_done() {
    let (server, boss, sam, f) = fixture().await;
    for year_id in &f.year_ids {
        let view = year_assets(&server, &sam, year_id).await;
        assert_eq!(view["status"], "current");
        for line in view["reconciliation"].as_array().unwrap() {
            assert_eq!(line["register"], line["ledger"], "{line}");
        }
    }
    let view = year_assets(&server, &sam, &f.year_ids[1]).await;
    let journals = view["journals"].as_array().unwrap();
    assert_eq!(journals.len(), 1);
    assert_eq!(
        lines(&journals[0]),
        pairs(&[("210", 728_461), ("705", -235_869), ("715", -492_592)])
    );

    let report = server
        .get_json(&format!("/api/years/{}/report", f.year_ids[1]), &boss)
        .await;
    let total = report["asset_schedule"]["blocks"]
        .as_array()
        .unwrap()
        .last()
        .unwrap();
    let row = |key: &str| {
        total["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["key"] == key)
            .unwrap()["current"]
            .clone()
    };
    let line = |key: &str| {
        report["statements"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|s| s["rows"].as_array().unwrap())
            .find(|r| r["key"] == key)
            .unwrap()["current"]
            .clone()
    };
    assert_eq!(row("book_value"), line("ppe"));
    assert_eq!(row("depreciation"), line("depreciation"));

    // Running again posts nothing.
    let before = counts(&server).await;
    let (status, _) = server
        .command(
            &sam,
            "run_depreciation",
            json!({ "client_year_id": f.year_ids[1] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let after = counts(&server).await;
    assert_eq!(after[0], before[0] + 1, "the run is logged");
    assert_eq!(after[5..], before[5..], "but posts no journals");
}

#[tokio::test]
async fn roles_and_rejections_leave_nothing_behind() {
    let (server, boss, sam, f) = fixture().await;
    let val = server.login("val").await;
    let plant = class_id(&f, "plant").to_owned();
    let asset = json!({
        "client_id": f.client_id,
        "class_id": plant,
        "name": "Forklift",
        "cost": 1_000_000,
        "residual": 0,
        "acquired": "2025-06-01",
    });
    let (status, _) = rejected(&server, &val, "create_asset", asset.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let class = json!({
        "entity_type": "company",
        "key": "tools",
        "name": "Tools",
        "settings": {
            "method": { "kind": "dv", "rate_bp": 3000 },
            "part_year": { "kind": "full_year" },
            "disposal_year": "none",
        },
        "accounts": { "cost": "700", "accumulated": "705", "expense": "210", "gain_loss": "250" },
    });
    let (status, _) = rejected(&server, &sam, "create_asset_class", class.clone()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // Wrong account types, and a duplicate key.
    let mut bad = class.clone();
    bad["accounts"]["expense"] = json!("700");
    let (_, body) = rejected(&server, &boss, "create_asset_class", bad).await;
    assert_eq!(body["code"], "invalid_asset_accounts");
    let mut dup = class.clone();
    dup["key"] = json!("plant");
    let (_, body) = rejected(&server, &boss, "create_asset_class", dup).await;
    assert_eq!(body["code"], "asset_class_exists");

    // A bad rate, a residual above cost, and an asset from before the first year with no
    // brought-forward balance.
    let mut a = asset.clone();
    a["settings"] = json!({
        "method": { "kind": "dv", "rate_bp": 0 },
        "part_year": { "kind": "full_year" },
        "disposal_year": "none",
    });
    let (_, body) = rejected(&server, &sam, "create_asset", a).await;
    assert_eq!(body["code"], "invalid_asset");
    let mut a = asset.clone();
    a["residual"] = json!(2_000_000);
    rejected(&server, &sam, "create_asset", a).await;
    let mut a = asset.clone();
    a["acquired"] = json!("2020-01-01");
    let (_, body) = rejected(&server, &sam, "create_asset", a.clone()).await;
    assert_eq!(body["details"][0]["code"], "needs_opening_balance");
    a["opening"] = json!({ "date": "2024-04-01", "accumulated": 400_000 });
    server.ok(&sam, "create_asset", a).await;

    // Disposing into a year the client doesn't have.
    let (_, body) = rejected(
        &server,
        &sam,
        "dispose_asset",
        json!({
            "asset_id": f.asset_ids[0],
            "disposal": { "date": "2030-01-01", "proceeds": 0, "proceeds_account": "600" },
        }),
    )
    .await;
    assert_eq!(body["code"], "no_year_for_date");
}

#[tokio::test]
async fn edits_go_stale_until_the_run_reposts() {
    let (server, _, sam, f) = fixture().await;
    let y2 = &f.year_ids[1];
    // The van at a custom 30%.
    let (status, body) = server
        .command(
            &sam,
            "update_asset",
            json!({
                "asset_id": f.asset_ids[1],
                "name": "Delivery van",
                "cost": 2_345_678,
                "residual": 0,
                "acquired": "2025-04-20",
                "settings": {
                    "method": { "kind": "dv", "rate_bp": 3000 },
                    "part_year": { "kind": "months_held", "count_acquisition_month": true },
                    "disposal_year": "to_disposal_date",
                },
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let view = year_assets(&server, &sam, y2).await;
    assert_eq!(view["status"], "stale");
    let van = &view["assets"][1];
    assert_eq!(van["asset"]["rate_source"], "custom");
    // 23,456.78 × 30% = 7,037.03.
    assert_eq!(van["movements"]["depreciation"], 703_703);

    let before = counts(&server).await;
    let (status, _) = server
        .command(&sam, "run_depreciation", json!({ "client_year_id": y2 }))
        .await;
    assert_eq!(status, StatusCode::OK);
    // One reversal and one new journal.
    assert_eq!(counts(&server).await[5], before[5] + 2);
    let view = year_assets(&server, &sam, y2).await;
    assert_eq!(view["status"], "current");
    for line in view["reconciliation"].as_array().unwrap() {
        assert_eq!(line["register"], line["ledger"], "{line}");
    }

    // Leaving `settings` out goes back to the class's defaults.
    let (status, _) = server
        .command(
            &sam,
            "update_asset",
            json!({
                "asset_id": f.asset_ids[1],
                "name": "Delivery van",
                "cost": 2_345_678,
                "residual": 0,
                "acquired": "2025-04-20",
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let view = year_assets(&server, &sam, y2).await;
    assert_eq!(view["assets"][1]["asset"]["rate_source"], "practice");
    assert_eq!(view["assets"][1]["movements"]["depreciation"], 492_592);
}

#[tokio::test]
async fn disposal_posts_its_journal_and_reinstating_undoes_it() {
    let (server, _, sam, f) = fixture().await;
    let y2 = &f.year_ids[1];
    let (status, body) = server
        .command(
            &sam,
            "dispose_asset",
            json!({
                "asset_id": f.asset_ids[1],
                "disposal": { "date": "2026-01-31", "proceeds": 2_000_000, "proceeds_account": "600" },
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Apr..Jan is 10 months: 23,456.78 × 21% × 10/12 = 4,104.94. Book value 19,351.84, so
    // proceeds of 20,000 give a gain of 648.16.
    let view = year_assets(&server, &sam, y2).await;
    assert_eq!(view["status"], "current");
    let van = &view["assets"][1]["movements"];
    assert_eq!(van["depreciation"], 410_494);
    assert_eq!(van["gain"], 64_816);
    let journals = view["journals"].as_array().unwrap();
    assert_eq!(
        lines(&journals[0]),
        pairs(&[
            ("210", 235_869 + 410_494),
            ("705", -235_869),
            ("715", -410_494)
        ])
    );
    assert_eq!(journals[1]["narration"], "Disposal of Delivery van");
    assert_eq!(
        lines(&journals[1]),
        pairs(&[
            ("250", -64_816),
            ("600", 2_000_000),
            ("710", -2_345_678),
            ("715", 410_494)
        ])
    );
    for line in view["reconciliation"].as_array().unwrap() {
        assert_eq!(line["register"], line["ledger"], "{line}");
    }
    let posted = server
        .get_json(&format!("/api/years/{y2}/journals"), &sam)
        .await;
    let kinds: Vec<&str> = posted
        .as_array()
        .unwrap()
        .iter()
        .map(|j| j["kind"].as_str().unwrap())
        .filter(|k| *k != "manual")
        .collect();
    assert_eq!(
        kinds,
        [
            "depreciation",
            "depreciation",
            "depreciation",
            "asset_disposal"
        ]
    );

    // A second disposal is refused; reinstating puts the year back as it was.
    let (_, body) = rejected(
        &server,
        &sam,
        "dispose_asset",
        json!({
            "asset_id": f.asset_ids[1],
            "disposal": { "date": "2026-02-28", "proceeds": 0, "proceeds_account": "600" },
        }),
    )
    .await;
    assert_eq!(body["code"], "already_disposed");
    let (status, _) = server
        .command(
            &sam,
            "reinstate_asset",
            json!({ "asset_id": f.asset_ids[1] }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let view = year_assets(&server, &sam, y2).await;
    assert_eq!(view["status"], "current");
    assert_eq!(view["journals"].as_array().unwrap().len(), 1);
    assert_eq!(view["assets"][1]["movements"]["depreciation"], 492_592);
}

#[tokio::test]
async fn a_finalised_year_fixes_cost_and_keeps_its_charges() {
    let (server, _, sam, f) = fixture().await;
    // Finalising arrives in M5; set FY2025's status directly, as m2_done does.
    {
        let mut w = server.state.store.writer().await;
        acct_store::sqlx::query("UPDATE client_years SET status = 'finalised' WHERE id = ?")
            .bind(&f.year_ids[0])
            .execute(&mut *w)
            .await
            .unwrap();
    }
    let plant = |cost: i64, rate_bp: i64| {
        json!({
            "asset_id": f.asset_ids[0],
            "name": "Packing machine",
            "cost": cost,
            "residual": 0,
            "acquired": "2024-04-05",
            "settings": {
                "method": { "kind": "dv", "rate_bp": rate_bp },
                "part_year": { "kind": "months_held", "count_acquisition_month": true },
                "disposal_year": "to_disposal_date",
            },
        })
    };
    let (_, body) = rejected(&server, &sam, "update_asset", plant(1_900_000, 1500)).await;
    assert_eq!(body["code"], "asset_fixed");
    let (_, body) = rejected(
        &server,
        &sam,
        "delete_asset",
        json!({ "asset_id": f.asset_ids[0] }),
    )
    .await;
    assert_eq!(body["code"], "asset_fixed");

    // A new rate applies from the first open year: FY2025 keeps its 2,774.93, and FY2026 is 20%
    // of 15,724.57 = 3,144.91.
    let (status, body) = server
        .command(&sam, "update_asset", plant(1_849_950, 2000))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let y1 = year_assets(&server, &sam, &f.year_ids[0]).await;
    assert_eq!(y1["status"], "finalised");
    assert_eq!(y1["assets"][0]["movements"]["depreciation"], 277_493);
    assert_eq!(y1["assets"][0]["asset"]["fixed"], true);
    let y2 = year_assets(&server, &sam, &f.year_ids[1]).await;
    assert_eq!(y2["status"], "stale");
    assert_eq!(y2["assets"][0]["movements"]["depreciation"], 314_491);

    // Disposing in the finalised year is refused.
    let (_, body) = rejected(
        &server,
        &sam,
        "dispose_asset",
        json!({
            "asset_id": f.asset_ids[0],
            "disposal": { "date": "2025-01-31", "proceeds": 0, "proceeds_account": "600" },
        }),
    )
    .await;
    assert_eq!(body["code"], "year_finalised");
}

#[tokio::test]
async fn defaults_cascade_and_pushing_a_new_default_is_explicit() {
    let (server, boss, sam, f) = fixture().await;
    let plant = class_id(&f, "plant").to_owned();
    let settings = |rate_bp: i64| {
        json!({
            "method": { "kind": "dv", "rate_bp": rate_bp },
            "part_year": { "kind": "months_held", "count_acquisition_month": true },
            "disposal_year": "to_disposal_date",
        })
    };
    let accounts =
        json!({ "cost": "700", "accumulated": "705", "expense": "210", "gain_loss": "250" });

    // The master changes the practice default. Existing assets don't move.
    let (status, body) = server
        .command(
            &boss,
            "update_asset_class",
            json!({
                "class_id": plant,
                "name": "Plant and equipment",
                "settings": settings(1800),
                "accounts": accounts,
            }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let y2 = year_assets(&server, &sam, &f.year_ids[1]).await;
    assert_eq!(y2["status"], "current");
    assert_eq!(y2["assets"][0]["asset"]["settings"], settings(1500));

    // Pushing it: the preview names the asset, and applying changes it.
    let preview = server
        .get_json(
            &format!(
                "/api/clients/{}/asset-classes/{plant}/apply-preview",
                f.client_id
            ),
            &sam,
        )
        .await;
    assert_eq!(preview.as_array().unwrap().len(), 1);
    assert_eq!(preview[0]["settings_from"], settings(1500));
    assert_eq!(preview[0]["settings_to"], settings(1800));
    let (status, _) = server
        .command(
            &sam,
            "apply_asset_class_defaults",
            json!({ "client_id": f.client_id, "class_id": plant }),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let y2 = year_assets(&server, &sam, &f.year_ids[1]).await;
    assert_eq!(y2["status"], "stale");
    assert_eq!(y2["assets"][0]["asset"]["settings"], settings(1800));

    // A client override (staff may set one) is the default for new assets, as `client`; a
    // different rate on the asset itself makes it `custom`.
    let (status, body) = server
        .command(
            &sam,
            "set_client_asset_class",
            json!({ "client_id": f.client_id, "class_id": plant, "settings": settings(2500) }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let classes = server
        .get_json(&format!("/api/clients/{}/asset-classes", f.client_id), &sam)
        .await;
    let view = classes
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["class"]["id"] == plant.as_str())
        .unwrap();
    assert_eq!(view["resolved"]["source"], "client");
    assert_eq!(view["resolved"]["settings"], settings(2500));
    let new_asset = |settings: Option<Value>| {
        let mut a = json!({
            "client_id": f.client_id,
            "class_id": plant,
            "name": "Forklift",
            "cost": 1_000_000,
            "residual": 0,
            "acquired": "2025-06-01",
        });
        if let Some(s) = settings {
            a["settings"] = s;
        }
        a
    };
    server.ok(&sam, "create_asset", new_asset(None)).await;
    server
        .ok(&sam, "create_asset", new_asset(Some(settings(4000))))
        .await;
    server
        .ok(&sam, "create_asset", new_asset(Some(settings(2500))))
        .await;
    let register = year_assets(&server, &sam, &f.year_ids[1]).await;
    let sources: Vec<&str> = register["assets"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["asset"]["name"] == "Forklift")
        .map(|a| a["asset"]["rate_source"].as_str().unwrap())
        .collect();
    assert_eq!(sources, ["client", "custom", "client"]);
}
