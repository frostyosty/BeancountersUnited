//! The one path to a model, and the row every ask leaves behind (ADR 016, 1 to 6).
//!
//! The raw [`Suggester`] is held only by [`Metered`], whose field is private, and the rest of the
//! server gets nothing from it but [`Metered::provider`], [`Metered::model`] and
//! [`Metered::begin`]. So a call that isn't metered doesn't compile, and a test reads every file in
//! `src` to make sure nobody threads a raw suggester back in (`tests/ai_usage.rs`).
//!
//! An ask is one user action that may reach a model: one suggestions run, or one explanation.
//!
//! 1. [`Metered::begin`] works out the plan, checks the daily limits and the budget cap, and
//!    returns an [`Ask`]. A refusal writes its row (`refused_limit` or `refused_budget`) before it
//!    returns the error.
//! 2. [`Ask::suggestions`] and [`Ask::explanation`] call the model, time the call and add up its
//!    tokens.
//! 3. [`Ask::finish`] works out the outcome and the cost and writes the one row.
//!
//! The row is written directly, as metering, not as a command (hard rule 6 as amended): usage
//! isn't practice or client data, so it never reaches `command_log`, the sync feed or Changes. It
//! is written after the ask's last model call, with no transaction open during it.
//!
//! Nothing is ever stored or logged here that would let us read what was asked: no prompt,
//! response, description, card wording, name, address or error message. A row is ids, a time,
//! counts, a model id and short enums (ADR 009's retention rule, unchanged).

use std::sync::Arc;
use std::time::Instant;

use acct_ai::eval::Prices;
use acct_ai::{
    AiError, Call, Config, ExplainRequest, RawSuggestion, SuggestRequest, Suggester, Usage,
};
use acct_store::SqliteConnection;
use acct_store::Store;
use acct_store::ai_usage::{self as usage_store, UsageRow};
use acct_store::guests as guests_store;
use acct_store::new_id;
use acct_store::users::Role;
use chrono::{DateTime, Utc};

use crate::AppState;
use crate::ai_limits::{Plan, parse_limit, plan_of};
use crate::ai_watch::{AiKind, AiOutcome};
use crate::auth::CurrentUser;
use crate::error::CommandError;

/// A suggester, with every call to it metered. `AppState::suggester` holds one.
pub struct Metered {
    inner: Arc<dyn Suggester>,
    /// What the model's tokens cost; `None` when its prices are unknown.
    prices: Option<Prices>,
    /// `ACCT_AI_DAILY_BUDGET_CENTS`: today's cost (US cents) at which model calls are refused.
    daily_budget_cents: Option<u32>,
}

impl Metered {
    /// Wraps a suggester. The prices are the list prices for its model, if it's on the list; there
    /// is no budget cap. Tests and `suggester_from_env` change either.
    pub fn new(inner: Arc<dyn Suggester>) -> Metered {
        let prices = Prices::known(inner.model());
        Metered {
            inner,
            prices,
            daily_budget_cents: None,
        }
    }

    /// With these prices for the model (`None`: unknown).
    #[must_use]
    pub fn with_prices(mut self, prices: Option<Prices>) -> Metered {
        self.prices = prices;
        self
    }

    /// With a daily budget cap in US cents (`None`: no cap).
    #[must_use]
    pub fn with_daily_budget_cents(mut self, cents: Option<u32>) -> Metered {
        self.daily_budget_cents = cents;
        self
    }

    /// The provider's name as Save tax and the privacy notice show it.
    pub fn provider(&self) -> &str {
        self.inner.provider()
    }

    /// The model id recorded with each suggestion.
    pub fn model(&self) -> &str {
        self.inner.model()
    }

    /// The daily budget cap in US cents, if one is set.
    pub fn daily_budget_cents(&self) -> Option<u32> {
        self.daily_budget_cents
    }

    /// Whether the model's tokens can be priced.
    pub fn prices_known(&self) -> bool {
        self.prices.is_some()
    }

