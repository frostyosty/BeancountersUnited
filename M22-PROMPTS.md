# M22: Watch the AI (usage, spikes and overseer access)

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M22 takes ADR 016 and
migration 0016. Start it once M21 is done (`m21_is_done` passes, the browser check is ticked, and M21's work is
committed, because "Explain better" is part of what M22 meters). M23 comes after M22.

## The milestone
Status: not started. Planned 2026-11-09. Decided 2026-11-09: usage is metered directly, not through commands (hard
rule 6 amended), and limits are keyed by plan.

**Why.** AI is the only part of the product with a running cost that users can push up, and the only one whose use we
can't see. M22 makes every AI ask a durable, countable fact, shows the overseer where the use is going and when it
spikes, sets limits per plan, and gives the overseer unrestricted use of the AI the users have.

**What exists today** (checked 2026-11-09, including M21's uncommitted work):
- Two features reach a model, both through the `Suggester` trait (`crates/ai/src/lib.rs`): suggestions
  (`ai::suggest`, behind `POST .../ai-suggestions`) and **Explain better** on a Save tax card (`ai::explain_card`, M21).
- Both limits are in memory, so a restart resets them. `ai::Quota`: suggestions per business per day
  (`ACCT_AI_DAILY_LIMIT`, 1 when unset). `ai::ExplainLimits`: per business 5, per trial 2, per client address 10, and a
  global 50 plus 2 per guest who started in the last 24 hours (`ACCT_AI_EXPLAIN_*`).
- The adapters add every call's tokens into one running `Usage` (`anthropic::usage_of`, `openai_compatible::usage_of`),
  and `eval.rs` prices tokens in micro-dollars. Nothing is per call, and nothing is stored.
- Guests can use Explain better (within the trial limit), but not suggestions.
- `record_suggestions` is `WhileActing::Allowed` in `impersonation.rs`, so an overseer viewing as someone needs
  "Allow changes" to ask for suggestions.
- The pricing page (`apps/web/src/pages/PricingPage.tsx`) lists four plans with sample prices: Free, Owner, Practice and
  Practice Plus. Paid plans are coming soon, but nothing in the server records which plan anyone is on yet.

**1. One record per ask (`ai_usage`, migration 0016).**
- An *ask* is one user action that may reach a model: one suggestions run, or one explanation. Each ask writes exactly
  one row, including asks the limits refused (those are what abuse looks like) and suggestion runs that layers 1 to 3
  answered without calling the model (those feed the AI share).
- Columns: `id`, `at` (UTC), `kind` (`suggestion | explain`; M23 adds `invoice_read`), `business_id`, `user_id` (null
  for a guest), `plan`, `is_guest`, `is_overseer`, `acting_as` (M19), `model` (null if none was called),
  `input_tokens`, `output_tokens`, `cost_micro_usd`, `latency_ms`, `outcome` (`ok | declined | invalid | error |
  refused_limit | refused_budget`), and for suggestion runs `lines_total`, `by_rules`, `by_history`, `by_merchants`,
  `by_model`. All integers or short enums.
- **Never stored:** prompts, responses, descriptions, card wording, names, IP addresses. This is ADR 009's retention
  rule, unchanged.
- **One path.** The raw `Suggester` becomes private to `crates/server/src/ai_usage.rs`; the rest of the server only gets
  a metered wrapper, so an unmetered call doesn't compile. The trait returns each call's own token usage with its
  answer, instead of the adapters totalling it.
- **Written directly, as metering** (decided). One store function writes the row after the call, in its own short
  transaction, not as a command: usage isn't practice or client data and nobody edits it, and a command per ask would
  add a `seq` that wakes every browser's live refresh and would need hiding from owners' Changes. Hard rule 6 in
  `CLAUDE.md` now says so.

**2. Limits per plan, surviving a restart, under a spend ceiling.**
- **Plans.** One function, `plan_of`, says which plan an ask falls under, and every limit is looked up by plan and kind
  in one table (`crates/server/src/ai_limits.rs`). Until billing records plans, `plan_of` returns Free for everyone and
  every plan gets today's numbers, so nothing changes for users in M22. The numbers per plan are the owner's call
  (`NON-CODE-TODOS.md`); changing them is a one-line edit. When a practice user asks on a client's business, the
  practice's plan counts (decided 2026-11-09), since it's the practice using it.
- `Quota` and `ExplainLimits` count today's (UTC) non-refused asks from `ai_usage` instead of from memory, and take
  their numbers from the limits table. The env vars stay as overrides for the Free plan. The per-address limit stays in
  memory, because addresses aren't stored.
- Two asks at once may overshoot a limit by one. That's acceptable for a spend limit.
- **Daily budget cap** (`ACCT_AI_DAILY_BUDGET_CENTS`, off when unset): once today's `cost_micro_usd` reaches it, model
  calls are refused as `refused_budget`, and layers 1 to 3 keep working because they're free. The owner sees plain
  wording with no cost, and the overseer view shows the cap was hit.
- **Overseers** have no limit and no cap. Their asks are still recorded, with `is_overseer` and `acting_as`.

**3. The overseer view** (Settings → Tools → AI usage, overseers only).
- Asks, tokens and cost by hour for 48 hours and by day for 90, split by kind, outcome and plan (cost per plan is what
  pricing needs).
- **AI share by week:** codings logged with `via.kind = "suggestion"` over all `code_bank_line(s)` codings, from
  `command_log`. Beside it, the share each layer (rules, history, merchants, model) answered, from `ai_usage`, which
  starts at M22. This says how much categorising the AI leads, and it should fall as businesses build up history.
- Top businesses and users by asks and cost, each with its change against its own 7-day median.
- **Spike flags**, listed on the page and counted in a badge on the Tools tab (no email or push yet):
  - a business or user over 3× its 7-day median asks and over a floor (so quiet accounts don't flag); a new account
    with no median is compared to the floor alone;
  - an hour over 3× the platform's median hour;
  - `invalid` or `error` over a set share of the day's model calls (a model change and an attack both look like this);
  - today's cost past 80% of the budget cap.
  Each threshold is a named constant in `crates/server/src/ai_watch.rs` with its own test.
- Click a business or user to see its asks (time, kind, outcome, plan, model, cost, layer counts), with a **View as**
  button that starts M19's impersonation. With no prompts stored, that list is the whole record.
- Served by `GET /api/admin/ai-usage` (`?by=`, `?business=`, `?user=`, `?from=`, `?to=`), checked in `access.rs`:
  overseers only. Owners still see only their own asks left, through the existing reads.

**4. Overseer access to the AI.**
- Every AI feature works on any business the overseer is viewing, including ones with suggestions switched off and
  guests' trials (for support). Nothing about it is silent: every ask is recorded as the overseer's.
- Asking for suggestions while viewing as someone doesn't need "Allow changes" (`record_suggestions` moves to
  `WhileActing::Session`), because suggestions only pre-fill and change no figures. Accepting one still needs it.

**Out.** Taking payment, recording which plan a business is on, and which features each plan unlocks (M24); alerts by email or push; storing anything that would let us read what was asked.

### Done when
`crates/server/tests/m22.rs` (`m22_is_done`) shows that:
- every suggestions run and every explanation writes exactly one `ai_usage` row with the right kind, user, business,
  plan, layer counts and outcome, refused asks included, and no description or card text is stored anywhere, nor
  anything in `command_log`;
- both daily limits survive a server restart, and the next ask after the limit is `refused_limit`;
- limits come from the plan table: a test plan with a different number is refused at that number;
- the budget cap refuses model calls but not layers 1 to 3;
- an overseer is never refused by either, is recorded as an overseer, and has `acting_as` when viewing as someone;
- the AI-share figures match a pinned set of codings;
- a business at 3× its median is flagged, one below the floor isn't, and a rise in `invalid` outcomes flags;
- practice admins, staff, owners and guests are refused `GET /api/admin/ai-usage`.

The web tests cover the charts, the spike badge, drilling into a business and **View as**. Then a browser check as an
overseer.

## Running it

Five waves of small agents. Opus only writes the ADR; the rest is Sonnet at the lowest thinking that suits the job.
- **Wave 1:** ADR 016. **Nothing in wave 2 starts until you've accepted it.**
- **Wave 2:** the table and per-call usage: mechanical groundwork.
- **Wave 3:** the metered path, plan limits, durable counting, the budget cap and the overseer exemption, plus the read
  endpoint's response types so wave 4 can run in parallel.
- **Wave 4:** two agents at once: the overseer reads, AI share and spike flags; and the overseer view in the web app.
- **Wave 5:** the done check.

Every agent reads the milestone section above first. Each prompt says which files the agent owns. Shared files
(`crates/server/src/lib.rs`, `commands.rs`, `access.rs`, `history.rs`, `impersonation.rs`'s lists,
`apps/web/src/App.tsx`, `apps/web/src/icons/registry.json`) are append-only except where a prompt says it owns them:
re-read just before editing, and add only your own lines. Don't hand-edit `packages/types`: run `make types`.

**Migration:** only Agent 2 adds one, 0016. If 0016 is taken by then, use the next free number and say so.

**Hard rules apply.** No prompt, response, description or card text is ever stored, logged or put in an error (ADR 009;
rule 1). Cost is integer micro-dollars and money is integer cents, never floats (4). The overseer view only renders the
server's figures; the browser adds nothing up. Emoji only in the chrome, never inside the numbers.

## Wave 1: start now

### Agent 1: ADR 016 (Opus, medium thinking)
```
Read CLAUDE.md (hard rules 1, 4 and 6, Roles), M22-PROMPTS.md (the milestone; its decisions are settled, so record them rather than reopening them), docs/decisions/009-ai-suggestions.md, 011-generalised-ai-requests.md and 013-impersonation.md, docs/security.md (the AI and overseer rows), crates/server/src/ai.rs (Quota, ExplainLimits, suggest, explain_card), impersonation.rs (WhileActing), access.rs, lib.rs (AppState), crates/ai/src/lib.rs, anthropic.rs, openai_compatible.rs and eval.rs (Usage, pricing), apps/web/src/pages/PricingPage.tsx (the plans).
You own:
- docs/decisions/016-ai-usage.md (new; check 016 is still the next free number)
- new rows in docs/security.md (Planned, M22)
- new items in NON-CODE-TODOS.md (append-only)
Task: first check the milestone's "What exists today" against the code: list every place that can reach a model, with file and line, and say plainly if anything isn't covered. Then write the ADR, status Proposed, recording the milestone's decisions and settling the rest. Give the reason for each choice in a sentence; mark anything that's my call DECISION FOR ME.
1. The single path: how the raw Suggester is unreachable except through the metered wrapper, how each call returns its own usage, and the row each kind of ask writes.
2. The columns and types, and what is never stored, checked against ADR 009. Where the price table lives (reuse eval.rs's); cost rounded once to micro-dollars.
3. Direct metering (decided): the store function, when it's written relative to the call, and that it isn't in command_log, the sync feed or Changes. Say whether ai_usage is in the backup.
4. Plans: the Plan enum (the pricing page's four, plus Guest if that's simpler than a flag), plan_of returning Free until billing exists, the limits table keyed by plan and kind, and the env vars as Free-plan overrides. When a practice user asks on a client's business, the practice's plan counts (decided). Add "set the AI limits per plan" to NON-CODE-TODOS.md.
5. Durable counting from ai_usage, the UTC day, the per-address limit staying in memory.
6. The budget cap, with the exact wording the owner and the overseer see.
7. The spike thresholds: each number, the floor and the reason, and the new-account case.
8. The overseer exemption, and what explain_card and accepting a pre-fill do while viewing as someone.
9. The read API: exact JSON shapes of GET /api/admin/ai-usage and its filters, named as Rust types, for wave 3 to define.
10. The AI-share query per ISO week in UTC, and what the layer shares show before M22.
Then list the consequences: migration 0016, the route, the access and impersonation changes, the types, and any privacy policy line (as a NON-CODE-TODOS.md item).
Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted ADR 016

### Agent 2: the table and per-call usage (Sonnet, medium thinking)
```
Read CLAUDE.md, M22-PROMPTS.md (the milestone), docs/decisions/016-ai-usage.md (accepted), crates/store/src/lib.rs and ai.rs, crates/store/migrations/0006_ai.sql, crates/ai/src/lib.rs, fake.rs, anthropic.rs, openai_compatible.rs, eval.rs, leak_tests.rs.
You own:
- crates/store/migrations/0016_*.sql (new) and crates/store/src/ai_usage.rs (new): insert one row, and the counting queries the ADR names (today's non-refused asks by business, user and kind; today's cost)
- the per-call usage change in crates/ai: the Suggester's methods return each call's usage with the answer; both adapters and the fake; eval.rs uses the new return instead of the running total
- the callers in crates/server that stop compiling because of that change: fix them minimally (Agent 3 rewrites them)
- crates/store/tests/ai_usage.rs (new)
Task: exactly the above, nothing in the server's behaviour changes yet. Integer columns as the ADR lists.
Tests: insert and count, including the UTC day boundary and refused rows not counting; each adapter's usage from the recorded responses in crates/ai/src/recorded/ is per call.
Run `make check`.
Don't commit.
```

## Wave 3: after Agent 2 has landed

### Agent 3: the metered path and limits (Sonnet, high thinking)
```
Read CLAUDE.md, M22-PROMPTS.md (the milestone), docs/decisions/016-ai-usage.md, crates/store/src/ai_usage.rs (Agent 2's), crates/server/src/ai.rs, lib.rs, impersonation.rs, access.rs, crates/server/tests/ai.rs and m11.rs.
You own:
- crates/server/src/ai_usage.rs (new): the metered wrapper and recording
- crates/server/src/ai_limits.rs (new): Plan, plan_of, the limits table
- crates/server/src/ai_watch.rs (new), containing only the response types for GET /api/admin/ai-usage from the ADR, with ts-rs derives (Agent 4 fills in the rest)
- the changes to ai.rs and lib.rs that route every ask through the wrapper; impersonation.rs: moving record_suggestions
- crates/server/tests/ai_usage.rs (new)
Task:
1. The metered wrapper: the only way to reach a model, so an unmetered call doesn't compile. Suggestions and Explain better both go through it. List every call site you changed.
2. One row per ask, written directly after the call, refused asks included, layer counts for suggestion runs, plan from plan_of.
3. Quota and ExplainLimits count from ai_usage and take their numbers from the limits table; the env vars override the Free plan; the per-address limit stays in memory.
4. The budget cap; the overseer exemption with is_overseer and acting_as.
5. The response types, then `make types`.
Tests: each kind writes exactly one row with the right fields, including a refused ask and a run answered without the model; a search of ai_usage and command_log for a known description and card wording finds neither; both limits survive a restart (rebuild the server state on the same database) and the next ask is refused_limit; a test plan with a different limit is refused at that number; the cap refuses model calls but not layers 1 to 3, with plain wording and no cost; an overseer is never refused and is recorded as one, with acting_as.
Run `make check`.
Don't commit.
```

## Wave 4: after Agent 3 has landed (both at once)

### Agent 4: the overseer reads, AI share and spike flags (Sonnet, high thinking)
```
Read CLAUDE.md, M22-PROMPTS.md (the milestone), docs/decisions/016-ai-usage.md, crates/server/src/ai_usage.rs, ai_watch.rs (Agent 3's types: implement against them, don't change their shape), crates/store/src/ai_usage.rs and log.rs, crates/server/src/trial_counts.rs (M21's overseer read, as the pattern), access.rs, lib.rs, crates/server/tests/ai_usage.rs and tenancy.rs.
You own:
- crates/server/src/ai_watch.rs (everything except the response types' shape) and any read queries it needs in crates/store/src/ai_usage.rs (append-only)
- its route lines in lib.rs and access.rs (append-only)
- crates/server/tests/ai_watch.rs (new)
Task:
1. GET /api/admin/ai-usage with the ADR's filters: by hour (48 hours) and by day (90 days), split by kind, outcome and plan; top businesses and users with their change against their own 7-day median; one business's or user's ask list. Overseers only, checked in access.rs.
2. The AI share by week exactly as the ADR defines it, beside each layer's share.
3. The spike flags, each threshold a named constant with its own test, including the floor and the new-account case, and the flag count for the badge.
Tests: the AI share matches a pinned set of codings built through commands, not SQL; a business at 3x its median is flagged and one below the floor isn't; a rise in invalid outcomes flags; the budget flag at 80%; practice admins, staff, owners and guests are refused.
Run `make check`.
Don't commit.
```

### Agent 5: the overseer view in the web app (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji, Reports), apps/web/src/ui/README.md, M22-PROMPTS.md (the milestone), docs/decisions/016-ai-usage.md (the read API), apps/web/src/pages/SettingsLayout.tsx (ToolsTab and the overseer panels), apps/web/src/components/TrialCounts/ (the pattern), apps/web/src/components/ActingBanner/ and the existing View as switcher, apps/web/src/auth.ts, apps/web/src/lib/money.ts, and the generated types from Agent 3 in packages/types.
Agent 4 is building the endpoint at the same time: build against the generated types and mock the fetch in tests. Don't touch crates/.
You own:
- apps/web/src/components/AiUsage/ (new)
- its one-line mount in SettingsLayout.tsx's ToolsTab, and the badge on the Tools tab
- new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. Settings → Tools → AI usage, rendered for overseers only (nothing at all for anyone else).
2. Asks, tokens and cost by hour and by day, split by kind, outcome and plan. Follow the dataviz skill; colours only from tokens, light and dark; every chart has a text table alternative.
3. The AI share by week beside each layer's share, with one plain sentence saying what it means.
4. Top businesses and users with their change against the median; the spike flags with the rule that fired; the badge count.
5. Click a business or user for its ask list, with a View as button that reuses the existing switcher.
6. Render the server's figures only; cost in dollars through lib/money.ts.
Testing Library tests: shown for an overseer, absent for a practice admin, owner and guest; the charts and their tables; the flags and the badge; drilling in; View as; the empty state when there's been no AI use.
Run `make check`.
Don't commit.
```

## Wave 5: after Agents 4 and 5 have landed

### Agent 6: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M22-PROMPTS.md ("Done when"), docs/decisions/016-ai-usage.md, crates/server/tests/ai_usage.rs, ai_watch.rs, ai.rs, impersonation.rs and tests/common/mod.rs.
You own:
- crates/server/tests/m22.rs (new)
Task: write `m22_is_done`, using the fake suggester, so that it checks each "Done when" bullet in turn. Reuse the helpers in tests/common rather than copying the other tests' setup.
Run `make check`.
Don't commit.
```

## When all of them are done

Check `make check` passes, then in a browser on staging:
- As an owner, ask for suggestions until the daily limit refuses one; restart the server; it still refuses. Do the same
  with Explain better.
- As an overseer, open Settings → Tools → AI usage: the asks appear, the AI share reads sensibly, and a deliberately
  hammered test business is flagged and counted in the badge. Click it, then View as.
- As the overseer, ask for suggestions on a business with suggestions switched off: it works, isn't refused, and shows
  as an overseer's ask.
- Set `ACCT_AI_DAILY_BUDGET_CENTS` very low on a test server: model calls are refused with plain wording, and rules,
  history and merchant suggestions still appear.

Tick M22's status here and in `PLAN.md`. Add the browser check to `NON-CODE-TODOS.md` if it's left for later.
