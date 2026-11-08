# 016: Watching the AI (usage, limits per plan, spikes and overseer access)

Status: accepted (2026-11-09). Settles M22 (`M22-PROMPTS.md`) before wave 2 starts. The owner settled three
points on 2026-11-09: usage is metered directly, not through commands (hard rule 6 amended in `CLAUDE.md`);
limits are keyed by plan; and when a practice user asks on a client's business, the practice's plan counts.
This ADR records those and settles the rest. The owner accepted every recommendation on 2026-11-09 (D1 to
D6, listed at the end). ADR 015 is the latest ADR, so this is 016. Migration 0015 is the latest, so M22 takes
0016.

## Context

### What exists today (checked against the code, 2026-11-09)
Every place in the code that can reach a model:

| # | Where | What | Reached from |
|---|---|---|---|
| 1 | `crates/server/src/ai.rs:970` | `suggester.suggest(request)`, once per batch of 50 lines, in `ai::suggest` | `POST /api/businesses/{id}/ai-suggestions` (`lib.rs:229`) |
| 2 | `crates/server/src/ai.rs:1258` | `suggester.explain(request)` in `ai::explain_card` (M21's **Explain better**) | `POST /api/businesses/{id}/explain` (`lib.rs:234`) |
| 3 | `crates/ai/src/eval.rs:195` | `suggester.suggest` per batch in `eval::run` | `acctd ai-eval` (`crates/server/src/main.rs:123`, `:160`): an operator's command line, with its own `Config`, never the server's state |
| 4 | `crates/ai/src/leak_tests.rs:169` | the fake, in a test | tests only |

A suggester is built in two places: `ai::suggester_from_env` (`ai.rs:51`), which `AppState::new` calls
(`lib.rs:77`) for `acctd serve` and for `acct-dev` (`apps/desktop/shell/src/server.rs:53`); and `main.rs:123`
for the bake-off. Tests put a `FakeSuggester` straight into the public `AppState::suggester` field
(`tests/ai.rs:184`, `:337`, `:559`). Nothing asks for suggestions in the background, although ADR 009's
"From suggestion to command" describes a background task.

The milestone's description holds, with these additions:
- **Limits.** `ai::Quota` (`ai.rs:410`) and `ai::ExplainLimits` (`ai.rs:501`) are in memory with the
  numbers it gives. A suggestion run takes from the quota only when there's at least one line to send
  (`ai.rs:939`), and an explanation takes from every limit or from none (`ai.rs:583`).
- **Usage.** `anthropic::usage_of` (`anthropic.rs:97`) and `openai_compatible::usage_of`
  (`openai_compatible.rs:67`) add each response's tokens to a `Mutex<Usage>` before the answer is read, so
  a refusal or a bad answer still counts. Network and HTTP-status errors have no body and count nothing.
  `eval::run` diffs `usage()` before and after (`eval.rs:179`, `:250`). `Prices::cost` (`eval.rs:154`)
  prices tokens in micro-dollars, rounded half up.
- **The OpenAI-compatible adapter has no `explain`**, so on that provider Explain better always fails as
  `ai_failed` (the trait's default, `lib.rs:98`).
- **Impersonation.** `record_suggestions` is on `ALLOWED` (`impersonation.rs:108`). The **routes** need
  changes too: `access::route_while_acting` makes both `POST .../ai-suggestions` and `POST .../explain`
  `NeedsChanges` (`access.rs:717`). So moving `record_suggestions` alone wouldn't let an overseer ask
  without "Allow changes". Today Explain better needs "Allow changes" too.
- **Guests.** Explain better is open to guests (`guests.rs:262`) and suggestions aren't (`guests.rs:274`).
  `docs/security.md` still says "no AI suggestions are made for a guest… The AI routes and commands are
  refused for guests" (lines 171–173, "What never leaves"), and its guests row says "No AI". That's
  out of date since M21; it needs correcting outside this ADR's new rows.
- **Plans.** The pricing page lists Free, Owner, Practice and Practice Plus
  (`apps/web/src/pages/PricingPage.tsx:21`, `:39`, `:47`, `:62`). Nothing on the server records a plan.

### Not covered by the milestone as written
Two parts of the milestone's section 4 collide with accepted ADRs (see 8):
- **Businesses with suggestions switched off.** Off means "stops all requests" (ADR 011, Consent; the
  privacy notice), and ADR 013 puts `set_ai_suggestions` on `NEVER` because whether a business's lines go
  to the provider is the owner's choice. `suggest` (`ai.rs:929`), `record_suggestions` (`ai.rs:226`) and
  `explain_card` (`ai.rs:1198`) all refuse when it's off.
- **Guests' trials.** Nobody but its guest can see an unsaved trial, an overseer included
  (`access::can_see`, `access.rs:233`; ADR 014, 1), and nobody can view as a guest (`may_act_as`,
  `impersonation.rs:223`). An overseer can't open a trial at all, so there's nothing there to ask the AI
  about.

## Decision

### 1. One path to a model
- **The wrapper.** `crates/server/src/ai_usage.rs` holds `pub struct Metered { inner: Arc<dyn Suggester>,
  prices: Option<Prices> }`, with a private `inner`. `AppState::suggester` becomes
  `Option<Arc<ai_usage::Metered>>`. `suggester_from_env` moves into `ai_usage.rs`. Tests build one with
  `Metered::new(Arc<dyn Suggester>)`. That wraps a suggester; it doesn't call one. Outside `ai_usage.rs`,
  `Metered` offers only `provider()`, `model()` and the metered asks below, so nothing else in the server
  can reach `suggest` or `explain`. *Reason: the type system can't stop a crate from naming a public
  trait, but it can make sure nothing outside one file ever holds a value to call it on.*
- **A source check.** A test in `crates/server/tests/ai_usage.rs` reads every file in `crates/server/src`
  and fails if `Suggester`, `.suggest(` or `.explain(` appears outside `ai_usage.rs` and `main.rs`.
  *Reason: it catches a raw `Arc<dyn Suggester>` being threaded back in later, which the types alone
  wouldn't.*
- **`acctd ai-eval` stays unmetered.** It's an operator's tool on the synthetic set, run on purpose,
  printing its own cost. It never runs in the server and never has a business or user, so there's no row
  it could write. *Reason: metering is about what users can push up.*
- **Per-call usage.** The trait's two methods return each call's own usage with its answer:
  ```rust
  pub struct Call<T> { pub result: Result<T, AiError>, pub usage: Usage }
  pub type SuggestFuture<'a> = Pin<Box<dyn Future<Output = Call<Vec<RawSuggestion>>> + Send + 'a>>;
  pub type ExplainFuture<'a> = Pin<Box<dyn Future<Output = Call<String>> + Send + 'a>>;
  ```
  Usage is filled in whenever a response body came back, including `Refused` and `BadResponse`, and is
  zero for `Network` and `Status`. The `usage()` method and both adapters' `Mutex<Usage>` go. `eval::run`
  adds up each `Call::usage`. *Reason: a running total can't say which ask spent what when two asks
  overlap, and the error case has to carry its tokens because it cost money.*
- **How an ask runs.** The ask is a handle, so every path ends in one row:
  1. `metered.begin(&state, AskCtx { kind, actor, client_id, address }) -> Result<Ask, CommandError>`
     works out the plan (4), checks the limits (5) and the budget (6), and returns the handle. A refusal
     writes its row (`refused_limit` or `refused_budget`) before returning the error.
  2. `ask.suggest(request)` / `ask.explain(request)` call the model, time the call and add up its usage.
  3. `ask.finish(Finish { outcome?, layers? }).await` works out the outcome and cost and writes the row.
  Every exit from `ai::suggest` and `ai::explain_card` after `begin` goes through `finish`. That includes
  an error from `record_suggestions` (the row then has `by_model = 0`). A test drives each path and counts
  rows.
- **What counts as an ask.** One press of "Suggest" that gets past the access check, the "AI isn't set up"
  check and the "turned off" check, or one press of Explain better on a card that exists. Those three
  refusals and a missing card write no row: they spend nothing and can't spend anything, and they're
  ordinary errors. A suggestion run with nothing left for the model (layers 1 to 3 answered every line)
  writes one `ok` row with no model, because that's what the AI share needs.

**The row each ask writes:**

| Ask | `kind` | `model`, tokens, cost, latency | `outcome` | Layer columns |
|---|---|---|---|---|
| Suggestion run, model called | `suggestion` | set, summed over the run's batches | see below | set |
| Suggestion run, nothing to send | `suggestion` | null / 0 / 0 / null | `ok` | set, `lines_asked = 0` |
| Suggestion run, refused | `suggestion` | null / 0 / 0 / null | `refused_limit` or `refused_budget` | set: the layers still ran |
| Explanation | `explain` | set | see below | null |
| Explanation, refused | `explain` | null / 0 / 0 / null | `refused_limit` or `refused_budget` | null |

**Outcome**, for an ask that called the model. A run's batches are combined, worst first:
- `error`: any call failed with `Network`, `Status` or `Unsupported`;
- else `invalid`: any call's answer was `BadResponse`, or the model answered at least one line and every
  answer in the run was dropped by `check_answers`;
- else `declined`: any call came back `Refused`;
- else `ok`.

*Reason: one outcome per ask keeps the table one row per ask. "Worst first" means a run that half failed
shows as a failure, which is what the error-share flag (7) is looking for.*

### 2. The table (`ai_usage`, migration 0016)

| Column | Type | Notes |
|---|---|---|
| `id` | `TEXT PRIMARY KEY` | UUIDv7 |
| `at` | `TEXT NOT NULL` | UTC, RFC 3339, when the row is written. Indexed with `kind` |
| `kind` | `TEXT NOT NULL CHECK (kind IN ('suggestion','explain'))` | M23 adds `invoice_read` through its own migration, which rebuilds the check |
| `business_id` | `TEXT NOT NULL` | **No foreign key**, so an expired trial's rows stay as counts (see 3). Indexed with `at` |
| `user_id` | `TEXT NULL` | The **real** user (the overseer while acting); null only for the server. Indexed with `at` |
| `plan` | `TEXT NOT NULL CHECK (plan IN ('guest','free','owner','practice','practice_plus'))` | From `plan_of` (4) |
| `is_overseer` | `INTEGER NOT NULL CHECK (is_overseer IN (0,1))` | The real user is an overseer |
| `acting_as` | `TEXT NULL` | The effective user while viewing as someone (M19) |
| `model` | `TEXT NULL` | The model id, null if no call was made |
| `model_calls` | `INTEGER NOT NULL DEFAULT 0` | Requests sent, failed ones included |
| `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` | `INTEGER NOT NULL DEFAULT 0` | Summed over the ask's calls |
| `cost_micro_usd` | `INTEGER NULL` | Null when the model's prices are unknown (see below) |
| `latency_ms` | `INTEGER NULL` | The model calls' durations added up; null if none |
| `outcome` | `TEXT NOT NULL CHECK (outcome IN ('ok','declined','invalid','error','refused_limit','refused_budget'))` | |
| `lines_total`, `by_rules`, `by_history`, `by_merchants`, `lines_asked`, `by_model` | `INTEGER NULL` | Suggestion runs only. See below |

This differs from the milestone's column list in four places, each for a reason:
- **No `is_guest`**: `plan = 'guest'` says the same thing, and one fact belongs in one place.
- **`user_id` is kept for guests.** A guest is a real `users` row (ADR 014), and its stub outlives the
  trial. Keeping the id lets the overseer see one trial's asks. Null is kept for asks the server makes
  itself, of which there are none yet.
- **`model_calls` and the two cache-token columns** are added. The cost can't be checked against the bill
  without the cache tokens, and a 500-line run is 10 calls, not one.
- **`lines_asked`** is added. It's the number of lines sent to the model. Without it, "the model didn't
  answer" and "a pre-fill was already waiting" can't be told apart.

**Layer columns.** These are counted from the Save tax queue the run reads.
- `lines_total`: categorise cards in the queue.
- `by_rules`, `by_history`, `by_merchants`: those with a suggestion from layers 1, 2 and 3
  (`SuggestionSource`).
- `lines_asked`: those sent to the model.
- `by_model`: pre-fills this run stored (after `check_answers`, and after dropping lines sorted
  meanwhile).

Lines that already had an AI pre-fill waiting are `lines_total − by_rules − by_history − by_merchants −
lines_asked`.

**Never stored**, here or anywhere else M22 writes: prompts, responses, bank descriptions, card headings or
wording, explanation text, business or person names, the activity phrase, private names, IP addresses, and
the error's message (only the outcome). This is ADR 009's "With us" retention rule and ADR 011's, unchanged.
Every column above is an id, a time, a count, a model id or a short enum. Model ids and enum values are our
own strings, never the provider's free text.

**Prices.** Prices come from one function, `acct_ai::eval::Prices::from_vars(var, model)`: `AI_PRICE_INPUT`
and friends if set, otherwise `Prices::known`. It's moved out of `main.rs`, so the bake-off and the server
price tokens alike. The cost is priced once per ask, on its summed usage, with `Prices::cost`: half up, to
whole micro-dollars (US). It's stored, never recomputed, so a later price change doesn't rewrite history.
- With no prices for the model, `cost_micro_usd` is null.
- The server logs a warning at startup.
- The overseer view says "cost unknown" for those asks.
- **Decided (D2): fail closed.** With a budget cap set and no prices known for the model, every model call
  is refused as `refused_budget`, and the startup warning says why. *Reason: the cap exists to bound
  spend, and spend it can't see isn't bounded.*

### 3. Direct metering (decided)
- **One store function**, `acct_store::ai_usage::insert(&Store, &UsageRow)`, takes the writer connection
  for one short `INSERT` in its own transaction. It runs after the ask's last model call, with no
  transaction open during the call (ADR 009). For an explanation, that's before the text goes back to the
  browser; for a run, after `record_suggestions`.
- **It isn't a command.** `ai_usage` isn't practice or client data and nobody edits it. A command per ask
  would add a `seq` that wakes every browser's live refresh, and would need hiding from owners' Changes
  (hard rule 6, as amended). So it isn't in `command_log`, isn't in `GET /api/sync`, and isn't in
  `history.rs`.
- **The row is written after the call.** It isn't reserved before, because one write per ask is enough,
  and the milestone accepts two simultaneous asks overshooting a limit by one. A crash mid-call loses that
  one ask's row. That's acceptable for a spend limit.
- **A failed write** is logged as a warning, with the outcome but no content, and the answer still goes
  back. *Reason: a database that can't take one insert is failing everything else too, and refusing the
  owner's answer wouldn't help them.*
- **Backups include it.** `VACUUM INTO` (`crates/store/src/backup.rs`) and Litestream copy the whole
  database. The rows hold no content, so that's fine, and restored limits stay right.
- **Expiring a trial** (`expire_guest`) leaves its `ai_usage` rows, which have no foreign key. They are
  counts, a model id and two opaque ids, and `command_log` keeps the guest's user stub anyway. ADR 014's
  "compare every table before and after an expiry" test lists `ai_usage` as kept.
- **Retention, decided (D3): 400 days**, so there's a year-on-year comparison for pricing, then a daily
  direct `DELETE`. The delete is built later, not in M22; `NON-CODE-TODOS.md` tracks it.

### 4. Plans
- **The enum.** In `crates/server/src/ai_limits.rs`:
  `pub enum Plan { Guest, Free, Owner, Practice, PracticePlus }`, with serde and ts-rs as `snake_case`.
  These are the pricing page's four, plus `Guest`. *Reason: a guest's tighter explanation limit is then
  one more row in the table, not a flag the lookup has to special-case.*
- **`plan_of`.** `async fn plan_of(conn, actor: &Actor, client_id: &str) -> Result<Plan, CommandError>`
  runs on the effective identity:
  - an unsaved trial (`guests::guest_owner` is set) is `Guest`;
  - a practice user (admin, staff or viewer) asking on a client's business gets **the practice's plan**
    (decided);
  - an owner gets their business's plan;
  - an overseer as themselves gets the business's plan, as the owner would.
  Until billing records plans (M24), each of the last three answers is `Free`.
- **The limits table.** It's one `const`, keyed by plan and kind, and the numbers are per business per UTC
  day:

  | Plan | `suggestion` | `explain` |
  |---|---|---|
  | `Guest` | 0 (the route is refused anyway) | 2 |
  | `Free` | 1 | 5 |
  | `Owner` | 1 | 5 |
  | `Practice` | 1 | 5 |
  | `PracticePlus` | 1 | 5 |

  Every paid plan gets today's Free numbers, so nothing changes for anyone in M22. Changing a number is a
  one-line edit. `None` in a cell means no limit. **Decided (D1):** these numbers for now. The owner sets
  the paid plans' numbers when billing arrives (M24).
- **Env overrides.** The environment variables override only these cells:
  - `ACCT_AI_DAILY_LIMIT` → `(Free, suggestion)`;
  - `ACCT_AI_EXPLAIN_LIMIT` → `(Free, explain)`;
  - `ACCT_AI_EXPLAIN_GUEST_LIMIT` → `(Guest, explain)`.

  `0` or `off` still mean no limit. *Reason: staging and tests keep their knobs, and a paid plan's number
  never changes behind its back because someone set a Free override.*
- **Not per plan:**
  - the per-address explanation limit (`ACCT_AI_EXPLAIN_IP_LIMIT`, 10);
  - the global explanation cap (`ACCT_AI_EXPLAIN_GLOBAL_LIMIT`, 50, plus `…_PER_GUEST`, 2, per guest
    started in the last 24 hours);
  - the budget cap (6).

  These protect the service, not a plan.

### 5. Durable counting
- **What's counted.** `Quota` and `ExplainLimits` keep their names and lose their maps. They count today's
  rows from `ai_usage`, where today is the UTC calendar day, from 00:00 UTC, as now. A business's count for
  a kind is the rows with that `business_id` and `kind`, `at` today, `is_overseer = 0`, and an outcome
  other than `refused_limit` or `refused_budget`. Suggestion runs also need `model IS NOT NULL`, which
  keeps today's rule that only a run with lines to send spends the allowance. Errors count, as today,
  because the call was made.
- **The global cap** counts the same for `explain` across every business.
- **The per-address limit** stays in memory, because addresses aren't stored. A restart resets only that
  one. The other limits catch the same abuse.
- **The read.** Counting uses a reader connection, before `begin` returns. The index on
  `(business_id, kind, at)` keeps it to a few rows.
- **The view.** `AiSuggestionsView::daily_limit` and `remaining_today` come from the plan's cell and the
  count. They're `None` for an overseer.

### 6. The daily budget cap
- **The setting.** `ACCT_AI_DAILY_BUDGET_CENTS` is US cents, because the provider bills in US dollars. It's
  off when unset, `0` or `off`.
- **The check.** At `begin`, if today's `SUM(cost_micro_usd)` over all rows (overseers' included, since
  it's real money) is at least `cap × 10_000`, the ask is refused as `refused_budget` before any model call.
  It's checked once per ask, not per batch, so one long run may overshoot. That's the same tolerance as the
  limits.
- **Layers 1 to 3 keep working.** They're the Save tax queue's own suggestions and never pass through the
  wrapper. A refused run still writes its layer counts.
- **What the owner sees** (code `ai_budget`, HTTP 422 like `ai_daily_limit`, with no cost or amount):
  - Suggestions: "The experts are resting until tomorrow. Suggestions from your rules and earlier choices
    still show."
  - Explain better: "The experts are resting until tomorrow. Try Explain better again then."
- **What the overseer sees** in the flag list (7), with the figures from the server:
  - at 80%: "Today's AI spend is US$4.10, 82% of the US$5.00 daily budget."
  - once hit: "The daily AI budget of US$5.00 was reached at 14:32 UTC. Model calls are refused until
    00:00 UTC; 17 asks refused so far."

### 7. Spike flags
The thresholds are named constants in `crates/server/src/ai_watch.rs`, each with its own test.
- **What's counted.** Asks counted for spikes include refused ones, because refusals are what abuse looks
  like. Overseers' asks are left out of every flag and median, since support testing isn't a spike.
- **Medians.** These run over the **previous 7 whole UTC days**, or the previous 168 whole hours, with
  missing days or hours counted as 0. For an even count, the lower of the two middle values is used, so
  medians stay whole numbers.

| Constant | Value | Rule | Why |
|---|---|---|---|
| `SPIKE_MULTIPLE` | 3 | today's asks > 3 × the 7-day median **and** > the floor | Three times a normal day is clearly unusual, but not a busy Monday |
| `BUSINESS_FLOOR` | 10 asks/day | the floor for a business | A Free business can make at most 6 counted asks a day (1 + 5). 10 allows a few refused retries before a flag |
| `USER_FLOOR` | 15 asks/day | the floor for a user | A staff member works across several clients, so a little more |
| `HOUR_FLOOR` | 30 asks/hour | an hour over 3 × the platform's median hour **and** over this | Stops a quiet platform's 2 → 7 asks from flagging |
| `ERROR_SHARE_PCT` | 20 | `invalid` + `error` > 20% of today's asks that called a model | A provider's normal failure rate is a few percent. A model change or an attack is much higher |
| `ERROR_MIN_ASKS` | 10 | …and at least this many such asks today | Small samples are noise |
| `BUDGET_WARN_PCT` | 80 | today's cost ≥ 80% of the cap (only with a cap set) | Time to act before the refusals start |

- **New accounts.** With zero-filled days, a new account's median is 0, so it's compared to the floor
  alone, as the milestone asks, with no special case. The test covers a business created today.
- **The badge.** `flag_count` is the number of flags in the list. The Tools tab's badge shows it.

### 8. Overseer access
- **No limits for overseers.** An overseer is never refused by any limit or the budget cap. Their rows have
  `is_overseer = 1`, their own `user_id`, and `acting_as` when they're viewing as someone. Their asks don't
  use up the business's allowance (5).
- **Suggestions while viewing as someone.** These don't need "Allow changes":
  - `record_suggestions` moves to `WhileActing::Session`, and `SESSION`'s description becomes "allowed
    while acting even with changes off";
  - the `POST /api/businesses/{id}/ai-suggestions` route moves from `NeedsChanges` to `Allowed` in
    `access::route_while_acting`.
  *Reason: suggestions only pre-fill, and the logged command still carries `acting_as`.*
- **Explain better while viewing as someone.** Its route moves to `Allowed` too, because it stores nothing
  and changes no figures. The explanation goes only to the overseer's screen, and the row records it as
  the overseer's.
- **Accepting a pre-fill** is `code_bank_line(s)` with `via`. It stays on `ALLOWED`, so it still needs
  "Allow changes".
- **The access check is unchanged.** It runs on the effective identity, so while viewing as Sam the
  overseer can ask only on businesses Sam can see.
- **Decided (D4): the off switch still applies to overseers.** The milestone said every AI feature works
  for an overseer on a business with suggestions turned off. But ADR 011 promises "off stops all requests",
  and ADR 013 treats that switch as the owner's consent, which nobody may change in their name. Support can
  see that it's off, which is what a support question about it needs. The exemption from limits and the
  budget cap stands. This replaces the milestone's "including ones with suggestions switched off".
- **Decided (D5): guests' trials are out of M22.** An overseer can't open an unsaved trial (ADR 014, 1), so
  "including guests' trials" would mean reopening ADR 014. A guest's own Explain better asks are still
  recorded, and the overseer sees them as counts.

### 9. The read API
- **The route.** `GET /api/overseer/ai-usage`, with `RouteRule::Overseer`. It's checked as the effective
  identity, so an overseer viewing as someone is refused, like the trial counts.
  - **Decided (D6):** this path, not the milestone's `/api/admin/ai-usage`. It matches M21's
    `/api/overseer/trials`, and `admin` reads as "practice admin" here.
  - Practice admins, staff, viewers, owners and guests are refused (403).
- **Query parameters**, all optional:
  - `by=hour|day`: which series to return. Default `day`.
  - `business=<id>` or `user=<id>`: add that one's ask list. Not both (400 `malformed`).
  - `from`, `to`: RFC 3339 times bounding the ask list only. The default is the last 7 days, the most is
    90 days, and the list holds the newest 500.

The types are in `crates/server/src/ai_watch.rs`, with `#[derive(Serialize, TS)] #[ts(export)]`, and every
time is an RFC 3339 UTC string:

```rust
pub struct AiUsageView {
    pub generated_at: String,
    pub by: SeriesBy,                     // hour | day
    pub series: Vec<UsageBucket>,         // 48 hourly or 90 daily, oldest first, empty buckets included
    pub budget: Option<BudgetStatus>,     // None when no cap is set
    pub share: Vec<AiShareWeek>,          // ISO weeks, oldest first, up to 26
    pub top_businesses: Vec<TopRow>,      // up to 10, by today's asks, then cost
    pub top_users: Vec<TopRow>,           // up to 10
    pub flags: Vec<SpikeFlag>,
    pub flag_count: u32,
    pub asks: Option<AskList>,            // only with ?business= or ?user=
    pub prices_known: bool,
}
pub enum SeriesBy { Hour, Day }
pub enum AiKind { Suggestion, Explain }
pub enum AiOutcome { Ok, Declined, Invalid, Error, RefusedLimit, RefusedBudget }
// Plan is ai_limits::Plan.
pub struct UsageBucket {
    pub start: String,
    pub asks: u32,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_micro_usd: u64,              // unknown costs count as 0; see prices_known
    pub by_kind: Vec<KindCount>,
    pub by_outcome: Vec<OutcomeCount>,
    pub by_plan: Vec<PlanCount>,          // non-overseer asks only
    pub overseer_asks: u32,
    pub overseer_cost_micro_usd: u64,
}
pub struct KindCount { pub kind: AiKind, pub asks: u32, pub cost_micro_usd: u64 }
pub struct OutcomeCount { pub outcome: AiOutcome, pub asks: u32, pub cost_micro_usd: u64 }
pub struct PlanCount { pub plan: Plan, pub asks: u32, pub cost_micro_usd: u64 }
pub struct BudgetStatus {
    pub cap_cents: u32,
    pub spent_micro_usd: u64,             // today, UTC
    pub percent: u32,                     // whole percent, rounded down
    pub reached_at: Option<String>,
    pub refused_today: u32,
}
pub struct AiShareWeek {
    pub week_start: String,               // Monday, as a date (YYYY-MM-DD)
    pub iso_week: String,                 // e.g. "2026-W46"
    pub codings: u32,
    pub via_suggestion: u32,
    pub share_bp: Option<u32>,            // basis points; None when codings is 0
    pub layers: Option<LayerShares>,      // None before ai_usage has any suggestion row that week
}
pub struct LayerShares {
    pub lines_total: u32,
    pub rules_bp: u32, pub history_bp: u32, pub merchants_bp: u32, pub model_bp: u32,
    pub unanswered_bp: u32,               // the rest, so the five add to 10_000
}
pub struct TopRow {
    pub id: String,                       // business or user id
    pub name: String,                     // display name, read live; never stored in ai_usage
    pub asks_today: u32,
    pub cost_today_micro_usd: u64,
    pub median_7d: u32,
    pub change_pct: Option<i32>,          // vs the median; None when the median is 0
}
pub struct SpikeFlag {
    pub rule: SpikeRule,                  // business | user | hour | error_share | budget_warn | budget_hit
    pub subject_id: Option<String>,       // the business or user, if it's about one
    pub subject_name: Option<String>,
    pub value: u64,                       // what was seen (asks, or percent for the share and budget rules)
    pub threshold: u64,                   // what it was compared with
    pub message: String,                  // the server's plain sentence, as in 6
}
pub enum SpikeRule { Business, User, Hour, ErrorShare, BudgetWarn, BudgetHit }
pub struct AskList {
    pub subject: AskSubject,              // business | user
    pub id: String,
    pub name: String,
    pub rows: Vec<AskRow>,                // newest first
    pub truncated: bool,
}
pub enum AskSubject { Business, User }
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
    pub lines_total: Option<u32>, pub by_rules: Option<u32>, pub by_history: Option<u32>,
    pub by_merchants: Option<u32>, pub lines_asked: Option<u32>, pub by_model: Option<u32>,
}
```

- **Rates and money stay integers.** Shares are basis points and costs are micro-dollars, so no floats
  (hard rule 4).
- **Display.** The browser formats micro-dollars as US dollars through one new function in
  `apps/web/src/lib/money.ts`, `formatMicroUsd`, and adds nothing up. Agent 5's prompt should list
  `money.ts` as theirs to append to.
- **View as.** The **View as** button uses `AskRow::user_id`, or the business's owner, with M19's switcher.
  A business with no owner user has nothing to view as (ADR 013, 2), so the button isn't shown.

### 10. The AI share
- **Weeks.** These are ISO weeks in UTC, from Monday 00:00 UTC, read from `command_log`:
  - the rows with `kind IN ('code_bank_line','code_bank_lines')`;
  - with `redacted_seq IS NULL` (an expired trial's cleared payloads can't be counted);
  - outside a live unsaved trial (trials can't use suggestions, so they would only dilute the share).
- **Codings** are 1 for `code_bank_line`, and `json_array_length(payload, '$.lines')` for
  `code_bank_lines`. A line coded twice counts twice, because each coding was a decision.
- **Via a suggestion** is `json_array_length(via, '$.suggestion_ids')` where
  `json_extract(via, '$.kind') = 'suggestion'`. It counts lines, not commands, because one
  `code_bank_lines` can accept some pre-fills and code other lines by hand.
- **`share_bp`** is `via_suggestion × 10_000 / codings`, rounded down.
- **Layer shares** come from `ai_usage`'s suggestion rows that week, overseers' included, since those runs
  pre-fill real cards. They're the sum of each layer column over the sum of `lines_total`, in basis
  points, with "unanswered" taking the rest so the five add to exactly 10_000.
- **Before M22**, `ai_usage` has no rows, so `layers` is `None` for those weeks and the view says "not
  measured before <date>", never 0%. The AI share itself goes back as far as `command_log` does.

## Consequences
- **Migration `0016_ai_usage.sql`:** the table in 2, plus indexes on `(business_id, kind, at)`,
  `(user_id, at)` and `(at)`.
- **`crates/ai`:**
  - `Call<T>` and the new future types;
  - `usage()` and both adapters' running totals removed;
  - the fake returns a fixed per-call `Usage`, so tests can check costs;
  - `Prices::from_vars` added, and used by `main.rs`.
- **`crates/server`:**
  - `ai_usage.rs` (the wrapper, `suggester_from_env`, the row), `ai_limits.rs` (`Plan`, `plan_of`, the
    table) and `ai_watch.rs` (types, then reads and flags);
  - `AppState::suggester` becomes `Option<Arc<Metered>>`, and tests wrap the fake with `Metered::new`;
  - `Quota` and `ExplainLimits` read from the store, and `ai::view` becomes plan-aware;
  - the new error code `ai_budget`.
- **The route** `GET /api/overseer/ai-usage` (D6) is added to `lib.rs` and given
  `RouteRule::Overseer` in `access::route_rule`. `tests/tenancy.rs` picks it up.
- **Access and impersonation:**
  - `record_suggestions` moves from `ALLOWED` to `SESSION`, and `tests/impersonation.rs` is updated;
  - both AI `POST` routes move from `NeedsChanges` to `Allowed` in `route_while_acting`;
  - ADR 013's section 3 is amended to say so. Its "Routes" bullet on `ai-suggestions` no longer holds.
- **ts-rs types:** everything in 9, plus `Plan`. Run `make types`.
- **Guests:** `expire_guest` leaves `ai_usage` rows, and ADR 014's table comparison test lists them as
  kept.
- **`docs/security.md`:** new rows for M22. The out-of-date "no AI for guests" lines need a separate fix
  (see Context).
- **The privacy policy** says what's metered: counts, tokens, cost and outcome per ask, linked to the
  business and user, with no content. That's in `NON-CODE-TODOS.md`.
- **`NON-CODE-TODOS.md`:**
  - setting the limits per plan is already listed ("M22: set the daily AI budget cap… and the per-plan,
    per-kind daily limits");
  - this ADR adds the privacy line and the 400-day delete (D3).

## The owner's decisions (2026-11-09, every recommendation accepted)
- **D1.** The limits per plan and kind are the table in 4: every plan gets Free's numbers until billing.
- **D2.** A budget cap with unknown prices fails closed.
- **D3.** `ai_usage` is kept for 400 days. The delete is built later.
- **D4.** The off switch still applies to overseers.
- **D5.** Guests' trials are out of M22.
- **D6.** The route is `/api/overseer/ai-usage`.
