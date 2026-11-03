# M19 agent prompts: admin "view as" with real impersonation

`PLAN.md` has the milestone ("M19 — Admin 'view as' with real impersonation"): the starting position, the audit,
the safety rules and the "Done when". Every agent reads it first.

Today, Settings → Admin has a UI-only preview (`apps/web/src/lib/viewAs.tsx`): the web app swaps the role it renders
for, and the server still checks every request as the real user. This milestone replaces that with a server-backed
session state, then deletes the client-side override.

There are four waves.
- **Wave 1:** one agent writes the ADR. **Nothing else starts until you've accepted it**, because every later prompt
  builds on its answers.
- **Wave 2:** one agent builds the server side: the session state, the access checks, the refusals and the two
  commands.
- **Wave 3:** two agents at once: the audit and history, and the web app.
- **Wave 4:** one agent writes the done check.

Each prompt says which files that agent owns. Shared files (`crates/server/src/lib.rs`, `crates/server/src/commands.rs`,
`apps/web/src/App.tsx`, `apps/web/src/icons/registry.json`) are append-only for everyone: re-read just before editing,
and add only your own lines. Don't hand-edit `packages/types`: run `make types`.

**Migration:** only Agent 2 adds one. 0012 is reserved by M18 (`statement_files`), so M19 takes 0013 even if M18
hasn't landed yet. Anyone else who thinks they need one stops and asks.

**Hard rules apply.** Starting and ending a session, and turning changes on, are commands through the pipeline (6). The
session row is login state, not practice data, but the command that changes it is logged like any other. No real user
data in fixtures or tests (1).

**Build through `scripts/one-build.sh`** in a Codespace, workspace-wide (`cargo test -- impersonat`), never `-p`.

## Wave 1: start now

### Agent 1: the ADR (Opus, high thinking)
```
Read CLAUDE.md (Roles, and hard rule 6), PLAN.md (M19), docs/decisions/007-online-service.md, docs/security.md, crates/server/src/access.rs, crates/server/src/auth.rs (CurrentUser, Me), crates/server/src/pipeline.rs (Actor), crates/store/src/log.rs, crates/server/src/history.rs (and the history sharing setting), and apps/web/src/lib/viewAs.tsx.
You own:
- docs/decisions/013-impersonation.md (new; check 013 is still the next free number)
- the impersonation rows in docs/security.md (Planned, M19)
Task: write the ADR, status Proposed, taking PLAN.md's starting position and settling each of these. Where you recommend something, say why in a sentence; where it's a real choice for me, list the options and mark it DECISION FOR ME.
1. Who may impersonate whom: an overseer only, and only users below them; never another overseer. Can a practice_admin ever view as their own staff (today's preview lets them)? DECISION FOR ME; recommend.
2. What "acting as" names: a specific user (always), or also a role with a business for the owner view when the business has no owner user yet. Recommend acting as a user only, and say what the owner view does without one.
3. Read-only by default. Writes need an "allow changes" toggle that lasts for the session and is itself a logged command (`allow_impersonation_changes`, with a reason). Which commands are always refused while acting: PLAN.md's list (finalise_year, reopen_year, accept_invite, change_own_password, submit to IRD) plus anything that changes users, roles, passwords, sessions or two-factor settings, and starting another impersonation (no nesting). List them by command kind as they exist today (grep commands.rs), and say how new commands are covered: recommend a deny-by-default list of kinds allowed while acting, so a new command is refused until someone adds it.
4. IRD: every IRD-linked action (M14's myIR authorisation and filing) is refused while acting, with no toggle. Name the routes and command kinds, or the prefix rule if M14 hasn't built them.
5. Timeout: 30 minutes from the start, or from the last request? Recommend one. How the end is logged when nobody presses End: the next request on that session ends it through the pipeline as the server ("timed out"), or a sweep. Recommend one.
6. Audit: command_log gets `acting_as`; `user_id` stays the overseer. start_impersonation and end_impersonation carry a required reason and are visible to the impersonated user in their own Changes, regardless of any history sharing setting. Say whether the impersonated user is notified some other way (an email, a banner on next sign-in). DECISION FOR ME.
7. Presence (M13): does the overseer show as themselves, as "Overseer (as Sam Staff)", or not at all? Recommend.
8. What happens to the overseer's other tabs: the acting state is per session (cookie), so every tab follows it. Say so, and that the banner shows in all of them.
9. What gets deleted: the client-side override in viewAs.tsx and its sessionStorage key.
Then list the consequences: the new migration (0013: sessions.acting_as, sessions.acting_since, sessions.allow_changes, command_log.acting_as), the new commands, and the change to Actor.
Don't commit. Stop after the ADR and give me the DECISIONS FOR ME as a short list.
```

