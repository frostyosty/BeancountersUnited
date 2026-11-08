# M24: Plans and billing

This file is the whole milestone: the plan first, then the agent prompts. `PLAN.md` points here. M24 takes ADR 018 and
migration 0018. It needs M22 (the plan-keyed limits and `plan_of`). It comes after M23 because both change the limits
table and the upload path; if billing becomes more urgent, it can run before M23 instead, but not alongside it.

## The milestone
Status: not started. Planned 2026-11-09. Decided 2026-11-09: practice plans are set by hand for now, Save tax stays
free, the pricing page drops editable history and the retention difference, Stripe is the provider, a failed payment gets
14 days' grace, and a downgrade deletes nothing (the owner picks which business stays editable). ADR 018 records these and settles the details.

**Why.** The pricing page (`apps/web/src/pages/PricingPage.tsx`) offers four plans with sample prices: Free ($0),
Owner ($4.99 a month), Practice ($9.99 a month, up to 25 clients) and Practice Plus ($24.99 a month, unlimited
clients), in NZD and GST inclusive. Nothing in the product takes money or knows anyone's plan. M24 lets an owner pay
for a plan, makes `plan_of` return the real plan, and enforces each plan's limits, without ever holding card details or
deleting anyone's data.

**What exists today:**
- M22's `crates/server/src/ai_limits.rs`: a `Plan` enum, `plan_of` (returns Free for everyone), and AI limits by plan
  and kind. M23 adds invoice-upload limits there.
- The pricing page's tiers are hard-coded in the web app, and its prices are marked as samples.
- The server has one practice. Practice users are made by an admin, and charts, templates and paragraphs are
  practice-wide. Self-serve practices need practice tenancy (backlog; ADR 015 section 8 says what it would take).

**1. Who pays, for what.**
- **Owners:** Free and Owner. A plan belongs to the owner's user account and covers every business they own, so
  `plan_of(business)` is its owner's plan. A guest is the `Guest` plan; claiming the trial starts them on Free.
- **Practices:** Practice and Practice Plus are billed per practice, but there's only one practice until tenancy
  exists. **Decided:** in M24, practice plans are set by an overseer by hand (`set_plan`) for deals made outside the
  app, and self-serve practice billing waits for tenancy. The pricing page's practice tiers say "Talk to us" until
  then.
- When a practice user works on a client's business, the practice's plan sets the AI limits (decided for ADR 016).

**2. Plans live in one place.** `ai_limits.rs` becomes `crates/server/src/plans.rs`: each plan's price (integer
cents, NZD, GST inclusive), billing period, limits (businesses, clients, AI asks by kind, invoice uploads) and features.
The pricing page reads them from a public `GET /api/plans`, so the page and the server can't disagree. Prices are the
owner's decision (`NON-CODE-TODOS.md`); changing one is an edit to `plans.rs` plus the matching price in the payment
provider.

**3. The pricing page's promises, checked.** ADR 018 goes through every perk and says whether M24 enforces it, it's
already true, or it should come off the page. Decided:
- **Save tax stays on Free.** M20 and M21 built the whole funnel on letting guests and free owners save tax. The paid
  perks are the ones that cost us money or time: more AI asks, more businesses, unlimited invoice reads. "Save tax
  walkthrough" moves to the Free column.
- **"Editable history of who changed what" comes off.** It clashes with posted journals never changing and the log
  being append-only.
- **No retention difference.** M24 deletes nothing; retention by plan is a later decision with legal advice (NZ
  requires seven years of records), so both "Seven year data retention" and "Unlimited data retention" come off.
- **"Up to 100,000 invoice uploads"** on Free reads oddly beside "Unlimited" on Owner; the number is the owner's call
  (`NON-CODE-TODOS.md`).
- The FAQ's "They'll only stay this low" is a promise about future prices; it goes to the owner as a
  `NON-CODE-TODOS.md` item.
- "1 business" (Free) and "Up to 3 businesses" (Owner) are enforced in M24.