    /// Starts an ask: works out its plan, and unless it's an overseer's (who have no limit and no
    /// cap, ADR 016, 8) or has nothing to send to the model, checks the daily limits and then the
    /// budget cap. A refusal writes its row and returns the error the owner sees.
    pub async fn begin(
        self: &Arc<Self>,
        state: &AppState,
        ctx: AskCtx<'_>,
    ) -> Result<Ask, CommandError> {
        let actor = ctx.user.actor();
        let is_overseer = actor.role == Role::Overseer;
        let now = Utc::now();
        let (plan, refusal) = {
            let mut conn = state.store.reader().await?;
            let plan = plan_of(&mut conn, &actor, ctx.client_id).await?;
            if !is_overseer
                && ctx.sends_to_model
                && ctx.kind == AiKind::Explain
                && plan == Plan::Guest
                && let Some(address) = ctx.address
                && let Some(left) = state.explain_quota.guest_cooldown_left(address, now)
            {
                return Err(CommandError::invalid(
                    "ai_cooldown",
                    format!("Please wait {left} seconds before asking again."),
                ));
            }
            let refusal = if is_overseer || !ctx.sends_to_model {
                None
            } else {
                self.refusal(state, &mut conn, plan, &ctx, now).await?
            };
            (plan, refusal)
        };
        let ask = Ask {
            metered: Arc::clone(self),
            store: Arc::clone(&state.store),
            kind: ctx.kind,
            business_id: ctx.client_id.to_owned(),
            user_id: actor.user_id,
            plan,
            is_overseer,
            acting_as: actor.acting_as.map(|a| a.user_id),
            layers: ctx.layers,
            calls: 0,
            usage: Usage::default(),
            latency_ms: 0,
            worst: AiOutcome::Ok,
        };
        match refusal {
            Some(outcome) => {
                tracing::info!(
                    kind = ctx.kind.as_str(),
                    outcome = outcome.as_str(),
                    "an AI ask was refused"
                );
                ask.write(outcome, 0).await;
                Err(refusal_error(outcome, ctx.kind))
            }
            None => {
                if !is_overseer
                    && ctx.sends_to_model
                    && ctx.kind == AiKind::Explain
                    && plan == Plan::Guest
                    && let Some(address) = ctx.address
                {
                    state.explain_quota.start_guest_cooldown(address, now);
                }
                Ok(ask)
            }
        }
    }

    /// Which refusal applies, if any, in this order: the plan's daily limit for the business, the
    /// global explanation cap, the budget cap, then the per-address limit last, because it's the
    /// only one that spends anything when it passes.
    async fn refusal(
        &self,
        state: &AppState,
        conn: &mut SqliteConnection,
        plan: Plan,
        ctx: &AskCtx<'_>,
        now: DateTime<Utc>,
    ) -> Result<Option<AiOutcome>, CommandError> {
        let day = now.date_naive();
        let kind = ctx.kind.as_str();
        let limit = match ctx.kind {
            AiKind::Suggestion => state.ai_quota.limit(plan),
            AiKind::Explain => state.explain_quota.limit(plan),
        };
        if let Some(limit) = limit
            && usage_store::count_for_business(conn, ctx.client_id, kind, day).await? >= limit
        {
            return Ok(Some(AiOutcome::RefusedLimit));
        }
        if ctx.kind == AiKind::Explain
            && let Some(cap) = state.explain_quota.global()
        {
            let guests =
                guests_store::started_since(conn, now - chrono::Duration::hours(24)).await?;
            if usage_store::count_all(conn, kind, day).await? >= cap.for_guests(guests) {
                return Ok(Some(AiOutcome::RefusedLimit));
            }
        }
        if let Some(cents) = self.daily_budget_cents {
            // With no prices the spend can't be seen, and a cap exists to bound it: fail closed
            // (ADR 016, D2).
            let cap = u64::from(cents) * MICRO_USD_PER_CENT;
            if self.prices.is_none() || usage_store::cost_on(conn, day).await? >= cap {
                return Ok(Some(AiOutcome::RefusedBudget));
            }
        }
        if ctx.kind == AiKind::Explain
            && let Some(address) = ctx.address
            && !state.explain_quota.take_address(address, day)
        {
            return Ok(Some(AiOutcome::RefusedLimit));
        }
        Ok(None)
    }
}

