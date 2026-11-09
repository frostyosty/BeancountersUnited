//! The `ai_usage` table and its counting queries, against a real SQLite database (ADR 016).

use acct_store::ai_usage::{self, UsageRow};
use acct_store::{Store, StoreError, new_id};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use tempfile::TempDir;

async fn open() -> (TempDir, Store) {
    let dir = TempDir::new().unwrap();
    let store = Store::open(&dir.path().join("acct.db")).await.unwrap();
    (dir, store)
}

fn day(d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, d).unwrap()
}

fn at(d: u32, h: u32, m: u32, s: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, d, h, m, s).unwrap()
}

/// A successful suggestion run that called the model, for `biz` at `when`.
fn row(biz: &str, kind: &str, when: DateTime<Utc>) -> UsageRow {
    UsageRow {
        id: new_id(),
        at: when,
        kind: kind.to_owned(),
        business_id: biz.to_owned(),
        user_id: Some("user-1".to_owned()),
        plan: "free".to_owned(),
        is_overseer: false,
        acting_as: None,
        model: Some("claude-haiku-5-5".to_owned()),
        model_calls: 1,
        input_tokens: 400,
        output_tokens: 90,
        cache_read_tokens: 1_800,
        cache_write_tokens: 0,
        cost_micro_usd: Some(1_000),
        latency_ms: Some(850),
        outcome: "ok".to_owned(),
        lines_total: (kind == "suggestion").then_some(10),
        by_rules: (kind == "suggestion").then_some(2),
        by_history: (kind == "suggestion").then_some(3),
        by_merchants: (kind == "suggestion").then_some(1),
        lines_asked: (kind == "suggestion").then_some(4),
        by_model: (kind == "suggestion").then_some(3),
    }
}

async fn count(store: &Store, biz: &str, kind: &str, d: u32) -> u32 {
    let mut r = store.reader().await.unwrap();
    ai_usage::count_for_business(&mut r, biz, kind, day(d))
        .await
        .unwrap()
}

#[tokio::test]
async fn a_row_is_stored_and_counted_by_business_user_and_kind() {
    let (_dir, store) = open().await;
    ai_usage::insert(&store, &row("b1", "suggestion", at(9, 10, 0, 0)))
        .await
        .unwrap();
    ai_usage::insert(&store, &row("b1", "explain", at(9, 10, 5, 0)))
        .await
        .unwrap();
    ai_usage::insert(&store, &row("b1", "explain", at(9, 11, 0, 0)))
        .await
        .unwrap();
    ai_usage::insert(&store, &row("b2", "explain", at(9, 12, 0, 0)))
        .await
        .unwrap();
    assert_eq!(count(&store, "b1", "suggestion", 9).await, 1);
    assert_eq!(count(&store, "b1", "explain", 9).await, 2);
    assert_eq!(count(&store, "b2", "explain", 9).await, 1);
    assert_eq!(count(&store, "nobody", "explain", 9).await, 0);
    let mut r = store.reader().await.unwrap();
    assert_eq!(
        ai_usage::count_for_user(&mut r, "user-1", "explain", day(9))
            .await
            .unwrap(),
        3
    );
    assert_eq!(
        ai_usage::count_for_user(&mut r, "user-2", "explain", day(9))
            .await
            .unwrap(),
        0
    );
    assert_eq!(
        ai_usage::count_all(&mut r, "explain", day(9))
            .await
            .unwrap(),
        3
    );
}

#[tokio::test]
async fn the_utc_day_boundary_is_midnight_utc() {
    let (_dir, store) = open().await;
    for when in [
        at(8, 23, 59, 59),
        at(9, 0, 0, 0),
        at(9, 23, 59, 59),
        at(10, 0, 0, 0),
    ] {
        ai_usage::insert(&store, &row("b1", "explain", when))
            .await
            .unwrap();
    }
    assert_eq!(count(&store, "b1", "explain", 8).await, 1);
    // Midnight itself starts the new day; the last second belongs to the old one.
    assert_eq!(count(&store, "b1", "explain", 9).await, 2);
    assert_eq!(count(&store, "b1", "explain", 10).await, 1);
    let mut r = store.reader().await.unwrap();
    assert_eq!(
        ai_usage::count_all(&mut r, "explain", day(9))
            .await
            .unwrap(),
        2
    );
    // The same holds for a time with a fraction of a second.
    drop(r);
    let mut late = row("b1", "explain", at(9, 23, 59, 59));
    late.at += chrono::Duration::milliseconds(999);
    ai_usage::insert(&store, &late).await.unwrap();
    assert_eq!(count(&store, "b1", "explain", 9).await, 3);
    assert_eq!(count(&store, "b1", "explain", 10).await, 1);
}

