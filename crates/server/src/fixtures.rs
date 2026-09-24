//! Loads the synthetic fixtures into a new, empty database, entirely through the command
//! pipeline (CLAUDE.md hard rule 6). `make db-reset` and the `acct-dev` desktop app use it.
//!
//! It sets the server up as `acctd init` would and adds one user per role, all with
//! `DEV_PASSWORD`. For development only: never point it at a real practice's database.

use acct_core::{Account, AccountCode, AssetAccounts, DepreciationSettings, Journal, Money};
use acct_store::Store;
use acct_store::users::Role;
use chrono::NaiveDate;
use serde::Deserialize;

use crate::commands::{Command, CommandEnvelope};
use crate::pipeline::{Actor, submit};

const CHART: &str = include_str!("../../../fixtures/practice/company-chart.json");
const TEMPLATE: &str = include_str!("../../../fixtures/practice/company-template.json");
const MAPPING: &str = include_str!("../../../fixtures/practice/company-mapping.json");
const CLIENT: &str = include_str!("../../../fixtures/clients/example-widgets.json");
const ASSET_CLASSES: &str = include_str!("../../../fixtures/practice/company-asset-classes.json");

pub const DEV_PASSWORD: &str = "fixture-password";

/// The dev users `load` creates, one per role.
pub const DEV_USERS: [(&str, Role); 3] = [
    ("admin", Role::Master),
    ("staff", Role::Staff),
    ("viewer", Role::Viewer),
];

pub type BoxError = Box<dyn std::error::Error + Send + Sync>;

/// What `load` put in the database.
#[derive(Debug, Clone)]
pub struct Loaded {
    pub client_name: String,
    pub journals: usize,
}

#[derive(Deserialize)]
struct Client {
    name: String,
    entity_type: String,
    retained_earnings: AccountCode,
    rounding_priority: Vec<AccountCode>,
    assets: Vec<FixtureAsset>,
    years: Vec<Year>,
}

#[derive(Deserialize)]
struct AssetClass {
    key: String,
    name: String,
    settings: DepreciationSettings,
    accounts: AssetAccounts,
}

#[derive(Deserialize)]
struct FixtureAsset {
    class: String,
    name: String,
    cost: Money,
    residual: Money,
    acquired: NaiveDate,
}

#[derive(Deserialize)]
struct Year {
    start: NaiveDate,
    end: NaiveDate,
    journals: Vec<Journal>,
}

struct Loader<'a> {
    store: &'a Store,
    actor: Actor,
}

impl Loader<'_> {
    /// Submits a command and returns the id of what it created.
    async fn run(&self, command: Command) -> Result<Option<String>, BoxError> {
        let kind = command.kind();
        let envelope = CommandEnvelope {
            id: uuid::Uuid::now_v7().to_string(),
            command,
        };
        match submit(self.store, &self.actor, envelope, chrono::Utc::now()).await {
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

/// Loads the fixture practice, users and client into `store`, which must be empty.
pub async fn load(store: &Store) -> Result<Loaded, BoxError> {
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
            username: DEV_USERS[0].0.into(),
            display_name: "Example Admin".into(),
            password: DEV_PASSWORD.into(),
        })
        .await?;
    loader.actor = Actor {
        user_id: Some(admin),
        role: Role::Master,
    };
    for (username, role) in &DEV_USERS[1..] {
        loader
            .create(Command::CreateUser {
                username: (*username).into(),
                display_name: format!("Example {username}"),
                password: DEV_PASSWORD.into(),
                role: *role,
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

    let classes: Vec<AssetClass> = serde_json::from_str(ASSET_CLASSES)?;
    let mut class_ids = Vec::new();
    for class in classes {
        let id = loader
            .create(Command::CreateAssetClass {
                entity_type: "company".into(),
                key: class.key.clone(),
                name: class.name,
                settings: class.settings,
                accounts: class.accounts,
            })
            .await?;
        class_ids.push((class.key, id));
    }

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
    let mut last_year_id = None;
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
        last_year_id = Some(client_year_id);
    }

    // The register, then depreciation for every year.
    for asset in client.assets {
        let class_id = class_ids
            .iter()
            .find(|(key, _)| *key == asset.class)
            .map(|(_, id)| id.clone())
            .ok_or_else(|| format!("no asset class {}", asset.class))?;
        loader
            .create(Command::CreateAsset {
                client_id: client_id.clone(),
                class_id,
                name: asset.name,
                cost: asset.cost,
                residual: asset.residual,
                acquired: asset.acquired,
                settings: None,
                opening: None,
            })
            .await?;
    }
    if let Some(client_year_id) = last_year_id {
        loader
            .run(Command::RunDepreciation { client_year_id })
            .await?;
    }

    Ok(Loaded {
        client_name: client.name,
        journals,
    })
}
