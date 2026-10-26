-- Whether a business owner lets their accountants see the owner's own edits in Changes. Off by
-- default: a business with no row shares nothing. Append-only (CLAUDE.md hard rule 7).
CREATE TABLE history_sharing (
    client_id          TEXT    PRIMARY KEY REFERENCES clients (id),
    share_owner_edits  INTEGER NOT NULL CHECK (share_owner_edits IN (0, 1)),
    updated_seq        INTEGER NOT NULL
);
