//! Users. Their login sessions are in `sessions`.

use chrono::{DateTime, Utc};
use sqlx::{FromRow, SqliteConnection};

use crate::{Result, parse_enum};

/// What a user may do (CLAUDE.md, Roles).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Role {
    /// Us, running the service: every business, every practice view, every command a signed-in
    /// user can submit. Only an overseer can make or manage another overseer.
    Overseer,
    /// The practice's top user: practice settings, users, defaults, master charts, templates,
    /// finalising and reopening. Was `master` before M12; old log payloads still say that.
    #[serde(alias = "master")]
    PracticeAdmin,
    /// Client work, including custom depreciation rates.
    Staff,
    /// Read-only.
    Viewer,
    /// A business owner who signed up: their own business only, and only the owner's screens
    /// (upload, Save tax, invite their accountant). Not part of the practice.
    BusinessOwner,
}

impl Role {
    /// The practice's own roles. Practice data (settings, defaults, the user list) is theirs.
    pub fn is_practice(self) -> bool {
        matches!(self, Role::PracticeAdmin | Role::Staff | Role::Viewer)
    }
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
    /// When this user started as a guest (M20, ADR 014): someone trying it on the home page with
    /// no sign-up. `None` for everyone who signed up or was added.
    pub guest_since: Option<DateTime<Utc>>,
    /// When a guest saved their work, giving the account an email and password.
    pub claimed_at: Option<DateTime<Utc>>,
}

impl User {
    /// A guest who hasn't saved their work yet: no credentials, and nobody else sees their
    /// business.
    pub fn is_guest(&self) -> bool {
        self.guest_since.is_some() && self.claimed_at.is_none()
    }
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
    #[sqlx(default)]
    guest_since: Option<DateTime<Utc>>,
    #[sqlx(default)]
    claimed_at: Option<DateTime<Utc>>,
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
            guest_since: r.guest_since,
            claimed_at: r.claimed_at,
        })
    }
}

pub async fn insert(conn: &mut SqliteConnection, user: &User) -> Result<()> {
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, role, active, created_seq,
                            guest_since, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&user.id)
    .bind(&user.username)
    .bind(&user.display_name)
    .bind(&user.password_hash)
    .bind(crate::enum_text(&user.role))
    .bind(user.active)
    .bind(user.created_seq)
    .bind(user.guest_since)
    .bind(user.claimed_at)
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

/// Every user, active or not, oldest first.
pub async fn list(conn: &mut SqliteConnection) -> Result<Vec<User>> {
    let rows: Vec<Row> = sqlx::query_as("SELECT * FROM users ORDER BY created_seq, id")
        .fetch_all(conn)
        .await?;
    rows.into_iter().map(User::try_from).collect()
}

pub async fn set_password_hash(
    conn: &mut SqliteConnection,
    id: &str,
    password_hash: &str,
) -> Result<()> {
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(password_hash)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

pub async fn set_active(conn: &mut SqliteConnection, id: &str, active: bool) -> Result<()> {
    sqlx::query("UPDATE users SET active = ? WHERE id = ?")
        .bind(active)
        .bind(id)
        .execute(conn)
        .await?;
    Ok(())
}

/// How many active users have `role`.
pub async fn count_active(conn: &mut SqliteConnection, role: Role) -> Result<i64> {
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM users WHERE active AND role = ?")
        .bind(crate::enum_text(&role))
        .fetch_one(conn)
        .await?;
    Ok(n)
}

/// A guest saves their work (M20, `claim_guest`): the same user gets an email as its username, a
/// name, a password and `claimed_at`. The caller has checked the username is free.
pub async fn claim(
    conn: &mut SqliteConnection,
    id: &str,
    username: &str,
    display_name: &str,
    password_hash: &str,
    at: DateTime<Utc>,
) -> Result<()> {
    sqlx::query(
        "UPDATE users SET username = ?, display_name = ?, password_hash = ?, claimed_at = ?
         WHERE id = ? AND guest_since IS NOT NULL AND claimed_at IS NULL",
    )
    .bind(username)
    .bind(display_name)
    .bind(password_hash)
    .bind(at)
    .bind(id)
    .execute(conn)
    .await?;
    Ok(())
}

/// Every active guest who hasn't saved their work, oldest first.
pub async fn guests(conn: &mut SqliteConnection) -> Result<Vec<User>> {
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT * FROM users WHERE guest_since IS NOT NULL AND claimed_at IS NULL AND active
         ORDER BY created_seq, id",
    )
    .fetch_all(conn)
    .await?;
    rows.into_iter().map(User::try_from).collect()
}
