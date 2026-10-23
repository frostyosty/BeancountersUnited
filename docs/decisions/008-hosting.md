# 008: Hosting on Fly.io, backups and deploys

Status: proposed (2026-10-24).
- Fly.io in Sydney, and Litestream to a Tigris bucket for continuous backup, were chosen by the owner
  on 2026-10-24.
- The app names `wla-staging` and `wla-prod` are proposed.
Follows ADR 007 and answers PLAN.md's "Hosting" open question for M12.

## Context
ADR 007 makes acct a hosted service, so one server on the internet owns every business's data. M12
needs a host and region, a continuous backup with a known restore point, encryption at rest, staging
and production, and deploys from GitHub Actions. The server is a single Rust binary (`acctd`) with the
web app embedded. SQLite runs in WAL mode with one writer connection that serialises every command
(ADR 001, 004). IRD's Operational Security Framework will ask how each of these works, so this ADR is
also evidence for `docs/security.md`.

## Decision

### Host and region
- **Fly.io, region `syd` (Sydney).** It's the closest Fly region to New Zealand, with roughly 25–40 ms
  to Auckland. Customer data, meaning the volume, its snapshots and the backup bucket, stays in
  Australia.
- **One machine with one volume.** The SQLite file lives on a Fly volume mounted at `/data`, and the
  database is `/data/acct.db` (`ACCT_DB`).

### Why we don't scale out
- SQLite has one writer, and acctd's single writer connection is what keeps `seq` gapless and
  commands serialised. A second machine would need its own copy of the database, which is exactly the
  multi-master merge ADR 001 rules out.
- A Fly volume attaches to one machine, so a second machine couldn't share the file anyway.
- One shared-cpu machine is ample for the expected load. The next step up is a bigger machine
  (`fly scale vm` / `fly scale memory`), not more machines.
- So deploys always use `--ha=false`, and nobody runs `fly scale count` above 1. The cost is a short
  outage of seconds on each deploy, and a longer one if the host fails, until the machine is moved and
  restored from backup. That's acceptable for an accounting app at this stage. Read replicas
  (for example, LiteFS) can be reconsidered if load ever needs them, but only with a new ADR.

### Continuous backup: Litestream to Tigris
We compared two options:

| | Fly volume snapshots | Litestream to Tigris |
|---|---|---|
| How | Fly snapshots the whole volume once a day | Streams every WAL change to an S3-compatible bucket |
| Restore point objective (most work we can lose) | Up to 24 h | About 10 s (`sync-interval: 10s`) |
| Point in time | Only the daily snapshot | Any moment in the retention window (7 days) |
| Where the copy lives | Fly's snapshot storage, beside the volume | Tigris object storage, separate from the machine and volume |
| Monthly cost at our size | $0: $0.08/GB, with the first 10 GB free | About $0–2: storage $0.02/GB with 5 GB free; PUTs $0.005 per 1,000, with 10,000 free. At most 259,200 syncs a month at 10 s, and none while idle |
| Set-up | None (on by default) | Litestream in the image, a bucket and four secrets |

**Decision:** Litestream is the primary backup, and Fly's daily snapshots stay on as a second layer
(production keeps 14 days of snapshots, staging 5).
- A 24-hour restore point is too much to lose for an app where owners categorise and file returns. If we
  lost a filed return, our records would disagree with IRD's.
- The copy also lives somewhere other than the volume it protects.

How it works:
- The image contains Litestream 0.5.17 (from its official image, pinned), `/etc/litestream.yml`
  (`litestream.yml` in the repo) and `scripts/fly-entrypoint.sh`.
- On boot, the entrypoint runs `litestream restore -if-db-not-exists -if-replica-exists`. If the volume
  is empty, the database comes back from the bucket. A brand-new app with an empty bucket starts
  fresh.
- Then `litestream replicate -exec acctd` runs the server and streams changes to the bucket. Fly stops
  machines with `SIGINT`. Litestream passes it to acctd, which exits cleanly, and then pushes the last
  changes.
