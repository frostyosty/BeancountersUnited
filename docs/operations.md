# Operations

How to back up the database and prove a backup restores. 💾 M12 isn't done until a restore drill brings
staging back with an identical `command_log` (PLAN.md, M12).

## The tools

All the data is one SQLite file, `ACCT_DB` (`data/acct.db` locally, `/data/acct.db` on Fly).

- `acctd backup <path>` writes a consistent copy of `ACCT_DB` to `<path>` with SQLite's `VACUUM INTO`.
  - You can run it while the server is running. The copy is a snapshot of the last committed command;
    nothing half-written gets in.
  - It never overwrites anything. If `<path>` exists, it stops with an error and leaves the file alone.
  - It prints the path and the latest `command_log` seq in the copy.
- `acctd restore-check <path>` opens any database file read-only (a backup or the live one) and prints:

  ```text
  database:         backups/acct-2026-10-24.db
  integrity:        ok
  latest seq:       1234
  command_log rows: 1234
  command_log hash: 9f2c…
  ```

  The hash is SHA-256 over every `command_log` row in seq order (the encoding is in
  `crates/store/src/backup.rs`). Two databases with the same hash have the same command history, byte
  for byte. It fails if SQLite's integrity check finds a problem, and it never creates or changes a file.

Neither command touches the command pipeline: a backup copies data, it doesn't change it (hard rule 6).

Rows and seq are equal on a healthy database, because seqs start at 1 and have no gaps. If they differ,
stop and investigate.

## The restore drill, locally

Run it from the repo root. `acctd` is `cargo run -q -p acct-server --bin acctd --` if you haven't built
it.

1. Load something worth restoring: `make db-reset`, then `make dev` and make a few changes in the browser.
2. Back up while the server is still running:

   ```sh
   mkdir -p backups
   ACCT_DB=data/acct.db acctd backup backups/acct-drill.db
   ```

   `.gitignore` covers `*.db*`, so backups stay out of git. Keep it that way, even for synthetic data.
3. Stop the server (Ctrl+C in `make dev`), so the live database stops moving.
4. Check the live database and the backup:

   ```sh
   acctd restore-check data/acct.db
   acctd restore-check backups/acct-drill.db
   ```

   If you made changes after step 2, the live seq is higher; that's expected. To compare like with like,
   take another backup now (`acctd backup backups/acct-drill-2.db`) and use that from here on. Its
   latest seq, rows and hash must match the live database exactly.
5. Restore. Move the live database aside, with its `-wal` and `-shm` files, and put the backup in its
   place:

   ```sh
   mkdir -p backups/replaced
   mv data/acct.db data/acct.db-wal data/acct.db-shm backups/replaced/ 2>/dev/null
   cp backups/acct-drill-2.db data/acct.db
   ```

   Never copy a backup next to an old `-wal` file: SQLite would replay the old log onto the restored
   database.
6. Start the server (`make dev`) and check it serves: `curl -s localhost:8080/api/health`, log in, and open
   a client.
7. Stop it and run `acctd restore-check data/acct.db` once more. The seq, rows and hash must equal the
   backup's from step 4. Starting the server runs migrations, which never write to `command_log`, so the
   hash doesn't move.
8. Write down the date, the seq and the hash, and whether every step matched.

## On Fly

The set-up is ADR 008's.
- Each environment is one Fly app with one machine and one volume: `wla-staging` (`fly.staging.toml`)
  and `wla-prod` (`fly.toml`). Each app's name is written only in its own fly config. The commands below
  use `wla-staging`; for anything else, pass `-a <app>`.
- Litestream 0.5.17 streams every change to the database to that app's private Tigris bucket, at most
  10 s apart (`sync-interval: 10s`). It takes a full snapshot daily and keeps 7 days (168 h), so any
  moment in the last week can be restored. The config is `/etc/litestream.yml` (`litestream.yml` in the
  repo), and it reads `ACCT_DB`, `BUCKET_NAME`, `AWS_ENDPOINT_URL_S3`, `AWS_ACCESS_KEY_ID` and
  `AWS_SECRET_ACCESS_KEY`. `fly storage create -a <app> -n <app>-backup` set the last four as secrets.
- `scripts/fly-entrypoint.sh` runs `litestream restore -if-db-not-exists -if-replica-exists` and then
  `litestream replicate -exec acctd`. An empty volume is filled from the bucket on boot; a volume that
  already has a database is left alone. Both apps set `ACCT_REQUIRE_BACKUP=1`, so a machine without
  `BUCKET_NAME` refuses to start.
- **Never let two machines replicate to the same bucket path at once.** Litestream assumes exactly one
  process writes a replica, and two would interleave their files under `acct.db` and could corrupt it.
  That's why every procedure below stops the old machine before cloning it and destroys it straight
  after.
- Fly's daily volume snapshots are the second layer: kept 14 days on production and 5 on staging
  (`snapshot_retention` in `[mounts]`).
