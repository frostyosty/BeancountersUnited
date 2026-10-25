//! M15's analysis reads: the GL listing (with matched reversals hidden by default) and expenses by
//! category, over HTTP. Accountants see account codes; business owners never do.

mod common;

use std::collections::BTreeMap;

use axum::http::{StatusCode, header};
use common::{PASSWORD, Server, new_id, post_json, split};
use serde_json::{Value, json};

const ST_CHART: &str = include_str!("../../../fixtures/practice/sole-trader-chart.json");
const ST_TEMPLATE: &str = include_str!("../../../fixtures/practice/sole-trader-template.json");
const ST_MAPPING: &str = include_str!("../../../fixtures/practice/sole-trader-mapping.json");
const KOWHAI: &[u8] =
    include_bytes!("../../../fixtures/bank-statements/kowhai-business-2025-08.csv");

fn entries(account: &Value) -> &Vec<Value> {
    account["entries"].as_array().unwrap()
}

/// Every GL account's closing balance, by code.
fn closings(gl: &Value) -> BTreeMap<String, i64> {
    gl["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["code"].as_str().unwrap().to_owned(),
                a["closing"].as_i64().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn the_gl_hides_matched_reversals_and_keeps_balances() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let f = server.load_fixture(&boss, &boss).await;
    let year = &f.year_ids[1];
    let gl_uri = format!("/api/years/{year}/gl");

    // Viewers can read it, with codes, and closing balances agree with the TB.
    let val = server.login("val").await;
    let before = server.get_json(&gl_uri, &val).await;
    let tb = server
        .get_json(&format!("/api/years/{year}/tb"), &val)
        .await;
    let tb_closing: BTreeMap<String, i64> = tb["closing"]
        .as_array()
        .unwrap()
        .iter()
        .map(|l| {
            (
                l["account"].as_str().unwrap().to_owned(),
                l["balance"].as_i64().unwrap(),
            )
        })
        .collect();
    let mut gl_closing = closings(&before);
    gl_closing.retain(|_, b| *b != 0);
    assert_eq!(gl_closing, tb_closing);
    // Retained earnings opens with year 1's profit, and each running balance follows on.
    let re = before["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|a| a["code"] == "960")
        .unwrap();
    assert_eq!(re["opening"], -2_688_495);
    assert!(!re["name"].as_str().unwrap().is_empty());
    for account in before["accounts"].as_array().unwrap() {
        let mut balance = account["opening"].as_i64().unwrap();
        for e in entries(account) {
            balance += e["amount"].as_i64().unwrap();
            assert_eq!(e["balance"].as_i64().unwrap(), balance, "{account}");
            assert_eq!(e["matched_reversal"], false);
        }
        assert_eq!(account["closing"].as_i64().unwrap(), balance);
    }

    // Reverse the first journal: it and its reversal are a matched pair.
    let journals = server
        .get_json(&format!("/api/years/{year}/journals"), &boss)
        .await;
    let first = journals[0]["id"].as_str().unwrap().to_owned();
    let reversal = server
        .ok(&boss, "reverse_journal", json!({ "journal_id": first }))
        .await;
    let after = server.get_json(&gl_uri, &boss).await;
    let flagged = |gl: &Value, id: &str| -> Vec<bool> {
        gl["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|a| entries(a).iter())
            .filter(|e| e["journal_id"] == id)
            .map(|e| e["matched_reversal"].as_bool().unwrap())
            .collect()
    };
    let hidden_first = flagged(&after, &first);
    assert!(!hidden_first.is_empty() && hidden_first.iter().all(|&h| h));
    assert!(flagged(&after, &reversal).iter().all(|&h| h));
    // On every account the hidden rows net to nothing, so leaving them out of the running balance
    // or not gives the same closing balance.
    for account in after["accounts"].as_array().unwrap() {
        let hidden: i64 = entries(account)
            .iter()
            .filter(|e| e["matched_reversal"] == true)
            .map(|e| e["amount"].as_i64().unwrap())
            .sum();
        assert_eq!(hidden, 0, "{account}");
    }

    // Reversing the reversal: the original shows again, and the two reversals pair up.
    let again = server
        .ok(&boss, "reverse_journal", json!({ "journal_id": reversal }))
        .await;
    let last = server.get_json(&gl_uri, &boss).await;
    assert!(flagged(&last, &first).iter().all(|&h| !h));
    assert!(flagged(&last, &reversal).iter().all(|&h| h));
    assert!(flagged(&last, &again).iter().all(|&h| h));
    assert_eq!(closings(&last), closings(&before));
}

#[tokio::test]
async fn expense_analysis_matches_the_statements() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let f = server.load_fixture(&boss, &boss).await;
    let year = &f.year_ids[1];

    let analysis = server
        .get_json(&format!("/api/years/{year}/analysis"), &boss)
        .await;
    assert_eq!(analysis["comparatives"], "unfinalised");
    let report = server
        .get_json(&format!("/api/years/{year}/report"), &boss)
        .await;
    let rows: Vec<&Value> = report["statements"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|s| s["rows"].as_array().unwrap())
        .collect();

    let categories = analysis["categories"].as_array().unwrap();
    assert!(!categories.is_empty());
    let (mut current, mut prior) = (0, 0);
    for c in categories {
        // Each category is a statement line, with the same label and the same accounts.
        let row = rows
            .iter()
            .find(|r| r["key"] == c["line"])
            .unwrap_or_else(|| panic!("{} isn't a statement line", c["line"]));
        assert_eq!(row["label"], c["label"]);
        let mut by_code: BTreeMap<&str, (i64, i64)> = BTreeMap::new();
        for a in row["accounts"].as_array().unwrap() {
            by_code.insert(
                a["code"].as_str().unwrap(),
                (a["current"].as_i64().unwrap(), a["prior"].as_i64().unwrap()),
            );
        }
        let m = &c["movement"];
        let (mut cur, mut pri) = (0, 0);
        for a in c["accounts"].as_array().unwrap() {
            let code = a["code"].as_str().expect("accountants see codes");
            let am = &a["movement"];
            assert_eq!(
                by_code.get(code),
                Some(&(
                    am["current"].as_i64().unwrap(),
                    am["prior"].as_i64().unwrap()
                )),
                "{code}"
            );
            cur += am["current"].as_i64().unwrap();
            pri += am["prior"].as_i64().unwrap();
        }
        assert_eq!(m["current"].as_i64().unwrap(), cur);
        assert_eq!(m["prior"].as_i64().unwrap(), pri);
        assert_eq!(m["change"].as_i64().unwrap(), cur - pri);
        // Basis points, integers only.
        match m["change_bp"].as_i64() {
            Some(bp) => {
                assert_ne!(pri, 0);
                let exact = (cur - pri) * 10_000;
                assert!((bp * pri.abs() - exact).abs() <= pri.abs(), "{m}");
            }
            None => assert_eq!(pri, 0),
        }
        current += cur;
        prior += pri;
    }
    assert_eq!(analysis["total"]["current"].as_i64().unwrap(), current);
    assert_eq!(analysis["total"]["prior"].as_i64().unwrap(), prior);

    // The first year has nothing to compare against.
    let first = server
        .get_json(&format!("/api/years/{}/analysis", f.year_ids[0]), &boss)
        .await;
    assert_eq!(first["comparatives"], "none");
    assert_eq!(first["total"]["prior"], 0);
    assert_eq!(first["total"]["change_bp"], Value::Null);
}

#[tokio::test]
async fn owners_never_see_account_codes() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let accounts: Value = serde_json::from_str(ST_CHART).unwrap();
    server
        .ok(
            &boss,
            "create_master_chart",
            json!({ "entity_type": "sole_trader", "name": "Sole trader", "accounts": accounts }),
        )
        .await;
    let template: Value = serde_json::from_str(ST_TEMPLATE).unwrap();
    let template_id = server
        .ok(
            &boss,
            "create_template",
            json!({ "entity_type": "sole_trader", "name": "Sole trader", "body": template }),
        )
        .await;
    let mapping: Value = serde_json::from_str(ST_MAPPING).unwrap();
    server
        .ok(
            &boss,
            "create_mapping",
            json!({ "template_id": template_id, "name": "Sole trader", "body": mapping }),
        )
        .await;

    let response = server
        .send(post_json(
            "/api/signup",
            None,
            &json!({
                "id": new_id(),
                "email": "ana@example.nz",
                "display_name": "ana",
                "password": PASSWORD,
                "business_name": "Ana's Gardens",
                "start_date": "2025-04-01",
            }),
        ))
        .await;
    let cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .map(|c| c.to_str().unwrap().split(';').next().unwrap().to_owned())
        .expect("sign-up signs you in");
    let (status, body) = split(response).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let biz = body["business_id"].as_str().unwrap().to_owned();

    use base64_engine::encode;
    done(
        &server,
        &cookie,
        "import_statement",
        json!({
            "client_id": biz,
            "file_name": "kowhai-business-2025-08.csv",
            "content_base64": encode(KOWHAI),
        }),
    )
    .await;
    // Ana sorts a withdrawal as an expense, which reverses and reposts its bank-line journal.
    let queue = server
        .get_json(&format!("/api/businesses/{biz}/save-tax"), &cookie)
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
        &cookie,
        "code_bank_line",
        json!({
            "bank_line_id": line["bank_line_id"],
            "coding": { "direction": "out", "kind": "expense",
                        "account": "150", "gst": "standard" },
        }),
    )
    .await;

    let client = server
        .get_json(&format!("/api/clients/{biz}"), &cookie)
        .await;
    let year = client["years"][0]["id"].as_str().unwrap().to_owned();

    let gl = server
        .get_json(&format!("/api/years/{year}/gl"), &cookie)
        .await;
    let gl_accounts = gl["accounts"].as_array().unwrap();
    assert!(!gl_accounts.is_empty());
    for a in gl_accounts {
        assert_eq!(a["code"], Value::Null, "{a}");
        assert!(!a["name"].as_str().unwrap().is_empty());
    }
    // The recoded line's original posting and its reversal are a matched pair.
    let hidden = gl_accounts
        .iter()
        .flat_map(|a| entries(a).iter())
        .filter(|e| e["matched_reversal"] == true)
        .count();
    assert!(hidden >= 2, "{gl}");
    assert!(!gl.to_string().contains("\"150\""));

    let analysis = server
        .get_json(&format!("/api/years/{year}/analysis"), &cookie)
        .await;
    let accounts: Vec<&Value> = analysis["categories"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|c| c["accounts"].as_array().unwrap())
        .collect();
    assert!(
        accounts
            .iter()
            .any(|a| a["name"] == "Purchases and materials"),
        "{analysis}"
    );
    assert!(accounts.iter().all(|a| a["code"] == Value::Null));
}

/// Submits a command that must succeed, whether or not it creates anything.
async fn done(server: &Server, cookie: &str, kind: &str, payload: Value) {
    let (status, body) = server.command(cookie, kind, payload).await;
    assert_eq!(status, StatusCode::OK, "{kind}: {body}");
}

/// Standard base64, for the statement upload.
mod base64_engine {
    pub fn encode(bytes: &[u8]) -> String {
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
}
