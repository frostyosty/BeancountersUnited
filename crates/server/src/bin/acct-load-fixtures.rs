//! Loads the synthetic fixtures into a new, empty database through the command pipeline.
//! `make db-reset` runs it after deleting the dev database. See `acct_server::fixtures`.

use std::path::PathBuf;

use acct_server::fixtures::{self, BoxError, DEV_PASSWORD};
use acct_store::Store;

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let db = PathBuf::from(std::env::var("ACCT_DB").unwrap_or_else(|_| "data/acct.db".to_owned()));
    if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let store = Store::open(&db).await?;
    let loaded = fixtures::load(&store).await?;
    println!(
        "Loaded {} with {} journals into {}.",
        loaded.client_name,
        loaded.journals,
        db.display()
    );
    println!("Log in as admin, staff or viewer, password {DEV_PASSWORD:?}.");
    Ok(())
}
