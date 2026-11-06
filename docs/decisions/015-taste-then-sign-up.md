# 015: The whole taste first, then sign up at the peak

Status: accepted (2026-11-07). Settles PLAN.md M21's questions before wave 2 of `M21-PROMPTS.md` starts.
Builds on ADR 014 (M20's guests). The owner decided its three open points on 2026-11-07, each taking
option A: the accountant view shows account codes in the general ledger (1.4), the "last 48 hours"
banner is dropped for plain wording (3.5), and accepting a practice request stays manual (7). ADR 014 is
the latest, so this is 015. Migration 0014 is the latest, so this takes 0015.

## Context
- PLAN.md M21: a visitor sees all of it before an account is asked for, including the accountant's side,
  read from their own trial. An account is asked for only when it's worth the most to them.
- What there is now (checked 2026-11-07):
  - **Year reads.** `access::route_rule` gives every `GET /api/years/{id}/…` route `Year(Need::Read)`. A
    business owner can see their own business (`can_see`), so **a claimed owner can already read every
    year route**, the PDF included. Nothing in the web app links an owner to them.
  - **Guests.** `guests::route_allowed` refuses every `/api/years/*` route for a guest. A guest can read
    `/api/clients/{id}`, `/chart` and `/asset-classes` for their own business already (ADR 014, 1, as
    built).
  - **The web's year screens** (`YearLayout` and its tabs) are under `NotForGuests` in `App.tsx`, with
    practice crumbs ("Clients") and edit controls on several tabs. `AssetsTab` decides edit buttons by
    `role !== "viewer"`, so an owner who found the URL would see buttons the server then refuses.
  - **What the year screens read:** `YearLayout` reads `/api/years/{id}`, `/api/clients/{id}` and
    `/chart`. Journals reads `/journals`, the trial balance `/tb`, statements `/report` (and links
    `/report.pdf`, and mounts `LayoutMove`, which reads `/layout`), the general ledger `/gl`, assets
    `/assets` and `/api/clients/{id}/asset-classes`. Changes is `HistoryPanel`, on `/api/history`. **The
    statements read no template or mapping route:** the server builds the ReportDoc from the year's
    pinned versions (`ledger::pinned_layout`).
  - **A business can't exist without the sole-trader template.** `business::set_up` refuses with
    `no_master_chart` when there's no sole-trader master chart, and the first year pins the only
    sole-trader mapping and its template or refuses with `mapping_required` (`business::pin_sole_trader`).
    So on a server without the starter set, `start_guest` itself fails, and every year that exists has a
    template and mapping pinned. Pinned versions are never deleted.
  - **Account codes.** `reports::shows_codes` leaves codes out of the GL and analysis for business owners.
    The trial balance and the chart (both readable by owners today) show them.
  - **Guest expiry slides.** A guest's session, and so their own trial, lasts 7 days from their last
    request, bumped at most hourly (`auth::slide_guest_session`). `GET /api/me` reads the expiry before
    the access layer bumps it.
  - **The log.** `redact_log` clears the payload, result details and changes of an unclaimed guest
    business's rows, keeping `seq`, `id`, `kind`, `user_id`, `client_id`, `client_year_id` and `at`. A
    `claim_guest` row is on a business that is then claimed, so it's never redacted. An `expire_guest` row
    names no client (`Effect.client_id` is empty), so it's never redacted either, and
    `history::row_shown` shows it to overseers only.
  - **One practice.** Practice users (`practice_admin`, `staff`, `viewer`) see every client without an
    owner (`can_see`), and master charts, templates, mappings, asset classes and the paragraph library are
    server-wide.
- The examples' figures (`fixtures/landing/README.md`, pinned): conservative $5,307.98, $9,111.51 and
  $32,890.09. The first card ("Only income: yes") brings them to $2,050.81, $3,520.36 and $18,188.54.

## Decision

### 1. The accountant view
**A guest may add these `GET` routes, each for its own business only.** Each still goes through the
existing access check (`RouteRule::Year`, year → client → `can_see`), so another guest, an owner, a
practice user or an overseer reading a guest's year still gets "not found", as today.

| Route | For a guest | Why |
|---|---|---|
| `/api/years/{id}` | **Allowed** | `YearLayout`'s header and every tab need the year. |
| `/api/years/{id}/journals` | **Allowed** | Journals. |
| `/api/years/{id}/tb` | **Allowed** | Trial balance. |
| `/api/years/{id}/report` | **Allowed** | Statements, built by the server from the pinned template and mapping. |
| `/api/years/{id}/gl` | **Allowed** | General ledger. |
| `/api/years/{id}/assets` | **Allowed** | The asset register. |
| `/api/years/{id}/report.pdf` | Refused: "Save your work first to download the PDF." | PLAN.md: the PDF needs an account. |
| `/api/years/{id}/snapshot`, `/finalise-check` | Refused | A guest's year can't be finalised (`finalise_year` is refused), so there's nothing to read. |
| `/api/years/{id}/reconciliation`, `/analysis`, `/notes`, `/layout` | Refused | Not in the view. The owner already has the bank proof card (M18). Adding one later is a line here and a tab. |
| `POST /api/years/{id}/tb-import/preview`, `/api/clients/{id}/asset-classes/{class_id}/apply-preview` | Refused | Previews of writes. |
| `/api/templates/{id}`, `/api/mappings/{id}`, `/api/paragraph-library/*` | Refused (practice routes, refused for owners too) | The statements don't read them (Context). |

Every write on a year stays refused as today: `post_journal`, `reverse_journal`, `import_tb`, the asset
commands, `run_depreciation`, `pick_notes`, `edit_note`, `move_year_layout`, `finalise_year`,
`reopen_year` and the chart commands are all on `GUEST_REFUSED`. M21 adds nothing to `GUEST_ALLOWED`.

`check_route`'s refusal for `report.pdf` is `save_first("download the PDF")`. It's a backstop: the web
never links a guest to the PDF (below). `check_route` only sees the path, so the server says the same for
an example. The web, which knows from `Me.guest.example` which business is the example, words it for that
case.

**1.1 One read-only context, not a check per button (recommended).** A `ReadOnlyBooks` React context
(`apps/web/src/lib/readOnly.tsx`): `{ readOnly: boolean; pdf: "download" | "save_first" | "example" }`.
The accountant view's layout provides it, and each year tab reads `useReadOnly()` and leaves out its write
controls. Its default is not read-only, so the practice's own year screens don't change. One switch keeps
the rule in one place, and a tab added later is read-only in this view as soon as it honours the context.
The server's refusals stay the real control; the context only keeps dead buttons off the screen.

What each tab leaves out when read-only:
- **Journals:** the post-journal form and every reverse button.
- **Statements:** `LayoutMove`. The PDF follows `pdf`:
  - `download` (a claimed owner): the usual "Download PDF" link. Owners can read it today; it says "Draft"
    on every page until the year is finalised.
  - `save_first` (a guest's own business): `LockedForGuest`, "Save your work to download the PDF.", whose
    button sends `from: "locked:pdf"` (4).
  - `example`: "This is an example, so there's no PDF. Try it with your own statement.", linking to the
    home page's drop zone.
- **Assets:** add, edit, delete, dispose, reinstate, run depreciation and apply class defaults.
- **Trial balance, general ledger:** nothing to leave out. The GL's "show matched reversals" toggle stays:
  it changes the view, not the books.
- **Changes:** anything that changes a setting (history sharing).
- **Not mounted at all:** Import TB, Notes, Reconcile, Analysis and Finalise.

**1.2 The routes in the web app.** `/businesses/{id}/books` and its children, beside the owner's
business screen, outside `NotForGuests`:
- `/businesses/{id}/books/statements` (the index), `/books/tb`, `/books/journals`, `/books/gl`,
  `/books/assets` and `/books/changes`.
- A `booksPath(businessId, view)` helper builds them, for the switch and the home page tiles.
- The layout picks the business's **latest year** from `ClientDetail.years`: the one the statements were
  uploaded into. If there are several, a year picker (read-only) shows; if there are none, "No books yet.
  Upload a bank statement and they fill in."
- Its header is the business's name, the switch, and PLAN.md's line: "This is what your accountant sees.
  They work on these same books, so nothing gets typed in twice." **Back to your tax** goes to
  `/businesses/{id}`. No practice crumbs.
- It supplies the same outlet context as `YearLayout` (`{ year, client, chart }`), so the tabs are the
  practice's own components, not copies.

**1.3 A server with no sole-trader template.** As Context shows, a guest's business can't be made
without it, and every year that exists has a template and mapping pinned. So the cases the statements tab
has to handle are:
- **No year yet** (a signed-up owner before their first upload): the layout's "No books yet" above. The
  server isn't asked.
- **The report can't be built** (`report_failed`, for example an account the accountant added that the
  mapping's ranges miss): in the read-only view, "The statements can't be shown yet: the layout your
  accountant uses doesn't cover every account. The trial balance, journals and ledger are all here." The
  mapping details are for the practice's own screen, which shows them as today.
- **A pinned version is missing** (which shouldn't happen): `ledger::pinned_layout` answers
  `not_found("template version")` today. Agent 2 makes the report read answer a coded 422, `no_layout`,
  "There's no statement layout for this business yet.", and the read-only view shows that sentence. No
  path in the report read may answer a 500.

**1.4 Account codes in the accountant view's general ledger (decided 2026-11-07: A).** Today the GL
leaves codes out for business owners (`reports::shows_codes`), but the trial balance and the chart they
can already read show them.
- **A. Show codes to everyone (recommended). Chosen.** `shows_codes` goes. The accountant view is then
  exactly the accountant's screen, and hiding codes in one tab while the next tab shows them protects
  nothing. Owner screens outside the accountant view never read the GL, so nothing else changes.
- B. Keep the GL without codes for owners and guests. The view differs from the accountant's in that
  one tab.

Recorded in `docs/domain.md` ("Sole-trader chart and template").

### 2. Claimed owners get the same switch, read-only (recommended)
"Your accountant gets proper books" is part of the owner's pitch, and the owner reads these routes
already. **Nothing they can read changes**: M21 adds no route for owners. What changes is that the web
links to the reads, and leaves out the buttons the server would refuse anyway. With 1.4 A, the GL shows
codes, which they already read in the trial balance. If the owner has invited an accountant, the
accountant's journals show in the view; that's the point ("the same books").

The switch, **Your view · Accountant view**, shows on `/businesses/{id}` for business owners and guests
(and so for an overseer viewing as an owner). Practice users have the real year screens and don't get it.

### 3. The peak rules
**3.1 The first saving on their own file.** Shown when the Save tax queue's `saved_so_far` (the server's
figure) is **$100.00 or more** (10,000 cents), on a guest's **own** business, never an example and never
for a claimed owner. The browser compares the server's figure with a constant; it works nothing out.

> Keep the $3,257.17 you've saved: save your work. It takes 20 seconds. **Save your work** · Not now

- `$X` is `saved_so_far`, formatted by `money.ts`, and it follows the figure while the line is up.
- **Cumulative, not one answer's saving**: the line names what they've saved in all, so the threshold is
  on the same figure.
- **Checked against the examples** (as if each were a visitor's own file): the first card alone saves
  $3,257.17, $5,591.15 and $14,701.55, so the line appears after the first answer in all three. A lower
  threshold wouldn't show it sooner, and $100 keeps it from saying "Keep the $4.20 you've saved". A better
  rule wasn't found: anything relative (a percentage) would hide it for a small business whose $300 saving
  matters.
- **Once per trial.** When it first shows, the browser records it under `acct.peak.saving.<business id>`.
  It stays for the rest of that page's visit, so it isn't snatched away, and doesn't come back on a later
  visit. **Not now** hides it at once. Both the home page's Save tax step and the Save tax page read the
  same key, so seeing it on one counts for both.
- **Browser storage, recommended**, because it's only a nudge: if storage is blocked or cleared, the worst
  case is that it shows once more. A server flag would need a write for a nudge (a command, or a write
  outside the pipeline against hard rule 6). Every read and write is in try/catch, and the page works
  without it.

**3.2 Filing.** As ADR 014, 5 (chosen A): saving their work is the first step of Submit. Until M14 the
Submit step's "Save your work to file. It's the first step." sends `from: "submit"`.

**3.3 Something only an account can do.** M20's "Save your work first to …" lines, plus the PDF (1.1).
Each sends its own `from` (4).

**3.4 An example's peak is their own file.** On an example business, once `saved_so_far` is $100.00 or
more (the same rule, so one rule covers both), under "saved so far":

> Like that? Drop your own statement and see yours.

It links to the home page's drop zone (on the home page, it scrolls there). It asks for no account, so
it isn't remembered or dismissed: it shows whenever the example's saving is over the threshold. In all
three examples that's after the first answer.

**3.5 "Before the trial goes" (decided 2026-11-07: A).** PLAN.md has the banner say so plainly in a trial's last
48 hours. But a trial's 7 days slide: every request moves them on (Context). So a visitor using their own
trial is never within 48 hours of losing it. They see 48 hours only on the very first `/api/me` after
being away 5 days or more, and the next request renews it. An example lives a fixed 24 hours, so it's
always in its last 48; it already says "This is an example · kept until …" and has nothing to save.
- **A. Drop the countdown wording (recommended). Chosen.** The banner keeps "Your work isn't saved yet ·
  kept until <date>", and the claim form says "Trials are kept for 7 days after you last use them."
  Honest, no nagging, and nothing to build. Peak 5 becomes the banner's wording, not a new state.
- B. A welcome-back line. If the first `/api/me` of a page load shows less than 48 hours left, the web
  keeps, for that visit: "Welcome back. We'd have deleted this trial on <date>. It's kept 7 more days now;
  save your work to keep it for good." The banner's button then sends `from: "expiry"`. Small, but it
  depends on `/api/me` being the first request, which holds today because `App` waits for it.
- C. As PLAN.md says. A "last 48 hours" banner, which almost nobody would ever see, for the reason
  above.

With A, `expiry` stays on the `from` list (4) unused, so that B can be added without a type change.

**3.6 Never before.** No pop-up or modal on arrival, no `beforeunload` handler, no timers, nothing that
counts down live. The banner's date is a date.

### 4. `from` on `claim_guest`
`claim_guest { email, display_name, password, business_name?, from? }`. `from` names the prompt that led
to the claim. A closed list, as a Rust enum with an explicit name per value, so ts-rs generates the
string union and the web can't send a typo:

| `from` | Sent by |
|---|---|
| `banner` | The guest banner's or site header's **Save your work**, anywhere not covered below. |
| `accountant_view` | The banner's or header's button while on an accountant-view page (`/businesses/{id}/books/*`). |
| `saving` | The first-saving line (3.1). |
| `submit` | The Submit step (3.2). |
| `locked:invite` | "Save your work first to invite your accountant." |
| `locked:ai` | The AI suggestions lock (`SaveTaxAi`). |
| `locked:pdf` | The PDF lock (1.1). |
| `expiry` | The welcome-back line, if 3.5 B is chosen. |

- Where several could apply, the most specific wins: a lock or line beats the page, and the page beats the
  banner.
- **An unknown value is refused** (serde refuses an unknown variant, so the command is malformed). The web
  and server ship together, and values are only ever added, so a stale tab still sends known ones.
  **A missing `from` is accepted**, stored as absent, and counted as "not recorded", so a claim never fails
  over a measurement.
- **Stored only in the command's own log payload** (`logged_payload` keeps it; it isn't a secret). No new
  column. The `claim_guest` row is never redacted (Context), so it lasts as long as the log.
- **Never shown to the visitor:** the claim route's response doesn't echo it, `/api/sync` sends no
  payloads, and `history::describe` for `claim_guest` stays "saved their work as Ana Ngata", with no
  `from`. Their accountant, if they invite one, sees the same description.
- `adopt_guest_business` (signing in to an existing account instead, ADR 014, 4) has no `from`. It's
  counted as a save of its own kind (5).
- The privacy policy says we note which button led to saving the work, and count it (NON-CODE-TODOS.md).

### 5. The overseer's counts
**`GET /api/overseer/trials`, overseers only, read from `command_log`, so no new table** (recommended:
the log already has every start, claim and expiry, with a time). For each of the last 12 weeks, newest
first, weeks starting Monday 00:00 UTC (a few hours off NZ's Monday at the edges, which doesn't matter for
counts and needs no time zone library):
- **started:** `start_guest` rows;
- **saved:** `claim_guest` rows, and separately `adopt_guest_business` rows ("moved into an account");
- **expired:** `expire_guest` rows, by `why`: `unused` (not back in 7 days), `by_you` (deleted it
  themselves) and `example_finished`;
- **saves by `from`:** `claim_guest` rows grouped by `payload.from`, absent as "not recorded".

These are events in the week they happened, not cohorts (a trial started in one week and saved the next
counts in each). Cohorts are possible later: `user_id` survives redaction, and joins a guest's
`start_guest` to their `claim_guest`.

**What a redacted (expired) trial still contributes:** its `start_guest` row (`kind` and `at` survive), so
it's counted as started; and the `expire_guest` row that ended it, which isn't redacted, so it's counted
as expired with its `why`. It never has a claim. It can't say whether the trial started from an example or
their own file, because that was in the redacted payload. Counting that would mean keeping a marker
through redaction, which changes ADR 014, 6; not recommended for M21.

**Counting never reads a redacted payload.** It reads payloads only of `claim_guest` and `expire_guest`
rows, and the query also says `redacted_seq IS NULL` for those, so a future change to redaction can't make
it read one. `start_guest` and `adopt_guest_business` are counted by `kind` and `at` alone. A test redacts
a trial and checks it still counts as started and expired.

This keeps ADR 014, 1's promise: counts only, never a business's data. It needs no third-party analytics
and no cookie beyond the session. Shown in Settings → Tools.

Access: a new `RouteRule::Overseer`, checked as the effective identity, so an overseer viewing as someone
is refused, as that person would be. Migration 0015 adds an index on `command_log (kind, at)` so the count
doesn't scan the whole log.

### 6. "Who are you?"
**Asked only if this guest opened the accountant view.** The web records it in browser storage under
`acct.guest.<guest user id>.books` when an accountant-view page renders for a guest (recommended over a
flag on the guest: it's only used to decide whether to ask a question, and a server flag would be a write
on a read). Keyed by the guest's user id, so a later guest in the same browser isn't asked because of an
earlier one. If storage is blocked or cleared, they aren't asked, and get the owner's path: the safe one.

**Save your work** then opens with the question first:

> **Who are you?** (•) I run this business ( ) I'm an accountant or bookkeeper **Continue**

- **I run this business is selected by default**, because getting it wrong costs differently (PLAN.md):
  an accountant sent down the owner's path loses one click; an owner sent down the accountant's path loses
  their trial and lands in a product they don't need. Opening the accountant view is a reason to offer the
  choice, never a reason to pick it for them.
- **I run this business** continues to M20's claim form, unchanged (with the `from` the button had).
  For a guest with only an example, that's M20's "Examples can't be saved" with Sign up.
- **I'm an accountant or bookkeeper** opens the practice request (7). This matters most for example-only
  guests, who are most often accountants: they're asked before being told an example can't be saved.
- A guest who never opened the accountant view goes straight to the claim form, as in M20.

### 7. The practice request
**`request_practice_account { name, email, practice_name, clients, phone?, from? }`**, through the
pipeline, on **`POST /api/practice-requests`** (Public). The same route serves a signed-out visitor
(`/accountants`, `/signup`) and a guest (from "Who are you?"). The route submits it with no user, the way
sign-up does, whatever session the browser has, so the request is never tied to a trial: the trial isn't
moved, read or kept longer, and the request holds none of its data.
- `clients` is a band, since PLAN.md asks for "roughly": `up_to_10`, `11_to_50`, `51_to_200`, `over_200`.
- `from`: `who_are_you`, `accountants_page` or `signup_page`, shown in the overseer's list.
- Validated on the server: `name` 1–100 characters, `email` with an `@`, at most 254, `practice_name`
  1–120, `phone` at most 30 of digits, spaces and `+()-`. Each trimmed.
- The form says: "Please don't upload a client's statement here without their OK." After sending: "Thanks,
  {name}. We'll email {email} about setting up your practice." For a guest, also: "Your trial stays as it
  is: it's kept for 7 days after you last use it, and you can still save it."

**What's stored (migration 0015):** a `practice_requests` table with `id`, `name`, `email`,
`practice_name`, `clients`, `phone` (nullable), `came_from` (nullable; `from` is an SQL keyword),
`created_seq` and `created_at`.
- **The log entry keeps none of the personal fields.** `logged_payload` replaces `name`, `email`, `phone`
  and `practice_name` with `"[redacted]"` (a one-person practice's name is often a person's name), keeping
  `clients` and `from`. The details live only in the table, as a statement file's bytes live only in
  `statement_files` (M18). So deleting the row deletes them, with no second exception to an append-only
  log.
- **Kept 90 days from arrival** (recommended), then deleted: long enough to reply and talk it through.
  Someone who becomes a customer has their details in their user account and contract instead. The guest
  sweep also submits `delete_practice_request { request_id, why: expired }` as the server for each
  request past 90 days. An overseer can submit it sooner (`why: by_overseer`): spam, or the person asked
  (IPP 6 and 7).
- **Who can list it: overseers only.** `GET /api/practice-requests` with `RouteRule::Overseer`, newest
  first. Not practice admins: the request is to us, who run the service, not to a practice. In Settings →
  Admin.
- **Its log rows are for overseers only**, like `expire_guest`'s: `history::row_shown` gains both kinds.
  Descriptions name no one: "A practice asked for an account (11–50 clients)" and "Deleted a practice
  request after 90 days".

**The per-address limit** reuses ADR 014, 8's machinery (in-memory fixed windows, an IPv4 address or an
IPv6 /64, `Fly-Client-IP` only behind Fly, HTTP 429 with `Retry-After`, checked before the pipeline):
- **5 per address per hour.** "We've had a few requests from your network in the last hour. Try again
  later, or get in touch through the contact page."
- **100 across all addresses per day**, checked inside the command from the table, so it holds across
  restarts. The same message.
- No CAPTCHA, as ADR 014. Revisit if spam starts.

**The privacy policy line** (NON-CODE-TODOS.md): "If you ask for a practice account, we keep your name,
email, practice name, roughly how many clients you have, and your phone number if you give it, to get in
touch about it. Only our team sees it. We delete it 90 days after you send it, or sooner if you ask."

**What an overseer does next** is by hand (NON-CODE-TODOS.md): read the list, reply, and set the practice
up. **Until practice tenancy exists (8), a second firm's people can't safely be practice users on a server
that holds another firm's clients:** every practice user sees every client without an owner, and a
`practice_admin` controls the server-wide charts, templates, paragraphs and users. So the honest replies
today are: the firm is the server's only practice; or it gets a server of its own (a second Fly app, ADR
008); or it waits for tenancy, while it can already work on any business whose owner invites a user we
make for it, as long as the server holds no practice-owned clients of another firm.

