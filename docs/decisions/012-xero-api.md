# 012: Pulling history through Xero's API

Status: accepted (2026-10-26). The owner chose not to build it (see "Recommendation").
- PLAN.md M16 says pulling history through Xero's API is a later option, decided by an ADR once Xero's
  developer terms and pricing have been checked. This is that ADR.
- Nothing here changes M16's main route: importing Xero's and MYOB's standard exports, which the owner
  or accountant downloads themselves.

## Context
M16 ("Bring your history") lets an owner or practice who is leaving Xero bring the chart of accounts,
trial balances, general ledger detail and contacts across, so earlier years become comparatives. The
export route works today. Someone runs Xero's reports, downloads the files and uploads them to us. An API
pull would save those steps: the owner clicks "Connect to Xero", approves access on Xero's own site, and
we fetch the same data.

ADR 007 lets the server call outside services, provided that each integration lives in its own crate
behind a trait, that tests run without a network, and that whatever comes back is validated as input to a
command. ADR 009 shows the shape for such an integration.

Everything below was checked on 2026-10-26 against Xero's own pages unless it's marked otherwise.

## What Xero's terms allow

### The developer terms
The [Xero Developer Platform Terms and Conditions](https://developer.xero.com/xero-developer-platform-terms-conditions)
(last updated 4 December 2025) govern every app that uses the API. Three clauses matter here.

- **Clause 29, prohibited uses.** It introduces its list with "things you mustn't ever do", and the list
  includes:
  > Access or use the developer platform for the purpose of attempting to move customers off Xero, or
  > substantially reproducing our products or services.

  M16 is a migration feature: it exists to move a business's history out of Xero and into a product that
  does the same job. On a plain reading that is the prohibited purpose. The words "for the purpose of"
  give a little room for an app whose purpose is something else, but "Bring your history" isn't such an
  app. We'd be relying on Xero choosing not to enforce its own terms.
- **Clause 7, API data.** API data may be used only "for the specific purpose of developing, testing, and
  supporting your app's features in accordance with your approved use case". Xero approves the use case,
  so it would see this one.
  - 7(b)(i): "API Data cannot be used to train, fine tune, adapt, or enhance any AI Models." ADR 009's
    labelled set and bake-off would have to exclude anything that came from Xero. Layer 2 of ADR 009 (the
    business's own coding history, used as examples in a prompt) is inference, not training, but the FAQ
    doesn't say so explicitly. We'd need Xero to confirm it.
  - 7(b)(ii): API data can't go to a third party without the user's consent. The AI provider would be a
    third party.
- **Clauses 12 and 15, user data.** We must get every consent the user's data needs, protect it with
  "at least industry standard" measures that meet Xero's security requirements, and report a security
  incident to Xero within 24 hours.

### The commercial terms and certification
The [Commercial Terms](https://developer.xero.com/xero-developer-platform-commercial-terms) (4 December
2025, applying to everyone from 2 March 2026):
- 2.1: apps must be certified by Xero before they're offered to Xero users, and recertified every year.
  Certification covers the connection, branding, scopes and use cases, error handling, data integrity and
  security, account mapping and tax rates.
- 3.1(f): the developer must "maintain and grow customers on Your App that are also actively using Xero's
  services". A migration app's customers stop using Xero, by design.
- 2.2(d): a connection counts towards the fee until we remove it, so connections must be removed when a
  user leaves.
- 8: Xero may suspend an integration that stops meeting certification or breaches section 3.

### The Journals endpoint is a premium feature
The general ledger detail comes from the Journals endpoint, which is different from Manual Journals.
According to the [pricing page](https://developer.xero.com/pricing) and the
[pricing FAQ](https://developer.xero.com/faq/pricing-and-policy-updates) (Q07, Q20):
- Journals is available only from the Advanced tier upwards.
- It needs an initial and annual security assessment, and Xero's approval of the use case.
- Manual Journals is available on every tier, but it holds only journals typed in by hand, not the
  ledger.

### Rate limits
From [Xero's limits FAQ](https://developer.xero.com/faq/limits), per connected organisation:
- 5 calls in progress at once, 60 calls a minute and 5,000 a day (1,000 a day on the free Starter tier).
- 10,000 calls a minute across the whole app.
- Going over returns HTTP 429 with a `Retry-After` header. Paged endpoints return 100 items a page.

A sole trader's history is small. For example, five years at about 2,000 ledger lines a year is about
10,000 lines, which comes to roughly 100 to 300 calls in all. That's well inside the daily limit, so rate
limits wouldn't be the problem. (This is our estimate, not Xero's figure.)

## Pricing at our scale
Xero's tiers took effect on 2 March 2026. Prices are in AUD a month, excluding tax, and the source is the
[pricing page](https://developer.xero.com/pricing):

| Tier | Connections | Fee | Egress included | Journals endpoint |
|---|---|---|---|---|
| Starter | 5 | free | n/a | No |
| Core | 50 | $35 | 10 GB | No |
| Plus | 1,000 | $245 | 50 GB | No |
| Advanced | 10,000 | $1,445 | 250 GB | Yes, after a security assessment and approval |
| Enterprise | unlimited | on application | on application | not stated |

Egress over the allotment costs $2.40 a GB. Egress is data downloaded from Xero, metered for each app.

- **100 connected organisations:** Plus at $245 a month, without the ledger detail. With it, Advanced at
  $1,445 a month.
- **1,000 connected organisations:** Plus allows exactly 1,000, so we'd need Advanced at $1,445 to have
  any headroom. Advanced is needed for the ledger detail anyway.
- **Egress:** at our estimate of about 10 MB for each organisation's history, 1,000 migrations come to
  about 10 GB, which fits every paid tier's allotment.
- **Connections are short-lived for a migration.** We'd pull once and disconnect, so the number connected
  at any one time stays far below the number migrated. Without Journals, Core ($35) might be enough. With
  it, it's Advanced, whatever the count.

So the realistic cost of the full pull, including the general ledger, is **AUD 1,445 a month (about NZD
1,600) from the first customer**, plus certification and a yearly security assessment.

## OAuth 2.0: what we would hold
- The user signs in on Xero's own site and approves the scopes there. **We never see or store a Xero
  password.** We receive an authorisation code and swap it for tokens.
- From [Xero's OAuth FAQ](https://developer.xero.com/faq/oauth2):
  - Access tokens last 30 minutes.
  - Refresh tokens rotate: every refresh returns a new one that replaces the old one.
  - An unused refresh token expires after 60 days.
- Apps created after 2 March 2026 must use Xero's granular scopes. For a pull those would be read-only:
  `accounting.settings.read` for the chart and organisation, `accounting.reports.trialbalance.read`,
  `accounting.contacts.read`, and the Journals scope Xero grants with Advanced approval. The scope names
  come from a third-party summary ([Apideck](https://www.apideck.com/blog/xero-scopes)), so they need
  checking against the developer portal.
- **A one-off pull needs no stored tokens.** The server would hold the access token in memory for the few
  minutes the pull takes, never ask for `offline_access` (so no refresh token is issued), and remove the
  connection (`DELETE /connections/{id}`) when it finishes. That also stops the connection counting
  towards the fee (Commercial Terms 2.2(d)).
- If we ever needed an ongoing connection (see "A different use case" below), we'd store the refresh token
  encrypted at rest:
  - AES-256-GCM, with a key from the server's configuration, never in the repo, the database or a log
  - in its own table, like login sessions, which aren't practice data (hard rule 6)
  - with connecting and disconnecting logged as commands, without the token

## What we'd pull and where it goes
The API returns the same information as the exports M16 already parses, so an API pull would produce the
same `crates/import/src/history.rs` types as the Xero export parser and go through the same import
commands. Only the transport differs. The types below are as proposed for `history.rs` on 2026-10-26.
That file doesn't exist yet, so check this table against it when it lands.

| Xero endpoint | Fields used | `history.rs` type |
|---|---|---|
| `GET /Organisation` | financial year end, base currency (must be NZD), GST basis | sets `HistorySource::Xero` and checks the import is in scope |
| `GET /Accounts` | `Code`, `Name`, `Type`, `TaxType`, `Status` | `HistoryAccount`. `Type` (BANK, CURRENT, FIXED, REVENUE, OVERHEADS and so on) collapses onto `SourceAccountType`, and the raw string is kept in `source_type`. `Status` gives `active`. The bank account number isn't kept. |
| `GET /Reports/TrialBalance?date=` | account code, debit and credit, at each balance date | `HistoryTb` with `as_at` |
| `GET /Journals` (Advanced only) | `JournalDate`, `JournalNumber`, `SourceType`, and the lines' `AccountCode` and `NetAmount` | `HistoryGlLine` |
| `GET /Contacts` | `Name`, `IsCustomer` / `IsSupplier`, `TaxNumber`, email, phone | `HistoryContact` |

Notes:
- **Money.** Xero's JSON gives amounts as decimal numbers. The adapter must read them as text and parse
  them to `Money` in cents, never through `f64` (hard rule 4), and reject any amount with more than two
  decimal places.
- **Comparatives don't need the ledger.** Trial balances at each 31 March, plus the chart, are enough for
  comparatives. The ledger detail is only needed for drill-down into earlier years. Without Journals, the
  pull drops to the cheaper tiers.
- **Books source.** A business arriving part-way through a year needs a cut-over TB alongside bank
  coding, which bends the books-source rule (`docs/domain.md`, "Books source"). That's M16's question
  whichever way the data arrives, and isn't decided here.
- **Multi-currency** organisations are refused, as they would be from an export (it's out of scope).

## The crate boundary (ADR 007)
If it's built:
- **`crates/xero`**:
  - a `XeroSource` trait with `organisation()`, `accounts()`, `trial_balance(date)`, `journals(offset)`
    and `contacts(page)`, each returning Xero's records as plain structs
  - `HttpXero`, the real client, which handles OAuth, paging, 429s with `Retry-After`, and the
    disconnect at the end
  - `FakeXero`, which serves synthetic JSON from `fixtures/xero/` for tests and `acct-dev`
- **The conversion is pure**, from Xero's records to `HistoryImport`, and lives in `crates/import` next to
  the export parser, so the two can't drift apart. Tests feed it the fake's output.
- **Tests never touch the network.** The real client is tested only against recorded responses, which are
  synthetic (hard rule 1).
- **From pull to command.** The pull runs outside any transaction, because the writer connection mustn't
  wait on the network. Its result is submitted through the same import commands as an uploaded export,
  and validated the same way. Core computes every figure.
- The client id and secret come from the server's configuration, never from the repo, the database or a
  log.

## Recommendation (accepted by the owner, 2026-10-26)
**Don't build it. Keep exports as the only route into M16, and change PLAN.md's "later option" line to
point here.**

Why:
1. **The terms forbid it.** Clause 29 prohibits using the platform "for the purpose of attempting to move
   customers off Xero", and moving customers off Xero is what "Bring your history" is for. Commercial
   Terms 3.1(f) expects our customers to keep using Xero. Certification would put our use case in front of
   Xero, and Xero can suspend the app (Commercial Terms 8). Building on this would be building on
   something Xero can switch off.
2. **The ledger detail costs the most.** The Journals endpoint needs the Advanced tier (AUD 1,445 a month
   from the first customer), a security assessment every year and Xero's approval. We'd be asking the
   competitor we're leaving to approve the use case.
3. **Exports already do the job.** The owner or accountant downloads their own reports, which Xero lets
   any subscriber do. That doesn't use the developer platform, so its terms don't apply. It costs us
   nothing and needs nobody's approval. A migration happens once per business, so a few manual steps,
   with clear instructions and screenshots in our own words, are a fair price.
4. **It adds risk for little gain**: another outside service, tokens, a certification and security review
   cycle on top of IRD's, and another subprocessor to disclose.

### A different use case, not proposed
A practice whose clients **stay on Xero**, preparing their statements here from a live Xero trial
balance, isn't "moving customers off Xero". It might be allowed, if Xero approves the use case and the
app isn't "substantially reproducing" Xero. It doesn't fit the current direction (owners on our ledger,
PLAN.md), and it would need the stored, encrypted refresh tokens described above. If it's ever wanted,
write to Xero first and get the use case confirmed in writing, then supersede this ADR.

## Consequences
- No `crates/xero`, no Xero developer app, no tokens and no Xero fees.
- M16's Xero route is the export import only. Its help screen tells people which Xero reports to export.
- PLAN.md's M16 line "Pulling history through Xero's API is a later option" changes to "Decided against:
  ADR 012".
- If Xero's terms change, or Xero confirms in writing that a one-off migration pull is acceptable, this
  ADR is revisited. The crate boundary above is the starting design.
