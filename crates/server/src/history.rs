//! Who changed what (M13): what each command changed, in plain English, with its effect on the
//! tax figure.
//!
//! It's all built from `command_log`. The pipeline records each command's [`Changes`] in the
//! command's own log entry: it observes what the command is about to touch, applies it, observes
//! again, and keeps what differs, along with the business's tax to pay before and after. There's
//! no second record of changes.
//!
//! [`describe`] turns a log entry into a sentence. Its match on [`Command`] has no catch-all, so a
//! new command kind doesn't compile until it has a description, and `tests` has one per kind.

use std::collections::{BTreeMap, BTreeSet};

use acct_core::coding::{Coding, DepositCoding, WithdrawalCoding};
use acct_core::depreciation::{Method, SlBasis};
use acct_core::tax::position::position;
use acct_core::{AccountCode, Chart, DepreciationSettings, GstCode, Money};
use acct_store::bank::BankLine;
use acct_store::coding::{LineState, LineStateKind};
use acct_store::log::LoggedCommand;
use acct_store::{
    SqliteConnection, ai as ai_store, assets as asset_store, bank, clients, coding, journals, log,
    users,
};
use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::access;
use crate::auth::CurrentUser;
use crate::commands::{Answer, Command, IrdPayment, Via};
use crate::error::CommandError;
use crate::save_tax;

// ---------------------------------------------------------------------------------------------
// What a command changed.

/// What one command changed, as stored in `command_log.changes`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Changes {
    /// The tax to pay of the business the command touched, before and after. Absent when it
    /// touched no business.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tax: Option<TaxChange>,
    /// Each value the command changed, in the order it was observed.
    #[serde(default)]
    pub fields: Vec<FieldChange>,
}

/// A business's tax to pay before and after a command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TaxChange {
    pub client_id: String,
    /// `None` when the business didn't exist yet.
    pub before: Option<TaxFigure>,
    pub after: TaxFigure,
}

impl TaxChange {
    /// How much the command moved the figure: positive when tax to pay went up. Nil when there's
    /// no figure from before (a new business, or a command that reached it through an invite).
    pub fn delta(&self) -> Money {
        self.before
            .as_ref()
            .map_or(Money::ZERO, |b| self.after.total - b.total)
    }

    /// How much the command moved one part of the figure (see [`TaxFigure::parts`]).
    pub fn part_delta(&self, part: &str) -> Money {
        let Some(before) = &self.before else {
            return Money::ZERO;
        };
        let of = |f: &TaxFigure| f.parts.get(part).copied().unwrap_or(Money::ZERO);
        of(&self.after) - of(before)
    }
}

/// "Tax to pay if submitted", and what it's made of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TaxFigure {
    pub total: Money,
    /// Each part of the total by [`gst_part`] or [`income_part`]: a GST return's box 15, or an
    /// income year's total. A return with no figure isn't listed.
    pub parts: BTreeMap<String, Money>,
}

/// The key of a GST period's part of the figure: `gst:<period start>`.
pub fn gst_part(start: NaiveDate) -> String {
    format!("gst:{start}")
}

/// The key of an income year's part of the figure: `income:<year it ends in>`.
pub fn income_part(year: i32) -> String {
    format!("income:{year}")
}

/// One value a command changed, in words as they were when it changed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct FieldChange {
    /// What it belongs to, such as a bank line (`COUNTDOWN on 12 Mar 2026 (-$45.20)`).
    pub subject: String,
    /// Which value, such as `category`.
    pub label: String,
    /// `None`: it didn't exist before.
    pub before: Option<String>,
    /// `None`: it doesn't exist after.
    pub after: Option<String>,
}

/// The label of a bank line's category, which [`describe`] groups lines by.
const CATEGORY: &str = "category";
/// The label of the number of a business's bank lines, which an upload changes.
const LINE_COUNT: &str = "transactions";

/// One observed value.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Fact {
    key: String,
    subject: String,
    label: String,
    value: String,
}

/// What the pipeline saw before applying a command.
pub(crate) struct Before {
    client_id: Option<String>,
    tax: Option<TaxFigure>,
    facts: Vec<Fact>,
}

/// Observes what `command` is about to change. `clients` are the clients it touches, from the
/// access check. Runs inside the command's transaction, before it's applied.
pub(crate) async fn before(
    conn: &mut SqliteConnection,
    command: &Command,
    clients: &[String],
) -> Result<Before, CommandError> {
    let client_id = clients.first().cloned();
    let tax = match &client_id {
        Some(c) => tax_figure(conn, c).await?,
        None => None,
    };
    let facts = observe(conn, command, client_id.as_deref()).await?;
    Ok(Before {
        client_id,
        tax,
        facts,
    })
}

/// Observes again once `command` is applied, and returns what changed. `effect_client` is the
/// client the command reported touching, which for a new business is the only way to know it.
pub(crate) async fn after(
    conn: &mut SqliteConnection,
    command: &Command,
    before: Before,
    effect_client: Option<&str>,
) -> Result<Changes, CommandError> {
    let client_id = before.client_id.as_deref().or(effect_client);
    let tax = match client_id {
        Some(c) => tax_figure(conn, c).await?.map(|after| TaxChange {
            client_id: c.to_owned(),
            before: before.tax,
            after,
        }),
        None => None,
    };
    let after = observe(conn, command, client_id).await?;
    Ok(Changes {
        tax,
        fields: diff(&before.facts, &after),
    })
}