- Production and staging set `ACCT_REQUIRE_BACKUP=1`, so a machine without a bucket refuses to start
  rather than run without backups. A local `docker run` without a bucket runs acctd alone, with a
  warning.
- Each app has its own private bucket. Its credentials are scoped to that bucket.
- `acctd backup <path>` (`VACUUM INTO`) and `acctd restore-check <path>` stay as the one-off backup and
  the drill's comparison: latest `seq`, row count and SHA-256 of `command_log`. `docs/operations.md` holds
  the runbook.

Restore drill (staging only; the full steps are in `docs/operations.md`):
1. Record the live state:
   `fly ssh console -a wla-staging -C "acctd restore-check /data/acct.db"`.
2. Quick check, with no downtime:
   `fly ssh console -a wla-staging -C "litestream restore -o /tmp/drill.db /data/acct.db"`, then
   `acctd restore-check /tmp/drill.db` must match step 1.
3. Full drill (M12's done check):
   - Find the volume: `fly volumes list -a wla-staging`. Snapshot it first:
     `fly volumes snapshots create <vol-id> -a wla-staging`.
   - Stop the old machine first: `fly machine stop <machine-id> -a wla-staging`. Stopping pushes its
     last changes to the bucket.
   - Clone it onto a new, empty volume: `fly machine clone <machine-id> -a wla-staging`. Clone makes a
     fresh empty volume for a machine that has one.
   - Destroy the old machine straight away (`fly machine destroy <machine-id> --force`). Otherwise
     staging's auto-start could wake it while the clone runs. Its volume stays until the drill passes.
   - Never let two machines run Litestream against the same bucket path at once. Both would write to
     the one replica and could corrupt it.
   - The new machine boots, restores from the bucket, and `acctd restore-check` must again match step 1.
   - Then destroy the old volume.

Rolling back to an earlier moment is a manual restore with `-timestamp`, and a person decides it. It
loses every later command, so it's a last resort for corruption, not a way to undo mistakes. Mistakes are
corrected with reversing journals.

### Encryption at rest
- **Fly volumes are encrypted by default.** Fly manages the keys, and snapshots of encrypted volumes are
  encrypted too. We never create a volume with `--no-encryption`.
- **Tigris encrypts stored objects.** The bucket is private (no `--public`), and only that app's
  credentials can read it.
- Litestream 0.5 has no client-side encryption of its own (0.3's `age` option was removed). We accept the
  providers' encryption for now: the data never sits unencrypted on disk, and the keys stay with the two
  providers.
- If IRD's security review asks for keys we hold ourselves, the answer is an encrypted copy (for
  example, `acctd backup` piped through `age` to a third location), not an app-level change. That
  would be its own ADR.
- Login secrets are already hashed (Argon2 passwords, SHA-256 session tokens). Nothing else is encrypted
  at the application level.

### Staging and production
| | Staging | Production |
|---|---|---|
| Fly app | `wla-staging` | `wla-prod` |
| Config | `fly.staging.toml` | `fly.toml` |
| Address until a custom domain | `https://wla-staging.fly.dev` | `https://wla-prod.fly.dev` |
| Data | Synthetic only (hard rule 1) | Real customers |
| Idle | Stops, and wakes on the next request | Always on |
| Snapshot retention | 5 days | 14 days |

- **The name lives in one place per environment:** the `app =` line and `SITE_URL` in its fly config.
  The deploy workflow and the image read them from there, and nothing else hard-codes them. A Fly app
  can't be renamed, so renaming means creating the new app and bucket, setting its secrets, changing
  those two lines, and restoring into it from the old bucket. Customers should see a custom domain,
  not `*.fly.dev`, so the Fly app name is plumbing.
- The code name `acct` (crates, `acctd`, the volume name `acct_data`) is internal and stays.
- **Secrets** are set only with `fly secrets set -a <app>`, or by `fly storage create`, never in the
  repo, a fly config or the image.
  - Per app: `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`
    (all four from `fly storage create`), plus `AI_*` once M11 turns suggestions on.
  - Staging and production never share credentials or a bucket.
- Non-secret settings go in the fly config's `[env]`.

### Deploys
- `.github/workflows/deploy.yml` runs when the CI workflow completes on master.
  - **Staging** deploys only if CI succeeded on a push. "CI" is every job in `ci.yml`, including
    `make check`; a desktop-check failure also blocks the deploy.
  - It checks out exactly the commit CI tested, and the image is labelled with that commit.
- **Production** waits behind a manual approval. That's the required-reviewer rule on the GitHub
  `production` environment, so the job pauses until the owner approves it in the Actions tab. It
  deploys the same commit that just went to staging.
- Each environment has its own `FLY_API_TOKEN` secret: a deploy token for that one app
  (`fly tokens create deploy -a <app>`). A leaked staging token can't touch production.
- Builds run on Fly's remote builder (`--remote-only`). Deploys use the rolling strategy with
  `--ha=false`. The one machine is replaced, migrations run as acctd starts, and the HTTP health check
  on `/api/health` must pass.
- Deploys run one at a time (`concurrency: deploy`). A newer push queues behind a running deploy
  instead of cancelling it.
- Rollback is `fly deploy -a <app> --image <earlier image>` (see `fly releases -a <app> --image`).
  Migrations are append-only and forward-only, so roll back only to a release that understands the
  current schema. Otherwise, fix forward.

### HTTPS and what the server trusts
Fly's edge terminates TLS and forwards plain HTTP to the machine on port 8080, over Fly's private
network. `force_https` redirects every `http://` request at the edge, and the app exposes no other
port.

The server **may trust**, only when it's configured to run behind Fly (a setting M12's security work
adds, such as `ACCT_PROXY=fly` in `[env]`; never by default):
- `Fly-Client-IP` as the client's address, for login throttling and access logs. Fly's proxy sets it.
  M12 confirms on staging that a value sent by the client is replaced.
