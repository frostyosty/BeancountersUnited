//! Plans and the daily AI limits per plan (ADR 016, 4).
//!
//! [`plan_of`] says which plan an ask falls under, and [`LimitTable`] holds every limit, looked up
//! by plan and kind in one place. The numbers are per business per UTC day. Changing one is a
//! one-line edit to [`STANDARD`]; the owner sets the paid plans' numbers when billing arrives (M24).

use std::collections::BTreeMap;

use acct_store::SqliteConnection;
use acct_store::guests as guests_store;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ai_watch::AiKind;
use crate::error::CommandError;
use crate::pipeline::Actor;

/// The plan an ask is made under: the pricing page's four, plus a guest's trial.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export, rename_all = "snake_case")]
pub enum Plan {
    Guest,
    Free,
    Owner,
    Practice,
    PracticePlus,
}

impl Plan {
    pub const ALL: [Plan; 5] = [
        Plan::Guest,
        Plan::Free,
        Plan::Owner,
        Plan::Practice,
        Plan::PracticePlus,
    ];

    /// The value `ai_usage.plan` stores.
    pub fn as_str(self) -> &'static str {
        match self {
            Plan::Guest => "guest",
            Plan::Free => "free",
            Plan::Owner => "owner",
            Plan::Practice => "practice",
            Plan::PracticePlus => "practice_plus",
        }
    }

    pub fn parse(s: &str) -> Option<Plan> {
        Plan::ALL.into_iter().find(|p| p.as_str() == s)
    }
}

/// Which plan an ask on `client_id` falls under.
///
/// - An unsaved trial is [`Plan::Guest`].
/// - When a practice user asks on a client's business, the practice's plan counts, since it's the
///   practice using it (decided 2026-11-09).
/// - An owner (or an overseer as themselves) gets their business's plan.
///
/// Nothing records plans until billing (M24), so everyone who isn't a guest is [`Plan::Free`] and
/// `_actor` doesn't matter yet.
pub async fn plan_of(
    conn: &mut SqliteConnection,
    _actor: &Actor,
    client_id: &str,
) -> Result<Plan, CommandError> {
    if guests_store::guest_owner(conn, client_id).await?.is_some() {
        return Ok(Plan::Guest);
    }
    Ok(Plan::Free)
}

/// Asks allowed per business per UTC day, by plan and kind. `None` is no limit. Every paid plan
/// gets today's Free numbers, so nothing changes for anyone until billing (ADR 016, D1).
pub const STANDARD: [(Plan, AiKind, Option<u32>); 10] = [
    // A guest can't ask for suggestions at all (the route is refused for them anyway).
    (Plan::Guest, AiKind::Suggestion, Some(0)),
    (Plan::Guest, AiKind::Explain, Some(2)),
    (Plan::Free, AiKind::Suggestion, Some(1)),
    (Plan::Free, AiKind::Explain, Some(5)),
    (Plan::Owner, AiKind::Suggestion, Some(1)),
    (Plan::Owner, AiKind::Explain, Some(5)),
    (Plan::Practice, AiKind::Suggestion, Some(1)),
    (Plan::Practice, AiKind::Explain, Some(5)),
    (Plan::PracticePlus, AiKind::Suggestion, Some(1)),
    (Plan::PracticePlus, AiKind::Explain, Some(5)),
];

/// Every limit, keyed by plan and kind.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LimitTable {
    cells: BTreeMap<(Plan, AiKind), Option<u32>>,
}

impl Default for LimitTable {
    /// No limits, for tests and tools. The server uses [`LimitTable::from_env`].
    fn default() -> LimitTable {
        LimitTable::unlimited()
    }
}

impl LimitTable {
    /// [`STANDARD`], untouched by the environment.
    pub fn standard() -> LimitTable {
        LimitTable {
            cells: STANDARD
                .iter()
                .map(|&(plan, kind, limit)| ((plan, kind), limit))
                .collect(),
        }
    }

    /// No limit for any plan or kind.
    pub fn unlimited() -> LimitTable {
        LimitTable {
            cells: Plan::ALL
                .into_iter()
                .flat_map(|p| AiKind::ALL.into_iter().map(move |k| ((p, k), None)))
                .collect(),
        }
    }

    /// This table with one cell changed.
    #[must_use]
    pub fn with(mut self, plan: Plan, kind: AiKind, limit: Option<u32>) -> LimitTable {
        self.cells.insert((plan, kind), limit);
        self
    }

    /// The limit for `plan` and `kind`; `None` is no limit.
    pub fn get(&self, plan: Plan, kind: AiKind) -> Option<u32> {
        self.cells.get(&(plan, kind)).copied().flatten()
    }

