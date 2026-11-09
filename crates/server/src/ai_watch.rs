//! The overseer's view of AI use (ADR 016, 7, 9 and 10): `GET /api/overseer/ai-usage`.
//!
//! This file holds the response types and the two enums that every `ai_usage` row uses, then the
//! reads, the AI share and the spike flags that fill them in. Each spike threshold is a named
//! constant with its own test.
//!
//! Rates and money stay integers (hard rule 4): shares are basis points and costs are US
//! micro-dollars. Every time is an RFC 3339 UTC string. Nothing here holds a prompt, a response,
//! a description or card wording; names are read live from the businesses and users and are never
//! stored in `ai_usage`.

use std::collections::{BTreeMap, BTreeSet};

use acct_store::ai_usage::{self as store, CodingEvent, LayerRow, UsageRow};
use axum::Json;
use axum::extract::rejection::QueryRejection;
use axum::extract::{Query, State};
use chrono::{DateTime, Datelike, Duration, NaiveDate, NaiveTime, SecondsFormat, Timelike, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::ai_limits::Plan;
use crate::auth::CurrentUser;
use crate::error::CommandError;

/// Which AI feature an ask used. M23 adds `invoice_read`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AiKind {
    /// A run of AI category suggestions.
    Suggestion,
    /// "Explain better" on a Save tax card.
    Explain,
}

impl AiKind {
    pub const ALL: [AiKind; 2] = [AiKind::Suggestion, AiKind::Explain];

    /// The value `ai_usage.kind` stores.
    pub fn as_str(self) -> &'static str {
        match self {
            AiKind::Suggestion => "suggestion",
            AiKind::Explain => "explain",
        }
    }

    pub fn parse(s: &str) -> Option<AiKind> {
        AiKind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// How an ask ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AiOutcome {
    Ok,
    /// The provider declined the request.
    Declined,
    /// An answer we couldn't use, or every answer was dropped.
    Invalid,
    /// The provider couldn't be reached, or answered with an error.
    Error,
    /// Refused by a daily limit before any model call.
    RefusedLimit,
    /// Refused by the daily budget cap before any model call.
    RefusedBudget,
}

impl AiOutcome {
    pub const ALL: [AiOutcome; 6] = [
        AiOutcome::Ok,
        AiOutcome::Declined,
        AiOutcome::Invalid,
        AiOutcome::Error,
        AiOutcome::RefusedLimit,
        AiOutcome::RefusedBudget,
    ];

    /// The value `ai_usage.outcome` stores.
    pub fn as_str(self) -> &'static str {
        match self {
            AiOutcome::Ok => "ok",
            AiOutcome::Declined => "declined",
            AiOutcome::Invalid => "invalid",
            AiOutcome::Error => "error",
            AiOutcome::RefusedLimit => "refused_limit",
            AiOutcome::RefusedBudget => "refused_budget",
        }
    }

    pub fn parse(s: &str) -> Option<AiOutcome> {
        AiOutcome::ALL.into_iter().find(|o| o.as_str() == s)
    }

    /// Refused before a model was called.
    pub fn is_refusal(self) -> bool {
        matches!(self, AiOutcome::RefusedLimit | AiOutcome::RefusedBudget)
    }
}

/// Which series the view returns (`?by=`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SeriesBy {
    Hour,
    Day,
}

