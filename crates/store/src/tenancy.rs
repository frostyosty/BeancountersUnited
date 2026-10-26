//! Who may see which client besides the practice (M12), and owners' invites to their accountant.
//! The rules that read these rows live in one place, `acct_server::access`.

use chrono::NaiveDate;
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, enum_text, parse_enum};

/// How a user is attached to a client.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Access {
    /// The business owner who signed up with it.
    Owner,
    /// A practice user who accepted the owner's invite.
    Accountant,
}

pub async fn grant(
    conn: &mut SqliteConnection,
    client_id: &str,
    user_id: &str,
    access: Access,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO client_access (client_id, user_id, access, granted_seq) VALUES (?, ?, ?, ?)",
    )
    .bind(client_id)
    .bind(user_id)
    .bind(enum_text(&access))
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}

/// `user_id`'s access to `client_id`, if they have a row.
pub async fn access(
    conn: &mut SqliteConnection,
    client_id: &str,
    user_id: &str,
) -> Result<Option<Access>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT access FROM client_access WHERE client_id = ? AND user_id = ?")
            .bind(client_id)
            .bind(user_id)
            .fetch_optional(conn)
            .await?;
    row.map(|(a,)| parse_enum(&a)).transpose()
}

/// Whether a business owner signed up with this client, which makes it theirs rather than the
/// practice's.
pub async fn has_owner(conn: &mut SqliteConnection, client_id: &str) -> Result<bool> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM client_access WHERE client_id = ? AND access = 'owner'",
    )
    .bind(client_id)
    .fetch_one(conn)
    .await?;
    Ok(n > 0)
}

/// Whether a practice user has accepted this client's invite, so the practice now prepares its
/// accounts.
pub async fn has_accountant(conn: &mut SqliteConnection, client_id: &str) -> Result<bool> {
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM client_access WHERE client_id = ? AND access = 'accountant'",
    )
    .bind(client_id)
    .fetch_one(conn)
    .await?;
    Ok(n > 0)
}

/// The clients `user_id` has a row for, by id.
pub async fn clients_for_user(conn: &mut SqliteConnection, user_id: &str) -> Result<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT client_id FROM client_access WHERE user_id = ? ORDER BY client_id")
            .bind(user_id)
            .fetch_all(conn)
            .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

/// Clients a business owner signed up with, by id: the ones the practice doesn't see by default.
pub async fn owned_clients(conn: &mut SqliteConnection) -> Result<Vec<String>> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT client_id FROM client_access WHERE access = 'owner' ORDER BY client_id",
    )
    .fetch_all(conn)
    .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Invite {
    pub id: String,
    pub client_id: String,
    pub email: String,
    pub token_hash: String,
    pub created_by: String,
    pub created_seq: i64,
    pub expires_on: NaiveDate,
    pub accepted_by: Option<String>,
    pub accepted_seq: Option<i64>,
}

pub async fn insert_invite(conn: &mut SqliteConnection, i: &Invite) -> Result<()> {
    sqlx::query(
        "INSERT INTO invites (id, client_id, email, token_hash, created_by, created_seq,
                              expires_on, accepted_by, accepted_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&i.id)
    .bind(&i.client_id)
    .bind(&i.email)
    .bind(&i.token_hash)
    .bind(&i.created_by)
    .bind(i.created_seq)
    .bind(i.expires_on)
    .bind(&i.accepted_by)
    .bind(i.accepted_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn invite_by_token_hash(
    conn: &mut SqliteConnection,
    token_hash: &str,
) -> Result<Option<Invite>> {
    Ok(sqlx::query_as("SELECT * FROM invites WHERE token_hash = ?")
        .bind(token_hash)
        .fetch_optional(conn)
        .await?)
}

pub async fn mark_accepted(
    conn: &mut SqliteConnection,
    id: &str,
    user_id: &str,
    seq: i64,
) -> Result<()> {
    sqlx::query("UPDATE invites SET accepted_by = ?, accepted_seq = ? WHERE id = ?")
        .bind(user_id)
        .bind(seq)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// Whether the owner of `client_id` lets practice users see the owner's own edits in Changes.
/// Off unless the owner turned it on.
pub async fn owner_edits_shared(conn: &mut SqliteConnection, client_id: &str) -> Result<bool> {
    let row: Option<(bool,)> =
        sqlx::query_as("SELECT share_owner_edits FROM history_sharing WHERE client_id = ?")
            .bind(client_id)
            .fetch_optional(conn)
            .await?;
    Ok(row.is_some_and(|(shared,)| shared))
}

/// The businesses whose owners share their edits with the practice.
pub async fn sharing_clients(conn: &mut SqliteConnection) -> Result<Vec<String>> {
    let rows: Vec<(String,)> =
        sqlx::query_as("SELECT client_id FROM history_sharing WHERE share_owner_edits = 1")
            .fetch_all(conn)
            .await?;
    Ok(rows.into_iter().map(|(c,)| c).collect())
}

pub async fn set_owner_edits_shared(
    conn: &mut SqliteConnection,
    client_id: &str,
    shared: bool,
    seq: i64,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO history_sharing (client_id, share_owner_edits, updated_seq) VALUES (?, ?, ?)
         ON CONFLICT (client_id) DO UPDATE
         SET share_owner_edits = excluded.share_owner_edits, updated_seq = excluded.updated_seq",
    )
    .bind(client_id)
    .bind(shared)
    .bind(seq)
    .execute(conn)
    .await?;
    Ok(())
}
