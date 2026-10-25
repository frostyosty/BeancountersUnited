//! The commands clients submit to `POST /api/commands`, and what they get back.

use acct_core::coding::{Coding, CodingSettings};
use acct_core::notes::{Paragraph, Placement};
use acct_core::{
    Account, AccountCode, AssetAccounts, DepreciationSettings, Disposal, GstCode, JournalLine,
    Mapping, Money, OpeningBalance, TbLine, Template,
};
use acct_store::users::Role;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ai::SuggestedCoding;
use crate::business::GstSetup;
use crate::starter::StarterSet;

/// The request body: `{ id, kind, payload }`. `id` is a UUID the client makes with `newId()`, and
/// is the idempotency key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CommandEnvelope {
    pub id: String,
    #[serde(flatten)]
    pub command: Command,
}

/// The body of `POST /api/commands`: a command, plus how it came about when it isn't the user's
/// own doing alone (ADR 009), which is stored in `command_log.via`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct CommandRequest {
    #[serde(flatten)]
    pub envelope: CommandEnvelope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub via: Option<Via>,
}

/// ADR 009's attribution. The signed-in user is still the actor; `via` says what they accepted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum Via {
    /// The user accepted AI suggestions as they were. If they edited a pre-fill first, the change
    /// is theirs alone and carries no `via`.
    Suggestion {
        /// The model that made the suggestions, such as `claude-haiku-5-5`.
        model: String,
        suggestion_ids: Vec<String>,
    },
}

/// One line to code, in `code_bank_line` or `code_bank_lines`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LineCoding {
    pub bank_line_id: String,
    pub coding: Coding,
    /// The owner holds the supplier's taxable supply information (lines over $200). `true` records
    /// today as the date they confirmed; absent or `false` leaves any earlier confirmation alone.
    #[serde(default)]
    #[ts(optional)]
    pub supply_info_confirmed: Option<bool>,
    /// For an asset purchase: the asset class. Needed only when more than one class uses the
    /// coding's cost account.
    #[serde(default)]
    #[ts(optional)]
    pub asset_class_id: Option<String>,
}

/// An answer to one of Save tax's questions, for one income year.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "question", rename_all = "snake_case")]
#[ts(export)]
pub enum Answer {
    /// "Is this business your only income?"
    OnlyIncome { yes: bool },
    /// The income from outside the business, and the tax (PAYE, RWT) already deducted from it.
    /// Implies the business isn't the only income.
    OtherIncome { income: Money, tax_deducted: Money },
    /// "Do you have a student loan?"
    StudentLoan { yes: bool },
    /// The independent earner tax credit: whole months of the year the owner is eligible, 0 to 12.
    Ietc { months: u8 },
}

/// What a payment to or from IRD was.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export)]
pub enum IrdPayment {
    /// GST: paid to IRD, or a refund from IRD.
    Gst,
    /// Income tax paid for an income year (named by the year it ends in), a credit against it.
    IncomeTax { income_year: i32 },
}

