-- Businesses, bank accounts and uploaded statements (M10). Append-only (CLAUDE.md hard rule 7).
--
-- Every imported line posts straight away as its own journal (`docs/domain.md`, "Bank statements
-- to the ledger"), so these tables record where journals came from; the ledger stays in
-- `journals`.

-- The owner-facing settings of a client run as a business (sole traders in M10). The balance
-- date is always 31 March and the GST basis always payments in M10, so neither is stored.
-- `money_in_account` and `money_out_account` are its "not yet sorted" accounts.
CREATE TABLE businesses (
    client_id           TEXT    PRIMARY KEY REFERENCES clients (id),
    start_date          TEXT    NOT NULL,
    gst_registered_from TEXT,
    gst_frequency       TEXT,
    money_in_account    TEXT    NOT NULL,
    money_out_account   TEXT    NOT NULL,
    gst_account         TEXT    NOT NULL,
    capital_account     TEXT    NOT NULL,
    created_seq         INTEGER NOT NULL,
    CHECK ((gst_registered_from IS NULL) = (gst_frequency IS NULL))
);

-- A business's bank accounts, each an asset account in its chart (600.01, 600.02, ...).
-- `account_number` is normalised (`BB-bbbb-AAAAAAA-SS`) so statements match it. `opening_*` is
-- the balance on `opening_date`, set once, from the first statement or by the owner.
CREATE TABLE bank_accounts (
    id                 TEXT    PRIMARY KEY,
    client_id          TEXT    NOT NULL REFERENCES clients (id),
    account_code       TEXT    NOT NULL,
    name               TEXT    NOT NULL,
    account_number     TEXT,
    opening_date       TEXT,
    opening_balance    INTEGER,
    opening_journal_id TEXT    REFERENCES journals (id),
    created_seq        INTEGER NOT NULL,
    UNIQUE (client_id, account_code),
    UNIQUE (client_id, account_number),
    CHECK ((opening_date IS NULL) = (opening_balance IS NULL))
);

-- Each uploaded statement file. The file itself is kept in the command's log entry.
-- `opening_balance` and `closing_balance` are as stated or worked out from the lines.
CREATE TABLE statements (
    id              TEXT    PRIMARY KEY,
    bank_account_id TEXT    NOT NULL REFERENCES bank_accounts (id),
    parser          TEXT    NOT NULL,
    file_name       TEXT    NOT NULL,
    start_date      TEXT    NOT NULL,
    end_date        TEXT    NOT NULL CHECK (end_date >= start_date),
    opening_balance INTEGER,
    closing_balance INTEGER,
    lines_in_file   INTEGER NOT NULL,
    lines_added     INTEGER NOT NULL,
    imported_seq    INTEGER NOT NULL
);
CREATE INDEX statements_account ON statements (bank_account_id, start_date);

-- Each imported line and the journal it posted. The unique key is duplicate detection: a line
-- already imported from an overlapping statement matches and is skipped, while two identical
-- purchases on one day differ by `occurrence`. `possible_duplicate` marks a new line on a day an
-- earlier statement already covered, for the owner to check.
CREATE TABLE bank_lines (
    id                 TEXT    PRIMARY KEY,
    bank_account_id    TEXT    NOT NULL REFERENCES bank_accounts (id),
    statement_id       TEXT    NOT NULL REFERENCES statements (id),
    date               TEXT    NOT NULL,
    amount             INTEGER NOT NULL,
    description        TEXT    NOT NULL,
    occurrence         INTEGER NOT NULL CHECK (occurrence >= 0),
    bank_id            TEXT,
    balance            INTEGER,
    journal_id         TEXT    NOT NULL REFERENCES journals (id),
    possible_duplicate INTEGER NOT NULL CHECK (possible_duplicate IN (0, 1)),
    UNIQUE (bank_account_id, date, amount, description, occurrence)
);

-- Gap journals: each posts the change in a bank account's balance across days no statement
-- covers. They're system journals, reversed and reposted whenever the account's gaps change.
CREATE TABLE gap_journals (
    journal_id      TEXT    PRIMARY KEY REFERENCES journals (id),
    bank_account_id TEXT    NOT NULL REFERENCES bank_accounts (id),
    start_date      TEXT    NOT NULL,
    end_date        TEXT    NOT NULL
);
CREATE INDEX gap_journals_account ON gap_journals (bank_account_id);
