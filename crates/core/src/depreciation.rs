//! Accounting depreciation: methods, conventions, per-year charges, disposal journals and the
//! fixed asset schedule.
//!
//! The rules are in `docs/domain.md` under "Depreciation". In short:
//! - a year's charge is an annual amount times a fraction of a year: months in the client-year ÷ 12
//!   for a year the asset is held throughout, and the part-year or disposal-year convention
//!   otherwise;
//! - DV charges rate × book value at the start of the year (which is cost in the year of
//!   acquisition), SL charges rate × (cost − residual) or (cost − residual) × 12 ÷ life months, and
//!   neither goes below nil (DV) or the residual (SL);
//! - each charge is computed exactly in i128 and rounded once to cents, half away from zero.

use std::collections::BTreeMap;

use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

use crate::chart::AccountCode;
use crate::ledger::{ClientYear, Journal, JournalLine, TrialBalance};
use crate::money::Money;

/// Rates are basis points a year: 12.5% = 1250. At most 100%.
pub const MAX_RATE_BP: u32 = 10_000;
/// Useful lives are whole months, at most 100 years.
pub const MAX_LIFE_MONTHS: u32 = 1_200;

/// How an asset is depreciated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Method {
    /// Diminishing value: rate × book value at the start of the year.
    Dv { rate_bp: u32 },
    /// Straight line: on cost less residual, stopping at the residual.
    Sl { basis: SlBasis },
    /// Not depreciated.
    None,
}

/// What a straight-line charge is based on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum SlBasis {
    /// A rate a year on cost less residual.
    Rate { rate_bp: u32 },
    /// A useful life: (cost − residual) × 12 ÷ months a year.
    Life { months: u32 },
}

/// How the year of acquisition is prorated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(tag = "kind", rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum PartYear {
    /// Whole calendar months held ÷ 12. The acquisition month (and the disposal month, under
    /// `ToDisposalDate`) counts only if `count_acquisition_month` is set.
    MonthsHeld { count_acquisition_month: bool },
    /// Days held ÷ 365, or ÷ 366 when the client-year contains a 29 February.
    Daily,
    /// A full year's charge.
    FullYear,
}

/// How the year of disposal is treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum DisposalYear {
    /// No depreciation in the year of disposal.
    None,
    /// Depreciation to the disposal date, prorated with the part-year convention.
    ToDisposalDate,
}

/// A method with its conventions: what an asset class sets as a default and what an asset
/// carries once created.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct DepreciationSettings {
    pub method: Method,
    pub part_year: PartYear,
    pub disposal_year: DisposalYear,
}

/// Where an asset's settings came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum RateSource {
    Practice,
    Client,
    Custom,
}

/// The accounts an asset's journals post to. Copied from its class when it's created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssetAccounts {
    pub cost: AccountCode,
    pub accumulated: AccountCode,
    pub expense: AccountCode,
    pub gain_loss: AccountCode,
}

/// Accumulated depreciation brought forward at the start of a client-year, for an asset acquired
/// before the register's first year.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OpeningBalance {
    /// The start of the client-year the register begins tracking the asset.
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub accumulated: Money,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Disposal {
    #[ts(type = "string")]
    pub date: NaiveDate,
    pub proceeds: Money,
    /// The account debited with the proceeds.
    pub proceeds_account: AccountCode,
}

/// An asset as depreciation sees it. Ids and names belong to the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
    pub cost: Money,
    /// Only straight line uses the residual.
    pub residual: Money,
    pub acquired: NaiveDate,
    pub settings: DepreciationSettings,
    pub opening: Option<OpeningBalance>,
    pub disposal: Option<Disposal>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Error, TS)]
#[serde(tag = "code", rename_all = "snake_case")]
#[ts(export)]
pub enum AssetError {
    #[error("the rate must be between 0.01% and 100%")]
    BadRate { rate_bp: u32 },
    #[error("the useful life must be between 1 and {MAX_LIFE_MONTHS} months")]
    BadLife { months: u32 },
    #[error("cost must be more than nil")]
    CostNotPositive,
    #[error("the residual value must be between nil and cost")]
    BadResidual,
    #[error("the disposal date is before the acquisition date")]
    DisposedBeforeAcquired,
    #[error("disposal proceeds can't be negative")]
    NegativeProceeds,
    #[error("accumulated depreciation brought forward must be between nil and cost")]
    BadOpeningAccumulated,
    #[error("the brought-forward date must be after the acquisition date")]
    OpeningNotAfterAcquired,
    #[error("the asset was acquired before the first year, so it needs a brought-forward balance")]
    NeedsOpeningBalance,
    #[error("the brought-forward date {date} isn't the start of a client-year")]
    OpeningNotYearStart {
        #[ts(type = "string")]
        date: NaiveDate,
    },
}

impl Method {
    pub fn validate(&self) -> Result<(), AssetError> {
        let rate_ok = |rate_bp: u32| {
            if (1..=MAX_RATE_BP).contains(&rate_bp) {
                Ok(())
            } else {
                Err(AssetError::BadRate { rate_bp })
            }
        };
        match *self {
            Method::Dv { rate_bp } => rate_ok(rate_bp),
            Method::Sl {
                basis: SlBasis::Rate { rate_bp },
            } => rate_ok(rate_bp),
            Method::Sl {
                basis: SlBasis::Life { months },
            } => {
                if (1..=MAX_LIFE_MONTHS).contains(&months) {
                    Ok(())
                } else {
                    Err(AssetError::BadLife { months })
                }
            }
            Method::None => Ok(()),
        }
    }
}

