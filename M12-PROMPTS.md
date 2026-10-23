# M12 agent prompts

M12 splits into two waves. In wave 1, five agents can work at once because none of them touches the same files. Wave 2 builds on wave 1's sign-in changes, so it starts once that lands.

Each prompt says which files that agent owns. Shared files (`App.tsx`, `icons/registry.json`, `config.env.example`) are append-only: re-read just before editing, and add only your own lines.

**Migrations:** take the next free number in `crates/store/migrations/` when you start, and create the file straight away (even empty) so other agents see the number is taken.

## Wave 1: start all five now

### Agent 1: ADR 008, hosting and deploys (needs me)
```
Read CLAUDE.md, ADR 007, PLAN.md's M12 section and its "Hosting" open question, fly.toml, Dockerfile and .github/workflows/ci.yml.
You own docs/decisions/008-hosting.md, fly.toml, Dockerfile, a new .github/workflows/deploy.yml, any new config for continuous backup (e.g. litestream.yml), and the "Hosting" line in PLAN.md's Open questions. Don't edit anything else. Other agents are working in this repo at the same time; if you need a change outside your files, message them (ListAgents / SendMessage).
Task:
1. Write ADR 008. Hosting is decided as Fly.io in Sydney, so record that and cover:
   - one machine, one volume (SQLite, single writer), and why we're not scaling out
   - continuous database backup: compare Fly's volume snapshots with Litestream to object storage, and recommend one, with its restore point objective and monthly cost
   - encryption at rest: what Fly's volumes already give us, and whether we need anything more
   - staging and production as two Fly apps, their names, and how secrets are set
   - deploys: GitHub Actions deploys to staging on each push to master once `make check` passes, and production is a manual approval step
   - HTTPS: Fly terminates TLS, so say what the server must trust (forwarded headers) and what it mustn't
2. Implement it: deploy.yml, fly.toml (production) plus a staging config, and the Dockerfile changes the backup tool needs.
3. Never put secrets in the repo. List the secrets I have to set, and the `fly` commands to set them, in your final message.
Ask me before settling the backup tool and the app names. Don't commit; I commit with my quicksave.
```

### Agent 2: `acctd backup` and the restore drill
```
Read CLAUDE.md, PLAN.md's M12 section (Backups), crates/server/src/main.rs and crates/store/src/lib.rs.
You own:
- a new file crates/store/src/backup.rs (plus the single line `pub mod backup;` in crates/store/src/lib.rs)
- the subcommand arms in crates/server/src/main.rs
- a new crates/server/tests/backup.rs
- a new docs/operations.md
Don't edit anything else.
Task:
1. `acctd backup <path>` writes a consistent copy with `VACUUM INTO` while the server can still be running. It refuses to overwrite an existing file, and prints the path and the latest command_log seq.
2. `acctd restore-check <path>` opens a backup read-only and prints its latest seq, the row count of command_log, and a SHA-256 over command_log in seq order. The restore drill compares this with the live database.
3. tests/backup.rs: back up a database that has fixture data and a running writer, restore it, and assert command_log is identical (same rows, same hash). Also test that it refuses to overwrite.
4. docs/operations.md: the restore drill, step by step, for local and for Fly (Agent 1 is writing ADR 008 and the continuous backup; message them for the Fly specifics and leave a clearly marked placeholder if they aren't settled yet).
Don't commit. Before you finish, run cargo fmt, clippy -D warnings and the tests for acct-store and acct-server.
```

