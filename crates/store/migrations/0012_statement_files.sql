-- The evidence behind each upload (M18). Append-only (CLAUDE.md hard rule 7).
--
-- Each uploaded statement's original file, so the owner can be shown the bank's own words beside
-- the books. It's written by `import_statement`, inside its transaction, so it's part of the
-- command (hard rule 6). From here on the command's log entry keeps only the file's SHA-256, not
-- its bytes. Statements uploaded before this migration have no row: their file isn't kept.
--
-- The same file uploaded again to the same bank account (same `sha256`) isn't stored twice: if
-- that upload still makes a statement, its row has no `bytes` and `same_as` names the statement
-- whose row holds them. Its own balance spans are written as usual, since they index the same text.
-- A card statement's full card number, if it has one, is masked to the last four digits in the
-- copy kept, and `sha256` is of that copy.
CREATE TABLE statement_files (
    statement_id TEXT PRIMARY KEY REFERENCES statements (id),
    sha256       TEXT NOT NULL,
    media_type   TEXT NOT NULL,
    bytes        BLOB,
    same_as      TEXT REFERENCES statements (id),
    CHECK ((bytes IS NULL) = (same_as IS NOT NULL))
);
CREATE INDEX statement_files_sha256 ON statement_files (sha256);

-- Where in its file each stated balance was read: the statement's opening or closing balance, or
-- a line's running balance (`bank_line_id`). `span_line` is the file's 1-based line, and
-- `span_start`..`span_end` the byte range within it, of the text as the parser decoded it.
CREATE TABLE balance_spans (
    statement_id TEXT    NOT NULL REFERENCES statements (id),
    kind         TEXT    NOT NULL CHECK (kind IN ('opening', 'closing', 'running')),
    bank_line_id TEXT    REFERENCES bank_lines (id),
    span_line    INTEGER NOT NULL CHECK (span_line >= 1),
    span_start   INTEGER NOT NULL CHECK (span_start >= 0),
    span_end     INTEGER NOT NULL CHECK (span_end >= span_start),
    CHECK ((kind = 'running') = (bank_line_id IS NOT NULL))
);
CREATE UNIQUE INDEX balance_spans_one_each
    ON balance_spans (statement_id, kind, COALESCE(bank_line_id, ''));
