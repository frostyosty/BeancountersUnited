//! M15's accounting policies and notes: the practice paragraph library, each year's own copies,
//! the push onto open years, and the notes in the ReportDoc. Every command is also checked for
//! rejection.

mod common;

use axum::http::StatusCode;
use common::Server;
use serde_json::{Value, json};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const PRIORITY: &str =
    include_str!("../../../fixtures/practice/sole-trader-rounding-priority.json");
const PARAGRAPHS: &str = include_str!("../../../fixtures/practice/paragraphs.json");

struct Setup {
    server: Server,
    boss: String,
    sam: String,
    val: String,
    /// The library's paragraph ids, by key.
    ids: Vec<(String, String)>,
    client: String,
}

impl Setup {
    fn id(&self, key: &str) -> &str {
        &self.ids.iter().find(|(k, _)| k == key).unwrap().1
    }

    async fn refused(&self, cookie: &str, kind: &str, payload: Value) -> (StatusCode, Value) {
        let (status, body) = self.server.command(cookie, kind, payload).await;
        assert_ne!(status, StatusCode::OK, "{kind} was accepted: {body}");
        (status, body)
    }

    async fn notes(&self, year: &str) -> Vec<Value> {
        self.server
            .get_json(&format!("/api/years/{year}/notes"), &self.sam)
            .await
            .as_array()
            .unwrap()
            .clone()
    }

    async fn year(&self, start: &str, end: &str) -> String {
        self.server
            .ok(
                &self.sam,
                "create_client_year",
                json!({ "client_id": self.client, "start": start, "end": end }),
            )
            .await
    }
}

/// The sole-trader defaults and the starter library (as the practice admin), a 25% DV tools
/// class, and a sole-trader client (as staff) with no years yet.
async fn setup() -> Setup {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let val = server.login("val").await;
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
    server
        .ok(
            &boss,
            "create_asset_class",
            json!({
                "entity_type": "sole_trader",
                "key": "tools",
                "name": "Tools and equipment",
                "settings": {
                    "method": { "kind": "dv", "rate_bp": 2500 },
                    "part_year": { "kind": "months_held", "count_acquisition_month": true },
                    "disposal_year": "to_disposal_date",
                },
                "accounts": { "cost": "700", "accumulated": "705", "expense": "210", "gain_loss": "250" },
            }),
        )
        .await;
    let mut ids = Vec::new();
    let set: Vec<Value> = serde_json::from_str(PARAGRAPHS).unwrap();
    for paragraph in set {
        let id = server
            .ok(
                &boss,
                "add_paragraph",
                json!({ "entity_type": "sole_trader", "paragraph": paragraph }),
            )
            .await;
        ids.push((paragraph["key"].as_str().unwrap().to_owned(), id));
    }
    let priority: Value = serde_json::from_str(PRIORITY).unwrap();
    let client = server
        .ok(
            &sam,
            "create_client",
            json!({
                "name": "Marsh Hollow Carpentry",
                "entity_type": "sole_trader",
                "retained_earnings": "970",
                "rounding_priority": priority,
            }),
        )
        .await;
    Setup {
        server,
        boss,
        sam,
        val,
        ids,
        client,
    }
}

fn keys(notes: &[Value]) -> Vec<&str> {
    notes
        .iter()
        .map(|n| n["paragraph"]["key"].as_str().unwrap())
        .collect()
}

fn version(notes: &[Value], key: &str) -> (i64, i64, bool) {
    let n = notes.iter().find(|n| n["paragraph"]["key"] == key).unwrap();
    (
        n["from_version"].as_i64().unwrap(),
        n["latest_version"].as_i64().unwrap(),
        n["edited"].as_bool().unwrap(),
    )
}

