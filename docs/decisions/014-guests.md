# 014: Guests: trying it on the home page with no sign-up

Status: proposed (2026-11-05). Settles PLAN.md M20's guest questions before wave 2 of `M20-PROMPTS.md`
starts. The GST rule in 3 was decided by the owner on 2026-11-04; this ADR writes it up and settles its
details. Three points are the owner's to decide, each marked **DECISION FOR ME**: what happens to a
guest's work if they sign in to an existing account instead (4), folding the claim into Submit (5), and
what happens to an expired guest's `command_log` rows (6). The status becomes accepted when M20 is done.
ADR 013 (M19) is taken, so this is 014.

## Context
- PLAN.md M20: a visitor drops a bank statement (one of our three examples, or their own) on the home
  page and sees their real figures: the tax, Save tax cards they can answer, and the File tax step. With
  their own file they can reach the Submit screen without signing up. Everything runs through the real
  parser, pipeline and tax engine.
- What there is now:
  - **Sign-up** (`crates/server/src/signup.rs`) is a public route, `POST /api/signup`, that submits
    `sign_up` through the pipeline as an `Actor` with `user_id: None` and role `BusinessOwner`
    (`access::Target::SignUp`), then starts an ordinary session. A guest starts the same way.
  - **Sessions** (`auth.rs`) last 12 hours and are written outside the pipeline, because login state
    isn't practice data (hard rule 6).
  - **Access** (`access.rs`) refuses any route without a rule, and `command_targets` has no catch-all.
    M19 (`impersonation.rs`) added a deny-by-default list of command kinds, with a test that every kind
    is classified. Guests follow that pattern.
  - **The log.** `command_log.user_id` has a foreign key to `users`, and foreign keys are on
    (`crates/store/src/lib.rs`). So a user who has made commands can't be deleted, only retired.
    `import_statement` logs the file's SHA-256, not its bytes (`Command::logged_payload`). Other rows
    still hold a real person's data: `add_rule` keeps the description it matches ("J SMITH"),
    `answer_question` keeps other income and tax deducted, `import_statement` keeps the file name, and
    `command_log.changes` (M13) keeps before and after values and tax figures.
  - **Statement files** (M18) are kept whole in `statement_files.bytes`.
  - **AI suggestions** are on by default since ADR 011. So "guests aren't offered AI" (PLAN.md) has to be
    a guest rule. ADR 009's opt-in no longer exists to rely on.
  - **GST** is set once, at setup (`business::set_up`, `GstSetup`). There's no command to change it.
    Each deposit is split for GST when it's imported (`acct_core::bank`), so changing registration
    means reposting those lines. `acct_core::bank::looks_like_ird` spots IRD lines but can't tell GST
    from income tax.
- The examples (`fixtures/landing/README.md`): Example 1 pays IRD "GST AUG-SEP" on 22 Oct. Example 2
  pays IRD "INC TAX 2026" and isn't GST registered. Example 3 pays "GST MAY-JUN" on 28 Jul and gets a
  "GST REFUND JUL-AUG" on 9 Sep. The OFX parser builds the description from `NAME` then `MEMO`, so
  "INLAND REVENUE GST AUG-SEP" is what core sees.

## Decision

### 1. What a guest is
**A `business_owner` user with no credentials, plus a business they own, made by a new `start_guest`
command on a public route.** Not a new role. Every owner screen, read and command already works for a
`business_owner` who owns the business, so a guest needs no second set of rules for what they can see.
What they can't do yet is one list (below).

- The user row: `username` is `guest:<user id>`, which has no `@`, so it can never collide with an email
  or be signed in with. `password_hash` is empty, which `auth::verify_password` never matches. `login`
  also refuses guest users by name, so this doesn't depend on that alone. `display_name` is `You`.
  `users.guest_since` is set (migration 0014). A **guest** is a user with `guest_since` set and
  `claimed_at` empty.
- The pipeline's `Actor` gains `guest: bool`, set when the session's user is a guest. Access checks read
  it, so nothing has to look a guest up again.
- **`GET /api/me`** for a guest returns the ordinary `Me`, with `username` sent as `""`, and a new
  `guest` field. `guest` is `null` for everyone else, and for a guest who has claimed.

  ```json
  {
    "id": "0193…", "username": "", "display_name": "You", "role": "business_owner",
    "acting_as": null, "real": null,
    "guest": {
      "expires_at": "2026-11-12T03:04:05Z",
      "business_id": "0193…",
      "example": { "business_id": "0193…", "number": 1, "expires_at": "2026-11-06T03:04:05Z" }
    }
  }
  ```

  `business_id` is the guest's own business, if they've dropped a file of their own, else `null`.
  `example` is their example business, if any (9). `expires_at` is when the guest goes if they don't come
  back (6).

