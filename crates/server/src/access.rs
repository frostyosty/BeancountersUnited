//! Who may read or change what (M12). This is the one place to audit:
//! - every command goes through [`check_command`], from the pipeline, before it's applied;
//! - every API route goes through [`guard`], a layer on the whole router, before its handler runs.
//!   A route with no rule in [`route_rule`] is refused for everyone.
//!
//! Both end in [`check`]. Lists that mix businesses (`/api/clients`, `/api/sync`) are filtered
//! with [`visible`], which applies the same rule as [`check`] does for one client.
//!
//! The rules:
//! - An overseer (us) sees and changes everything.
//! - Practice users see the practice's clients. A business an owner signed up with is the owner's:
//!   a practice user sees it only after accepting the owner's invite.
//! - A business owner sees only their own business, and does only the owner's work on it.
//! - What each role may do once it can see something is [`Need`]'s ladder.
//! - A user's own things (the invoice maker's drafts, templates and images) are theirs alone, at
//!   any role: no one else sees them, an overseer included.
//!
//! Something a user can't see is reported as not found, the same as if it didn't exist, naming
//! only the id they sent. Something they can see but their role can't do is forbidden.
//!
//! While an overseer views as someone (M19, ADR 013), every rule here runs as that person, the
//! effective identity ([`Actor::effective`]), so the overseer sees exactly what they'd see. The
//! three impersonation commands are the exception: they're about the overseer's own session, so
//! they're checked as the real one. What may be done while acting is decided before any of this:
//! commands in `crate::impersonation`, other routes in [`while_acting`].

use std::collections::BTreeSet;

use acct_store::users::{self, Role};
use acct_store::{
    SqliteConnection, assets, bank, clients, coding, invoices, journals, tenancy, years,
};
use axum::extract::{FromRequestParts, MatchedPath, RawPathParams, Request, State};
use axum::http::Method;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::AppState;
use crate::auth::CurrentUser;
use crate::commands::Command;
use crate::error::CommandError;
use crate::pipeline::{Actor, Identity};

/// How much a request asks to do, lowest first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Need {
    /// Look.
    Read,
    /// The owner's work on a business: uploads, Save tax, AI suggestions, inviting an accountant.
    Owner,
    /// Accountant's work: charts, journals, TB import, assets, years, setting clients up.
    Accounting,
    /// Practice settings, defaults and users.
    Admin,
}

/// The most a role may ask for, on something it can see.
fn ceiling(role: Role) -> Need {
    match role {
        Role::Overseer | Role::PracticeAdmin => Need::Admin,
        Role::Staff => Need::Accounting,
        Role::BusinessOwner => Need::Owner,
        Role::Viewer => Need::Read,
    }
}

/// What a request or command touches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// No login needed: health, login, logout, the sign-up page's request.
    Public,
    /// `acctd init` on the server itself. Never a web request.
    Server,
    /// Signing up: no user yet. Only the sign-up endpoint submits as this.
    SignUp,
    /// Any signed-in user: their own account, or `POST /api/commands`, whose commands are each
    /// checked again here.
    SignedIn,
    /// Practice-wide data: settings, defaults, master charts, templates, asset classes, merchants.
    Practice,
    /// A user account with this role (or the role being given). `None`: no such user.
    User(Option<Role>),
    /// A list the handler filters with [`visible`].
    Listing,
    /// One client's data, named as the request named it.
    Client(ClientRef),
    /// Accepting an owner's invite. The token is the permission; any practice user may use one.
    Invite,
    /// One of a user's own things, and who it belongs to (`None`: no such thing).
    Own(OwnRef),
    /// Viewing as someone (M19): starting, allowing changes, ending. Overseers only.
    Impersonation,
}

/// Something that belongs to one user, as the request named it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OwnRef {
    pub entity: &'static str,
    pub id: String,
    pub owner: Option<String>,
}

