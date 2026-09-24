//! The query endpoints and sync feed, over HTTP, against the fixture company.

mod common;

use acct_core::ReportDoc;
use axum::http::StatusCode;
use common::{Server, get, split};
use serde_json::json;

const FY2025: &str = include_str!("../../core/tests/snapshots/fixture__fy2025_reportdoc.snap");
const FY2026: &str = include_str!("../../core/tests/snapshots/fixture__fy2026_reportdoc.snap");

/// The JSON body of an insta snapshot file (everything after its `---` header).
fn snapshot_body(snap: &str) -> &str {
    let rest = snap.strip_prefix("---\n").unwrap();
    let (_, body) = rest.split_once("\n---\n").unwrap();
    body.trim_end()
}

#[tokio::test]
async fn the_fixture_reports_match_the_m1_snapshots_byte_for_byte() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let f = server.load_fixture(&boss, &sam).await;

    // Without finalisation, FY2026's comparatives are live and marked unfinalised.
    let live = server
        .get_json(&format!("/api/years/{}/report", f.year_ids[1]), &boss)
        .await;
    assert_eq!(live["comparatives"], "unfinalised");

    // M1's snapshots show FY2026 with FY2025 finalised. There's no finalise command until M5,
    // so mark it finalised directly; FY2025's snapshot TB would equal its live TB anyway.
    {
        let mut w = server.state.store.writer().await;
        acct_store::sqlx::query("UPDATE client_years SET status = 'finalised' WHERE id = ?")
            .bind(&f.year_ids[0])
            .execute(&mut *w)
            .await
            .unwrap();
    }

    // Viewers can read reports too.
    let val = server.login("val").await;
    for (year_id, snap) in f.year_ids.iter().zip([FY2025, FY2026]) {
        let bytes = server
            .get_bytes(&format!("/api/years/{year_id}/report"), &val)
            .await;
        let doc: ReportDoc = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            serde_json::to_string_pretty(&doc).unwrap(),
            snapshot_body(snap)
        );
        // The wire bytes are the same document, serialised compactly.
        let expected: ReportDoc = serde_json::from_str(snapshot_body(snap)).unwrap();
        assert_eq!(bytes, serde_json::to_vec(&expected).unwrap());
    }
}

#[tokio::test]
async fn clients_years_charts_and_journals_read_back() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let f = server.load_fixture(&boss, &boss).await;

    let list = server.get_json("/api/clients", &boss).await;
    assert_eq!(
        list,
        json!([{ "id": f.client_id, "name": "Example Widgets Limited", "entity_type": "company" }])
    );

    let client = server
        .get_json(&format!("/api/clients/{}", f.client_id), &boss)
        .await;
    assert_eq!(client["retained_earnings"], "960");
    assert_eq!(client["rounding_priority"][0], "235");
    let years = client["years"].as_array().unwrap();
    assert_eq!(years.len(), 2);
    assert_eq!(years[0]["start"], "2024-04-01");
    assert_eq!(years[1]["end"], "2026-03-31");
    assert_eq!(years[1]["status"], "open");
    assert_eq!(years[1]["books_source"], json!(null));

    let year = server
        .get_json(&format!("/api/years/{}", f.year_ids[1]), &boss)
        .await;
    assert_eq!(year, years[1]);

    let chart = server
        .get_json(&format!("/api/clients/{}/chart", f.client_id), &boss)
        .await;
    let fixture_chart: serde_json::Value = serde_json::from_str(common::CHART).unwrap();
    assert_eq!(chart, fixture_chart);

    let journals = server
        .get_json(&format!("/api/years/{}/journals", f.year_ids[0]), &boss)
        .await;
    let client_fixture: serde_json::Value = serde_json::from_str(common::CLIENT).unwrap();
    let expected = client_fixture["years"][0]["journals"].as_array().unwrap();
    let journals = journals.as_array().unwrap();
    assert_eq!(journals.len(), expected.len());
    assert_eq!(journals[0]["narration"], expected[0]["narration"]);
    assert_eq!(journals[0]["lines"], expected[0]["lines"]);
    assert_eq!(journals[0]["kind"], "manual");
}

#[tokio::test]
async fn trial_balances_roll_forward_and_reversals_show() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let f = server.load_fixture(&boss, &boss).await;

    // Year 2 opens with year 1's profit of 26,884.95 in retained earnings (960), and no income
    // or expense balances.
    let tb = server
        .get_json(&format!("/api/years/{}/tb", f.year_ids[1]), &boss)
        .await;
    let opening = tb["opening"].as_array().unwrap();
    let re = opening.iter().find(|l| l["account"] == "960").unwrap();
    assert_eq!(re["balance"], -2_688_495);
    assert!(opening.iter().all(|l| l["account"] != "100"));
    let total: i64 = tb["closing"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| l["balance"].as_i64().unwrap())
        .sum();
    assert_eq!(total, 0);

    let journals = server
        .get_json(&format!("/api/years/{}/journals", f.year_ids[1]), &boss)
        .await;
    let first = journals[0]["id"].as_str().unwrap().to_owned();
    let reversal = server
        .ok(&boss, "reverse_journal", json!({ "journal_id": first }))
        .await;
    let journals = server
        .get_json(&format!("/api/years/{}/journals", f.year_ids[1]), &boss)
        .await;
    assert_eq!(journals[0]["reversed_by"], json!(reversal));
    let last = journals.as_array().unwrap().last().unwrap();
    assert_eq!(last["reverses_journal_id"], json!(first));
}