**Should accepting a request make the user? (decided 2026-11-07: A)**
- **A. Stay manual for now (recommended). Chosen.** The overseer reads the request and makes users as today. The
  reason above is why: making a `practice_admin` from a request on this server would hand a stranger the
  only practice's defaults and users, and every client without an owner. A command for it is worth
  building with tenancy, when it can make a practice of their own.
- B. `accept_practice_request { request_id, role }`, overseers only: makes the user from the request
  (inactive until they set a password), with an invite-style link the overseer sends (made in the browser,
  stored as a hash, once, 14 days, as owner invites are). It saves typing, but carries the tenancy risk
  above until tenancy exists, so the overseer would still have to judge every one.

### 8. Self-serve practice accounts: what tenancy would take
M21 doesn't start this. Written down so it can be planned as its own milestone (PLAN.md's White label
backlog item):
- **A `practices` table**, and a `practice_id` on every practice-level row: master charts, templates and
  their versions, mappings and their versions, asset classes, the paragraph library, merchants, practice
  settings, and every practice user. Today's data moves into practice 1 in one migration.
- **Every practice-level read and command scoped by the actor's practice.** `RouteRule::Practice` and
  `Target::Practice` take the actor's practice; `can_see` for practice roles becomes "clients of my
  practice, plus those shared with my practice", not "every client without an owner"; `visible`, the sync
  feed and Changes filter by practice. `tests/tenancy.rs` walks every route twice: same practice, other
  practice.
