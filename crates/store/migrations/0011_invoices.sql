-- The invoice maker (Settings › Tools): each user's own invoices, kept with their account. These
-- belong to the user, not to any business, and aren't part of anyone's books. Append-only (CLAUDE.md
-- hard rule 7).

-- The invoice a user is working on: one per user, saved as they edit. `html` is the editor's page.
CREATE TABLE invoice_drafts (
    user_id      TEXT    PRIMARY KEY REFERENCES users (id),
    html         TEXT    NOT NULL,
    updated_seq  INTEGER NOT NULL
);

-- Named layouts a user saved to start invoices from. Saving under an existing name replaces it.
CREATE TABLE invoice_templates (
    id           TEXT    PRIMARY KEY,
    user_id      TEXT    NOT NULL REFERENCES users (id),
    name         TEXT    NOT NULL,
    html         TEXT    NOT NULL,
    created_seq  INTEGER NOT NULL,
    updated_seq  INTEGER NOT NULL,
    UNIQUE (user_id, name)
);

-- Images (logos, signatures) placed on a user's invoices, which refer to them by id. Stored once
-- per user per content: uploading the same image again returns the same id.
CREATE TABLE invoice_images (
    id            TEXT    PRIMARY KEY,
    user_id       TEXT    NOT NULL REFERENCES users (id),
    content_type  TEXT    NOT NULL,
    sha256        TEXT    NOT NULL,
    data          BLOB    NOT NULL,
    created_seq   INTEGER NOT NULL,
    UNIQUE (user_id, sha256)
);