**4. Taking payment.**
- A payment provider behind a `Billing` trait in a new crate, `crates/billing`, with a fake for tests, as ADR 007 has
  for every outside service. **Decided: Stripe**, because it supports NZD, GST-inclusive prices, hosted Checkout and a
  hosted customer portal, so card details never touch our server.
- Upgrading sends the owner to the provider's hosted checkout; managing or cancelling uses its hosted portal. No card
  fields in our UI.
- The provider tells us what happened through a webhook. The server checks the signature, then turns each event into a
  command (`apply_billing_event`), validated like anything from the UI and idempotent by the provider's event id.
  The provider's word is input, not truth: the command checks the plan and price against `plans.rs`.
- Our own tax invoices to customers come from the provider, with our GST number (`NON-CODE-TODOS.md`: GST registration
  of the business that sells the service).

**5. Changing plans never loses data.**
- **Upgrading** takes effect when the provider confirms payment.
- **Downgrading or cancelling** takes effect at the end of the paid period. **Payment failing** gives a grace period
  (14 days, decided) with a banner, then the account returns to Free.
- **Over a limit after a downgrade** (for example three businesses on Free), decided: nothing is deleted or hidden; every business stays readable and exportable, and the owner picks which one stays editable until
  they upgrade again. Filing with IRD is never blocked for a business that was editable when its period ended.
- Every plan change is a command, so it appears in Changes ("Plan changed to Owner") and in the overseer's view.

**6. Enforcement.** Each limit is checked in the server where the action happens, with plain wording and an upgrade
link: creating or claiming a business past the plan's count, AI asks (M22), invoice uploads and reads (M23). The web
never decides what a plan allows; it renders what the server says.

