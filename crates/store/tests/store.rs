//! Runs every repository query against a real SQLite database (ADR 004).

use acct_core::{Account, AccountCode, Chart, ClientYear, Journal, Mapping, Template};
use acct_store::charts::MasterChart;
use acct_store::clients::Client;
use acct_store::journals::{JournalKind, StoredJournal};
use acct_store::log::LoggedCommand;
use acct_store::practice::Practice;
use acct_store::templates::{MappingInfo, TemplateInfo};
use acct_store::users::{Role, User};
use acct_store::years::{BooksSource, StoredYear, YearStatus};
use acct_store::{
    Store, StoreError, charts, clients, journals, log, new_id, practice, templates, users, years,
};
use chrono::{TimeZone, Utc};
use sqlx::Connection;
use tempfile::TempDir;

const CHART: &str = include_str!("../../../fixtures/practice/company-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/company-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/company-mapping.json");
const CLIENT: &str = include_str!("../../../fixtures/clients/example-widgets.json");

async fn open() -> (TempDir, Store) {
    let dir = TempDir::new().unwrap();
    let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
    (dir, store)
}

fn fixture_chart() -> Chart {
    serde_json::from_str(CHART).unwrap()
}

fn fixture_journals(year: usize) -> Vec<Journal> {
    let client: serde_json::Value = serde_json::from_str(CLIENT).unwrap();
    serde_json::from_value(client["years"][year]["journals"].clone()).unwrap()
}

fn code(s: &str) -> AccountCode {
    s.parse().unwrap()
}

fn is_constraint_error(e: &StoreError) -> bool {
    matches!(e, StoreError::Sqlx(sqlx::Error::Database(d)) if d.message().contains("constraint"))
}

/// A client with the fixture chart and one year pinned to version 1 of the fixture template and
/// mapping. Returns (client id, year id).
async fn seed_client(store: &Store) -> (String, String) {
    let mut w = store.writer().await;
    let template_id = new_id();
    templates::insert_template(
        &mut w,
        &TemplateInfo {
            id: template_id.clone(),
            entity_type: "company".into(),
            name: "Company".into(),
            created_seq: 1,
        },
    )
    .await
    .unwrap();
    let tv = new_id();
    let template: Template = serde_json::from_str(TEMPLATE).unwrap();
    templates::add_template_version(&mut w, &tv, &template_id, &template, 1)
        .await
        .unwrap();
    let mapping_id = new_id();
    templates::insert_mapping(
        &mut w,
        &MappingInfo {
            id: mapping_id.clone(),
            template_id,
            name: "Company".into(),
            created_seq: 1,
        },
    )
    .await
    .unwrap();
    let mv = new_id();
    let mapping: Mapping = serde_json::from_str(MAPPING).unwrap();
    templates::add_mapping_version(&mut w, &mv, &mapping_id, &mapping, 1)
        .await
        .unwrap();

    let client_id = new_id();
    clients::insert(
        &mut w,
        &Client {
            id: client_id.clone(),
            name: "Example Widgets Limited".into(),
            entity_type: "company".into(),
            retained_earnings: code("960"),
            rounding_priority: vec![code("235"), code("205")],
            created_seq: 2,
        },
    )
    .await
    .unwrap();
    for a in fixture_chart().accounts() {
        clients::insert_account(&mut w, &client_id, a)
            .await
            .unwrap();
    }
    let year_id = new_id();
    years::insert(
        &mut w,
        &StoredYear {
            id: year_id.clone(),
            client_id: client_id.clone(),
            year: ClientYear::new(date("2024-04-01"), date("2025-03-31")).unwrap(),
            template_version_id: tv,
            mapping_version_id: mv,
            books_source: None,
            status: YearStatus::Open,
            created_seq: 3,
        },
    )
    .await
    .unwrap();
    (client_id, year_id)
}

fn date(s: &str) -> chrono::NaiveDate {
    s.parse().unwrap()
}