    /// [`STANDARD`] with the Free plan's and the guest plan's cells overridden by the environment
    /// (ADR 016, 4), so staging and tests keep their knobs without touching a paid plan:
    /// - `ACCT_AI_DAILY_LIMIT`: (Free, suggestion);
    /// - `ACCT_AI_EXPLAIN_LIMIT`: (Free, explain);
    /// - `ACCT_AI_EXPLAIN_GUEST_LIMIT`: (Guest, explain).
    ///
    /// A number sets the limit; `0` or `off` mean no limit.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> LimitTable {
        let mut table = LimitTable::standard();
        for (name, plan, kind) in [
            ("ACCT_AI_DAILY_LIMIT", Plan::Free, AiKind::Suggestion),
            ("ACCT_AI_EXPLAIN_LIMIT", Plan::Free, AiKind::Explain),
            ("ACCT_AI_EXPLAIN_GUEST_LIMIT", Plan::Guest, AiKind::Explain),
        ] {
            if let Some(v) = var(name) {
                table.cells.insert((plan, kind), parse_limit(&v));
            }
        }
        table
    }

    /// [`LimitTable::from_vars`] over the environment.
    pub fn from_env() -> LimitTable {
        LimitTable::from_vars(|name| std::env::var(name).ok())
    }
}

/// A limit as written: a number, with `0`, `off` or anything else meaning none.
pub fn parse_limit(text: &str) -> Option<u32> {
    match text.trim().parse::<u32>() {
        Ok(0) | Err(_) => None,
        Ok(n) => Some(n),
    }
}

/// A limit from the environment: a number, `0` or `off` for none, `default` when unset.
pub fn env_limit(name: &str, default: u32) -> Option<u32> {
    match std::env::var(name) {
        Ok(v) => parse_limit(&v),
        Err(_) => Some(default),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<String> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(k, _)| *k == name)
                .map(|(_, v)| (*v).to_owned())
        }
    }

    #[test]
    fn every_plan_and_kind_has_a_cell_and_paid_plans_match_free() {
        let t = LimitTable::standard();
        for plan in Plan::ALL {
            for kind in AiKind::ALL {
                assert!(
                    STANDARD.iter().any(|&(p, k, _)| p == plan && k == kind),
                    "{plan:?} {kind:?} has no cell"
                );
            }
        }
        for plan in [Plan::Owner, Plan::Practice, Plan::PracticePlus] {
            for kind in AiKind::ALL {
                assert_eq!(t.get(plan, kind), t.get(Plan::Free, kind));
            }
        }
        assert_eq!(t.get(Plan::Free, AiKind::Suggestion), Some(1));
        assert_eq!(t.get(Plan::Free, AiKind::Explain), Some(5));
        assert_eq!(t.get(Plan::Guest, AiKind::Explain), Some(2));
        assert_eq!(t.get(Plan::Guest, AiKind::Suggestion), Some(0));
        assert_eq!(
            LimitTable::unlimited().get(Plan::Free, AiKind::Explain),
            None
        );
    }

    #[test]
    fn the_environment_overrides_only_the_free_and_guest_cells() {
        let t = LimitTable::from_vars(vars(&[
            ("ACCT_AI_DAILY_LIMIT", "7"),
            ("ACCT_AI_EXPLAIN_LIMIT", "off"),
            ("ACCT_AI_EXPLAIN_GUEST_LIMIT", "3"),
        ]));
        assert_eq!(t.get(Plan::Free, AiKind::Suggestion), Some(7));
        assert_eq!(t.get(Plan::Free, AiKind::Explain), None);
        assert_eq!(t.get(Plan::Guest, AiKind::Explain), Some(3));
        // A paid plan never changes behind its back.
        assert_eq!(t.get(Plan::Owner, AiKind::Suggestion), Some(1));
        assert_eq!(t.get(Plan::Practice, AiKind::Explain), Some(5));
        // Unset means the standard table.
        assert_eq!(LimitTable::from_vars(vars(&[])), LimitTable::standard());
        // `0` means none, as it always has.
        let t = LimitTable::from_vars(vars(&[("ACCT_AI_DAILY_LIMIT", "0")]));
        assert_eq!(t.get(Plan::Free, AiKind::Suggestion), None);
    }

    #[test]
    fn one_cell_can_be_changed_for_a_test_plan() {
        let t = LimitTable::standard().with(Plan::PracticePlus, AiKind::Explain, Some(9));
        assert_eq!(t.get(Plan::PracticePlus, AiKind::Explain), Some(9));
        assert_eq!(t.get(Plan::Practice, AiKind::Explain), Some(5));
    }

    #[test]
    fn plans_spell_what_the_table_stores() {
        for p in Plan::ALL {
            assert_eq!(Plan::parse(p.as_str()), Some(p));
            assert_eq!(
                serde_json::to_value(p).unwrap(),
                serde_json::json!(p.as_str())
            );
        }
        assert_eq!(Plan::parse("enterprise"), None);
    }
}
