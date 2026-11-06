# M20 agent prompts: try it on the home page, no sign-up

`PLAN.md` has the milestone ("M20 — Try it on the home page, no sign-up"): what the visitor sees on a desktop and a
phone, what happens on a drop, the guest starting position and the "Done when". Every agent reads it first.

The three example statements are already written: `fixtures/landing/` (three OFX files, `generate.py` that wrote
them, and a README saying what each covers). Don't hand-edit the OFX files; change `generate.py` and rerun it.

There are four waves.
- **Wave 1:** two agents at once: the ADR, and the examples on the server. **Nothing in wave 2 starts until you've
  accepted the ADR**, because the guest prompts build on its answers.
- **Wave 2:** two agents at once: the guest server side, and the home page's layout and drag and drop.
- **Wave 3:** two agents at once: wiring the home page to a guest, and guests inside the app.
- **Wave 4:** one agent writes the done check.

Each prompt says which files that agent owns. Shared files (`crates/server/src/lib.rs`, `crates/server/src/commands.rs`,
`crates/server/src/access.rs`, `apps/web/src/App.tsx`, `apps/web/src/icons/registry.json`) are append-only for
everyone except where a prompt says it owns them: re-read just before editing, and add only your own lines. Don't
hand-edit `packages/types`: run `make types`.

**Migration:** only Agent 3 adds one, 0014. M19 has 0013 reserved, so M20 takes 0014 even if M19 hasn't landed. If
0014 is taken by then, use the next free number and say so. Anyone else who thinks they need one stops and asks.

**Hard rules apply.** Starting, claiming and expiring a guest, and every upload and answer, are commands through
the pipeline (6). Real files a visitor drops land only on the hosted server: never in fixtures, tests, logs or
error reports (1). The example statements are synthetic and stay that way. Money only through `money.ts` (4); the
browser never works out a tax figure, it shows the server's.

**Build through `scripts/one-build.sh`** in a Codespace, workspace-wide (`cargo test -- guest`), never `-p`.

## Wave 1: start now (both at once)