impl Asset {
    /// Checks the asset on its own. Whether its brought-forward date fits the client's years is
    /// checked by [`asset_years`].
    pub fn validate(&self) -> Result<(), Vec<AssetError>> {
        let mut errors = Vec::new();
        if let Err(e) = self.settings.method.validate() {
            errors.push(e);
        }
        if self.cost <= Money::ZERO {
            errors.push(AssetError::CostNotPositive);
        }
        if self.residual < Money::ZERO || self.residual > self.cost {
            errors.push(AssetError::BadResidual);
        }
        if let Some(d) = &self.disposal {
            if d.date < self.acquired {
                errors.push(AssetError::DisposedBeforeAcquired);
            }
            if d.proceeds < Money::ZERO {
                errors.push(AssetError::NegativeProceeds);
            }
        }
        if let Some(o) = &self.opening {
            if o.accumulated < Money::ZERO || o.accumulated > self.cost {
                errors.push(AssetError::BadOpeningAccumulated);
            }
            if o.date <= self.acquired {
                errors.push(AssetError::OpeningNotAfterAcquired);
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors)
        }
    }

    fn disposed_in(&self, year: &ClientYear) -> Option<&Disposal> {
        self.disposal.as_ref().filter(|d| year.contains(d.date))
    }

    /// The charge for one year, given accumulated depreciation at its start and, for a life-based
    /// SL asset, how much of its life (in [`UNITS_PER_YEAR`]ths of a year) was used before it.
    /// Returns the charge and the life used this year. Nil for a year the asset isn't held in.
    fn charge(
        &self,
        year: &ClientYear,
        opening_accumulated: Money,
        life_used: i128,
    ) -> (Money, i128) {
        let units = self.held_units(year);
        let cost = i128::from(self.cost.cents());
        let book_value = cost - i128::from(opening_accumulated.cents());
        let bp = i128::from(MAX_RATE_BP);
        let (charge, floor) = match self.settings.method {
            Method::None => (0, 0),
            Method::Dv { rate_bp } => (
                div_round_half_away(
                    book_value * i128::from(rate_bp) * units,
                    bp * UNITS_PER_YEAR,
                ),
                0,
            ),
            Method::Sl { basis } => {
                let residual = i128::from(self.residual.cents());
                let base = cost - residual;
                let charge = match basis {
                    SlBasis::Rate { rate_bp } => {
                        div_round_half_away(base * i128::from(rate_bp) * units, bp * UNITS_PER_YEAR)
                    }
                    SlBasis::Life { months } => {
                        let life = i128::from(months) * UNITS_PER_MONTH;
                        if units > 0 && life_used + units >= life {
                            // The life ends this year: write off what's left, so no cent is
                            // left over from rounding the earlier years.
                            book_value - residual
                        } else {
                            div_round_half_away(base * units, life)
                        }
                    }
                };
                (charge, residual)
            }
        };
        let charge = charge.clamp(0, (book_value - floor).max(0));
        let charge = Money::from_cents(i64::try_from(charge).expect("a charge never exceeds cost"));
        (charge, units)
    }

    /// How much of a year's charge falls in `year`, in [`UNITS_PER_YEAR`]ths of a year.
    fn held_units(&self, year: &ClientYear) -> i128 {
        if self.acquired > year.end() {
            return 0;
        }
        if let Some(d) = &self.disposal
            && d.date < year.start()
        {
            return 0;
        }
        let acquired = year.contains(self.acquired).then_some(self.acquired);
        let disposed = self.disposed_in(year).map(|d| d.date);
        if disposed.is_some() && self.settings.disposal_year == DisposalYear::None {
            return 0;
        }
        let whole_months = month_index(year.end()) - month_index(year.start()) + 1;
        if acquired.is_none() && disposed.is_none() {
            return whole_months * UNITS_PER_MONTH;
        }
        match self.settings.part_year {
            PartYear::FullYear => whole_months * UNITS_PER_MONTH,
            PartYear::MonthsHeld {
                count_acquisition_month: count,
            } => {
                let skip = i128::from(!count);
                let from = acquired.map_or(month_index(year.start()), |d| month_index(d) + skip);
                let to = disposed.map_or(month_index(year.end()), |d| month_index(d) - skip);
                (to - from + 1).max(0) * UNITS_PER_MONTH
            }
            PartYear::Daily => {
                let from = acquired.unwrap_or(year.start());
                let to = disposed.unwrap_or(year.end());
                let days = i128::from((to - from).num_days() + 1).max(0);
                let per_day = UNITS_PER_YEAR / if contains_leap_day(year) { 366 } else { 365 };
                days * per_day
            }
        }
    }

    /// Life used before a brought-forward date, for a life-based SL asset. The earlier years
    /// aren't in the register, so this counts whole months (or days, under `Daily`) from
    /// acquisition as if they had been 12-month years.
    fn life_used_before(&self, date: NaiveDate) -> i128 {
        match self.settings.part_year {
            PartYear::Daily => {
                i128::from((date - self.acquired).num_days()).max(0) * (UNITS_PER_YEAR / 365)
            }
            PartYear::MonthsHeld {
                count_acquisition_month: false,
            } => (month_index(date) - month_index(self.acquired) - 1).max(0) * UNITS_PER_MONTH,
            _ => (month_index(date) - month_index(self.acquired)).max(0) * UNITS_PER_MONTH,
        }
    }
}

/// Fractions of a year are counted in units of 1/267,180 of a year, the least common multiple of
/// 12, 365 and 366, so months and days are both exact.
const UNITS_PER_YEAR: i128 = 267_180;
const UNITS_PER_MONTH: i128 = UNITS_PER_YEAR / 12;

fn month_index(d: NaiveDate) -> i128 {
    i128::from(d.year()) * 12 + i128::from(d.month0())
}

fn contains_leap_day(year: &ClientYear) -> bool {
    (year.start().year()..=year.end().year())
        .any(|y| NaiveDate::from_ymd_opt(y, 2, 29).is_some_and(|d| year.contains(d)))
}

