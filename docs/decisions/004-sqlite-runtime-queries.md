# 004: SQLite owned by the server, with runtime-checked queries

Status: accepted

## Context
The practice is small, the server is a single office machine, and nobody should have to run a separate
database server. Builds and CI must not need a live database.

## Decision
- SQLite, accessed through sqlx, in WAL mode.
- One writer connection serialises all commands. A pool of read connections serves queries.
- Queries use sqlx's runtime API (`query_as` with `FromRow`), not the compile-time `query!` macros, so
  building needs no database and no offline query cache.
- Migrations live in `crates/store/migrations` and are append-only. A Claude Code hook blocks edits to any
  migration already committed to git.
- Integration tests run the SQL against a real SQLite database.

## Consequences
- Type mismatches between SQL and Rust surface in tests rather than at compile time, so every query needs
  test coverage.
- Backups are a single-file copy (`VACUUM INTO`, M7).
- Write throughput is bounded by one connection. That's plenty for a small practice, and it makes command
  ordering trivial.