/// The response of `GET /api/overseer/ai-usage`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AiUsageView {
    pub generated_at: String,
    pub by: SeriesBy,
    /// 48 hourly or 90 daily buckets, oldest first, empty ones included.
    pub series: Vec<UsageBucket>,
    /// `None` when no daily budget cap is set.
    pub budget: Option<BudgetStatus>,
    /// ISO weeks, oldest first, up to 26.
    pub share: Vec<AiShareWeek>,
    /// Up to 10, by today's asks, then cost.
    pub top_businesses: Vec<TopRow>,
    /// Up to 10.
    pub top_users: Vec<TopRow>,
    pub flags: Vec<SpikeFlag>,
    /// The number of flags in `flags`: the Tools tab's badge.
    pub flag_count: u32,
    /// Only with `?business=` or `?user=`.
    pub asks: Option<AskList>,
    /// Every row's model had known prices. When false, unknown costs count as 0 in the figures.
    pub prices_known: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct UsageBucket {
    /// The bucket's first instant.
    pub start: String,
    pub asks: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Unknown costs count as 0; see `AiUsageView::prices_known`.
    pub cost_micro_usd: u64,
    pub by_kind: Vec<KindCount>,
    pub by_outcome: Vec<OutcomeCount>,
    /// Non-overseer asks only.
    pub by_plan: Vec<PlanCount>,
    pub overseer_asks: u32,
    pub overseer_cost_micro_usd: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct KindCount {
    pub kind: AiKind,
    pub asks: u32,
    pub cost_micro_usd: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OutcomeCount {
    pub outcome: AiOutcome,
    pub asks: u32,
    pub cost_micro_usd: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct PlanCount {
    pub plan: Plan,
    pub asks: u32,
    pub cost_micro_usd: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct BudgetStatus {
    /// The cap, in US cents.
    pub cap_cents: u32,
    /// Today's cost so far (UTC), in micro-dollars.
    pub spent_micro_usd: u64,
    /// Whole percent of the cap, rounded down.
    pub percent: u32,
    /// When today's spend reached the cap, if it has.
    pub reached_at: Option<String>,
    /// Asks refused today because of the cap.
    pub refused_today: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AiShareWeek {
    /// The Monday, as a date (`YYYY-MM-DD`).
    pub week_start: String,
    /// Such as `2026-W46`.
    pub iso_week: String,
    /// Bank-line codings that week.
    pub codings: u32,
    /// Of those, accepted from an AI pre-fill.
    pub via_suggestion: u32,
    /// Basis points; `None` when `codings` is 0.
    pub share_bp: Option<u32>,
    /// `None` before `ai_usage` has any suggestion row that week.
    pub layers: Option<LayerShares>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct LayerShares {
    pub lines_total: u32,
    pub rules_bp: u32,
    pub history_bp: u32,
    pub merchants_bp: u32,
    pub model_bp: u32,
    /// The rest, so the five add to 10_000.
    pub unanswered_bp: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TopRow {
    /// The business's or user's id.
    pub id: String,
    /// Read live; never stored in `ai_usage`.
    pub name: String,
    pub asks_today: u32,
    pub cost_today_micro_usd: u64,
    pub median_7d: u32,
    /// Against the median; `None` when the median is 0.
    pub change_pct: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SpikeFlag {
    /// The rule that fired.
    pub rule: SpikeRule,
    /// The business or user, if the flag is about one.
    pub subject_id: Option<String>,
    pub subject_name: Option<String>,
    /// What was seen: asks, or a percent for the share and budget rules.
    pub value: u64,
    /// What it was compared with.
    pub threshold: u64,
    /// The server's plain sentence.
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SpikeRule {
    Business,
    User,
    Hour,
    ErrorShare,
    BudgetWarn,
    BudgetHit,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AskList {
    pub subject: AskSubject,
    pub id: String,
    pub name: String,
    /// Newest first.
    pub rows: Vec<AskRow>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum AskSubject {
    Business,
    User,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AskRow {
    pub at: String,
    pub kind: AiKind,
    pub outcome: AiOutcome,
    pub plan: Plan,
    pub model: Option<String>,
    pub cost_micro_usd: Option<u64>,
    pub latency_ms: Option<u32>,
    pub business_id: String,
    pub user_id: Option<String>,
    pub is_overseer: bool,
    pub acting_as: Option<String>,
    pub lines_total: Option<u32>,
    pub by_rules: Option<u32>,
    pub by_history: Option<u32>,
    pub by_merchants: Option<u32>,
    pub lines_asked: Option<u32>,
    pub by_model: Option<u32>,
}

// ---------------------------------------------------------------------------------------------
// The reads, the AI share and the spike flags (ADR 016, 7, 9 and 10).
//
// `build` is pure: the same rows, codings and time always give the same view, so every threshold
// below is tested on synthetic rows. The handler only reads the database and fills in names.
//
// Counting rules, from the ADR:
// - Spike flags and medians count every ask a user made, refused ones included (refusals are what
//   abuse looks like), and leave overseers' asks out (support testing isn't a spike). The top
//   lists leave them out for the same reason; the series keeps them, split out as `overseer_*`.
// - A day is a UTC calendar day and an hour a UTC clock hour. Medians run over the previous 7
//   whole days or 168 whole hours, with empty ones counted as 0, and take the lower of the two
//   middle values, so they stay whole numbers.
// ---------------------------------------------------------------------------------------------

/// Today's asks must be more than this many times the 7-day median (and over the floor) to flag a
/// business or a user. Three times a normal day is clearly unusual, but not a busy Monday.
pub const SPIKE_MULTIPLE: u32 = 3;
/// A business's asks a day under which it never flags. A Free business makes at most 6 counted
/// asks a day (1 + 5), so 10 allows a few refused retries before a flag.
pub const BUSINESS_FLOOR: u32 = 10;
/// The same for a user, who may work across several clients.
pub const USER_FLOOR: u32 = 15;
/// An hour flags only over 3 times the platform's median hour and over this, so a quiet
/// platform's 2 to 7 asks doesn't.
pub const HOUR_FLOOR: u32 = 30;
/// `invalid` plus `error` flag when they're more than this percent of today's asks that reached
/// a model. A provider's usual failure rate is a few percent; a model change or an attack is far
/// higher.
pub const ERROR_SHARE_PCT: u32 = 20;
/// The error share needs at least this many asks that reached a model today. Small samples are
/// noise.
pub const ERROR_MIN_ASKS: u32 = 10;
/// With a daily budget cap set, today's cost at this percent of it flags, before refusals start.
pub const BUDGET_WARN_PCT: u32 = 80;

/// The hourly series covers this many hours, the current one included.
pub const SERIES_HOURS: i64 = 48;
/// The daily series covers this many days, today included.
pub const SERIES_DAYS: i64 = 90;
/// The AI share covers this many ISO weeks, the current one included.
pub const SHARE_WEEKS: i64 = 26;
/// How many businesses and how many users the top lists hold.
pub const TOP_N: usize = 10;
/// How many asks one business's or user's list holds.
pub const ASK_LIST_MAX: usize = 500;
/// The ask list's window when `from` isn't given, and the most it may span.
pub const ASK_LIST_DEFAULT_DAYS: i64 = 7;
pub const ASK_LIST_MAX_DAYS: i64 = 90;
/// Previous whole days a subject's median runs over, and previous whole hours the platform's does.
const MEDIAN_DAYS: usize = 7;
const MEDIAN_HOURS: i64 = 168;
/// The hour flags look at the last this many hours, the current one included.
const HOURS_CHECKED: i64 = 24;
/// US micro-dollars in a US cent.
const MICRO_USD_PER_CENT: u64 = 10_000;

/// Whole numbers for sizes and counts, saturating.
fn sat32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn u64_of(n: i64) -> u64 {
    u64::try_from(n).unwrap_or(0)
}

fn u32_of(n: i64) -> u32 {
    u32::try_from(n).unwrap_or(0)
}

/// The names the view shows, read live from the businesses and users (never stored in
/// `ai_usage`). A business or user that's gone, such as an expired trial, has a stand-in.
#[derive(Debug, Clone, Default)]
pub struct Names {
    pub businesses: BTreeMap<String, String>,
    pub users: BTreeMap<String, String>,
}

impl Names {
    pub fn business(&self, id: &str) -> String {
        self.businesses
            .get(id)
            .cloned()
            .unwrap_or_else(|| "A removed business".to_owned())
    }

    pub fn user(&self, id: &str) -> String {
        self.users
            .get(id)
            .cloned()
            .unwrap_or_else(|| "A removed user".to_owned())
    }
}

/// Everything [`build`] reads.
pub struct Inputs<'a> {
    pub now: DateTime<Utc>,
    pub by: SeriesBy,
    /// The last [`SERIES_DAYS`] days of `ai_usage`.
    pub rows: &'a [UsageRow],
    /// Bank-line codings from the first AI-share week on.
    pub codings: &'a [CodingEvent],
    /// Suggestion runs from the first AI-share week on.
    pub layers: &'a [LayerRow],
    pub names: &'a Names,
    /// `ACCT_AI_DAILY_BUDGET_CENTS`, if set.
    pub budget_cap_cents: Option<u32>,
}

/// One ask, as the figures need it.
struct Seen {
    at: DateTime<Utc>,
    kind: AiKind,
    outcome: AiOutcome,
    plan: Plan,
    is_overseer: bool,
    business: String,
    user: Option<String>,
    /// `None`: the model's prices were unknown.
    cost: Option<u64>,
    input_tokens: u64,
    output_tokens: u64,
    /// The ask reached a model (or tried to): not refused, and not a run the first three layers
    /// answered alone.
    reached_model: bool,
}

impl Seen {
    fn of(r: &UsageRow) -> Option<Seen> {
        let outcome = AiOutcome::parse(&r.outcome)?;
        Some(Seen {
            at: r.at,
            kind: AiKind::parse(&r.kind)?,
            outcome,
            plan: Plan::parse(&r.plan)?,
            is_overseer: r.is_overseer,
            business: r.business_id.clone(),
            user: r.user_id.clone(),
            cost: r.cost_micro_usd.map(u64_of),
            input_tokens: u64_of(r.input_tokens),
            output_tokens: u64_of(r.output_tokens),
            reached_model: !outcome.is_refusal() && (r.model.is_some() || outcome != AiOutcome::Ok),
        })
    }
}

fn day_start(at: DateTime<Utc>) -> DateTime<Utc> {
    at.date_naive().and_time(NaiveTime::MIN).and_utc()
}

fn hour_start(at: DateTime<Utc>) -> DateTime<Utc> {
    at.date_naive()
        .and_hms_opt(at.hour(), 0, 0)
        .expect("a whole hour exists")
        .and_utc()
}

/// The Monday of the ISO week holding `day`.
fn week_of(day: NaiveDate) -> NaiveDate {
    day - Duration::days(i64::from(day.weekday().num_days_from_monday()))
}

fn rfc(at: DateTime<Utc>) -> String {
    at.to_rfc3339_opts(SecondsFormat::Secs, true)
}

/// The lower of the two middle values, so a median of whole numbers is whole.
fn median_low(mut values: Vec<u32>) -> u32 {
    values.sort_unstable();
    match values.len() {
        0 => 0,
        n => values[(n - 1) / 2],
    }
}

/// What a business, user or hour must exceed to flag: [`SPIKE_MULTIPLE`] times its median, and
/// the floor. A subject with no history has median 0, so only the floor applies.
pub fn spike_threshold(median: u32, floor: u32) -> u32 {
    SPIKE_MULTIPLE.saturating_mul(median).max(floor)
}

/// US dollars for the sentences, such as `US$4.10`, from micro-dollars (rounded down to cents).
fn usd(micro: u64) -> String {
    let cents = micro / MICRO_USD_PER_CENT;
    format!("US${}.{:02}", cents / 100, cents % 100)
}

// ---- the series --------------------------------------------------------------------------

#[derive(Default)]
struct Acc {
    asks: u32,
    input_tokens: u64,
    output_tokens: u64,
    cost: u64,
    kinds: BTreeMap<AiKind, (u32, u64)>,
    outcomes: BTreeMap<AiOutcome, (u32, u64)>,
    plans: BTreeMap<Plan, (u32, u64)>,
    overseer_asks: u32,
    overseer_cost: u64,
}

fn tally<K: Ord>(map: &mut BTreeMap<K, (u32, u64)>, key: K, cost: u64) {
    let e = map.entry(key).or_default();
    e.0 += 1;
    e.1 += cost;
}

/// 48 hourly or 90 daily buckets, oldest first, empty ones included. Every ask counts in `asks`,
/// `by_kind` and `by_outcome`; an overseer's is also counted in `overseer_*`, and `by_plan` leaves
/// overseers out. Only buckets that have asks list a kind, outcome or plan.
fn series(seen: &[Seen], now: DateTime<Utc>, by: SeriesBy) -> Vec<UsageBucket> {
    let (step, n, last) = match by {
        SeriesBy::Hour => (3600_i64, SERIES_HOURS, hour_start(now)),
        SeriesBy::Day => (86_400_i64, SERIES_DAYS, day_start(now)),
    };
    let first = last - Duration::seconds(step * (n - 1));
    let mut accs: Vec<Acc> = (0..n).map(|_| Acc::default()).collect();
    for s in seen {
        let index = (s.at - first).num_seconds().div_euclid(step);
        let Some(acc) = usize::try_from(index).ok().and_then(|i| accs.get_mut(i)) else {
            continue;
        };
        let cost = s.cost.unwrap_or(0);
        acc.asks += 1;
        acc.input_tokens += s.input_tokens;
        acc.output_tokens += s.output_tokens;
        acc.cost += cost;
        tally(&mut acc.kinds, s.kind, cost);
        tally(&mut acc.outcomes, s.outcome, cost);
        if s.is_overseer {
            acc.overseer_asks += 1;
            acc.overseer_cost += cost;
        } else {
            tally(&mut acc.plans, s.plan, cost);
        }
    }
    accs.into_iter()
        .zip(0_i64..)
        .map(|(a, i)| UsageBucket {
            start: rfc(first + Duration::seconds(step * i)),
            asks: a.asks,
            input_tokens: a.input_tokens,
            output_tokens: a.output_tokens,
            cost_micro_usd: a.cost,
            by_kind: a
                .kinds
                .into_iter()
                .map(|(kind, (asks, cost_micro_usd))| KindCount {
                    kind,
                    asks,
                    cost_micro_usd,
                })
                .collect(),
            by_outcome: a
                .outcomes
                .into_iter()
                .map(|(outcome, (asks, cost_micro_usd))| OutcomeCount {
                    outcome,
                    asks,
                    cost_micro_usd,
                })
                .collect(),
            by_plan: a
                .plans
                .into_iter()
                .map(|(plan, (asks, cost_micro_usd))| PlanCount {
                    plan,
                    asks,
                    cost_micro_usd,
                })
                .collect(),
            overseer_asks: a.overseer_asks,
            overseer_cost_micro_usd: a.overseer_cost,
        })
        .collect()
}

// ---- who made the asks -------------------------------------------------------------------

/// One business's or user's asks: today's, and each of the 7 days before.
#[derive(Default)]
struct Counts {
    today: u32,
    cost_today: u64,
    /// `prior[0]` is yesterday.
    prior: [u32; MEDIAN_DAYS],
}

impl Counts {
    fn median(&self) -> u32 {
        median_low(self.prior.to_vec())
    }
}

/// Non-overseer asks per subject (`key` picks the business or user).
fn per_subject<'a>(
    seen: &'a [Seen],
    today: NaiveDate,
    key: impl Fn(&'a Seen) -> Option<&'a str>,
) -> BTreeMap<&'a str, Counts> {
    let mut map: BTreeMap<&str, Counts> = BTreeMap::new();
    for s in seen.iter().filter(|s| !s.is_overseer) {
        let Some(k) = key(s) else { continue };
        let age = (today - s.at.date_naive()).num_days();
        let c = map.entry(k).or_default();
        match age {
            0 => {
                c.today += 1;
                c.cost_today += s.cost.unwrap_or(0);
            }
            1..=7 => {
                if let Some(day) = usize::try_from(age - 1)
                    .ok()
                    .and_then(|i| c.prior.get_mut(i))
                {
                    *day += 1;
                }
            }
            _ => {}
        }
    }
    map
}

/// The top [`TOP_N`] by today's asks, then today's cost, with each one's change against its own
/// median. Only subjects that asked today.
fn top_rows(map: &BTreeMap<&str, Counts>, name: impl Fn(&str) -> String) -> Vec<TopRow> {
    let mut rows: Vec<(&str, &Counts)> = map
        .iter()
        .filter(|(_, c)| c.today > 0)
        .map(|(id, c)| (*id, c))
        .collect();
    rows.sort_by(|a, b| {
        b.1.today
            .cmp(&a.1.today)
            .then(b.1.cost_today.cmp(&a.1.cost_today))
            .then(a.0.cmp(b.0))
    });
    rows.into_iter()
        .take(TOP_N)
        .map(|(id, c)| {
            let median = c.median();
            TopRow {
                id: id.to_owned(),
                name: name(id),
                asks_today: c.today,
                cost_today_micro_usd: c.cost_today,
                median_7d: median,
                change_pct: (median > 0).then(|| {
                    let change = (i64::from(c.today) - i64::from(median)) * 100 / i64::from(median);
                    i32::try_from(change).unwrap_or(i32::MAX)
                }),
            }
        })
        .collect()
}

/// The business or user flags: today's asks over [`SPIKE_MULTIPLE`] times the 7-day median and
/// over `floor`. Biggest first.
fn subject_flags(
    map: &BTreeMap<&str, Counts>,
    floor: u32,
    rule: SpikeRule,
    name: impl Fn(&str) -> String,
) -> Vec<SpikeFlag> {
    let mut flags: Vec<SpikeFlag> = map
        .iter()
        .filter_map(|(id, c)| {
            let median = c.median();
            let threshold = spike_threshold(median, floor);
            (c.today > threshold).then(|| {
                let name = name(id);
                let usual = if rule == SpikeRule::Business {
                    "Its"
                } else {
                    "Their"
                };
                SpikeFlag {
                    rule,
                    subject_id: Some((*id).to_owned()),
                    subject_name: Some(name.clone()),
                    value: u64::from(c.today),
                    threshold: u64::from(threshold),
                    message: format!(
                        "{name} made {} AI asks today. {usual} usual is {median} a day, so more \
                         than {threshold} is flagged.",
                        c.today
                    ),
                }
            })
        })
        .collect();
    flags.sort_by(|a, b| b.value.cmp(&a.value).then(a.subject_id.cmp(&b.subject_id)));
    flags
}

// ---- the platform ------------------------------------------------------------------------

/// Any of the last [`HOURS_CHECKED`] hours (newest first) over [`SPIKE_MULTIPLE`] times the
/// platform's median hour (the 168 whole hours before the current one) and over [`HOUR_FLOOR`].
fn hour_flags(seen: &[Seen], now: DateTime<Utc>) -> Vec<SpikeFlag> {
    let current = hour_start(now);
    let mut by_hour: BTreeMap<DateTime<Utc>, u32> = BTreeMap::new();
    for s in seen.iter().filter(|s| !s.is_overseer) {
        *by_hour.entry(hour_start(s.at)).or_default() += 1;
    }
    let at = |i: i64| {
        by_hour
            .get(&(current - Duration::hours(i)))
            .copied()
            .unwrap_or(0)
    };
    let median = median_low((1..=MEDIAN_HOURS).map(at).collect());
    let threshold = spike_threshold(median, HOUR_FLOOR);
    (0..HOURS_CHECKED)
        .filter(|&i| at(i) > threshold)
        .map(|i| SpikeFlag {
            rule: SpikeRule::Hour,
            subject_id: None,
            subject_name: None,
            value: u64::from(at(i)),
            threshold: u64::from(threshold),
            message: format!(
                "{} AI asks in the hour from {} UTC. The usual hour has {median}, so more than \
                 {threshold} is flagged.",
                at(i),
                (current - Duration::hours(i)).format("%Y-%m-%d %H:%M"),
            ),
        })
        .collect()
}

/// `invalid` plus `error` over [`ERROR_SHARE_PCT`] of today's asks that reached a model, with at
/// least [`ERROR_MIN_ASKS`] of them. A model change and an attack both look like this.
fn error_flag(seen: &[Seen], today: NaiveDate) -> Option<SpikeFlag> {
    let (mut total, mut bad) = (0_u64, 0_u64);
    for s in seen
        .iter()
        .filter(|s| !s.is_overseer && s.reached_model && s.at.date_naive() == today)
    {
        total += 1;
        if matches!(s.outcome, AiOutcome::Invalid | AiOutcome::Error) {
            bad += 1;
        }
    }
    if total < u64::from(ERROR_MIN_ASKS) || bad * 100 <= u64::from(ERROR_SHARE_PCT) * total {
        return None;
    }
    // Rounded up, so a share that tipped over the line never reads as the line itself.
    let percent = (bad * 100).div_ceil(total);
    Some(SpikeFlag {
        rule: SpikeRule::ErrorShare,
        subject_id: None,
        subject_name: None,
        value: percent,
        threshold: u64::from(ERROR_SHARE_PCT),
        message: format!(
            "{bad} of today's {total} AI calls to the model failed or gave answers we couldn't \
             use ({percent}%). More than {ERROR_SHARE_PCT}% is flagged: a model change and an \
             attack both look like this."
        ),
    })
}

// ---- the budget --------------------------------------------------------------------------

/// Today's spend against the cap. Every ask counts, overseers' too, because it's real money.
fn budget_status(seen: &[Seen], cap_cents: u32, now: DateTime<Utc>) -> BudgetStatus {
    let cap = u64::from(cap_cents) * MICRO_USD_PER_CENT;
    let today = now.date_naive();
    let (mut spent, mut refused) = (0_u64, 0_u32);
    let mut reached_at = None;
    for s in seen.iter().filter(|s| s.at.date_naive() == today) {
        spent += s.cost.unwrap_or(0);
        if reached_at.is_none() && cap > 0 && spent >= cap {
            reached_at = Some(rfc(s.at));
        }
        if s.outcome == AiOutcome::RefusedBudget {
            refused += 1;
        }
    }
    BudgetStatus {
        cap_cents,
        spent_micro_usd: spent,
        percent: u32::try_from(spent.saturating_mul(100).checked_div(cap).unwrap_or(0))
            .unwrap_or(u32::MAX),
        reached_at,
        refused_today: refused,
    }
}

/// The budget's flag, if any: at [`BUDGET_WARN_PCT`] a warning, once the cap's reached (or it's
/// refusing model calls, as when its prices are unknown) a hit.
fn budget_flag(b: &BudgetStatus) -> Option<SpikeFlag> {
    let cap = u64::from(b.cap_cents) * MICRO_USD_PER_CENT;
    let flag = |rule, value: u32, threshold: u32, message: String| SpikeFlag {
        rule,
        subject_id: None,
        subject_name: None,
        value: u64::from(value),
        threshold: u64::from(threshold),
        message,
    };
    if b.reached_at.is_some() || b.refused_today > 0 {
        let when = b
            .reached_at
            .as_deref()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(|t| format!(" was reached at {} UTC", t.format("%H:%M")))
            .unwrap_or_else(|| " is refusing model calls".to_owned());
        return Some(flag(
            SpikeRule::BudgetHit,
            b.percent,
            100,
            format!(
                "The daily AI budget of {}{when}. Model calls are refused until 00:00 UTC; {} \
                 asks refused so far.",
                usd(cap),
                b.refused_today
            ),
        ));
    }
    (b.percent >= BUDGET_WARN_PCT).then(|| {
        flag(
            SpikeRule::BudgetWarn,
            b.percent,
            BUDGET_WARN_PCT,
            format!(
                "Today's AI spend is {}, {}% of the {} daily budget.",
                usd(b.spent_micro_usd),
                b.percent,
                usd(cap)
            ),
        )
    })
}

// ---- the AI share ------------------------------------------------------------------------

#[derive(Default)]
struct WeekAcc {
    codings: u64,
    via_suggestion: u64,
    runs: u64,
    lines_total: u64,
    by_rules: u64,
    by_history: u64,
    by_merchants: u64,
    by_model: u64,
}

/// Basis points of `part` in `whole`, rounded down.
fn bp(part: u64, whole: u64) -> u32 {
    u32::try_from(part.saturating_mul(10_000).checked_div(whole).unwrap_or(0)).unwrap_or(u32::MAX)
}

/// The last [`SHARE_WEEKS`] ISO weeks (UTC, Monday to Sunday), oldest first.
///
/// - `share_bp` is the lines accepted from an AI pre-fill over all lines coded, per week, from
///   the command log. It goes back as far as the log does.
/// - `layers` is what each layer answered, from `ai_usage`'s suggestion runs, and is `None` for a
///   week with no run (before M22 there are none): "not measured", never 0%. A week whose runs
///   saw no cards at all has nothing to take a share of, so it's `None` too.
fn share(codings: &[CodingEvent], layers: &[LayerRow], now: DateTime<Utc>) -> Vec<AiShareWeek> {
    let this_week = week_of(now.date_naive());
    let first = this_week - Duration::weeks(SHARE_WEEKS - 1);
    let mut weeks: BTreeMap<NaiveDate, WeekAcc> = (0..SHARE_WEEKS)
        .map(|i| (first + Duration::weeks(i), WeekAcc::default()))
        .collect();
    for c in codings {
        if let Some(w) = weeks.get_mut(&week_of(c.at.date_naive())) {
            let codings = u64_of(c.codings);
            w.codings += codings;
            // One command can't accept more pre-fills than it coded lines.
            w.via_suggestion += u64_of(c.via_suggestion).min(codings);
        }
    }
    for l in layers {
        if let Some(w) = weeks.get_mut(&week_of(l.at.date_naive())) {
            w.runs += 1;
            w.lines_total += u64_of(l.lines_total);
            w.by_rules += u64_of(l.by_rules);
            w.by_history += u64_of(l.by_history);
            w.by_merchants += u64_of(l.by_merchants);
            w.by_model += u64_of(l.by_model);
        }
    }
    weeks
        .into_iter()
        .map(|(monday, w)| {
            let layers = (w.runs > 0 && w.lines_total > 0).then(|| {
                let (rules_bp, history_bp, merchants_bp, model_bp) = (
                    bp(w.by_rules, w.lines_total),
                    bp(w.by_history, w.lines_total),
                    bp(w.by_merchants, w.lines_total),
                    bp(w.by_model, w.lines_total),
                );
                LayerShares {
                    lines_total: u32::try_from(w.lines_total).unwrap_or(u32::MAX),
                    rules_bp,
                    history_bp,
                    merchants_bp,
                    model_bp,
                    // The rest, so the five add to exactly 10,000.
                    unanswered_bp: 10_000_u32
                        .saturating_sub(rules_bp + history_bp + merchants_bp + model_bp),
                }
            });
            let iso = monday.iso_week();
            AiShareWeek {
                week_start: monday.format("%Y-%m-%d").to_string(),
                iso_week: format!("{}-W{:02}", iso.year(), iso.week()),
                codings: u32::try_from(w.codings).unwrap_or(u32::MAX),
                via_suggestion: u32::try_from(w.via_suggestion).unwrap_or(u32::MAX),
                share_bp: (w.codings > 0).then(|| bp(w.via_suggestion, w.codings)),
                layers,
            }
        })
        .collect()
}

// ---- putting it together -----------------------------------------------------------------

/// The whole view, except for `asks` (a business's or user's list, read separately).
pub fn build(i: &Inputs<'_>) -> AiUsageView {
    let mut seen: Vec<Seen> = i.rows.iter().filter_map(Seen::of).collect();
    seen.sort_by_key(|s| s.at);
    let today = i.now.date_naive();
    let by_business = per_subject(&seen, today, |s| Some(s.business.as_str()));
    let by_user = per_subject(&seen, today, |s| s.user.as_deref());
    let budget = i
        .budget_cap_cents
        .map(|cap| budget_status(&seen, cap, i.now));

    // Most urgent first: the money, then a failing provider, then who's asking, then when.
    let mut flags: Vec<SpikeFlag> = Vec::new();
    flags.extend(budget.as_ref().and_then(budget_flag));
    flags.extend(error_flag(&seen, today));
    flags.extend(subject_flags(
        &by_business,
        BUSINESS_FLOOR,
        SpikeRule::Business,
        |id| i.names.business(id),
    ));
    flags.extend(subject_flags(&by_user, USER_FLOOR, SpikeRule::User, |id| {
        i.names.user(id)
    }));
    flags.extend(hour_flags(&seen, i.now));

    AiUsageView {
        generated_at: rfc(i.now),
        by: i.by,
        series: series(&seen, i.now, i.by),
        budget,
        share: share(i.codings, i.layers, i.now),
        top_businesses: top_rows(&by_business, |id| i.names.business(id)),
        top_users: top_rows(&by_user, |id| i.names.user(id)),
        flag_count: sat32(flags.len()),
        flags,
        asks: None,
        prices_known: i.rows.iter().all(|r| r.cost_micro_usd.is_some()),
    }
}

/// One stored row as the ask list shows it.
pub fn ask_row(r: &UsageRow) -> Option<AskRow> {
    Some(AskRow {
        at: rfc(r.at),
        kind: AiKind::parse(&r.kind)?,
        outcome: AiOutcome::parse(&r.outcome)?,
        plan: Plan::parse(&r.plan)?,
        model: r.model.clone(),
        cost_micro_usd: r.cost_micro_usd.map(u64_of),
        latency_ms: r.latency_ms.map(u32_of),
        business_id: r.business_id.clone(),
        user_id: r.user_id.clone(),
        is_overseer: r.is_overseer,
        acting_as: r.acting_as.clone(),
        lines_total: r.lines_total.map(u32_of),
        by_rules: r.by_rules.map(u32_of),
        by_history: r.by_history.map(u32_of),
        by_merchants: r.by_merchants.map(u32_of),
        lines_asked: r.lines_asked.map(u32_of),
        by_model: r.by_model.map(u32_of),
    })
}

/// The query of `GET /api/overseer/ai-usage`. Every part is optional.
#[derive(Debug, Default, Deserialize)]
pub struct AiUsageQuery {
    /// Which series: `hour` or `day` (the default).
    pub by: Option<SeriesBy>,
    /// Add this business's asks. Not with `user`.
    pub business: Option<String>,
    /// Add this person's asks. Not with `business`.
    pub user: Option<String>,
    /// The ask list's window, RFC 3339. The default is the last 7 days, and the most 90.
    pub from: Option<String>,
    pub to: Option<String>,
}

fn parse_time(name: &str, value: &str) -> Result<DateTime<Utc>, CommandError> {
    DateTime::parse_from_rfc3339(value)
        .map(|t| t.to_utc())
        .map_err(|_| CommandError::Malformed(format!("`{name}` must be an RFC 3339 time")))
}

/// The ask list's window: `to` is now unless given, `from` is 7 days before it unless given, and
/// the window is cut to 90 days.
fn ask_window(
    q: &AiUsageQuery,
    now: DateTime<Utc>,
) -> Result<(DateTime<Utc>, DateTime<Utc>), CommandError> {
    let to = match &q.to {
        Some(t) => parse_time("to", t)?,
        None => now + Duration::seconds(1),
    };
    let from = match &q.from {
        Some(t) => parse_time("from", t)?,
        None => to - Duration::days(ASK_LIST_DEFAULT_DAYS),
    };
    if from >= to {
        return Err(CommandError::Malformed("`from` must be before `to`".into()));
    }
    Ok((from.max(to - Duration::days(ASK_LIST_MAX_DAYS)), to))
}

/// `GET /api/overseer/ai-usage` (ADR 016, 9). Overseers only, as themselves
/// (`access::RouteRule::Overseer`), so no practice user, owner or guest reaches it, and an overseer
/// viewing as someone doesn't either.
pub async fn get_ai_usage(
    State(state): State<AppState>,
    _user: CurrentUser,
    query: Result<Query<AiUsageQuery>, QueryRejection>,
) -> Result<Json<AiUsageView>, CommandError> {
    let Query(q) = query.map_err(|e| CommandError::Malformed(e.body_text()))?;
    if q.business.is_some() && q.user.is_some() {
        return Err(CommandError::Malformed(
            "`business` and `user` can't be used together".into(),
        ));
    }
    let now = Utc::now();
    let window = if q.business.is_some() || q.user.is_some() {
        Some(ask_window(&q, now)?)
    } else {
        None
    };
    let mut conn = state.store.reader().await?;

    let series_from = day_start(now) - Duration::days(SERIES_DAYS - 1);
    let share_from = week_of(now.date_naive()).and_time(NaiveTime::MIN).and_utc()
        - Duration::weeks(SHARE_WEEKS - 1);
    let rows = store::rows_since(&mut conn, series_from).await?;
    let layers = store::layer_rows_since(&mut conn, share_from).await?;
    let codings = store::coding_events(&mut conn, share_from).await?;

    // Names for whoever asked today: the top lists and the flags only name them.
    let today = day_start(now);
    let (mut businesses, mut users) = (BTreeSet::new(), BTreeSet::new());
    for r in rows.iter().filter(|r| r.at >= today) {
        businesses.insert(r.business_id.clone());
        users.extend(r.user_id.clone());
    }
    let names = Names {
        businesses: store::business_names(&mut conn, &businesses.into_iter().collect::<Vec<_>>())
            .await?,
        users: store::user_names(&mut conn, &users.into_iter().collect::<Vec<_>>()).await?,
    };

    let mut view = build(&Inputs {
        now,
        by: q.by.unwrap_or(SeriesBy::Day),
        rows: &rows,
        codings: &codings,
        layers: &layers,
        names: &names,
        budget_cap_cents: state
            .suggester
            .as_ref()
            .and_then(|m| m.daily_budget_cents()),
    });

    if let Some((from, to)) = window {
        let (subject, id) = match (&q.business, &q.user) {
            (Some(b), _) => (AskSubject::Business, b.as_str()),
            (_, Some(u)) => (AskSubject::User, u.as_str()),
            _ => unreachable!("a window is only made for a subject"),
        };
        let found = match subject {
            AskSubject::Business => store::Subject::Business(id),
            AskSubject::User => store::Subject::User(id),
        };
        let limit = i64::try_from(ASK_LIST_MAX).unwrap_or(i64::MAX);
        let mut found = store::rows_for(&mut conn, found, from, to, limit + 1).await?;
        let truncated = found.len() > ASK_LIST_MAX;
        found.truncate(ASK_LIST_MAX);
        let ids = [id.to_owned()];
        let name = match subject {
            AskSubject::Business => store::business_names(&mut conn, &ids).await?,
            AskSubject::User => store::user_names(&mut conn, &ids).await?,
        }
        .remove(id);
        // An unknown id with no asks is a 404; one with asks (a business that's gone since) is
        // listed under a stand-in name.
        let name = match (name, found.is_empty()) {
            (Some(n), _) => n,
            (None, false) => match subject {
                AskSubject::Business => Names::default().business(id),
                AskSubject::User => Names::default().user(id),
            },
            (None, true) => {
                return Err(CommandError::not_found(
                    match subject {
                        AskSubject::Business => "business",
                        AskSubject::User => "user",
                    },
                    id,
                ));
            }
        };
        view.asks = Some(AskList {
            subject,
            id: id.to_owned(),
            name,
            rows: found.iter().filter_map(ask_row).collect(),
            truncated,
        });
    }
    Ok(Json(view))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Wednesday 11 November 2026, 15:30 UTC: the week starts Monday the 9th (ISO week 46).
    fn now() -> DateTime<Utc> {
        at("2026-11-11T15:30:00Z")
    }

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().to_utc()
    }

    /// An ask by `business` (and `user`) at `when`: an explanation that cost 300 micro-dollars.
    fn row(when: DateTime<Utc>, business: &str, user: Option<&str>) -> UsageRow {
        UsageRow {
            id: format!("{business}-{}", when.timestamp_micros()),
            at: when,
            kind: "explain".into(),
            business_id: business.into(),
            user_id: user.map(str::to_owned),
            plan: "free".into(),
            is_overseer: false,
            acting_as: None,
            model: Some("m".into()),
            model_calls: 1,
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            cost_micro_usd: Some(300),
            latency_ms: Some(50),
            outcome: "ok".into(),
            lines_total: None,
            by_rules: None,
            by_history: None,
            by_merchants: None,
            lines_asked: None,
            by_model: None,
        }
    }

    fn with_outcome(mut r: UsageRow, outcome: &str) -> UsageRow {
        r.outcome = outcome.into();
        r
    }

    fn with_cost(mut r: UsageRow, cost: i64) -> UsageRow {
        r.cost_micro_usd = Some(cost);
        r
    }

    /// `n` asks by distinct businesses and `user`, at `when`, so no business flags.
    fn spread(n: u32, when: DateTime<Utc>, tag: &str, user: Option<&str>) -> Vec<UsageRow> {
        (0..n)
            .map(|i| {
                row(
                    when + Duration::seconds(i64::from(i)),
                    &format!("{tag}{i}"),
                    user,
                )
            })
            .collect()
    }

    /// `n` asks by one business, at `when`.
    fn by_business(n: u32, when: DateTime<Utc>, business: &str) -> Vec<UsageRow> {
        (0..n)
            .map(|i| row(when + Duration::seconds(i64::from(i)), business, None))
            .collect()
    }

    fn view_of(rows: &[UsageRow], cap: Option<u32>) -> AiUsageView {
        build(&Inputs {
            now: now(),
            by: SeriesBy::Day,
            rows,
            codings: &[],
            layers: &[],
            names: &Names::default(),
            budget_cap_cents: cap,
        })
    }

    fn rules(view: &AiUsageView) -> Vec<SpikeRule> {
        view.flags.iter().map(|f| f.rule).collect()
    }

    /// Business `b1` asked `per_day` times on each of the 7 days before today, and `today` times
    /// today.
    fn history(per_day: u32, today: u32) -> Vec<UsageRow> {
        let mut rows = Vec::new();
        for days_ago in 1..=7 {
            let noon = at("2026-11-11T12:00:00Z") - Duration::days(days_ago);
            rows.extend(by_business(per_day, noon, "b1"));
        }
        rows.extend(by_business(today, at("2026-11-11T09:00:00Z"), "b1"));
        rows
    }

    #[test]
    fn the_median_is_the_lower_middle() {
        assert_eq!(median_low(vec![]), 0);
        assert_eq!(median_low(vec![5]), 5);
        assert_eq!(median_low(vec![9, 1, 5, 3]), 3);
        assert_eq!(median_low(vec![0, 0, 0, 0, 7, 7, 7]), 0);
        assert_eq!(median_low(vec![0, 0, 0, 7, 7, 7, 7]), 7);
    }

    #[test]
    fn a_business_over_three_times_its_median_flags() {
        // SPIKE_MULTIPLE: a usual 4 a day flags over 12.
        assert_eq!(SPIKE_MULTIPLE, 3);
        let quiet = view_of(&history(4, 12), None);
        assert!(
            quiet.flags.is_empty(),
            "12 is 3 times 4, not over: {:?}",
            quiet.flags
        );
        let spike = view_of(&history(4, 13), None);
        assert_eq!(rules(&spike), [SpikeRule::Business]);
        let f = &spike.flags[0];
        assert_eq!((f.value, f.threshold), (13, 12));
        assert_eq!(f.subject_id.as_deref(), Some("b1"));
        assert_eq!(spike.flag_count, 1);
        // The top list says how far over its own median it is: (13 - 4) / 4 = +225%.
        let top = &spike.top_businesses[0];
        assert_eq!(
            (top.asks_today, top.median_7d, top.change_pct),
            (13, 4, Some(225))
        );
    }

    #[test]
    fn a_business_below_the_floor_never_flags() {
        // BUSINESS_FLOOR: a usual 1 a day is 3 times over at 4, but a business needs over 10.
        assert_eq!(BUSINESS_FLOOR, 10);
        assert!(view_of(&history(1, 10), None).flags.is_empty());
        assert!(view_of(&history(1, 4), None).flags.is_empty());
        let spike = view_of(&history(1, 11), None);
        assert_eq!(rules(&spike), [SpikeRule::Business]);
        assert_eq!(spike.flags[0].threshold, 10);
    }

    #[test]
    fn a_new_business_is_compared_to_the_floor_alone() {
        let new = |n| by_business(n, at("2026-11-11T09:00:00Z"), "fresh");
        assert!(view_of(&new(10), None).flags.is_empty());
        let spike = view_of(&new(11), None);
        assert_eq!(rules(&spike), [SpikeRule::Business]);
        // No median to compare with, so no change either.
        assert_eq!(spike.top_businesses[0].median_7d, 0);
        assert_eq!(spike.top_businesses[0].change_pct, None);
    }

    #[test]
    fn a_user_over_the_user_floor_flags() {
        // USER_FLOOR: asks spread across 16 businesses, so only the person is busy.
        assert_eq!(USER_FLOOR, 15);
        let when = at("2026-11-11T09:00:00Z");
        assert!(
            view_of(&spread(15, when, "b", Some("sam")), None)
                .flags
                .is_empty()
        );
        let spike = view_of(&spread(16, when, "b", Some("sam")), None);
        assert_eq!(rules(&spike), [SpikeRule::User]);
        assert_eq!(spike.flags[0].subject_id.as_deref(), Some("sam"));
        assert_eq!(spike.top_users[0].asks_today, 16);
    }

    #[test]
    fn an_hour_flags_over_the_floor_when_the_platform_is_quiet() {
        // HOUR_FLOOR: a quiet platform's median hour is 0, so only the floor counts.
        assert_eq!(HOUR_FLOOR, 30);
        let nine = at("2026-11-11T09:00:00Z");
        assert!(view_of(&spread(30, nine, "b", None), None).flags.is_empty());
        let spike = view_of(&spread(31, nine, "b", None), None);
        assert_eq!(rules(&spike), [SpikeRule::Hour]);
        assert_eq!((spike.flags[0].value, spike.flags[0].threshold), (31, 30));
        assert!(spike.flags[0].message.contains("2026-11-11 09:00 UTC"));
    }

    #[test]
    fn an_hour_flags_over_three_times_the_platform_median() {
        // A busy platform: 11 asks in every one of the previous hours, so 3 times is 33.
        let current = hour_start(now());
        let busy = |test_hour: u32| {
            let mut rows = Vec::new();
            for i in 1..=MEDIAN_HOURS {
                if i != 6 {
                    rows.extend(spread(
                        11,
                        current - Duration::hours(i),
                        &format!("h{i}-"),
                        None,
                    ));
                }
            }
            // Six hours back is 09:00 today.
            rows.extend(spread(test_hour, current - Duration::hours(6), "t", None));
            rows
        };
        assert!(view_of(&busy(33), None).flags.is_empty());
        let spike = view_of(&busy(34), None);
        assert_eq!(rules(&spike), [SpikeRule::Hour]);
        assert_eq!((spike.flags[0].value, spike.flags[0].threshold), (34, 33));
    }

    #[test]
    fn a_failing_model_flags_over_the_error_share() {
        // ERROR_SHARE_PCT and ERROR_MIN_ASKS.
        assert_eq!((ERROR_SHARE_PCT, ERROR_MIN_ASKS), (20, 10));
        let when = at("2026-11-11T09:00:00Z");
        let mix = |errors: usize, total: usize| {
            let mut rows = spread(u32::try_from(total).unwrap(), when, "b", None);
            for r in rows.iter_mut().take(errors) {
                r.outcome = "error".into();
            }
            // Asks that never reached a model say nothing about the provider.
            for i in 0..5 {
                rows.push(with_outcome(
                    row(when, &format!("r{i}"), None),
                    "refused_limit",
                ));
                let mut free = row(when, &format!("f{i}"), None);
                free.model = None;
                rows.push(free);
            }
            rows
        };
        assert!(
            view_of(&mix(2, 10), None).flags.is_empty(),
            "20% is the line, not over it"
        );
        let spike = view_of(&mix(3, 10), None);
        assert_eq!(rules(&spike), [SpikeRule::ErrorShare]);
        assert_eq!((spike.flags[0].value, spike.flags[0].threshold), (30, 20));
        // `invalid` counts like `error`.
        let mut rows = mix(0, 10);
        for r in rows.iter_mut().take(3) {
            r.outcome = "invalid".into();
        }
        assert_eq!(rules(&view_of(&rows, None)), [SpikeRule::ErrorShare]);
        // Under ERROR_MIN_ASKS, even all errors is noise.
        assert!(view_of(&mix(9, 9), None).flags.is_empty());
    }

    #[test]
    fn the_budget_flags_at_eighty_percent_and_when_hit() {
        assert_eq!(BUDGET_WARN_PCT, 80);
        // A US$5.00 cap is 5,000,000 micro-dollars.
        let one = |cost| vec![with_cost(row(at("2026-11-11T09:00:00Z"), "b", None), cost)];
        let none = view_of(&one(3_999_999), Some(500));
        assert_eq!(none.budget.as_ref().unwrap().percent, 79);
        assert!(none.flags.is_empty());

        let warn = view_of(&one(4_100_000), Some(500));
        assert_eq!(rules(&warn), [SpikeRule::BudgetWarn]);
        assert_eq!(
            warn.flags[0].message,
            "Today's AI spend is US$4.10, 82% of the US$5.00 daily budget."
        );
        assert_eq!((warn.flags[0].value, warn.flags[0].threshold), (82, 80));

        let mut rows = one(5_000_000);
        rows.extend((0..3).map(|i| {
            with_outcome(
                with_cost(row(at("2026-11-11T14:00:00Z"), &format!("r{i}"), None), 0),
                "refused_budget",
            )
        }));
        let hit = view_of(&rows, Some(500));
        assert_eq!(rules(&hit), [SpikeRule::BudgetHit]);
        let b = hit.budget.as_ref().unwrap();
        assert_eq!((b.percent, b.refused_today), (100, 3));
        assert_eq!(b.reached_at.as_deref(), Some("2026-11-11T09:00:00Z"));
        assert_eq!(
            hit.flags[0].message,
            "The daily AI budget of US$5.00 was reached at 09:00 UTC. Model calls are refused \
             until 00:00 UTC; 3 asks refused so far."
        );

        // Yesterday's spend isn't today's, and no cap means no budget and no flag.
        let old = vec![with_cost(
            row(at("2026-11-10T09:00:00Z"), "b", None),
            9_000_000,
        )];
        assert_eq!(view_of(&old, Some(500)).budget.unwrap().spent_micro_usd, 0);
        let uncapped = view_of(&one(9_000_000), None);
        assert!(uncapped.budget.is_none() && uncapped.flags.is_empty());
    }

    #[test]
    fn overseers_are_left_out_of_flags_medians_and_top_lists() {
        let mut rows = by_business(40, at("2026-11-11T09:00:00Z"), "b1");
        for r in &mut rows {
            r.is_overseer = true;
            r.user_id = Some("olive".into());
        }
        let view = view_of(&rows, None);
        assert!(
            view.flags.is_empty() && view.top_businesses.is_empty() && view.top_users.is_empty()
        );
        // The series still shows them, split out.
        let today = view.series.last().unwrap();
        assert_eq!(
            (
                today.asks,
                today.overseer_asks,
                today.overseer_cost_micro_usd
            ),
            (40, 40, 12_000)
        );
        assert!(today.by_plan.is_empty(), "plans leave overseers out");
    }

    #[test]
    fn the_series_has_every_bucket_oldest_first() {
        let rows = vec![
            row(at("2026-11-11T15:10:00Z"), "b1", Some("u1")),
            with_outcome(row(at("2026-11-11T15:20:00Z"), "b1", Some("u1")), "error"),
            row(at("2026-11-11T02:00:00Z"), "b2", None),
            row(at("2026-08-14T02:00:00Z"), "b2", None),
        ];
        let hourly = build(&Inputs {
            by: SeriesBy::Hour,
            now: now(),
            rows: &rows,
            codings: &[],
            layers: &[],
            names: &Names::default(),
            budget_cap_cents: None,
        });
        assert_eq!(hourly.series.len(), 48);
        assert_eq!(hourly.series[0].start, "2026-11-09T16:00:00Z");
        let last = hourly.series.last().unwrap();
        assert_eq!(last.start, "2026-11-11T15:00:00Z");
        assert_eq!(
            (
                last.asks,
                last.input_tokens,
                last.output_tokens,
                last.cost_micro_usd
            ),
            (2, 200, 40, 600)
        );
        assert_eq!(
            last.by_kind,
            [KindCount {
                kind: AiKind::Explain,
                asks: 2,
                cost_micro_usd: 600
            }]
        );
        assert_eq!(
            last.by_outcome
                .iter()
                .map(|o| (o.outcome, o.asks))
                .collect::<Vec<_>>(),
            [(AiOutcome::Ok, 1), (AiOutcome::Error, 1)]
        );
        assert_eq!(
            last.by_plan,
            [PlanCount {
                plan: Plan::Free,
                asks: 2,
                cost_micro_usd: 600
            }]
        );
        assert_eq!(
            hourly.series.iter().map(|b| b.asks).sum::<u32>(),
            3,
            "the August ask is out of range"
        );

        let daily = view_of(&rows, None);
        assert_eq!(daily.series.len(), 90);
        assert_eq!(daily.series[0].start, "2026-08-14T00:00:00Z");
        assert_eq!(daily.series[0].asks, 1);
        assert_eq!(daily.series[89].start, "2026-11-11T00:00:00Z");
        assert_eq!(daily.series[89].asks, 3);
        assert!(
            daily.series[1].by_kind.is_empty(),
            "an empty bucket lists nothing"
        );
        assert!(daily.prices_known);
        let mut unpriced = rows.clone();
        unpriced[0].cost_micro_usd = None;
        assert!(!view_of(&unpriced, None).prices_known);
    }

    #[test]
    fn the_top_lists_are_ordered_capped_and_named() {
        let midnight = at("2026-11-11T00:00:00Z");
        let mut rows = Vec::new();
        // Twelve businesses with 1 to 12 asks (all under the floor except the last two), each in
        // its own hour so the platform's hours stay quiet.
        for n in 1..=12 {
            rows.extend(by_business(
                n,
                midnight + Duration::hours(i64::from(n)),
                &format!("biz{n:02}"),
            ));
        }
        let mut names = Names::default();
        names
            .businesses
            .insert("biz12".into(), "Marsh Hollow Candles".into());
        let view = build(&Inputs {
            now: now(),
            by: SeriesBy::Day,
            rows: &rows,
            codings: &[],
            layers: &[],
            names: &names,
            budget_cap_cents: None,
        });
        assert_eq!(view.top_businesses.len(), TOP_N);
        assert_eq!(view.top_businesses[0].id, "biz12");
        assert_eq!(view.top_businesses[0].name, "Marsh Hollow Candles");
        assert_eq!(view.top_businesses[9].id, "biz03");
        assert_eq!(view.top_businesses[1].name, "A removed business");
        // Two are over the floor of 10; the flag names the business.
        assert_eq!(rules(&view), [SpikeRule::Business, SpikeRule::Business]);
        assert!(
            view.flags[0]
                .message
                .starts_with("Marsh Hollow Candles made 12 AI asks today.")
        );
    }

    #[test]
    fn the_ai_share_is_lines_accepted_from_a_prefill_over_lines_coded() {
        let coding = |when: &str, codings, via| CodingEvent {
            at: at(when),
            codings,
            via_suggestion: via,
        };
        let codings = [
            coding("2026-11-09T00:00:00Z", 10, 4),
            coding("2026-11-15T23:59:59Z", 5, 5),
            // The week before.
            coding("2026-11-08T23:59:59Z", 3, 1),
            // A command can't have accepted more pre-fills than it coded lines.
            coding("2026-11-03T10:00:00Z", 2, 9),
            // Out of range: before the 26 weeks begin.
            coding("2026-05-01T10:00:00Z", 100, 100),
        ];
        let run = |when: &str, total, rules, history, merchants, model| LayerRow {
            at: at(when),
            lines_total: total,
            by_rules: rules,
            by_history: history,
            by_merchants: merchants,
            by_model: model,
        };
        let layers = [
            run("2026-11-10T10:00:00Z", 10, 2, 1, 1, 3),
            run("2026-11-11T10:00:00Z", 10, 0, 2, 1, 2),
            // Three cards, one answered by rules: 3333 bp and the rest in "unanswered".
            run("2026-11-03T10:00:00Z", 3, 1, 0, 0, 0),
        ];
        let view = build(&Inputs {
            now: now(),
            by: SeriesBy::Day,
            rows: &[],
            codings: &codings,
            layers: &layers,
            names: &Names::default(),
            budget_cap_cents: None,
        });
        assert_eq!(view.share.len(), 26);
        let this = view.share.last().unwrap();
        assert_eq!(
            (this.week_start.as_str(), this.iso_week.as_str()),
            ("2026-11-09", "2026-W46")
        );
        assert_eq!(
            (this.codings, this.via_suggestion, this.share_bp),
            (15, 9, Some(6000))
        );
        let l = this.layers.as_ref().unwrap();
        assert_eq!(
            (
                l.lines_total,
                l.rules_bp,
                l.history_bp,
                l.merchants_bp,
                l.model_bp,
                l.unanswered_bp
            ),
            (20, 1000, 1500, 1000, 2500, 4000)
        );
        let before = &view.share[24];
        assert_eq!(before.week_start, "2026-11-02");
        assert_eq!(
            (before.codings, before.via_suggestion, before.share_bp),
            (5, 3, Some(6000))
        );
        let l = before.layers.as_ref().unwrap();
        assert_eq!((l.rules_bp, l.unanswered_bp), (3333, 6667));
        assert_eq!(
            l.rules_bp + l.history_bp + l.merchants_bp + l.model_bp + l.unanswered_bp,
            10_000
        );
        // Earlier weeks had no coding and no run: nothing to share, and "not measured".
        let first = &view.share[0];
        assert_eq!(
            (first.week_start.as_str(), first.codings, first.share_bp),
            ("2026-05-18", 0, None)
        );
        assert!(first.layers.is_none());
    }

    #[test]
    fn the_ask_list_window_defaults_to_a_week_and_never_exceeds_ninety_days() {
        let q = |from: Option<&str>, to: Option<&str>| AiUsageQuery {
            from: from.map(str::to_owned),
            to: to.map(str::to_owned),
            ..AiUsageQuery::default()
        };
        let (from, to) = ask_window(&q(None, None), now()).unwrap();
        assert_eq!(to - from, Duration::days(ASK_LIST_DEFAULT_DAYS));
        let (from, to) = ask_window(
            &q(Some("2020-01-01T00:00:00Z"), Some("2026-11-11T00:00:00Z")),
            now(),
        )
        .unwrap();
        assert_eq!(to - from, Duration::days(ASK_LIST_MAX_DAYS));
        assert!(
            ask_window(
                &q(Some("2026-11-11T00:00:00Z"), Some("2026-11-10T00:00:00Z")),
                now()
            )
            .is_err()
        );
        assert!(ask_window(&q(Some("yesterday"), None), now()).is_err());
    }

    #[test]
    fn money_in_the_sentences_is_whole_cents_in_us_dollars() {
        assert_eq!(usd(4_100_000), "US$4.10");
        assert_eq!(usd(5_000_000), "US$5.00");
        assert_eq!(usd(12_345_678), "US$12.34");
        assert_eq!(usd(9_999), "US$0.00");
    }

    #[test]
    fn the_enums_spell_what_the_table_stores() {
        for k in AiKind::ALL {
            assert_eq!(AiKind::parse(k.as_str()), Some(k));
            assert_eq!(
                serde_json::to_value(k).unwrap(),
                serde_json::json!(k.as_str())
            );
        }
        for o in AiOutcome::ALL {
            assert_eq!(AiOutcome::parse(o.as_str()), Some(o));
            assert_eq!(
                serde_json::to_value(o).unwrap(),
                serde_json::json!(o.as_str())
            );
        }
        assert_eq!(AiKind::parse("invoice_read"), None);
        assert!(AiOutcome::RefusedBudget.is_refusal() && !AiOutcome::Error.is_refusal());
    }
}
