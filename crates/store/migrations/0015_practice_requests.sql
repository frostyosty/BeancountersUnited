-- The whole taste first, then sign up at the peak (M21, ADR 015). Append-only (CLAUDE.md hard
-- rule 7).

-- A request for a practice account (`request_practice_account`): an accountant or bookkeeper who
-- tried it asks us to set their practice up. Only overseers read these. The personal details live
-- here alone: the command's log entry keeps `[redacted]` in their place, so deleting the row
-- (`delete_practice_request`, after 90 days or sooner on request) deletes them.
-- `came_from` is the request's `from` (`from` is an SQL keyword). `created_at` is UTC.
CREATE TABLE practice_requests (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL,
    practice_name TEXT NOT NULL,
    clients       TEXT NOT NULL
        CHECK (clients IN ('up_to_10', '11_to_50', '51_to_200', 'over_200')),
    phone         TEXT,
    came_from     TEXT
        CHECK (came_from IN ('who_are_you', 'accountants_page', 'signup_page')),
    created_seq   INTEGER NOT NULL,
    created_at    TEXT NOT NULL
);
CREATE INDEX practice_requests_created ON practice_requests (created_at);

-- The overseer's trial counts read `command_log` by kind over the last 12 weeks. 0013 already has
-- `command_log_kind` on (kind, seq), so this one is named for its columns.
CREATE INDEX command_log_kind_at ON command_log (kind, at);
