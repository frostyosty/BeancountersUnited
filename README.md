# White Label Accounting

Online accounting for NZ small businesses and their accountants: upload bank statements, see the tax to
pay, categorise transactions to bring it down, and file GST and income tax returns with IRD. The code
name is `acct`.

The online version is being built (`PLAN.md`, from M10). The server is `acctd`, and everyone uses acct in a
browser. For now it runs locally.

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

Each push to `master` builds one Windows program, `acct-dev.exe`, and publishes it as the
`master-build` pre-release on GitHub. A `v*` tag publishes a numbered release.

`acct-dev.exe` is for development and for trying a build on Windows without a Rust or pnpm toolchain. It
runs a throwaway server loaded with the synthetic fixtures, opens a window signed in as each role, and has
a simulator that checks several clients stay in sync. Everything is deleted when you close it.

`acct-master` and `acct-client` were retired in M12: `acctd` is the server, and everyone else uses a
browser. See the amendment at the end of `docs/decisions/006-desktop-apps.md`.