#[tokio::test]
async fn a_report_with_unmapped_accounts_says_which() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let f = server.load_fixture(&boss, &boss).await;
    // A mapping without the sales range, pinned to a new year.
    let mut mapping: serde_json::Value = serde_json::from_str(common::MAPPING).unwrap();
    mapping["ranges"].as_array_mut().unwrap().remove(0);
    let mut r = server.state.store.reader().await.unwrap();
    let (mapping_id,): (String,) = acct_store::sqlx::query_as("SELECT id FROM mappings")
        .fetch_one(&mut *r)
        .await
        .unwrap();
    drop(r);
    server
        .ok(
            &boss,
            "revise_mapping",
            json!({ "mapping_id": mapping_id, "body": mapping }),
        )
        .await;
    let y3 = server
        .ok(
            &boss,
            "create_client_year",
            json!({
                "client_id": f.client_id,
                "start": "2026-04-01",
                "end": "2027-03-31",
                "mapping_id": mapping_id,
            }),
        )
        .await;
    // The new year's prior year (FY2026) has sales, which no longer map.
    let (status, body) = split(
        server
            .send(get(&format!("/api/years/{y3}/report"), Some(&boss)))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "report_failed");
    assert_eq!(
        body["details"],
        json!([{ "code": "unmapped", "account": "100" }])
    );
    // The older years keep their own pinned mapping, so their reports still build.
    server
        .get_json(&format!("/api/years/{}/report", f.year_ids[1]), &boss)
        .await;
}

#[tokio::test]
async fn the_sync_feed_pages_through_changes() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let f = server.load_fixture(&boss, &boss).await;

    let all = server.get_json("/api/sync?after=0", &boss).await;
    let changes = all["changes"].as_array().unwrap();
    // initialise, 2 users, then the fixture.
    assert_eq!(changes[0]["kind"], "initialise");
    assert_eq!(all["last_seq"], changes.last().unwrap()["seq"]);
    let last = changes.last().unwrap();
    assert_eq!(last["kind"], "post_journal");
    assert_eq!(last["client_id"], json!(f.client_id));
    assert_eq!(last["client_year_id"], json!(f.year_ids[1]));

    let page = server.get_json("/api/sync?after=2&limit=3", &boss).await;
    let seqs: Vec<i64> = page["changes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["seq"].as_i64().unwrap())
        .collect();
    assert_eq!(seqs, [3, 4, 5]);
    assert_eq!(page["last_seq"], 5);
    // The head is the end of the log, whatever page was asked for.
    assert_eq!(page["head_seq"], all["last_seq"]);

    let none = server
        .get_json(&format!("/api/sync?after={}", all["last_seq"]), &boss)
        .await;
    assert_eq!(none["changes"], json!([]));
    assert_eq!(none["last_seq"], all["last_seq"]);
    assert_eq!(none["head_seq"], all["last_seq"]);

    let (status, body) = split(server.send(get("/api/sync?after=abc", Some(&boss))).await).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(body["code"], "malformed");
}

#[tokio::test]
async fn reads_need_a_login_and_unknown_ids_are_not_found() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    for uri in ["/api/clients", "/api/sync", "/api/years/x/report"] {
        let (status, _) = split(server.send(get(uri, None)).await).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{uri}");
    }
    for uri in [
        "/api/clients/nope",
        "/api/clients/nope/chart",
        "/api/years/nope",
        "/api/years/nope/journals",
        "/api/years/nope/tb",
        "/api/years/nope/report",
    ] {
        let (status, body) = split(server.send(get(uri, Some(&boss))).await).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(body["code"], "not_found");
    }
}

#[tokio::test]
async fn the_practice_lists_its_defaults_for_any_role() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    server.load_fixture(&boss, &sam).await;

    let val = server.login("val").await;
    let p = server.get_json("/api/practice", &val).await;
    assert_eq!(p["name"], "Example Practice");
    let charts = p["master_charts"].as_array().unwrap();
    assert_eq!(charts.len(), 1);
    assert_eq!(charts[0]["entity_type"], "company");
    assert!(!charts[0]["accounts"].as_array().unwrap().is_empty());
    let templates = p["templates"].as_array().unwrap();
    assert_eq!(templates.len(), 1);
    assert_eq!(templates[0]["latest_version"], 1);
    let mappings = p["mappings"].as_array().unwrap();
    assert_eq!(mappings.len(), 1);
    assert_eq!(mappings[0]["entity_type"], "company");
    assert_eq!(mappings[0]["template_id"], templates[0]["id"]);
    assert_eq!(mappings[0]["latest_version"], 1);
}

#[tokio::test]
async fn only_a_master_lists_users_and_never_sees_hashes() {
    let server = Server::new().await;
    for who in ["sam", "val"] {
        let cookie = server.login(who).await;
        let (status, body) = split(server.send(get("/api/users", Some(&cookie))).await).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(body["code"], "forbidden");
    }
    let boss = server.login("boss").await;
    let users = server.get_json("/api/users", &boss).await;
    let names: Vec<_> = users
        .as_array()
        .unwrap()
        .iter()
        .map(|u| (u["username"].as_str().unwrap(), u["role"].as_str().unwrap()))
        .collect();
    assert_eq!(
        names,
        [("boss", "master"), ("sam", "staff"), ("val", "viewer")]
    );
    assert!(!users.to_string().contains("argon2"));
    assert_eq!(users[0]["active"], json!(true));
}
