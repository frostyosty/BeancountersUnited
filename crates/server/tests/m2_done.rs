//! PLAN.md M2 "Done when": over HTTP, the fixture company goes from empty to a ReportDoc
//! identical to M1's snapshot, and rejected commands leave no partial writes.

mod common;

use acct_core::ReportDoc;
use axum::http::StatusCode;
use common::Server;
use serde_json::json;

const FY2026: &str = include_str!("../../core/tests/snapshots/fixture__fy2026_reportdoc.snap");

/// Row counts of every table, so a rejection can be shown to have written nothing.
async fn counts(server: &Server) -> Vec<i64> {
    let mut r = server.state.store.reader().await.unwrap();
    let mut out = Vec::new();
    for sql in [
        "SELECT COUNT(*) FROM practice",
        "SELECT COUNT(*) FROM users",
        "SELECT COUNT(*) FROM command_log",
        "SELECT COUNT(*) FROM master_charts",
        "SELECT COUNT(*) FROM master_chart_accounts",
        "SELECT COUNT(*) FROM templates",
        "SELECT COUNT(*) FROM template_versions",
        "SELECT COUNT(*) FROM mappings",
        "SELECT COUNT(*) FROM mapping_versions",
        "SELECT COUNT(*) FROM clients",
        "SELECT COUNT(*) FROM accounts",
        "SELECT COUNT(*) FROM client_years",
        "SELECT COUNT(*) FROM journals",
        "SELECT COUNT(*) FROM journal_lines",
        "SELECT COUNT(*) FROM snapshots",
    ] {
        let (n,): (i64,) = acct_store::sqlx::query_as(sql)
            .fetch_one(&mut *r)
            .await
            .unwrap();
        out.push(n);
    }
    out
}

#[tokio::test]
async fn m2_is_done() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    let val = server.login("val").await;
    let f = server.load_fixture(&boss, &sam).await;

    // M1's snapshot treats FY2025 as finalised; finalising arrives in M5, so set it here.
    {
        let mut w = server.state.store.writer().await;
        acct_store::sqlx::query("UPDATE client_years SET status = 'finalised' WHERE id = ?")
            .bind(&f.year_ids[0])
            .execute(&mut *w)
            .await
            .unwrap();
    }
    let body = server
        .get_bytes(&format!("/api/years/{}/report", f.year_ids[1]), &val)
        .await;
    let doc: ReportDoc = serde_json::from_slice(&body).unwrap();
    let snapshot = FY2026
        .strip_prefix("---\n")
        .unwrap()
        .split_once("\n---\n")
        .unwrap()
        .1
        .trim_end();
    assert_eq!(serde_json::to_string_pretty(&doc).unwrap(), snapshot);

    let year = &f.year_ids[1];
    let journal = |lines: serde_json::Value| {
        json!({
            "client_year_id": year,
            "date": "2025-06-30",
            "narration": "Rejected",
            "lines": lines,
        })
    };
    let rejected = [
        (
            &sam,
            journal(
                json!([{ "account": "600", "amount": 100 }, { "account": "100", "amount": -99 }]),
            ),
            StatusCode::UNPROCESSABLE_ENTITY,
            "unbalanced",
        ),
        (
            &sam,
            journal(
                json!([{ "account": "600", "amount": 100 }, { "account": "123", "amount": -100 }]),
            ),
            StatusCode::UNPROCESSABLE_ENTITY,
            "unknown_account",
        ),
        (
            &val,
            journal(
                json!([{ "account": "600", "amount": 100 }, { "account": "100", "amount": -100 }]),
            ),
            StatusCode::FORBIDDEN,
            "forbidden",
        ),
    ];
    for (cookie, payload, status, problem) in rejected {
        let before = counts(&server).await;
        let (got, body) = server.command(cookie, "post_journal", payload).await;
        assert_eq!(got, status, "{body}");
        if problem == "forbidden" {
            assert_eq!(body["code"], "forbidden");
        } else {
            assert_eq!(body["code"], "invalid_journal");
            assert_eq!(body["details"][0]["code"], problem);
        }
        assert_eq!(counts(&server).await, before, "{problem} left rows behind");
    }
}