#[tokio::test]
async fn open_migrates_and_reopens() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("acct.db");
    let store = Store::open(&path).await.unwrap();
    let mut r = store.reader().await.unwrap();
    let (mode,): (String,) = sqlx::query_as("PRAGMA journal_mode")
        .fetch_one(&mut *r)
        .await
        .unwrap();
    assert_eq!(mode, "wal");
    let (fk,): (i64,) = sqlx::query_as("PRAGMA foreign_keys")
        .fetch_one(&mut *r)
        .await
        .unwrap();
    assert_eq!(fk, 1);
    drop(r);
    store.close().await.unwrap();
    // Opening again finds the schema already applied.
    Store::open(&path).await.unwrap();
}

#[tokio::test]
async fn readers_cannot_write() {
    let (_dir, store) = open().await;
    let mut r = store.reader().await.unwrap();
    let err = practice::insert(
        &mut r,
        &Practice {
            name: "x".into(),
            created_seq: 1,
        },
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("readonly"), "{err}");
}

#[tokio::test]
async fn practice_is_a_single_row() {
    let (_dir, store) = open().await;
    let mut w = store.writer().await;
    assert_eq!(practice::get(&mut w).await.unwrap(), None);
    let p = Practice {
        name: "Example Practice".into(),
        created_seq: 1,
    };
    practice::insert(&mut w, &p).await.unwrap();
    assert_eq!(practice::get(&mut w).await.unwrap(), Some(p.clone()));
    assert!(is_constraint_error(
        &practice::insert(&mut w, &p).await.unwrap_err()
    ));
}

#[tokio::test]
async fn users_round_trip_and_usernames_ignore_case() {
    let (_dir, store) = open().await;
    let mut w = store.writer().await;
    assert_eq!(users::count(&mut w).await.unwrap(), 0);
    let u = User {
        id: new_id(),
        username: "Pat".into(),
        display_name: "Pat Example".into(),
        password_hash: "$argon2id$placeholder".into(),
        role: Role::Master,
        active: true,
        created_seq: 1,
    };
    users::insert(&mut w, &u).await.unwrap();
    assert_eq!(users::get(&mut w, &u.id).await.unwrap(), Some(u.clone()));
    assert_eq!(
        users::by_username(&mut w, "pat").await.unwrap(),
        Some(u.clone())
    );
    assert_eq!(users::count(&mut w).await.unwrap(), 1);
    let dup = User {
        id: new_id(),
        username: "PAT".into(),
        ..u
    };
    assert!(is_constraint_error(
        &users::insert(&mut w, &dup).await.unwrap_err()
    ));
}

#[tokio::test]
async fn command_log_appends_finds_and_feeds() {
    let (_dir, store) = open().await;
    let mut w = store.writer().await;
    assert_eq!(log::next_seq(&mut w).await.unwrap(), 1);
    let entry = |seq: i64, id: &str| LoggedCommand {
        seq,
        id: id.into(),
        kind: "create_client".into(),
        payload: "{}".into(),
        result: r#"{"ok":true}"#.into(),
        user_id: None,
        client_id: Some("c1".into()),
        client_year_id: None,
        at: Utc.with_ymd_and_hms(2026, 9, 23, 1, 2, 3).unwrap(),
    };
    log::append(&mut w, &entry(1, "a")).await.unwrap();
    log::append(&mut w, &entry(2, "b")).await.unwrap();
    assert_eq!(log::next_seq(&mut w).await.unwrap(), 3);
    assert_eq!(log::find(&mut w, "b").await.unwrap(), Some(entry(2, "b")));
    assert_eq!(log::find(&mut w, "z").await.unwrap(), None);
    let feed = log::after(&mut w, 0, 10).await.unwrap();
    assert_eq!(feed.iter().map(|e| e.seq).collect::<Vec<_>>(), [1, 2]);
    assert_eq!(
        log::after(&mut w, 1, 10).await.unwrap(),
        vec![entry(2, "b")]
    );
    assert_eq!(log::after(&mut w, 0, 1).await.unwrap().len(), 1);
    // The id is the idempotency key, so it can't be logged twice.
    assert!(is_constraint_error(
        &log::append(&mut w, &entry(3, "a")).await.unwrap_err()
    ));
}

