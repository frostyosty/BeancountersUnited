# 013: Viewing as someone else (impersonation)

Status: proposed (2026-11-04). Settles PLAN.md M19 before any code is written. The owner decided the two
open points on 2026-11-04: practice admins don't view as anyone (1: A), and the person gets a notice as
well as the entries in Changes (6: B). The status becomes accepted when M19 is done (`M19-PROMPTS.md`).

## Context
- Settings → Admin has a UI-only preview today (`apps/web/src/lib/viewAs.tsx`). The web app swaps the
  role it renders for and remembers the choice in `sessionStorage` (`view-as-role`). The server still
  checks every request as the real user, so the preview shows the wrong data: an overseer "viewing as
  staff" still sees every business, and the Changes feed still shows what an overseer sees.
- Support needs to see exactly what one person sees, to answer "why can't I see X" or "this button fails
  for me". That means the server has to answer as that person.
- Letting someone act as someone else is the most sensitive thing the service does. Taxpayer information
  must be protected against unauthorised access or use (IR1269 4(a), 4(g); `docs/security.md`), and
  IRD's yearly review will ask who can reach customer data and how it's logged. The selling point
  against Xero is that every change shows who made it (PLAN.md, "Direction"). So the design has to keep
  that true while someone is acting as someone else.
- What's there now: `Actor { user_id, role }` (`crates/server/src/pipeline.rs`) is built from the
  session in `CurrentUser::actor()` (`crates/server/src/auth.rs`). Every read goes through
  `access::guard` and every command through `access::check_command`, both ending in `access::check`
  (`crates/server/src/access.rs`). `command_log` keeps one `user_id` per command
  (`crates/store/src/log.rs`). `sessions` holds a token hash, a user and an expiry, and is written
  outside the pipeline because it's login state (`crates/store/src/sessions.rs`).

## Decision

### The model
Acting as someone is a state of one login session, not a second login. The session keeps the
overseer's own identity and adds who they're acting as. Ending it returns that session to the
overseer's own view. Nothing about the overseer's other sessions (another browser or device) changes.

Two words used below:
- the **real** identity: the overseer who signed in. It goes in `command_log.user_id` and anywhere
  that records who did something.
- the **effective** identity: the person being acted as. It's what every access decision uses: what
  can be seen, and what the role may do.

### 1. Who may act as whom
- Only an `overseer`, and only as an active user below them: a `practice_admin`, `staff`, `viewer` or
  `business_owner`.
- Never as another overseer, never as themselves, and never as an inactive user.
- If the person being acted as is made inactive, or becomes an overseer, while it's going on, the state
  ends at once (see 5).

**May a practice_admin view as their own staff?** Today's preview lets them. **Decided 2026-11-04: A.**
- **A. No: overseers only. Practice admins lose the preview. (Chosen.)** A practice admin can
  already read everything their staff and viewers can: `access::can_see` and `access::visible` treat
  all three practice roles alike, and the owner's history sharing setting hides owner edits from all of
  them alike. So viewing as staff would show an admin the same data with fewer buttons. That isn't
  worth a second kind of impersonator to audit and explain to IRD.
- B. Yes, as their own staff and viewers only, read-only, with no "allow changes".
- C. Overseers impersonate for real, and practice admins keep a UI-only role preview. This keeps the
  client-side override that M19 exists to delete, and the preview would keep showing an admin's data
  under a staff label.

### 2. What "acting as" names
- **Always a specific user.** Not a role, and not a role plus a business. A role isn't a person: there's
  no one whose view it reproduces, nobody to see the session in their own Changes, and nobody to name in
  "Overseer Olive (as …)".
- **A business with no owner user** (set up by a practice, and nobody signs in as its owner) has no
  owner view to reproduce. The overseer opens it as themselves: `/businesses/{id}` and Save tax already
  show the owner's screens to anyone who can see the business, and an overseer can see every business.
  The user picker in Settings → Admin lists users, so there's nothing to pick for such a business.

### 3. What it may do
**Read-only by default.** Writes need **Allow changes**, which:
- is its own logged command, `allow_impersonation_changes { reason }`, with a required reason;
- lasts until the session's acting state ends. There's no command to turn it back off: End, then start
  again.

**Deny by default.** The server keeps one list of the command kinds allowed while acting. Every other
kind is refused, so a new command is refused while acting until someone adds it to the list on
purpose. A test goes through every command kind and fails unless each is in exactly one of the three
groups below, so a new kind can't be added without someone deciding.

