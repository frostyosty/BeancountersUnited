# Security

How White Label Accounting protects business owners' data and taxpayer information, what IRD expects of
us as a gateway services provider, and what we do when something goes wrong.

Status: draft (2026-10-24), written during M12. Items marked **planned (M12, Agent N)** are being built
now; update each one to point at the code when it lands. Names in `[BRACKETS]` are placeholders until the
contacts are chosen (see "Contacts").

## What IRD asks of us

IRD vets every digital service provider before granting gateway access, and again every year (ADR 007).
The requirements come from three published sources:

| Source | What it requires |
|---|---|
| [Operational Security Framework](https://www.ird.govt.nz/digital-service-providers/operational-security-framework) (updated 14 Apr 2026) | A "simplified ISO27001 aligned security review", tiered by the risk of the services we integrate with. An initial OSF questionnaire at registration, then an OSF review every year. |
| [Gateway Services Terms of Use, IR1269](https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir1200---ir1299/ir1269/gateway-services-terms-of-use.pdf) (February 2026; [summary page](https://www.ird.govt.nz/about-this-site/conditions-of-use/terms-of-use-for-gateway-services) updated 22 Apr 2026) | The binding terms. The [digital service provider terms page](https://www.ird.govt.nz/about-this-site/conditions-of-use/terms-of-use-for-digital-service-providers) now links to the same document. Clauses are summarised below. |
| [Working with us](https://www.ird.govt.nz/digital-service-providers/working-with-us) and [Information disclosures](https://www.ird.govt.nz/digital-service-providers/working-with-us/information-disclosures) | Business, integrity and security checks before access; services used only for tax and social policy purposes. |

**The questionnaire itself isn't public.** IR1269 clause 4(b) makes IRD's security requirements,
including the OSF and any assessment of us, confidential. So this document is organised by the areas an
ISO 27001-aligned review covers, and it must not quote the questionnaire. When IRD sends it, answer it
from this document, and keep the questions and our answers outside the repo (see "Contacts" for who holds
them).

### IR1269 clauses that shape our controls

| Clause | Requirement | Where we meet it |
|---|---|---|
| 4(a), 4(g) | Keep taxpayer information strictly confidential, with appropriate security against unauthorised access or use. | The controls in "Controls" below. |
| 4(c) | Keep our gateway account and login credentials safe. | "Secrets and credentials". |
| 4(e) | Comply with the Privacy Act 2020. | "Breach response", "What leaves the server". |
| 4(h), 4(i) | Use taxpayer information only as authorised; don't disclose it to a third party without the taxpayer's consent, and produce evidence of consent if asked. | Consent is a logged command (`command_log`), e.g. `set_ai_suggestions` (ADR 009). IRD-sourced data is never sent to any third party. |
| 4(j) | Give IRD our customer terms and conditions if asked. | Customer terms: [CUSTOMER TERMS LOCATION]. |
| 4(k) | Allow audits of our premises, systems and records, on 14 days' written notice. | `command_log`, access logs and this document are the starting point. |
| 4(p) | Don't share or outsource gateway access without approval. | Only `acctd` holds gateway credentials (M14). |
| 5.1 | **Promptly** notify IRD of a notifiable privacy breach involving taxpayer personal information, a confidentiality breach, a security breach affecting gateway use or taxpayer information, or unauthorised use of our gateway account, whether **experienced or suspected**. | "Breach response". |
| 5.2 | Notify IRD **in advance** of a change of purpose, **material changes to the systems that process taxpayer information**, and material business events (insolvency, key office holders, control, insurance). | Changing host, region, database, AI provider or anything in "What leaves the server" is a material change: tell IRD before it ships. |
| 6.7 | Customer terms must say how taxpayer information is handled if we stop trading. | Customer terms: [CUSTOMER TERMS LOCATION]. |

PLAN.md (M12) says IRD must be told "immediately". IR1269's current wording is "promptly". We hold
ourselves to the stricter one: IRD is told within the first hour of a suspected breach (see below).

## Controls

Each row is an area an ISO 27001-aligned review asks about, what we do, and where it lives.

### Organisation and people

| Control | What we do | Where |
|---|---|---|
| Security ownership | One named person owns security and this document. | [SECURITY LEAD] |
| Key people's integrity | IRD runs tax and integrity checks on the organisation and its key office holders (IR1269 3(b), 3(c)). | `NON-CODE-TODOS.md`, business track |
| Annual review | The OSF review each year; this document is re-read and updated before answering it. | This document's "Review" section |
| Real client data stays out of development | Hard rule 1: fixtures are synthetic; nothing real in the repo, its history or a Codespace. | `CLAUDE.md`, `fixtures/` |

### Access control and authentication

| Control | What we do | Where |
|---|---|---|
| Passwords | Hashed with argon2id; at least 10 characters, at most 256. | `crates/server/src/auth.rs:3`, `:48` |
| Session tokens | Random tokens; the browser holds the token in an `HttpOnly`, `SameSite=Strict` cookie; the database stores only its SHA-256. Sessions last 12 hours and expired ones are deleted on login. | `crates/server/src/auth.rs:30`, `:74`; `sessions` in `crates/store/migrations/0001_initial.sql` |
| `Secure` cookie flag | Not set yet (`auth.rs:75` still assumes the old plain-HTTP LAN). **Planned (M12, Agent 6).** | |
| Two-factor sign-in | An authenticator app (TOTP). **Planned (M12, Agent 6).** | |
| Login throttling | Limits on failed sign-ins per account and per address. **Planned (M12, Agent 6).** | |
| Roles | `overseer`, `practice_admin` (was `Master`), `staff`, `viewer`, and `business_owner`, who sees and changes only their own business. Every read and command checks the role. The rename is **planned (M12, Agent 3)**. | `crates/store/src/users.rs:11`; `CLAUDE.md`, "Roles" |
| Tenancy | One owner can never read or change another's business; tests prove it. **Planned (M12, Agent 3)**; `crates/store/migrations/0007_tenancy.sql` reserves the migration. | |
| Server re-validates everything | The UI is untrusted: every command is validated and recomputed in the pipeline (hard rule 4, 6). | `crates/server/src/pipeline.rs` |

### Data protection

| Control | What we do | Where |
|---|---|---|
| In transit | HTTPS only, terminated at Fly's proxy; plain HTTP is redirected. **Planned (M12, Agent 1).** | `fly.toml:33` (`force_https`), ADR 008 |
| At rest | Encrypted database volume and encrypted backups. **Planned (M12, Agent 1, Agent 2).** | ADR 008 |
| Where the data lives | Fly.io, region `syd` (Sydney, Australia), for production and staging. Fly has no NZ region, so the records are stored offshore. Storing NZ taxpayers' records outside New Zealand needs IRD approval or an approved provider (see [third-party providers approved to store records offshore](https://www.taxtechnical.ird.govt.nz/general-articles/third-party-providers-approved-to-store-taxpayer-electronic-records-offshore)). **Open: check whether Fly.io and Tigris are on that list, and if not, apply to IRD before real data goes in.** ADR 008 records the decision. **Planned (M12, Agent 1).** | `fly.toml:8`, `fly.staging.toml:7`, ADR 008 |
| myIR tokens | Stored encrypted; we never see or store myIR passwords. **Planned (M14).** | PLAN.md, M14 |
| Filed returns | The exact payload, IRD's response and the payload's SHA-256 are stored and never regenerated. **Planned (M14).** | PLAN.md, M14 |

### Integrity and change history

| Control | What we do | Where |
|---|---|---|
| One write path | Every change to practice or client data is a command: validated, applied and appended to `command_log` in one transaction (hard rule 6). | `crates/server/src/pipeline.rs`; `command_log` in `crates/store/migrations/0001_initial.sql:43` |
| Who changed what | Each command row records its kind, payload, result, `user_id`, business and time. M13 builds the visible history on it. | As above |
| Immutable ledger | Posted journals never change; corrections reverse. Finalised years and filed periods reject changes. | `CLAUDE.md`, "Domain invariants" |

### Operations

| Control | What we do | Where |
|---|---|---|
| Backups | `acctd backup <path>` with `VACUUM INTO`, plus continuous backup with Litestream to a Tigris bucket (7 days kept), plus Fly volume snapshots. **Planned (M12, Agent 2).** | `crates/store/src/backup.rs`, `litestream.yml`, `docs/operations.md` |
| Restore drill | Documented, and run until staging comes back with an identical `command_log`. **Planned (M12, Agent 2).** | `docs/operations.md`, "The restore drill" |
| Deploys | GitHub Actions to staging, then production. **Planned (M12, Agent 1).** | ADR 008 |
| Dependencies | Each new dependency is justified in its commit message; `make check` runs clippy with `-D warnings`. | `CLAUDE.md`, "Working conventions" |
| Tests don't touch the network | Each outside integration sits behind a trait with a fake (ADR 007). | `crates/ai` |

### Secrets and credentials

- Secrets (the AI key, M14's gateway credentials and certificates, the database encryption key) come from
  the host's secret store as environment variables (`AI_API_KEY` and friends, ADR 009). They are never in
  the repo, the database or a log.
- Gateway credentials are held by `acctd` only, and only [SECURITY LEAD] and [TECH LEAD] can read them
  on the host.
- Rotate a secret at once if it might have been exposed (see "Breach response").

## Access logging

### What we log

| Event | Fields | Status |
|---|---|---|
| Every change | `command_log`: command kind, payload, result, user, business, time, `seq`. | Built |
| Sign-in | User, time, IP address, user agent, whether two-factor was used. | **Planned (M12, Agent 6)** |
| Failed sign-in | Username tried, time, IP address, user agent, reason (unknown user, wrong password, wrong code, throttled). | **Planned (M12, Agent 6)** |
| Sign-out, session expiry, two-factor set up or removed, password change | User, time, IP address. | **Planned (M12, Agent 6)** |
| Who read which business | User, business, what was read (the endpoint, not the data), time. One row per user, business and endpoint per minute is enough. | **Planned (M12, Agent 6)** |
| Calls to IRD | Operation, business, time, outcome; never the payload in a log (the payload is stored separately, M14). | **Planned (M14)** |
| Calls to the AI provider | Count, model, outcome; never request or response bodies (ADR 009). | Built, `crates/server/src/ai.rs` |

Logs never contain passwords, session tokens, two-factor secrets, API keys, bank descriptions, IRD
numbers or request bodies.

### How long we keep it

- `command_log`: for as long as the business's data is kept. It is the record of the books, and tax
  records must be kept for at least 7 years.
- Sign-in and read logs: [RETENTION, proposed 2 years], then deleted by a scheduled job. Long enough to
  investigate a breach found late; short enough not to become a record of people's habits.
- Server (stdout) logs: whatever the host keeps, at most [HOST LOG RETENTION, ADR 008].

### Who can see it

- A business owner sees sign-ins to their own account, and who opened their business and when.
- A practice admin sees the same for their practice's users and clients.
- The overseer, [SECURITY LEAD] and [TECH LEAD] see everything, and only to run the service or
  investigate an incident. Their own reads of the logs are logged.
- IRD may see them during an audit (IR1269 4(k)).

## What leaves the server

| Destination | What goes | When | Basis |
|---|---|---|---|
| IRD's gateway services | Return payloads core builds, filing and status requests, the business's IRD identifiers. | M14, when the owner files or checks a return. | The owner's own return, authorised through myIR. |
| AI provider (Anthropic, Claude Haiku 5.5 during development; the bake-off picks the production model) | Redacted bank descriptions (60 characters at most), whole-dollar amounts, direction, our category list, and the owner's optional activity phrase. Processed overseas; retained up to 30 days; not used for training. | M11, only for businesses that opted in (`set_ai_suggestions`). | Consent, recorded in `command_log`; the provider acts as our agent (Privacy Act 2020 s 11). IRD must confirm in writing before real owners use it (ADR 009). |
| Backup storage (Tigris, through Fly) | The whole database, encrypted. | Continuously, by Litestream. **Planned (M12, Agent 2).** | Our own bucket; `litestream.yml`, ADR 008. |
| The host (Fly.io) | Everything, as the place the server runs. | Always. | ADR 008. |

**What never leaves**, to anyone:
- Anything IRD sent us (prefill, filing data, return status), except back to IRD.
- Owners' names, business names, IRD numbers, bank account numbers, addresses and emails, except to IRD
  where a return needs them.
- Passwords, session tokens, two-factor secrets, myIR tokens and API keys.
- Statement files as uploaded.
- Anything to Icon Studio's image service: it gets icon descriptions only (`CLAUDE.md`, "Icons and
  emoji").

### Subprocessors

List each one in the OSF answers and in our privacy notice. Adding or changing one is a material change
under IR1269 5.2(b): tell IRD first.

| Subprocessor | Role | Data | Location |
|---|---|---|---|
| Fly.io | Hosting, volumes, volume snapshots | Everything | Sydney, Australia (`syd`) |
| Tigris (through Fly) | Continuous backup storage | The whole database | [TIGRIS REGION, ADR 008] |
| Anthropic | AI category suggestions (opt-in) | Redacted lines, as above | Overseas (global routing) |
| [EMAIL PROVIDER, if sign-up sends email] | Sign-up and sign-in email | Email address, name | [LOCATION] |

GitHub holds the code only, never customer data (hard rule 1).

## Breach response

A breach is anything that exposes, changes, loses or makes unavailable customer or taxpayer
information, or lets someone use our gateway account, **whether confirmed or only suspected**
(IR1269 5.1). When in doubt, start this plan.

### Contacts

| Role | Person | Backup | Reach them by |
|---|---|---|---|
| Incident lead: runs the response, makes the calls | [INCIDENT LEAD] | [INCIDENT LEAD BACKUP] | [PHONE] |
| Technical lead: contains and fixes | [TECH LEAD] | [TECH LEAD BACKUP] | [PHONE] |
| Privacy officer: Privacy Act assessment and notices (every agency must have one, Privacy Act 2020 s 201) | [PRIVACY OFFICER] | | [PHONE] |
| IRD liaison: tells IRD and keeps them updated | [IRD LIAISON] | | [PHONE] |
| Security lead: owns this document and the OSF answers | [SECURITY LEAD] | | [PHONE] |

### How to tell IRD

- IRD doesn't publish a dedicated security-incident address. IR1269 names our **relationship manager**
  and IRD's **External Relationships team** as our contacts, and registered providers get support through
  the **[Gateway Customer Support Portal](https://gws.ird.govt.nz/gws)** ([OSF page](https://www.ird.govt.nz/digital-service-providers/operational-security-framework)).
- So, in order: phone the relationship manager, [IRD RELATIONSHIP MANAGER, PHONE, EMAIL]; and log a case
  in the Gateway Customer Support Portal so there's a written, timestamped record. If the relationship
  manager can't be reached within 30 minutes, [IRD INCIDENT CONTACT, to be confirmed with IRD at
  onboarding].
- Ask the relationship manager for the exact incident route during onboarding, and fill it in here.
- Before we have gateway access (until M14), IR1269 doesn't bind us yet, but tell IRD anyway once we are
  registered or registering.

### How to tell the Privacy Commissioner

- A privacy breach is **notifiable** if it has caused, or is likely to cause, anyone serious harm
  ([Privacy Act 2020 ss 112–113](https://www.legislation.govt.nz/act/public/2020/0031/latest/LMS23342.html)).
  Weigh: how sensitive the information is (tax and bank data is), who has it or may get it, whether it's
  contained, and what we've done to reduce harm.
- Notify the Commissioner **as soon as practicable** (s 114) through
  [NotifyUs](https://www.privacy.org.nz/responsibilities/privacy-breaches/notify-us/). The Commissioner
  expects this **within 72 hours** of knowing it's notifiable, even while still investigating.
- Notify the affected people (or publicly, if that isn't practicable) as soon as practicable (s 115),
  unless an exception in s 116 applies. A delay must be justified and recorded.
- Failing to notify the Commissioner is an offence with a fine of up to $10,000 (s 118).
- A notifiable privacy breach involving taxpayer personal information also has to go to IRD
  (IR1269 5.1(a)), as above.

### The first hour

1. Whoever notices: tell [INCIDENT LEAD] by phone (backup: [INCIDENT LEAD BACKUP]). Don't fix anything
   quietly first.
2. Incident lead: open an incident record ([INCIDENT RECORD LOCATION]) with the time, who noticed, and
   what's known. Every later step is timestamped there.
3. Technical lead: contain it, without destroying evidence.
   - Revoke the affected sessions, or all sessions (delete from `sessions`).
   - Rotate any secret that might be exposed: AI key, gateway credentials, database key.
   - If the gateway account might be misused, suspend our IRD calls (turn off the integration in
     configuration) and say so to IRD.
   - If needed, put the service into maintenance mode.
   - Snapshot the database and logs before changing anything else.
4. IRD liaison: **tell IRD within the hour** (see "How to tell IRD") if taxpayer information, the gateway
   account or our gateway use is, or may be, affected. Say what's known and when the next update comes.

### The first day

1. Scope it from `command_log`, the access logs and the host's logs: which businesses, which people,
   what information, and since when.
2. Privacy officer: assess serious harm. If it's notifiable, or likely to be, notify the Commissioner
   through NotifyUs the same day where possible.
3. Technical lead: close the hole, or keep the service off until it's closed. Restore from backup if data
   was changed or lost; check the restored `command_log` against the last good one.
4. IRD liaison: update IRD with the scope and what was done, and agree how they want to be kept informed.
5. If the AI provider or host is involved, tell them and ask for their logs.

### The first week

1. Tell affected owners what happened, what information was involved, what we've done and what they
   should do (for example, watch for IRD-themed phishing). Use plain words; include a contact.
2. Keep IRD and the Commissioner updated until both say they're done.
3. Write a review: timeline, cause, what worked, what didn't, and the fixes, each with an owner and a
   date. Add the fixes to `PLAN.md` or `NON-CODE-TODOS.md`.
4. Update this document and, if a control changed materially, tell IRD (IR1269 5.2(b)).
5. Run the restore drill again if backups were used.

## Review

- Re-read and update this document before each yearly OSF review, after every incident, and whenever
  hosting, a subprocessor or what leaves the server changes.
- Last reviewed: 2026-10-24, [REVIEWER].