- Volumes and snapshots are encrypted by default, and Tigris encrypts stored objects. Never create a
  volume with `--no-encryption`, and never make a bucket public.

Run drills on **staging**. Its data is synthetic (hard rule 1). On production, restores happen only to
recover, and a person decides each one.

`fly ssh console` needs the machine running. Staging stops when idle, so open the site or run
`fly machine start -a wla-staging` first.

### Quick drill (no downtime)

This proves the bucket holds a restorable copy that matches the live database.

1. Wait until nobody has used staging for at least 10 s, so Litestream has pushed the last change.
2. Record the live state:

   ```sh
   fly ssh console -a wla-staging -C "acctd restore-check /data/acct.db"
   ```

3. Restore from the bucket to a scratch file on the machine and check it:

   ```sh
   fly ssh console -a wla-staging -C "litestream restore -o /tmp/drill.db /data/acct.db"
   fly ssh console -a wla-staging -C "acctd restore-check /tmp/drill.db"
   fly ssh console -a wla-staging -C "rm /tmp/drill.db"
   ```

   `/data/acct.db` here names the database in the config, not a file to read; `-o` is where the copy
   goes. The latest seq, rows and hash must equal step 2's. If the live seq is higher, someone used
   staging in between: wait 10 s and repeat both steps.
4. Record the date, the seq, the hash and the result.

### Full drill (M12's done check)

This brings staging back from the bucket onto a new, empty volume, the way we'd recover from a lost
host.

1. Wait 10 s after the last write and record the live state, as in the quick drill.
2. Find the machine and its volume, and snapshot the volume as a fallback:

   ```sh
   fly machine list -a wla-staging
   fly volumes list -a wla-staging
   fly volumes snapshots create <vol-id> -a wla-staging
   ```

3. Stop the old machine, so its Litestream pushes its last changes and stops writing to the bucket:

   ```sh
   fly machine stop <old-machine-id> -a wla-staging
   ```

4. Clone it. The clone gets a new, empty volume, and it restores from the bucket when it boots:

   ```sh
   fly machine clone <old-machine-id> -a wla-staging
   ```

5. Destroy the old machine straight away, so only one machine is left to serve requests and write to
   the bucket. Its volume isn't destroyed with it, so it's still the fallback:

   ```sh
   fly machine destroy <old-machine-id> -a wla-staging --force
   ```

6. On the new machine, run `fly ssh console -a wla-staging -C "acctd restore-check /data/acct.db"`.
   The latest seq, rows and hash must equal step 1's. Then check `https://wla-staging.fly.dev/api/health`,
   log in and open a client.
7. Only when step 6 matches, destroy the old volume: `fly volumes destroy <old-vol-id> -a wla-staging`.
   If it doesn't match, keep the old volume and the snapshot, and restore from them (see below).
8. Record the date, the seq, the hash and the result.

### Restoring to an earlier moment

Litestream can restore the database as it was at any moment in the last 7 days:

```sh
fly ssh console -a <app> -C "litestream restore -timestamp 2026-10-24T03:15:00Z -o /tmp/at.db /data/acct.db"
fly ssh console -a <app> -C "acctd restore-check /tmp/at.db"
```

Putting that copy into service loses every command after it, so it's a last resort for corruption, never
a way to undo a mistake. Mistakes are fixed with reversing journals. A person decides it. To do it, follow
the full drill, but before step 4, replace the volume's database with the restored copy.

### Restoring from a volume snapshot

Use this only if the bucket is unusable.

```sh
fly volumes snapshots list <vol-id> -a <app>
fly volumes create acct_data -r syd --snapshot-id <snapshot-id> -a <app>
fly machine stop <machine-id> -a <app>
fly machine clone <machine-id> -a <app> --attach-volume <new-vol-id>:/data
fly machine destroy <machine-id> -a <app> --force
```

As in the full drill, stop the old machine before cloning it and destroy it straight after.
- The entrypoint never overwrites an existing database from the bucket, so the machine starts from the
  snapshot as it is.
- Snapshots are daily, so up to a day of commands is lost.
- Once Litestream runs again, it replicates the snapshot's database to the bucket.

### A one-off copy with `acctd backup`

For a copy outside Fly, for example before a risky migration:

```sh
fly ssh console -a <app> -C "acctd backup /data/backup-2026-10-24.db"
fly ssh sftp get -a <app> /data/backup-2026-10-24.db ./backup-2026-10-24.db
fly ssh console -a <app> -C "rm /data/backup-2026-10-24.db"
acctd restore-check ./backup-2026-10-24.db
```

A production copy is real client data. Download it only to an encrypted office machine, never to a
Codespace or into this repo (hard rule 1).

## How often

- Run the restore drill on staging before M12 is called done, and then every quarter and after any change
  to the backup set-up.
- Keep the record of each drill (date, seq, hash, outcome). It's evidence for IRD's security review
  (`docs/security.md`).