#[tokio::test]
async fn master_chart_round_trips() {
    let (_dir, store) = open().await;
    let mut w = store.writer().await;
    let mc = MasterChart {
        id: new_id(),
        entity_type: "company".into(),
        name: "Company".into(),
        created_seq: 1,
        chart: fixture_chart(),
    };
    charts::insert(&mut w, &mc).await.unwrap();
    assert_eq!(
        charts::for_entity_type(&mut w, "company").await.unwrap(),
        Some(mc)
    );
    assert_eq!(
        charts::for_entity_type(&mut w, "trust").await.unwrap(),
        None
    );
}

#[tokio::test]
async fn clients_and_their_charts_round_trip() {
    let (_dir, store) = open().await;
    let (client_id, _) = seed_client(&store).await;
    let mut r = store.reader().await.unwrap();
    let client = clients::get(&mut r, &client_id).await.unwrap().unwrap();
    assert_eq!(client.retained_earnings, code("960"));
    assert_eq!(client.rounding_priority, vec![code("235"), code("205")]);
    assert_eq!(clients::list(&mut r).await.unwrap(), vec![client]);
    assert_eq!(
        clients::chart(&mut r, &client_id).await.unwrap(),
        fixture_chart()
    );
    assert_eq!(clients::get(&mut r, "missing").await.unwrap(), None);
}

#[tokio::test]
async fn client_account_codes_are_unique_per_client() {
    let (_dir, store) = open().await;
    let (client_id, _) = seed_client(&store).await;
    let mut w = store.writer().await;
    let a = Account {
        code: code("100"),
        name: "Duplicate".into(),
        account_type: acct_core::AccountType::Income,
        active: true,
    };
    assert!(is_constraint_error(
        &clients::insert_account(&mut w, &client_id, &a)
            .await
            .unwrap_err()
    ));
}