- **Accountant access by practice:** invites name a practice, and `client_access` grants an accountant
  through their practice.
- **Defaults per practice:** `install_starter_set` installs into one practice; "defaults never reach back"
  holds within each.
- **Guests need a home:** a guest's business is set up from "the" sole-trader master chart today. With
  tenancy, that's the service's own default practice.
- **Sign-up for a practice:** `sign_up_practice` makes the practice and its first `practice_admin`, and
  installs the starter sets. Billing is per practice. Branding and a practice's own domain (white label)
  come after.
- Overseers stay across all practices. Impersonation (ADR 013) and the guest rules (ADR 014) are unchanged.

## Consequences
**Migration 0015** (append-only; Agent 2 uses the next free number if 0015 is taken, and says so):
- `practice_requests` (7).
- `CREATE INDEX command_log_kind ON command_log (kind, at)` (5).

**New commands:**
- `request_practice_account`: no user, only through its route; a target like `SignUp`'s, so
  `/api/commands` refuses it for anyone signed in.
- `delete_practice_request { request_id, why }`: the server's sweep, or an overseer.

Each needs: an `access::command_targets` rule; a place on M19's `NEVER` list; `GUEST_REFUSED` ("do
this"); a `describe` arm in history (`history::tests`); `history::row_shown` for overseers only; and
`logged_payload` redaction for `request_practice_account`.