/// `n ÷ d` rounded half away from zero. `d` must be positive.
fn div_round_half_away(n: i128, d: i128) -> i128 {
    debug_assert!(d > 0);
    let q = n / d;
    let r = n % d;
    if r.abs() * 2 >= d { q + n.signum() } else { q }
}

/// One asset's movements in one client-year, in cents. Accumulated depreciation is positive.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssetYear {
    pub opening_cost: Money,
    pub additions: Money,
    pub disposals: Money,
    pub closing_cost: Money,
    pub opening_accumulated: Money,
    pub depreciation: Money,
    pub disposal_accumulated: Money,
    pub closing_accumulated: Money,
    /// Proceeds less book value at disposal; only in the year of disposal.
    pub gain: Option<Money>,
}

impl AssetYear {
    pub fn closing_book_value(&self) -> Money {
        self.closing_cost - self.closing_accumulated
    }

    fn add(&mut self, o: &AssetYear) {
        self.opening_cost += o.opening_cost;
        self.additions += o.additions;
        self.disposals += o.disposals;
        self.closing_cost += o.closing_cost;
        self.opening_accumulated += o.opening_accumulated;
        self.depreciation += o.depreciation;
        self.disposal_accumulated += o.disposal_accumulated;
        self.closing_accumulated += o.closing_accumulated;
        self.gain = match (self.gain, o.gain) {
            (None, None) => None,
            (a, b) => Some(a.unwrap_or_default() + b.unwrap_or_default()),
        };
    }
}

/// An asset's movements in each of the client's years, oldest first. `years` must be the
/// client's years in order. `locked` gives charges that can't change (a finalised year's, by the
/// year's start date); they're used as they are instead of recomputed, so a change of method or
/// rate only applies from the first open year.
pub fn asset_years(
    asset: &Asset,
    years: &[ClientYear],
    locked: &BTreeMap<NaiveDate, Money>,
) -> Result<Vec<AssetYear>, AssetError> {
    // Where tracking starts: the year of acquisition, or the brought-forward year.
    let start = match &asset.opening {
        Some(o) => match years.iter().position(|y| y.start() == o.date) {
            Some(i) => Some((i, o.accumulated)),
            None => return Err(AssetError::OpeningNotYearStart { date: o.date }),
        },
        None => {
            if years.first().is_some_and(|y| asset.acquired < y.start()) {
                return Err(AssetError::NeedsOpeningBalance);
            }
            years
                .iter()
                .position(|y| y.contains(asset.acquired))
                .map(|i| (i, Money::ZERO))
        }
    };
    let mut out = vec![AssetYear::default(); years.len()];
    let Some((first, mut accumulated)) = start else {
        return Ok(out);
    };
    let mut held = false;
    let mut life_used = asset.opening.map_or(0, |o| asset.life_used_before(o.date));
    for (i, year) in years.iter().enumerate().skip(first) {
        if asset
            .disposal
            .as_ref()
            .is_some_and(|d| d.date < year.start())
        {
            break;
        }
        let row = &mut out[i];
        if held || asset.opening.is_some() && i == first {
            row.opening_cost = asset.cost;
            row.opening_accumulated = accumulated;
        } else {
            row.additions = asset.cost;
        }
        held = true;
        let (computed, units) = asset.charge(year, accumulated, life_used);
        life_used += units;
        let charge = locked.get(&year.start()).copied().unwrap_or(computed);
        row.depreciation = charge;
        accumulated += charge;
        if let Some(d) = asset.disposed_in(year) {
            row.disposals = asset.cost;
            row.disposal_accumulated = accumulated;
            row.gain = Some(d.proceeds - (asset.cost - accumulated));
            break;
        }
        row.closing_cost = asset.cost;
        row.closing_accumulated = accumulated;
    }
    Ok(out)
}

/// An asset in the register, with what its journals and the schedule need.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegisterAsset {
    pub name: String,
    /// The asset class's code, which groups the schedule.
    pub class: String,
    pub accounts: AssetAccounts,
    pub asset: Asset,
}

/// The journals the register posts for one year.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct YearJournals {
    /// Dated at year end; `None` when nothing is charged.
    pub depreciation: Option<Journal>,
    /// One per asset disposed of in the year, in date then register order.
    pub disposals: Vec<Journal>,
}

impl YearJournals {
    /// Every journal, the depreciation journal first.
    pub fn all(&self) -> impl Iterator<Item = &Journal> {
        self.depreciation.iter().chain(&self.disposals)
    }
}

/// The depreciation and disposal journals for `year`. `rows` are each asset's movements in
/// `year`, parallel to `assets`.
pub fn year_journals(
    year: &ClientYear,
    assets: &[RegisterAsset],
    rows: &[AssetYear],
) -> YearJournals {
    let mut depreciation: BTreeMap<AccountCode, Money> = BTreeMap::new();
    let mut disposals = Vec::new();
    for (a, row) in assets.iter().zip(rows) {
        if !row.depreciation.is_zero() {
            *depreciation.entry(a.accounts.expense.clone()).or_default() += row.depreciation;
            *depreciation
                .entry(a.accounts.accumulated.clone())
                .or_default() -= row.depreciation;
        }
        if let (Some(d), Some(gain)) = (a.asset.disposed_in(year), row.gain) {
            let mut lines: BTreeMap<AccountCode, Money> = BTreeMap::new();
            *lines.entry(d.proceeds_account.clone()).or_default() += d.proceeds;
            *lines.entry(a.accounts.accumulated.clone()).or_default() += row.disposal_accumulated;
            *lines.entry(a.accounts.cost.clone()).or_default() -= row.disposals;
            *lines.entry(a.accounts.gain_loss.clone()).or_default() -= gain;
            if let Some(j) = journal(d.date, format!("Disposal of {}", a.name), lines) {
                disposals.push(j);
            }
        }
    }
    disposals.sort_by_key(|j| j.date);
    YearJournals {
        depreciation: journal(
            year.end(),
            "Depreciation for the year".to_owned(),
            depreciation,
        ),
        disposals,
    }
}