/// Every change to practice or client data (CLAUDE.md hard rule 6).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", content = "payload", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Command {
    /// Names the practice and creates its first practice admin. Only `acctd init` on the server
    /// can submit it, and only once.
    Initialise {
        practice_name: String,
        username: String,
        display_name: String,
        password: String,
    },
    /// Adds a user. Practice admin only.
    CreateUser {
        username: String,
        display_name: String,
        password: String,
        role: Role,
    },
    /// Changes the submitting user's own password. Any role.
    ChangeOwnPassword {
        current_password: String,
        new_password: String,
    },
    /// Sets a user's password and ends their sessions. Practice admin only.
    ResetPassword {
        user_id: String,
        new_password: String,
    },
    /// Makes a user active or inactive; making one inactive ends their sessions. Practice admin only.
    /// Nobody can make themselves inactive, and the last active practice admin stays active.
    SetUserActive { user_id: String, active: bool },
    /// Installs a starter set (`crate::starter`): the master chart, statement template, mapping
    /// and asset classes for its entity type, all at once. Refused if that entity type already has
    /// any of them. Practice admin only.
    InstallStarterSet { set: StarterSet },
    /// Sets up the practice master chart for an entity type. Practice admin only.
    CreateMasterChart {
        entity_type: String,
        name: String,
        accounts: Vec<Account>,
    },
    /// Adds an account to an entity type's master chart. Its code must be new to the chart.
    /// Existing clients' charts don't change; new clients get it. Practice admin only.
    AddMasterAccount {
        entity_type: String,
        account: Account,
    },
    /// Renames an account in a master chart. Existing clients' charts don't change. Practice admin
    /// only.
    RenameMasterAccount {
        entity_type: String,
        code: AccountCode,
        name: String,
    },
    /// Makes a master chart account active or inactive, so new clients get it that way. Refused
    /// while a practice asset class or merchant entry uses it, or while setting up a business
    /// needs it. Existing clients' charts don't change. Practice admin only.
    SetMasterAccountActive {
        entity_type: String,
        code: AccountCode,
        active: bool,
    },
    /// Sets or clears a master chart account's default GST code (income and expense accounts
    /// only). Existing clients' charts don't change. Practice admin only.
    SetMasterAccountGst {
        entity_type: String,
        code: AccountCode,
        default_gst: Option<GstCode>,
    },
    /// Creates a statement template with its first version. Practice admin only.
    CreateTemplate {
        entity_type: String,
        name: String,
        body: Template,
    },
    /// Writes a new version of a template. Years already pinned to an older version keep it until
    /// `move_year_layout`. Every mapping onto the template must still fit the new version: those
    /// that wouldn't are revised in the same command, through `mappings`, or it's refused.
    /// Practice admin only.
    ReviseTemplate {
        template_id: String,
        body: Template,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        mappings: Option<Vec<MappingRevision>>,
    },
    /// Creates a mapping onto a template, with its first version. Practice admin only.
    CreateMapping {
        template_id: String,
        name: String,
        body: Mapping,
    },
    /// Writes a new version of a mapping. Practice admin only.
    ReviseMapping { mapping_id: String, body: Mapping },
    /// Moves an open year onto the latest version of a mapping and of its template: by default the
    /// mapping the year already uses, or `mapping_id`, another for its entity type. Preview it with
    /// `GET /api/years/{id}/layout`. Refused if the year's statements couldn't be built that way, or
    /// if it's already on those versions. Comparatives follow, as they're presented through the
    /// year's own layout.
    MoveYearLayout {
        client_year_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        mapping_id: Option<String>,
    },
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
    /// Sets or clears the default GST code of an income or expense account in a client's chart.
    /// It changes no figures, so it's allowed in finalised years too.
    SetAccountGst {
        client_id: String,
        code: AccountCode,
        default_gst: Option<GstCode>,
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
    /// Adds a practice asset class for an entity type. `key` is a stable name such as `plant`
    /// (lowercase words joined by underscores) that the asset schedule uses. Practice admin only.
    CreateAssetClass {
        entity_type: String,
        key: String,
        name: String,
        settings: DepreciationSettings,
        accounts: AssetAccounts,
    },
    /// Changes a practice asset class. Existing assets keep the settings and accounts copied onto
    /// them; `apply_asset_class_defaults` pushes a change onto them. Practice admin only.
    UpdateAssetClass {
        class_id: String,
        name: String,
        settings: DepreciationSettings,
        accounts: AssetAccounts,
    },
    /// Sets a client's override of a practice asset class. `None` parts fall back to the
    /// practice's, so both `None` removes the override. Existing assets aren't changed.
    SetClientAssetClass {
        client_id: String,
        class_id: String,
        #[ts(optional)]
        settings: Option<DepreciationSettings>,
        #[ts(optional)]
        accounts: Option<AssetAccounts>,
    },
    /// Adds an asset to a client's register. The class's resolved settings and accounts are
    /// copied onto it; `settings`, if given and different, makes them custom. `opening` is needed
    /// for an asset acquired before the client's first year.
    CreateAsset {
        client_id: String,
        class_id: String,
        name: String,
        cost: Money,
        residual: Money,
        #[ts(type = "string")]
        acquired: NaiveDate,
        #[ts(optional)]
        settings: Option<DepreciationSettings>,
        #[ts(optional)]
        opening: Option<OpeningBalance>,
    },
    /// Edits an asset. Cost, residual, acquisition date and the brought-forward balance can
    /// change only while no finalised year holds the asset. `settings` absent resets them to the
    /// class's resolved defaults. The open years' depreciation becomes stale until it's run.
    UpdateAsset {
        asset_id: String,
        name: String,
        cost: Money,
        residual: Money,
        #[ts(type = "string")]
        acquired: NaiveDate,
        #[ts(optional)]
        settings: Option<DepreciationSettings>,
        #[ts(optional)]
        opening: Option<OpeningBalance>,
    },
    /// Removes an asset that no finalised year holds. Its journals go at the next run.
    DeleteAsset { asset_id: String },
    /// Records a disposal and reposts that year's asset journals, including the disposal
    /// journal. The year must be open.
    DisposeAsset {
        asset_id: String,
        disposal: Disposal,
    },
    /// Undoes a disposal and reposts that year's asset journals. The year must be open.
    ReinstateAsset { asset_id: String },
    /// Reposts the asset journals (depreciation and disposals) of every open year up to and
    /// including this one, reversing any that changed. Years already current post nothing.
    RunDepreciation { client_year_id: String },
    /// Pushes a class's current defaults (the client's override, else the practice's) onto the
    /// client's assets in that class: settings unless an asset's are custom, and accounts.
    /// Preview it with `GET /api/clients/{id}/asset-classes/{class_id}/apply-preview`. Only open
    /// years change, at the next run.
    ApplyAssetClassDefaults { client_id: String, class_id: String },
    /// Sets up a business (M10): a sole-trader client whose chart is a copy of the master chart,
    /// with its start date and GST registration. Only the payments basis is accepted.
    SetUpBusiness {
        name: String,
        #[ts(type = "string")]
        start_date: NaiveDate,
        #[ts(optional)]
        gst: Option<GstSetup>,
    },
    /// Adds a bank account to a business, with its own account (600.01, ...) in the chart.
    AddBankAccount {
        client_id: String,
        name: String,
        #[ts(optional)]
        account_number: Option<String>,
    },
    /// Uploads a bank statement file (base64). Every new line posts straight away: money in as
    /// income (less GST), money out as not yet sorted. Lines already imported are skipped. Without
    /// `bank_account_id`, the file's account number picks the account, or adds one.
    ImportStatement {
        client_id: String,
        file_name: String,
        content_base64: String,
        #[ts(optional)]
        bank_account_id: Option<String>,
    },
    /// The owner's balance for a bank account on the start date, when its first statement starts
    /// later. Posts the opening-balance journal; set once.
    SetOpeningBalance {
        bank_account_id: String,
        balance: Money,
    },
    /// Codes one bank line (Save tax): reverses its live journal and posts the coding's, in one
    /// command. Posted journals never change. An asset purchase also adds the asset to the
    /// register. Recoding one line of a confirmed transfer undoes the pair; the other line goes
    /// back to unsorted.
    CodeBankLine {
        #[serde(flatten)]
        line: LineCoding,
    },
    /// Codes several lines at once ("accept all"). All or nothing.
    CodeBankLines { lines: Vec<LineCoding> },
    /// Adds a rule, such as "always treat COUNTDOWN as personal", and codes every unsorted line it
    /// matches. Later uploads are coded by it too. Lines coded by hand are left alone.
    AddRule {
        client_id: String,
        description_contains: String,
        #[ts(optional)]
        min: Option<Money>,
        #[ts(optional)]
        max: Option<Money>,
        coding: Coding,
    },
    /// Removes a rule. Lines it already coded stay as they are.
    RemoveRule { rule_id: String },
    /// Answers a Save tax question for an income year.
    AnswerQuestion {
        client_id: String,
        income_year: i32,
        answer: Answer,
    },
    /// Confirms two lines are a transfer between the owner's own accounts: one journal moves the
    /// money between the two accounts, and both lines' old journals are reversed.
    ConfirmTransfer {
        out_line_id: String,
        in_line_id: String,
    },
    /// Says what a payment to or from IRD was. Income tax paid is a credit for its year.
    ConfirmIrdPayment {
        bank_line_id: String,
        payment: IrdPayment,
    },
    /// Answers whether a line flagged as a possible duplicate is one. A duplicate posts nothing.
    ResolveDuplicate {
        bank_line_id: String,
        is_duplicate: bool,
    },
    /// The owner holds the supplier's taxable supply information for a line, so GST over $200 can
    /// be claimed. Recodes the line if it's already coded.
    ConfirmSupplyInfo { bank_line_id: String },
    /// Adds a credit card to a business, with its own liability account (850.01, ...).
    /// `card_number` is the card's last four digits or its number as a statement shows it; only
    /// the masked form, `XXXX-XXXX-XXXX-1234`, is kept.
    AddCardAccount {
        client_id: String,
        name: String,
        #[ts(optional)]
        card_number: Option<String>,
    },
    /// Changes a business's coding settings. It changes no figures, so it's allowed in finalised
    /// years; it applies only to lines coded afterwards.
    SetCodingSettings {
        client_id: String,
        settings: CodingSettings,
    },
    /// Turns AI category suggestions on or off for a business (ADR 009). Off by default.
    /// Turning them on needs `consent_version`, from `GET /api/businesses/{id}/ai-suggestions`,
    /// once the owner has agreed to the wording; turning them off stops all requests and deletes
    /// the suggestions still waiting. The business owner does this, or staff on their behalf. `activity` (the owner's phrase for what the business does)
    /// and `private_names` (names to strip from what's sent, besides the business's own), when
    /// absent, keep what's stored.
    SetAiSuggestions {
        client_id: String,
        enabled: bool,
        #[ts(optional)]
        consent_version: Option<String>,
        #[ts(optional)]
        activity: Option<String>,
        #[ts(optional)]
        private_names: Option<Vec<String>>,
    },
    /// Adds an entry to an entity type's merchant list (ADR 009's layer 3), such as "Z ENERGY is
    /// vehicle costs", in the master chart's codes. Save tax suggests it after the business's
    /// rules and history. It never changes a coded line. Use synthetic or consented data only.
    /// Practice admin only.
    AddMerchant {
        entity_type: String,
        description_contains: String,
        coding: Coding,
    },
    /// Takes an entry off the merchant list. Practice admin only.
    RemoveMerchant { merchant_id: String },
    /// Stores AI suggestions for unsorted lines as pre-fills. It changes no figures. The server
    /// submits it from `POST /api/businesses/{id}/ai-suggestions`.
    RecordSuggestions {
        client_id: String,
        /// The model that made them, such as `claude-haiku-5-5`.
        model: String,
        suggestions: Vec<SuggestedCoding>,
    },
    /// A business owner signs up (M12): their account, with `email` as the username, and their
    /// business, set up as `set_up_business` does. Only `POST /api/signup` submits it, before
    /// there's a session; it then signs the owner in.
    SignUp {
        email: String,
        display_name: String,
        password: String,
        business_name: String,
        #[ts(type = "string")]
        start_date: NaiveDate,
        #[ts(optional)]
        gst: Option<GstSetup>,
    },
    /// The owner invites their accountant. `token` is 32 random bytes as hex, made by the browser
    /// for the link the owner copies; only its hash is kept, and it's redacted from the log.
    /// Sending the email is out of scope for now. An invite lasts 14 days and is used once.
    CreateInvite {
        client_id: String,
        email: String,
        token: String,
    },
    /// A practice user accepts an invite, which lets them see and work on that business.
    AcceptInvite { token: String },
    /// Finalises a year (M15): checks it's ready, stores the snapshot (the TB, the pinned template
    /// and mapping versions, the ReportDoc and its SHA-256), and locks the year. Practice admin
    /// only, signed in. `accept_uncategorised` says the accountant accepts any bank lines still
    /// unsorted as they are; it's kept in the log with the command.
    FinaliseYear {
        client_year_id: String,
        #[serde(default)]
        #[ts(optional)]
        accept_uncategorised: Option<bool>,
    },
    /// Reopens a finalised year so its numbers can change again. Practice admin only, with a
    /// reason, which is kept in the log. The year's snapshots stay on record. A later finalised
    /// year has to be reopened first.
    ReopenYear {
        client_year_id: String,
        reason: String,
    },
    /// Adds a paragraph to an entity type's library (M15), in our own wording (hard rule 3), with
    /// fields such as `{business_name}`. Practice admin only.
    AddParagraph {
        entity_type: String,
        paragraph: Paragraph,
    },
    /// Writes a new version of a library paragraph. Its key stays. No year's copy changes until
    /// `push_paragraph`. Practice admin only.
    ReviseParagraph {
        paragraph_id: String,
        placement: Placement,
        title: String,
        body: String,
    },
    /// Sets which library paragraphs an open year's notes use, in order. Paragraphs it already
    /// has keep their copies (and any edits); new ones are copied at the latest version; ones
    /// left off are dropped.
    PickNotes {
        client_year_id: String,
        paragraph_ids: Vec<String>,
    },
    /// Edits an open year's copy of a paragraph. The library is unchanged, and later pushes skip
    /// this copy.
    EditNote {
        client_year_id: String,
        paragraph_id: String,
        title: String,
        body: String,
    },
    /// Pushes a library paragraph's latest version onto every open year's unedited copy of it.
    /// Preview it with `GET /api/paragraphs/{id}/push-preview`. Finalised years and edited copies
    /// are left alone. Practice admin only.
    PushParagraph { paragraph_id: String },
    /// Takes a paragraph out of the library. Years that picked it keep their copies, but no year
    /// can newly pick it. Its key can be added again. Practice admin only.
    RemoveParagraph { paragraph_id: String },
}

