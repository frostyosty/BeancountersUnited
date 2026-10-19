# 007: An online service that files with IRD

Status: accepted (2026-10-19). Removes hard rule 2. Amends 001 (the server is hosted, not on the office
LAN), 005 (no LAN) and 006 (`acct-master` retires).

## Context
The product changes from a LAN-only tool for one accounting practice into White Label Accounting: online
accounting for NZ small businesses and their accountants. An owner uploads bank statements, sees the tax
they'd pay if they filed now, categorises transactions to bring it down, and files GST and income tax
returns with IRD (PLAN.md, "Direction").

Filing goes through IRD's gateway services, so the server has to reach IRD over the internet. Owners and
accountants work from anywhere, which also answers PLAN.md's old question about editing away from the
office. IRD vets every software provider before granting access: a business alignment review, tax
compliance and integrity checks on the organisation and its key people, and the Operational Security
Framework, an ISO 27001-aligned security review repeated every year. Its terms require customer
information to be protected to at least ISO 27001 or NZ Information Security Manual practice, and IRD
can ask for evidence of each customer's consent.

## Decision
- Hard rule 2 (no network access at runtime) is removed. Its number stays unused, so references to rules
  3–7 in code comments and committed migrations stay correct.
- One server still owns the data, now hosted rather than in an office. ADR 001's model is unchanged: the
  command pipeline, idempotent command ids, `seq` and the sync feed. Everyone uses a browser over HTTPS.
- The server may call outside services: IRD's gateway services (M14) and an AI provider for category
  suggestions (M11, which gets its own ADR first).
  - Each integration lives in its own crate behind a trait, so tests run without a network.
  - `crates/core` stays pure (hard rule 5). It computes every tax figure and builds every return payload.
    Outside services never compute amounts.
  - Whatever comes back (IRD responses, AI suggestions) is input to a command, validated like anything
    from the UI and recorded in `command_log`.
- IRD connectivity, GST returns, and the tax calculations behind the returns we file move into scope.
- The host, region, backups and deploys are decided in ADR 008 (M12).

## Consequences
- Security becomes part of the product: HTTPS, `Secure` cookies, login throttling, two-factor sign-in,
  encryption at rest, backups and a breach plan (M12), plus the yearly security review.
- Customer data leaves our server only for IRD and, if M11's ADR allows it, the AI provider.
- The LAN-only parts of the old M7 (a practice certificate authority, device trust, mDNS) and the old M9
  (off-network editing) are dropped.
- `acct-master`, a server on an office PC, doesn't fit a hosted service and retires in M12. M12 also
  decides whether `acct-client` points at the hosted address and whether `acct-dev` stays.
- Nothing forces the UI to change: it already bundles its own scripts and uses system fonts.
- `newId()` stays as it is: it works everywhere, and switching to `crypto.randomUUID` gains nothing.
