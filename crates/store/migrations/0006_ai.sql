-- AI category suggestions (ADR 009). Append-only (CLAUDE.md hard rule 7).

-- Each business's consent and what redaction needs. Off by default: a business with no row, or
-- `enabled = 0`, sends nothing. `consent_version` is the wording-and-provider version the owner
-- agreed to; requests stop when the server's current version differs. `activity` is the owner's
-- short phrase for what the business does. `private_names` is a JSON array of names to strip from
-- descriptions (the owner's and any others on the account; the business's name is always
-- stripped).
CREATE TABLE ai_settings (
    client_id       TEXT    PRIMARY KEY REFERENCES clients (id),
    enabled         INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    consent_version TEXT,
    activity        TEXT,
    private_names   TEXT    NOT NULL,
    updated_seq     INTEGER NOT NULL
);

-- Suggestions waiting on the owner, and the ones they accepted. We store the coding, the model
-- and the confidence, never prompts or responses. A suggestion not accepted is deleted when its
-- line is sorted some other way, or when suggestions are turned off; an accepted one stays, and
-- `command_log.via` names it.
-- - `coding` is an `acct_core::coding::Coding` as JSON.
-- - `confidence` is `low`, `medium` or `high` (checked in Rust).
CREATE TABLE ai_suggestions (
    id           TEXT    PRIMARY KEY,
    client_id    TEXT    NOT NULL REFERENCES clients (id),
    bank_line_id TEXT    NOT NULL REFERENCES bank_lines (id),
    coding       TEXT    NOT NULL,
    model        TEXT    NOT NULL,
    confidence   TEXT    NOT NULL,
    created_seq  INTEGER NOT NULL,
    accepted_seq INTEGER
);
CREATE INDEX ai_suggestions_client ON ai_suggestions (client_id);
-- At most one suggestion per line waits on the owner.
CREATE UNIQUE INDEX ai_suggestions_live ON ai_suggestions (bank_line_id) WHERE accepted_seq IS NULL;

-- The practice's merchant list (ADR 009's layer 3), one per entity type: a description pattern
-- and the `acct_core::coding::Coding` it suggests, in the master chart's codes. Our own content,
-- from synthetic or consented data only. It's consulted when Save tax is shown, so a change
-- affects only suggestions, never coded lines. A removed entry keeps its row.
CREATE TABLE merchants (
    id                   TEXT    PRIMARY KEY,
    entity_type          TEXT    NOT NULL,
    description_contains TEXT    NOT NULL,
    coding               TEXT    NOT NULL,
    created_seq          INTEGER NOT NULL,
    removed_seq          INTEGER
);
CREATE INDEX merchants_entity_type ON merchants (entity_type);