**Allowed while acting, only with changes on (36 kinds).** The work done on one business, which is
where a person's view and their role make a difference:
- Chart: `add_account`, `rename_account`, `set_account_active`, `set_account_gst`,
  `set_rounding_priority`.
- Years, journals and notes: `create_client_year`, `post_journal`, `reverse_journal`, `import_tb`,
  `run_depreciation`, `move_year_layout`, `pick_notes`, `edit_note`.
- Assets: `set_client_asset_class`, `create_asset`, `update_asset`, `delete_asset`, `dispose_asset`,
  `reinstate_asset`, `apply_asset_class_defaults`.
- Bank, uploads and Save tax: `set_coding_settings`, `add_bank_account`, `add_card_account`,
  `import_statement`, `set_opening_balance`, `remove_statement`, `code_bank_line`, `code_bank_lines`,
  `add_rule`, `remove_rule`, `answer_question`, `confirm_transfer`, `confirm_ird_payment`,
  `resolve_duplicate`, `confirm_supply_info`, `record_suggestions`.
  - `confirm_ird_payment` codes a bank line as a payment to IRD. It's bookkeeping, not an IRD action
    (see 4), so it's allowed.

The two session commands are allowed while acting **even with changes off**: `end_impersonation` and
`allow_impersonation_changes`.

**Not on the list: do it as yourself (20 kinds).** Practice-wide defaults and new businesses. An
overseer can already do all of these as themselves, and doing them "as" someone else adds nothing but a
misleading name in the log: `install_starter_set`, `create_master_chart`, `add_master_account`,
`rename_master_account`, `set_master_account_active`, `set_master_account_gst`, `create_template`,
`revise_template`, `create_mapping`, `revise_mapping`, `create_asset_class`, `update_asset_class`,
`add_merchant`, `remove_merchant`, `add_paragraph`, `revise_paragraph`, `remove_paragraph`,
`push_paragraph`, `create_client`, `set_up_business`.

**Always refused while acting, even with changes on (17 kinds).** These are a person's own signature,
identity or consent, so nobody may do them in someone else's name:
- Signing off: `finalise_year`, `reopen_year`.
- Users, roles, passwords and sessions: `create_user`, `reset_password`, `set_user_active`,
  `change_own_password`. Two-factor commands join this group when M12 builds them.
- Granting access: `accept_invite`, `create_invite`. An owner's invite gives a practice their data, so
  it's the owner's consent to give.
- The owner's choices about their own data: `set_history_sharing` (who sees their edits) and
  `set_ai_suggestions` (whether their lines go to the AI provider).
- A user's own invoices: `save_invoice_draft`, `save_invoice_template`, `delete_invoice_template`,
  `add_invoice_image`. `docs/security.md` promises that no one else can read or change them, an overseer
  included.
- No nesting: `start_impersonation`.
- Never from a browser session anyway: `initialise`, `sign_up`.

The always-refused group is a second check, not just "not on the list". It runs even if a kind is put on
the allowed list by mistake.

**Routes, not just commands.**
- Every `GET` runs as the effective identity, except the invoice maker's (`/api/invoices/draft`,
  `/api/invoices/templates`, `/api/invoices/templates/{id}`, `/api/invoices/images/{id}`). Those are
  refused while acting, so neither the person's invoices nor the overseer's own show.
- `POST` routes other than `/api/commands`:
  - `/api/presence`, `/api/mappings/check` and `/api/years/{id}/tb-import/preview` change nothing, so
    they're allowed.
  - `POST /api/businesses/{id}/ai-suggestions` sends the business's lines to the AI provider and submits
    `record_suggestions`, so it counts as a write: it's refused unless changes are on.
  - `/api/logout` ends the acting state first (see 5).
  - Any new non-`GET` route is refused while acting until it's given a rule, the same deny-by-default
    as commands.

**Refusals say why**, in plain words, naming the person: "You're viewing as Sam Staff. Overseers can't
finalise a year as someone else." or "You're viewing as Sam Staff, read-only. Turn on Allow changes to
make this change." They get their own error code (`impersonating`), so the web app can show them in its
usual error style.

**Recording who did it.** Anything that decides what's allowed or visible uses the effective identity.
Anything that records who did something (the `by` on an invite or a finalisation, `command_log.user_id`)
uses the real one. Most of those commands are refused while acting anyway, but the rule holds for any
that aren't.

