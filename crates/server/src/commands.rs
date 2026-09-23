//! The commands clients submit to `POST /api/commands`, and what they get back.

use acct_core::{Account, AccountCode, JournalLine, Mapping, Template};
use acct_store::users::Role;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The request body: `{ id, kind, payload }`. `id` is a UUID the client makes with `newId()`, and
/// is the idempotency key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CommandEnvelope {
    pub id: String,
    #[serde(flatten)]
    pub command: Command,
}

/// Every change to practice or client data (CLAUDE.md hard rule 6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Command {
    /// Sets up the practice master chart for an entity type. Master only.
    CreateMasterChart {
        entity_type: String,
        name: String,
        accounts: Vec<Account>,
    },
    /// Creates a statement template with its first version. Master only.
    CreateTemplate {
        entity_type: String,
        name: String,
        body: Template,
    },
    /// Writes a new version of a template. Years already pinned to an older version keep it.
    /// Master only.
    ReviseTemplate { template_id: String, body: Template },
    /// Creates a mapping onto a template, with its first version. Master only.
    CreateMapping {
        template_id: String,
        name: String,
        body: Mapping,
    },
    /// Writes a new version of a mapping. Master only.
    ReviseMapping { mapping_id: String, body: Mapping },
    /// Creates a client whose chart is a copy of the master chart for its entity type.
    CreateClient {
        name: String,
        entity_type: String,
        retained_earnings: AccountCode,
        rounding_priority: Vec<AccountCode>,
    },
    /// Adds a year directly before a client's first year or after its last. Without
    /// `mapping_id`, it pins the same template and mapping versions as the neighbouring year, or
    /// for a client's first year, the latest version of the only mapping for its entity type.
    CreateClientYear {
        client_id: String,
        #[ts(type = "string")]
        start: NaiveDate,
        #[ts(type = "string")]
        end: NaiveDate,
        #[ts(optional)]
        mapping_id: Option<String>,
    },
    PostJournal {
        client_year_id: String,
        #[ts(type = "string")]
        date: NaiveDate,
        narration: String,
        lines: Vec<JournalLine>,
    },
    /// Posts a journal that reverses `journal_id`, dated `date` or, if that's absent, the
    /// original's date. A journal can be reversed only once.
    ReverseJournal {
        journal_id: String,
        #[ts(optional, type = "string")]
        date: Option<NaiveDate>,
        #[ts(optional)]
        narration: Option<String>,
    },
}

impl Command {
    /// The name stored in `command_log.kind`, as it appears on the wire.
    pub fn kind(&self) -> &'static str {
        match self {
            Command::CreateMasterChart { .. } => "create_master_chart",
            Command::CreateTemplate { .. } => "create_template",
            Command::ReviseTemplate { .. } => "revise_template",
            Command::CreateMapping { .. } => "create_mapping",
            Command::ReviseMapping { .. } => "revise_mapping",
            Command::CreateClient { .. } => "create_client",
            Command::CreateClientYear { .. } => "create_client_year",
            Command::PostJournal { .. } => "post_journal",
            Command::ReverseJournal { .. } => "reverse_journal",
        }
    }

    /// The payload as stored in `command_log`. Commands carrying secrets blank them here.
    pub fn logged_payload(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).expect("commands serialise");
        v["payload"].take()
    }

    /// Whether `role` may submit this command.
    pub fn allowed_for(&self, role: Role) -> bool {
        match self {
            Command::CreateMasterChart { .. }
            | Command::CreateTemplate { .. }
            | Command::ReviseTemplate { .. }
            | Command::CreateMapping { .. }
            | Command::ReviseMapping { .. } => role == Role::Master,
            Command::CreateClient { .. }
            | Command::CreateClientYear { .. }
            | Command::PostJournal { .. }
            | Command::ReverseJournal { .. } => matches!(role, Role::Master | Role::Staff),
        }
    }
}

/// The response to an accepted command, returned again for a resubmitted `id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Accepted {
    pub seq: i64,
    /// The id of the entity the command created, if it created one.
    pub entity_id: Option<String>,
}
