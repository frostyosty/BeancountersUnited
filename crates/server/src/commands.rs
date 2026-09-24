//! The commands clients submit to `POST /api/commands`, and what they get back.

use acct_core::{Account, AccountCode, JournalLine, Mapping, TbLine, Template};
use acct_store::users::Role;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::pipeline::Actor;

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
    /// Names the practice and creates its first master user. Only `acctd init` on the server can
    /// submit it, and only once.
    Initialise {
        practice_name: String,
        username: String,
        display_name: String,
        password: String,
    },
    /// Adds a user. Master only.
    CreateUser {
        username: String,
        display_name: String,
        password: String,
        role: Role,
    },
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
    /// Adds an account to a client's chart. Its code must be new to the chart.
    AddAccount { client_id: String, account: Account },
    /// Renames an account in a client's chart. Codes and account types never change.
    RenameAccount {
        client_id: String,
        code: AccountCode,
        name: String,
    },
    /// Makes an account active or inactive. An account can't be made inactive while it has a
    /// balance in an open year, or while it's the retained earnings account.
    SetAccountActive {
        client_id: String,
        code: AccountCode,
        active: bool,
    },
    /// Replaces a client's rounding priority list (`docs/domain.md`, Rounding).
    SetRoundingPriority {
        client_id: String,
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
    /// Imports a year's trial balance, as previewed by `POST /api/years/{id}/tb-import/preview`.
    /// Posts the TB less the opening balances as the year's TB-import journal, replacing any
    /// earlier one. Every other journal is left alone.
    ImportTb {
        client_year_id: String,
        rows: Vec<TbLine>,
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
            Command::Initialise { .. } => "initialise",
            Command::CreateUser { .. } => "create_user",
            Command::CreateMasterChart { .. } => "create_master_chart",
            Command::CreateTemplate { .. } => "create_template",
            Command::ReviseTemplate { .. } => "revise_template",
            Command::CreateMapping { .. } => "create_mapping",
            Command::ReviseMapping { .. } => "revise_mapping",
            Command::CreateClient { .. } => "create_client",
            Command::AddAccount { .. } => "add_account",
            Command::RenameAccount { .. } => "rename_account",
            Command::SetAccountActive { .. } => "set_account_active",
            Command::SetRoundingPriority { .. } => "set_rounding_priority",
            Command::CreateClientYear { .. } => "create_client_year",
            Command::PostJournal { .. } => "post_journal",
            Command::ImportTb { .. } => "import_tb",
            Command::ReverseJournal { .. } => "reverse_journal",
        }
    }

    /// The payload as stored in `command_log`. Commands carrying secrets blank them here.
    pub fn logged_payload(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).expect("commands serialise");
        let mut payload = v["payload"].take();
        if let Some(password) = payload.get_mut("password") {
            *password = "[redacted]".into();
        }
        payload
    }

    /// Whether `actor` may submit this command.
    pub fn allowed_for(&self, actor: &Actor) -> bool {
        let role = actor.role;
        match self {
            Command::Initialise { .. } => actor.user_id.is_none(),
            Command::CreateUser { .. }
            | Command::CreateMasterChart { .. }
            | Command::CreateTemplate { .. }
            | Command::ReviseTemplate { .. }
            | Command::CreateMapping { .. }
            | Command::ReviseMapping { .. } => role == Role::Master,
            Command::CreateClient { .. }
            | Command::AddAccount { .. }
            | Command::RenameAccount { .. }
            | Command::SetAccountActive { .. }
            | Command::SetRoundingPriority { .. }
            | Command::CreateClientYear { .. }
            | Command::PostJournal { .. }
            | Command::ImportTb { .. }
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
