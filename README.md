# acct

Practice accounts and financial statements for a small NZ accounting practice. It runs offline on the office
LAN: one server owns the data and staff use browsers.

- `CLAUDE.md`: the rules and architecture.
- `PLAN.md`: milestones.
- `docs/`: the domain glossary and architecture decisions.

```sh
make setup   # dependencies
cargo run -p acct-server --bin acctd -- init   # once: name the practice and create the first master user
make dev     # server on :8080, web on :5173
make check   # everything CI runs
```

The server keeps its database at `data/acct.db` (set `ACCT_DB` to move it) and listens on
`127.0.0.1:8080` (set `ACCT_BIND` to change it).
