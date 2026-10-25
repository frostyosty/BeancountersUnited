-- M15, accounting policies and notes. Append-only (CLAUDE.md hard rule 7).
--
-- The practice paragraph library: one per entity type, our own wording (hard rule 3). Each
-- paragraph has immutable numbered versions, like templates. Defaults never reach back: a new
-- version changes no client-year's copy until `push_paragraph` is run.
--
-- `removed_seq` is set by `remove_paragraph`. A removed paragraph leaves the library, but years
-- that picked it keep their copies, and its key is free to add again.
CREATE TABLE paragraphs (
    id          TEXT    PRIMARY KEY,
    entity_type TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    created_seq INTEGER NOT NULL,
    removed_seq INTEGER
);

CREATE UNIQUE INDEX paragraphs_live_key ON paragraphs (entity_type, key)
    WHERE removed_seq IS NULL;

CREATE TABLE paragraph_versions (
    id           TEXT    PRIMARY KEY,
    paragraph_id TEXT    NOT NULL REFERENCES paragraphs (id),
    version      INTEGER NOT NULL,
    -- `policy` (inside note 1) or `note` (a numbered note of its own).
    placement    TEXT    NOT NULL,
    title        TEXT    NOT NULL,
    body         TEXT    NOT NULL,
    created_seq  INTEGER NOT NULL,
    UNIQUE (paragraph_id, version)
);

-- A client-year's own copies of the paragraphs it picked, in `position` order. `from_version` is
-- the library version last copied in; `edited` is set once staff change the copy, and a push then
-- leaves it alone.
CREATE TABLE year_notes (
    id             TEXT    PRIMARY KEY,
    client_year_id TEXT    NOT NULL REFERENCES client_years (id),
    paragraph_id   TEXT    NOT NULL REFERENCES paragraphs (id),
    position       INTEGER NOT NULL,
    from_version   INTEGER NOT NULL,
    placement      TEXT    NOT NULL,
    title          TEXT    NOT NULL,
    body           TEXT    NOT NULL,
    edited         INTEGER NOT NULL DEFAULT 0,
    updated_seq    INTEGER NOT NULL,
    UNIQUE (client_year_id, paragraph_id)
);

CREATE INDEX year_notes_paragraph ON year_notes (paragraph_id);