/// The tax figure of `client_id`, if it's a business.
async fn tax_figure(
    conn: &mut SqliteConnection,
    client_id: &str,
) -> Result<Option<TaxFigure>, CommandError> {
    if bank::business(conn, client_id).await?.is_none() {
        return Ok(None);
    }
    let computed = position(&save_tax::tax_inputs(conn, client_id).await?);
    let mut parts = BTreeMap::new();
    for g in &computed.gst {
        if let Ok(r) = &g.result {
            parts.insert(gst_part(g.period.start), r.box15);
        }
    }
    for i in &computed.income {
        if let Ok(r) = &i.result {
            parts.insert(income_part(i.year.0), r.total());
        }
    }
    Ok(Some(TaxFigure {
        total: computed.total,
        parts,
    }))
}

/// The values that differ between two observations, in the order they were first seen.
fn diff(before: &[Fact], after: &[Fact]) -> Vec<FieldChange> {
    let after_by_key: BTreeMap<&str, &Fact> = after.iter().map(|f| (f.key.as_str(), f)).collect();
    let before_keys: BTreeSet<&str> = before.iter().map(|f| f.key.as_str()).collect();
    let mut out = Vec::new();
    for b in before {
        match after_by_key.get(b.key.as_str()) {
            Some(a) if a.value == b.value => {}
            Some(a) => out.push(FieldChange {
                subject: a.subject.clone(),
                label: a.label.clone(),
                before: Some(b.value.clone()),
                after: Some(a.value.clone()),
            }),
            None => out.push(FieldChange {
                subject: b.subject.clone(),
                label: b.label.clone(),
                before: Some(b.value.clone()),
                after: None,
            }),
        }
    }
    for a in after
        .iter()
        .filter(|a| !before_keys.contains(a.key.as_str()))
    {
        out.push(FieldChange {
            subject: a.subject.clone(),
            label: a.label.clone(),
            before: None,
            after: Some(a.value.clone()),
        });
    }
    out
}

/// What `command` can change, read now. Anything missing is left out: a command naming something
/// that doesn't exist is refused when it's applied, with its own error.
async fn observe(
    conn: &mut SqliteConnection,
    command: &Command,
    client_id: Option<&str>,
) -> Result<Vec<Fact>, CommandError> {
    use Command as C;
    let mut facts = Vec::new();
    match command {
        C::CodeBankLine { line } => {
            line_facts(conn, client_id, &[line.bank_line_id.as_str()], &mut facts).await?;
        }
        C::CodeBankLines { lines } => {
            let ids: Vec<&str> = lines.iter().map(|l| l.bank_line_id.as_str()).collect();
            line_facts(conn, client_id, &ids, &mut facts).await?;
        }
        C::ConfirmTransfer {
            out_line_id,
            in_line_id,
        } => {
            line_facts(conn, client_id, &[out_line_id, in_line_id], &mut facts).await?;
        }
        C::ConfirmIrdPayment { bank_line_id, .. } | C::ResolveDuplicate { bank_line_id, .. } => {
            line_facts(conn, client_id, &[bank_line_id], &mut facts).await?;
        }
        C::ConfirmSupplyInfo { bank_line_id } => {
            line_facts(conn, client_id, &[bank_line_id], &mut facts).await?;
            if let (Some(c), Some(line)) = (client_id, bank::bank_line(conn, bank_line_id).await?) {
                let held = coding::supply_info(conn, c)
                    .await?
                    .iter()
                    .any(|(id, _)| id == bank_line_id);
                facts.push(Fact {
                    key: format!("supply:{bank_line_id}"),
                    subject: line_subject(&line),
                    label: "supplier's GST information".into(),
                    value: if held { "held" } else { "not held" }.into(),
                });
            }
        }
        C::AddRule { .. } | C::RemoveRule { .. } => {
            if let Some(c) = client_id {
                rule_facts(conn, c, &mut facts).await?;
                all_line_facts(conn, c, &mut facts).await?;
            }
        }
        C::ImportStatement { .. } => {
            if let Some(c) = client_id {
                let n = bank::bank_lines(conn, c).await?.len();
                facts.push(Fact {
                    key: "line_count".into(),
                    subject: "bank statements".into(),
                    label: LINE_COUNT.into(),
                    value: n.to_string(),
                });
            }
        }
        C::SetOpeningBalance {
            bank_account_id, ..
        } => {
            if let Some(a) = bank::bank_account(conn, bank_account_id).await?
                && let Some((date, balance)) = a.opening
            {
                facts.push(Fact {
                    key: format!("opening:{bank_account_id}"),
                    subject: a.name,
                    label: "opening balance".into(),
                    value: format!("{} on {}", dollars(balance), day(date)),
                });
            }
        }
        C::AnswerQuestion { income_year, .. } => {
            if let Some(c) = client_id {
                answer_facts(conn, c, *income_year, &mut facts).await?;
            }
        }
        C::AddAccount { account, .. } => {
            if let Some(c) = client_id {
                account_facts(conn, c, &account.code, &mut facts).await?;
            }
        }
        C::RenameAccount { code, .. }
        | C::SetAccountActive { code, .. }
        | C::SetAccountGst { code, .. } => {
            if let Some(c) = client_id {
                account_facts(conn, c, code, &mut facts).await?;
            }
        }
        C::SetRoundingPriority { .. } => {
            if let Some(c) = client_id.map(str::to_owned)
                && let Some(client) = clients::get(conn, &c).await?
            {
                facts.push(Fact {
                    key: "rounding".into(),
                    subject: "rounding".into(),
                    label: "rounding order".into(),
                    value: join_codes(&client.rounding_priority),
                });
            }
        }
        C::SetUserActive { user_id, .. } => {
            if let Some(u) = users::get(conn, user_id).await? {
                facts.push(Fact {
                    key: format!("user:{user_id}"),
                    subject: u.display_name,
                    label: "status".into(),
                    value: if u.active { "active" } else { "inactive" }.into(),
                });
            }
        }
        C::UpdateAsset { asset_id, .. }
        | C::DeleteAsset { asset_id }
        | C::DisposeAsset { asset_id, .. }
        | C::ReinstateAsset { asset_id } => {
            if let Some(a) = asset_store::get_asset(conn, asset_id).await? {
                asset_facts(&a, &mut facts);
            }
        }
        C::UpdateAssetClass { class_id, .. } => {
            if let Some(class) = asset_store::get_class(conn, class_id).await? {
                let subject = format!("asset class {}", class.name);
                facts.push(fact(&subject, "name", class.name.clone()));
                facts.push(fact(
                    &subject,
                    "depreciation",
                    settings_label(&class.settings),
                ));
            }
        }
        C::SetClientAssetClass { class_id, .. } | C::ApplyAssetClassDefaults { class_id, .. } => {
            if let Some(c) = client_id {
                let overrides = asset_store::overrides_for_client(conn, c).await?;
                let o = overrides.iter().find(|o| &o.class_id == class_id);
                let class = asset_store::get_class(conn, class_id).await?;
                let subject = format!(
                    "asset class {}",
                    class
                        .as_ref()
                        .map_or(class_id.as_str(), |c| c.name.as_str())
                );
                if let Some(s) = o.and_then(|o| o.settings.as_ref()) {
                    facts.push(fact(
                        &subject,
                        "this client's depreciation",
                        settings_label(s),
                    ));
                }
                for a in asset_store::assets_for_client(conn, c).await? {
                    if &a.class_id == class_id {
                        asset_facts(&a, &mut facts);
                    }
                }
            }
        }
        C::SetCodingSettings { .. } => {
            if let Some(c) = client_id
                && let Some(s) = coding::settings(conn, c).await?
            {
                let v = serde_json::to_value(&s).expect("settings serialise");
                if let Some(map) = v.as_object() {
                    for (k, v) in map {
                        let value = v.as_str().map_or_else(|| v.to_string(), str::to_owned);
                        facts.push(fact("coding settings", &k.replace('_', " "), value));
                    }
                }
            }
        }
        C::SetAiSuggestions { .. } => {
            if let Some(c) = client_id {
                let on = ai_store::settings(conn, c)
                    .await?
                    .is_some_and(|s| s.enabled);
                facts.push(fact("AI suggestions", "AI suggestions", on_off(on).into()));
            }
        }
        C::Initialise { .. }
        | C::CreateUser { .. }
        | C::ChangeOwnPassword { .. }
        | C::ResetPassword { .. }
        | C::CreateMasterChart { .. }
        | C::CreateTemplate { .. }
        | C::ReviseTemplate { .. }
        | C::CreateMapping { .. }
        | C::ReviseMapping { .. }
        | C::CreateClient { .. }
        | C::CreateClientYear { .. }
        | C::PostJournal { .. }
        | C::ImportTb { .. }
        | C::ReverseJournal { .. }
        | C::CreateAssetClass { .. }
        | C::CreateAsset { .. }
        | C::RunDepreciation { .. }
        | C::SetUpBusiness { .. }
        | C::AddBankAccount { .. }
        | C::AddCardAccount { .. }
        | C::AddMerchant { .. }
        | C::RemoveMerchant { .. }
        | C::RecordSuggestions { .. }
        | C::SignUp { .. }
        | C::CreateInvite { .. }
        | C::AcceptInvite { .. } => {}
    }
    Ok(facts)
}