impl Command {
    /// The name stored in `command_log.kind`, as it appears on the wire.
    pub fn kind(&self) -> &'static str {
        match self {
            Command::Initialise { .. } => "initialise",
            Command::CreateUser { .. } => "create_user",
            Command::ChangeOwnPassword { .. } => "change_own_password",
            Command::ResetPassword { .. } => "reset_password",
            Command::SetUserActive { .. } => "set_user_active",
            Command::InstallStarterSet { .. } => "install_starter_set",
            Command::CreateMasterChart { .. } => "create_master_chart",
            Command::AddMasterAccount { .. } => "add_master_account",
            Command::RenameMasterAccount { .. } => "rename_master_account",
            Command::SetMasterAccountActive { .. } => "set_master_account_active",
            Command::SetMasterAccountGst { .. } => "set_master_account_gst",
            Command::CreateTemplate { .. } => "create_template",
            Command::ReviseTemplate { .. } => "revise_template",
            Command::CreateMapping { .. } => "create_mapping",
            Command::ReviseMapping { .. } => "revise_mapping",
            Command::MoveYearLayout { .. } => "move_year_layout",
            Command::CreateClient { .. } => "create_client",
            Command::AddAccount { .. } => "add_account",
            Command::RenameAccount { .. } => "rename_account",
            Command::SetAccountActive { .. } => "set_account_active",
            Command::SetAccountGst { .. } => "set_account_gst",
            Command::SetRoundingPriority { .. } => "set_rounding_priority",
            Command::CreateClientYear { .. } => "create_client_year",
            Command::PostJournal { .. } => "post_journal",
            Command::ImportTb { .. } => "import_tb",
            Command::ReverseJournal { .. } => "reverse_journal",
            Command::CreateAssetClass { .. } => "create_asset_class",
            Command::UpdateAssetClass { .. } => "update_asset_class",
            Command::SetClientAssetClass { .. } => "set_client_asset_class",
            Command::CreateAsset { .. } => "create_asset",
            Command::UpdateAsset { .. } => "update_asset",
            Command::DeleteAsset { .. } => "delete_asset",
            Command::DisposeAsset { .. } => "dispose_asset",
            Command::ReinstateAsset { .. } => "reinstate_asset",
            Command::RunDepreciation { .. } => "run_depreciation",
            Command::ApplyAssetClassDefaults { .. } => "apply_asset_class_defaults",
            Command::SetUpBusiness { .. } => "set_up_business",
            Command::AddBankAccount { .. } => "add_bank_account",
            Command::ImportStatement { .. } => "import_statement",
            Command::SetOpeningBalance { .. } => "set_opening_balance",
            Command::CodeBankLine { .. } => "code_bank_line",
            Command::CodeBankLines { .. } => "code_bank_lines",
            Command::AddRule { .. } => "add_rule",
            Command::RemoveRule { .. } => "remove_rule",
            Command::AnswerQuestion { .. } => "answer_question",
            Command::ConfirmTransfer { .. } => "confirm_transfer",
            Command::ConfirmIrdPayment { .. } => "confirm_ird_payment",
            Command::ResolveDuplicate { .. } => "resolve_duplicate",
            Command::ConfirmSupplyInfo { .. } => "confirm_supply_info",
            Command::AddCardAccount { .. } => "add_card_account",
            Command::SetCodingSettings { .. } => "set_coding_settings",
            Command::SetAiSuggestions { .. } => "set_ai_suggestions",
            Command::RecordSuggestions { .. } => "record_suggestions",
            Command::AddMerchant { .. } => "add_merchant",
            Command::RemoveMerchant { .. } => "remove_merchant",
            Command::SignUp { .. } => "sign_up",
            Command::CreateInvite { .. } => "create_invite",
            Command::AcceptInvite { .. } => "accept_invite",
            Command::FinaliseYear { .. } => "finalise_year",
            Command::ReopenYear { .. } => "reopen_year",
            Command::AddParagraph { .. } => "add_paragraph",
            Command::ReviseParagraph { .. } => "revise_paragraph",
            Command::PickNotes { .. } => "pick_notes",
            Command::EditNote { .. } => "edit_note",
            Command::PushParagraph { .. } => "push_paragraph",
            Command::RemoveParagraph { .. } => "remove_paragraph",
        }
    }

    /// The payload as stored in `command_log`. Commands carrying secrets blank them here.
    pub fn logged_payload(&self) -> serde_json::Value {
        let mut v = serde_json::to_value(self).expect("commands serialise");
        let mut payload = v["payload"].take();
        for key in ["password", "current_password", "new_password", "token"] {
            if let Some(secret) = payload.get_mut(key) {
                *secret = "[redacted]".into();
            }
        }
        payload
    }
}

/// A mapping's new version, revised along with its template in `revise_template`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct MappingRevision {
    pub mapping_id: String,
    pub body: Mapping,
}

/// The response to an accepted command, returned again for a resubmitted `id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Accepted {
    pub seq: i64,
    /// The id of the entity the command created, if it created one.
    pub entity_id: Option<String>,
}
