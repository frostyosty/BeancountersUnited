//! Starter sets: the practice defaults that ship with the app, so a new practice can create
//! clients straight away. Each is one entity type's master chart, statement template, mapping and
//! asset classes, read from the synthetic files in `fixtures/practice/` (our own content, hard
//! rule 3). There's one copy of the data: the dev fixture loader installs the same sets.
//!
//! `install_starter_set` applies them as the commands an admin would otherwise submit one by one,
//! within the one command and its one transaction, so each part is validated exactly as those
//! commands are, and a refused part leaves nothing behind.

use acct_core::{Account, AssetAccounts, DepreciationSettings, Mapping, Template};
use acct_store::{SqliteConnection, assets, charts, templates};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;
use ts_rs::TS;

use crate::commands::Command;
use crate::error::CommandError;

/// A starter set, named by the entity type it sets up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum StarterSet {
    Company,
    SoleTrader,
}

impl StarterSet {
    pub const ALL: [StarterSet; 2] = [StarterSet::Company, StarterSet::SoleTrader];

    /// The entity type it sets up.
    pub fn entity_type(self) -> &'static str {
        match self {
            StarterSet::Company => "company",
            StarterSet::SoleTrader => "sole_trader",
        }
    }

    /// The master chart's name; the template and mapping are this plus " (standard)".
    pub fn name(self) -> &'static str {
        match self {
            StarterSet::Company => "Company",
            StarterSet::SoleTrader => "Sole trader",
        }
    }

    fn files(self) -> Files {
        match self {
            StarterSet::Company => Files {
                chart: include_str!("../../../fixtures/practice/company-chart.json"),
                template: include_str!("../../../fixtures/practice/company-template.json"),
                mapping: include_str!("../../../fixtures/practice/company-mapping.json"),
                classes: include_str!("../../../fixtures/practice/company-asset-classes.json"),
            },
            StarterSet::SoleTrader => Files {
                chart: include_str!("../../../fixtures/practice/sole-trader-chart.json"),
                template: include_str!("../../../fixtures/practice/sole-trader-template.json"),
                mapping: include_str!("../../../fixtures/practice/sole-trader-mapping.json"),
                classes: include_str!("../../../fixtures/practice/sole-trader-asset-classes.json"),
            },
        }
    }

    /// The set's contents. The files are built in, and a test parses every set, so this can't
    /// fail at run time.
    pub fn contents(self) -> Contents {
        let f = self.files();
        Contents {
            accounts: self.parse("chart", f.chart),
            template: self.parse("template", f.template),
            mapping: self.parse("mapping", f.mapping),
            classes: self.parse("asset classes", f.classes),
        }
    }

    fn parse<T: DeserializeOwned>(self, what: &str, json: &str) -> T {
        serde_json::from_str(json)
            .unwrap_or_else(|e| panic!("the {} starter {what} parses: {e}", self.name()))
    }
}

struct Files {
    chart: &'static str,
    template: &'static str,
    mapping: &'static str,
    classes: &'static str,
}

/// What a starter set holds.
pub struct Contents {
    pub accounts: Vec<Account>,
    pub template: Template,
    pub mapping: Mapping,
    pub classes: Vec<StarterClass>,
}

/// One of a starter set's asset classes, as `fixtures/practice/*-asset-classes.json` has it.
#[derive(Debug, Clone, Deserialize)]
pub struct StarterClass {
    pub key: String,
    pub name: String,
    pub settings: DepreciationSettings,
    pub accounts: AssetAccounts,
}

impl Contents {
    pub fn chart_command(&self, set: StarterSet) -> Command {
        Command::CreateMasterChart {
            entity_type: set.entity_type().into(),
            name: set.name().into(),
            accounts: self.accounts.clone(),
        }
    }

    pub fn template_command(&self, set: StarterSet) -> Command {
        Command::CreateTemplate {
            entity_type: set.entity_type().into(),
            name: standard(set),
            body: self.template.clone(),
        }
    }

    pub fn mapping_command(&self, set: StarterSet, template_id: String) -> Command {
        Command::CreateMapping {
            template_id,
            name: standard(set),
            body: self.mapping.clone(),
        }
    }

    pub fn class_commands(&self, set: StarterSet) -> Vec<Command> {
        self.classes
            .iter()
            .map(|c| Command::CreateAssetClass {
                entity_type: set.entity_type().into(),
                key: c.key.clone(),
                name: c.name.clone(),
                settings: c.settings,
                accounts: c.accounts.clone(),
            })
            .collect()
    }
}

fn standard(set: StarterSet) -> String {
    format!("{} (standard)", set.name())
}

/// A starter set goes only onto an entity type with no defaults yet: defaults never reach back,
/// so it can't merge into a chart, templates or asset classes already there.
pub async fn check_free(tx: &mut SqliteConnection, set: StarterSet) -> Result<(), CommandError> {
    let entity_type = set.entity_type();
    let mut found = Vec::new();
    if charts::for_entity_type(tx, entity_type).await?.is_some() {
        found.push(json!({ "code": "master_chart_exists" }));
    }
    let template_count = templates::list_templates(tx)
        .await?
        .iter()
        .filter(|t| t.entity_type == entity_type)
        .count();
    if template_count > 0 {
        found.push(json!({ "code": "templates_exist", "count": template_count }));
    }
    let class_count = assets::classes_for_entity_type(tx, entity_type)
        .await?
        .len();
    if class_count > 0 {
        found.push(json!({ "code": "asset_classes_exist", "count": class_count }));
    }
    if found.is_empty() {
        return Ok(());
    }
    Err(CommandError::invalid_with(
        "starter_set_installed",
        format!(
            "The {} defaults are already set up, so the starter set can't be installed over them.",
            set.name().to_lowercase()
        ),
        found,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_starter_set_parses_and_its_mapping_fits_its_template() {
        for set in StarterSet::ALL {
            let c = set.contents();
            assert!(!c.accounts.is_empty(), "{set:?}");
            acct_core::Chart::new(c.accounts.clone()).unwrap();
            c.template.validate().unwrap();
            c.mapping.validate(&c.template).unwrap();
            assert!(!c.classes.is_empty(), "{set:?}");
        }
    }
}