/// A fact keyed by its subject and label.
fn fact(subject: &str, label: &str, value: String) -> Fact {
    Fact {
        key: format!("{subject}\u{1f}{label}"),
        subject: subject.to_owned(),
        label: label.to_owned(),
        value,
    }
}

async fn line_facts(
    conn: &mut SqliteConnection,
    client_id: Option<&str>,
    ids: &[&str],
    out: &mut Vec<Fact>,
) -> Result<(), CommandError> {
    let Some(client_id) = client_id else {
        return Ok(());
    };
    let chart = clients::chart(conn, client_id).await?;
    for id in ids {
        if let Some(line) = bank::bank_line(conn, id).await? {
            let state = coding::line_state(conn, id).await?;
            out.push(line_fact(&line, state.as_ref(), &chart));
        }
    }
    Ok(())
}

async fn all_line_facts(
    conn: &mut SqliteConnection,
    client_id: &str,
    out: &mut Vec<Fact>,
) -> Result<(), CommandError> {
    let chart = clients::chart(conn, client_id).await?;
    let states: BTreeMap<String, LineState> = coding::line_states(conn, client_id)
        .await?
        .into_iter()
        .map(|s| (s.bank_line_id.clone(), s))
        .collect();
    for line in bank::bank_lines(conn, client_id).await? {
        out.push(line_fact(&line, states.get(&line.id), &chart));
    }
    Ok(())
}

fn line_fact(line: &BankLine, state: Option<&LineState>, chart: &Chart) -> Fact {
    let value = match state {
        Some(LineState {
            state: LineStateKind::Coded,
            coding: Some(c),
            ..
        }) => coding_label(c, Some(chart)),
        Some(LineState {
            state: LineStateKind::Duplicate,
            ..
        }) => "a duplicate".to_owned(),
        _ if line.amount > Money::ZERO => "income, not sorted yet".to_owned(),
        _ => "not sorted yet".to_owned(),
    };
    Fact {
        key: format!("line:{}", line.id),
        subject: line_subject(line),
        label: CATEGORY.into(),
        value,
    }
}

