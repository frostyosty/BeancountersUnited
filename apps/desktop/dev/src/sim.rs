//! The "master dev" sync simulator (PLAN.md backlog): several simulated clients log in to one
//! master over HTTP, post journals at the same time, and follow `/api/sync`. It checks they all
//! converge on the same state, and that the ledger moved by exactly what was posted.

use std::collections::BTreeSet;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::task::JoinSet;

#[derive(Debug, Clone, Copy)]
pub struct SimConfig {
    pub clients: u32,
    pub journals_each: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct Check {
    pub passed: bool,
    pub what: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimReport {
    pub passed: bool,
    pub checks: Vec<Check>,
}

/// One simulated client: its own cookie jar, so its own login.
struct Client {
    http: reqwest::Client,
    base: String,
}

impl Client {
    async fn login(base: &str, username: &str, password: &str) -> Result<Client, String> {
        let http = reqwest::Client::builder()
            .cookie_store(true)
            .no_proxy()
            .build()
            .map_err(|e| e.to_string())?;
        let client = Client {
            http,
            base: base.to_owned(),
        };
        client
            .post(
                "/api/login",
                json!({ "username": username, "password": password }),
            )
            .await?;
        Ok(client)
    }

    async fn get(&self, path: &str) -> Result<Value, String> {
        let r = self
            .http
            .get(format!("{}{path}", self.base))
            .send()
            .await
            .map_err(|e| format!("GET {path}: {e}"))?;
        read(r, path).await
    }

    async fn post(&self, path: &str, body: Value) -> Result<Value, String> {
        let r = self
            .http
            .post(format!("{}{path}", self.base))
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("POST {path}: {e}"))?;
        read(r, path).await
    }

    /// Follows the sync feed from `after` to its end; returns every change's seq.
    async fn drain_sync(&self, mut after: i64) -> Result<Vec<i64>, String> {
        let mut seqs = Vec::new();
        loop {
            let feed = self.get(&format!("/api/sync?after={after}")).await?;
            let changes = feed["changes"].as_array().cloned().unwrap_or_default();
            if changes.is_empty() {
                return Ok(seqs);
            }
            seqs.extend(changes.iter().filter_map(|c| c["seq"].as_i64()));
            after = feed["last_seq"]
                .as_i64()
                .ok_or("the sync feed has no last_seq")?;
        }
    }
}

async fn read(r: reqwest::Response, path: &str) -> Result<Value, String> {
    let status = r.status();
    let body: Value = r.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(format!("{path}: {status} {}", body["message"]))
    }
}

/// What every simulated client needs to post journals.
#[derive(Clone)]
struct Target {
    year_id: String,
    date: String,
    debit: String,
    credit: String,
}

async fn pick_target(c: &Client) -> Result<Target, String> {
    let clients = c.get("/api/clients").await?;
    let client_id = clients[0]["id"]
        .as_str()
        .ok_or("the master has no clients to post to")?;
    let detail = c.get(&format!("/api/clients/{client_id}")).await?;
    let year = detail["years"]
        .as_array()
        .and_then(|ys| ys.iter().rev().find(|y| y["status"] == "open"))
        .ok_or("the client has no open year")?;
    let chart = c.get(&format!("/api/clients/{client_id}/chart")).await?;
    let active: Vec<&str> = chart
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["active"] == true)
        .filter_map(|a| a["code"].as_str())
        .collect();
    let [debit, credit, ..] = active[..] else {
        return Err("the client's chart needs two active accounts".into());
    };
    Ok(Target {
        year_id: year["id"].as_str().unwrap_or_default().to_owned(),
        date: year["start"].as_str().unwrap_or_default().to_owned(),
        debit: debit.to_owned(),
        credit: credit.to_owned(),
    })
}

fn closing(tb: &Value, account: &str) -> i64 {
    tb["closing"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|l| l["account"] == account)
        .and_then(|l| l["balance"].as_i64())
        .unwrap_or(0)
}

/// A simulated client after it has posted its journals.
struct Posted {
    client: Client,
    accepted: Vec<i64>,
    seen: Vec<i64>,
    cursor: i64,
    replay_matched: bool,
}

async fn post_journals(
    base: String,
    username: String,
    password: String,
    target: Target,
    index: u32,
    journals: u32,
    start_seq: i64,
) -> Result<Posted, String> {
    let client = Client::login(&base, &username, &password).await?;
    let mut accepted = Vec::new();
    let mut seen = Vec::new();
    let mut cursor = start_seq;
    let mut first: Option<(Value, i64)> = None;
    for n in 0..journals {
        // Distinct amounts per client and journal, in cents.
        let amount = i64::from((index + 1) * 1000 + n + 1);
        let envelope = json!({
            "id": uuid::Uuid::now_v7().to_string(),
            "kind": "post_journal",
            "payload": {
                "client_year_id": target.year_id,
                "date": target.date,
                "narration": format!("Simulated client {} journal {}", index + 1, n + 1),
                "lines": [
                    { "account": target.debit, "amount": amount },
                    { "account": target.credit, "amount": -amount },
                ],
            },
        });
        let result = client.post("/api/commands", envelope.clone()).await?;
        let seq = result["seq"]
            .as_i64()
            .ok_or("an accepted command has no seq")?;
        accepted.push(seq);
        first.get_or_insert((envelope, seq));
        // Follow the feed between posts, as a live client would.
        let new = client.drain_sync(cursor).await?;
        cursor = new.last().copied().unwrap_or(cursor);
        seen.extend(new);
    }
    // Resubmitting a command id must return the original result, not post again.
    let replay_matched = match first {
        Some((envelope, seq)) => {
            client.post("/api/commands", envelope).await?["seq"].as_i64() == Some(seq)
        }
        None => true,
    };
    Ok(Posted {
        client,
        accepted,
        seen,
        cursor,
        replay_matched,
    })
}

