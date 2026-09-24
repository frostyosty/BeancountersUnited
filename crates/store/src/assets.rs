//! Asset classes (practice and client override), the asset register and posted charges.

use acct_core::{
    AccountCode, Asset, AssetAccounts, DepreciationSettings, Disposal, Money, OpeningBalance,
    RateSource,
};
use chrono::NaiveDate;
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, StoreError, enum_text, from_json, parse, parse_enum, to_json};

/// A practice asset class for one entity type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetClass {
    pub id: String,
    pub entity_type: String,
    pub key: String,
    pub name: String,
    pub settings: DepreciationSettings,
    pub accounts: AssetAccounts,
    pub created_seq: i64,
    pub updated_seq: i64,
}

#[derive(FromRow)]
struct ClassRow {
    id: String,
    entity_type: String,
    key: String,
    name: String,
    settings: String,
    accounts: String,
    created_seq: i64,
    updated_seq: i64,
}

impl TryFrom<ClassRow> for AssetClass {
    type Error = StoreError;
    fn try_from(r: ClassRow) -> Result<AssetClass> {
        Ok(AssetClass {
            id: r.id,
            entity_type: r.entity_type,
            key: r.key,
            name: r.name,
            settings: from_json(&r.settings)?,
            accounts: from_json(&r.accounts)?,
            created_seq: r.created_seq,
            updated_seq: r.updated_seq,
        })
    }
}