/// `COUNTDOWN AUCKLAND on 12 Mar 2026 (-$45.20)`. [`describe`] takes the first word as the
/// merchant.
fn line_subject(line: &BankLine) -> String {
    format!(
        "{} on {} ({})",
        line.description.trim(),
        day(line.date),
        dollars(line.amount)
    )
}

async fn rule_facts(
    conn: &mut SqliteConnection,
    client_id: &str,
    out: &mut Vec<Fact>,
) -> Result<(), CommandError> {
    let chart = clients::chart(conn, client_id).await?;
    for rule in coding::live_rules(conn, client_id).await? {
        out.push(Fact {
            key: format!("rule:{}", rule.id),
            subject: format!("rule for “{}”", rule.description_contains),
            label: "rule".into(),
            value: format!(
                "always treat “{}” as {}",
                rule.description_contains,
                coding_label(&rule.coding, Some(&chart))
            ),
        });
    }
    Ok(())
}

async fn answer_facts(
    conn: &mut SqliteConnection,
    client_id: &str,
    year: i32,
    out: &mut Vec<Fact>,
) -> Result<(), CommandError> {
    let Some((_, a)) = coding::answers(conn, client_id)
        .await?
        .into_iter()
        .find(|(y, _)| y.0 == year)
    else {
        return Ok(());
    };
    let subject = year_label(year);
    let yes_no = |b: bool| if b { "yes" } else { "no" }.to_owned();
    if let Some(b) = a.questions.only_income {
        out.push(fact(&subject, "only income", yes_no(b)));
    }
    if let Some(o) = a.other_income {
        out.push(fact(&subject, "other income", dollars(o.income)));
        out.push(fact(
            &subject,
            "tax deducted from it",
            dollars(o.tax_deducted),
        ));
    }
    if let Some(b) = a.questions.student_loan {
        out.push(fact(&subject, "student loan", yes_no(b)));
    }
    if let Some(m) = a.ietc_months {
        out.push(fact(&subject, "IETC months", m.to_string()));
    }
    if !a.tax_paid.is_zero() {
        out.push(fact(
            &subject,
            "income tax already paid",
            dollars(a.tax_paid),
        ));
    }
    Ok(())
}

async fn account_facts(
    conn: &mut SqliteConnection,
    client_id: &str,
    code: &AccountCode,
    out: &mut Vec<Fact>,
) -> Result<(), CommandError> {
    let chart = clients::chart(conn, client_id).await?;
    if let Some(a) = chart.get(code) {
        let subject = format!("account {code}");
        out.push(fact(&subject, "name", a.name.clone()));
        out.push(fact(
            &subject,
            "status",
            if a.active { "active" } else { "inactive" }.into(),
        ));
        out.push(fact(
            &subject,
            "default GST",
            a.default_gst.map_or("none set".into(), gst_label),
        ));
    }
    Ok(())
}

fn asset_facts(a: &asset_store::StoredAsset, out: &mut Vec<Fact>) {
    let subject = format!("asset {}", a.name);
    let key = |label: &str| format!("asset:{}:{label}", a.id);
    let mut push = |label: &str, value: String| {
        out.push(Fact {
            key: key(label),
            subject: subject.clone(),
            label: label.to_owned(),
            value,
        });
    };
    push("name", a.name.clone());
    push("cost", dollars(a.asset.cost));
    push("residual value", dollars(a.asset.residual));
    push("acquired", day(a.asset.acquired));
    push("depreciation", settings_label(&a.asset.settings));
    push(
        "disposal",
        a.asset
            .disposal
            .as_ref()
            .map_or("not disposed of".into(), |d| {
                format!("on {} for {}", day(d.date), dollars(d.proceeds))
            }),
    );
}

// ---------------------------------------------------------------------------------------------
// Words.

/// `$1,234.56`, `-$45.20`, or `$84` for whole dollars.
pub fn dollars(m: Money) -> String {
    let text = Money::from_cents(m.cents().abs()).to_string();
    let text = text.strip_suffix(".00").unwrap_or(&text);
    let sign = if m < Money::ZERO { "-" } else { "" };
    format!("{sign}${text}")
}

/// `12 Mar 2026`.
fn day(d: NaiveDate) -> String {
    d.format("%-d %b %Y").to_string()
}

/// `the year to 31 March 2027`.
fn year_label(year: i32) -> String {
    format!("the year to 31 March {year}")
}

fn on_off(on: bool) -> &'static str {
    if on { "on" } else { "off" }
}

fn percent(bp: u32) -> String {
    if bp.is_multiple_of(100) {
        format!("{}%", bp / 100)
    } else {
        format!("{}.{:02}%", bp / 100, bp % 100)
            .trim_end_matches('0')
            .to_owned()
    }
}

fn gst_label(g: GstCode) -> String {
    match g {
        GstCode::Standard => "standard-rated",
        GstCode::Zero => "zero-rated",
        GstCode::Exempt => "exempt",
        GstCode::None => "no GST",
    }
    .to_owned()
}

