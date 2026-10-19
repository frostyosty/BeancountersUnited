# White Label Accounting

Online accounting for NZ small businesses and their accountants: upload bank statements, see the tax to
pay, categorise transactions to bring it down, and file GST and income tax returns with IRD. The code
name is `acct`.

The online version is being built (`PLAN.md`, from M10). For now the server runs locally, or on an office
network through the desktop apps below.

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

## Desktop apps

Each push to `master` builds three Windows programs and publishes them as the `master-build`
pre-release on GitHub. A `v*` tag publishes a numbered release. See `docs/decisions/006-desktop-apps.md`.
`acct-master` retires once the hosted version is live (ADR 007).

- `acct-master.exe`: run on the office server PC. The first run sets up the practice and its
  master user; after that, it shows the address staff connect to.
- `acct-client.exe`: run on staff PCs. Type in the master's address, then sign in with the
  account the master user created for you.
- `acct-dev.exe`: for development. A throwaway master loaded with the synthetic fixtures, a window
  signed in as each role, and a simulator that checks several clients stay in sync.
