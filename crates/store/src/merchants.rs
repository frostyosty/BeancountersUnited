//! The practice's merchant list (ADR 009's layer 3), one per entity type.

use acct_core::coding::{Coding, Merchant};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, from_json, to_json};

/// A merchant entry and the entity type whose list it's on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredMerchant {
    pub entity_type: String,
    pub merchant: Merchant,
    pub created_seq: i64,
    pub removed_seq: Option<i64>,
}

#[derive(FromRow)]
struct Row {
    id: String,
    entity_type: String,
    description_contains: String,
    coding: String,
    created_seq: i64,
    removed_seq: Option<i64>,
}

impl TryFrom<Row> for StoredMerchant {
    type Error = crate::StoreError;
    fn try_from(r: Row) -> Result<StoredMerchant> {
        let coding: Coding = from_json(&r.coding)?;
        Ok(StoredMerchant {
            entity_type: r.entity_type,
            merchant: Merchant {
                id: r.id,
                description_contains: r.description_contains,
                coding,
            },
            created_seq: r.created_seq,
            removed_seq: r.removed_seq,
        })
    }
}

pub async fn insert(
    conn: &mut SqliteConnection,
    entity_type: &str,
    merchant: &Merchant,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO merchants (id, entity_type, description_contains, coding, created_seq)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(&merchant.id)
    .bind(entity_type)
    .bind(&merchant.description_contains)
    .bind(to_json(&merchant.coding))
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredMerchant>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM merchants WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(StoredMerchant::try_from).transpose()
}

/// The entries on an entity type's list now, oldest first.
pub async fn live(conn: &mut SqliteConnection, entity_type: &str) -> Result<Vec<Merchant>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT * FROM merchants WHERE entity_type = ? AND removed_seq IS NULL
         ORDER BY created_seq, id",
    )
    .bind(entity_type)
    .fetch_all(conn)
    .await?;
    rows.into_iter()
        .map(|r| StoredMerchant::try_from(r).map(|m| m.merchant))
        .collect()
}

pub async fn remove(conn: &mut SqliteConnection, id: &str, seq: i64) -> Result<()> {
    sqlx::query("UPDATE merchants SET removed_seq = ? WHERE id = ?")
        .bind(seq)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}