fn join_codes(codes: &[AccountCode]) -> String {
    if codes.is_empty() {
        return "none".into();
    }
    codes
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

fn settings_label(s: &DepreciationSettings) -> String {
    match s.method {
        Method::Dv { rate_bp } => format!("diminishing value at {}", percent(rate_bp)),
        Method::Sl {
            basis: SlBasis::Rate { rate_bp },
        } => format!("straight line at {}", percent(rate_bp)),
        Method::Sl {
            basis: SlBasis::Life { months },
        } => format!("straight line over {months} months"),
        Method::None => "not depreciated".into(),
    }
}

/// An account's name from the chart, or its code when there's no chart to hand.
fn account_name(code: &AccountCode, chart: Option<&Chart>) -> String {
    chart
        .and_then(|c| c.get(code))
        .map_or_else(|| format!("account {code}"), |a| a.name.clone())
}

/// What a line is coded as, in words.
fn coding_label(coding: &Coding, chart: Option<&Chart>) -> String {
    let name = |code: &AccountCode| account_name(code, chart);
    match coding {
        Coding::In(d) => match d {
            DepositCoding::Income { account, .. } => format!("income: {}", name(account)),
            DepositCoding::Transfer { from } => format!("a transfer from {}", name(from)),
            DepositCoding::Loan => "a loan".into(),
            DepositCoding::OwnerFunds => "money the owner put in".into(),
            DepositCoding::GstRefund => "a GST refund".into(),
            DepositCoding::PayeWages => "wages already taxed".into(),
            DepositCoding::PersonalSale => "the sale of a personal item".into(),
        },
        Coding::Out(w) => match w {
            WithdrawalCoding::Expense { account, .. } => name(account),
            WithdrawalCoding::PartPrivate {
                account,
                business_bp,
                ..
            } => format!("{}, {} business", name(account), percent(*business_bp)),
            WithdrawalCoding::AssetPurchase { account, .. } => {
                format!("an asset purchase: {}", name(account))
            }
            WithdrawalCoding::Personal => "personal".into(),
            WithdrawalCoding::Transfer { to } => format!("a transfer to {}", name(to)),
            WithdrawalCoding::IrdGst => "GST paid to IRD".into(),
            WithdrawalCoding::IrdIncomeTax => "income tax paid to IRD".into(),
        },
    }
}

fn role_label(role: acct_store::users::Role) -> &'static str {
    use acct_store::users::Role;
    match role {
        Role::Overseer => "an overseer",
        Role::PracticeAdmin => "a practice admin",
        Role::Staff => "staff",
        Role::Viewer => "a viewer",
        Role::BusinessOwner => "a business owner",
    }
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

fn transactions(n: usize) -> String {
    plural(n, "transaction", "transactions")
}

/// What a set of line recodings did: "marked 12 COUNTDOWN transactions as personal".
fn lines_phrase(changes: Option<&Changes>, asked: usize) -> String {
    let lines: Vec<&FieldChange> = changes
        .map(|c| c.fields.iter().filter(|f| f.label == CATEGORY).collect())
        .unwrap_or_default();
    let Some(first) = lines.first() else {
        return format!("sorted {}, with no change", transactions(asked));
    };
    let what = if lines.len() == 1 {
        first.subject.clone()
    } else {
        let merchant = |f: &FieldChange| f.subject.split_whitespace().next().map(str::to_owned);
        let m = merchant(first);
        if m.is_some() && lines.iter().all(|f| merchant(f) == m) {
            format!("{} {} transactions", lines.len(), m.unwrap_or_default())
        } else {
            transactions(lines.len())
        }
    };
    let afters: BTreeSet<Option<&String>> = lines.iter().map(|f| f.after.as_ref()).collect();
    match (afters.len(), first.after.as_ref()) {
        (1, Some(after)) => format!("marked {what} as {after}"),
        _ => format!("sorted {what}"),
    }
}

/// The first change with this label, if any.
fn field<'a>(changes: Option<&'a Changes>, label: &str) -> Option<&'a FieldChange> {
    changes?.fields.iter().find(|f| f.label == label)
}

/// The subject of the first change, if any: what a command acted on, by name.
fn subject(changes: Option<&Changes>) -> Option<&str> {
    Some(changes?.fields.first()?.subject.as_str())
}

/// One log entry as a sentence: who did what, and what it did to the tax figure.
/// `users` maps user ids to display names.
pub fn describe(
    entry: &LoggedCommand,
    changes: Option<&Changes>,
    users: &BTreeMap<String, String>,
) -> String {
    let parsed = serde_json::from_value::<Command>(serde_json::json!({
        "kind": entry.kind,
        "payload": serde_json::from_str::<serde_json::Value>(&entry.payload).unwrap_or_default(),
    }));
    let who = match &entry.user_id {
        Some(id) => users.get(id).cloned().unwrap_or_else(|| "Someone".into()),
        None => "The system".into(),
    };
    let Ok(command) = parsed else {
        return format!("{who} made a change ({}).", entry.kind.replace('_', " "));
    };
    let user = |id: &str| users.get(id).cloned().unwrap_or_else(|| "a user".into());
    let action = action(&command, changes, &user);
    let who = match &command {
        Command::SignUp { display_name, .. } if entry.user_id.is_none() => display_name.clone(),
        _ => who,
    };
    let via: Option<Via> = entry
        .via
        .as_deref()
        .and_then(|v| serde_json::from_str(v).ok());
    let mut sentence = match via {
        Some(Via::Suggestion { suggestion_ids, .. }) => format!(
            "{who} accepted {}: {action}.",
            plural(suggestion_ids.len(), "AI suggestion", "AI suggestions")
        ),
        None => format!("{who} {action}."),
    };
    if let Some(t) = changes.and_then(|c| c.tax.as_ref())
        && t.before.is_some()
    {
        let d = t.delta();
        if d > Money::ZERO {
            sentence.push_str(&format!(" Tax to pay went up {}.", dollars(d)));
        } else if d < Money::ZERO {
            sentence.push_str(&format!(" Tax to pay went down {}.", dollars(-d)));
        }
    }
    sentence
}