**7. The overseer.** Settings → Tools → Plans: each paying account, its plan, status (active, past due, cancelling) and
next renewal, plus counts by plan (feeding M22's cost-per-plan view). `set_plan` sets a plan by hand, with a reason
that's logged, for practice deals, comps and fixing a stuck subscription.

**Out.** Self-serve practice billing (waits for tenancy), annual billing, coupons and trials of paid plans, usage-based
charges, refunds through the app (the provider's dashboard handles them), and retention by plan.

### Done when
`crates/server/tests/m24.rs` (`m24_is_done`), with the fake billing provider, shows that:
- `GET /api/plans` returns the plans from `plans.rs`, and the pricing page renders from it;
- a checkout-completed event moves an owner to Owner, `plan_of` returns it for each of their businesses, and the AI and
  upload limits change to Owner's;
- a replayed event changes nothing; an event with a bad signature, or naming a price that isn't in `plans.rs`, is
  refused;
- cancelling keeps the plan until the period ends, then returns to Free; a failed payment returns to Free only after
  the grace period;
- a Free owner can't create or claim a second business, and after a downgrade from three businesses nothing is deleted
  and exactly one stays editable;
- `set_plan` is overseer-only, needs a reason, and shows in Changes;
- no card number or provider secret appears in the database, logs or any response.

The web tests cover the pricing page from the API, upgrade and manage buttons, the past-due banner and the over-limit
choice. Then a check in the provider's test mode on staging.

## Running it

Five waves of small agents. Opus only writes the ADR; the rest is Sonnet at the lowest thinking that suits the job.
- **Wave 1:** ADR 018. **Nothing in wave 2 starts until you've accepted it.**
- **Wave 2:** two agents at once: the plans table and `GET /api/plans`; and the billing crate (trait, provider adapter,
  fake, signature checks).
- **Wave 3:** the server: subscriptions, the commands, checkout, portal and webhook routes, plan changes over time.
- **Wave 4:** two agents at once: enforcing the limits across the server; and the web (pricing page, billing settings,
  banners, the overseer's Plans panel).
- **Wave 5:** the done check.

Every agent reads the milestone section above first. Each prompt says which files the agent owns. Shared files
(`crates/server/src/lib.rs`, `commands.rs`, `access.rs`, `history.rs`, `impersonation.rs`'s lists, `guests.rs`'s lists,
`Cargo.toml` workspace members, `apps/web/src/App.tsx`, `apps/web/src/icons/registry.json`) are append-only except
where a prompt says it owns them: re-read just before editing, and add only your own lines. Don't hand-edit
`packages/types`: run `make types`.

**Migration:** only Agent 4 adds one, 0018. If 0018 is taken by then, use the next free number and say so.

**Hard rules apply.** Prices are integer cents, never floats (4). Every plan change is a command; the webhook is input
to one (6). The provider's secret key and webhook secret come from the environment and never appear in logs, errors or
responses, and card details never reach our server. Tests use the fake provider and recorded payloads with invented
customers; no network in CI (ADR 007). The overseer is never shown card details, only plan and status.

## Wave 1: start now

### Agent 1: ADR 018 (Opus, high thinking)
```
Read CLAUDE.md (hard rules 4 and 6, Roles, Architecture's outside services), M24-PROMPTS.md (the milestone), PLAN.md (Open questions, Backlog), docs/decisions/007-online-service.md, 008-hosting.md, 015-taste-then-sign-up.md (section 8, tenancy) and 016-ai-usage.md, docs/security.md, apps/web/src/pages/PricingPage.tsx, crates/server/src/ai_limits.rs, signup.rs, guests.rs (claiming), access.rs, impersonation.rs.
You own:
- docs/decisions/018-plans-and-billing.md (new; check 018 is still the next free number)
- new rows in docs/security.md (Planned, M24)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed. The milestone's "Decided" items are settled: record them with their reasons and don't reopen them. Give the reason for each other choice in a sentence; mark anything that's still my call DECISION FOR ME.
1. Who holds a plan (owner account, practice), plan_of for each kind of business (owned, guest, example, a practice's client, where the practice's plan counts), and how claiming a trial starts Free.
2. Practice plans set by an overseer only, and the pricing page's "Talk to us" wording meanwhile.
3. The pricing page audit: every perk, marked enforced in M24, already true, or changed as decided, with the new wording.
4. plans.rs: the shape (price, period, limits, features), how ai_limits.rs folds into it, and the JSON of GET /api/plans (public, no sign-in).
5. Stripe (decided): its fees in NZ, the Billing trait's methods, and which Stripe objects we store (ids only).
6. Webhooks: which events we handle, signature checking, idempotency by event id, ordering (events can arrive late or twice), and what apply_billing_event validates against plans.rs.
7. Plan changes over time: upgrade, downgrade at period end, cancel, failed payment and the grace period, resubscribing. The states and their transitions, as a table.
8. Over a limit after a downgrade: what stays readable, editable and exportable, how the owner chooses, and that IRD filing is never blocked for a period that ended while editable.
9. Enforcement points: each limit, where it's checked, and the wording.
10. The commands (apply_billing_event, set_plan, choose_editable_business, and any others), their payloads, how each reads in Changes, and which are allowed while an overseer is viewing as someone.
11. The overseer Plans panel's read, and what's never shown (card details).
12. What a person must do: provider account, products and prices, webhook secret in Fly secrets, GST registration and the GST number on invoices, terms of service, refund policy, privacy policy (the provider as a processor). Add each to NON-CODE-TODOS.md.
Then list the consequences: migration 0018, the new crate and its dependency, the routes, the access and guest changes, the types.
Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted ADR 018 (both at once)

### Agent 2: plans table and GET /api/plans (Sonnet, medium thinking)
```
Read CLAUDE.md, M24-PROMPTS.md (the milestone), docs/decisions/018-plans-and-billing.md (accepted; follow it where it differs from the milestone), crates/server/src/ai_limits.rs and every file that uses it, lib.rs, access.rs.
You own:
- crates/server/src/plans.rs (new; ai_limits.rs folds into it as the ADR says, and every user of it moves over)
- the public GET /api/plans route, its lines in lib.rs and access.rs (append-only), and its response types with ts-rs derives
- crates/server/tests/plans.rs (new)
Task: plans.rs with each plan's price (integer cents), period, limits and features as the ADR lists, the AI and upload limits unchanged in value. plan_of still returns Free for now (Agent 4 wires it to subscriptions). GET /api/plans needs no sign-in. Then `make types`.
Tests: the route returns every plan with integer prices; it works signed out; every existing AI limit test still passes against plans.rs.
Run `make check`.
Don't commit.
```

### Agent 3: the billing crate (Sonnet, high thinking)
```
Read CLAUDE.md (Architecture's outside services), M24-PROMPTS.md (the milestone), docs/decisions/018-plans-and-billing.md (the provider, the trait, the webhooks), crates/ai/Cargo.toml and src/lib.rs (the pattern: a trait, adapters, a fake, recorded payloads, leak tests), the workspace Cargo.toml.
You own:
- crates/billing/ (new): the Billing trait, the provider adapter, a FakeBilling, webhook signature checking and event parsing into our own small enum, recorded payloads in crates/billing/src/recorded/ with invented customers
- its line in the workspace Cargo.toml (append-only)
- any new dependency (prefer plain HTTP with the reqwest already in the workspace over a provider SDK, if that's simple; say what you chose and why, for the commit message)
Task:
1. The trait: create a checkout session, create a portal session, and anything else the ADR lists. Ids only in what it returns.
2. Webhook signature checking (constant-time compare, timestamp tolerance) and parsing into our event enum; unknown events are ignored, not errors.
3. The fake: canned sessions and a way for tests to build signed events.
4. The secret key and webhook secret are read by the caller and passed in; never logged or put in an error.
Tests: each recorded payload parses to the right event; a bad signature, a stale timestamp and a tampered body are refused; secrets never appear in Debug output or errors.
Run `make check`.
Don't commit.
```

## Wave 3: after Agents 2 and 3 have landed

### Agent 4: subscriptions and plan changes (Sonnet, high thinking)
```
Read CLAUDE.md, M24-PROMPTS.md (the milestone), docs/decisions/018-plans-and-billing.md, crates/server/src/plans.rs (Agent 2's), crates/billing/ (Agent 3's), pipeline.rs, commands.rs, access.rs, history.rs, impersonation.rs, guests.rs (claiming), lib.rs (AppState), crates/store (users, log, migrations), crates/server/tests/tenancy.rs and impersonation.rs.
You own:
- crates/store/migrations/0018_*.sql (new) and crates/store/src/subscriptions.rs (new)
- crates/server/src/billing.rs (new): the checkout and portal routes, the webhook route, apply_billing_event, set_plan, choose_editable_business, the state transitions, and the overseer Plans read with its response types
- plan_of in plans.rs, now reading subscriptions
- the lines for the new commands and routes in commands.rs, history.rs, impersonation.rs, lib.rs and access.rs (append-only)
- crates/server/tests/billing.rs (new)
Task:
1. Migration 0018 and the store: subscriptions (provider ids only, plan, status, period end), processed event ids.
2. The routes: checkout and portal return the provider's hosted URL; the webhook checks the signature with crates/billing, then submits apply_billing_event, which validates against plans.rs and is idempotent by event id.
3. The state transitions exactly as the ADR's table, including period end and the grace period (the server's clock decides when a period has ended, not core).
4. set_plan (overseer only, reason required) and choose_editable_business.
5. plan_of reads the subscription; claiming a guest's trial starts Free.
6. The overseer Plans read, then `make types`.
Tests: checkout-completed moves an owner to Owner and plan_of follows for each business; a replayed event changes nothing; a bad signature or an unknown price is refused; cancel keeps the plan to period end, then Free; failed payment returns to Free only after the grace period; set_plan is overseer-only and in Changes; no secret or card detail in any stored row or response.
Run `make check`.
Don't commit.
```

## Wave 4: after Agent 4 has landed (both at once)

### Agent 5: enforcing the limits (Sonnet, medium thinking)
```
Read CLAUDE.md, M24-PROMPTS.md (the milestone, "Enforcement" and "Changing plans never loses data"), docs/decisions/018-plans-and-billing.md (the enforcement points and wording), crates/server/src/plans.rs, billing.rs, signup.rs, guests.rs, business.rs, ai_usage.rs, bill_reading.rs (M23), access.rs, crates/server/tests/tenancy.rs.
You own:
- the limit checks at each enforcement point the ADR lists (a few lines in each file, calling one function in plans.rs that you add), and the read-only rule for businesses that aren't the chosen editable one
- crates/server/tests/plan_limits.rs (new)
Task: every enforcement point in the ADR, each refusing with its plain wording and an upgrade hint, and the over-limit rule after a downgrade: everything stays readable and exportable, only the chosen business is editable, and IRD filing stays open for a period that ended while editable. Nothing is ever deleted.
Tests: a Free owner can't create or claim a second business; Owner's third is fine and a fourth isn't; after a downgrade from three, nothing is deleted, exactly one is editable, the others refuse writes with the wording, and filing a period that ended while editable still works; AI and upload limits follow the plan.
Run `make check`.
Don't commit.
```

### Agent 6: the web (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, M24-PROMPTS.md (the milestone), docs/decisions/018-plans-and-billing.md (the pricing page wording, the states, the API), apps/web/src/pages/PricingPage.tsx, SettingsLayout.tsx (and the overseer panels, TrialCounts and AiUsage as patterns), apps/web/src/lib/money.ts, and the generated types from Agents 2 and 4.
Agent 5 is adding the limit checks at the same time; you only render what the server returns. Don't touch crates/.
You own:
- PricingPage.tsx (now rendering GET /api/plans, with the ADR's perk wording)
- apps/web/src/components/Billing/ (new): the plan card in Settings, Upgrade and Manage buttons, the past-due and cancelling banners, the over-limit "choose which business stays editable" dialog, and the overseer's Plans panel
- their one-line mounts, and new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. The pricing page from the API; prices formatted through lib/money.ts; practice tiers as the ADR says.
2. Settings: the current plan, renewal or end date, Upgrade (to the checkout URL) and Manage (to the portal URL). No card fields anywhere.
3. Banners for past due (with the grace end date) and cancelling; a refusal from a limit shows the server's wording and an upgrade link.
4. The over-limit dialog, sending choose_editable_business through ConfirmDialog.
5. The overseer's Plans panel, overseers only.
Testing Library tests: the pricing page from mocked plans; Upgrade and Manage go to the returned URLs; each banner; the over-limit choice; the Plans panel shown only to overseers.
Run `make check`.
Don't commit.
```

## Wave 5: after Agents 5 and 6 have landed

### Agent 7: the done check (Sonnet, low thinking)
```
Read CLAUDE.md, M24-PROMPTS.md ("Done when"), docs/decisions/018-plans-and-billing.md, crates/server/tests/plans.rs, billing.rs, plan_limits.rs and tests/common/mod.rs.
You own:
- crates/server/tests/m24.rs (new)
Task: write `m24_is_done` with the fake billing provider, checking each "Done when" bullet in turn. Reuse the helpers in tests/common rather than copying the other tests' setup.
Run `make check`.
Don't commit.
```

## When all of them are done

Check `make check` passes, then on staging with the provider in test mode:
- Sign up, upgrade to Owner with a test card: the plan shows in Settings, and the AI limit rises.
- Replay the webhook from the provider's dashboard: nothing changes twice.
- Cancel in the portal: the plan stays until the period ends (use the provider's test clock), then returns to Free.
- With three businesses on Owner, downgrade: nothing disappears, you're asked which stays editable, and the others are
  read-only with plain wording.
- As an overseer, set a practice plan by hand with a reason; it appears in Plans and in Changes.

Before going live, everything in M24's `NON-CODE-TODOS.md` section must be ticked (provider account, prices, terms,
refund and privacy policy, GST number on invoices). Tick M24's status here and in `PLAN.md`.