### Agent 1: the ADR (Opus, high thinking)
```
Read CLAUDE.md (hard rules 1 and 6, Roles), PLAN.md (M20, and M12, M14 and M19), docs/decisions/007-online-service.md, 008-hosting.md, 009-ai-suggestions.md, docs/security.md, crates/server/src/signup.rs, crates/server/src/auth.rs, crates/server/src/access.rs, crates/server/src/pipeline.rs (Actor, and how sign_up runs with no session), crates/store/src/log.rs, crates/server/src/commands.rs (ImportStatement and its log redaction), crates/server/src/statement_files.rs, docs/domain.md ("The conservative figure and Save tax"), and fixtures/landing/README.md.
You own:
- docs/decisions/014-guests.md (new; check 014 is still the next free number after M19's reserved 013)
- the guest rows in docs/security.md (Planned, M20)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed, taking PLAN.md's starting position and settling each of these. Where you recommend something, say why in a sentence; where it's a real choice for me, list the options and mark it DECISION FOR ME.
1. What a guest is: a business_owner user with no credentials plus a business, made by `start_guest` on a public route (recommend), or a new role. Say what `GET /api/me` returns for one, and which routes and command kinds a guest may use (recommend a deny-by-default allowed list, like M19's, so a new command is refused for guests until someone adds it). Say what can't happen until claimed: inviting an accountant, AI suggestions, filing, changing a password that doesn't exist.
2. When a guest is made: on the first drop or "Use this example", never on a page view. What if the visitor already has a guest session and drops another file: same business (recommend for their own files), and what happens when they then use an example (recommend: a fresh guest business per example, so an example never mixes with real lines, and say how the old one is handled).
3. Business setup from a file alone: the start date and the balance date (31 March). GST is decided (2026-11-04); write it up and settle only the details:
   - Detect, then assume registered. A GST refund from IRD, or an IRD payment whose reference says GST, proves registration: treat the business as registered and say why ("We spotted a GST payment to IRD on 22 Oct, so we've treated you as GST registered. Not right?"). Infer the filing frequency from the payment dates where they show it. Statements can never prove someone isn't registered, so without proof assume registered and show "Assumed GST registered · change". Deposits over $60,000 a year only add a warning that registration is compulsory.
   - Why registered: with the same deposits it always gives the higher figure (unless the business makes a loss), so the figure stays conservative and answering "not registered" only brings it down. Check that claim against the tax engine and say so in the ADR.
   - No up-front question. "Are you GST registered?" is a Save tax card, ranked by its saving like every other card.
   - While registration is assumed, not confirmed, hold back GST-only questions (GST codes, supplier information over $200) and just categorise.
   - At Submit, if still unconfirmed: once M14 is built, IRD's filing obligations answer it (registered or not, and the frequency), and IRD's answer wins over the owner's. Before M14, ask "We couldn't tell if you're GST registered. Are you?" (and how often they file, if yes). When the figure changes there, say why ("IRD says you're not GST registered, so your tax dropped by $X").
   - How detection is recorded and changed: a command (for example `set_gst_registration` with a source of detected, owner or IRD), logged like any other.
   Name what core needs for it (today `looks_like_ird` in crates/core/src/bank.rs spots IRD lines but doesn't tell GST from income tax). The examples carry their own setup (fixtures/landing/README.md), and should come out detected for 1 and 3 and assumed for 2.
4. Claiming: `claim_guest { email, display_name, password }` keeps every line and answer; an email already in use is refused with "Sign in instead"; what happens to the guest's data if they sign in to an existing account instead (recommend: offer to move the business into that account, as a separate command, or leave it to expire; DECISION FOR ME).
5. Filing: PLAN.md has a guest reach the Submit screen with no sign-in. Filing itself (M14) needs a claimed account for the myIR authorisation and the stored filing. Recommend folding the claim into the Submit flow as its first step, so it's one screen, not a detour. DECISION FOR ME.
6. Expiry: how long an unclaimed guest lives (recommend 7 days from the last request), how it's ended (an `expire_guest` command the server submits from a sweep, as M19's timeout does, or on the next request), and exactly what's deleted: statement_files, statements, bank lines, journals, the business, the user, the sessions. command_log is append-only, and its payloads and changes for that business can hold descriptions and amounts from a real person's bank file. Options: redact those rows' payloads and changes in place (an explicit, documented exception, logged by expire_guest itself), keep guest commands out of the main log until claimed, or keep them unredacted. DECISION FOR ME; recommend, and say what the M13 Changes feed shows afterwards.
7. Privacy: the one line shown beside the drop zone (what leaves the browser, where it's processed, how long it's kept, that nobody looks at it), and what the privacy policy must add. Check whether IRD's terms or the Privacy Act need anything before a guest uploads, and put anything a person must do in NON-CODE-TODOS.md.
8. Abuse limits, with numbers: guests started per IP per hour, upload size, statements per guest, lines per guest, guests alive at once, and what the visitor sees when refused. Where per-IP state lives (in memory, like presence, is fine for one machine per ADR 008).
9. Examples: using one is `start_guest { example: 1..3 }` and the server imports its own embedded copy, so the browser never sends the bytes. Say whether example guests expire faster (recommend 1 day) and whether they count against the per-IP limit.
10. History: how a guest's changes read in Changes ("You (not saved yet)"), and that after claiming they read under the new name.
Then list the consequences: migration 0014 (for example users.claimed_at, users.guest_last_seen, businesses.example), the new commands, the new public routes, and the access changes.
Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

### Agent 2: the examples on the server (Sonnet, medium thinking)
```
Read CLAUDE.md, PLAN.md (M20), fixtures/landing/README.md and the three OFX files there, crates/import (the OFX parser and its tests), crates/server/src/business.rs, crates/server/src/save_tax.rs (queue), crates/server/src/tax.rs, crates/server/tests/m10.rs and m11.rs (how a business is set up and a statement imported in tests).
You own:
- crates/server/src/examples.rs (new) and its route line in lib.rs (append-only), plus `GET /api/examples` as Public in access.rs's route rules (one line)
- crates/import/tests/landing_examples.rs (new)
- crates/server/tests/examples.rs (new)
- fixtures/landing/README.md (the figures section only) and fixtures/landing/generate.py if a figure needs it
Task:
1. Parser test: each example parses with no warnings into the line count, period, account number and closing balance the README gives, and its balance check agrees. If one doesn't, fix the example (in generate.py) only when the file is wrong; when the parser is wrong, stop and tell me.
2. `examples.rs`: the three files embedded with include_bytes!, and for each: number, title, business, bank, the setup it implies (GST registered or not, from when, filing frequency, start date), the period, the parsed lines (date, description, amount in cents, as the parser gives them, for the preview), the closing balance, the raw text, and the conservative tax figure a fresh business gets from it. Work the figure out through the same path an owner's upload takes (set up a business, import, read the tax) in a throwaway in-memory store once at start-up, or say why another way is better; it must not be a second implementation.
3. `GET /api/examples` (public, no session, cached): that list. ts-rs types for it.
4. Tests (examples.rs): each example's conservative figure, and the figure after answering its top three Save tax cards in the queue's order with the answers the README implies, pinned as exact cents. Record those figures in the README's last section. Example 1's conservative figure is the one the home page's hero ticket will show; report it.
Run `make check`.
Don't commit.
```

## Wave 2: after you've accepted the ADR (both at once)

### Agent 3: guests on the server (Opus, high thinking)
```
Read CLAUDE.md, PLAN.md (M20), docs/decisions/014-guests.md (accepted; follow it where it differs from PLAN.md), crates/server/src/signup.rs, crates/server/src/auth.rs, crates/server/src/access.rs, crates/server/src/pipeline.rs, crates/server/src/commands.rs, crates/server/src/examples.rs (Agent 2), crates/store (users, sessions, log), crates/server/tests/tenancy.rs and crates/server/tests/m10.rs.
You own:
- crates/store/migrations/0014_guests.sql (new) and the store functions for guests
- crates/server/src/guests.rs (new): start_guest, claim_guest, expire_guest, the sweep, the per-IP limits; their lines in commands.rs and lib.rs (append-only)
- the guest rules in crates/server/src/access.rs and auth.rs (Me)
- crates/server/src/history.rs: one description per new command kind, and the "You (not saved yet)" wording, as the ADR says
- crates/server/tests/guests.rs (new)
Task:
1. Migration 0014 as the ADR lists. Append-only.
2. `POST /api/guest` (public): runs start_guest through the pipeline (as signup.rs runs sign_up with no session), then sets the session cookie. With `example`, it sets the business up as that example says and imports the server's own copy in the same command's transaction. Without one, it sets up the business as the ADR's answer to its question 3 (assumed GST registered) and the visitor's first file follows as an ordinary import_statement, after which GST detection runs as the ADR says.
3. Access: a guest is an owner of their one business, limited to the ADR's allowed list; every other command and route is refused with a plain reason ("Save your work first to invite your accountant.").
4. claim_guest, and the sign-in case the ADR settled. After claiming, the same session carries on signed in.
5. expire_guest and the sweep (tokio interval in the server, not core), deleting exactly what the ADR lists and doing to command_log exactly what it decided. The sweep submits through the pipeline as the server.
6. The abuse limits with the ADR's numbers, refusing with its wording.
7. Logs and errors never include a dropped file's contents or line descriptions (grep tracing calls on the import path).
Tests (guests.rs): starting a guest with and without an example; a guest's reads and writes on its own business work and on another's are refused (reuse the tenancy test's pattern); each refused command kind is refused; claiming keeps every line, answer and figure; claim with a taken email is refused; expiry deletes what it should and leaves other businesses byte-identical; the per-IP limit; and a test that iterates every command kind and fails if one isn't classified as allowed or refused for guests.
Run `make check`.
Don't commit.
```

**Agent 3: done 2026-11-06.** "Left" 1–4 below are finished: `crates/server/tests/guests.rs` (16 tests), types
unchanged, `fixtures/landing/README.md` re-pinned for the guest setup, `docs/domain.md` "GST registration from
statements", `docs/security.md` guest rows marked built, `ACCT_GUEST_FILES=warn` in `fly.staging.toml`, and
refusals by the in-memory limits are logged (limit and address, never the file). Wave 3 can start.

**Agent 3 progress (paused 2026-11-05). Kept for the record.**

Done (compiles, clippy clean; the whole existing suite passed before the last small edit to `auth.rs` login):
- `crates/store/migrations/0014_guests.sql`; `crates/store/src/guests.rs` (flags, `set_gst`, guest businesses, holding/totals, `delete_business`, `redact_log`, sessions helpers, `rename_client`, `move_owner`, `retire_guest`); `users.rs` gained `guest_since`, `claimed_at`, `is_guest()`, `claim`, `guests`; `log.rs` gained `redacted_seq` and `count_for_client`; `PRAGMA secure_delete = ON` on the writer.
- Core: `bank::ird_kind`/`IrdKind`, `tax::gst::detect_registration` (+ `DetectLine`, `GstDetection`, `DEFAULT_FREQUENCY`), `coding::without_input_tax`, with unit tests.
- `commands.rs`: `start_guest`, `add_guest_business`, `claim_guest`, `adopt_guest_business` (decision 4 B), `expire_guest`, `set_gst_registration`; `GuestSource`, `ExpireWhy`; file bytes hashed in the log. `error.rs`: `Guest` (403) and `Limited` (429 + `Retry-After`).
- `crates/server/src/guests.rs`: the commands, `GUEST_ALLOWED`/`GUEST_REFUSED`, the refusal step, route allow-list, GST detection after uploads (`redetect`), per-guest limits, in-memory per-address/per-minute `Limits` (in `AppState.guest_limits`), the sweep (every 10 min), `MeGuest`/`MoveableTrial`, routes `POST /api/guest`, `/api/guest/claim`, `/api/guest/adopt`.
- Wired: `pipeline.rs` (refusal step, apply chain, `after_apply`, `start_guest` logged as the guest, lock rules), `access.rs` (targets, `ServerOrClient`, trials hidden from everyone else incl. overseers, guard route check + 7-day sliding cookie), `auth.rs` (guest sessions, `Me.guest`, `Me.moveable_trial`, login refuses guests and keeps the guest token in `acct_guest`), `impersonation.rs` (lists, `may_act_as`), `presence.rs`, `history.rs` (descriptions, "You (not saved yet)", redacted rows hidden, `expire_guest` overseers only), `lib.rs` (routes, sweep, connect info).
- Save tax: no input tax while assumed (`Books::claimable`), the "Are you GST registered?" card (`Question::GstRegistered`, priced by `not_registered`), `repost_all` + `business::regenerate_all_gaps` for `set_gst_registration`; the missing-opening-balance reconcile card is skipped for unsaved trials.
- `examples.rs` now runs each example through `start_guest`; `tests/examples.rs` re-pinned: Examples 1 and 3 unchanged, Example 2 conservative $9,111.51 (assumed registered), then only income $3,520.36, GST registered: no $1,686.32, income tax paid $186.32.
- Existing tests updated: `history/tests.rs` samples, `tests/impersonation.rs`, `tests/tenancy.rs`, `tests/m15.rs`, `common/mod.rs`.

Left:
1. `crates/server/tests/guests.rs`, as the task lists. Plan for expiry: dump every table before the guest exists, start a trial, sweep at now + 8 days, and expect every table except `command_log`, `users` and `sessions` byte-identical; check no row outside `command_log` mentions the trial's ids, and no log payload holds its file name or descriptions. Use `fixtures/bank-statements/harbourlight-cheque-2025-08.ofx` as the visitor's own file. Login's `Set-Cookie` puts the session cookie first.
2. `make types`, then `make check` (fmt, clippy, tests, tsc). The web may need `Question` `gst_registered` handled.
3. `fixtures/landing/README.md`: figures and setup paragraph for the guest setup (Example 2 above; books from 1 April).
4. `docs/domain.md` "GST registration from statements" section; `docs/security.md` guest rows' status; `ACCT_GUEST_FILES=warn` in `fly.staging.toml` (not exposed to the web yet).

Report to the user as decisions or gaps: "Claim the GST" cards after confirmation not built; the "refund after you said not registered" notice not built; capacity limits answer 422 (`trial_full`, `file_too_big`), rate limits 429; guests may also read `/api/clients/{id}`, `/chart` and `/coding-settings` (the Save tax page needs the chart); `Actor.guest` not added (the pipeline looks the guest up); the GST card ranks by saving (9th for Example 2 at first, 2nd after "only income"); the reconcile-card skip for trials.

### Agent 4: the home page's layout and drag and drop (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji, money rules), apps/web/src/ui/README.md, PLAN.md (M20 "The home page" sections), docs/decisions/014-guests.md (question 7's privacy line), apps/web/src/pages/HomePage.tsx and HomePage.module.css, apps/web/src/ui/Modal, apps/web/src/lib/files.ts, apps/web/src/lib/money.ts, and the ExampleStatement type from Agent 2 (packages/types).
You own:
- apps/web/src/pages/HomePage.tsx and HomePage.module.css (the flow section; leave the hero ticket's behaviour to Agent 5 but give it a prop or handler to hook into)
- apps/web/src/components/TryIt/ (new): ExamplesPanel, ExampleCard, StatementPreview (the full-screen view), UploadDrop (the drop zone), and a `useTryIt` hook whose interface Agent 5 will implement
- new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. Desktop (wider than the existing 52rem breakpoint): the flow stays on the left and the ExamplesPanel sits in the space to its right, sticky while the flow scrolls: "Drag and drop an example OFX", with three ExampleCards from GET /api/examples. Each card looks like a small paper statement (bank, business, period, first four lines, "Example 1"), our own design from tokens; not a copy of any real bank's look (hard rule 3). Every example is visibly labelled as an example.
2. Clicking a card opens StatementPreview full screen: the statement as a table (date, description, money in, money out, closing balance) laid out like a bank statement, a "Raw file" tab with the OFX text in a scrollable monospace block, and Use this example. Money formatted only through money.ts.
3. Drag and drop: a card is draggable onto the Upload step's UploadDrop, which highlights while something is over it and accepts either a dragged card or files from the desktop. A Choose a file button too. Use this example (in the preview, and a small button on each card) does the same for keyboard and touch users. The privacy line from the ADR sits under the drop zone.
4. Phone (52rem and below): no panel; under the Upload step's text, links "Example 1", "Example 2", "Example 3", each opening StatementPreview.
5. useTryIt: an interface with { state, useExample(n), useFile(file), reset() } and a state machine of idle → uploading → working out the tax → ready (tax, top cards) | error. In this wave implement it as a stub that tests can drive; Agent 5 makes it real. The four steps render from that state: the Upload step shows the file name, bank, period and line count or the error; the other three show placeholders this wave.
Icons through <Icon> with text labels; colours from tokens; every interaction works with the keyboard. Testing Library tests: the panel on a desktop width and the links on a phone width, opening and closing the preview (including Escape), Use this example calling useExample, dropping a card, dropping a file, and the drop zone's highlight.
Run `make check`.
Don't commit.
```

## Wave 3: after Agents 3 and 4 have landed (both at once)

### Agent 5: wire the home page to a guest (Sonnet, high thinking)
```
Read CLAUDE.md, apps/web/src/ui/README.md, PLAN.md (M20 "What happens on a drop" and "The hero ticket"), docs/decisions/014-guests.md, apps/web/src/components/TryIt/ (Agent 4), apps/web/src/pages/HomePage.tsx, apps/web/src/pages/SaveTaxPage.tsx and SaveTaxCards.tsx, apps/web/src/pages/BusinessPage.tsx, apps/web/src/lib/useCommand.ts, apps/web/src/lib/queries.ts, crates/server/src/guests.rs (Agent 3) and the guest types in packages/types.
You own:
- the real useTryIt in apps/web/src/components/TryIt/
- the See your tax, Save tax and File tax steps' filled-in states in TryIt (new components there)
- the hero ticket's click in HomePage.tsx
Task:
1. useExample(n) posts /api/guest with the example; useFile(file) starts a guest if there isn't one, then sends import_statement as the upload screen does today. Then read the tax and the Save tax queue for that business.
2. See your tax: the loader with steps, shown for at least about two seconds from the drop even when the server is faster; with prefers-reduced-motion, no animation and a short wait. Then the figure, the "Counts every deposit as income…" line, and the GST note: why we treated them as registered, or "Assumed GST registered · change", as the ADR words it.
3. Save tax: the top three cards from the real queue, answerable in place by reusing SaveTaxCards' components (don't fork them); after each answer refetch the figure, show "saved so far", and move the queue on. See all opens /businesses/{id}/save-tax.
4. File tax: Review your return opens /businesses/{id}, the owner screen with Submit, and the claim step where the ADR put it.
5. The hero ticket is a button: its amount is Example 1's figure from GET /api/examples (formatted through money.ts), and clicking it runs useExample(1) and scrolls to the flow.
6. Errors: the parser's message for a bad file, the ADR's wording for a refused guest (limits), and a retry.
Testing Library tests with the API mocked: a drop runs the loader then shows the server's figure; answering a card updates the figure; See all and Review your return go to the right routes; the ticket loads Example 1; the minimum loader time, and the reduced-motion case; a bad file's error.
Run `make check`.
Don't commit.
```

**Agent 5: done 2026-11-06.** Real `useTryIt` (`POST /api/guest`, then the tax, Save tax queue and business reads),
`TryItSteps.tsx` (loader, figure, GST line, top three cards through `CardBody`, Review your return), the hero ticket,
`startGuest` in `api.ts`, `saveTaxKey` exported from `SaveTaxPage.tsx`, `TryItFlow.test.tsx` (16 tests). Gaps for the
others, none fixed here: (1) the web can't tell *why* a visitor's own file is treated as registered, since
`BusinessView` has no `gst_source` or evidence, so it says "Treated as GST registered" and the detected/assumed
wording appears only for the examples; (2) `/api/clients/{id}/asset-classes` isn't on `GUEST_ALLOWED` routes but the
categorise form reads it; (3) coming back to the home page as a guest starts empty (no resume from `Me.guest`);
(4) `make check`'s Rust half wasn't run (no Rust changed).

### Agent 6: guests inside the app (Sonnet, medium thinking)
```
Read CLAUDE.md, apps/web/src/ui/README.md, PLAN.md (M20 "Guests"), docs/decisions/014-guests.md, apps/web/src/App.tsx (signed-in and signed-out routes), apps/web/src/auth.tsx, apps/web/src/components/Layout.tsx, apps/web/src/components/SiteHeader.tsx, apps/web/src/components/HistoryPanel.tsx, apps/web/src/pages/BusinessPage.tsx, apps/web/src/pages/SignUpPage.tsx and the guest fields on Me (packages/types).
You own:
- apps/web/src/components/GuestBanner/ (new) and apps/web/src/components/ClaimForm/ (new)
- the guest lines in App.tsx, auth.tsx, Layout.tsx and SiteHeader.tsx
- the parts of BusinessPage.tsx that hide or explain what a guest can't do yet
Task:
1. A guest's session reaches /businesses/{id}, its Save tax page and Submit without a sign-in screen; other signed-in routes send them back to their business.
2. GuestBanner on every page a guest sees: "Your work isn't saved yet · kept until <date>" with Save your work, which opens ClaimForm (email, name, password) and sends claim_guest; after it, the banner goes and nothing reloads that doesn't need to. The sign-in case as the ADR settled it.
3. Things a guest can't do yet (invite your accountant, AI suggestions, filing) stay visible, with a short reason and Save your work, never a dead button with no explanation.
4. SiteHeader shows "Your business" and Save your work for a guest instead of Sign in.
5. Changes shows a guest's own changes as the ADR words them.
Icons through <Icon> with text labels; colours from tokens. Testing Library tests: a guest lands on their business, the banner and its date, claiming (including an email already taken), the sign-in case, and a guest sent away from a route they can't use.
Run `make check`.
Don't commit.
```

## Wave 4: after Agents 5 and 6 have landed

### Agent 7: the done check (Sonnet, medium thinking)
```
Read CLAUDE.md, PLAN.md (M20 "Done when"), docs/decisions/014-guests.md, fixtures/landing/README.md, crates/server/tests/examples.rs, crates/server/tests/guests.rs and crates/server/tests/tenancy.rs.
You own:
- crates/server/tests/m20.rs (new)
Task: `m20_is_done`, with no sign-in anywhere until the claim:
1. For each example, a fresh client starts a guest with it, gets the pinned conservative figure, answers the top three Save tax cards and gets the pinned figure after each.
2. A guest drops fixtures/bank-statements/harbourlight-cheque-2025-08.ofx as its own file (sent as a browser would, base64 through import_statement), answers cards, and reads everything the Submit screen needs.
3. It claims: every line, answer and figure is unchanged, and it can sign in with the new password.
4. A second guest can't read or change the first's business.
5. An unclaimed guest past its expiry is swept: its statement files, statements, lines, journals, business and user are gone, command_log is as the ADR says, and every other business is byte-identical.
6. The per-IP limit refuses the next guest with the ADR's wording.
Run `make check`.
Don't commit.
```

## When all of them are done

Check `make check` passes, then by hand in a browser:
- **Desktop:** the panel sits right of the flow; a card opens full screen and closes with Escape; dragging Example 2 onto Upload runs the loader and shows its figure; answering a Save tax card lowers it; Review your return opens the owner screen without a sign-in; the hero ticket loads Example 1. Then drop a real OFX of your own and go through to the Submit screen. Save your work, sign out and back in, and check it's all there.
- **Phone:** the Example 1–3 links open the preview; Use this example runs the same flow.
- Leave an example guest alone past its expiry on staging and check it's gone.

Tick M20's status in PLAN.md, record the figures in fixtures/landing/README.md if Agent 2 hasn't, and set ADR 014 to Accepted. Add the browser check to NON-CODE-TODOS.md if it's left for later.

**Gaps closed after wave 3 (2026-11-06).** None of these moves a pinned figure.
- **"Are you GST registered?" card.** The web showed "We can't show this question yet". It's now answerable on Save tax and in the home page's top three (`SaveTaxGst.tsx`): No, or Yes with how often they file.
- **GST status on the Save tax page.** It says why we think they're registered, with the line that proved it, and has a Change link. The home page's "change" link lands there.
- **"Claim the GST" happens when registration is confirmed.** When an owner says yes (or a statement proves it), the same command gives purchases sorted while it was assumed their categories' GST codes (`save_tax::restore_input_tax`). The books come out the same whichever order things were answered in. ADR 014 and `docs/domain.md` record why this replaced the card.
- **"Are you registered after all?"** If the owner said no and a statement uploaded since has a GST line from IRD, Save tax asks again (`BusinessView.gst_contradicted_by`).
- **Agent 5's gaps:**
  - (1) `BusinessView` now has `gst_source`, `gst_evidence` and `example`, so a visitor's own file says "We spotted a GST payment to IRD on 22 Oct 2025".
  - (2) Guests may read `/api/clients/{id}/asset-classes`.
  - (3) A guest coming back to the home page carries on with their trial.
- **Decided:** guests keep the reads of their own `/api/clients/{id}`, `/chart`, `/coding-settings` and `/asset-classes` (ADR 014's route list says so). A trial gets no opening-balance reconcile card until it's saved (`docs/domain.md`).
- **Tests:** `tests/guests.rs` gained two (confirming claims the GST in either order; the refund notice). There's also `SaveTaxGst.test.tsx`, and a resume test in `TryItFlow.test.tsx`.