- **Deny by default.** `crates/server/src/guest.rs` holds `GUEST_ALLOWED`, the command kinds a guest may
  submit. Any other kind is refused for guests before it's validated, with code `guest` and "Save your
  work first to do this." So a new command is refused for guests until someone adds it to the list. A
  test goes through every command kind and fails unless it's on `GUEST_ALLOWED` or `GUEST_REFUSED`
  (the second list only documents the refusals), the same way `tests/impersonation.rs` does.
  - **Allowed:** `import_statement`, `remove_statement`, `set_opening_balance`, `add_bank_account`,
    `add_card_account`, `code_bank_line`, `code_bank_lines`, `add_rule`, `remove_rule`,
    `answer_question`, `confirm_transfer`, `confirm_ird_payment`, `resolve_duplicate`,
    `confirm_supply_info`, `set_gst_registration` (source `owner` only, 3), `add_guest_business` (2),
    `expire_guest` (their own business only: "Delete it now", 6), and `claim_guest` (through its own
    route, 4).
  - On an **example** business, `import_statement`, `add_bank_account` and `add_card_account` are
    refused too: "This is an example. Your own statements go in a business of your own: drop one on the
    home page." An example never mixes with real lines.
- **Routes**, also deny by default (`guest::route_allowed`, called from `access::guard`). A guest may
  use: `GET /api/me`, `/api/clients`, `/api/businesses/{id}`, `/tax`, `/save-tax`, `/rules`,
  `/api/statements/{id}/excerpt`, `/api/bank-accounts/{id}/proof`, `/api/history`, `/api/sync`, and
  `POST /api/commands`, `/api/presence`, `/api/logout`, `/api/guest/claim`. As built (2026-11-06), also
  their own business's `GET /api/clients/{id}`, `/chart`, `/coding-settings` and `/asset-classes`,
  because the Save tax screens read them (the categorise form needs the chart and asset classes).
  Each is a read of the guest's own business, already limited by the access check, so it widens nothing. Every other route is refused
  for guests, including both `/api/businesses/{id}/ai-suggestions` routes, `/api/invoices/*`,
  `/api/ird/*` and `/api/years/*`.
- **Not until claimed:**
  - inviting an accountant (`create_invite`), so no practice user ever sees a guest's business;
  - AI suggestions: the route is refused, and the background requester skips guest businesses. Nothing
    of a guest's leaves the server;
  - filing with IRD and anything else `ird_*` (M14);
  - changing a password, since there isn't one (`change_own_password`), and two-factor set-up (M12);
  - the invoice maker (`save_invoice_*`, `add_invoice_image`, `delete_invoice_template`) and
    `set_history_sharing`.
- **Nobody else sees a guest's business, an overseer included.** `access::can_see` answers "not found"
  for an unclaimed guest's business to everyone but that guest. `access::visible` leaves those
  businesses out of `/api/clients`, `/api/sync` and `/api/history` for everyone else.
  `impersonation::may_act_as` refuses unclaimed guests. That's what makes the privacy line's "nobody
  looks at it" (7) true. The server's own sweep isn't a person and isn't affected. If we ever need
  operational figures, it's counts only (guests alive, bytes held), never a business's data.

### 2. When a guest is made, and what further files do
- **Only on a drop or "Use this example", never on a page view.** A page view writes nothing, so crawlers
  and passers-by cost nothing.
- **`start_guest { source }`** on `POST /api/guest` (public), where `source` is
  `{ "file": { "file_name", "content_base64" } }` or `{ "example": 1 | 2 | 3 }`. One command, applied in
  one transaction, does everything: makes the user, sets up the business from the file (3), imports the
  file as `import_statement` would, and grants the user owner access. Then the route starts a guest
  session and sets the cookie. A file the parser rejects therefore makes no guest, and the visitor sees
  the parser's own plain-English error. `logged_payload` replaces `content_base64` with its SHA-256, as
  it does for `import_statement`.
- **A visitor with a guest session drops another file of their own:** it goes in the **same** business
  (recommended): an ordinary `import_statement`, which picks or adds the bank account by the file's
  account number. A trial is one business. A second business would split the figure, and nothing
  suggests the visitor means a second one. If the guest has only an example business so far, their
  first file of their own goes in a new business of their own:
  `add_guest_business { source: { file } }`.
- **A guest uses an example:** `add_guest_business { source: { example } }` makes a **fresh example
  business** under the same guest user (recommended), so an example never mixes with real lines. The
  guest's own business is untouched. A guest has at most one example business: the same command
  deletes the previous one, the same way expiry does (6), and says so in its log entry. Example data is
  synthetic, but the guest's answers to its Save tax cards ("other income $45,000") are about them, so
  they get the same deletion.
