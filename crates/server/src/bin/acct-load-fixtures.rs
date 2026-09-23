//! Loads the synthetic fixtures into a new, empty database, entirely through the command
//! pipeline (CLAUDE.md hard rule 6). `make db-reset` runs it after deleting the dev database.
//!
//! It sets the server up as `acctd init` would and adds one user per role, all with
//! `DEV_PASSWORD`. For development only: never point it at a real practice's database.

use std::path::PathBuf;

use acct_core::{Account, AccountCode, Journal};
use acct_server::commands::{Command, CommandEnvelope};
use acct_server::pipeline::{Actor, submit};
use acct_store::Store;
use acct_store::users::Role;
use chrono::NaiveDate;
use serde::Deserialize;

const CHART: &str = include_str!("../../../../fixtures/practice/company-chart.json");
const TEMPLATE: &str = include_str!("../../../../fixtures/practice/company-template.json");
const MAPPING: &str = include_str!("../../../../fixtures/practice/company-mapping.json");
const CLIENT: &str = include_str!("../../../../fixtures/clients/example-widgets.json");

const DEV_PASSWORD: &str = "fixture-password";

#[derive(Deserialize)]
struct Client {
    name: String,
    entity_type: String,
    retained_earnings: AccountCode,
    rounding_priority: Vec<AccountCode>,
    years: Vec<Year>,
}

#[derive(Deserialize)]
struct Year {
    start: NaiveDate,
    end: NaiveDate,
    journals: Vec<Journal>,
}

type BoxError = Box<dyn std::error::Error>;

struct Loader {
    store: Store,
    actor: Actor,
}

impl Loader {
    /// Submits a command and returns the id of what it created.
    async fn run(&self, command: Command) -> Result<Option<String>, BoxError> {
        let kind = command.kind();
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        match submit(&self.store, &self.actor, envelope, chrono::Utc::now()).await {
            Ok(accepted) => Ok(accepted.entity_id),
            Err(e) => Err(format!("{kind}: {}", serde_json::to_string(&e.body())?).into()),
        }
    }

    async fn create(&self, command: Command) -> Result<String, BoxError> {
        let kind = command.kind();
        self.run(command)
            .await?
            .ok_or_else(|| format!("{kind} created nothing").into())
    }
}

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let db = PathBuf::from(std::env::var("ACCT_DB").unwrap_or_else(|_| "data/acct.db".to_owned()));
    if let Some(dir) = db.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir)?;
    }
    let store = Store::open(&db).await?;
    let mut loader = Loader {
        store,
        actor: Actor {
            user_id: None,
            role: Role::Master,
        },
    };

    let admin = loader
        .create(Command::Initialise {
            practice_name: "Example Practice".into(),
            username: "admin".into(),
            display_name: "Example Admin".into(),
            password: DEV_PASSWORD.into(),
        })
        .await?;
    loader.actor = Actor {
        user_id: Some(admin),
        role: Role::Master,
    };
    for (username, role) in [("staff", Role::Staff), ("viewer", Role::Viewer)] {
        loader
            .create(Command::CreateUser {
                username: username.into(),
                display_name: format!("Example {username}"),
                password: DEV_PASSWORD.into(),
                role,
            })
            .await?;
    }

    let accounts: Vec<Account> = serde_json::from_str(CHART)?;
    loader
        .create(Command::CreateMasterChart {
            entity_type: "company".into(),
            name: "Company".into(),
            accounts,
        })
        .await?;
    let template_id = loader
        .create(Command::CreateTemplate {
            entity_type: "company".into(),
            name: "Company (standard)".into(),
            body: serde_json::from_str(TEMPLATE)?,
        })
        .await?;
    loader
        .create(Command::CreateMapping {
            template_id,
            name: "Company (standard)".into(),
            body: serde_json::from_str(MAPPING)?,
        })
        .await?;

    let client: Client = serde_json::from_str(CLIENT)?;
    let client_id = loader
        .create(Command::CreateClient {
            name: client.name.clone(),
            entity_type: client.entity_type,
            retained_earnings: client.retained_earnings,
            rounding_priority: client.rounding_priority,
        })
        .await?;
    let mut journals = 0;
    for year in client.years {
        let client_year_id = loader
            .create(Command::CreateClientYear {
                client_id: client_id.clone(),
                start: year.start,
                end: year.end,
                mapping_id: None,
            })
            .await?;
        for j in year.journals {
            loader
                .create(Command::PostJournal {
                    client_year_id: client_year_id.clone(),
                    date: j.date,
                    narration: j.narration,
                    lines: j.lines,
                })
                .await?;
            journals += 1;
        }
    }

    println!(
        "Loaded {} with {journals} journals into {}.",
        client.name,
        db.display()
    );
    println!("Log in as admin, staff or viewer, password {DEV_PASSWORD:?}.");
    Ok(())
}