## Wave 2: after you've accepted the ADR

### Agent 2: the server side (Opus, high thinking)
```
Read CLAUDE.md, PLAN.md (M19), docs/decisions/013-impersonation.md (accepted; follow it where it differs from PLAN.md), crates/server/src/auth.rs, crates/server/src/access.rs, crates/server/src/pipeline.rs, crates/server/src/commands.rs, crates/store/src/sessions.rs (or wherever sessions are read and written), crates/store/src/log.rs and crates/server/tests/tenancy.rs.
You own:
- crates/store/migrations/0013_impersonation.sql (new) and the session functions in the store
- crates/server/src/auth.rs (CurrentUser, Me)
- the Actor type and the refusal step in crates/server/src/pipeline.rs
- crates/server/src/access.rs
- a new crates/server/src/impersonation.rs with the commands start_impersonation, end_impersonation and allow_impersonation_changes, plus their lines in commands.rs (append-only)
- crates/server/tests/impersonation.rs (new)
Leave command_log.acting_as recording and the history text to Agent 3: add the column in the migration, and put both identities on Actor so Agent 3 can record them, but don't write the log code.
Task:
1. Migration 0013 as the ADR lists. Append-only.
2. Actor carries both identities: `Actor { user_id, role, acting_as: Option<ActingAs> }` where ActingAs has the acting user's id and role. Add `fn effective(&self)` giving the identity access checks use, and keep `user_id` the real person. CurrentUser loads the session's acting state and applies the timeout rule the ADR chose.
3. Every check in access.rs (check, visible, check_command, route_rule/guard) runs against the effective identity, so reads show exactly what that person sees, including owner edits hidden from staff by the owner's sharing setting. Read the existing checks one by one and list in your report any that used the user id for something other than access (those may need the real one).
4. The pipeline refuses while acting, before validate: every command not on the ADR's allowed list; every command when changes aren't turned on, except end_impersonation and allow_impersonation_changes; and the always-refused list and IRD actions, even with changes on. A refusal names why, in plain words ("You're viewing as Sam Staff. Overseers can't finalise a year as someone else.").
5. The three commands: start_impersonation { user_id, reason } (overseer only; target below them, active, not an overseer; not while already acting), end_impersonation { reason? }, allow_impersonation_changes { reason }. Each updates the session row inside the command's transaction. Reason is required and trimmed non-empty where the ADR says.
6. `GET /api/me` adds `acting_as: { user_id, name, role, since, expires_at, allow_changes } | null`, and `real` (the overseer's own name and role) when acting.
Tests (impersonation.rs): who can start and who can't (including a practice_admin, per the ADR); reads while acting as staff match that staff user's reads exactly, endpoint by endpoint, using the tenancy test's businesses; every refused class is refused with changes off and on; allowed writes work only with changes on; the timeout ends the state; a second session of the same overseer isn't affected. Plus a test that iterates every command kind and fails if one isn't classified as allowed or refused while acting.
Run `make check`.
Don't commit.
```

## Wave 3: after Agent 2 has landed (both at once)