- **A guest session is held by one browser.** A signed-in user who isn't a guest gets "Open your
  business" on the home page, and no guest is made.

### 3. Setting a business up from a file alone
- **Name:** "Your business", until they claim (4). An example business takes the example's name, such
  as "Tūī Street Coffee".
- **Balance date:** 31 March, the only one M10 supports.
- **Start date:** 1 April of the income year that holds the file's earliest line. `docs/domain.md`
  ("Bank statements to the ledger") already uses that year's first day for a business that started
  before its earliest uploaded income year, and a bank statement can't tell us otherwise. It means
  statements from earlier in the same year can be added later. If the start date were the statement's
  first day, they would be refused as "before the business started". The days from 1 April to the first
  statement are a gap, flagged as today's rules do. With no balance for 1 April, the gap has no amount,
  so it changes no figure. The home page should word it as what the figure covers ("Covers 1–31 Oct
  2025. Add your statements from 1 April to see the whole year."), not as a warning.

**GST: detect it, otherwise assume registered, and ask late (decided 2026-11-04).**
- **Detected.** Two kinds of line prove the business is registered:
  - a deposit from IRD whose description says GST (a GST refund);
  - a payment to IRD whose description says GST.

  Either way, the business is set up as registered from the start date, with the reason shown: "We
  spotted a GST payment to IRD on 22 Oct, so we've treated you as GST registered. Not right?"
- **Filing frequency, where the lines show it:**
  1. A month range in the reference ("AUG-SEP" is two months ending in September, so two-monthly ending
     in odd months; "MAY-JUN" ends in June, so even months; "SEP" alone is monthly; a six-month range ending in March or September is
     six-monthly).
  2. Otherwise, the spacing of two or more GST lines: about 1, 2 or 6 months apart.
  3. Otherwise, IRD's default for a 31 March balance date: two-monthly, ending in odd months.

  The frequency only decides how the same deposits split into periods, so a wrong guess moves the
  figure by rounding cents at most. It does change which returns are due when, so it's shown with the
  registration ("GST registered · two-monthly · change").
- **Assumed.** Statements can never prove someone isn't registered. Without proof, the business is set
  up as registered from the start date, two-monthly (odd), and shows "Assumed GST registered · change".
- **Deposits over $60,000 in 12 months** only add the existing notice, worded for this case:
  registration is compulsory over that, so "not registered" may not be right. It never changes the
  setting.

**Why assume registered: checked against the tax engine (`acct_core::tax`).** Take deposits D that count
for GST, and G = D × 3/23, the GST inside them.
- Registered, box 15 includes G and taxable income is D − G. Not registered, there's no GST and taxable
  income is D. So registering adds G of GST and takes G off taxable income. The income tax on that G is
  at most G × m, where m is the highest combined marginal rate the engine can reach. Unanswered, m is
  39% plus the 12% student loan, so 51%. After answers, the worst case is 55%, in the independent earner
  tax credit's abatement band ($66,000–$70,000): 30% plus 12% plus the 13% abatement. Either way m is
  below 100%, so registered is higher by at least 0.45 × G.
- **Example**, with $10,000 of deposits and nothing answered:
  - registered: GST 1,304.35, plus income tax and student loan of 51% × 8,695.65 = 4,434.78, which is
    5,739.13;
  - not registered: 51% × 10,000.00 = 5,100.00.

  Registered is higher by 639.13.
- **The claim's exception is wrong, and the rule needs one more line.** A **loss doesn't** make
  registration cheaper. With taxable income at or below nil, income tax is nil either way (the engine
  floors each year at nil), and the GST is still owed, so registered is higher by all of G. What can
  make it cheaper is **input tax**: GST claimed on purchases. If claimed purchases outweigh sales in a
  period (a $28,750 van, say), box 15 is a refund, and registered can come out lower than not
  registered. Then answering "not registered" would put the figure up, breaking the plan's promise.
- **So: while registration is only assumed, no input tax is claimed.** Lines are still categorised, but
  a coding is posted with GST code `none`, whatever the category's default. The server enforces this:
  it recomputes the posting, and doesn't trust the code the UI sends. Then the GST in every period is
  output tax only, never a refund, and the inequality above holds for any categorisation. Assuming
  registration is always at least as high as not, and answering "not registered" only ever brings the
  figure down.
- Once registration is confirmed (the owner says yes, IRD does, or a later statement proves it), the
  command that confirms it recodes those lines with their categories' GST codes, in the same
  transaction (`save_tax::restore_input_tax`). *Changed while building (2026-11-06):* this was going
  to be a "Claim the GST on 14 expenses" card, but claiming at once makes the books the same whichever
  order the owner answered in (sorted then confirmed, or confirmed then sorted), and the screen can
  say "You told us you're GST registered, so we've added the GST you can claim" straight away. Over
  $200, the GST still waits for the supply information card as usual.

**No up-front question.** "Are you GST registered?" is a Save tax card (a new `Question::GstRegistered`),
shown only while registration is assumed. Its saving is the figure now less the figure if not registered,
which the engine prices like any other change. The card is a best case ("could save up to"), like "other
income". "Yes" saves nothing by itself, but turns on the GST-only cards. A detected registration gets no
card, because the evidence says registered and a card offering a saving for "no" would invite the wrong
answer. It gets only the "Not right?" link beside the reason.

**While assumed, GST-only questions are held back.** No GST code choices on cards, no "do you have the
supplier's information?" for lines over $200, and no "Claim the GST" cards. The owner just categorises.
`confirm_supply_info` stays allowed: it claims nothing while assumed, and counts once confirmed.

**At Submit, if still assumed:**
- Once M14 is built, IRD's filing obligations (`RetrieveFilingObligation`) answer it: registered or not,
  and the frequency. The server submits `set_gst_registration` with source `ird`.
- Before M14, the Submit screen asks "We couldn't tell if you're GST registered. Are you?" and, if yes,
  "How often do you file GST?". The answer is `set_gst_registration` with source `owner`.
- When the figure changes there, the screen says why, from the command's own tax before and after (M13
  `changes`): "IRD says you're not GST registered, so your tax dropped by $639.13" (the $10,000 example
  above), or "You told us
  you're GST registered, so we've added the GST you can claim."

