//! M12 backups: `acctd backup` copies a live database consistently, a restore brings back an
//! identical `command_log`, and a backup never overwrites a file.

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use acct_store::Store;
use acct_store::backup::{self, LogSummary};
use acct_store::log::{self, LoggedCommand};
use acct_store::sqlx::{self, Connection};
use axum::http::StatusCode;
use common::{CLIENT, Server, post_json, split};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

async fn db_path(server: &Server) -> PathBuf {
    let mut conn = server.state.store.reader().await.unwrap();
    let (file,): (String,) =
        sqlx::query_as("SELECT file FROM pragma_database_list WHERE name = 'main'")
            .fetch_one(&mut *conn)
            .await
            .unwrap();
    PathBuf::from(file)
}

async fn whole_log(conn: &mut acct_store::SqliteConnection) -> Vec<LoggedCommand> {
    log::after(conn, 0, i64::MAX).await.unwrap()
}

/// What `acctd restore-check` computes, through the same store function.
async fn summary(path: &Path) -> (LogSummary, String) {
    let mut conn = backup::open_read_only(path).await.unwrap();
    let mut hasher = Sha256::new();
    let summary = backup::summarise_log(&mut conn, &mut |b| hasher.update(b))
        .await
        .unwrap();
    conn.close().await.unwrap();
    let hash = hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    (summary, hash)
}

fn acctd(args: &[&str], db: &Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_acctd"))
        .args(args)
        .env("ACCT_DB", db)
        .env("RUST_LOG", "warn")
        .output()
        .unwrap()
}

/// The lines of `acctd restore-check` that the drill compares (everything but the path).
fn drill_lines(output: &std::process::Output) -> Vec<String> {
    assert!(output.status.success(), "{output:?}");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter(|l| !l.starts_with("database:"))
        .map(str::to_owned)
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_backup_taken_while_writing_restores_an_identical_command_log() {
    let server = Server::new().await;
    let boss = server.login("boss").await;
    let sam = server.login("sam").await;
    server.load_fixture(&boss, &sam).await;
    let live = db_path(&server).await;
    let fixture_seq = {
        let mut conn = server.state.store.reader().await.unwrap();
        log::head_seq(&mut conn).await.unwrap()
    };

    // A writer that keeps committing while the backup runs.
    let client: Value = serde_json::from_str(CLIENT).unwrap();
    let app = server.app();
    let writer = tokio::spawn(async move {
        for i in 0..40 {
            let body = json!({
                "id": common::new_id(),
                "kind": "create_client",
                "payload": {
                    "name": format!("Busy Client {i}"),
                    "entity_type": client["entity_type"],
                    "retained_earnings": client["retained_earnings"],
                    "rounding_priority": client["rounding_priority"],
                },
            });
            let response = app
                .clone()
                .oneshot(post_json("/api/commands", Some(&sam), &body))
                .await
                .unwrap();
            let (status, body) = split(response).await;
            assert_eq!(status, StatusCode::OK, "{body}");
        }
    });
    // Let the writer get going, then back up from a connection of our own, as `acctd backup` does.
    loop {
        let mut conn = server.state.store.reader().await.unwrap();
        if log::head_seq(&mut conn).await.unwrap() >= fixture_seq + 3 {
            break;
        }
        drop(conn);
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let dir = tempfile::TempDir::new().unwrap();
    let during = dir.path().join("during.db");
    let mut source = backup::open_read_only(&live).await.unwrap();
    let backed_up_seq = backup::backup_into(&mut source, &during).await.unwrap();
    source.close().await.unwrap();
    writer.await.unwrap();
    assert!(backed_up_seq > fixture_seq);

    // Restore: copy the backup into place and open it the way the server does.
    let restored_dir = dir.path().join("restored");
    std::fs::create_dir(&restored_dir).unwrap();
    let restored = restored_dir.join("acct.db");
    std::fs::copy(&during, &restored).unwrap();
    let restored_store = Store::open(&restored).await.unwrap();
    let restored_log = whole_log(&mut restored_store.reader().await.unwrap()).await;
    restored_store.close().await.unwrap();

    // The snapshot is a clean prefix of the live log: every command up to its seq, nothing torn.
    let live_log = whole_log(&mut server.state.store.reader().await.unwrap()).await;
    assert_eq!(restored_log.len() as i64, backed_up_seq);
    assert_eq!(restored_log[..], live_log[..restored_log.len()]);
    assert!(live_log.len() > restored_log.len(), "the writer kept going");

    // With the writer stopped, a fresh backup's restore-check matches the live database exactly.
    let after = dir.path().join("after.db");
    let output = acctd(&["backup", after.to_str().unwrap()], &live);
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(&format!("latest seq: {}", live_log.len())),
        "{stdout}"
    );
    let (live_summary, live_hash) = summary(&live).await;
    let (backup_summary, backup_hash) = summary(&after).await;
    assert_eq!(live_summary.rows, live_log.len() as i64);
    assert_eq!(backup_summary, live_summary);
    assert_eq!(backup_hash, live_hash);
    let check_backup = drill_lines(&acctd(&["restore-check", after.to_str().unwrap()], &live));
    let check_live = drill_lines(&acctd(&["restore-check", live.to_str().unwrap()], &live));
    assert_eq!(check_backup, check_live);
    assert!(check_backup.contains(&format!("command_log hash: {live_hash}")));
    assert!(check_backup.contains(&"integrity:        ok".to_owned()));

    // And the earlier snapshot differs, as it should: it stops at an earlier seq.
    let (during_summary, during_hash) = summary(&during).await;
    assert_eq!(during_summary.head_seq, backed_up_seq);
    assert_ne!(during_hash, live_hash);
}

#[tokio::test]
async fn a_backup_never_overwrites_a_file() {
    let server = Server::new().await;
    let live = db_path(&server).await;
    let dir = tempfile::TempDir::new().unwrap();
    let dest = dir.path().join("existing.db");
    std::fs::write(&dest, b"keep me").unwrap();

    let mut source = backup::open_read_only(&live).await.unwrap();
    let err = backup::backup_into(&mut source, &dest).await.unwrap_err();
    source.close().await.unwrap();
    assert!(matches!(err, backup::BackupError::Exists(_)), "{err}");

    let output = acctd(&["backup", dest.to_str().unwrap()], &live);
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("already exists"),
        "{output:?}"
    );
    assert_eq!(std::fs::read(&dest).unwrap(), b"keep me");
}

#[tokio::test]
async fn restore_check_refuses_a_missing_file() {
    let dir = tempfile::TempDir::new().unwrap();
    let missing = dir.path().join("nope.db");
    let output = acctd(&["restore-check", missing.to_str().unwrap()], &missing);
    assert!(!output.status.success());
    assert!(
        !missing.exists(),
        "restore-check must not create a database"
    );
}