fn journal(
    date: NaiveDate,
    narration: String,
    lines: BTreeMap<AccountCode, Money>,
) -> Option<Journal> {
    let lines: Vec<JournalLine> = lines
        .into_iter()
        .filter(|(_, amount)| !amount.is_zero())
        .map(|(account, amount)| JournalLine { account, amount })
        .collect();
    (lines.len() >= 2).then_some(Journal {
        date,
        narration,
        lines,
    })
}

/// The register against the ledger for one account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReconciliationLine {
    pub account: AccountCode,
    /// What the register says the balance should be (debit positive).
    pub register: Money,
    pub ledger: Money,
}

impl ReconciliationLine {
    pub fn difference(&self) -> Money {
        self.ledger - self.register
    }
}

/// Compares the register's closing cost and accumulated depreciation with the linked ledger
/// accounts at the end of the year. One line per account, in code order.
pub fn reconcile(
    assets: &[RegisterAsset],
    rows: &[AssetYear],
    tb: &TrialBalance,
) -> Vec<ReconciliationLine> {
    let mut register: BTreeMap<AccountCode, Money> = BTreeMap::new();
    for (a, row) in assets.iter().zip(rows) {
        *register.entry(a.accounts.cost.clone()).or_default() += row.closing_cost;
        *register.entry(a.accounts.accumulated.clone()).or_default() -= row.closing_accumulated;
    }
    register
        .into_iter()
        .map(|(account, register)| ReconciliationLine {
            ledger: tb.balance(&account),
            account,
            register,
        })
        .collect()
}

/// An asset class as the schedule names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScheduleClass {
    pub code: String,
    pub name: String,
}