/// US micro-dollars in a US cent.
const MICRO_USD_PER_CENT: u64 = 10_000;

/// What the owner sees when an ask is refused. Never a cost or an amount.
fn refusal_error(outcome: AiOutcome, kind: AiKind) -> CommandError {
    match (outcome, kind) {
        (AiOutcome::RefusedBudget, AiKind::Suggestion) => CommandError::invalid(
            "ai_budget",
            "The experts are resting until tomorrow. Suggestions from your rules and earlier \
             choices still show.",
        ),
        (AiOutcome::RefusedBudget, AiKind::Explain) => CommandError::invalid(
            "ai_budget",
            "The experts are resting until tomorrow. Try Explain better again then.",
        ),
        (_, AiKind::Suggestion) => CommandError::invalid(
            "ai_daily_limit",
            "You've used today's question. The experts are back tomorrow.",
        ),
        (_, AiKind::Explain) => CommandError::invalid(
            "ai_daily_limit",
            "Daily usage limit reached. Explanations are back tomorrow.",
        ),
    }
}

/// What [`Metered::begin`] needs to know about an ask.
pub struct AskCtx<'a> {
    pub kind: AiKind,
    /// Who's asking. The row records the real user, and `acting_as` while viewing as someone.
    pub user: &'a CurrentUser,
    pub client_id: &'a str,
    /// The client's address, for the per-address explanation limit (kept in memory only).
    pub address: Option<&'a str>,
    /// A suggestions run's layer counts, from the queue it read. Written even if the ask is
    /// refused, because the first three layers still ran.
    pub layers: Option<Layers>,
    /// False for a run with nothing left for the model: it's free, so no limit or cap applies,
    /// and it still writes its row for the AI share.
    pub sends_to_model: bool,
}

/// A suggestions run's layer counts, taken from the Save tax queue it reads (ADR 016, 2). Lines
/// that already had an AI pre-fill waiting are `lines_total` less the other four.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Layers {
    /// Categorise cards in the queue.
    pub lines_total: u32,
    pub by_rules: u32,
    pub by_history: u32,
    pub by_merchants: u32,
    /// Lines sent to the model.
    pub lines_asked: u32,
}

/// What the caller knows once the ask is over, for [`Ask::finish`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Finish {
    /// Answers the model gave, over the whole run.
    pub answered: u32,
    /// Of those, the ones that survived checking.
    pub kept: u32,
    /// Pre-fills the run stored.
    pub by_model: u32,
}

/// One ask in progress. Every path ends in [`Ask::finish`], which writes its one row.
#[must_use = "an ask writes its row only when it is finished"]
pub struct Ask {
    metered: Arc<Metered>,
    store: Arc<Store>,
    kind: AiKind,
    business_id: String,
    user_id: Option<String>,
    plan: Plan,
    is_overseer: bool,
    acting_as: Option<String>,
    layers: Option<Layers>,
    /// Requests sent, failed ones included.
    calls: u32,
    usage: Usage,
    latency_ms: u64,
    /// The worst outcome of any call so far.
    worst: AiOutcome,
}

impl Ask {
    /// One batch of lines to the model.
    pub async fn suggestions(
        &mut self,
        request: SuggestRequest,
    ) -> Result<Vec<RawSuggestion>, AiError> {
        let started = Instant::now();
        let call = self.metered.inner.suggest(request).await;
        self.take(call, started)
    }

    /// One card to the model.
    pub async fn explanation(&mut self, request: ExplainRequest) -> Result<String, AiError> {
        let started = Instant::now();
        let call = self.metered.inner.explain(request).await;
        self.take(call, started)
    }

    /// Adds a call's tokens and time, and notes how it went.
    fn take<T>(&mut self, call: Call<T>, started: Instant) -> Result<T, AiError> {
        let Call { result, usage } = call;
        // A provider that can't write explanations never sent a request.
        if !matches!(result, Err(AiError::Unsupported)) {
            self.calls += 1;
            self.latency_ms += u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        }
        self.usage.add(usage);
        if let Err(e) = &result {
            self.worst = self.worst.max(outcome_of(e));
        }
        result
    }