/// What a command did, as a phrase that follows its actor's name.
fn action(command: &Command, changes: Option<&Changes>, user: &dyn Fn(&str) -> String) -> String {
    use Command as C;
    let named = |what: &str| subject(changes).map_or_else(|| what.to_owned(), str::to_owned);
    match command {
        C::Initialise {
            practice_name,
            display_name,
            ..
        } => format!("set up the practice {practice_name}, with {display_name} as its admin"),
        C::CreateUser {
            display_name, role, ..
        } => format!("added {display_name} as {}", role_label(*role)),
        C::ChangeOwnPassword { .. } => "changed their password".into(),
        C::ResetPassword { user_id, .. } => format!("reset {}'s password", user(user_id)),
        C::SetUserActive { user_id, active } => {
            if *active {
                format!("made {} active again", user(user_id))
            } else {
                format!("made {} inactive", user(user_id))
            }
        }
        C::CreateMasterChart {
            entity_type,
            name,
            accounts,
        } => format!(
            "set up the {} master chart “{name}” with {}",
            entity_type.replace('_', " "),
            plural(accounts.len(), "account", "accounts")
        ),
        C::CreateTemplate { name, .. } => format!("created the statement template “{name}”"),
        C::ReviseTemplate { .. } => "revised a statement template".into(),
        C::CreateMapping { name, .. } => format!("created the mapping “{name}”"),
        C::ReviseMapping { .. } => "revised a mapping".into(),
        C::CreateClient {
            name, entity_type, ..
        } => format!(
            "added the client {name} ({})",
            entity_type.replace('_', " ")
        ),
        C::AddAccount { account, .. } => {
            format!("added account {} {}", account.code, account.name)
        }
        C::RenameAccount { code, name, .. } => match field(changes, "name") {
            Some(FieldChange {
                before: Some(old), ..
            }) => format!("renamed account {code} from “{old}” to “{name}”"),
            _ => format!("renamed account {code} to “{name}”"),
        },
        C::SetAccountActive { code, active, .. } => {
            format!(
                "made account {code} {}",
                if *active { "active" } else { "inactive" }
            )
        }
        C::SetAccountGst {
            code, default_gst, ..
        } => match default_gst {
            Some(g) => format!("set account {code}'s default GST to {}", gst_label(*g)),
            None => format!("cleared account {code}'s default GST"),
        },
        C::SetRoundingPriority {
            rounding_priority, ..
        } => format!(
            "set the rounding order to {}",
            join_codes(rounding_priority)
        ),
        C::CreateClientYear { start, end, .. } => {
            format!("added the year {} to {}", day(*start), day(*end))
        }
        C::PostJournal {
            date,
            narration,
            lines,
            ..
        } => {
            let debits: Money = lines
                .iter()
                .map(|l| l.amount)
                .filter(|a| *a > Money::ZERO)
                .sum();
            format!(
                "posted a journal on {} for {}: “{narration}”",
                day(*date),
                dollars(debits)
            )
        }
        C::ImportTb { rows, .. } => format!(
            "imported a trial balance of {}",
            plural(rows.len(), "account", "accounts")
        ),
        C::ReverseJournal { .. } => "reversed a journal".into(),
        C::CreateAssetClass { name, .. } => format!("added the asset class “{name}”"),
        C::UpdateAssetClass { name, .. } => format!("changed the asset class “{name}”"),
        C::SetClientAssetClass {
            settings, accounts, ..
        } => {
            if settings.is_none() && accounts.is_none() {
                "went back to the practice's settings for an asset class".into()
            } else {
                "set this client's own settings for an asset class".into()
            }
        }
        C::CreateAsset { name, cost, .. } => {
            format!("added the asset “{name}”, costing {}", dollars(*cost))
        }
        C::UpdateAsset { name, .. } => format!("changed the asset “{name}”"),
        C::DeleteAsset { .. } => format!("removed the {}", named("an asset")),
        C::DisposeAsset { disposal, .. } => format!(
            "recorded the disposal of the {} on {}, for {}",
            named("asset"),
            day(disposal.date),
            dollars(disposal.proceeds)
        ),
        C::ReinstateAsset { .. } => format!("undid the disposal of the {}", named("asset")),
        C::RunDepreciation { .. } => "ran depreciation".into(),
        C::ApplyAssetClassDefaults { .. } => {
            "applied an asset class's defaults to this client's assets".into()
        }
        C::SetUpBusiness { name, .. } => format!("set up the business {name}"),
        C::AddBankAccount { name, .. } => format!("added the bank account “{name}”"),
        C::AddCardAccount { name, .. } => format!("added the credit card “{name}”"),
        C::ImportStatement { file_name, .. } => {
            let added = field(changes, LINE_COUNT).and_then(|f| {
                let n = |v: &Option<String>| v.as_deref()?.parse::<usize>().ok();
                Some(n(&f.after)? - n(&f.before)?)
            });
            match added {
                Some(n) => format!(
                    "uploaded the statement {file_name}, adding {}",
                    plural(n, "new transaction", "new transactions")
                ),
                None => format!("uploaded the statement {file_name}, adding nothing new"),
            }
        }
        C::SetOpeningBalance { balance, .. } => {
            format!(
                "set a bank account's opening balance to {}",
                dollars(*balance)
            )
        }
        C::CodeBankLine { .. } => lines_phrase(changes, 1),
        C::CodeBankLines { lines } => lines_phrase(changes, lines.len()),
        C::AddRule {
            description_contains,
            coding,
            ..
        } => {
            let rule = field(changes, "rule")
                .and_then(|f| f.after.clone())
                .unwrap_or_else(|| {
                    format!(
                        "always treat “{description_contains}” as {}",
                        coding_label(coding, None)
                    )
                });
            let sorted = changes.map_or(0, |c| {
                c.fields.iter().filter(|f| f.label == CATEGORY).count()
            });
            if sorted == 0 {
                format!("added a rule: {rule}")
            } else {
                format!(
                    "added a rule: {rule}, which sorted {}",
                    transactions(sorted)
                )
            }
        }
        C::RemoveRule { .. } => match field(changes, "rule").and_then(|f| f.before.as_ref()) {
            Some(rule) => format!("removed the rule {rule}"),
            None => "removed a rule".into(),
        },
        C::AnswerQuestion {
            income_year,
            answer,
            ..
        } => {
            let said = match answer {
                Answer::OnlyIncome { yes: true } => {
                    "said this business is their only income".into()
                }
                Answer::OnlyIncome { yes: false } => {
                    "said this business isn't their only income".into()
                }
                Answer::OtherIncome {
                    income,
                    tax_deducted,
                } => format!(
                    "entered other income of {} with {} tax already deducted",
                    dollars(*income),
                    dollars(*tax_deducted)
                ),
                Answer::StudentLoan { yes: true } => "said they have a student loan".into(),
                Answer::StudentLoan { yes: false } => "said they don't have a student loan".into(),
                Answer::Ietc { months: 0 } => {
                    "said they can't get the independent earner tax credit".into()
                }
                Answer::Ietc { months } => format!(
                    "said they can get the independent earner tax credit for {}",
                    plural(usize::from(*months), "month", "months")
                ),
            };
            format!("{said}, for {}", year_label(*income_year))
        }
        C::ConfirmTransfer { .. } => {
            "confirmed a transfer between the business's own accounts".into()
        }
        C::ConfirmIrdPayment { payment, .. } => match payment {
            IrdPayment::Gst => format!("confirmed {} was GST", named("a payment")),
            IrdPayment::IncomeTax { income_year } => format!(
                "confirmed {} was income tax for {}",
                named("a payment"),
                year_label(*income_year)
            ),
        },
        C::ResolveDuplicate { is_duplicate, .. } => {
            if *is_duplicate {
                format!("marked {} as a duplicate", named("a transaction"))
            } else {
                format!("said {} isn't a duplicate", named("a transaction"))
            }
        }
        C::ConfirmSupplyInfo { .. } => format!(
            "confirmed they hold the supplier's GST information for {}",
            named("a transaction")
        ),
        C::SetCodingSettings { .. } => "changed the coding settings".into(),
        C::SetAiSuggestions { enabled, .. } => {
            format!("turned AI suggestions {}", on_off(*enabled))
        }
        C::AddMerchant {
            entity_type,
            description_contains,
            coding,
        } => format!(
            "added “{description_contains}” to the {} merchant list as {}",
            entity_type.replace('_', " "),
            coding_label(coding, None)
        ),
        C::RemoveMerchant { .. } => "took an entry off the merchant list".into(),
        C::RecordSuggestions {
            model, suggestions, ..
        } => format!(
            "asked AI ({model}) for suggestions, and got {}",
            plural(suggestions.len(), "suggestion", "suggestions")
        ),
        C::SignUp { business_name, .. } => format!("signed up with the business {business_name}"),
        C::CreateInvite { email, .. } => format!("invited {email} to be the business's accountant"),
        C::AcceptInvite { .. } => "accepted an invite to work on this business".into(),
    }
}

