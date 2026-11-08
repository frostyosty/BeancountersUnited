//! The overseer's trial counts (M21, ADR 015, 5): `GET /api/overseer/trials`.
//!
//! Read from `command_log`, so there's no table of its own: for each of the last 12 weeks, the
//! trials started, saved (claimed, or moved into an existing account) and expired by why, and
//! saves by the prompt that led to them (`claim_guest`'s `from`). Events in the week they
//! happened, not cohorts. Counts only, never a business's data.
//!
//! A redacted (expired) trial still counts: its `start_guest` row keeps its kind and time, and the
//! `expire_guest` row that ended it is never redacted. Counting reads payloads only of
//! `claim_guest` and `expire_guest` rows that aren't redacted (`log::trial_events`), so it never
//! reads a redacted payload.

use std::collections::BTreeMap;

use acct_store::SqliteConnection;
use acct_store::log::{self, TrialEvent};
use axum::Json;
use axum::extract::State;
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::AppState;
use crate::auth::CurrentUser;
use crate::commands::ExpireWhy;
use crate::error::CommandError;
use crate::guests::ClaimFrom;

/// How many weeks the counts cover, the current one included.
pub const WEEKS: usize = 12;

/// The response of `GET /api/overseer/trials`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TrialCounts {
    /// The last 12 weeks, newest first. Weeks start Monday 00:00 UTC.
    pub weeks: Vec<TrialWeek>,
    /// All 12 weeks together.
    pub total: TrialTally,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TrialWeek {
    /// The Monday the week starts on.
    #[ts(type = "string")]
    pub starts: NaiveDate,
    pub counts: TrialTally,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct TrialTally {
    /// `start_guest`: trials started, from a file or an example.
    pub started: i64,
    /// `claim_guest`: saved as a new account.
    pub saved: i64,
    /// `adopt_guest_business`: moved into an account the visitor already had.
    pub moved: i64,
    /// `expire_guest`, every why.
    pub expired: i64,
    /// Not back in 7 days.
    pub expired_unused: i64,
    /// Deleted by the visitor.
    pub expired_by_you: i64,
    /// An example's 24 hours were up.
    pub expired_example_finished: i64,
    /// Saves by the prompt that led to them, in the list's order, "not recorded" (`null`) last.
    /// Only those with a save.
    pub saves_by_from: Vec<SavesFrom>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct SavesFrom {
    /// `null`: not recorded.
    pub from: Option<ClaimFrom>,
    pub saves: i64,
}

/// A tally being counted: saves by `from` in a map, "not recorded" under `None`.
#[derive(Default)]
struct Tally {
    t: TrialTally,
    by_from: BTreeMap<Option<ClaimFrom>, i64>,
}

impl Tally {
    fn add(&mut self, e: &TrialEvent) {
        let field = |key: &str| -> Option<serde_json::Value> {
            let payload: serde_json::Value = serde_json::from_str(e.payload.as_deref()?).ok()?;
            payload.get(key).cloned()
        };
        match e.kind.as_str() {
            "start_guest" => self.t.started += 1,
            "adopt_guest_business" => self.t.moved += 1,
            "claim_guest" => {
                self.t.saved += 1;
                let from = field("from").and_then(|v| serde_json::from_value(v).ok());
                *self.by_from.entry(from).or_default() += 1;
            }
            "expire_guest" => {
                self.t.expired += 1;
                match field("why").and_then(|v| serde_json::from_value(v).ok()) {
                    Some(ExpireWhy::Unused) => self.t.expired_unused += 1,
                    Some(ExpireWhy::ByYou) => self.t.expired_by_you += 1,
                    Some(ExpireWhy::ExampleFinished) => self.t.expired_example_finished += 1,
                    None => {}
                }
            }
            _ => {}
        }
    }

    fn done(self) -> TrialTally {
        let mut t = self.t;
        let (recorded, none): (Vec<_>, Vec<_>) = self
            .by_from
            .into_iter()
            .partition(|(from, _)| from.is_some());
        t.saves_by_from = recorded
            .into_iter()
            .chain(none)
            .map(|(from, saves)| SavesFrom { from, saves })
            .collect();
        t
    }
}

/// The Monday 00:00 UTC that starts the week holding `at`.
fn week_of(at: DateTime<Utc>) -> NaiveDate {
    let d = at.date_naive();
    d - Duration::days(i64::from(d.weekday().num_days_from_monday()))
}

/// The counts for the 12 weeks up to `now`.
pub async fn counts(
    conn: &mut SqliteConnection,
    now: DateTime<Utc>,
) -> Result<TrialCounts, CommandError> {
    let this_week = week_of(now);
    let first = this_week - Duration::weeks(WEEKS as i64 - 1);
    let since = first.and_hms_opt(0, 0, 0).expect("midnight").and_utc();
    let mut weeks: BTreeMap<NaiveDate, Tally> = (0..WEEKS as i64)
        .map(|i| (first + Duration::weeks(i), Tally::default()))
        .collect();
    let mut total = Tally::default();
    for e in log::trial_events(conn, since).await? {
        if let Some(week) = weeks.get_mut(&week_of(e.at)) {
            week.add(&e);
            total.add(&e);
        }
    }
    Ok(TrialCounts {
        weeks: weeks
            .into_iter()
            .rev()
            .map(|(starts, tally)| TrialWeek {
                starts,
                counts: tally.done(),
            })
            .collect(),
        total: total.done(),
    })
}

/// `GET /api/overseer/trials`. Overseers only, as themselves (`access::RouteRule::Overseer`).
pub async fn get_trials(
    State(state): State<AppState>,
    _user: CurrentUser,
) -> Result<Json<TrialCounts>, CommandError> {
    let mut conn = state.store.reader().await?;
    Ok(Json(counts(&mut conn, Utc::now()).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weeks_start_on_monday_utc() {
        let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().to_utc();
        // Saturday 7 November 2026.
        assert_eq!(
            week_of(at("2026-11-07T23:59:00Z")),
            NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()
        );
        // A Monday is its own week's start.
        assert_eq!(
            week_of(at("2026-11-02T00:00:00Z")),
            NaiveDate::from_ymd_opt(2026, 11, 2).unwrap()
        );
        assert_eq!(
            week_of(at("2026-11-01T23:59:59Z")),
            NaiveDate::from_ymd_opt(2026, 10, 26).unwrap()
        );
    }

    #[test]
    fn saves_by_from_put_not_recorded_last() {
        let event = |kind: &str, payload: Option<&str>| TrialEvent {
            kind: kind.to_owned(),
            at: Utc::now(),
            payload: payload.map(str::to_owned),
        };
        let mut t = Tally::default();
        t.add(&event("claim_guest", Some(r#"{"email":"[x]"}"#)));
        t.add(&event("claim_guest", Some(r#"{"from":"locked:pdf"}"#)));
        t.add(&event("claim_guest", Some(r#"{"from":"banner"}"#)));
        t.add(&event("expire_guest", Some(r#"{"why":"by_you"}"#)));
        // A payload that couldn't be read still counts as an expiry.
        t.add(&event("expire_guest", None));
        t.add(&event("start_guest", None));
        let t = t.done();
        assert_eq!(
            (t.started, t.saved, t.expired, t.expired_by_you),
            (1, 3, 2, 1)
        );
        let froms: Vec<_> = t.saves_by_from.iter().map(|s| s.from).collect();
        assert_eq!(
            froms,
            [Some(ClaimFrom::Banner), Some(ClaimFrom::LockedPdf), None]
        );
    }
}
