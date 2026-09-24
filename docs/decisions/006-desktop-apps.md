# 006: Three Tauri desktop apps, built for Windows by GitHub Actions

Status: accepted (2026-09-24). Brings forward part of M7. Amends ADR 005: the web app is still the
only UI for accounting work, and these apps show it in a webview.

## Context
The practice wants to install programs rather than point browsers at an address. It also wants a
development build that runs a master and several clients in one program, to see the whole
system working. Codespaces can't run Windows, but GitHub Actions has Windows runners.

## Decision
- Three apps, each a Tauri 2 binary in `apps/desktop/`, sharing the `acct-desktop` library:
  - `acct-master`: runs the acct server in-process (the same `acct_server::serve` that `acctd`
    uses), on `0.0.0.0:8080` by default, with its database in the app's local data folder. Its control
    window sets up a new practice (the `initialise` command, as `acctd init` does) and shows the
    address staff connect to. Closing the control window stops the server. `acctd` stays as the
    headless server.
  - `acct-client`: for staff and viewer PCs. It asks for the master's address (remembering it),
    checks `/api/health` for the same version, then shows the master's web app. The app is the
    same whatever the role: what a person may do comes only from the account the master set up for
    them, enforced by the server.
  - `acct-dev`: for development only. A throwaway master on a temporary database loaded with the
    synthetic fixtures (`acct_server::fixtures`, through the command pipeline), plus a window per
    dev user (each in its own webview profile, so their logins are separate), acct-client's
    connect screen, and the sync simulator from the PLAN.md backlog.
- The server builds the web app in with the `embed-web` feature (`rust-embed`). The desktop
  apps turn it on; `acctd` and `make check` don't, so neither needs a web build.
- The apps' own screens are small static pages in `apps/desktop/ui` (plain HTML and JS, no
  build step). Only these local pages may call the apps' Tauri commands. Tauri gives remote
  pages, the master's web app included, no IPC.
- The desktop crates are workspace members but not `default-members`, so `cargo test`,
  `cargo clippy` and `make check` skip them. `make desktop-check` covers them; on Linux it needs
  WebKitGTK (`scripts/desktop-deps.sh`).
- `.github/workflows/release.yml` builds the three `.exe` files on `windows-latest`. Each push to
  master replaces a rolling `master-build` pre-release, and a `v*` tag publishes a release.
- The exes are standalone (no installer) and unsigned.

## Consequences
- Staff PCs need WebView2, which Windows 10 and 11 include. Windows updates that runtime itself;
  the apps make no network calls of their own beyond the master on the LAN.
- A client and its master must be the same version, so upgrade them together.
- Traffic is still plain HTTP on the office LAN until M7's TLS work. M7 still decides the server
  host (a Windows PC running `acct-master` is now one option) and TLS.
- Windows SmartScreen warns before the first run of an unsigned exe. Code signing is future work.
- The master only serves while `acct-master` is open and someone is logged in to that PC. A
  Windows service is still an M7 option.
