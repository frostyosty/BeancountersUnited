//! Practice master charts, one per entity type, and the rows shared with client charts.

use acct_core::{Account, Chart};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, StoreError, enum_text, parse, parse_enum};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MasterChart {
    pub id: String,
    pub entity_type: String,
    pub name: String,
    pub created_seq: i64,
    pub chart: Chart,
}

#[derive(FromRow)]
pub(crate) struct AccountRow {
    code: String,
    name: String,
    account_type: String,
    active: bool,
    default_gst: Option<String>,
}

impl TryFrom<AccountRow> for Account {
    type Error = StoreError;
    fn try_from(r: AccountRow) -> Result<Account> {
        Ok(Account {
            code: parse(&r.code)?,
            name: r.name,
            account_type: parse_enum(&r.account_type)?,
            active: r.active,
            default_gst: r.default_gst.as_deref().map(parse_enum).transpose()?,
        })
    }
}

pub(crate) fn to_chart(rows: Vec<AccountRow>) -> Result<Chart> {
    let accounts = rows
        .into_iter()
        .map(Account::try_from)
        .collect::<Result<Vec<_>>>()?;
    Chart::new(accounts).map_err(|e| StoreError::Corrupt(e.to_string()))
}

#[derive(FromRow)]
struct Row {
    id: String,
    entity_type: String,
    name: String,
    created_seq: i64,
}

pub async fn insert(conn: &mut SqliteConnection, chart: &MasterChart) -> Result<()> {
    sqlx::query(
        "INSERT INTO master_charts (id, entity_type, name, created_seq) VALUES (?, ?, ?, ?)",
    )
    .bind(&chart.id)
    .bind(&chart.entity_type)
    .bind(&chart.name)
    .bind(chart.created_seq)
    .execute(&mut *conn)
    .await?;
    for a in chart.chart.accounts() {
        insert_account(conn, &chart.id, a).await?;
    }
    Ok(())
}

/// Adds an account to a master chart. Client charts already copied from it don't change.
pub async fn insert_account(
    conn: &mut SqliteConnection,
    chart_id: &str,
    a: &Account,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO master_chart_accounts
             (chart_id, code, name, account_type, active, default_gst)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(chart_id)
    .bind(a.code.as_str())
    .bind(&a.name)
    .bind(enum_text(&a.account_type))
    .bind(a.active)
    .bind(a.default_gst.as_ref().map(enum_text))
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Updates a master chart account's name, active flag and default GST code. Codes and account
/// types never change, and client charts already copied from it don't either.
pub async fn update_account(
    conn: &mut SqliteConnection,
    chart_id: &str,
    a: &Account,
) -> Result<()> {
    sqlx::query(
        "UPDATE master_chart_accounts SET name = ?, active = ?, default_gst = ?
         WHERE chart_id = ? AND code = ?",
    )
    .bind(&a.name)
    .bind(a.active)
    .bind(a.default_gst.as_ref().map(enum_text))
    .bind(chart_id)
    .bind(a.code.as_str())
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// The master chart for an entity type, with its accounts.
pub async fn for_entity_type(
    conn: &mut SqliteConnection,
    entity_type: &str,
) -> Result<Option<MasterChart>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM master_charts WHERE entity_type = ?")
        .bind(entity_type)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let accounts: Vec<AccountRow> = sqlx::query_as(
        "SELECT code, name, account_type, active, default_gst
         FROM master_chart_accounts WHERE chart_id = ?",
    )
    .bind(&row.id)
    .fetch_all(&mut *conn)
    .await?;
    Ok(Some(MasterChart {
        id: row.id,
        entity_type: row.entity_type,
        name: row.name,
        created_seq: row.created_seq,
        chart: to_chart(accounts)?,
    }))
}

/// Every master chart, with its accounts, by entity type.
pub async fn list(conn: &mut SqliteConnection) -> Result<Vec<MasterChart>> {
    let types: Vec<(String,)> =
        sqlx::query_as("SELECT entity_type FROM master_charts ORDER BY entity_type")
            .fetch_all(&mut *conn)
            .await?;
    let mut charts = Vec::with_capacity(types.len());
    for (entity_type,) in types {
        if let Some(chart) = for_entity_type(conn, &entity_type).await? {
            charts.push(chart);
        }
    }
    Ok(charts)
}