fn check(checks: &mut Vec<Check>, passed: bool, what: String) {
    checks.push(Check { passed, what });
}

/// Runs the simulation against the master at `base`, logging every client in as `username`.
pub async fn run(
    base: &str,
    username: &str,
    password: &str,
    config: SimConfig,
) -> Result<SimReport, String> {
    let observer = Client::login(base, username, password).await?;
    let target = pick_target(&observer).await?;
    let start_seq = observer.drain_sync(0).await?.last().copied().unwrap_or(0);
    let tb_path = format!("/api/years/{}/tb", target.year_id);
    let journals_path = format!("/api/years/{}/journals", target.year_id);
    let tb_before = observer.get(&tb_path).await?;
    let journals_before = observer
        .get(&journals_path)
        .await?
        .as_array()
        .map_or(0, Vec::len);

    let mut tasks = JoinSet::new();
    for index in 0..config.clients {
        tasks.spawn(post_journals(
            base.to_owned(),
            username.to_owned(),
            password.to_owned(),
            target.clone(),
            index,
            config.journals_each,
            start_seq,
        ));
    }
    let mut posted = Vec::new();
    while let Some(result) = tasks.join_next().await {
        posted.push(result.map_err(|e| e.to_string())??);
    }

    // Everyone has finished posting: each client catches up and reads the ledger.
    let mut finals = Vec::new();
    for p in &mut posted {
        let rest = p.client.drain_sync(p.cursor).await?;
        p.seen.extend(rest);
        let tb = p.client.get(&tb_path).await?;
        let journals = p
            .client
            .get(&journals_path)
            .await?
            .as_array()
            .map_or(0, Vec::len);
        finals.push((tb, journals));
    }

    let expected = config.clients as usize * config.journals_each as usize;
    let accepted: BTreeSet<i64> = posted
        .iter()
        .flat_map(|p| p.accepted.iter().copied())
        .collect();
    let mut checks = Vec::new();
    check(
        &mut checks,
        accepted.len() == expected,
        format!(
            "{} clients posted {} journals each: {} of {expected} accepted with distinct seqs",
            config.clients,
            config.journals_each,
            accepted.len()
        ),
    );
    let feeds_agree = posted.windows(2).all(|w| w[0].seen == w[1].seen);
    let feed: BTreeSet<i64> = posted
        .first()
        .map(|p| p.seen.iter().copied().collect())
        .unwrap_or_default();
    check(
        &mut checks,
        feeds_agree && accepted.is_subset(&feed),
        "every client's sync feed saw the same changes, in the same order, including every post"
            .into(),
    );
    check(
        &mut checks,
        posted.iter().all(|p| p.replay_matched),
        "resubmitting a command id returned the original result".into(),
    );
    let tbs_agree = finals.windows(2).all(|w| w[0] == w[1]);
    check(
        &mut checks,
        tbs_agree,
        "every client read the same trial balance and journal count".into(),
    );
    if let Some((tb, journals)) = finals.first() {
        let posted_cents: i64 = (0..config.clients)
            .flat_map(|i| (0..config.journals_each).map(move |n| i64::from((i + 1) * 1000 + n + 1)))
            .sum();
        let moved = closing(tb, &target.debit) - closing(&tb_before, &target.debit);
        let moved_back = closing(&tb_before, &target.credit) - closing(tb, &target.credit);
        check(
            &mut checks,
            moved == posted_cents && moved_back == posted_cents,
            format!(
                "accounts {} and {} moved by exactly the {posted_cents} cents posted",
                target.debit, target.credit
            ),
        );
        check(
            &mut checks,
            *journals == journals_before + expected,
            format!("the year has {expected} more journals ({journals_before} → {journals})"),
        );
    }
    Ok(SimReport {
        passed: checks.iter().all(|c| c.passed),
        checks,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use acct_server::fixtures::{self, DEV_PASSWORD};

    #[tokio::test(flavor = "multi_thread")]
    async fn simulated_clients_converge_on_the_fixture_company() {
        let dir = tempfile::tempdir().unwrap();
        let server = acct_desktop::server::start(
            &dir.path().join("acct.db"),
            "127.0.0.1:0".parse().unwrap(),
        )
        .await
        .unwrap();
        fixtures::load(&server.store).await.unwrap();
        let config = SimConfig {
            clients: 4,
            journals_each: 5,
        };
        let report = run(&server.local_url(), "staff", DEV_PASSWORD, config)
            .await
            .unwrap();
        assert!(report.passed, "{report:#?}");
        assert_eq!(report.checks.len(), 6);
    }
}