#[tokio::test]
async fn template_and_mapping_versions_count_up() {
    let (_dir, store) = open().await;
    seed_client(&store).await;
    let mut w = store.writer().await;
    let (template_id,): (String,) = sqlx::query_as("SELECT id FROM templates")
        .fetch_one(&mut *w)
        .await
        .unwrap();
    let (mapping_id,): (String,) = sqlx::query_as("SELECT id FROM mappings")
        .fetch_one(&mut *w)
        .await
        .unwrap();
    assert_eq!(
        templates::get_template(&mut w, &template_id)
            .await
            .unwrap()
            .unwrap()
            .name,
        "Company"
    );
    assert_eq!(
        templates::get_mapping(&mut w, &mapping_id)
            .await
            .unwrap()
            .unwrap()
            .template_id,
        template_id
    );

    let v1 = templates::latest_template_version(&mut w, &template_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(v1.version, 1);
    assert_eq!(v1.body, serde_json::from_str::<Template>(TEMPLATE).unwrap());
    let mut edited = v1.body.clone();
    edited.name = "Company (edited)".into();
    let v2_id = new_id();
    let n = templates::add_template_version(&mut w, &v2_id, &template_id, &edited, 9)
        .await
        .unwrap();
    assert_eq!(n, 2);
    let latest = templates::latest_template_version(&mut w, &template_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!((latest.id.as_str(), latest.version), (v2_id.as_str(), 2));
    // The old version is still there, unchanged.
    assert_eq!(
        templates::template_version(&mut w, &v1.id).await.unwrap(),
        Some(v1)
    );

    let m1 = templates::latest_mapping_version(&mut w, &mapping_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(m1.body, serde_json::from_str::<Mapping>(MAPPING).unwrap());
    let n = templates::add_mapping_version(&mut w, &new_id(), &mapping_id, &Mapping::default(), 9)
        .await
        .unwrap();
    assert_eq!(n, 2);
    assert_eq!(
        templates::mapping_version(&mut w, &m1.id).await.unwrap(),
        Some(m1)
    );
}

#[tokio::test]
async fn years_round_trip_in_date_order() {
    let (_dir, store) = open().await;
    let (client_id, y1) = seed_client(&store).await;
    let mut w = store.writer().await;
    let first = years::get(&mut w, &y1).await.unwrap().unwrap();
    assert_eq!(first.books_source, None);
    let second = StoredYear {
        id: new_id(),
        year: ClientYear::new(date("2025-04-01"), date("2026-03-31")).unwrap(),
        created_seq: 4,
        ..first.clone()
    };
    years::insert(&mut w, &second).await.unwrap();
    years::set_books_source(&mut w, &y1, BooksSource::TbImport)
        .await
        .unwrap();
    let all = years::for_client(&mut w, &client_id).await.unwrap();
    assert_eq!(all.len(), 2);
    assert_eq!(all[0].books_source, Some(BooksSource::TbImport));
    assert_eq!(all[1], second);
    // Two years can't start on the same day.
    let clash = StoredYear {
        id: new_id(),
        ..second
    };
    assert!(is_constraint_error(
        &years::insert(&mut w, &clash).await.unwrap_err()
    ));
}

#[tokio::test]
async fn journals_round_trip_and_reverse_once() {
    let (_dir, store) = open().await;
    let (_, year_id) = seed_client(&store).await;
    let mut w = store.writer().await;
    let mut ids = Vec::new();
    for (i, journal) in fixture_journals(0).into_iter().enumerate() {
        let j = StoredJournal {
            id: new_id(),
            client_year_id: year_id.clone(),
            kind: JournalKind::Manual,
            reverses_journal_id: None,
            posted_seq: 10 + i as i64,
            journal,
        };
        journals::insert(&mut w, &j).await.unwrap();
        ids.push(j);
    }
    assert_eq!(journals::for_year(&mut w, &year_id).await.unwrap(), ids);
    let first = &ids[0];
    assert_eq!(
        journals::get(&mut w, &first.id).await.unwrap().as_ref(),
        Some(first)
    );
    assert_eq!(journals::get(&mut w, "missing").await.unwrap(), None);

    assert_eq!(
        journals::reversal_of(&mut w, &first.id).await.unwrap(),
        None
    );
    let reversal = |id: String| StoredJournal {
        id,
        reverses_journal_id: Some(first.id.clone()),
        posted_seq: 99,
        journal: Journal {
            narration: "Reversal".into(),
            lines: first
                .journal
                .lines
                .iter()
                .map(|l| acct_core::JournalLine {
                    account: l.account.clone(),
                    amount: -l.amount,
                })
                .collect(),
            ..first.journal.clone()
        },
        ..first.clone()
    };
    let r1 = reversal(new_id());
    journals::insert(&mut w, &r1).await.unwrap();
    assert_eq!(
        journals::reversal_of(&mut w, &first.id).await.unwrap(),
        Some(r1.id)
    );
    assert!(is_constraint_error(
        &journals::insert(&mut w, &reversal(new_id()))
            .await
            .unwrap_err()
    ));
}

#[tokio::test]
async fn foreign_keys_are_enforced() {
    let (_dir, store) = open().await;
    let mut w = store.writer().await;
    let j = StoredJournal {
        id: new_id(),
        client_year_id: "no-such-year".into(),
        kind: JournalKind::Manual,
        reverses_journal_id: None,
        posted_seq: 1,
        journal: fixture_journals(0).remove(0),
    };
    assert!(is_constraint_error(
        &journals::insert(&mut w, &j).await.unwrap_err()
    ));
}

#[tokio::test]
async fn a_rolled_back_transaction_leaves_nothing() {
    let (_dir, store) = open().await;
    let (_, year_id) = seed_client(&store).await;
    let mut w = store.writer().await;
    let mut tx = w.begin().await.unwrap();
    let j = StoredJournal {
        id: new_id(),
        client_year_id: year_id.clone(),
        kind: JournalKind::TbImport,
        reverses_journal_id: None,
        posted_seq: 1,
        journal: fixture_journals(0).remove(0),
    };
    journals::insert(&mut tx, &j).await.unwrap();
    assert_eq!(
        journals::for_year(&mut tx, &year_id).await.unwrap().len(),
        1
    );
    tx.rollback().await.unwrap();
    assert!(
        journals::for_year(&mut w, &year_id)
            .await
            .unwrap()
            .is_empty()
    );
    let (lines,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM journal_lines")
        .fetch_one(&mut *w)
        .await
        .unwrap();
    assert_eq!(lines, 0);
}