pub async fn insert_class(conn: &mut SqliteConnection, c: &AssetClass) -> Result<()> {
    sqlx::query(
        "INSERT INTO asset_classes
             (id, entity_type, key, name, settings, accounts, created_seq, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&c.id)
    .bind(&c.entity_type)
    .bind(&c.key)
    .bind(&c.name)
    .bind(to_json(&c.settings))
    .bind(to_json(&c.accounts))
    .bind(c.created_seq)
    .bind(c.updated_seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// Replaces a class's name, settings and accounts. Its key and entity type never change.
pub async fn update_class(conn: &mut SqliteConnection, c: &AssetClass) -> Result<()> {
    sqlx::query(
        "UPDATE asset_classes SET name = ?, settings = ?, accounts = ?, updated_seq = ?
         WHERE id = ?",
    )
    .bind(&c.name)
    .bind(to_json(&c.settings))
    .bind(to_json(&c.accounts))
    .bind(c.updated_seq)
    .bind(&c.id)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get_class(conn: &mut SqliteConnection, id: &str) -> Result<Option<AssetClass>> {
    let row: Option<ClassRow> = sqlx::query_as("SELECT * FROM asset_classes WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(AssetClass::try_from).transpose()
}

/// An entity type's classes, by key.
pub async fn classes_for_entity_type(
    conn: &mut SqliteConnection,
    entity_type: &str,
) -> Result<Vec<AssetClass>> {
    let rows: Vec<ClassRow> =
        sqlx::query_as("SELECT * FROM asset_classes WHERE entity_type = ? ORDER BY key")
            .bind(entity_type)
            .fetch_all(conn)
            .await?;
    rows.into_iter().map(AssetClass::try_from).collect()
}

/// Every class, by entity type then key.
pub async fn all_classes(conn: &mut SqliteConnection) -> Result<Vec<AssetClass>> {
    let rows: Vec<ClassRow> =
        sqlx::query_as("SELECT * FROM asset_classes ORDER BY entity_type, key")
            .fetch_all(conn)
            .await?;
    rows.into_iter().map(AssetClass::try_from).collect()
}

/// A client's override of a practice class. `None` fields fall back to the practice's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassOverride {
    pub client_id: String,
    pub class_id: String,
    pub settings: Option<DepreciationSettings>,
    pub accounts: Option<AssetAccounts>,
    pub updated_seq: i64,
}

#[derive(FromRow)]
struct OverrideRow {
    client_id: String,
    class_id: String,
    settings: Option<String>,
    accounts: Option<String>,
    updated_seq: i64,
}

impl TryFrom<OverrideRow> for ClassOverride {
    type Error = StoreError;
    fn try_from(r: OverrideRow) -> Result<ClassOverride> {
        Ok(ClassOverride {
            client_id: r.client_id,
            class_id: r.class_id,
            settings: r.settings.as_deref().map(from_json).transpose()?,
            accounts: r.accounts.as_deref().map(from_json).transpose()?,
            updated_seq: r.updated_seq,
        })
    }
}

/// Sets a client's override of a class, or removes it when both parts are `None`.
pub async fn set_override(conn: &mut SqliteConnection, o: &ClassOverride) -> Result<()> {
    if o.settings.is_none() && o.accounts.is_none() {
        sqlx::query("DELETE FROM client_asset_classes WHERE client_id = ? AND class_id = ?")
            .bind(&o.client_id)
            .bind(&o.class_id)
            .execute(conn)
            .await?;
        return Ok(());
    }
    sqlx::query(
        "INSERT INTO client_asset_classes (client_id, class_id, settings, accounts, updated_seq)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (client_id, class_id) DO UPDATE SET
             settings = excluded.settings,
             accounts = excluded.accounts,
             updated_seq = excluded.updated_seq",
    )
    .bind(&o.client_id)
    .bind(&o.class_id)
    .bind(o.settings.as_ref().map(to_json))
    .bind(o.accounts.as_ref().map(to_json))
    .bind(o.updated_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn overrides_for_client(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<ClassOverride>> {
    let rows: Vec<OverrideRow> =
        sqlx::query_as("SELECT * FROM client_asset_classes WHERE client_id = ? ORDER BY class_id")
            .bind(client_id)
            .fetch_all(conn)
            .await?;
    rows.into_iter().map(ClassOverride::try_from).collect()
}

/// An asset in a client's register.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredAsset {
    pub id: String,
    pub client_id: String,
    pub class_id: String,
    pub name: String,
    pub rate_source: RateSource,
    pub accounts: AssetAccounts,
    pub asset: Asset,
    pub created_seq: i64,
    pub updated_seq: i64,
}

#[derive(FromRow)]
struct AssetRow {
    id: String,
    client_id: String,
    class_id: String,
    name: String,
    cost: i64,
    residual: i64,
    acquired: NaiveDate,
    settings: String,
    rate_source: String,
    accounts: String,
    opening_date: Option<NaiveDate>,
    opening_accumulated: Option<i64>,
    disposal_date: Option<NaiveDate>,
    disposal_proceeds: Option<i64>,
    disposal_account: Option<String>,
    created_seq: i64,
    updated_seq: i64,
}

impl TryFrom<AssetRow> for StoredAsset {
    type Error = StoreError;
    fn try_from(r: AssetRow) -> Result<StoredAsset> {
        let opening = match (r.opening_date, r.opening_accumulated) {
            (Some(date), Some(accumulated)) => Some(OpeningBalance {
                date,
                accumulated: Money::from_cents(accumulated),
            }),
            _ => None,
        };
        let disposal = match (r.disposal_date, r.disposal_proceeds, r.disposal_account) {
            (Some(date), Some(proceeds), Some(account)) => Some(Disposal {
                date,
                proceeds: Money::from_cents(proceeds),
                proceeds_account: parse::<AccountCode>(&account)?,
            }),
            _ => None,
        };
        Ok(StoredAsset {
            id: r.id,
            client_id: r.client_id,
            class_id: r.class_id,
            name: r.name,
            rate_source: parse_enum(&r.rate_source)?,
            accounts: from_json(&r.accounts)?,
            asset: Asset {
                cost: Money::from_cents(r.cost),
                residual: Money::from_cents(r.residual),
                acquired: r.acquired,
                settings: from_json(&r.settings)?,
                opening,
                disposal,
            },
            created_seq: r.created_seq,
            updated_seq: r.updated_seq,
        })
    }
}

pub async fn insert_asset(conn: &mut SqliteConnection, a: &StoredAsset) -> Result<()> {
    sqlx::query(
        "INSERT INTO assets
             (id, client_id, class_id, name, cost, residual, acquired, settings, rate_source,
              accounts, opening_date, opening_accumulated, disposal_date, disposal_proceeds,
              disposal_account, created_seq, updated_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&a.id)
    .bind(&a.client_id)
    .bind(&a.class_id)
    .bind(&a.name)
    .bind(a.asset.cost.cents())
    .bind(a.asset.residual.cents())
    .bind(a.asset.acquired)
    .bind(to_json(&a.asset.settings))
    .bind(enum_text(&a.rate_source))
    .bind(to_json(&a.accounts))
    .bind(a.asset.opening.map(|o| o.date))
    .bind(a.asset.opening.map(|o| o.accumulated.cents()))
    .bind(a.asset.disposal.as_ref().map(|d| d.date))
    .bind(a.asset.disposal.as_ref().map(|d| d.proceeds.cents()))
    .bind(
        a.asset
            .disposal
            .as_ref()
            .map(|d| d.proceeds_account.as_str()),
    )
    .bind(a.created_seq)
    .bind(a.updated_seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// Replaces everything about an asset except its id, client, class and `created_seq`.
pub async fn update_asset(conn: &mut SqliteConnection, a: &StoredAsset) -> Result<()> {
    sqlx::query(
        "UPDATE assets SET
             name = ?, cost = ?, residual = ?, acquired = ?, settings = ?, rate_source = ?,
             accounts = ?, opening_date = ?, opening_accumulated = ?, disposal_date = ?,
             disposal_proceeds = ?, disposal_account = ?, updated_seq = ?
         WHERE id = ?",
    )
    .bind(&a.name)
    .bind(a.asset.cost.cents())
    .bind(a.asset.residual.cents())
    .bind(a.asset.acquired)
    .bind(to_json(&a.asset.settings))
    .bind(enum_text(&a.rate_source))
    .bind(to_json(&a.accounts))
    .bind(a.asset.opening.map(|o| o.date))
    .bind(a.asset.opening.map(|o| o.accumulated.cents()))
    .bind(a.asset.disposal.as_ref().map(|d| d.date))
    .bind(a.asset.disposal.as_ref().map(|d| d.proceeds.cents()))
    .bind(
        a.asset
            .disposal
            .as_ref()
            .map(|d| d.proceeds_account.as_str()),
    )
    .bind(a.updated_seq)
    .bind(&a.id)
    .execute(conn)
    .await?;
    Ok(())
}

/// Removes an asset and its recorded charges.
pub async fn delete_asset(conn: &mut SqliteConnection, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM asset_charges WHERE asset_id = ?")
        .bind(id)
        .execute(&mut *conn)
        .await?;
    sqlx::query("DELETE FROM assets WHERE id = ?")
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn get_asset(conn: &mut SqliteConnection, id: &str) -> Result<Option<StoredAsset>> {
    let row: Option<AssetRow> = sqlx::query_as("SELECT * FROM assets WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(StoredAsset::try_from).transpose()
}

/// A client's register, by acquisition date, then name, then id.
pub async fn assets_for_client(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<StoredAsset>> {
    let rows: Vec<AssetRow> = sqlx::query_as(
        "SELECT * FROM assets WHERE client_id = ? ORDER BY acquired, name COLLATE NOCASE, id",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(StoredAsset::try_from).collect()
}

/// A charge posted by the depreciation run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Charge {
    pub asset_id: String,
    pub client_year_id: String,
    pub amount: Money,
}

/// Replaces a year's recorded charges.
pub async fn set_charges(
    conn: &mut SqliteConnection,
    client_year_id: &str,
    charges: &[Charge],
    seq: i64,
) -> Result<()> {
    sqlx::query("DELETE FROM asset_charges WHERE client_year_id = ?")
        .bind(client_year_id)
        .execute(&mut *conn)
        .await?;
    for c in charges {
        sqlx::query(
            "INSERT INTO asset_charges (asset_id, client_year_id, amount, posted_seq)
             VALUES (?, ?, ?, ?)",
        )
        .bind(&c.asset_id)
        .bind(&c.client_year_id)
        .bind(c.amount.cents())
        .bind(seq)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Every recorded charge for a client's assets.
pub async fn charges_for_client(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Vec<Charge>> {
    let rows: Vec<(String, String, i64)> = sqlx::query_as(
        "SELECT c.asset_id, c.client_year_id, c.amount FROM asset_charges c
         JOIN assets a ON a.id = c.asset_id
         WHERE a.client_id = ? ORDER BY c.asset_id, c.client_year_id",
    )
    .bind(client_id)
    .fetch_all(conn)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(asset_id, client_year_id, amount)| Charge {
            asset_id,
            client_year_id,
            amount: Money::from_cents(amount),
        })
        .collect())
}