/// The fixed asset schedule: one block per class, then a total block. Whole dollars.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct AssetSchedule {
    pub title: String,
    pub blocks: Vec<ScheduleBlock>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScheduleBlock {
    /// The class's code, or `None` for the total block.
    pub class: Option<String>,
    pub title: String,
    pub rows: Vec<ScheduleRow>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ScheduleRowKey {
    OpeningCost,
    Additions,
    Disposals,
    ClosingCost,
    OpeningAccumulated,
    Depreciation,
    DisposalAccumulated,
    ClosingAccumulated,
    BookValue,
    Gain,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum ScheduleRowStyle {
    Line,
    Total,
}

/// Disposals and depreciation on disposals are negative, so each part foots downwards.
/// A loss on disposal is negative.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ScheduleRow {
    pub key: ScheduleRowKey,
    pub style: ScheduleRowStyle,
    pub label: String,
    pub current: Option<i64>,
    pub prior: Option<i64>,
}

const SCHEDULE_ROWS: [(ScheduleRowKey, ScheduleRowStyle, &str); 10] = [
    (
        ScheduleRowKey::OpeningCost,
        ScheduleRowStyle::Line,
        "Cost at the start of the year",
    ),
    (
        ScheduleRowKey::Additions,
        ScheduleRowStyle::Line,
        "Additions",
    ),
    (
        ScheduleRowKey::Disposals,
        ScheduleRowStyle::Line,
        "Disposals",
    ),
    (
        ScheduleRowKey::ClosingCost,
        ScheduleRowStyle::Total,
        "Cost at the end of the year",
    ),
    (
        ScheduleRowKey::OpeningAccumulated,
        ScheduleRowStyle::Line,
        "Accumulated depreciation at the start of the year",
    ),
    (
        ScheduleRowKey::Depreciation,
        ScheduleRowStyle::Line,
        "Depreciation for the year",
    ),
    (
        ScheduleRowKey::DisposalAccumulated,
        ScheduleRowStyle::Line,
        "Depreciation on disposals",
    ),
    (
        ScheduleRowKey::ClosingAccumulated,
        ScheduleRowStyle::Total,
        "Accumulated depreciation at the end of the year",
    ),
    (
        ScheduleRowKey::BookValue,
        ScheduleRowStyle::Total,
        "Book value at the end of the year",
    ),
    (
        ScheduleRowKey::Gain,
        ScheduleRowStyle::Line,
        "Gain (loss) on disposal",
    ),
];

/// Whole-dollar figures for one block and column, footing as `docs/domain.md` describes: book
/// value and accumulated depreciation are their exact amounts rounded, cost is their sum, and a
/// movement absorbs what's left.
fn rounded_block(y: &AssetYear) -> [i64; 10] {
    let r = |m: Money| m.round_to_dollars();
    let foot = |opening: i64, first: Money, second: Money, closing: i64| -> (i64, i64) {
        // Closing = opening + first − second. Rounding goes to `first` unless it's nil.
        if !first.is_zero() || second.is_zero() {
            let s = r(second);
            (closing - opening + s, s)
        } else {
            (0, opening - closing)
        }
    };
    let (oa, ca) = (r(y.opening_accumulated), r(y.closing_accumulated));
    let oc = r(y.opening_cost - y.opening_accumulated) + oa;
    let cc = r(y.closing_book_value()) + ca;
    let (additions, disposals) = foot(oc, y.additions, y.disposals, cc);
    let (depreciation, disposal_accumulated) = foot(oa, y.depreciation, y.disposal_accumulated, ca);
    [
        oc,
        additions,
        -disposals,
        cc,
        oa,
        depreciation,
        -disposal_accumulated,
        ca,
        cc - ca,
        y.gain.map_or(0, r),
    ]
}

/// Builds the schedule from each asset's movements. `current` and `prior` are parallel to
/// `assets`; `prior` is `None` when there's no prior year. Classes are shown in the order given,
/// and a class with nothing in either column is left out.
pub fn build_asset_schedule(
    classes: &[ScheduleClass],
    assets: &[RegisterAsset],
    current: &[AssetYear],
    prior: Option<&[AssetYear]>,
) -> AssetSchedule {
    let sum = |rows: &[AssetYear], class: Option<&str>| {
        let mut total = AssetYear::default();
        for (a, row) in assets.iter().zip(rows) {
            if class.is_none_or(|c| a.class == c) {
                total.add(row);
            }
        }
        total
    };
    let block = |class: Option<&ScheduleClass>| -> Option<ScheduleBlock> {
        let code = class.map(|c| c.code.as_str());
        let cur = sum(current, code);
        let pri = prior.map(|p| sum(p, code));
        let empty = |y: &AssetYear| *y == AssetYear::default();
        if class.is_some() && empty(&cur) && pri.as_ref().is_none_or(empty) {
            return None;
        }
        let cur = rounded_block(&cur);
        let pri = pri.as_ref().map(rounded_block);
        let rows = SCHEDULE_ROWS
            .iter()
            .enumerate()
            .map(|(i, &(key, style, label))| ScheduleRow {
                key,
                style,
                label: label.to_owned(),
                current: Some(cur[i]),
                prior: pri.map(|p| p[i]),
            })
            .collect();
        Some(ScheduleBlock {
            class: code.map(str::to_owned),
            title: class.map_or_else(|| "Total".to_owned(), |c| c.name.clone()),
            rows,
        })
    };
    let blocks = classes
        .iter()
        .filter_map(|c| block(Some(c)))
        .chain(block(None))
        .collect();
    AssetSchedule {
        title: "Property, plant and equipment".to_owned(),
        blocks,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(y: i32, m: u32, day: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(y, m, day).unwrap()
    }

    fn year(start: NaiveDate, end: NaiveDate) -> ClientYear {
        ClientYear::new(start, end).unwrap()
    }

    fn march_year(end_year: i32) -> ClientYear {
        year(d(end_year - 1, 4, 1), d(end_year, 3, 31))
    }

    fn asset(method: Method, part_year: PartYear) -> Asset {
        Asset {
            cost: Money::from_cents(1_000_000),
            residual: Money::ZERO,
            acquired: d(2024, 9, 15),
            settings: DepreciationSettings {
                method,
                part_year,
                disposal_year: DisposalYear::ToDisposalDate,
            },
            opening: None,
            disposal: None,
        }
    }

    fn charge(a: &Asset, year: &ClientYear, opening_accumulated: Money) -> Money {
        a.charge(year, opening_accumulated, 0).0
    }

    const MONTHS: PartYear = PartYear::MonthsHeld {
        count_acquisition_month: true,
    };

    #[test]
    fn dv_months_held_counting_the_acquisition_month() {
        // $10,000 at 20% DV, bought 15 Sep 2024: Sep..Mar is 7 months. 10,000 × 20% × 7/12.
        let a = asset(Method::Dv { rate_bp: 2000 }, MONTHS);
        assert_eq!(
            charge(&a, &march_year(2025), Money::ZERO),
            Money::from_cents(116_667)
        );
        // The next year: 20% of 8,833.33.
        let c = charge(&a, &march_year(2026), Money::from_cents(116_667));
        assert_eq!(c, Money::from_cents(176_667));
    }

    #[test]
    fn months_held_without_the_acquisition_month() {
        let a = asset(
            Method::Dv { rate_bp: 2000 },
            PartYear::MonthsHeld {
                count_acquisition_month: false,
            },
        );
        // Oct..Mar: 6 months. 10,000 × 20% × 6/12 = 1,000.
        assert_eq!(
            charge(&a, &march_year(2025), Money::ZERO),
            Money::from_cents(100_000)
        );
    }

    #[test]
    fn daily_uses_365_or_366() {
        let a = asset(Method::Dv { rate_bp: 2000 }, PartYear::Daily);
        // 15 Sep 2024 to 31 Mar 2025 is 198 days; no 29 Feb in that year. 2,000 × 198/365.
        assert_eq!(
            charge(&a, &march_year(2025), Money::ZERO),
            Money::from_cents(108_493)
        );
        // FY2024 (Apr 2023 to Mar 2024) contains 29 Feb 2024: 199 days. 2,000 × 199/366.
        let mut b = a.clone();
        b.acquired = d(2023, 9, 15);
        assert_eq!(
            charge(&b, &march_year(2024), Money::ZERO),
            Money::from_cents(108_743)
        );
    }

    #[test]
    fn full_year_and_long_years() {
        let a = asset(Method::Dv { rate_bp: 2000 }, PartYear::FullYear);
        assert_eq!(
            charge(&a, &march_year(2025), Money::ZERO),
            Money::from_cents(200_000)
        );
        // A 15-month year held throughout: 15/12 of a year.
        let long = year(d(2025, 1, 1), d(2026, 3, 31));
        let mut b = a.clone();
        b.acquired = d(2024, 6, 1);
        assert_eq!(
            charge(&b, &long, Money::from_cents(200_000)),
            Money::from_cents(200_000)
        );
    }

    #[test]
    fn sl_rate_stops_at_the_residual() {
        let mut a = asset(
            Method::Sl {
                basis: SlBasis::Rate { rate_bp: 3333 },
            },
            PartYear::FullYear,
        );
        a.residual = Money::from_cents(100_000);
        // 9,000 × 33.33% = 2,999.70 a year; the fourth year takes only the 0.90 left.
        let years: Vec<ClientYear> = (2025..=2029).map(march_year).collect();
        let rows = asset_years(&a, &years, &BTreeMap::new()).unwrap();
        let charges: Vec<i64> = rows.iter().map(|r| r.depreciation.cents()).collect();
        assert_eq!(charges, [299_970, 299_970, 299_970, 90, 0]);
        assert_eq!(rows[4].closing_book_value(), Money::from_cents(100_000));
    }

    #[test]
    fn sl_life_writes_off_exactly() {
        let a = asset(
            Method::Sl {
                basis: SlBasis::Life { months: 36 },
            },
            MONTHS,
        );
        // 7 months, then 12, 12, then the 5 left.
        let years: Vec<ClientYear> = (2025..=2029).map(march_year).collect();
        let rows = asset_years(&a, &years, &BTreeMap::new()).unwrap();
        let charges: Vec<i64> = rows.iter().map(|r| r.depreciation.cents()).collect();
        assert_eq!(charges, [194_444, 333_333, 333_333, 138_890, 0]);
        assert_eq!(rows[3].closing_book_value(), Money::ZERO);
    }

    #[test]
    fn disposal_to_date_and_gain() {
        let mut a = asset(Method::Dv { rate_bp: 2000 }, MONTHS);
        a.disposal = Some(Disposal {
            date: d(2025, 6, 10),
            proceeds: Money::from_cents(850_000),
            proceeds_account: "620".parse().unwrap(),
        });
        let years = [march_year(2025), march_year(2026), march_year(2027)];
        let rows = asset_years(&a, &years, &BTreeMap::new()).unwrap();
        // FY2026: Apr..Jun is 3 months on 8,833.33 at 20%: 441.67.
        assert_eq!(rows[1].depreciation, Money::from_cents(44_167));
        assert_eq!(rows[1].disposal_accumulated, Money::from_cents(160_834));
        // Book value 8,391.66, proceeds 8,500: gain 108.34.
        assert_eq!(rows[1].gain, Some(Money::from_cents(10_834)));
        assert_eq!(rows[1].closing_cost, Money::ZERO);
        assert_eq!(rows[2], AssetYear::default());

        let mut none = a.clone();
        none.settings.disposal_year = DisposalYear::None;
        let rows = asset_years(&none, &years, &BTreeMap::new()).unwrap();
        assert_eq!(rows[1].depreciation, Money::ZERO);
        assert_eq!(rows[1].gain, Some(Money::from_cents(850_000 - 883_333)));
    }

    #[test]
    fn brought_forward_balance() {
        let mut a = asset(Method::Dv { rate_bp: 2000 }, MONTHS);
        a.acquired = d(2020, 5, 1);
        let years = [march_year(2025)];
        assert_eq!(
            asset_years(&a, &years, &BTreeMap::new()),
            Err(AssetError::NeedsOpeningBalance)
        );
        a.opening = Some(OpeningBalance {
            date: d(2024, 4, 1),
            accumulated: Money::from_cents(600_000),
        });
        let rows = asset_years(&a, &years, &BTreeMap::new()).unwrap();
        assert_eq!(rows[0].opening_cost, a.cost);
        assert_eq!(rows[0].additions, Money::ZERO);
        assert_eq!(rows[0].depreciation, Money::from_cents(80_000));
    }

    #[test]
    fn locked_years_keep_their_charge() {
        let a = asset(Method::Dv { rate_bp: 2000 }, MONTHS);
        let years = [march_year(2025), march_year(2026)];
        let locked = BTreeMap::from([(years[0].start(), Money::from_cents(100_000))]);
        let rows = asset_years(&a, &years, &locked).unwrap();
        assert_eq!(rows[0].depreciation, Money::from_cents(100_000));
        assert_eq!(rows[1].depreciation, Money::from_cents(180_000));
    }

    #[test]
    fn validation() {
        let mut a = asset(Method::Dv { rate_bp: 0 }, MONTHS);
        a.residual = Money::from_cents(-1);
        assert_eq!(
            a.validate(),
            Err(vec![
                AssetError::BadRate { rate_bp: 0 },
                AssetError::BadResidual
            ])
        );
        assert_eq!(
            Method::Sl {
                basis: SlBasis::Life { months: 0 }
            }
            .validate(),
            Err(AssetError::BadLife { months: 0 })
        );
    }

    #[test]
    fn rounding_half_away() {
        assert_eq!(div_round_half_away(5, 10), 1);
        assert_eq!(div_round_half_away(-5, 10), -1);
        assert_eq!(div_round_half_away(4, 10), 0);
        assert_eq!(div_round_half_away(15, 10), 2);
    }

    fn code(c: &str) -> AccountCode {
        c.parse().unwrap()
    }

    fn register_asset(name: &str, class: &str, asset: Asset) -> RegisterAsset {
        let (cost, acc) = if class == "plant" {
            ("700", "705")
        } else {
            ("710", "715")
        };
        RegisterAsset {
            name: name.to_owned(),
            class: class.to_owned(),
            accounts: AssetAccounts {
                cost: code(cost),
                accumulated: code(acc),
                expense: code("210"),
                gain_loss: code("120"),
            },
            asset,
        }
    }

    fn two_assets() -> (Vec<ClientYear>, Vec<RegisterAsset>) {
        let years = vec![march_year(2025), march_year(2026)];
        let lathe = asset(Method::Dv { rate_bp: 2000 }, MONTHS);
        let mut van = asset(Method::Dv { rate_bp: 3000 }, MONTHS);
        van.cost = Money::from_cents(2_000_050);
        van.acquired = d(2024, 4, 1);
        van.disposal = Some(Disposal {
            date: d(2025, 7, 31),
            proceeds: Money::from_cents(1_200_000),
            proceeds_account: code("620"),
        });
        (
            years,
            vec![
                register_asset("Lathe", "plant", lathe),
                register_asset("Van", "vehicles", van),
            ],
        )
    }

    fn rows_for(assets: &[RegisterAsset], years: &[ClientYear], i: usize) -> Vec<AssetYear> {
        assets
            .iter()
            .map(|a| asset_years(&a.asset, years, &BTreeMap::new()).unwrap()[i])
            .collect()
    }

    #[test]
    fn year_journals_post_depreciation_and_disposals() {
        let (years, assets) = two_assets();
        let rows = rows_for(&assets, &years, 1);
        let journals: Vec<Journal> = year_journals(&years[1], &assets, &rows)
            .all()
            .cloned()
            .collect();
        assert_eq!(journals.len(), 2);
        let dep = &journals[0];
        assert_eq!(dep.date, d(2026, 3, 31));
        // Lathe 1,766.67; van: 30% of 14,000.35 for Apr..Jul, 4/12: 1,400.04.
        let lines: Vec<(String, i64)> = dep
            .lines
            .iter()
            .map(|l| (l.account.to_string(), l.amount.cents()))
            .collect();
        assert_eq!(
            lines,
            [
                ("210".to_owned(), 176_667 + 140_004),
                ("705".to_owned(), -176_667),
                ("715".to_owned(), -140_004),
            ]
        );
        let disposal = &journals[1];
        assert_eq!(disposal.date, d(2025, 7, 31));
        assert_eq!(disposal.narration, "Disposal of Van");
        // Accumulated 6,000.15 + 1,400.04 = 7,400.19; book value 12,600.31; loss 600.31.
        let lines: Vec<(String, i64)> = disposal
            .lines
            .iter()
            .map(|l| (l.account.to_string(), l.amount.cents()))
            .collect();
        assert_eq!(
            lines,
            [
                ("120".to_owned(), 60_031),
                ("620".to_owned(), 1_200_000),
                ("710".to_owned(), -2_000_050),
                ("715".to_owned(), 740_019),
            ]
        );
        for j in &journals {
            assert_eq!(j.lines.iter().map(|l| l.amount).sum::<Money>(), Money::ZERO);
        }
    }

    #[test]
    fn reconcile_against_the_ledger() {
        let (years, assets) = two_assets();
        let rows = rows_for(&assets, &years, 0);
        let tb = TrialBalance::from_journals(
            &TrialBalance::default(),
            &[Journal {
                date: d(2025, 3, 31),
                narration: "x".to_owned(),
                lines: vec![
                    JournalLine {
                        account: code("700"),
                        amount: Money::from_cents(1_000_000),
                    },
                    JournalLine {
                        account: code("710"),
                        amount: Money::from_cents(2_000_000),
                    },
                    JournalLine {
                        account: code("600"),
                        amount: Money::from_cents(-3_000_000),
                    },
                ],
            }],
        );
        let rec = reconcile(&assets, &rows, &tb);
        let diffs: Vec<(String, i64)> = rec
            .iter()
            .map(|r| (r.account.to_string(), r.difference().cents()))
            .collect();
        assert_eq!(
            diffs,
            [
                ("700".to_owned(), 0),
                ("705".to_owned(), 116_667),
                ("710".to_owned(), -50),
                ("715".to_owned(), 600_015),
            ]
        );
    }

    #[test]
    fn schedule_blocks_foot_and_agree_with_the_totals() {
        let (years, assets) = two_assets();
        let classes = [
            ScheduleClass {
                code: "plant".to_owned(),
                name: "Plant and equipment".to_owned(),
            },
            ScheduleClass {
                code: "vehicles".to_owned(),
                name: "Motor vehicles".to_owned(),
            },
        ];
        let cur = rows_for(&assets, &years, 1);
        let pri = rows_for(&assets, &years, 0);
        let s = build_asset_schedule(&classes, &assets, &cur, Some(&pri));
        let titles: Vec<&str> = s.blocks.iter().map(|b| b.title.as_str()).collect();
        assert_eq!(titles, ["Plant and equipment", "Motor vehicles", "Total"]);
        let get = |b: usize, k: ScheduleRowKey| {
            let r = s.blocks[b].rows.iter().find(|r| r.key == k).unwrap();
            (r.current.unwrap(), r.prior.unwrap())
        };
        // Van, FY2025: book value 14,000.35 and accumulated 6,000.15 round to 14,000 and 6,000,
        // so cost shows 20,000 although 20,000.50 alone would round to 20,001.
        assert_eq!(get(1, ScheduleRowKey::Additions), (0, 20_000));
        assert_eq!(get(1, ScheduleRowKey::ClosingAccumulated), (0, 6_000));
        assert_eq!(get(1, ScheduleRowKey::Disposals), (-20_000, 0));
        assert_eq!(get(1, ScheduleRowKey::Gain), (-600, 0));
        for b in 0..s.blocks.len() {
            for col in [0, 1] {
                let v = |k| {
                    let (c, p) = get(b, k);
                    if col == 0 { c } else { p }
                };
                use ScheduleRowKey::*;
                assert_eq!(v(OpeningCost) + v(Additions) + v(Disposals), v(ClosingCost));
                assert_eq!(
                    v(OpeningAccumulated) + v(Depreciation) + v(DisposalAccumulated),
                    v(ClosingAccumulated)
                );
                assert_eq!(v(ClosingCost) - v(ClosingAccumulated), v(BookValue));
            }
        }
        // Nothing in either column: no block.
        let s = build_asset_schedule(&classes[..1], &assets[..0], &[], None);
        assert_eq!(s.blocks.len(), 1);
        assert_eq!(s.blocks[0].rows[0].prior, None);
    }

    fn arb_settings() -> impl Strategy<Value = DepreciationSettings> {
        let method = prop_oneof![
            (1..=MAX_RATE_BP).prop_map(|rate_bp| Method::Dv { rate_bp }),
            (1..=MAX_RATE_BP).prop_map(|rate_bp| Method::Sl {
                basis: SlBasis::Rate { rate_bp }
            }),
            (1..=240u32).prop_map(|months| Method::Sl {
                basis: SlBasis::Life { months }
            }),
            Just(Method::None),
        ];
        let part_year = prop_oneof![
            any::<bool>().prop_map(|c| PartYear::MonthsHeld {
                count_acquisition_month: c
            }),
            Just(PartYear::Daily),
            Just(PartYear::FullYear),
        ];
        let disposal_year =
            prop_oneof![Just(DisposalYear::None), Just(DisposalYear::ToDisposalDate)];
        (method, part_year, disposal_year).prop_map(|(method, part_year, disposal_year)| {
            DepreciationSettings {
                method,
                part_year,
                disposal_year,
            }
        })
    }

    fn arb_asset() -> impl Strategy<Value = Asset> {
        (
            1..10_000_000_000i64,
            0..=100u32,
            0..2_000i64,
            arb_settings(),
            proptest::option::of((0..4_000i64, 0..10_000_000_000i64)),
        )
            .prop_map(|(cost, residual_pct, day, settings, disposal)| Asset {
                cost: Money::from_cents(cost),
                residual: Money::from_cents(cost * i64::from(residual_pct) / 100),
                acquired: d(2020, 4, 1) + chrono::Days::new(day as u64),
                settings,
                opening: None,
                disposal: disposal.map(|(after, proceeds)| Disposal {
                    date: d(2020, 4, 1) + chrono::Days::new((day + after) as u64),
                    proceeds: Money::from_cents(proceeds),
                    proceeds_account: code("620"),
                }),
            })
    }

    use proptest::prelude::*;

    proptest! {
        #[test]
        fn book_value_stays_between_nil_and_cost(a in arb_asset()) {
            // Years ending 31 March 2021 to 2035, with one 15-month year in the middle.
            let mut years: Vec<ClientYear> = (2021..=2026).map(march_year).collect();
            years.push(year(d(2026, 4, 1), d(2027, 6, 30)));
            years.extend((2028..=2035).map(|y| year(d(y - 1, 7, 1), d(y, 6, 30))));
            let rows = asset_years(&a, &years, &BTreeMap::new()).unwrap();
            let floor = match a.settings.method {
                Method::Sl { .. } => a.residual,
                _ => Money::ZERO,
            };
            for row in &rows {
                prop_assert!(row.depreciation >= Money::ZERO);
                if !row.closing_cost.is_zero() {
                    prop_assert!(row.closing_book_value() >= floor);
                    prop_assert!(row.closing_book_value() <= a.cost);
                }
                if row.gain.is_some() {
                    prop_assert!(row.disposal_accumulated <= a.cost - floor);
                }
            }
            if let Method::Sl { basis: SlBasis::Life { months } } = a.settings.method
                && a.disposal.is_none()
                && months <= 96
            {
                // Everything above the residual is written off by the end of the life.
                prop_assert_eq!(rows.last().unwrap().closing_book_value(), a.residual);
            }
        }

        #[test]
        fn register_journals_balance_and_schedules_foot(assets in proptest::collection::vec(arb_asset(), 0..6)) {
            let years: Vec<ClientYear> = (2021..=2027).map(march_year).collect();
            let register: Vec<RegisterAsset> = assets
                .into_iter()
                .enumerate()
                .map(|(i, a)| register_asset(&format!("A{i}"), if i % 2 == 0 { "plant" } else { "vehicles" }, a))
                .collect();
            let all: Vec<Vec<AssetYear>> = register
                .iter()
                .map(|a| asset_years(&a.asset, &years, &BTreeMap::new()).unwrap())
                .collect();
            let classes = [
                ScheduleClass { code: "plant".to_owned(), name: "P".to_owned() },
                ScheduleClass { code: "vehicles".to_owned(), name: "V".to_owned() },
            ];
            for (i, year) in years.iter().enumerate() {
                let rows: Vec<AssetYear> = all.iter().map(|r| r[i]).collect();
                for j in year_journals(year, &register, &rows).all() {
                    prop_assert!(j.lines.len() >= 2);
                    prop_assert!(year.contains(j.date));
                    prop_assert_eq!(j.lines.iter().map(|l| l.amount).sum::<Money>(), Money::ZERO);
                }
                let prior: Option<Vec<AssetYear>> = i.checked_sub(1).map(|p| all.iter().map(|r| r[p]).collect());
                let s = build_asset_schedule(&classes, &register, &rows, prior.as_deref());
                for b in &s.blocks {
                    let v = |k: ScheduleRowKey| b.rows.iter().find(|r| r.key == k).unwrap().current.unwrap();
                    use ScheduleRowKey::*;
                    prop_assert_eq!(v(OpeningCost) + v(Additions) + v(Disposals), v(ClosingCost));
                    prop_assert_eq!(v(OpeningAccumulated) + v(Depreciation) + v(DisposalAccumulated), v(ClosingAccumulated));
                    prop_assert_eq!(v(ClosingCost) - v(ClosingAccumulated), v(BookValue));
                    let total: AssetYear = {
                        let mut t = AssetYear::default();
                        for (a, r) in register.iter().zip(&rows) {
                            if b.class.as_deref().is_none_or(|c| a.class == c) { t.add(r); }
                        }
                        t
                    };
                    prop_assert_eq!(v(ClosingAccumulated), total.closing_accumulated.round_to_dollars());
                    prop_assert_eq!(v(BookValue), total.closing_book_value().round_to_dollars());
                }
            }
        }
    }
}