async fn invoice_template_target(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Target, CommandError> {
    let owner = invoices::template(conn, id).await?.map(|t| t.user_id);
    Ok(Target::Own(OwnRef {
        entity: "invoice template",
        id: id.to_owned(),
        owner,
    }))
}

async fn invoice_image_target(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Target, CommandError> {
    Ok(Target::Own(OwnRef {
        entity: "invoice image",
        id: id.to_owned(),
        owner: invoices::image_owner(conn, id).await?,
    }))
}

/// A client a request touches, and what the request actually named (a year, a bank line, ...),
/// so a refusal never reveals the client's id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientRef {
    pub client_id: String,
    pub named: (&'static str, String),
}

impl ClientRef {
    fn direct(client_id: &str) -> ClientRef {
        ClientRef {
            client_id: client_id.to_owned(),
            named: ("client", client_id.to_owned()),
        }
    }
}

/// The access check. Every read and every command ends here. It runs as the actor's effective
/// identity: the person an overseer is viewing as, if they are.
pub async fn check(
    conn: &mut SqliteConnection,
    actor: &Actor,
    target: &Target,
    need: Need,
) -> Result<(), CommandError> {
    check_as(conn, actor.effective(), target, need).await
}

async fn check_as(
    conn: &mut SqliteConnection,
    me: Identity<'_>,
    target: &Target,
    need: Need,
) -> Result<(), CommandError> {
    let role = me.role;
    let signed_in = me.user_id.is_some();
    let within = need <= ceiling(role);
    let allowed = match target {
        Target::Public => true,
        Target::Server => !signed_in && matches!(role, Role::PracticeAdmin | Role::Overseer),
        Target::SignUp => !signed_in && role == Role::BusinessOwner,
        Target::SignedIn => {
            if !signed_in {
                return Err(CommandError::Unauthenticated);
            }
            true
        }
        Target::Practice => (role == Role::Overseer || role.is_practice()) && within,
        Target::User(user_role) => match role {
            Role::Overseer => true,
            Role::PracticeAdmin => user_role.is_none_or(Role::is_practice),
            _ => false,
        },
        Target::Listing => true,
        Target::Invite => signed_in && role.is_practice(),
        // Someone else's is reported as not found, the same as one that doesn't exist. Nobody
        // reaches a user's own things by viewing as them, so those are not found too.
        Target::Own(o) => {
            if !signed_in {
                return Err(CommandError::Unauthenticated);
            }
            if me.acted_as || o.owner.is_none() || o.owner.as_deref() != me.user_id {
                return Err(CommandError::not_found(o.entity, &o.id));
            }
            true
        }
        Target::Impersonation => role == Role::Overseer,
        Target::Client(c) => {
            if !can_see(conn, me, &c.client_id).await? {
                let (entity, id) = &c.named;
                return Err(CommandError::not_found(entity, id));
            }
            within
        }
    };
    if allowed {
        Ok(())
    } else {
        Err(CommandError::Forbidden)
    }
}

/// Whether `me` can see this client at all. A client that doesn't exist can't be seen.
async fn can_see(
    conn: &mut SqliteConnection,
    me: Identity<'_>,
    client_id: &str,
) -> Result<bool, CommandError> {
    if clients::get(conn, client_id).await?.is_none() {
        return Ok(false);
    }
    let row = match me.user_id {
        Some(user_id) => tenancy::access(conn, client_id, user_id).await?,
        None => None,
    };
    Ok(match me.role {
        Role::Overseer => true,
        Role::BusinessOwner => row == Some(tenancy::Access::Owner),
        Role::PracticeAdmin | Role::Staff | Role::Viewer => {
            row == Some(tenancy::Access::Accountant) || !tenancy::has_owner(conn, client_id).await?
        }
    })
}

/// Which clients `actor` can see, for filtering lists. The same rule as [`check`] for one client.
pub struct Visible {
    everything: bool,
    practice: bool,
    hidden: BTreeSet<String>,
    shared: BTreeSet<String>,
}

impl Visible {
    /// Whether an entry about `client_id` (or about no client, such as a practice default) shows.
    pub fn shows(&self, client_id: Option<&str>) -> bool {
        if self.everything {
            return true;
        }
        match client_id {
            Some(c) if self.shared.contains(c) => true,
            Some(c) => self.practice && !self.hidden.contains(c),
            None => self.practice,
        }
    }
}

/// Which clients `actor` can see, as its effective identity.
pub async fn visible(conn: &mut SqliteConnection, actor: &Actor) -> Result<Visible, CommandError> {
    let me = actor.effective();
    let shared = match me.user_id {
        Some(id) => tenancy::clients_for_user(conn, id).await?,
        None => Vec::new(),
    };
    let practice = me.role.is_practice();
    Ok(Visible {
        everything: me.role == Role::Overseer,
        practice,
        hidden: if practice {
            tenancy::owned_clients(conn).await?.into_iter().collect()
        } else {
            BTreeSet::new()
        },
        shared: shared.into_iter().collect(),
    })
}

/// Checks a command against everything it touches. The pipeline calls this before applying it.
/// Returns the clients it touches, in the order the command names them.
pub async fn check_command(
    conn: &mut SqliteConnection,
    actor: &Actor,
    command: &Command,
) -> Result<Vec<String>, CommandError> {
    let (need, targets) = command_targets(conn, command).await?;
    // Viewing as someone is about the overseer's own session, so it's checked as them. Everything
    // else is checked as the person they're viewing as, if they are.
    let me = if matches!(targets.as_slice(), [Target::Impersonation]) {
        actor.real()
    } else {
        actor.effective()
    };
    // Role first, so a refusal never depends on whether something exists.
    if need > ceiling(me.role) {
        return Err(CommandError::Forbidden);
    }
    // Who sees the owner's edits is the owner's call, not their accountants'.
    if matches!(command, Command::SetHistorySharing { .. })
        && !matches!(me.role, Role::BusinessOwner | Role::Overseer)
    {
        return Err(CommandError::Forbidden);
    }
    let mut clients: Vec<String> = Vec::new();
    for target in &targets {
        check_as(conn, me, target, need).await?;
        if let Target::Client(c) = target
            && !clients.contains(&c.client_id)
        {
            clients.push(c.client_id.clone());
        }
    }
    Ok(clients)
}

/// What a command touches, and how much it asks to do there. The match has no catch-all, so a
/// new command doesn't compile until it's given a rule here.
async fn command_targets(
    conn: &mut SqliteConnection,
    command: &Command,
) -> Result<(Need, Vec<Target>), CommandError> {
    use Command as C;
    let client = |id: &str| Target::Client(ClientRef::direct(id));
    Ok(match command {
        C::Initialise { .. } => (Need::Read, vec![Target::Server]),
        C::SignUp { .. } => (Need::Read, vec![Target::SignUp]),
        C::ChangeOwnPassword { .. } => (Need::Read, vec![Target::SignedIn]),
        // The user's own invoices, at any role, a viewer's included: they're no business's data.
        C::SaveInvoiceDraft { .. } | C::SaveInvoiceTemplate { .. } | C::AddInvoiceImage { .. } => {
            (Need::Read, vec![Target::SignedIn])
        }
        C::DeleteInvoiceTemplate { template_id } => (
            Need::Read,
            vec![invoice_template_target(conn, template_id).await?],
        ),
        C::AcceptInvite { .. } => (Need::Read, vec![Target::Invite]),

        C::CreateUser { role, .. } => (Need::Admin, vec![Target::User(Some(*role))]),
        C::ResetPassword { user_id, .. } | C::SetUserActive { user_id, .. } => {
            let role = users::get(conn, user_id).await?.map(|u| u.role);
            (Need::Admin, vec![Target::User(role)])
        }

        C::InstallStarterSet { .. }
        | C::CreateMasterChart { .. }
        | C::AddMasterAccount { .. }
        | C::RenameMasterAccount { .. }
        | C::SetMasterAccountActive { .. }
        | C::SetMasterAccountGst { .. }
        | C::CreateTemplate { .. }
        | C::ReviseTemplate { .. }
        | C::CreateMapping { .. }
        | C::ReviseMapping { .. }
        | C::CreateAssetClass { .. }
        | C::UpdateAssetClass { .. }
        | C::AddMerchant { .. }
        | C::RemoveMerchant { .. }
        | C::AddParagraph { .. }
        | C::ReviseParagraph { .. }
        | C::RemoveParagraph { .. } => (Need::Admin, vec![Target::Practice]),
        // Pushes only onto clients the admin can see (`paragraphs::push_plan` filters with
        // `visible`).
        C::PushParagraph { .. } => (Need::Admin, vec![Target::Practice]),

        C::CreateClient { .. } | C::SetUpBusiness { .. } => {
            (Need::Accounting, vec![Target::Practice])
        }

        C::AddAccount { client_id, .. }
        | C::RenameAccount { client_id, .. }
        | C::SetAccountActive { client_id, .. }
        | C::SetAccountGst { client_id, .. }
        | C::SetRoundingPriority { client_id, .. }
        | C::CreateClientYear { client_id, .. }
        | C::SetClientAssetClass { client_id, .. }
        | C::CreateAsset { client_id, .. }
        | C::ApplyAssetClassDefaults { client_id, .. }
        | C::SetCodingSettings { client_id, .. } => (Need::Accounting, vec![client(client_id)]),

        C::PostJournal { client_year_id, .. }
        | C::ImportTb { client_year_id, .. }
        | C::RunDepreciation { client_year_id }
        | C::MoveYearLayout { client_year_id, .. }
        | C::PickNotes { client_year_id, .. }
        | C::EditNote { client_year_id, .. } => (
            Need::Accounting,
            vec![year_target(conn, client_year_id).await?],
        ),
        // Signing a year off, or reopening it, is the practice admin's (CLAUDE.md, Roles).
        C::FinaliseYear { client_year_id, .. } | C::ReopenYear { client_year_id, .. } => {
            (Need::Admin, vec![year_target(conn, client_year_id).await?])
        }
        C::ReverseJournal { journal_id, .. } => {
            let target = match journals::get(conn, journal_id).await? {
                Some(j) => via_year(conn, &j.client_year_id, ("journal", journal_id)).await?,
                None => return Err(CommandError::not_found("journal", journal_id)),
            };
            (Need::Accounting, vec![target])
        }
        C::UpdateAsset { asset_id, .. }
        | C::DeleteAsset { asset_id }
        | C::DisposeAsset { asset_id, .. }
        | C::ReinstateAsset { asset_id } => {
            let a = assets::get_asset(conn, asset_id)
                .await?
                .ok_or_else(|| CommandError::not_found("asset", asset_id))?;
            (
                Need::Accounting,
                vec![named(&a.client_id, "asset", asset_id)],
            )
        }

        C::AddBankAccount { client_id, .. }
        | C::AddCardAccount { client_id, .. }
        | C::AddRule { client_id, .. }
        | C::AnswerQuestion { client_id, .. }
        | C::SetAiSuggestions { client_id, .. }
        | C::SetHistorySharing { client_id, .. }
        | C::RecordSuggestions { client_id, .. }
        | C::CreateInvite { client_id, .. } => (Need::Owner, vec![client(client_id)]),
        C::ImportStatement {
            client_id,
            bank_account_id,
            ..
        } => {
            let mut targets = vec![client(client_id)];
            if let Some(id) = bank_account_id {
                targets.push(bank_account_target(conn, id).await?);
            }
            (Need::Owner, targets)
        }
        C::SetOpeningBalance {
            bank_account_id, ..
        } => (
            Need::Owner,
            vec![bank_account_target(conn, bank_account_id).await?],
        ),
        C::RemoveRule { rule_id } => {
            let rule = coding::get_rule(conn, rule_id)
                .await?
                .ok_or_else(|| CommandError::not_found("rule", rule_id))?;
            (Need::Owner, vec![named(&rule.client_id, "rule", rule_id)])
        }
        C::CodeBankLine { line } => (
            Need::Owner,
            vec![bank_line_target(conn, &line.bank_line_id).await?],
        ),
        C::CodeBankLines { lines } => {
            let mut targets = Vec::new();
            for l in lines {
                targets.push(bank_line_target(conn, &l.bank_line_id).await?);
            }
            (Need::Owner, targets)
        }
        C::ConfirmTransfer {
            out_line_id,
            in_line_id,
        } => (
            Need::Owner,
            vec![
                bank_line_target(conn, out_line_id).await?,
                bank_line_target(conn, in_line_id).await?,
            ],
        ),
        C::ConfirmIrdPayment { bank_line_id, .. }
        | C::ResolveDuplicate { bank_line_id, .. }
        | C::ConfirmSupplyInfo { bank_line_id } => (
            Need::Owner,
            vec![bank_line_target(conn, bank_line_id).await?],
        ),
        // Undoing an upload is the uploader's work.
        C::RemoveStatement { statement_id } => (
            Need::Owner,
            vec![statement_target(conn, statement_id).await?],
        ),

        // Overseers only (ADR 013, 1). Whom, and whether the session is acting, is checked when
        // it's applied (`crate::impersonation`).
        C::StartImpersonation { .. }
        | C::EndImpersonation { .. }
        | C::AllowImpersonationChanges { .. } => (Need::Read, vec![Target::Impersonation]),
    })
}

fn named(client_id: &str, entity: &'static str, id: &str) -> Target {
    Target::Client(ClientRef {
        client_id: client_id.to_owned(),
        named: (entity, id.to_owned()),
    })
}

async fn year_target(conn: &mut SqliteConnection, year_id: &str) -> Result<Target, CommandError> {
    via_year(conn, year_id, ("client-year", year_id)).await
}

async fn via_year(
    conn: &mut SqliteConnection,
    year_id: &str,
    (entity, id): (&'static str, &str),
) -> Result<Target, CommandError> {
    let year = years::get(conn, year_id)
        .await?
        .ok_or_else(|| CommandError::not_found(entity, id))?;
    Ok(named(&year.client_id, entity, id))
}

async fn bank_account_target(
    conn: &mut SqliteConnection,
    id: &str,
) -> Result<Target, CommandError> {
    let a = bank::bank_account(conn, id)
        .await?
        .ok_or_else(|| CommandError::not_found("bank account", id))?;
    Ok(named(&a.client_id, "bank account", id))
}

async fn bank_line_target(conn: &mut SqliteConnection, id: &str) -> Result<Target, CommandError> {
    let not_found = || CommandError::not_found("bank line", id);
    let line = bank::bank_line(conn, id).await?.ok_or_else(not_found)?;
    let a = bank::bank_account(conn, &line.bank_account_id)
        .await?
        .ok_or_else(not_found)?;
    Ok(named(&a.client_id, "bank line", id))
}

async fn statement_target(conn: &mut SqliteConnection, id: &str) -> Result<Target, CommandError> {
    let not_found = || CommandError::not_found("statement", id);
    let statement = bank::statement(conn, id).await?.ok_or_else(not_found)?;
    let a = bank::bank_account(conn, &statement.bank_account_id)
        .await?
        .ok_or_else(not_found)?;
    Ok(named(&a.client_id, "statement", id))
}

/// What a route touches, by the path it was registered with.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteRule {
    Public,
    SignedIn,
    /// The signed-in user's own invoices, as a list: any signed-in user, for their own only.
    OwnInvoices,
    Practice(Need),
    Listing,
    /// The `{id}` parameter is a client (or business) id.
    Client(Need),
    /// The `{id}` parameter is a client-year id.
    Year(Need),
    /// The `{id}` parameter is one of the user's own invoice templates.
    InvoiceTemplate,
    /// The `{id}` parameter is one of the user's own invoice images.
    InvoiceImage,
    /// The `{id}` parameter is an uploaded statement: its bank account's business (M18).
    Statement(Need),
    /// The `{id}` parameter is a bank account or card: its business (M18).
    BankAccount(Need),
}

/// The rule for each route in [`crate::api_routes`]. `None` means the route is refused for
/// everyone, and `tests/tenancy.rs` fails until it has one.
pub fn route_rule(method: &Method, path: &str) -> Option<RouteRule> {
    use RouteRule as R;
    let get = *method == Method::GET;
    let post = *method == Method::POST;
    Some(match path {
        "/api/health" if get => R::Public,
        "/api/login" | "/api/logout" | "/api/signup" if post => R::Public,
        "/api/me" if get => R::SignedIn,
        "/api/invoices/draft" | "/api/invoices/templates" if get => R::OwnInvoices,
        "/api/invoices/templates/{id}" if get => R::InvoiceTemplate,
        "/api/invoices/images/{id}" if get => R::InvoiceImage,
        "/api/commands" if post => R::SignedIn,
        "/api/practice"
        | "/api/asset-classes"
        | "/api/merchants/{entity_type}"
        | "/api/paragraph-library/{entity_type}"
            if get =>
        {
            R::Practice(Need::Read)
        }
        "/api/paragraphs/{id}/push-preview" if get => R::Practice(Need::Admin),
        "/api/templates/{id}" | "/api/mappings/{id}" if get => R::Practice(Need::Read),
        "/api/mappings/check" if post => R::Practice(Need::Admin),
        "/api/users" if get => R::Practice(Need::Admin),
        "/api/clients" | "/api/sync" | "/api/history" if get => R::Listing,
        "/api/presence" if post => R::Listing,
        "/api/clients/{id}"
        | "/api/clients/{id}/chart"
        | "/api/clients/{id}/asset-classes"
        | "/api/clients/{id}/asset-classes/{class_id}/apply-preview"
        | "/api/businesses/{id}"
        | "/api/businesses/{id}/tax"
        | "/api/businesses/{id}/save-tax"
        | "/api/businesses/{id}/coding-settings"
        | "/api/businesses/{id}/rules"
        | "/api/businesses/{id}/ai-suggestions"
        | "/api/businesses/{id}/history-sharing"
            if get =>
        {
            R::Client(Need::Read)
        }
        "/api/businesses/{id}/ai-suggestions" if post => R::Client(Need::Owner),
        "/api/years/{id}"
        | "/api/years/{id}/journals"
        | "/api/years/{id}/tb"
        | "/api/years/{id}/report"
        | "/api/years/{id}/reconciliation"
        | "/api/years/{id}/gl"
        | "/api/years/{id}/analysis"
        | "/api/years/{id}/assets"
        | "/api/years/{id}/snapshot"
        | "/api/years/{id}/finalise-check"
        | "/api/years/{id}/report.pdf"
        | "/api/years/{id}/notes"
        | "/api/years/{id}/layout"
            if get =>
        {
            R::Year(Need::Read)
        }
        "/api/years/{id}/tb-import/preview" if post => R::Year(Need::Accounting),
        "/api/statements/{id}/excerpt" if get => R::Statement(Need::Read),
        "/api/bank-accounts/{id}/proof" if get => R::BankAccount(Need::Read),
        _ => return None,
    })
}

/// What a route may do while the session is viewing as someone (ADR 013, 3).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WhileActing {
    /// It runs as the person: every read, and requests that change nothing.
    Allowed,
    /// It changes something, so only once changes are turned on.
    NeedsChanges,
    /// Never while acting. The phrase finishes "Overseers can't … as someone else."
    Refused(&'static str),
}

/// The rule for each route while acting. Deny by default: a new route that isn't a `GET` is
/// refused while acting until it's given a rule here. Public routes (sign-in, sign-out, sign-up)
/// aren't asked: they run before any session is read.
pub fn while_acting(method: &Method, path: &str, rule: RouteRule) -> WhileActing {
    use WhileActing as W;
    // Every call to IRD uses the owner's own myIR authorisation, reads included (ADR 013, 4).
    if path.starts_with("/api/ird/") {
        return W::Refused("deal with IRD");
    }
    // A user's own invoices are theirs alone; neither theirs nor the overseer's show.
    if matches!(
        rule,
        RouteRule::OwnInvoices | RouteRule::InvoiceTemplate | RouteRule::InvoiceImage
    ) {
        return W::Refused("open someone's invoices");
    }
    if *method == Method::GET {
        return W::Allowed;
    }
    match path {
        // `POST /api/commands` is decided command by command, in the pipeline.
        "/api/commands"
        | "/api/presence"
        | "/api/mappings/check"
        | "/api/years/{id}/tb-import/preview" => W::Allowed,
        // Sends the business's lines to the AI provider and stores what comes back.
        "/api/businesses/{id}/ai-suggestions" => W::NeedsChanges,
        _ => W::Refused("do this"),
    }
}

/// The refusal for a route the session can't use while viewing as someone, if it can't.
fn check_while_acting(
    method: &Method,
    path: &str,
    rule: RouteRule,
    user: &CurrentUser,
) -> Result<(), CommandError> {
    let Some(acting) = user.acting() else {
        return Ok(());
    };
    let name = &user.0.display_name;
    match while_acting(method, path, rule) {
        WhileActing::Allowed => Ok(()),
        WhileActing::NeedsChanges if acting.allow_changes => Ok(()),
        WhileActing::NeedsChanges => Err(crate::impersonation::read_only(name)),
        WhileActing::Refused(what) => Err(crate::impersonation::never(name, what)),
    }
}

/// The router's access layer: runs [`check`] for every API request before its handler.
pub async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let (mut parts, body) = request.into_parts();
    let path = parts
        .extensions
        .get::<MatchedPath>()
        .map(|p| p.as_str().to_owned());
    let rule = path.as_deref().and_then(|p| route_rule(&parts.method, p));
    let (Some(rule), Some(path)) = (rule, path) else {
        return CommandError::Forbidden.into_response();
    };
    if rule != RouteRule::Public {
        let user = match CurrentUser::from_request_parts(&mut parts, &state).await {
            Ok(u) => u,
            Err(e) => return e.into_response(),
        };
        if let Err(e) = check_while_acting(&parts.method, &path, rule, &user) {
            return e.into_response();
        }
        let id = match RawPathParams::from_request_parts(&mut parts, &state).await {
            Ok(params) => params
                .iter()
                .find(|(k, _)| *k == "id")
                .map(|(_, v)| v.to_owned()),
            Err(e) => return e.into_response(),
        };
        if let Err(e) = check_route(&state, &user.actor(), rule, id.as_deref()).await {
            return e.into_response();
        }
    }
    next.run(Request::from_parts(parts, body)).await
}

async fn check_route(
    state: &AppState,
    actor: &Actor,
    rule: RouteRule,
    id: Option<&str>,
) -> Result<(), CommandError> {
    let mut conn = state.store.reader().await?;
    let id = || id.ok_or_else(|| CommandError::Malformed("missing id".to_owned()));
    let (target, need) = match rule {
        RouteRule::Public => (Target::Public, Need::Read),
        RouteRule::SignedIn | RouteRule::OwnInvoices => (Target::SignedIn, Need::Read),
        RouteRule::Listing => (Target::Listing, Need::Read),
        RouteRule::Practice(need) => (Target::Practice, need),
        RouteRule::Client(need) => (Target::Client(ClientRef::direct(id()?)), need),
        RouteRule::Year(need) => (year_target(&mut conn, id()?).await?, need),
        RouteRule::InvoiceTemplate => {
            (invoice_template_target(&mut conn, id()?).await?, Need::Read)
        }
        RouteRule::InvoiceImage => (invoice_image_target(&mut conn, id()?).await?, Need::Read),
        RouteRule::Statement(need) => (statement_target(&mut conn, id()?).await?, need),
        RouteRule::BankAccount(need) => (bank_account_target(&mut conn, id()?).await?, need),
    };
    check(&mut conn, actor, &target, need).await
}
