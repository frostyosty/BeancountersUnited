# 001: The LAN server has authority over the data

Status: accepted

## Context
The practice's data must stay in the office, and nothing may talk to the internet at runtime. Several staff
work on the same clients at once over the office network. Financial statements that have been signed must
be reproducible exactly.

## Decision
- One office server (`acctd`) owns the database. Every other machine is a client, and until M7 a client is
  a browser.
- There is no multi-master merge and no peer-to-peer replication. A client never holds data the server
  doesn't have.
- Every change to practice or client data is a command sent to `POST /api/commands` as `{ id, kind, payload }`.
  The server decodes, authorises, validates, applies, appends to `command_log` and commits, all in one
  transaction. There's no other write path.
- The command `id` is a client-generated v4 UUID and serves as the idempotency key. Resubmitting an `id`
  returns the original result.
- Accepted commands get an increasing `seq`. `GET /api/sync?after=<seq>` is the change feed that clients
  use for live refresh.
- Entity ids are server-generated UUIDv7.

## Consequences
- Conflicts are resolved by ordering: the writer connection serialises commands, and each one is
  validated against the state its predecessors left.
- The server recomputes everything the UI sends, so a buggy or stale client can't corrupt the ledger.
- Working away from the office needs its own design (M9) and isn't possible by default.
- `command_log` doubles as an audit trail.