**Changed command:** `claim_guest` gains `from?: ClaimFrom` (4).

**New routes:**
- `POST /api/practice-requests` (Public, per-address limit).
- `GET /api/practice-requests` (Overseer).
- `GET /api/overseer/trials` (Overseer).
Each in `lib.rs`'s `routes()`, `access::route_rule`, and `tests/tenancy.rs`.

**Guest route additions** (`guests::route_allowed`): `GET /api/years/{id}`, `/journals`, `/tb`, `/report`,
`/gl` and `/assets`. `check_route` words `report.pdf` as "download the PDF".

**Access changes:** `RouteRule::Overseer` (effective identity must be an overseer). Nothing else: the new
guest reads go through the existing year rule.

**Server, elsewhere:**
- the report read answers `no_layout` (422), never a 500 (1.3);
- `reports::shows_codes` goes (1.4 A), so the GL and analysis show codes to everyone;
- `guests::Limits` gains the per-address practice-request window; the sweep deletes old requests.

**Types** (generated by `make types`): `ClaimFrom`, the `ClaimGuest` payload's `from`,
`RequestPracticeAccount`'s payload, `PracticeClients` (the band), `PracticeRequestFrom`,
`PracticeRequestView` (the overseer's list), and `TrialCounts` with `TrialWeek`.

**Web** (Agents 3 and 4): the read-only context and the `/businesses/{id}/books/*` routes (1.1, 1.2), the
switch (2), the peaks (3), `from` on every claim path (4), "Who are you?" (6) and the request form (7).
Agent 4 also builds the overseer's two Settings panels: the counts in Settings → Tools and the requests
in Settings → Admin.

**Docs:** `docs/security.md` gains the M21 rows (Planned). `NON-CODE-TODOS.md` gains the privacy policy
lines, the follow-up routine and the one-practice caution. `docs/domain.md` records 1.4.