// ---------------------------------------------------------------------------------------------
// GET /api/history

/// The query of `GET /api/history`. Every filter is optional.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[ts(export)]
pub struct HistoryQuery {
    /// One business (client) only.
    #[ts(optional)]
    pub business: Option<String>,
    /// One person only, by user id.
    #[ts(optional)]
    pub user: Option<String>,
    /// From this day (UTC), inclusive.
    #[ts(optional, type = "string")]
    pub from: Option<NaiveDate>,
    /// To this day (UTC), inclusive.
    #[ts(optional, type = "string")]
    pub to: Option<NaiveDate>,
    /// Only changes that moved one figure: `tax` (the business's tax to pay), `gst:<period
    /// start>` or `income:<year>`. Needs `business`.
    #[ts(optional)]
    pub figure: Option<String>,
    /// With `accounts`: only changes that posted to these accounts in this client-year.
    #[ts(optional)]
    pub year: Option<String>,
    /// Comma-separated account codes, with `year`: the drill-down from a statement or TB line.
    #[ts(optional)]
    pub accounts: Option<String>,
    /// Only entries before this `seq`, for the next page.
    #[ts(optional)]
    pub before: Option<i64>,
    #[ts(optional)]
    pub limit: Option<i64>,
}

/// How a change came about when it wasn't the user's own doing alone (ADR 009).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct AiAttribution {
    /// The model that made the suggestions.
    pub model: String,
    /// How many suggestions were accepted.
    pub suggestions: usize,
}

/// One change in the history panel.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct HistoryEntry {
    pub seq: i64,
    #[ts(type = "string")]
    pub at: DateTime<Utc>,
    pub kind: String,
    /// The plain-English sentence.
    pub description: String,
    /// Who made it, by user id; `None` for the server itself.
    pub user_id: Option<String>,
    pub who: String,
    pub business_id: Option<String>,
    pub business_name: Option<String>,
    /// Before and after values. `None` for changes logged before M13.
    pub changes: Option<Changes>,
    /// How much it moved the tax to pay, positive for up. `None` when it touched no business or
    /// was logged before M13.
    pub tax_change: Option<Money>,
    /// Set when it accepted AI suggestions. `who` accepted them.
    pub ai: Option<AiAttribution>,
}

