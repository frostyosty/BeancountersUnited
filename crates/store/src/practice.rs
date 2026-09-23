//! The practice: a single row.

use sqlx::{FromRow, SqliteConnection};

use crate::Result;

#[derive(Debug, Clone, PartialEq, Eq, FromRow)]
pub struct Practice {
    pub name: String,
    pub created_seq: i64,
}

pub async fn get(conn: &mut SqliteConnection) -> Result<Option<Practice>> {
    Ok(
        sqlx::query_as("SELECT name, created_seq FROM practice WHERE id = 1")
            .fetch_optional(conn)
            .await?,
    )
}

pub async fn insert(conn: &mut SqliteConnection, practice: &Practice) -> Result<()> {
    sqlx::query("INSERT INTO practice (id, name, created_seq) VALUES (1, ?, ?)")
        .bind(&practice.name)
        .bind(practice.created_seq)
        .execute(conn)
        .await?;
    Ok(())
}
