-- M12: business owners, who sees which business, and invites. Append-only (CLAUDE.md hard rule 7).

-- Roles are renamed: `master` is now `practice_admin`. New roles are `overseer` (us, running the
-- service: every business and every view) and `business_owner` (one signed-up business only).
-- This renames a stored enum value; it changes no one's permissions. Old `create_user` payloads in
-- `command_log` still say `master`, and `Role` reads that as `practice_admin`.
UPDATE users SET role = 'practice_admin' WHERE role = 'master';

-- Who may see a client besides the practice. `access` is checked in Rust:
-- - `owner`: the business owner who signed up with it. A client with an owner row is the owner's
--   business: practice users see it only with an `accountant` row of their own.
-- - `accountant`: a practice user who accepted the owner's invite.
-- A client with no owner row is a practice client, and every practice user sees it, as before M12.
CREATE TABLE client_access (
    client_id   TEXT    NOT NULL REFERENCES clients (id),
    user_id     TEXT    NOT NULL REFERENCES users (id),
    access      TEXT    NOT NULL,
    granted_seq INTEGER NOT NULL,
    PRIMARY KEY (client_id, user_id)
) WITHOUT ROWID;
CREATE INDEX client_access_user ON client_access (user_id);

-- An owner's invite to their accountant. Only a SHA-256 of the token is kept; the token itself is
-- in the link the owner copies, and is redacted from `command_log`. An invite is used once.
-- `email` is who the owner meant it for; sending it is out of scope for now. `expires_on` is a
-- date (the last day it can be accepted).
CREATE TABLE invites (
    id           TEXT    PRIMARY KEY,
    client_id    TEXT    NOT NULL REFERENCES clients (id),
    email        TEXT    NOT NULL,
    token_hash   TEXT    NOT NULL UNIQUE,
    created_by   TEXT    NOT NULL REFERENCES users (id),
    created_seq  INTEGER NOT NULL,
    expires_on   TEXT    NOT NULL,
    accepted_by  TEXT    REFERENCES users (id),
    accepted_seq INTEGER
);
CREATE INDEX invites_client ON invites (client_id);
