//! TB import over HTTP: preview, import, re-import, and statements built from imported books.

mod common;

use acct_core::ReportDoc;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use common::{Server, split};
use serde_json::{Value, json};

const TBS: &str = include_str!("../../core/tests/snapshots/fixture__trial_balances.snap");
const FY2025: &str = include_str!("../../core/tests/snapshots/fixture__fy2025_reportdoc.snap");
const FY2026: &str = include_str!("../../core/tests/snapshots/fixture__fy2026_reportdoc.snap");

fn snapshot_body(snap: &str) -> &str {
    let rest = snap.strip_prefix("---\n").unwrap();
    rest.split_once("\n---\n").unwrap().1.trim_end()
}

/// The fixture's closing TB for a year (0 or 1), as a signed-amount CSV: the client's own books
/// at year end, before closing entries.
fn fixture_tb_csv(year: usize) -> String {
    let block = snapshot_body(TBS).split("\n\n").nth(year).unwrap();
    let mut csv = String::from("Code,Name,Amount\n");
    for line in block.lines().skip(1) {
        let (code, amount) = line.split_once(char::is_whitespace).unwrap();
        csv.push_str(&format!("{code},Account {code},\"{}\"\n", amount.trim()));
    }
    csv
}

/// Rewrites one account's amount in a signed-amount CSV.
fn with_balance(csv: &str, code: &str, amount: &str) -> String {
    csv.lines()
        .map(|l| {
            if l.starts_with(&format!("{code},")) {
                format!("{code},Account {code},\"{amount}\"")
            } else {
                l.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

struct Ctx {
    server: Server,
    cookie: String,
    client_id: String,
    years: Vec<String>,
}

impl Ctx {
    async fn new() -> Ctx {
        let server = Server::new().await;
        let cookie = server.login("boss").await;
        server.practice_defaults(&cookie).await;
        let (client_id, years) = server.fixture_client(&cookie).await;
        Ctx {
            server,
            cookie,
            client_id,
            years,
        }
    }

    async fn preview_as(&self, cookie: &str, year: usize, csv: &str) -> (StatusCode, Value) {
        let request = Request::post(format!("/api/years/{}/tb-import/preview", self.years[year]))
            .header(header::CONTENT_TYPE, "text/csv")
            .header(header::COOKIE, cookie)
            .body(Body::from(csv.to_owned()))
            .unwrap();
        split(self.server.send(request).await).await
    }

    async fn preview(&self, year: usize, csv: &str) -> Value {
        let (status, body) = self.preview_as(&self.cookie, year, csv).await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body
    }

    /// Previews then imports, as the UI will. Returns the command's response.
    async fn import(&self, year: usize, csv: &str) -> (StatusCode, Value) {
        let preview = self.preview(year, csv).await;
        assert_eq!(preview["file_errors"], json!([]), "{preview}");
        let rows: Vec<Value> = preview["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| json!({ "account": r["code"], "balance": r["balance"] }))
            .collect();
        self.server
            .command(
                &self.cookie,
                "import_tb",
                json!({ "client_year_id": self.years[year], "rows": rows }),
            )
            .await
    }

    async fn journals(&self, year: usize) -> Vec<Value> {
        let j = self
            .server
            .get_json(
                &format!("/api/years/{}/journals", self.years[year]),
                &self.cookie,
            )
            .await;
        j.as_array().unwrap().clone()
    }

    async fn closing(&self, year: usize, code: &str) -> i64 {
        let tb = self
            .server
            .get_json(&format!("/api/years/{}/tb", self.years[year]), &self.cookie)
            .await;
        tb["closing"]
            .as_array()
            .unwrap()
            .iter()
            .find(|l| l["account"] == code)
            .map_or(0, |l| l["balance"].as_i64().unwrap())
    }

    async fn post(&self, year: usize, date: &str, lines: Value) -> String {
        self.server
            .ok(
                &self.cookie,
                "post_journal",
                json!({
                    "client_year_id": self.years[year],
                    "date": date,
                    "narration": "Adjustment",
                    "lines": lines,
                }),
            )
            .await
    }
}

#[tokio::test]
async fn imported_books_give_the_same_statements_as_journals() {
    let ctx = Ctx::new().await;
    for year in 0..2 {
        let (status, body) = ctx.import(year, &fixture_tb_csv(year)).await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
    // Year 2's import is the TB less the rolled-forward opening balances.
    let journals = ctx.journals(1).await;
    assert_eq!(journals.len(), 1);
    assert_eq!(journals[0]["kind"], "tb_import");
    assert_eq!(journals[0]["date"], "2026-03-31");
    let lines = journals[0]["lines"].as_array().unwrap();
    let line = |code: &str| {
        lines
            .iter()
            .find(|l| l["account"] == code)
            .map(|l| l["amount"].clone())
    };
    // Share capital didn't move, so it's not in the journal; retained earnings came from rollover.
    assert_eq!(line("950"), None);
    assert_eq!(line("960"), None);
    // The bank moved from 38,316.22 to 48,513.45.
    assert_eq!(line("600"), Some(json!(1_019_723)));

    let client = ctx
        .server
        .get_json(&format!("/api/clients/{}", ctx.client_id), &ctx.cookie)
        .await;
    assert_eq!(client["years"][1]["books_source"], "tb_import");

    // As in the M1 snapshots, FY2025 is treated as finalised (no finalise command until M5).
    {
        let mut w = ctx.server.state.store.writer().await;
        acct_store::sqlx::query("UPDATE client_years SET status = 'finalised' WHERE id = ?")
            .bind(&ctx.years[0])
            .execute(&mut *w)
            .await
            .unwrap();
    }
    for (year, snap) in [FY2025, FY2026].iter().enumerate() {
        let doc = ctx
            .server
            .get_json(
                &format!("/api/years/{}/report", ctx.years[year]),
                &ctx.cookie,
            )
            .await;
        let doc: ReportDoc = serde_json::from_value(doc).unwrap();
        assert_eq!(
            serde_json::to_string_pretty(&doc).unwrap(),
            snapshot_body(snap)
        );
    }
}

#[tokio::test]
async fn reimporting_keeps_adjustments_and_an_identical_tb_posts_nothing() {
    let ctx = Ctx::new().await;
    let csv = fixture_tb_csv(0);
    let (_, first) = ctx.import(0, &csv).await;
    let import_id = first["entity_id"].as_str().unwrap().to_owned();
    // An adjustment: 100.00 of general expenses reclassified to repairs.
    let adjustment = ctx
        .post(
            0,
            "2025-03-31",
            json!([
                { "account": "235", "amount": 10_000 },
                { "account": "290", "amount": -10_000 },
            ]),
        )
        .await;

    // The same TB again: accepted, but nothing is posted.
    let preview = ctx.preview(0, &csv).await;
    assert_eq!(preview["unchanged"], true);
    assert_eq!(preview["replaces_journal_id"], json!(import_id));
    let (status, again) = ctx.import(0, &csv).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["entity_id"], json!(null));
    assert_eq!(ctx.journals(0).await.len(), 2);

    // A changed TB: the old import is reversed and a new one posted; the adjustment stays.
    let changed = with_balance(&with_balance(&csv, "600", "38,416.22"), "610", "8,422.25");
    let preview = ctx.preview(0, &changed).await;
    assert_eq!(preview["unchanged"], false);
    let (status, body) = ctx.import(0, &changed).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let journals = ctx.journals(0).await;
    assert_eq!(journals.len(), 4);
    assert_eq!(journals[0]["id"], json!(import_id));
    assert_eq!(journals[1]["id"], json!(adjustment));
    assert_eq!(journals[1]["reversed_by"], json!(null));
    assert_eq!(journals[2]["reverses_journal_id"], json!(import_id));
    assert_eq!(journals[2]["kind"], "tb_import");
    assert_eq!(journals[3]["id"], body["entity_id"]);
    // Closing balances are the new TB plus the adjustment.
    assert_eq!(ctx.closing(0, "600").await, 3_841_622);
    assert_eq!(ctx.closing(0, "610").await, 842_225);
    assert_eq!(ctx.closing(0, "235").await, 81_173 + 10_000);
    assert_eq!(ctx.closing(0, "290").await, 57_953 - 10_000);

    // System journals can't be reversed by hand.
    let (status, body) = ctx
        .server
        .command(
            &ctx.cookie,
            "reverse_journal",
            json!({ "journal_id": journals[3]["id"] }),
        )
        .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "system_journal");
}

#[tokio::test]
async fn the_preview_flags_a_retained_earnings_gap() {
    let ctx = Ctx::new().await;
    ctx.import(0, &fixture_tb_csv(0)).await;
    let csv = fixture_tb_csv(1);
    let preview = ctx.preview(1, &csv).await;
    assert_eq!(preview["retained_earnings_gap"], json!(null));
    ctx.import(1, &csv).await;

    // The practice adds 500.00 of depreciation to last year, which the client never posts.
    ctx.post(
        0,
        "2025-03-31",
        json!([
            { "account": "210", "amount": 50_000 },
            { "account": "705", "amount": -50_000 },
        ]),
    )
    .await;
    let preview = ctx.preview(1, &csv).await;
    assert_eq!(
        preview["retained_earnings_gap"],
        json!({
            "account": "960",
            "imported": -2_688_495,
            "rolled_forward": -2_638_495,
            "difference": -50_000,
        })
    );
    assert_eq!(preview["problems"], json!([]));
    assert_eq!(preview["unchanged"], false);
}

#[tokio::test]
async fn bad_files_and_accounts_are_reported_and_block_the_import() {
    let ctx = Ctx::new().await;
    let preview = ctx.preview(0, "code,amount\n600,10\n100,-9\n").await;
    assert_eq!(preview["file_errors"][0]["code"], "unbalanced");
    assert_eq!(preview["rows"], json!([]));

    // Unknown accounts matter only when they have a balance.
    let csv = "code,name,debit,credit\n600,Bank,10,\n999.9,New,,10\n123,Unused,,\n";
    let preview = ctx.preview(0, csv).await;
    assert_eq!(
        preview["problems"],
        json!([{ "code": "unknown_account", "account": "999.9" }])
    );

    let before = ctx.server.get_json("/api/sync", &ctx.cookie).await["last_seq"].clone();
    let (status, body) = ctx.import(0, csv).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["code"], "tb_import_rejected");
    assert_eq!(body["details"][0]["code"], "unknown_account");
    assert_eq!(ctx.journals(0).await.len(), 0);
    assert_eq!(
        ctx.server.get_json("/api/sync", &ctx.cookie).await["last_seq"],
        before
    );

    // A viewer can't preview.
    let val = ctx.server.login("val").await;
    let (status, _) = ctx.preview_as(&val, 0, csv).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_year_coded_from_the_bank_cant_take_a_tb() {
    let ctx = Ctx::new().await;
    // Bank coding arrives in M6, so set the year's books source directly.
    {
        let mut w = ctx.server.state.store.writer().await;
        acct_store::years::set_books_source(
            &mut w,
            &ctx.years[0],
            acct_store::years::BooksSource::BankCoding,
        )
        .await
        .unwrap();
    }
    let (status, body) = ctx.import(0, &fixture_tb_csv(0)).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        body["details"],
        json!([{ "code": "books_from_bank_coding" }])
    );
}
