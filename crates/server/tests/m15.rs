//! M15: finalising a year, the lock on its numbers, reopening it, and comparatives.
//!
//! The "Done when" check is `m15_is_done`: a finalised year's ReportDoc is byte-identical across a
//! server restart and after a template edit, posting into that year is rejected, and the
//! fixture's bank accounts reconcile.

mod common;

use acct_core::Money;
use acct_server::commands::Command;
use acct_server::pipeline::{Lock, lock_rule};
use acct_server::tax;
use acct_store::{bank, journals, log, snapshots, years};
use axum::body::to_bytes;
use axum::http::StatusCode;
use common::{Server, get, new_id};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

const CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const ASSET_CLASSES: &str =
    include_str!("../../../fixtures/practice/sole-trader-asset-classes.json");
const CODING_SETTINGS: &str =
    include_str!("../../../fixtures/practice/sole-trader-coding-settings.json");

const OFX: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08.ofx");
const QIF: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/harbourlight-cheque-2025-08-28_09-30.qif");
const KOWHAI_AUG: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");
const KOWHAI_SEP: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-09-10_09-30.csv");
const RIMU: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/rimu-savings-2025-08-29_09-30.csv");
/// A re-export of a day Rimu's statement already covers: a possible duplicate.
const RIMU_AGAIN: &[u8] = b"Account,Posted,Type,Payee,Particulars,Reference,Amount
99-7702-0000789-00,2025-09-03,DEP,Q MARSH,Top-up,,300.00
";
/// A new line in the first year.
const RIMU_LATE: &[u8] = b"Account,Posted,Type,Payee,Particulars,Reference,Amount
99-7702-0000789-00,2025-10-20,DEP,PIKORUA MARKET,Stall,,42.00
";

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

fn m(s: &str) -> Money {
    s.parse().unwrap()
}

/// The synthetic sole trader (Marsh Hollow Candles) with its first year's books: every statement,
/// a manual journal, an asset held all year and one disposed of, and depreciation run.
struct Books {
    server: Server,
    boss: String,
    sam: String,
    client: String,
    /// 1 August 2025 to 31 March 2026.
    year: String,
    template_id: String,
    mapping_id: String,
    class_id: String,
    /// Held in the year.
    laptop: String,
    /// Disposed of in the year.
    drill: String,
    journal_id: String,
    bank_accounts: Vec<String>,
}

impl Books {
    async fn ok(&self, cookie: &str, kind: &str, payload: Value) -> Value {
        let (status, body) = self.server.command(cookie, kind, payload).await;
        assert_eq!(status, StatusCode::OK, "{kind}: {body}");
        body
    }

    async fn upload(&self, name: &str, bytes: &[u8]) {
        self.ok(
            &self.sam,
            "import_statement",
            json!({ "client_id": self.client, "file_name": name, "content_base64": base64(bytes) }),
        )
        .await;
    }