**How it's recorded and changed.** `set_gst_registration { client_id, registered, registered_from?,
frequency?, source }`, logged like any other command. Migration 0014 adds `businesses.gst_source` and
`businesses.gst_evidence` (the proving bank line).
- `source` is `detected`, `assumed`, `owner` or `ird`. Today's businesses keep `NULL`, which means "given
  at setup". That's treated as `owner`.
- **Who sets what:**
  - `detected` and `assumed` are only ever set by the server, inside `start_guest`, `add_guest_business`
    or `import_statement`.
  - `owner` is the only source a browser may send.
  - `ird` is set by the M14 integration only.
- **Precedence:** `ird` beats `owner`, which beats `detected`, which beats `assumed`.
  - An upload that proves registration on an assumed business upgrades it to `detected` inside that
    `import_statement`, and its log entry's `changes` say so.
  - Detection never overrides an owner's answer. If the owner said "not registered" and a later
    statement has a GST refund, they get a notice ("This statement has a GST refund from IRD. Are you
    registered after all?"), not a silent change. Built: `BusinessView.gst_contradicted_by`, from the
    statements uploaded since the owner's last answer, shown above the Save tax cards with yes and no.
  - An owner can't contradict IRD: "IRD has you as GST registered, two-monthly. If that's wrong,
    contact IRD."
- **Applying it** changes the business's GST setting, then reverses and reposts, in the same command,
  every bank-line and gap journal whose posting changes: deposits gain or lose their GST split, and once
  confirmed, assumed-era codings get their categories' GST codes back in the same command. Posted journals
  never change; this is the reverse-and-repost every recode already does. It's refused for a filed GST
  period or a finalised year (M14, M15), like any other change to their numbers.

**What core needs** (all pure, in `crates/core`):
- `bank::ird_kind(description) -> Option<IrdKind>`, to replace the yes-or-no `looks_like_ird`. `IrdKind`
  is `Gst { months }` (the month range in the reference, if any), `IncomeTax { year }` (from "INC TAX
  2026", "IR3", "PROV TAX" and the like, if it names one), or `Unknown`. The word list is ours, with
  unit tests for each example's lines.
- `tax::gst::detect_registration(lines) -> GstDetection`: `Detected { line, kind: Refund | Payment,
  frequency }` or `Assumed`, using the frequency rules above.
- The coding rule: while registration is assumed, every coding is posted with GST code `none`.
- The Save tax question `GstRegistered`, priced through `TaxInputs::with`, plus the "Claim the GST" card.

**The examples come out:**
- **Example 1: detected**, from the 22 Oct payment "GST AUG-SEP": two-monthly, odd months.
- **Example 2: assumed.** Its only IRD line is income tax, and its "Are you GST registered?" card should
  be one of its top three. The README's "not registered" is the answer to that card.
- **Example 3: detected**, from the 28 Jul payment "GST MAY-JUN" (and the 9 Sep refund "GST REFUND
  JUL-AUG"): two-monthly, even months.

Example 3 comes out even months, not IRD's odd-month default, because that's what its references say.
The README only says "two-monthly" for both.

### 4. Claiming
**`claim_guest { email, display_name, password, business_name? }`** on `POST /api/guest/claim` (a
guest's session only). The route submits it through the pipeline, then, as sign-up does, checks the
password, deletes the guest's sessions and starts an ordinary 12-hour session with a new token. Changing
the token at the moment the session gains credentials closes off session fixation.
- **It keeps everything.** It's the same user id and the same business, so every line, coding, answer
  and log entry stays exactly where it is. The command sets `username` to the email, `display_name`,
  `password_hash` and `claimed_at`, and renames the business if `business_name` is given. `guest_since`
  stays as a record that they started as a guest.
- The guest's **example business is deleted** in the same command (6's deletion). An example can never
  be filed: those are made-up figures.
- **A guest with only an example business** can't claim. They're told "Examples can't be saved. Drop
  one of your own statements, or sign up." and the button goes to `/signup`.
- **An email already in use** is refused with `email_taken`: "There's already an account with that
  email. Sign in instead." This is sign-up's message, so the two read the same.
- The password is checked against sign-up's rules, and `logged_payload` already redacts `password`.
  When sign-up records acceptance of the customer terms (`NON-CODE-TODOS.md`), `claim_guest` records it
  the same way. A guest hasn't accepted terms before claiming (7).

**DECISION FOR ME: a guest who signs in to an existing account instead.** When they sign in, the
browser's cookie is replaced, so the guest's business is no longer reachable.
- **B. Offer to move it into that account.** The login route notices the guest cookie and offers "Move
  the statement you just tried into your account?". An `adopt_guest_business { client_id }` command,
  sent by the signed-in owner, gives them owner access, retires the guest user, and deletes its example
  business. It's always a business of its own, never merged into one they already have: two setups
  could double-count. It costs a command, a login hook and owners with two businesses in the web app.
  Worth it later if people do this often. **Chosen for this one**

### 5. Filing
PLAN.md has a guest reach the Submit screen with no sign-in. Filing itself (M14) needs a claimed account:
the myIR authorisation is stored against the owner, and so is the filed record, which outlives any trial.

**DECISION FOR ME: how a guest gets from Submit to filed.**
- **A. The claim is the first step of Submit (recommended).** One screen: "Save your work to file"
  (email, name, password), then the return's lines and the declaration, then myIR. A visitor who gets
  this far has decided to file, so asking for an account there isn't a detour.**Chosen this one**


**Until M14:** "Review your return" opens the Submit screen as today, with Submit switched off. It shows
the GST question if registration is still assumed (3), and has no claim step yet. The "Save your work"
banner is there anyway. An example business's Submit screen says "This is an example, so it can't be
filed. Try your own statement."

### 6. Expiry
**How long:**
- A guest's own business lives **7 days from the guest's last request** (recommended). That's long
  enough to come back after a weekend, and short enough that we hold little.
- An example business lives **24 hours** from when it was made, or less if the guest goes first (9).

**How "last request" is kept.** The guest's session is the clock:
- A guest session lasts 7 days, sliding. It's not the 12 hours a signed-in session gets, which would
  lock a guest out of their own trial overnight.
- Any request at least an hour after the last bump moves `sessions.expires_at` to 7 days from now. The
  response re-sends the cookie with the new `Max-Age`, so the browser keeps it as long as the server
  does.
- This is login state, which hard rule 6 leaves outside the pipeline. So unlike a `users.guest_last_seen`
  column, it needs no command on every read. A guest whose sessions have all expired has been away 7
  days.

**How it ends: a sweep, like M19's.** `guest::sweep` runs at startup and every 10 minutes. It submits
`expire_guest { client_id, why }` through the pipeline as the server (`user_id: None`), for:
- each own business whose guest has no live session (`why: unused`);
- each example business past its 24 hours (`why: example_finished`).

Waiting for the next request isn't enough on its own, because a guest who never comes back never makes
one. A guest can also end it themselves: "Delete it now" in the banner submits `expire_guest` with
`why: by_you`. Signing out as a guest deletes the session, so the next sweep ends the trial. The sign-out
button says so: "Leave and delete your trial".

**What's deleted, for one business, in one transaction:**
- **The files:** `statement_files` (the bytes) and `balance_spans`.
- **The books:** `statements`, `bank_lines`, `gap_journals`, `journal_lines` and `journals`.
- **What the owner told us:** `bank_line_states`, `coding_rules`, `supply_info_confirmations`,
  `duplicate_answers` and `tax_answers`.
- **Assets:** `assets`, `asset_charges` and `client_asset_classes`.
- **AI:** `ai_suggestions` and `ai_settings` (none should exist for a guest).
- **Settings:** `coding_settings`, `history_sharing` and `year_notes`.
- **Access:** `client_access` and `invites` (none should exist).
- **The business itself:** `bank_accounts`, `client_years`, `accounts` (the chart copy), `businesses` and
  `clients`.

When the guest has no business left:
- **their sessions** are deleted, and their presence entry is dropped;
- **their user row** is kept, because `command_log.user_id` refers to it, but cleared: `username`
  `expired:<id>`, `display_name` "Expired guest", `password_hash` empty, `active` 0. It held no personal
  details anyway.

A test lists every table and column from `sqlite_master` after an expiry and fails if any row still holds
the business's id. A table added later can't be missed that way. `PRAGMA secure_delete = ON` on the
writer connection overwrites deleted rows in the database file instead of leaving them in free pages.

**DECISION FOR ME: the business's rows in `command_log`.** `command_log` is append-only, but its rows
for a guest business can hold descriptions, file names, amounts and answers from a real person's bank
file (Context).
- **A. Redact them in place (recommended).** `expire_guest` rewrites only that business's rows:
  - `payload` becomes `{"redacted":"guest"}`;
  - `result` keeps only `seq` and `entity_id`;
  - `changes` becomes `NULL`;
  - a new `command_log.redacted_seq` is set to the `expire_guest` entry's own `seq`.

  `seq`, `id`, `kind`, `user_id`, `client_id`, `client_year_id` and `at` stay, so `seq` stays gapless,
  the sync feed and restore check still work, and the log still shows that commands happened, and when.
  It's the one documented exception to append-only: only `expire_guest` and the two deletions in 2 and 4
  may do it, only for an unclaimed guest's business, and each records what it redacted (the count and
  the `seq` range) in its own entry. A resubmitted command id that hits a redacted row is refused as a
  reused id. The trial is gone anyway.**Chosen this one**

**What M13's Changes shows afterwards:**
- The guest's own Changes is gone with them.
- Nobody else ever saw that business (1).
- History skips rows with `redacted_seq` set. `describe` can't read them, and there's nothing to say.
- The `expire_guest` entry is the one line left, in the server's feed only: "Deleted an unsaved trial
  after 7 days unused: 2 statements, 51 lines and 14 earlier changes." It has no business name or
  amounts.

**Backups.** Litestream keeps 7 days of history and Fly's volume snapshots keep 14 (ADR 008). So a
deleted trial is gone from backups within 14 days of its expiry. The privacy policy says so (7).
Rolling a backup forward over an expiry deletes it again, because the `expire_guest` command is in the
log.

### 7. Privacy
**The line beside the drop zone** (one line, with a link to the privacy policy's section on trials):

> 🔒 Your file is read on our server in Australia, only to show you your tax. Nobody looks at it, it
> isn't sent anywhere else, and it's deleted 7 days after you last use it unless you save your work.
> How we handle your file

- "in Australia" follows the hosting decision. If production moves to a New Zealand host
  (`NON-CODE-TODOS.md`, M12 security), it says "in New Zealand".
- "Nobody looks at it" holds because of 1: no accountant, no overseer, no view-as, no AI.
- "Isn't sent anywhere else": the host and its backup storage are where our server runs, and the
  policy names them.
- The emoji is `<Emoji>` chrome, per CLAUDE.md.
- The example statements need no line. They're ours.

**On staging**, the line is replaced with: "This is our test server. Don't upload a real statement: use an
example, or a made-up file." Staging is synthetic only (hard rule 1, ADR 008), and only a warning can
stop a person dropping a real file there. `ACCT_GUEST_FILES=warn` turns it on in `fly.staging.toml`.
Production leaves it unset.

**What the privacy policy must add:**
- What a trial collects: the file, and what's worked out from it.
- Its purpose: showing the visitor their tax.
- That nobody looks at it, and that nothing is sent to the AI provider or anyone else.
- Where it's processed and stored.
- That bank statements name other people (payees and payers), and we use those names only to sort the
  lines.
- How long it's kept: 7 days from last use, an example 24 hours, then up to 14 days in backups.
- How to delete it at once ("Delete it now").
- That saving your work keeps everything, under the account's normal terms.

**The law, as far as this ADR can check it:**
- **Privacy Act 2020.** IPP 3 asks that people know, at or before collection, what's collected, why, who
  gets it, and their rights to see and correct it. The line plus the policy link, shown before the drop,
  is how we meet that. IPP 9 (no longer than needed) is the expiry. IPP 5 (security) is the controls
  here and in `docs/security.md`. Hosting in Australia is processing by our agent (s 11), not a
  disclosure, but the policy still says where.
- **Terms before upload.** None. A trial has no account, files nothing, uses no IRD service and deletes
  itself, so acceptance is recorded at claim (4). A privacy lawyer should confirm that this and the line
  are enough.
- **IRD.** IR1269 governs our gateway use and the taxpayer information we handle as a provider. A trial
  calls no gateway service and files nothing, so nothing in IR1269 asks for anything before a guest
  uploads. Its confidentiality and security clauses (4(a), 4(g)) are met by the controls here anyway.
  Describe trials in the OSF answers, and confirm with the relationship manager.

These checks are in `NON-CODE-TODOS.md`.

### 8. Abuse limits
| Limit | Number | What the visitor sees when refused |
|---|---|---|
| Trials started with their own file, per address per hour | 10 | "Lots of people on your network have tried this in the last hour. Try again in about 20 minutes, or sign up to carry on." |
| Examples opened, per address per hour (a separate count, 9) | 30 | The same, naming the examples |
| Trials started, across all addresses, per hour | 300 | "We're very busy right now. Try again in a few minutes, or sign up to carry on." |
| Guests alive at once | 1,000 | The same as above |
| File size, per upload | 1 MB | "That file is over 1 MB. A statement of one to three months is plenty to see your tax." |
| File bytes held per guest | 5 MB | "That's as much as a trial can hold. Save your work to add more." |
| File bytes held for all guests together | 200 MB | "We're very busy right now…" |
| Statements per guest | 12 | "That's 12 statements, the most a trial can hold. Save your work to add more." |
| Lines per guest | 5,000 | The same, naming lines |
| Bank and card accounts per guest business | 4 | The same, naming accounts |
| Commands per guest per minute | 60 | "Slow down a little. Try that again in a moment." |

- **An address** is an IPv4 address, or an IPv6 /64. NZ mobile networks put many people behind one IPv4
  address (carrier-grade NAT), so 10 an hour is set to annoy a script, not a shared office or a phone
  network.
- The client's address is `Fly-Client-IP` only when the server is configured as behind Fly (ADR 008).
  Otherwise it's the socket's peer address. Never the left of `X-Forwarded-For`.
- **The 1 MB check runs before parsing.** It's well under axum's default 2 MB JSON body limit once
  base64'd (about 1.37 MB). A busy month of OFX is around 50 KB. Signed-in owners keep today's limit.
- **Refusals are HTTP 429 with `Retry-After`**, and the address limits are checked before the command
  reaches the pipeline. They aren't data. Per-guest and all-guest limits are checked inside the command,
  from the database, so they hold across restarts.
- **Per-address counts live in memory** (fixed one-hour windows in a map, swept with the presence
  data). One machine is all there is (ADR 008). A deploy resets them, which is fine.
- Dev and the desktop app (`acct-dev`) use one address, so they raise the per-address limits by
  configuration.
- The 200 MB and 1,000 caps also protect the 1 GB production volume (ADR 008). Revisit the volume and
  the caps together if trials take off.
- No CAPTCHA. A page view does nothing, and a drop needs JavaScript. Revisit if the caps start
  refusing people.

### 9. Examples
- **Using one is `start_guest { example: n }`** (or `add_guest_business` for an existing guest). The
  server imports its own embedded copy of the file (`crates/server/src/examples.rs`, `include_bytes!`),
  so the browser never sends the bytes, and `GET /api/examples` serves what the cards and the hero ticket
  show.
- **An example business is set up from its file by the same rules as anyone's (3).** Only its name comes
  from the example. That's what makes Examples 1 and 3 come out detected and Example 2 assumed, and it
  keeps the demo honest: what a visitor sees is what their own file would get.
- **It expires 24 hours after it's made (recommended).** It's synthetic, it's cheap to make again, and
  every hour it lives is an hour the visitor's answers to it are kept.
- **It counts against its own per-address limit (30 an hour), not the 10 for trials with a real file**
  (recommended). Clicking through all three examples a few times shouldn't stop someone trying their
  own statement. It counts against the all-guest limits.
- **One at a time per guest:** a new example replaces the old one (2).
- **It can't be claimed or filed,** and it takes no uploads of the visitor's own (1, 4, 5).

### 10. History
- **To the guest**, their own changes read "You (not saved yet)" ("You (not saved yet) uploaded
  statement.ofx: 27 lines. Tax to pay went up $…"). `history::entry_view` gives that label to a
  user who is an unclaimed guest, when the reader is that guest.
- **The server's own entries on the business** (detecting GST inside an import is the import's own
  entry; an expiry has no reader left) read as today's server entries do.
- **After claiming**, every earlier entry reads under the new name ("Ana Ngata uploaded…"). Nothing is
  rewritten. History looks names up from `users` when it reads (`history.rs`, `names`), and claiming sets
  the name on the same user id.
- **Descriptions for the new kinds** (`history::tests` needs one each):
  - `start_guest`: "started a trial with statement.ofx" or "…with Example 1";
  - `add_guest_business`: "tried Example 2" or "added their own statement";
  - `claim_guest`: "saved their work as Ana Ngata";
  - `set_gst_registration`: "said they're not GST registered" (owner), "IRD says GST registered,
    two-monthly" (ird), "GST registration detected from a GST payment to IRD on 22 Oct" (detected);
  - `expire_guest`: as in 6.

## Consequences
**Migration 0014** (append-only; renumber if 0014 is taken when Agent 3 starts, and say so):
- `users.guest_since TEXT NULL` (UTC) and `users.claimed_at TEXT NULL` (UTC). A guest is
  `guest_since IS NOT NULL AND claimed_at IS NULL`.
- `businesses.example INTEGER NULL CHECK (example IN (1, 2, 3))`.
- `businesses.gst_source TEXT NULL CHECK (gst_source IN ('detected', 'assumed', 'owner', 'ird'))`
  and `businesses.gst_evidence TEXT NULL REFERENCES bank_lines (id)`.
- `command_log.redacted_seq INTEGER NULL`.
- No `users.guest_last_seen`: the sliding session is the clock (6). No new session column.

**New commands:**
- `start_guest`: public; makes the guest, sets up the business, imports.
- `add_guest_business`: a guest; their own business or a fresh example.
- `claim_guest`: a guest, through its route.
- `expire_guest`: the server's sweep, or the guest for their own business.
- `set_gst_registration`: owners and guests with source `owner`; the server with `detected`, `assumed`
  or `ird`.

Each also needs:
- an `access::command_targets` rule. `start_guest` gets a target like `SignUp`'s: no user, role
  `BusinessOwner`. `expire_guest` from the sweep gets a server target.
- a place in M19's lists: `start_guest`, `add_guest_business`, `claim_guest` and `expire_guest` go on
  `NEVER` (an overseer can't do these as someone else). `set_gst_registration` goes on `ALLOWED`.
- a `describe` arm in history.
- a decision about `history::before`/`after`.

**New routes:**
- `POST /api/guest` (Public): starts a trial.
- `POST /api/guest/claim` (SignedIn, guests only).
- `GET /api/examples` (Public, Agent 2).

**Access changes:**
- `Actor.guest`, and the guest command and route lists, checked before validation, the way
  impersonation's are.
- An unclaimed guest's business is not found for everyone but its guest, an overseer included, and left
  out of every listing.
- `may_act_as` refuses unclaimed guests.
- `login` refuses guest users.
- Guest sessions slide to 7 days.

**Elsewhere:**
- `auth`: guest sessions and the cookie's `Max-Age`.
- `ai`: skip guest businesses.
- `presence`: a guest shows as "You" to themselves and to nobody else.
- `history`: the label in 10, and skipping redacted rows.
- `sync`: tolerate redacted payloads.
- The writer sets `PRAGMA secure_delete = ON`.
- `fly.staging.toml` sets `ACCT_GUEST_FILES=warn`.

**For wave 2** (`M20-PROMPTS.md`):
- Agent 2's figures from `examples.rs` must be what a guest gets, so they come from the guest setup in
  3, not the README's setup table.
  - **Example 2 is priced as registered (assumed)**, so its conservative figure includes GST, and its
    "Are you GST registered?" card answered "no" is one of its top three.
  - Example 1 is two-monthly ending in odd months, and Example 3 in even months. Agent 2's
    `examples.rs` already has both right (checked 2026-11-05).
  - Agent 2 currently sets Example 2 up as not registered, and dates registration and the start from the
    statement. The start date doesn't move any figure (the gap before the first statement has no
    amount), but Example 2's registration does. Agent 3 reconciles this once the guest setup exists.
- Agent 3 owns migration 0014, `guest.rs`, the five commands, the sweep and the access changes. The
  GST detection and the "no input tax while assumed" rule are in core, in the same agent or split out,
  as the prompts decide.

**Other consequences:**
- `docs/security.md` gains the guest rows (Planned, M20).
- `NON-CODE-TODOS.md` gains the privacy policy, lawyer, IRD and staging items.
- `docs/domain.md` gains a "GST registration from statements (decided 2026-11-04)" section, written from
  3 when the code lands. It amends "Registration. Setup asks whether…" for guests: setup no longer asks
  a guest.
- A business owner can now own more than one business: a guest's own one and an example. `tenancy`
  already allows it, and the owner screens are by business id.
- The log is no longer strictly append-only: `expire_guest` and the deletions in 2 and 4 redact the
  rows of an unclaimed guest's business. Nothing else may, and `docs/security.md` says so.