    /// Ends the ask and writes its row. The outcome is the worst of its calls: `error`, then
    /// `invalid` (which also covers a run whose every answer was dropped), then `declined`, then
    /// `ok`. A row that can't be written is logged without content, and the answer still goes
    /// back (ADR 016, 3).
    pub async fn finish(mut self, finish: Finish) {
        if finish.answered > 0 && finish.kept == 0 {
            self.worst = self.worst.max(AiOutcome::Invalid);
        }
        let outcome = self.worst;
        self.write(outcome, finish.by_model).await;
    }

    async fn write(&self, outcome: AiOutcome, by_model: u32) {
        let called = self.calls > 0;
        let int = |n: u64| i64::try_from(n).unwrap_or(i64::MAX);
        let layer = |f: fn(&Layers) -> u32| self.layers.as_ref().map(|l| i64::from(f(l)));
        let row = UsageRow {
            id: new_id(),
            at: Utc::now(),
            kind: self.kind.as_str().to_owned(),
            business_id: self.business_id.clone(),
            user_id: self.user_id.clone(),
            plan: self.plan.as_str().to_owned(),
            is_overseer: self.is_overseer,
            acting_as: self.acting_as.clone(),
            model: called.then(|| self.metered.model().to_owned()),
            model_calls: i64::from(self.calls),
            input_tokens: int(self.usage.input_tokens),
            output_tokens: int(self.usage.output_tokens),
            cache_read_tokens: int(self.usage.cache_read_tokens),
            cache_write_tokens: int(self.usage.cache_write_tokens),
            // Priced once, on the summed usage, and stored, so a later price change doesn't
            // rewrite history. An ask that made no call cost nothing.
            cost_micro_usd: if called {
                self.metered.prices.map(|p| int(p.cost(&self.usage)))
            } else {
                Some(0)
            },
            latency_ms: called.then(|| int(self.latency_ms)),
            outcome: outcome.as_str().to_owned(),
            lines_total: layer(|l| l.lines_total),
            by_rules: layer(|l| l.by_rules),
            by_history: layer(|l| l.by_history),
            by_merchants: layer(|l| l.by_merchants),
            lines_asked: layer(|l| l.lines_asked),
            by_model: self.layers.map(|_| i64::from(by_model)),
        };
        if let Err(e) = usage_store::insert(&self.store, &row).await {
            tracing::warn!(
                kind = self.kind.as_str(),
                outcome = outcome.as_str(),
                error = %e,
                "couldn't record an AI ask"
            );
        }
    }
}

/// How a failed call counts in its ask's outcome.
fn outcome_of(error: &AiError) -> AiOutcome {
    match error {
        AiError::Network(_) | AiError::Status(_) | AiError::Unsupported => AiOutcome::Error,
        AiError::BadResponse(_) => AiOutcome::Invalid,
        AiError::Refused => AiOutcome::Declined,
    }
}

/// The suggester the server's environment names, if any, wrapped so every call is metered. A bad
/// configuration is logged and leaves suggestions off.
///
/// - Prices come from `AI_PRICE_*` or the list prices (`Prices::from_vars`). With none for the
///   model, costs are recorded as unknown, and a warning says so.
/// - `ACCT_AI_DAILY_BUDGET_CENTS` is the daily budget cap in US cents: unset, `0` or `off` for
///   none. With a cap and no prices, every model call is refused (ADR 016, D2).
pub fn suggester_from_env() -> Option<Arc<Metered>> {
    metered_from_vars(|name| std::env::var(name).ok())
}