/// The response of `GET /api/history`: newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export)]
pub struct HistoryPage {
    pub entries: Vec<HistoryEntry>,
    /// Pass as `before` for older entries. `None` at the start of the log.
    pub next_before: Option<i64>,
}

const HISTORY_MAX: i64 = 200;
const HISTORY_DEFAULT: i64 = 50;
/// How many log entries are read at a time while filtering.
const BATCH: i64 = 500;

/// `GET /api/history`: the changes the user can see, newest first, filtered.
pub async fn get_history(
    State(state): State<AppState>,
    user: CurrentUser,
    query: Result<Query<HistoryQuery>, QueryRejection>,
) -> Result<Json<HistoryPage>, CommandError> {
    let Query(q) = query.map_err(|e| CommandError::Malformed(e.body_text()))?;
    let mut conn = state.store.reader().await?;
    let actor = user.actor();
    let visible = access::visible(&mut conn, &actor).await?;
    if let Some(b) = &q.business
        && !visible.shows(Some(b))
    {
        return Err(CommandError::not_found("business", b));
    }
    if q.figure.is_some() && q.business.is_none() {
        return Err(CommandError::Malformed("`figure` needs `business`".into()));
    }
    // The drill-down: the commands that posted the journals touching these accounts.
    let posted: Option<BTreeSet<i64>> = match (&q.year, &q.accounts) {
        (Some(year), Some(accounts)) => {
            let codes: BTreeSet<&str> = accounts.split(',').map(str::trim).collect();
            let found = journals::for_year(&mut conn, year).await?;
            Some(
                found
                    .iter()
                    .filter(|j| {
                        j.journal
                            .lines
                            .iter()
                            .any(|l| codes.contains(l.account.as_str()))
                    })
                    .map(|j| j.posted_seq)
                    .collect(),
            )
        }
        (None, None) => None,
        _ => {
            return Err(CommandError::Malformed(
                "`year` and `accounts` go together".into(),
            ));
        }
    };
    let limit = q.limit.unwrap_or(HISTORY_DEFAULT).clamp(1, HISTORY_MAX);

    let mut picked: Vec<(LoggedCommand, Option<Changes>)> = Vec::new();
    let mut cursor = q.before.unwrap_or(i64::MAX);
    let mut exhausted = false;
    while (picked.len() as i64) < limit {
        let batch = log::before(
            &mut conn,
            cursor,
            q.business.as_deref(),
            q.user.as_deref(),
            BATCH,
        )
        .await?;
        let Some(last) = batch.last() else {
            exhausted = true;
            break;
        };
        let short = (batch.len() as i64) < BATCH;
        cursor = last.seq;
        for e in batch {
            if (picked.len() as i64) >= limit {
                break;
            }
            if !visible.shows(e.client_id.as_deref()) {
                continue;
            }
            let day = e.at.date_naive();
            if q.from.is_some_and(|f| day < f) || q.to.is_some_and(|t| day > t) {
                continue;
            }
            if let Some(seqs) = &posted
                && !seqs.contains(&e.seq)
            {
                continue;
            }
            let changes: Option<Changes> = e
                .changes
                .as_deref()
                .and_then(|c| serde_json::from_str(c).ok());
            if let Some(figure) = &q.figure {
                let moved = changes
                    .as_ref()
                    .and_then(|c| c.tax.as_ref())
                    .is_some_and(|t| {
                        if figure == "tax" {
                            !t.delta().is_zero()
                        } else {
                            !t.part_delta(figure).is_zero()
                        }
                    });
                if !moved {
                    continue;
                }
            }
            picked.push((e, changes));
        }
        if short {
            exhausted = true;
            break;
        }
    }

    let names: BTreeMap<String, String> = users::list(&mut conn)
        .await?
        .into_iter()
        .map(|u| (u.id, u.display_name))
        .collect();
    let businesses: BTreeMap<String, String> = clients::list(&mut conn)
        .await?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect();
    let next_before = if exhausted && (picked.len() as i64) < limit {
        None
    } else {
        picked.last().map(|(e, _)| e.seq)
    };
    let entries = picked
        .into_iter()
        .map(|(e, changes)| entry_view(e, changes, &names, &businesses))
        .collect();
    Ok(Json(HistoryPage {
        entries,
        next_before,
    }))
}

fn entry_view(
    e: LoggedCommand,
    changes: Option<Changes>,
    names: &BTreeMap<String, String>,
    businesses: &BTreeMap<String, String>,
) -> HistoryEntry {
    let description = describe(&e, changes.as_ref(), names);
    let ai = e
        .via
        .as_deref()
        .and_then(|v| serde_json::from_str::<Via>(v).ok())
        .map(|v| match v {
            Via::Suggestion {
                model,
                suggestion_ids,
            } => AiAttribution {
                model,
                suggestions: suggestion_ids.len(),
            },
        });
    let tax_change = changes
        .as_ref()
        .and_then(|c| c.tax.as_ref())
        .filter(|t| t.before.is_some())
        .map(TaxChange::delta);
    let who = match &e.user_id {
        Some(id) => names.get(id).cloned().unwrap_or_else(|| "Someone".into()),
        None => "The system".into(),
    };
    HistoryEntry {
        seq: e.seq,
        at: e.at,
        kind: e.kind,
        description,
        business_name: e
            .client_id
            .as_ref()
            .and_then(|c| businesses.get(c).cloned()),
        business_id: e.client_id,
        user_id: e.user_id,
        who,
        changes,
        tax_change,
        ai,
    }
}

#[cfg(test)]
mod tests;
