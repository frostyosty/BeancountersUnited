# 005: The client is a web app first

Status: accepted

## Context
Staff use Windows PCs on the office network. Development happens in Codespaces, which can't build or run a
Windows desktop shell. How clients will trust the server (a practice certificate authority or a desktop
shell) is decided in M7.

## Decision
- The UI is a React and TypeScript single-page app built with Vite. It uses TanStack Query for server
  state, React Router for navigation, and CSS modules. There's no UI kit in v1.
- The server serves the built app. In development, Vite runs on :5173 and proxies `/api` to the server on
  :8080.
- The UI bundles everything it uses: no CDN scripts, web fonts or telemetry.
- Shared types are generated from Rust with ts-rs into `packages/types`, which is never edited by hand.
  `make check` fails if the generated files are out of date.
- Command ids come from `newId()` in `apps/web/src/lib/id.ts`, built on `crypto.getRandomValues`, because
  `crypto.randomUUID` only exists in secure contexts and the office LAN is plain HTTP until M7.

## Consequences
- Any machine on the LAN with a browser can be a client, with nothing to install.
- Until M7, traffic on the LAN isn't encrypted. That's acceptable only because the network is the office's own.
- A desktop shell stays an option for M7, reusing the same web app.
