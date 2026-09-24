//! Clients and their own charts.

use acct_core::{Account, AccountCode, Chart};
use sqlx::{FromRow, SqliteConnection};

use crate::charts::{AccountRow, to_chart};
use crate::{Result, enum_text, from_json, parse, to_json};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Client {
    pub id: String,
    pub name: String,
    pub entity_type: String,
    /// The equity account P&L accounts close to at rollover.
    pub retained_earnings: AccountCode,
    pub rounding_priority: Vec<AccountCode>,
    pub created_seq: i64,
}

#[derive(FromRow)]
struct Row {
    id: String,
    name: String,
    entity_type: String,
    retained_earnings: String,
    rounding_priority: String,
    created_seq: i64,
}

impl TryFrom<Row> for Client {
    type Error = crate::StoreError;
    fn try_from(r: Row) -> Result<Client> {
        Ok(Client {
            id: r.id,
            name: r.name,
            entity_type: r.entity_type,
            retained_earnings: parse(&r.retained_earnings)?,
            rounding_priority: from_json(&r.rounding_priority)?,
            created_seq: r.created_seq,
        })
    }
}

pub async fn insert(conn: &mut SqliteConnection, client: &Client) -> Result<()> {
    sqlx::query(
        "INSERT INTO clients
             (id, name, entity_type, retained_earnings, rounding_priority, created_seq)
         VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(&client.id)
    .bind(&client.name)
    .bind(&client.entity_type)
    .bind(client.retained_earnings.as_str())
    .bind(to_json(&client.rounding_priority))
    .bind(client.created_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<Client>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM clients WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(Client::try_from).transpose()
}

/// Every client, by name.
pub async fn list(conn: &mut SqliteConnection) -> Result<Vec<Client>> {
    let rows: Vec<Row> = sqlx::query_as("SELECT * FROM clients ORDER BY name COLLATE NOCASE, id")
        .fetch_all(conn)
        .await?;
    rows.into_iter().map(Client::try_from).collect()
}

/// Adds an account to a client's chart.
pub async fn insert_account(
    conn: &mut SqliteConnection,
    client_id: &str,
    account: &Account,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO accounts (client_id, code, name, account_type, active)
         VALUES (?, ?, ?, ?, ?)",
    )
    .bind(client_id)
    .bind(account.code.as_str())
    .bind(&account.name)
    .bind(enum_text(&account.account_type))
    .bind(account.active)
    .execute(conn)
    .await?;
    Ok(())
}

/// A client's chart. Empty if the client doesn't exist.
pub async fn chart(conn: &mut SqliteConnection, client_id: &str) -> Result<Chart> {
    let rows: Vec<AccountRow> =
        sqlx::query_as("SELECT code, name, account_type, active FROM accounts WHERE client_id = ?")
            .bind(client_id)
            .fetch_all(conn)
            .await?;
    to_chart(rows)
}

/// Updates an existing account's name and active flag. Codes and account types never change.
pub async fn update_account(
    conn: &mut SqliteConnection,
    client_id: &str,
    account: &Account,
) -> Result<()> {
    sqlx::query("UPDATE accounts SET name = ?, active = ? WHERE client_id = ? AND code = ?")
        .bind(&account.name)
        .bind(account.active)
        .bind(client_id)
        .bind(account.code.as_str())
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn set_rounding_priority(
    conn: &mut SqliteConnection,
    client_id: &str,
    rounding_priority: &[AccountCode],
) -> Result<()> {
    sqlx::query("UPDATE clients SET rounding_priority = ? WHERE id = ?")
        .bind(to_json(&rounding_priority))
        .bind(client_id)
        .execute(conn)
        .await?;
    Ok(())
}