### Agent 3: audit and history (Sonnet, medium thinking)
```
Read CLAUDE.md, PLAN.md (M19 Audit), docs/decisions/013-impersonation.md, crates/store/src/log.rs, crates/server/src/pipeline.rs (Actor, as Agent 2 left it), crates/server/src/history.rs and its tests, crates/server/src/presence.rs and crates/server/tests/m13.rs.
You own:
- the acting_as recording in crates/store/src/log.rs and the pipeline's call to it
- crates/server/src/history.rs and history/tests.rs
- crates/server/src/presence.rs
- crates/server/tests/m13.rs (add cases; don't change existing ones)
Task:
1. Record command_log.acting_as for every command accepted while acting; user_id stays the overseer.
2. History says "Overseer Olive (as Sam Staff) marked 12 COUNTDOWN transactions as personal…" for those commands. Plain-English descriptions for start_impersonation ("Overseer Olive started viewing as Sam Staff: <reason>"), end_impersonation (including "timed out") and allow_impersonation_changes. history::tests needs one per new kind, as it already enforces.
3. Visibility: the impersonated user sees the start, the end and every change made as them in their own Changes, whatever the history sharing setting says. Filtering by person matches either identity.
4. Presence follows the ADR's answer.
5. The redacted payload stored in command_log keeps the reason.
Tests: the log rows carry both identities; the history text for each case; the impersonated user's own feed shows the session even when the owner's sharing setting would hide staff edits from them.
Run `make check`.
Don't commit.
```

### Agent 4: the web app (Sonnet, medium thinking)
```
Read CLAUDE.md (Icons and emoji), apps/web/src/ui/README.md, PLAN.md (M19), docs/decisions/013-impersonation.md, apps/web/src/lib/viewAs.tsx, apps/web/src/components/Layout.tsx, apps/web/src/pages/SettingsLayout.tsx, apps/web/src/pages/OverviewPage.tsx, apps/web/src/App.tsx and apps/web/src/auth.tsx, and the new `acting_as` on Me (packages/types, after `make types`).
You own:
- apps/web/src/lib/viewAs.tsx (replace it; delete the sessionStorage override)
- the Admin section of SettingsLayout.tsx, and the lines in Layout.tsx, OverviewPage.tsx and App.tsx that use viewAs
- apps/web/src/components/ActingBanner/ (new)
- new slots in apps/web/src/icons/registry.json (append-only)
Task:
1. Settings → Admin: "View as someone" for an overseer: pick a user (name, role, business), type a reason, Start. It sends start_impersonation and then reloads Me and every query (they now answer as that person). Nothing for other roles unless the ADR says a practice_admin may.
2. A persistent banner on every page while acting: "Viewing as Sam Staff · read-only · 24 min left", an End button (asks for an optional reason), and "Allow changes" (asks for a reason, says what stays refused). It shows in every tab, because the state is per session; refetch Me on window focus so a tab notices when another ended it or it timed out.
3. Write buttons stay visible. When the server refuses a command because of acting, show its message in the existing error style, not a crash.
4. CurrentUser is the acting person while acting (the server's view), and useViewAs().real is the overseer, so the existing `real` checks in SettingsLayout and OverviewPage keep working. Remove PREVIEWABLE and the UI-only role swap entirely.
Icons through <Icon> with text labels; colours from tokens. Testing Library tests: starting, the banner and its countdown, ending, a refused write's message, and that no sessionStorage key is read or written any more.
Run `make check`.
Don't commit.
```

## Wave 4: after Agents 3 and 4 have landed

### Agent 5: the done check (Sonnet, medium thinking)
```
Read CLAUDE.md, PLAN.md (M19 "Done when"), docs/decisions/013-impersonation.md, crates/server/tests/impersonation.rs, crates/server/tests/tenancy.rs and crates/server/tests/m13.rs.
You own:
- crates/server/tests/m19.rs (new)
Task: `m19_is_done`. Set up synthetic users: an overseer, a practice_admin, a staff user, and a business owner who hides their own edits from staff. The overseer starts acting as the staff user (with a reason) and: every read matches what the staff user gets signed in themselves, including the owner's hidden edits staying hidden; a write is refused while read-only; after allow_impersonation_changes a permitted write succeeds; finalise_year, reopen_year and an IRD action are refused even with changes on; end_impersonation returns the overseer's own view. Then check that every command in that run, and the start, the allow and the end, are in command_log with both identities, and appear in the staff user's own Changes. Finally, a second session started and left alone times out and its end is logged.
Run `make check`.
Don't commit.
```

## When all of them are done

Check `make check` passes, then by hand in a browser with two windows: the overseer views as a staff user, sees the banner in both of the overseer's tabs, has a write refused, allows changes, makes one, and ends; the staff user, signed in separately, sees all of it in their own Changes. Tick M19's status in PLAN.md and set the ADR to Accepted. Add the browser check to NON-CODE-TODOS.md if it's left for later.
