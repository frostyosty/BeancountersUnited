# M21 agent prompts: the whole taste first, then sign up at the peak

`PLAN.md` has the milestone ("M21 — The whole taste first, then sign up at the peak"). Every agent reads it first, then
`docs/decisions/014-guests.md` (M20's guests), because M21 builds on it.

There are four waves.
- **Wave 1:** one agent writes ADR 015. **Nothing in wave 2 starts until you've accepted it.**
- **Wave 2:** two agents at once: the server, and the accountant view in the web app.
- **Wave 3:** one agent: the home page tiles, the peak prompts and the "Who are you?" question.
- **Wave 4:** one agent writes the done check.

Start M21 only once M20 is done (its `m20_is_done` passes and the browser check is ticked), because the same files
change.

Each prompt says which files that agent owns. Shared files (`crates/server/src/lib.rs`, `crates/server/src/commands.rs`,
`crates/server/src/access.rs`, `crates/server/src/guests.rs`'s lists, `apps/web/src/App.tsx`,
`apps/web/src/icons/registry.json`) are append-only for everyone except where a prompt says it owns them: re-read just
before editing, and add only your own lines. Don't hand-edit `packages/types`: run `make types`.

**Migration:** only Agent 2 adds one, 0015. If 0015 is taken by then, use the next free number and say so.

**Hard rules apply.** A practice request is a command through the pipeline (6). A visitor's own statement never
lands in fixtures, tests, logs or error reports (1). The accountant view only renders the server's ReportDoc and
figures; the browser works nothing out (4, and the Reports rules in CLAUDE.md). No emoji in the statements
themselves, only in the chrome around them.

## Wave 1: start now

### Agent 1: ADR 015 (Opus, high thinking)
```
Read CLAUDE.md (hard rules 1 and 6, Roles), PLAN.md (M20 and M21, and the White label backlog item), docs/decisions/014-guests.md, docs/security.md (the guest rows), crates/server/src/guests.rs (GUEST_ALLOWED, GUEST_REFUSED, route_allowed, check_route), crates/server/src/access.rs (the year routes and Need), crates/server/src/signup.rs (invites), crates/server/src/reports.rs, apps/web/src/App.tsx (the year routes, NotForGuests), apps/web/src/pages/BusinessPage.tsx, apps/web/src/components/ClaimForm/ and GuestBanner/.
You own:
- docs/decisions/015-taste-then-sign-up.md (new; check 015 is still the next free number)
- new rows in docs/security.md (Planned, M21)
- new items in NON-CODE-TODOS.md (append-only)
Task: write the ADR, status Proposed, taking PLAN.md M21's starting position and settling each of these. Where you recommend something, say why in a sentence; where it's a real choice for me, list the options and mark it DECISION FOR ME.
1. The accountant view: exactly which GET routes a guest may add for its own business (the year reads: which of journals, tb, report, gl, analysis, assets, reconciliation, notes, layout, and any template or mapping read the statements need), and which stay refused (report.pdf, snapshot, finalise-check, every write). How the web shows read-only: recommend one read-only context the year screens honour, not a check per button. What a server with no sole-trader template shows.
2. Claimed owners: recommend they get the same switch, read-only. Say whether anything they can read today changes.
3. The peak rules: the $100 first-saving threshold (or a better rule; check it against the three examples' figures in fixtures/landing/README.md and say what each would show), once per trial, how dismissal is remembered (recommend browser storage, since it's only a nudge), the last-48-hours banner, and the example's "drop your own statement" line.
4. `from` on claim_guest: the values (recommend banner, saving, submit, locked:<what>, accountant_view, expiry), where it's stored (its own log payload), and that it's never shown to the visitor.
5. The overseer counts: trials started, saved and expired by week, and saves by `from`. Recommend reading them from command_log, so no new table. Say what a redacted (expired) trial still contributes, and check that counting never reads a redacted payload.
6. "Who are you?": shown only after the guest opened the accountant view (how the web knows: browser storage is enough, or a flag on the guest), owner selected by default, and why (PLAN.md's asymmetry).
7. The practice request: `request_practice_account { name, email, practice_name, clients, phone? }` on a public route, or from a guest's session. What's stored (migration 0015), how long it's kept, who can list it (overseers only), the per-address limit (reuse ADR 014's limits), the privacy policy line, and what an overseer does next (NON-CODE-TODOS.md). DECISION FOR ME: whether accepting a request should create the practice_admin user from it (a command, with an invite-style link), or stay manual for now.
8. Self-serve practice accounts: say plainly what practice tenancy would take (practice-owned charts, templates, paragraphs, users; every practice-level read and command scoped) so it can be planned later, and that M21 doesn't start it.
Then list the consequences: migration 0015, the new command and route, the guest route additions, the access changes, the types.
Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted ADR 015 (both at once)

### Agent 2: the server (Opus, high thinking)
```
Read CLAUDE.md, PLAN.md (M21), docs/decisions/015-taste-then-sign-up.md (accepted; follow it where it differs from PLAN.md), docs/decisions/014-guests.md, crates/server/src/guests.rs, access.rs, pipeline.rs, commands.rs, reports.rs, history.rs, signup.rs, crates/store (log, users, migrations), crates/server/tests/guests.rs and tenancy.rs.
You own:
- crates/store/migrations/0015_*.sql (new) and its store functions
- crates/server/src/practice_requests.rs (new): the command, its public route, the overseer list
- the guest route additions and the PDF refusal wording in guests.rs; `from` on claim_guest
- the overseer counts read (a new route, overseers only) and its lines in lib.rs and access.rs (append-only)
- history.rs: a description for request_practice_account
- crates/server/tests/accountant_view.rs and crates/server/tests/practice_requests.rs (new)
Task:
1. The guest route additions exactly as the ADR lists, each a read of the guest's own business through the existing access check. report.pdf refused with the ADR's wording ("Save your work to download the PDF", or the example's wording).
2. `from` on claim_guest, validated against the ADR's list, kept in the payload, never echoed to the browser.
3. request_practice_account, its route, the per-address limit, the overseer list, migration 0015.
4. The overseer counts, from command_log as the ADR says, never reading a redacted payload.
5. Check a guest's business can show statements: if the sole-trader template or mapping isn't there, the report read answers the ADR's plain message, not a 500.
6. reports.rs: drop `shows_codes`, so the GL and analysis show account codes to everyone (ADR 015, 1.4, decided A).
Tests: a guest reads its own trial's year routes and an example's; another guest and a signed-up owner can't; every write on a year is refused for a guest; report.pdf is refused with the reason; claim_guest stores `from` and refuses an unknown one; a practice request is stored, limited per address, listed for overseers and refused for everyone else; the counts after starting, claiming and expiring trials (reuse guests.rs's sweep pattern).
Run `make check`.
Don't commit.
```

### Agent 3: the accountant view in the web app (Sonnet, high thinking)
```
Read CLAUDE.md (Icons and emoji, Reports), apps/web/src/ui/README.md, PLAN.md (M21 "The accountant view"), docs/decisions/015-taste-then-sign-up.md, apps/web/src/App.tsx, apps/web/src/auth.ts, apps/web/src/pages/BusinessPage.tsx, the year screens (YearLayout and its tabs: JournalsTab, TrialBalanceTab, StatementsTab, GlTab, AssetsTab), apps/web/src/components/HistoryPanel.tsx, apps/web/src/components/GuestBanner/ (LockedForGuest).
You own:
- a read-only context for the year screens (new, in apps/web/src/lib/ or components/), and the lines in each year tab that honour it
- the Your view · Accountant view switch on BusinessPage.tsx, and the accountant view's route for owners and guests in App.tsx (append-only)
- new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. The switch on the owner's business screen, for claimed owners and guests: the accountant view opens the current year's statements, trial balance, journals, general ledger, assets and Changes, with the line PLAN.md gives at the top and "Back to your tax".
2. Read-only everywhere in it, through the one context: no post, import, notes, chart, finalise or PDF buttons; the PDF shows LockedForGuest's pattern with the ADR's wording for a guest.
3. A server with no sole-trader template: the statements tab shows the server's plain message.
4. Deep links the home page tiles can use: `/businesses/{id}/books/statements`, `/books/tb`, `/books/journals`, `/books/changes` (or the ADR's paths). Export a helper that builds them.
5. Remember in browser storage that this guest opened the accountant view (try/catch; the page works without it), for Agent 4's "Who are you?".
Icons through <Icon> with text labels; colours from tokens; no emoji inside the statements. Testing Library tests: the switch for an owner and a guest, each tab read-only (no edit buttons), the PDF locked for a guest, the no-template message, and the deep links.
Run `make check`.
Don't commit.
```

## Wave 3: after Agents 2 and 3 have landed

### Agent 4: the tiles, the peaks and "Who are you?" (Sonnet, high thinking)
```
Read CLAUDE.md, apps/web/src/ui/README.md, PLAN.md (M21), docs/decisions/015-taste-then-sign-up.md, apps/web/src/pages/HomePage.tsx, apps/web/src/components/TryIt/ (useTryIt, TryItSteps), apps/web/src/components/ClaimForm/ and GuestBanner/, apps/web/src/pages/SaveTaxPage.tsx, apps/web/src/pages/AccountantsPage.tsx and SignUpPage.tsx, apps/web/src/pages/SettingsLayout.tsx (ToolsTab, AdminSettingsTab), Agent 3's deep-link helper and Agent 2's types (TrialCounts, PracticeRequestView).
You own:
- the "boring stuff, for accountants" section of HomePage.tsx
- the peak prompts: new components in apps/web/src/components/Peaks/ (new), and their one-line mounts in TryItSteps.tsx, SaveTaxPage.tsx and GuestBanner
- the "Who are you?" step in ClaimForm, and `from` on every claim
- apps/web/src/components/PracticeRequest/ (new), and its entries on AccountantsPage.tsx and SignUpPage.tsx
- the overseer's two panels: apps/web/src/components/TrialCounts/ and apps/web/src/components/PracticeRequests/ (new), and their one-line mounts in SettingsLayout.tsx's ToolsTab and AdminSettingsTab
Task:
1. The three tiles as buttons: with a trial, open its view through the deep links; without one, run useExample(1) and open the view once it's ready.
2. The peaks exactly as the ADR words them: the first $100 saving on their own file (once per trial, dismissable, remembered in browser storage with try/catch), the example's "drop your own statement" line, and the banner's and claim form's expiry wording as ADR 015, 3.5 A says (no countdown or 48-hour state). Nothing on arrival or on leaving.
3. Every Save your work passes its `from`.
4. "Who are you?" before the claim form, only when Agent 3's flag says they opened the accountant view; I run this business selected. The accountant choice opens PracticeRequest, which sends request_practice_account and says what happens next; the trial is untouched.
5. Get a practice account on /accountants and /signup.
6. For overseers only (render nothing for anyone else): Settings → Tools shows the trial counts from `GET /api/overseer/trials` (the last 12 weeks: started, saved, moved into an account, expired by why, and saves by `from`, with "not recorded" for none), and Settings → Admin lists the practice requests from `GET /api/practice-requests`, newest first, with a Delete button (`delete_practice_request`, `why: by_overseer`, through ConfirmDialog). The page only renders the server's counts; it adds nothing up.
Testing Library tests: each tile with and without a trial, the saving line once at the threshold and never for an example, dismissal, the example line, the banner's expiry wording, `from` on each claim path, the question shown only after the accountant view, the practice request form (including the per-address refusal), and both overseer panels (shown for an overseer, absent for a practice admin, the counts as served, deleting a request).
Run `make check`.
Don't commit.

From agent 3:   For Agent 4                                                                     │ 109            <Route element={<NotForGuests />}>
  - Tiles: link them with booksPath.                                              │ 110              <Route index element={<HomeRoute />} />        
  - "Who are you?": ask only when hasOpenedAccountantView(me.id) is true.         │ 111              <Route path="clients/:clientId" element={<Clie 
  - Banner and header button: these still send no from. They should send          │      ntPage />} />
    accountant_view while the path starts with /businesses/<id>/books.  
```

## Wave 4: after Agent 4 has landed

### Agent 5: the done check (Sonnet, medium thinking)
```
Read CLAUDE.md, PLAN.md (M21 "Done when"), docs/decisions/015-taste-then-sign-up.md, crates/server/tests/guests.rs, m20.rs, accountant_view.rs and practice_requests.rs.
You own:
- crates/server/tests/m21.rs (new)
Task: `m21_is_done`, with no sign-in anywhere until the claim:
1. A guest drops fixtures/bank-statements/harbourlight-cheque-2025-08.ofx and reads its statements, trial balance, journals, general ledger and asset register; an example guest reads Example 3's (answer its van card first, as m20.rs does; then the van is in the register).
2. Every write on those years is refused for the guest, and the PDF, with the ADR's wording.
3. A second guest can't read the first's.
4. The first guest claims with `from` = accountant_view, and the overseer counts show one started, one saved by accountant_view.
5. A practice request goes through the pipeline, is limited per address, and only an overseer can list it.
Run `make check`.
Don't commit.
```

## When all of them are done

Check `make check` passes, then by hand in a browser:
- **Desktop:** with no trial, click "Statements that foot": Example 1 loads and its statements open, read-only. Back to your tax, drop a real OFX of your own, answer Save tax cards until the saving line appears; it shows once. Open the accountant view, then Save your work: "Who are you?" appears with I run this business selected. Pick the accountant path and send a request; as an overseer, check it's in Settings → Admin and that Settings → Tools counts the trials.
- **Phone:** the tiles open the same views; the statements read on a narrow screen.

Tick M21's status in PLAN.md (ADR 015 was accepted on 2026-11-07). Add the browser check to NON-CODE-TODOS.md if it's left for later.
