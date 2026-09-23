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
}

impl TryFrom<AccountRow> for Account {
    type Error = StoreError;
    fn try_from(r: AccountRow) -> Result<Account> {
        Ok(Account {
            code: parse(&r.code)?,
            name: r.name,
            account_type: parse_enum(&r.account_type)?,
            active: r.active,
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
        sqlx::query(
            "INSERT INTO master_chart_accounts (chart_id, code, name, account_type, active)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&chart.id)
        .bind(a.code.as_str())
        .bind(&a.name)
        .bind(enum_text(&a.account_type))
        .bind(a.active)
        .execute(&mut *conn)
        .await?;
    }
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
        "SELECT code, name, account_type, active FROM master_chart_accounts WHERE chart_id = ?",
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