fn metered_from_vars(var: impl Fn(&str) -> Option<String>) -> Option<Arc<Metered>> {
    let config = match Config::from_vars(&var) {
        Ok(Some(c)) => c,
        Ok(None) => return None,
        Err(e) => {
            tracing::warn!("AI suggestions are off: {e}");
            return None;
        }
    };
    let inner = match config.suggester() {
        Ok(s) => s,
        Err(e) => {
            tracing::warn!("AI suggestions are off: {e}");
            return None;
        }
    };
    let prices = Prices::from_vars(&var, &config.model).unwrap_or_else(|e| {
        tracing::warn!("{e}; costs will be recorded as unknown");
        None
    });
    let budget = var("ACCT_AI_DAILY_BUDGET_CENTS").and_then(|v| parse_limit(&v));
    tracing::info!(
        provider = %config.provider_name,
        model = %config.model,
        daily_budget_cents = ?budget,
        "AI suggestions are available"
    );
    if prices.is_none() {
        tracing::warn!(
            model = %config.model,
            "no prices are known for the AI model, so costs are recorded as unknown; set \
             AI_PRICE_INPUT and AI_PRICE_OUTPUT (USD per million tokens){}",
            if budget.is_some() {
                ", because with a daily budget set every model call is refused until they are"
            } else {
                ""
            }
        );
    }
    Some(Arc::new(
        Metered::new(inner)
            .with_prices(prices)
            .with_daily_budget_cents(budget),
    ))
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
    fn the_worst_call_names_the_outcome() {
        assert_eq!(outcome_of(&AiError::Network("x".into())), AiOutcome::Error);
        assert_eq!(outcome_of(&AiError::Status(500)), AiOutcome::Error);
        assert_eq!(outcome_of(&AiError::Unsupported), AiOutcome::Error);
        assert_eq!(outcome_of(&AiError::BadResponse("x")), AiOutcome::Invalid);
        assert_eq!(outcome_of(&AiError::Refused), AiOutcome::Declined);
        // Worst first: error, invalid, declined, ok.
        assert!(AiOutcome::Error > AiOutcome::Invalid);
        assert!(AiOutcome::Invalid > AiOutcome::Declined);
        assert!(AiOutcome::Declined > AiOutcome::Ok);
    }

    #[test]
    fn the_environment_names_the_suggester_prices_and_cap() {
        assert!(metered_from_vars(vars(&[])).is_none());
        let fake = [("AI_PROVIDER", "fake"), ("AI_MODEL", "fake-model")];
        let m = metered_from_vars(vars(&fake)).unwrap();
        assert_eq!(m.model(), "fake-model");
        assert!(!m.prices_known() && m.daily_budget_cents().is_none());

        let priced = [
            ("AI_PROVIDER", "fake"),
            ("AI_PRICE_INPUT", "0.1"),
            ("AI_PRICE_OUTPUT", "0.5"),
            ("ACCT_AI_DAILY_BUDGET_CENTS", "500"),
        ];
        let m = metered_from_vars(vars(&priced)).unwrap();
        assert!(m.prices_known());
        assert_eq!(m.daily_budget_cents(), Some(500));

        // `0` and `off` mean no cap, like the daily limits.
        for none in ["0", "off"] {
            let pairs = [
                ("AI_PROVIDER", "fake"),
                ("ACCT_AI_DAILY_BUDGET_CENTS", none),
            ];
            assert_eq!(
                metered_from_vars(vars(&pairs))
                    .unwrap()
                    .daily_budget_cents(),
                None
            );
        }
        // A bad price leaves costs unknown instead of stopping the server.
        let bad = [("AI_PROVIDER", "fake"), ("AI_PRICE_INPUT", "lots")];
        assert!(!metered_from_vars(vars(&bad)).unwrap().prices_known());
    }

    #[test]
    fn the_owner_never_sees_a_cost() {
        for kind in AiKind::ALL {
            for outcome in [AiOutcome::RefusedLimit, AiOutcome::RefusedBudget] {
                let CommandError::Invalid { code, message, .. } = refusal_error(outcome, kind)
                else {
                    panic!("a refusal is an invalid-request error");
                };
                assert!(code == "ai_daily_limit" || code == "ai_budget", "{code}");
                assert!(
                    !message.contains('$') && !message.contains("cent"),
                    "{message}"
                );
            }
        }
    }
}