    /// The signed ReportDoc's bytes, checked against the SHA-256 the server sends with it.
    async fn snapshot(&self, year: &str) -> Vec<u8> {
        let response = self
            .server
            .send(get(
                &format!("/api/years/{year}/snapshot"),
                Some(&self.boss),
            ))
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        let sha = response.headers()["x-report-sha256"]
            .to_str()
            .unwrap()
            .to_owned();
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap()
            .to_vec();
        let hex: String = Sha256::digest(&bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_eq!(sha, hex);
        bytes
    }

    async fn bank_lines(&self) -> Vec<bank::BankLine> {
        let mut conn = self.server.state.store.reader().await.unwrap();
        bank::bank_lines(&mut conn, &self.client).await.unwrap()
    }

    async fn line(&self, date: &str, amount: &str) -> String {
        let date: chrono::NaiveDate = date.parse().unwrap();
        self.bank_lines()
            .await
            .into_iter()
            .find(|l| l.date == date && l.amount == m(amount))
            .unwrap_or_else(|| panic!("no line on {date} for {amount}"))
            .id
    }

    async fn log_head(&self) -> i64 {
        let mut conn = self.server.state.store.reader().await.unwrap();
        log::head_seq(&mut conn).await.unwrap()
    }

    async fn tb(&self, year: &str) -> Value {
        self.server
            .get_json(&format!("/api/years/{year}/tb"), &self.boss)
            .await
    }
}

/// `walk`: leave Rimu's opening balance unset and upload a possible duplicate, so the lock walk has
/// something to try on each. Without it, the books reconcile as M10's worked example does.
async fn books(walk: bool) -> Books {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
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
    let mapping_id = server
        .ok(
            &boss,
            "create_mapping",
            json!({ "template_id": template_id, "name": "Sole trader", "body": mapping }),
        )
        .await;
    let classes: Vec<Value> = serde_json::from_str(ASSET_CLASSES).unwrap();
    let mut class_id = String::new();
    for class in &classes {
        let id = server
            .ok(
                &boss,
                "create_asset_class",
                json!({
                    "entity_type": "sole_trader", "key": class["key"], "name": class["name"],
                    "settings": class["settings"], "accounts": class["accounts"],
                }),
            )
            .await;
        if class["key"] == "tools" {
            class_id = id;
        }
    }
    let client = server
        .ok(
            &sam,
            "set_up_business",
            json!({ "name": "Marsh Hollow Candles", "start_date": "2025-08-01" }),
        )
        .await;
    let mut bank_accounts = Vec::new();
    for (name, number) in [
        ("Harbourlight cheque", "99-1001-0000123-00"),
        ("Kowhai business", "99-5501-0000456-00"),
        ("Rimu savings", "99-7702-0000789-00"),
    ] {
        bank_accounts.push(
            server
                .ok(
                    &sam,
                    "add_bank_account",
                    json!({ "client_id": client, "name": name, "account_number": number }),
                )
                .await,
        );
    }
    let mut b = Books {
        server,
        boss,
        sam,
        client,
        year: String::new(),
        template_id,
        mapping_id,
        class_id,
        laptop: String::new(),
        drill: String::new(),
        journal_id: String::new(),
        bank_accounts,
    };
    b.upload("harbourlight.ofx", OFX).await;
    b.upload("harbourlight.qif", QIF).await;
    b.upload("kowhai-aug.csv", KOWHAI_AUG).await;
    b.upload("kowhai-sep.csv", KOWHAI_SEP).await;
    b.upload("rimu.csv", RIMU).await;
    if walk {
        b.upload("rimu-again.csv", RIMU_AGAIN).await;
    } else {
        b.ok(
            &b.sam,
            "set_opening_balance",
            json!({ "bank_account_id": b.bank_accounts[2], "balance": m("1,000.00") }),
        )
        .await;
    }
    let mut conn = b.server.state.store.reader().await.unwrap();
    let all = years::for_client(&mut conn, &b.client).await.unwrap();
    drop(conn);
    assert_eq!(all.len(), 1);
    b.year = all[0].id.clone();

    let asset = |name: &str, cost: &str, acquired: &str| {
        json!({
            "client_id": b.client, "class_id": b.class_id, "name": name,
            "cost": m(cost), "residual": 0, "acquired": acquired,
        })
    };
    let laptop = b.ok(
        &b.sam,
        "create_asset",
        asset("Laptop", "2,400.00", "2025-09-01"),
    );
    b.laptop = laptop.await["entity_id"].as_str().unwrap().to_owned();
    let drill = b.ok(
        &b.sam,
        "create_asset",
        asset("Drill", "500.00", "2025-08-15"),
    );
    b.drill = drill.await["entity_id"].as_str().unwrap().to_owned();
    b.ok(
        &b.sam,
        "dispose_asset",
        json!({
            "asset_id": b.drill,
            "disposal": { "date": "2025-12-01", "proceeds": m("100.00"), "proceeds_account": "120" },
        }),
    )
    .await;
    let journal = b.ok(
        &b.sam,
        "post_journal",
        json!({
            "client_year_id": b.year, "date": "2026-03-31", "narration": "Reclassify insurance",
            "lines": [{ "account": "215", "amount": m("50.00") },
                      { "account": "200", "amount": m("-50.00") }],
        }),
    );
    b.journal_id = journal.await["entity_id"].as_str().unwrap().to_owned();
    b.ok(
        &b.sam,
        "run_depreciation",
        json!({ "client_year_id": b.year }),
    )
    .await;
    b
}

fn issue_codes(body: &Value) -> Vec<&str> {
    body["details"]
        .as_array()
        .unwrap_or_else(|| panic!("{body}"))
        .iter()
        .map(|i| i["code"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn m15_is_done() {
    let b = books(false).await;

    // The ledger matches M10's worked example: each account whose statements give a closing
    // balance agrees with it (Rimu's give none).
    let mut conn = b.server.state.store.reader().await.unwrap();
    let view = tax::business_view(&mut conn, &b.client).await.unwrap();
    drop(conn);
    let recs: Vec<_> = view
        .bank_accounts
        .iter()
        .map(|a| a.reconciliation.as_ref().map(|r| (r.ledger, r.agrees)))
        .collect();
    assert_eq!(
        recs,
        vec![
            Some((m("2,247.12"), Some(true))),
            Some((m("2,830.73"), Some(true))),
            Some((m("1,153.76"), None)),
        ]
    );

    // Only a practice admin finalises.
    let (status, body) = b
        .server
        .command(&b.sam, "finalise_year", json!({ "client_year_id": b.year }))
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    // Not ready: an asset added since depreciation ran, and lines still unsorted.
    b.ok(
        &b.sam,
        "create_asset",
        json!({
            "client_id": b.client, "class_id": b.class_id, "name": "Wax melter",
            "cost": m("800.00"), "residual": 0, "acquired": "2026-01-10",
        }),
    )
    .await;
    let (status, body) = b
        .server
        .command(
            &b.boss,
            "finalise_year",
            json!({ "client_year_id": b.year }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "not_ready_to_finalise");
    assert_eq!(
        issue_codes(&body),
        vec!["depreciation_stale", "uncategorised_lines"]
    );
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("Run depreciation first."),
        "{body}"
    );
    b.ok(
        &b.sam,
        "run_depreciation",
        json!({ "client_year_id": b.year }),
    )
    .await;

    // Accepting the unsorted lines as they are, it finalises, and the acceptance is logged.
    let accepted = b
        .ok(
            &b.boss,
            "finalise_year",
            json!({ "client_year_id": b.year, "accept_uncategorised": true }),
        )
        .await;
    let snapshot_id = accepted["entity_id"].as_str().unwrap();
    let mut conn = b.server.state.store.reader().await.unwrap();
    let entry = log::after(&mut conn, 0, 10_000)
        .await
        .unwrap()
        .into_iter()
        .rfind(|e| e.kind == "finalise_year")
        .unwrap();
    assert!(entry.payload.contains("\"accept_uncategorised\":true"));
    let stored = snapshots::for_year(&mut conn, &b.year).await.unwrap();
    drop(conn);
    assert_eq!(stored.len(), 1);
    assert_eq!(stored[0].id, snapshot_id);

    // The signed ReportDoc is what the live report gave at that moment.
    let signed = b.snapshot(&b.year).await;
    let live = b
        .server
        .get_json(&format!("/api/years/{}/report", b.year), &b.boss)
        .await;
    assert_eq!(serde_json::from_slice::<Value>(&signed).unwrap(), live);
    assert_eq!(stored[0].report_doc.as_bytes(), signed.as_slice());

    // A template edit and an account rename don't touch it.
    let mut template: Value = serde_json::from_str(TEMPLATE).unwrap();
    template["statements"][0]["title"] = json!("Profit and loss, as revised");
    b.ok(
        &b.boss,
        "revise_template",
        json!({ "template_id": b.template_id, "body": template }),
    )
    .await;
    b.ok(
        &b.sam,
        "rename_account",
        json!({ "client_id": b.client, "code": "215", "name": "Insurance premiums" }),
    )
    .await;
    assert_eq!(b.snapshot(&b.year).await, signed);

    // Posting into the year is rejected, by journal or by upload.
    let head = b.log_head().await;
    let (status, body) = b
        .server
        .command(
            &b.sam,
            "post_journal",
            json!({
                "client_year_id": b.year, "date": "2026-03-31", "narration": "Late",
                "lines": [{ "account": "215", "amount": 1 }, { "account": "200", "amount": -1 }],
            }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "year_finalised");
    let (status, body) = b
        .server
        .command(
            &b.sam,
            "import_statement",
            json!({ "client_id": b.client, "file_name": "late.csv",
                    "content_base64": base64(RIMU_LATE) }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "year_finalised");
    assert_eq!(b.log_head().await, head);

    // Byte-identical across a restart.
    let Books {
        server, boss, year, ..
    } = b;
    let server = server.restart().await;
    let response = server
        .send(get(&format!("/api/years/{year}/snapshot"), Some(&boss)))
        .await;
    assert_eq!(response.status(), StatusCode::OK);
    let again = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(again.as_ref(), signed.as_slice());

    // The fixture's bank accounts reconcile in the finalised year (the reconciliation view's own
    // tests, in tests/m15_reconcile.rs, cover the detail).
    let rec = server
        .get_json(&format!("/api/years/{year}/reconciliation"), &boss)
        .await;
    let statuses: Vec<(&str, &str)> = rec["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["code"].as_str().unwrap(), a["status"].as_str().unwrap()))
        .collect();
    assert_eq!(statuses.len(), 3, "{rec}");
    for (code, status) in &statuses {
        let ok = match *code {
            // Rimu's statements give no closing balance.
            "600.03" => *status == "no_balance",
            _ => *status == "agrees" || *status == "explained",
        };
        assert!(ok, "{code} doesn't reconcile: {rec}");
    }
}

/// What a command kind does against the finalised year in the walk.
enum Expect {
    /// Refused by the lock: submit it and expect `year_finalised` or `asset_fixed`.
    Refused(Value),
    /// Allowed: submit it; if it's refused, it's for some other reason than the lock.
    Allowed(Value),
    /// Allowed, but not submitted: reopening would unlock the year mid-walk.
    NotSubmitted(Value),
}

/// One payload for each command kind, aimed at the finalised year. A new kind fails here until
/// it's given one, and the expectation must agree with `pipeline::lock_rule`.
async fn walk_case(kind: &str, b: &Books) -> Expect {
    use Expect::{Allowed, NotSubmitted, Refused};
    let coding = json!({ "direction": "out", "kind": "personal" });
    let template: Value = serde_json::from_str(TEMPLATE).unwrap();
    let mapping: Value = serde_json::from_str(MAPPING).unwrap();
    let classes: Vec<Value> = serde_json::from_str(ASSET_CLASSES).unwrap();
    let settings: Value = serde_json::from_str(CODING_SETTINGS).unwrap();
    let class = &classes[0];
    let biz = &b.client;
    let out_line = b.line("2025-08-29", "-6.50").await;
    let transfer_out = b.line("2025-08-22", "-500.00").await;
    let transfer_in = b.line("2025-08-22", "500.00").await;
    let ird = b.line_like("IRD").await;
    let duplicate = b
        .bank_lines()
        .await
        .into_iter()
        .find(|l| l.possible_duplicate)
        .expect("a possible duplicate")
        .id;
    match kind {
        "post_journal" => Refused(json!({
            "client_year_id": b.year, "date": "2026-03-31", "narration": "X",
            "lines": [{ "account": "215", "amount": 1 }, { "account": "200", "amount": -1 }],
        })),
        "import_tb" => Refused(json!({ "client_year_id": b.year, "rows": [] })),
        "reverse_journal" => Refused(json!({ "journal_id": b.journal_id })),
        "run_depreciation" => Refused(json!({ "client_year_id": b.year })),
        "create_asset" => Refused(json!({
            "client_id": biz, "class_id": b.class_id, "name": "Late find",
            "cost": 10_000, "residual": 0, "acquired": "2025-10-01",
        })),
        "update_asset" => Refused(json!({
            "asset_id": b.laptop, "name": "Laptop", "cost": 999, "residual": 0,
            "acquired": "2025-09-01",
        })),
        "delete_asset" => Refused(json!({ "asset_id": b.laptop })),
        "dispose_asset" => Refused(json!({
            "asset_id": b.laptop,
            "disposal": { "date": "2026-02-01", "proceeds": 0, "proceeds_account": "120" },
        })),
        "reinstate_asset" => Refused(json!({ "asset_id": b.drill })),
        "import_statement" => Refused(json!({
            "client_id": biz, "file_name": "late.csv", "content_base64": base64(RIMU_LATE),
        })),
        "set_opening_balance" => Refused(json!({
            "bank_account_id": b.bank_accounts[2], "balance": m("1,000.00"),
        })),
        "code_bank_line" => Refused(json!({ "bank_line_id": out_line, "coding": coding })),
        "code_bank_lines" => {
            Refused(json!({ "lines": [{ "bank_line_id": out_line, "coding": coding }] }))
        }
        "confirm_transfer" => Refused(json!({
            "out_line_id": transfer_out, "in_line_id": transfer_in,
        })),
        "confirm_ird_payment" => {
            Refused(json!({ "bank_line_id": ird, "payment": { "kind": "gst" } }))
        }
        "resolve_duplicate" => Refused(json!({ "bank_line_id": duplicate, "is_duplicate": true })),
        "confirm_supply_info" => Refused(json!({ "bank_line_id": out_line })),
        "create_client_year" => Refused(json!({
            "client_id": biz, "start": "2024-08-01", "end": "2025-07-31",
        })),
        "finalise_year" => {
            Refused(json!({ "client_year_id": b.year, "accept_uncategorised": true }))
        }

        "pick_notes" => Refused(json!({ "client_year_id": b.year, "paragraph_ids": [] })),
        "edit_note" => Refused(json!({
            "client_year_id": b.year, "paragraph_id": new_id(), "title": "X", "body": "X",
        })),
        "add_paragraph" => Allowed(json!({
            "entity_type": "sole_trader",
            "paragraph": { "key": "walked", "placement": "note", "title": "X", "body": "X" },
        })),
        "revise_paragraph" => Allowed(json!({
            "paragraph_id": new_id(), "placement": "note", "title": "X", "body": "X",
        })),
        "push_paragraph" => Allowed(json!({ "paragraph_id": new_id() })),
        "remove_paragraph" => Allowed(json!({ "paragraph_id": new_id() })),

        "reopen_year" => NotSubmitted(json!({ "client_year_id": b.year, "reason": "X" })),

        "initialise" => Allowed(json!({
            "practice_name": "X", "username": "x", "display_name": "X", "password": "x",
        })),
        "sign_up" => Allowed(json!({
            "email": "x@example.nz", "display_name": "X", "password": common::PASSWORD,
            "business_name": "X", "start_date": "2025-04-01",
        })),
        "create_user" => Allowed(json!({
            "username": "walker", "display_name": "Walker",
            "password": common::PASSWORD, "role": "staff",
        })),
        "change_own_password" => Allowed(json!({
            "current_password": "not it", "new_password": common::PASSWORD,
        })),
        "reset_password" => {
            Allowed(json!({ "user_id": new_id(), "new_password": common::PASSWORD }))
        }
        "set_user_active" => Allowed(json!({ "user_id": new_id(), "active": true })),
        "create_master_chart" => {
            Allowed(json!({ "entity_type": "company", "name": "X", "accounts": [] }))
        }
        "install_starter_set" => Allowed(json!({ "set": "company" })),
        "add_master_account" => Allowed(json!({
            "entity_type": "sole_trader",
            "account": { "code": "998", "name": "X", "account_type": "expense", "active": true },
        })),
        "rename_master_account" => {
            Allowed(json!({ "entity_type": "sole_trader", "code": "290", "name": "X" }))
        }
        "set_master_account_active" => {
            Allowed(json!({ "entity_type": "sole_trader", "code": "275", "active": false }))
        }
        "set_master_account_gst" => Allowed(json!({
            "entity_type": "sole_trader", "code": "290", "default_gst": null,
        })),
        "create_template" => {
            Allowed(json!({ "entity_type": "sole_trader", "name": "X", "body": template }))
        }
        "revise_template" => Allowed(json!({ "template_id": b.template_id, "body": template })),
        "create_mapping" => {
            Allowed(json!({ "template_id": b.template_id, "name": "X", "body": mapping }))
        }
        "revise_mapping" => Allowed(json!({ "mapping_id": b.mapping_id, "body": mapping })),
        "create_asset_class" => Allowed(json!({
            "entity_type": "sole_trader", "key": "walked", "name": "X",
            "settings": class["settings"], "accounts": class["accounts"],
        })),
        "update_asset_class" => Allowed(json!({
            "class_id": b.class_id, "name": "Tools",
            "settings": class["settings"], "accounts": class["accounts"],
        })),
        "add_merchant" => Allowed(json!({
            "entity_type": "sole_trader", "description_contains": "WALK", "coding": coding,
        })),
        "remove_merchant" => Allowed(json!({ "merchant_id": new_id() })),
        "create_client" => Allowed(json!({
            "name": "X", "entity_type": "sole_trader",
            "retained_earnings": "970", "rounding_priority": [],
        })),
        "set_up_business" => Allowed(json!({ "name": "X", "start_date": "2025-04-01" })),
        "add_account" => Allowed(json!({
            "client_id": biz,
            "account": { "code": "999", "name": "X", "account_type": "expense", "active": true },
        })),
        "rename_account" => {
            Allowed(json!({ "client_id": biz, "code": "215", "name": "Insurance cover" }))
        }
        "set_account_active" => Allowed(json!({ "client_id": biz, "code": "215", "active": true })),
        "set_account_gst" => {
            Allowed(json!({ "client_id": biz, "code": "215", "default_gst": "standard" }))
        }
        "set_rounding_priority" => Allowed(json!({ "client_id": biz, "rounding_priority": [] })),
        "set_client_asset_class" => Allowed(json!({ "client_id": biz, "class_id": b.class_id })),
        "apply_asset_class_defaults" => {
            Allowed(json!({ "client_id": biz, "class_id": b.class_id }))
        }
        "add_bank_account" => Allowed(json!({ "client_id": biz, "name": "Spare" })),
        "add_card_account" => Allowed(json!({ "client_id": biz, "name": "Visa" })),
        "add_rule" => Allowed(json!({
            "client_id": biz, "description_contains": "PIKORUA", "coding": coding,
        })),
        "remove_rule" => Allowed(json!({ "rule_id": new_id() })),
        "answer_question" => Allowed(json!({
            "client_id": biz, "income_year": 2026,
            "answer": { "question": "only_income", "yes": true },
        })),
        "set_coding_settings" => Allowed(json!({ "client_id": biz, "settings": settings })),
        "set_ai_suggestions" => Allowed(json!({ "client_id": biz, "enabled": false })),
        "record_suggestions" => {
            Allowed(json!({ "client_id": biz, "model": "x", "suggestions": [] }))
        }
        "create_invite" => Allowed(json!({
            "client_id": biz, "email": "x@example.nz", "token": "ab".repeat(32),
        })),
        "accept_invite" => Allowed(json!({ "token": "cd".repeat(32) })),
        other => panic!("tests/m15.rs has no lock walk case for the new command {other}; add one"),
    }
}

impl Books {
    async fn line_like(&self, text: &str) -> String {
        self.bank_lines()
            .await
            .into_iter()
            .find(|l| l.description.to_uppercase().contains(text))
            .unwrap_or_else(|| panic!("no line like {text}"))
            .id
    }
}

/// Every command kind, from the `Command` enum's own list of variants (as `tests/tenancy.rs`
/// does it).
fn all_kinds() -> Vec<String> {
    let err = serde_json::from_value::<Command>(json!({ "kind": "?", "payload": {} }))
        .unwrap_err()
        .to_string();
    let list = err
        .split_once("expected one of ")
        .unwrap_or_else(|| panic!("serde's message changed: {err}"))
        .1;
    list.split(", ")
        .map(|k| {
            k.trim_matches(|c: char| c == '`' || c.is_whitespace())
                .to_owned()
        })
        .collect()
}

#[tokio::test]
async fn every_command_kind_respects_a_finalised_year() {
    let b = books(true).await;
    b.ok(
        &b.boss,
        "finalise_year",
        json!({ "client_year_id": b.year, "accept_uncategorised": true }),
    )
    .await;
    let signed = b.snapshot(&b.year).await;
    let tb = b.tb(&b.year).await;
    let kinds = all_kinds();
    assert!(kinds.len() > 50, "{kinds:?}");
    let mut refused = Vec::new();
    for kind in &kinds {
        let case = walk_case(kind, &b).await;
        let payload = match &case {
            Expect::Refused(p) | Expect::Allowed(p) | Expect::NotSubmitted(p) => p.clone(),
        };
        let command: Command =
            serde_json::from_value(json!({ "kind": kind, "payload": payload.clone() }))
                .unwrap_or_else(|e| panic!("{kind}: {e}"));
        let rule = lock_rule(&command);
        match case {
            Expect::Refused(_) => {
                assert_eq!(rule, Lock::Enforced, "{kind}: the walk expects it refused");
                let head = b.log_head().await;
                let (status, body) = b.server.command(&b.boss, kind, payload).await;
                assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{kind}: {body}");
                let code = body["code"].as_str().unwrap();
                assert!(
                    code == "year_finalised" || code == "asset_fixed",
                    "{kind}: refused, but not by the lock: {body}"
                );
                assert_eq!(b.log_head().await, head, "{kind} left something in the log");
                refused.push(kind.as_str());
            }
            Expect::Allowed(_) | Expect::NotSubmitted(_) => {
                assert!(
                    matches!(rule, Lock::Allowed(_)),
                    "{kind}: lock_rule says {rule:?}, but the walk expects it allowed"
                );
                if matches!(case, Expect::Allowed(_)) {
                    let (_, body) = b.server.command(&b.boss, kind, payload).await;
                    assert_ne!(body["code"], "year_finalised", "{kind}: {body}");
                    assert_ne!(body["code"], "asset_fixed", "{kind}: {body}");
                }
            }
        }
    }
    assert!(refused.len() >= 19, "{refused:?}");

    // Nothing reached the year: same balances, same signed statements, still finalised.
    assert_eq!(b.tb(&b.year).await, tb);
    assert_eq!(b.snapshot(&b.year).await, signed);
    let mut conn = b.server.state.store.reader().await.unwrap();
    let year = years::get(&mut conn, &b.year).await.unwrap().unwrap();
    assert_eq!(year.status, acct_store::years::YearStatus::Finalised);
    let posted = journals::for_year(&mut conn, &b.year).await.unwrap();
    drop(conn);
    let finalised_at = year_seq(&b).await;
    assert!(posted.iter().all(|j| j.posted_seq < finalised_at));
}

/// The seq of the year's finalise command: nothing in the year was posted after it.
async fn year_seq(b: &Books) -> i64 {
    let mut conn = b.server.state.store.reader().await.unwrap();
    log::after(&mut conn, 0, 10_000)
        .await
        .unwrap()
        .into_iter()
        .rfind(|e| e.kind == "finalise_year")
        .unwrap()
        .seq
}

#[tokio::test]
async fn years_finalise_in_order_reopen_with_a_reason_and_keep_their_snapshots() {
    let b = books(false).await;
    let next = b
        .ok(
            &b.sam,
            "create_client_year",
            json!({ "client_id": b.client, "start": "2026-04-01", "end": "2027-03-31" }),
        )
        .await["entity_id"]
        .as_str()
        .unwrap()
        .to_owned();
    b.ok(
        &b.sam,
        "run_depreciation",
        json!({ "client_year_id": next }),
    )
    .await;
    let report = |year: String| {
        let (server, boss) = (&b.server, &b.boss);
        async move {
            server
                .get_json(&format!("/api/years/{year}/report"), boss)
                .await
        }
    };

    // The first year isn't finalised, so the second can't be, and its comparatives say so.
    let (status, body) = b
        .server
        .command(&b.boss, "finalise_year", json!({ "client_year_id": next }))
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(issue_codes(&body), vec!["prior_not_finalised"]);
    assert_eq!(report(next.clone()).await["comparatives"], "unfinalised");

    // Once it is, the comparatives come from its snapshot TB.
    b.ok(
        &b.boss,
        "finalise_year",
        json!({ "client_year_id": b.year, "accept_uncategorised": true }),
    )
    .await;
    let prior_report = report(next.clone()).await;
    assert_eq!(prior_report["comparatives"], "finalised");
    let signed: Value = serde_json::from_slice(&b.snapshot(&b.year).await).unwrap();
    // Each row's amount in one column, by statement, row key and style.
    let column = |doc: &Value, col: &str| -> std::collections::BTreeMap<String, Value> {
        let mut out = std::collections::BTreeMap::new();
        for s in doc["statements"].as_array().unwrap() {
            for r in s["rows"].as_array().unwrap() {
                if !r[col].is_null() {
                    let key = format!("{} {} {}", s["key"], r["key"], r["style"]);
                    out.insert(key, r[col].clone());
                }
            }
        }
        out
    };
    // The template hasn't changed, so the prior column shows the signed current column. (The
    // later year may show extra rows, such as a zero the prior year had no row for.)
    let prior_column = column(&prior_report, "prior");
    let signed_column = column(&signed, "current");
    for (key, amount) in &signed_column {
        assert_eq!(prior_column.get(key), Some(amount), "{key}");
    }

    // A later year finalised: the earlier one stays locked until it's reopened.
    b.ok(&b.boss, "finalise_year", json!({ "client_year_id": next }))
        .await;
    let (status, body) = b
        .server
        .command(
            &b.boss,
            "reopen_year",
            json!({ "client_year_id": b.year, "reason": "Missing invoice" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "later_year_finalised");

    // Reopening is the practice admin's, and needs a reason.
    let (status, _) = b
        .server
        .command(
            &b.sam,
            "reopen_year",
            json!({ "client_year_id": next, "reason": "Missing invoice" }),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = b
        .server
        .command(
            &b.boss,
            "reopen_year",
            json!({ "client_year_id": next, "reason": "  " }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "reason_required");
    b.ok(
        &b.boss,
        "reopen_year",
        json!({ "client_year_id": next, "reason": "Missing invoice" }),
    )
    .await;

    // The reason is in the log, and the history says it.
    let mut conn = b.server.state.store.reader().await.unwrap();
    let entry = log::after(&mut conn, 0, 10_000)
        .await
        .unwrap()
        .into_iter()
        .rfind(|e| e.kind == "reopen_year")
        .unwrap();
    assert!(
        entry.payload.contains("Missing invoice"),
        "{}",
        entry.payload
    );
    let history = b
        .server
        .get_json(&format!("/api/history?client_id={}", b.client), &b.boss)
        .await
        .to_string();
    assert!(
        history.contains("reopened the year ending 31 Mar 2027, because “Missing invoice”"),
        "{history}"
    );

    // Open again: no signed statements served, but the old snapshot stays on record.
    let (status, body) = common::split(
        b.server
            .send(get(&format!("/api/years/{next}/snapshot"), Some(&b.boss)))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "year_not_finalised");
    assert_eq!(
        snapshots::for_year(&mut conn, &next).await.unwrap().len(),
        1
    );
    drop(conn);

    // Its numbers can change again, and finalising it again adds a second snapshot.
    b.ok(
        &b.sam,
        "post_journal",
        json!({
            "client_year_id": next, "date": "2026-06-30", "narration": "Missing invoice",
            "lines": [{ "account": "215", "amount": m("80.00") },
                      { "account": "200", "amount": m("-80.00") }],
        }),
    )
    .await;
    b.ok(&b.boss, "finalise_year", json!({ "client_year_id": next }))
        .await;
    let mut conn = b.server.state.store.reader().await.unwrap();
    let all = snapshots::for_year(&mut conn, &next).await.unwrap();
    assert_eq!(all.len(), 2);
    assert_ne!(all[0].report_sha256, all[1].report_sha256);
    drop(conn);
    assert_eq!(
        b.snapshot(&next).await,
        all[1].report_doc.as_bytes().to_vec()
    );

    // A year can't be added before a finalised first year.
    let (status, body) = b
        .server
        .command(
            &b.sam,
            "create_client_year",
            json!({ "client_id": b.client, "start": "2024-08-01", "end": "2025-07-31" }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(body["code"], "year_finalised");
}

#[tokio::test]
async fn the_server_itself_cant_sign_a_year_off() {
    let b = books(false).await;
    let system = acct_server::pipeline::Actor {
        user_id: None,
        role: acct_store::users::Role::PracticeAdmin,
    };
    let envelope = acct_server::commands::CommandEnvelope {
        id: new_id(),
        command: Command::FinaliseYear {
            client_year_id: b.year.clone(),
            accept_uncategorised: Some(true),
        },
    };
    let err =
        acct_server::pipeline::submit(&b.server.state.store, &system, envelope, chrono::Utc::now())
            .await
            .unwrap_err();
    assert!(
        matches!(err, acct_server::error::CommandError::Forbidden),
        "{err:?}"
    );
}

#[tokio::test]
async fn the_finalise_check_runs_the_pre_checks_without_finalising() {
    let b = books(false).await;
    let next = b
        .ok(
            &b.sam,
            "create_client_year",
            json!({ "client_id": b.client, "start": "2026-04-01", "end": "2027-03-31" }),
        )
        .await["entity_id"]
        .as_str()
        .unwrap()
        .to_owned();
    let check = |year: String| {
        let (server, sam) = (&b.server, &b.sam);
        async move {
            server
                .get_json(&format!("/api/years/{year}/finalise-check"), sam)
                .await
        }
    };
    let codes = |body: &Value| -> Vec<String> {
        body["issues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["code"].as_str().unwrap().to_owned())
            .collect()
    };

    // The first year has unsorted bank lines; the check reports them and changes nothing.
    let head = b.log_head().await;
    let first = check(b.year.clone()).await;
    assert_eq!(first["status"], "open");
    assert_eq!(first["has_prior_year"], false);
    assert_eq!(codes(&first), vec!["uncategorised_lines"]);
    assert!(first["uncategorised_lines"].as_u64().unwrap() > 0);
    assert!(first["finalised"].is_null());
    assert_eq!(b.log_head().await, head);
    // The second year's prior isn't finalised, and its depreciation hasn't been run.
    let second = check(next.clone()).await;
    assert_eq!(second["has_prior_year"], true);
    assert!(codes(&second).contains(&"prior_not_finalised".to_owned()));

    // Once finalised, it says who by, when, and the hash the snapshot is served with.
    b.ok(
        &b.boss,
        "finalise_year",
        json!({ "client_year_id": b.year, "accept_uncategorised": true }),
    )
    .await;
    let done = check(b.year.clone()).await;
    assert_eq!(done["status"], "finalised");
    assert_eq!(done["issues"], json!([]));
    let signed = b.snapshot(&b.year).await;
    let hex: String = Sha256::digest(&signed)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect();
    assert_eq!(done["finalised"]["sha256"], hex);
    assert!(!done["finalised"]["who"].as_str().unwrap().is_empty());
    assert!(done["finalised"]["at"].as_str().unwrap().starts_with("20"));
    assert!(!codes(&check(next).await).contains(&"prior_not_finalised".to_owned()));
}
