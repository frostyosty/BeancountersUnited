# acct

Practice accounts and financial statements for a small NZ accounting practice. It runs offline on the office
LAN: one server owns the data and staff use browsers.

- `CLAUDE.md`: the rules and architecture.
- `PLAN.md`: milestones.
- `docs/`: the domain glossary and architecture decisions.

```sh
make setup   # dependencies
make dev     # server on :8080, web on :5173
make check   # everything CI runs
```
