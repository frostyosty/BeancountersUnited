//! Users. Their login sessions are in `sessions`.

use sqlx::{FromRow, SqliteConnection};

use crate::{Result, parse_enum};

/// What a user may do (CLAUDE.md, Roles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Role {
    /// Practice settings, users, defaults, master charts, templates, finalising and reopening.
    Master,
    /// Client work, including custom depreciation rates.
    Staff,
    /// Read-only.
    Viewer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub role: Role,
    pub active: bool,
    pub created_seq: i64,
}

#[derive(FromRow)]
struct Row {
    id: String,
    username: String,
    display_name: String,
    password_hash: String,
    role: String,
    active: bool,
    created_seq: i64,
}

impl TryFrom<Row> for User {
    type Error = crate::StoreError;
    fn try_from(r: Row) -> Result<User> {
        Ok(User {
            id: r.id,
            username: r.username,
            display_name: r.display_name,
            password_hash: r.password_hash,
            role: parse_enum(&r.role)?,
            active: r.active,
            created_seq: r.created_seq,
        })
    }
}

pub async fn insert(conn: &mut SqliteConnection, user: &User) -> Result<()> {
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, role, active, created_seq)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&user.id)
    .bind(&user.username)
    .bind(&user.display_name)
    .bind(&user.password_hash)
    .bind(crate::enum_text(&user.role))
    .bind(user.active)
    .bind(user.created_seq)
    .execute(conn)
    .await?;
    Ok(())
}

pub async fn get(conn: &mut SqliteConnection, id: &str) -> Result<Option<User>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(id)
        .fetch_optional(conn)
        .await?;
    row.map(User::try_from).transpose()
}

/// Looks a user up by username, ignoring case.
pub async fn by_username(conn: &mut SqliteConnection, username: &str) -> Result<Option<User>> {
    let row: Option<Row> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(username)
        .fetch_optional(conn)
        .await?;
    row.map(User::try_from).transpose()
}

pub async fn count(conn: &mut SqliteConnection) -> Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users")
        .fetch_one(conn)
        .await?;
    Ok(n)
}