#[tokio::test]
async fn refused_overseer_and_model_free_asks_dont_count() {
    let (_dir, store) = open().await;
    let when = at(9, 9, 0, 0);
    ai_usage::insert(&store, &row("b1", "explain", when))
        .await
        .unwrap();
    // Refused asks are recorded but never spend the allowance.
    for outcome in ["refused_limit", "refused_budget"] {
        let mut refused = row("b1", "explain", when);
        refused.outcome = outcome.to_owned();
        refused.model = None;
        refused.model_calls = 0;
        refused.cost_micro_usd = Some(0);
        ai_usage::insert(&store, &refused).await.unwrap();
    }
    // An overseer's ask is recorded but is never counted.
    let mut overseer = row("b1", "explain", when);
    overseer.is_overseer = true;
    overseer.acting_as = Some("owner-1".to_owned());
    ai_usage::insert(&store, &overseer).await.unwrap();
    // An error still counts: the call was made.
    let mut error = row("b1", "explain", when);
    error.outcome = "error".to_owned();
    ai_usage::insert(&store, &error).await.unwrap();
    assert_eq!(count(&store, "b1", "explain", 9).await, 2);
    let mut r = store.reader().await.unwrap();
    assert_eq!(
        ai_usage::count_all(&mut r, "explain", day(9))
            .await
            .unwrap(),
        2
    );
    drop(r);

    // A suggestion run the first three layers answered used no model, so it doesn't count.
    ai_usage::insert(&store, &row("b2", "suggestion", when))
        .await
        .unwrap();
    let mut free = row("b2", "suggestion", when);
    free.model = None;
    free.model_calls = 0;
    free.cost_micro_usd = Some(0);
    free.lines_asked = Some(0);
    ai_usage::insert(&store, &free).await.unwrap();
    assert_eq!(count(&store, "b2", "suggestion", 9).await, 1);
}

#[tokio::test]
async fn the_days_cost_sums_every_row_including_overseers_and_refusals() {
    let (_dir, store) = open().await;
    let mut r = store.reader().await.unwrap();
    assert_eq!(ai_usage::cost_on(&mut r, day(9)).await.unwrap(), 0);
    drop(r);

    ai_usage::insert(&store, &row("b1", "explain", at(9, 1, 0, 0)))
        .await
        .unwrap();
    let mut overseer = row("b2", "explain", at(9, 2, 0, 0));
    overseer.is_overseer = true;
    overseer.cost_micro_usd = Some(2_500);
    ai_usage::insert(&store, &overseer).await.unwrap();
    // Unknown prices (NULL cost) add nothing.
    let mut unknown = row("b3", "explain", at(9, 3, 0, 0));
    unknown.cost_micro_usd = None;
    ai_usage::insert(&store, &unknown).await.unwrap();
    // Another day isn't in today's cost.
    ai_usage::insert(&store, &row("b1", "explain", at(10, 0, 0, 0)))
        .await
        .unwrap();
    let mut r = store.reader().await.unwrap();
    assert_eq!(ai_usage::cost_on(&mut r, day(9)).await.unwrap(), 3_500);
    assert_eq!(ai_usage::cost_on(&mut r, day(10)).await.unwrap(), 1_000);
}

#[tokio::test]
async fn the_table_refuses_values_the_server_doesnt_spell() {
    let (_dir, store) = open().await;
    let mut bad_kind = row("b1", "explain", at(9, 9, 0, 0));
    bad_kind.kind = "chat".to_owned();
    let err = ai_usage::insert(&store, &bad_kind).await.unwrap_err();
    assert!(matches!(err, StoreError::Sqlx(_)));
    let mut bad_outcome = row("b1", "explain", at(9, 9, 0, 0));
    bad_outcome.outcome = "mystery".to_owned();
    assert!(ai_usage::insert(&store, &bad_outcome).await.is_err());
    let mut bad_plan = row("b1", "explain", at(9, 9, 0, 0));
    bad_plan.plan = "platinum".to_owned();
    assert!(ai_usage::insert(&store, &bad_plan).await.is_err());
}

#[tokio::test]
async fn a_row_comes_back_as_written() {
    let (_dir, store) = open().await;
    let mut overseer = row("b1", "suggestion", at(9, 9, 0, 0));
    overseer.is_overseer = true;
    overseer.acting_as = Some("owner-1".to_owned());
    ai_usage::insert(&store, &overseer).await.unwrap();
    let mut r = store.reader().await.unwrap();
    let (is_overseer, acting_as, cache_read, by_model): (bool, Option<String>, i64, Option<i64>) =
        sqlx::query_as(
            "SELECT is_overseer, acting_as, cache_read_tokens, by_model FROM ai_usage WHERE id = ?",
        )
        .bind(&overseer.id)
        .fetch_one(&mut *r)
        .await
        .unwrap();
    assert!(is_overseer);
    assert_eq!(acting_as.as_deref(), Some("owner-1"));
    assert_eq!(cache_read, 1_800);
    assert_eq!(by_model, Some(3));
}