### 4. IRD
Every IRD-linked action is refused while acting, with no toggle: authorising us through myIR, and every
call to IRD's gateway (filing, amending, checking status, retrieving returns, prefill). An overseer must
never file as someone, or use an owner's myIR authorisation without them.

M14 hasn't built any of these yet, so the rule is a naming rule M14 must follow:
- Every command kind that calls IRD or changes the myIR link starts with `ird_` (for example
  `ird_authorise`, `ird_file_return`, `ird_amend_return`).
- Every route that calls IRD lives under `/api/ird/`, reads included, since checking status uses the
  owner's authorisation.
- Both are refused while acting, as part of the always-refused check, by prefix. A test fails if any
  `ird_` kind is on the allowed list.
- Reading a filed return we've already stored (the payload and IRD's response) isn't an IRD call, so it
  works like any other read if M14 serves it outside `/api/ird/`.

### 5. Timeout and how it ends
- **30 minutes from the start, not from the last request.** A fixed window is easy to state ("support
  looked for at most half an hour"), is the same for everyone, and can't be kept open all day by a tab
  left polling. To keep going, the overseer ends it and starts again with a new reason.
- **The clock is checked on every request.** `CurrentUser` treats an acting state whose 30 minutes are
  up as already over: the request runs as the overseer. Access never depends on whether the end has been
  logged yet.
- **The end is logged by a sweep.** A task in `acctd` runs once a minute, and once at startup. It
  submits `end_impersonation` through the pipeline as the server for each acting state that has run out,
  or whose session has gone. Ending it on the next request alone would never log anything when the
  overseer just closes the laptop, and the person's Changes would show a session that never ended. The
  sweep takes `now` as an argument, so tests call it directly instead of waiting.
- The other ways it ends, each logged as `end_impersonation` with how it ended:
  - The overseer presses End (with an optional reason).
  - The overseer signs out. `/api/logout` ends the acting state through the pipeline before it deletes
    the session.
  - The person is made inactive or becomes an overseer: treated as over at once, then logged by the
    sweep.
  - The session is deleted some other way (a password reset or deactivation of the overseer): logged by
    the sweep, which also closes acting states whose session no longer exists.
- Every start has exactly one end. The start's `entity_id` is a new id for that acting session, kept on
  the session row, and the end returns the same `entity_id`. A test checks every start has an end once
  the sweep has run.

### 6. Audit
- `command_log.acting_as` is the effective user for every command accepted while acting. `user_id`
  stays the overseer. The sweep's ends have no `user_id` (the server did it) and still have `acting_as`.
- `start_impersonation`, `allow_impersonation_changes` and `end_impersonation` all carry `acting_as` too,
  so "every row whose `acting_as` is me" is one rule that finds the whole session.
- **Reasons:** required, trimmed and non-empty, for `start_impersonation` and
  `allow_impersonation_changes`. Optional for `end_impersonation`. At most 500 characters. They're kept
  in the logged payload. The person can read them, so overseers write them for that reader.
- **Changes** names both identities: "Overseer Olive (as Sam Staff) marked 12 COUNTDOWN transactions as
  personal."
- **Who sees which rows:**
  - The person acted as sees every row whose `acting_as` is them in their own Changes: the start, the
    allow, the end and every change made as them. Their own history sharing setting and the usual
    filters don't hide these, and an owner sees them even though the start names no business.
  - The start, allow and end rows are seen only by overseers and the person acted as. A reason like
    "Sam says the TB won't load" isn't the rest of the practice's business.
  - A change made while acting is seen by whoever would see that change anyway, with both names on it.
  - For the history sharing rule, a change made as an owner counts as the owner's edit, so the practice
    sees it only if the owner shares their edits. It was made in the owner's seat, and this keeps the
    sharing rule one rule.
  - Filtering by person matches either identity: picking Sam shows Sam's own changes and the ones made
    as Sam.

**Is the person told some other way?** **Decided 2026-11-04: B.**
- A. Changes only.
- **B. Changes, plus a notice when they next open the app. (Chosen.)** "Olive from support viewed
  your account as you on 4 Nov for 12 minutes: <reason>. See Changes." It's built from the same log
  rows, so there's no new table. Dismissing it is remembered in the browser only: the notice is a
  courtesy, and Changes stays the record. It's honest without needing anything we haven't built.
- C. B plus an email. We don't send email yet (`docs/security.md` lists the email provider as a
  placeholder), so this waits until sign-up email exists.