#[tokio::test]
async fn notes_are_copied_filled_in_and_pushed_only_onto_open_unedited_years() {
    let s = setup().await;
    let library = s
        .server
        .get_json("/api/paragraph-library/sole_trader", &s.val)
        .await;
    assert_eq!(library.as_array().unwrap().len(), 8);

    // FY2025 picks its notes; FY2026, added after it, starts with copies of them.
    let fy25 = s.year("2024-04-01", "2025-03-31").await;
    let picked = [
        "basis_of_preparation",
        "gst_registered",
        "depreciation",
        "going_concern",
        "income_tax",
    ];
    let ids: Vec<&str> = picked.iter().map(|k| s.id(k)).collect();
    s.server
        .done(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy25, "paragraph_ids": ids }),
        )
        .await;
    assert_eq!(keys(&s.notes(&fy25).await), picked);
    let fy26 = s.year("2025-04-01", "2026-03-31").await;
    assert_eq!(keys(&s.notes(&fy26).await), picked);

    // An asset held in both years, so the depreciation policy has something to say.
    s.server
        .ok(
            &s.sam,
            "post_journal",
            json!({
                "client_year_id": fy25,
                "date": "2024-06-01",
                "narration": "Saw bench",
                "lines": [
                    { "account": "700", "amount": 400_000 },
                    { "account": "950", "amount": -400_000 },
                ],
            }),
        )
        .await;
    let classes = s
        .server
        .get_json(&format!("/api/clients/{}/asset-classes", s.client), &s.sam)
        .await;
    let class_id = classes[0]["class"]["id"].as_str().unwrap().to_owned();
    s.server
        .ok(
            &s.sam,
            "create_asset",
            json!({
                "client_id": s.client,
                "class_id": class_id,
                "name": "Saw bench",
                "cost": 400_000,
                "residual": 0,
                "acquired": "2024-06-01",
            }),
        )
        .await;
    let (status, body) = s
        .server
        .command(
            &s.sam,
            "run_depreciation",
            json!({ "client_year_id": fy26 }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // The notes follow the statements, filled in for each year.
    let report = s
        .server
        .get_json(&format!("/api/years/{fy26}/report"), &s.sam)
        .await;
    let notes = report["notes"].as_array().unwrap();
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert_eq!(notes[0]["number"], 1);
    assert_eq!(notes[0]["title"], "Statement of accounting policies");
    let sections: Vec<&str> = notes[0]["sections"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["title"].as_str().unwrap())
        .collect();
    assert_eq!(
        sections,
        [
            "Basis of preparation",
            "Goods and services tax (GST)",
            "Depreciation",
            "Going concern"
        ]
    );
    assert_eq!(
        notes[0]["sections"][0]["text"][0],
        "These are special purpose financial statements for Marsh Hollow Carpentry, a business \
         owned by one person. They cover the period from 1 April 2025 to 31 March 2026, and were \
         prepared for the owner and to support the owner's income tax return. They are not \
         general purpose financial statements."
    );
    assert_eq!(
        notes[0]["sections"][2]["text"][0],
        "Fixed assets are shown at cost less accumulated depreciation. Depreciation is charged \
         at these rates:\nTools and equipment: 25% diminishing value"
    );
    assert_eq!(
        (notes[1]["number"].clone(), notes[1]["title"].clone()),
        (json!(2), json!("Income tax"))
    );
    assert!(notes[1]["sections"][0]["title"].is_null());

    // FY2026 edits its basis of preparation; then FY2025 is signed off.
    s.server
        .done(
            &s.sam,
            "edit_note",
            json!({
                "client_year_id": fy26,
                "paragraph_id": s.id("basis_of_preparation"),
                "title": "Basis of preparation",
                "body": "Prepared for {business_name}'s owner, to {balance_date}.",
            }),
        )
        .await;
    assert_eq!(
        version(&s.notes(&fy26).await, "basis_of_preparation"),
        (1, 1, true)
    );
    let (status, body) = s
        .server
        .command(
            &s.boss,
            "finalise_year",
            json!({ "client_year_id": fy25, "accept_uncategorised": true }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let signed = s
        .server
        .get_json(&format!("/api/years/{fy25}/report"), &s.sam)
        .await;

    // The practice revises two paragraphs. No year's copy changes.
    for key in ["basis_of_preparation", "going_concern"] {
        s.server
            .done(
                &s.boss,
                "revise_paragraph",
                json!({
                    "paragraph_id": s.id(key),
                    "placement": "policy",
                    "title": "Revised",
                    "body": "Revised wording for {business_name}.",
                }),
            )
            .await;
    }
    for year in [&fy25, &fy26] {
        let notes = s.notes(year).await;
        assert_eq!(version(&notes, "going_concern"), (1, 2, false));
    }
    assert_eq!(
        s.server
            .get_json(&format!("/api/years/{fy25}/report"), &s.sam)
            .await["notes"],
        signed["notes"]
    );

    // The push previews only open years: FY2025 is finalised, and FY2026's edited basis stays.
    let preview = |key: &str| {
        let uri = format!("/api/paragraphs/{}/push-preview", s.id(key));
        let boss = s.boss.clone();
        let server = &s.server;
        async move { server.get_json(&uri, &boss).await }
    };
    let basis = preview("basis_of_preparation").await;
    assert_eq!(basis.as_array().unwrap().len(), 1, "{basis}");
    assert_eq!(basis[0]["client_year_id"], json!(fy26));
    assert_eq!(basis[0]["action"], "keep_edited");
    let going = preview("going_concern").await;
    assert_eq!(going.as_array().unwrap().len(), 1, "{going}");
    assert_eq!(
        (
            going[0]["client_year_id"].clone(),
            going[0]["action"].clone()
        ),
        (json!(fy26), json!("update"))
    );
    assert_eq!(
        (
            going[0]["from_version"].clone(),
            going[0]["to_version"].clone()
        ),
        (json!(1), json!(2))
    );

    for key in ["basis_of_preparation", "going_concern"] {
        s.server
            .done(
                &s.boss,
                "push_paragraph",
                json!({ "paragraph_id": s.id(key) }),
            )
            .await;
    }
    let fy26_notes = s.notes(&fy26).await;
    assert_eq!(version(&fy26_notes, "going_concern"), (2, 2, false));
    assert_eq!(version(&fy26_notes, "basis_of_preparation"), (1, 2, true));
    let fy25_notes = s.notes(&fy25).await;
    assert_eq!(version(&fy25_notes, "going_concern"), (1, 2, false));
    assert_eq!(version(&fy25_notes, "basis_of_preparation"), (1, 2, false));
    // Nothing left to push for going concern.
    assert!(
        preview("going_concern")
            .await
            .as_array()
            .unwrap()
            .is_empty()
    );
    let report = s
        .server
        .get_json(&format!("/api/years/{fy26}/report"), &s.sam)
        .await;
    let policies = &report["notes"][0]["sections"];
    assert_eq!(
        policies[0]["text"][0],
        "Prepared for Marsh Hollow Carpentry's owner, to 31 March 2026."
    );
    assert_eq!(policies[3]["title"], "Revised");
    assert_eq!(
        policies[3]["text"][0],
        "Revised wording for Marsh Hollow Carpentry."
    );

    // Re-picking keeps copies (and edits), reorders, and drops what's left off.
    let ids = [s.id("income_tax"), s.id("basis_of_preparation")];
    s.server
        .done(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy26, "paragraph_ids": ids }),
        )
        .await;
    let notes = s.notes(&fy26).await;
    assert_eq!(keys(&notes), ["income_tax", "basis_of_preparation"]);
    assert_eq!(version(&notes, "basis_of_preparation"), (1, 2, true));

    // Finalised years refuse note changes.
    let (_, body) = s
        .refused(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy25, "paragraph_ids": [] }),
        )
        .await;
    assert_eq!(body["code"], "year_finalised", "{body}");
    let (_, body) = s
        .refused(
            &s.sam,
            "edit_note",
            json!({
                "client_year_id": fy25,
                "paragraph_id": s.id("income_tax"),
                "title": "Income tax",
                "body": "Changed.",
            }),
        )
        .await;
    assert_eq!(body["code"], "year_finalised", "{body}");
}