### Agent 3: business owners: sign-up, roles and access checks
```
Read CLAUDE.md (Roles, Hard rules 6), PLAN.md's M12 section, crates/server/src/auth.rs, crates/store/src/users.rs, crates/server/src/reads.rs, crates/server/src/pipeline.rs, crates/server/src/business.rs and crates/server/tests/auth.rs.
You own:
- crates/store/src/users.rs and a new migration (see the note on numbers at the top of M12-PROMPTS.md)
- the access checks in crates/server/src/pipeline.rs, reads.rs, business.rs, save_tax.rs, tax.rs and ai.rs (only the checks; don't restructure their logic)
- a new crates/server/src/signup.rs, its routes in crates/server/src/lib.rs, and the matching commands in commands.rs
- a new crates/server/tests/tenancy.rs
- apps/web/src/pages/SignUpPage.tsx (+ test), the sign-up and invite routes in App.tsx, and the invite form on BusinessPage.tsx
Don't edit auth.rs's login, sessions or cookies: Agent 6 changes those in wave 2.
Task:
1. First, ask me about role names. CLAUDE.md now lists `overseer` and `practice owner` (renamed from `master`), but the code still has Role::Master, and PLAN.md adds an `owner` role for business owners. "Owner" and "practice owner" are easy to confuse, so propose names for all five roles and wait for my answer before changing the public type.
2. Self sign-up for business owners: email, password (the existing rules), and the business's setup in one flow. Sign-up is a command through the pipeline like any other change (hard rule 6), and it creates the user, the business and a session.
3. A business owner sees and changes only their own business. They can invite their accountant by email (an invite token; sending email is out of scope for now, so show the link to copy). Accepting it gives that practice user access to the business.
4. One access function that every read and every command calls, so there's a single place to audit. No handler skips it.
5. tests/tenancy.rs: two owners sign up, and every GET route and every command kind is tried by the other owner and rejected. Build the list of routes and kinds from the router and the Command enum, so a new one that isn't covered fails the test.
Don't commit. Before you finish, run make check (vitest via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...`, because the local Node is too old) and regenerate the types.
```

### Agent 4: docs/security.md (doc only)
```
Read CLAUDE.md, ADR 007, ADR 009, PLAN.md's M12 section and IRD's published requirements for gateway service software providers (the OSF / security questionnaire). Research those requirements and cite the sources.
You own a new docs/security.md. Don't edit anything else, and don't write code.
Cover:
- each control IRD asks about, what we do for it, and where in the code or ADRs it lives. Leave "planned (M12, agent N)" where it's still being built: hosting and backups (Agent 1, 2), tenancy (Agent 3), two-factor sign-in, throttling, cookies and access logging (Agent 6).
- access logging: what we log (sign-ins, failed sign-ins, who read which business), how long we keep it, and who can see it
- a breach response plan: who does what in the first hour, the first day and the first week. IRD must be told immediately; find the exact contact route and cite it. Include the Privacy Act 2020 notifiable breach duty.
- what leaves the server (AI suggestions per ADR 009, IRD calls in M14), and what never does
Ask me who the named contacts are; leave placeholders until I answer. Don't commit.
```

### Agent 5: desktop apps after going online (needs me)
```
Read CLAUDE.md (Desktop apps), ADR 006, ADR 007, PLAN.md's M12 section, apps/desktop/**, .github/workflows/release.yml and the desktop targets in the Makefile.
You own apps/desktop/**, .github/workflows/release.yml, the desktop targets in the Makefile, a new ADR amendment note at the end of docs/decisions/006-desktop-apps.md, and CLAUDE.md's "Desktop apps" bullet. Don't edit anything else.
Task:
1. Retire acct-master: remove the app, its workspace member and its build in release.yml. acctd stays the server.
2. Recommend, then ask me, before doing either:
   - acct-client: point it at the hosted address by default (with a way to set a staging address), or retire it in favour of the browser
   - acct-dev: keep it as the local master with fixtures and a window per role, or retire it in favour of `make dev`
3. Make whatever I choose build: `make desktop-check` passes, and release.yml still builds the remaining exes.
Don't commit. Before you finish, run cargo fmt and make desktop-check if this machine can.
```

## Wave 2: once Agent 3 is in

### Agent 6: sign-in security: two-factor, throttling, cookies, access log
```
Read CLAUDE.md, PLAN.md's M12 section, docs/security.md (Agent 4's), ADR 008 (Agent 1's), crates/server/src/auth.rs, crates/store/src/sessions.rs, apps/web/src/pages/LoginPage.tsx and AccountPage.tsx.
You own crates/server/src/auth.rs, crates/store/src/sessions.rs, a new crates/store/src/access_log.rs, a new migration (see the note on numbers), crates/server/tests/auth.rs, LoginPage.tsx and AccountPage.tsx (+ tests), and the auth.* slots in icons/registry.json.
Task:
1. Cookies: `Secure` (except when ACCT_INSECURE_COOKIES is set for local HTTP dev), HttpOnly and SameSite=Lax. Behind Fly, trust the forwarded protocol header only as ADR 008 says.
2. Login throttling per account and per IP, with a plain message saying when to try again. Throttling state isn't practice data, like sessions.
3. Two-factor sign-in with an authenticator app (TOTP): set up on the account page with a QR code and one-time recovery codes, and asked for at login. Store the secret encrypted, with the key from an env var. Turning two-factor on or off is a command (it changes a user).
4. Access log: sign-ins, failed sign-ins, and which user read which business, kept as docs/security.md says.
5. Tests for each: the cookie flags, throttling kicking in and expiring (use an injected clock, not sleep), a wrong TOTP code rejected, a used recovery code rejected the second time.
When you add a dependency (e.g. for TOTP or QR codes), give the reason in your final message so it goes in the commit. Then update docs/security.md's "planned" markers for your controls (only those lines).
Don't commit. Before you finish, run make check (vitest via `npx -p node@22 -p pnpm@12.3.4 -- pnpm ...`) and regenerate the types.
```

## Done check (after wave 2)
Run by me, or by Agent 1 continued:
- staging is up over HTTPS
- two owners sign up on staging and neither can read the other's data
- the restore drill in docs/operations.md brings staging back, and `acctd restore-check` gives the same command_log hash as before

## Notes
- **Agents 1, 3, 4 and 5 will ask you things:** the backup tool and app names (1), role names (3), named contacts for the breach plan (4), and the futures of acct-client and acct-dev (5).
- **The order that matters:** Agent 6 needs Agent 3's role and access changes, and reads Agent 1's ADR and Agent 4's security doc. The done check needs everyone.
- **Not committed yet:** M11 is still uncommitted, so quicksave before starting wave 1. Each agent's work then shows up as its own diff.
- **Don't overlap with M15:** Agent 3 changes every command's access check in pipeline.rs. Don't run M15's finalise agent (which adds lock checks to every command) at the same time.