### 7. Presence (M13)
Recommended: the overseer shows as **"Olive (Overseer, as Sam Staff)"**, to whoever could see Sam's
presence there, and to every overseer. Sam doesn't show as present unless Sam is signed in too. Showing
nothing would hide support from the very person it concerns, who may be online at the same moment.
Showing just "Sam" would be false, and showing the overseer as just themselves wouldn't say whose view
they're in.

### 8. The overseer's other tabs
The acting state belongs to the session, and the session is the cookie, so every tab in that browser
follows it at once. The banner ("Viewing as Sam Staff · read-only · 24 min left", with End and Allow
changes) shows in all of them. A tab notices a change made in another tab (start, end, allow, or a time
out) the next time it fetches `/api/me`: on window focus, and when the sync feed shows an
impersonation command. Starting or ending clears every cached query, so no tab keeps showing the other
identity's data. Another browser or device signed in as the same overseer has its own session and isn't
affected.

### 9. What gets deleted
- The client-side role override in `apps/web/src/lib/viewAs.tsx`: `PREVIEWABLE`, the role swap and the
  `view-as-role` key in `sessionStorage`. Nothing reads or writes that key afterwards.
- The practice admin's role picker in Settings → Admin goes too (decision 1: A).
- `useViewAs().real` stays, meaning the overseer while acting, so the existing `real` checks in
  `SettingsLayout.tsx` and `OverviewPage.tsx` keep working.

## Consequences
- **Migration `0013_impersonation.sql`** (0012 is M18's), append-only:
  - `sessions.acting_as TEXT NULL REFERENCES users (id)`: who this session is acting as.
  - `sessions.acting_id TEXT NULL`: the acting session's id, the start's `entity_id`, so the end can
    name the start it closes. This column is one more than PLAN.md lists.
  - `sessions.acting_since TEXT NULL`: when it started, for the 30 minutes.
  - `sessions.allow_changes INTEGER NOT NULL DEFAULT 0 CHECK (allow_changes IN (0, 1))`.
  - `command_log.acting_as TEXT NULL REFERENCES users (id)`, and an index on `(acting_as, seq)` for the
    person's own feed.
  - The sessions columns are login state, like the rest of `sessions`. The commands that change them are
    logged like any other (hard rule 6).
- **New commands**, in a new `crates/server/src/impersonation.rs`:
  - `start_impersonation { user_id, reason }`: only by an overseer who isn't already acting, as an
    active user below them. Its `entity_id` is the new acting id.
  - `end_impersonation { reason? }`: ends the request's own session's acting state. The sweep submits it
    as the server, naming the acting id it closes.
  - `allow_impersonation_changes { reason }`: only while acting.
  - Each updates the session row inside its own transaction, and each gets a sentence in `history.rs`.
- **Actor changes** to `Actor { user_id, role, acting_as: Option<ActingAs> }`, where
  `ActingAs { user_id, role }`, with `fn effective(&self)` giving the identity access checks use.
  - `user_id` and `role` stay the real person.
  - `check`, `visible`, `check_command` and `guard` run on `effective()`.
  - The pipeline refuses while acting, before validating, in this order: the always-refused group and
    the `ird_` prefix; then anything not on the allowed list; then, with changes off, everything except
    `end_impersonation` and `allow_impersonation_changes`.
- **`GET /api/me`** answers as the effective user, and adds
  `acting_as: { user_id, name, role, since, expires_at, allow_changes } | null`, plus `real` (the
  overseer's own name and role) while acting.
- **A background task** in `acctd`: the once-a-minute sweep. It's the server's first periodic task.
- **M14** must follow the `ird_` and `/api/ird/` naming rule in 4.
- **M12's planned access logs** (who read which business, sign-ins) record both identities when they're
  built.
- **Once two-factor sign-in exists** (M12, Agent 6), starting should require that the overseer's session
  used it.
- **The web app** gets the notice from decision 6 (B), built from the person's own Changes entries, with
  the dismissal kept only in the browser.
- **Outside the code:** the customer terms and privacy policy must say support may view an account as
  its user, read-only unless needed, time-limited, logged and visible to them (`NON-CODE-TODOS.md`, IRD
  business track).