- The scheme is always HTTPS behind Fly. Cookies are `Secure` because the server is configured as
  hosted, not because a request says `X-Forwarded-Proto: https`.

The server **must not trust**:
- The left-hand entries of `X-Forwarded-For`, which the client can write. If it's ever used, only the
  entry Fly appended counts.
- `X-Forwarded-Host`, `X-Forwarded-Port` or the `Host` header, for building links, redirects or emails.
  It uses the configured public address instead.
- Any forwarded header at all when it isn't configured as behind Fly, such as in local dev or the
  desktop apps. Otherwise anyone could spoof their IP to dodge login throttling.

The server should also send `Strict-Transport-Security`, once a custom domain is settled. M12's
security work owns these server changes. This ADR only sets the rules.

### Expected monthly cost (USD)
- **Production, about $5–7.**
  - Shared-cpu-1x with 512 MB, always on: about $3.70 in Ashburn, and Sydney is somewhat higher. Check
    the price in the Fly dashboard.
  - 1 GB volume: $0.15.
  - Snapshots and Tigris are within their free allowances at our size.
- **Staging, about $1–2**, because it sleeps when idle.
- A dedicated IPv4 address ($2) isn't needed: the shared IPv4 and IPv6 are free.

## Consequences
- Each deploy is a few seconds of downtime. Users retry, and command ids make retries safe.
- If Sydney or the host fails, we can lose up to about 10 s of commands, and recovery is a manual
  restore onto a new machine. Owners who submitted in that window resubmit, which is idempotent by
  command id. An IRD filing made in that window is reconciled against IRD's records (M14).
- The restore drill runs before M12 is done, then every quarter (`docs/operations.md`).
- The existing test app `acct-test` retires once staging works. Its volume holds only test data.
- Moving off Fly later means moving the Litestream replica, which is plain S3, and the image, which is
  plain Docker. Nothing in the code depends on Fly except the headers above.