#[tokio::test]
async fn a_field_with_nothing_to_fill_it_fails_the_report() {
    let s = setup().await;
    let year = s.year("2025-04-01", "2026-03-31").await;
    // No assets, so the depreciation policy has no rates to list.
    s.server
        .done(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": year, "paragraph_ids": [s.id("depreciation")] }),
        )
        .await;
    let (status, body) = common::split(
        s.server
            .send(common::get(
                &format!("/api/years/{year}/report"),
                Some(&s.sam),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "notes_failed", "{body}");
    assert_eq!(body["details"][0]["code"], "empty_field", "{body}");
    assert_eq!(
        body["details"][0]["field"], "depreciation_methods",
        "{body}"
    );
}

#[tokio::test]
async fn each_command_is_rejected_when_it_should_be() {
    let s = setup().await;
    let year = s.year("2025-04-01", "2026-03-31").await;
    let basis = s.id("basis_of_preparation").to_owned();

    // add_paragraph
    let new = |key: &str, body: &str| {
        json!({
            "entity_type": "sole_trader",
            "paragraph": { "key": key, "placement": "note", "title": "New", "body": body },
        })
    };
    let (_, body) = s
        .refused(
            &s.boss,
            "add_paragraph",
            new("new_note", "For {owner_name}."),
        )
        .await;
    assert_eq!(code(&body), "invalid_paragraph");
    assert_eq!(body["details"][0]["code"], "unknown_field", "{body}");
    assert_eq!(body["details"][0]["field"], "owner_name", "{body}");
    let (_, body) = s
        .refused(
            &s.boss,
            "add_paragraph",
            new("new_note", "A stray { brace."),
        )
        .await;
    assert_eq!(body["details"][0]["code"], "stray_brace", "{body}");
    let (_, body) = s
        .refused(&s.boss, "add_paragraph", new("going_concern", "Again."))
        .await;
    assert_eq!(code(&body), "paragraph_exists");
    let (status, _) = s
        .refused(&s.sam, "add_paragraph", new("staff_note", "Staff can't."))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s
        .refused(
            &s.boss,
            "add_paragraph",
            json!({
                "entity_type": "trust",
                "paragraph": { "key": "x", "placement": "note", "title": "X", "body": "X." },
            }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // revise_paragraph
    let revise = |id: &str, body: &str| json!({ "paragraph_id": id, "placement": "policy", "title": "Basis", "body": body });
    let (status, _) = s
        .refused(&s.boss, "revise_paragraph", revise("nope", "X."))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, body) = s
        .refused(&s.boss, "revise_paragraph", revise(&basis, "{nope}"))
        .await;
    assert_eq!(code(&body), "invalid_paragraph");
    let library = s
        .server
        .get_json("/api/paragraph-library/sole_trader", &s.boss)
        .await;
    let current = library
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == json!(basis))
        .unwrap()["paragraph"]
        .clone();
    let (_, body) = s
        .refused(
            &s.boss,
            "revise_paragraph",
            json!({
                "paragraph_id": basis,
                "placement": current["placement"],
                "title": current["title"],
                "body": current["body"],
            }),
        )
        .await;
    assert_eq!(code(&body), "paragraph_unchanged");
    let (status, _) = s
        .refused(&s.sam, "revise_paragraph", revise(&basis, "Staff can't."))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // pick_notes
    let pick = |ids: Vec<&str>| json!({ "client_year_id": year, "paragraph_ids": ids });
    let (_, body) = s
        .refused(&s.sam, "pick_notes", pick(vec![&basis, &basis]))
        .await;
    assert_eq!(code(&body), "duplicate_paragraph");
    let (status, _) = s.refused(&s.sam, "pick_notes", pick(vec!["nope"])).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (status, _) = s.refused(&s.val, "pick_notes", pick(vec![&basis])).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s
        .refused(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": "nope", "paragraph_ids": [] }),
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // A paragraph from another entity type's library.
    let company: Value = serde_json::from_str(common::CHART).unwrap();
    s.server
        .ok(
            &s.boss,
            "create_master_chart",
            json!({ "entity_type": "company", "name": "Company", "accounts": company }),
        )
        .await;
    let other = s
        .server
        .ok(
            &s.boss,
            "add_paragraph",
            json!({
                "entity_type": "company",
                "paragraph": { "key": "directors", "placement": "note", "title": "Directors", "body": "D." },
            }),
        )
        .await;
    let (_, body) = s.refused(&s.sam, "pick_notes", pick(vec![&other])).await;
    assert_eq!(code(&body), "wrong_entity_type");

    // edit_note
    let edit = |paragraph_id: &str, body: &str| {
        json!({
            "client_year_id": year,
            "paragraph_id": paragraph_id,
            "title": "Basis of preparation",
            "body": body,
        })
    };
    let (status, _) = s
        .refused(&s.sam, "edit_note", edit(&basis, "Not picked yet."))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    s.server
        .done(&s.sam, "pick_notes", pick(vec![&basis]))
        .await;
    let (_, body) = s
        .refused(&s.sam, "edit_note", edit(&basis, "For {owner_name}."))
        .await;
    assert_eq!(code(&body), "invalid_paragraph");
    let (status, _) = s
        .refused(&s.val, "edit_note", edit(&basis, "Viewers can't."))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let copy = &s.notes(&year).await[0]["paragraph"];
    let (_, body) = s
        .refused(
            &s.sam,
            "edit_note",
            json!({
                "client_year_id": year,
                "paragraph_id": basis,
                "title": copy["title"],
                "body": copy["body"],
            }),
        )
        .await;
    assert_eq!(code(&body), "note_unchanged");

    // push_paragraph
    let (status, _) = s
        .refused(&s.sam, "push_paragraph", json!({ "paragraph_id": basis }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s
        .refused(&s.boss, "push_paragraph", json!({ "paragraph_id": "nope" }))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    // Staff can't see the push preview either.
    let (status, _) = common::split(
        s.server
            .send(common::get(
                &format!("/api/paragraphs/{basis}/push-preview"),
                Some(&s.sam),
            ))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_removed_paragraph_leaves_the_library_but_years_keep_their_copies() {
    let s = setup().await;
    let going = s.id("going_concern").to_owned();
    let basis = s.id("basis_of_preparation").to_owned();
    let fy25 = s.year("2024-04-01", "2025-03-31").await;
    s.server
        .done(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy25, "paragraph_ids": [basis, going] }),
        )
        .await;

    // Only a practice admin can remove, and only something that's there.
    let remove = |id: &str| json!({ "paragraph_id": id });
    let (status, _) = s.refused(&s.sam, "remove_paragraph", remove(&going)).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = s.refused(&s.boss, "remove_paragraph", remove("nope")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    s.server
        .done(&s.boss, "remove_paragraph", remove(&going))
        .await;
    let (_, body) = s.refused(&s.boss, "remove_paragraph", remove(&going)).await;
    assert_eq!(code(&body), "paragraph_removed");

    // Gone from the library, but FY2025's copy stays, still in its report.
    let library = s
        .server
        .get_json("/api/paragraph-library/sole_trader", &s.val)
        .await;
    assert_eq!(library.as_array().unwrap().len(), 7);
    assert!(library.as_array().unwrap().iter().all(|p| p["id"] != going));
    let notes = s.notes(&fy25).await;
    assert_eq!(keys(&notes), ["basis_of_preparation", "going_concern"]);
    assert_eq!(notes[1]["removed"], true);
    assert_eq!(notes[0]["removed"], false);
    let report = s
        .server
        .get_json(&format!("/api/years/{fy25}/report"), &s.sam)
        .await;
    let policies = &report["notes"][0]["sections"];
    assert_eq!(policies[1]["key"], "going_concern");

    // FY2026 carries the copy forward, and a year can keep a copy it has (reordering is fine),
    let fy26 = s.year("2025-04-01", "2026-03-31").await;
    assert_eq!(
        keys(&s.notes(&fy26).await),
        ["basis_of_preparation", "going_concern"]
    );
    s.server
        .done(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy26, "paragraph_ids": [going, basis] }),
        )
        .await;
    // but once dropped it can't be picked again.
    s.server
        .done(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy26, "paragraph_ids": [basis] }),
        )
        .await;
    let (_, body) = s
        .refused(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy26, "paragraph_ids": [basis, going] }),
        )
        .await;
    assert_eq!(code(&body), "paragraph_removed");

    // It can't be revised or pushed.
    let (_, body) = s
        .refused(
            &s.boss,
            "revise_paragraph",
            json!({ "paragraph_id": going, "placement": "policy", "title": "Going concern",
                    "body": "Revised." }),
        )
        .await;
    assert_eq!(code(&body), "paragraph_removed");
    let (_, body) = s.refused(&s.boss, "push_paragraph", remove(&going)).await;
    assert_eq!(code(&body), "paragraph_removed");

    // Its key is free again. A year can't have the old copy and the new paragraph together.
    let again = s
        .server
        .ok(
            &s.boss,
            "add_paragraph",
            json!({
                "entity_type": "sole_trader",
                "paragraph": { "key": "going_concern", "placement": "policy",
                               "title": "Going concern", "body": "New wording." },
            }),
        )
        .await;
    let (_, body) = s
        .refused(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy25, "paragraph_ids": [basis, going, again] }),
        )
        .await;
    assert_eq!(code(&body), "duplicate_paragraph");
    s.server
        .done(
            &s.sam,
            "pick_notes",
            json!({ "client_year_id": fy25, "paragraph_ids": [basis, again] }),
        )
        .await;
    let notes = s.notes(&fy25).await;
    assert_eq!(notes[1]["paragraph"]["body"], "New wording.");
    assert_eq!(notes[1]["removed"], false);
}

fn code(body: &Value) -> String {
    body["code"].as_str().unwrap_or_default().to_owned()
}

trait Done {
    async fn done(&self, cookie: &str, kind: &str, payload: Value);
}

impl Done for Server {
    /// Submits a command that must succeed, whether or not it creates anything.
    async fn done(&self, cookie: &str, kind: &str, payload: Value) {
        let (status, body) = self.command(cookie, kind, payload).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {body}");
    }
}
