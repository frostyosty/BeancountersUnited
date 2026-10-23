-- Save tax (M11): coding settings, rules, how each bank line is sorted, the owner's answers, and
-- credit cards. Append-only (CLAUDE.md hard rule 7).
--
-- The ledger stays in `journals`. These tables record why each bank line's live journal says what
-- it says, so a recode knows what to reverse.

-- Credit cards share `bank_accounts`: `kind` is `bank` or `credit_card` (checked in Rust). A card's
-- account is a liability (850.01, 850.02, ...) and `account_number` is its masked number,
-- `XXXX-XXXX-XXXX-1234`.
ALTER TABLE bank_accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'bank';

-- ADR 009's attribution: how a command came about, such as accepting an AI suggestion. A JSON
-- object, NULL for a command the user made alone.
ALTER TABLE command_log ADD COLUMN via TEXT;

-- Each business's `acct_core::coding::CodingSettings`, as JSON. Set at `set_up_business` from the
-- practice defaults, changed by `set_coding_settings`; a change applies only to lines coded after it.
CREATE TABLE coding_settings (
    client_id   TEXT    PRIMARY KEY REFERENCES clients (id),
    settings    TEXT    NOT NULL,
    updated_seq INTEGER NOT NULL
);

-- Businesses set up before this migration get the practice defaults
-- (fixtures/practice/sole-trader-coding-settings.json), pinned as of their setup.
INSERT INTO coding_settings (client_id, settings, updated_seq)
SELECT client_id,
       '{"gst":"810","unclaimed_gst":"615","gst_refund":"812","capital":"950","paye_wages":"952","personal_sale":"954","drawings":"960","income_tax":"962","loans":"900","part_private_gst":"business_share"}',
       created_seq
FROM businesses;

-- Per-business rules, in `acct_core::coding::Rule`'s shape. `coding` is JSON. A removed rule keeps
-- its row, so lines it coded can still name it.
CREATE TABLE coding_rules (
    id                   TEXT    PRIMARY KEY,
    client_id            TEXT    NOT NULL REFERENCES clients (id),
    description_contains TEXT    NOT NULL,
    min_amount           INTEGER,
    max_amount           INTEGER,
    coding               TEXT    NOT NULL,
    created_seq          INTEGER NOT NULL,
    removed_seq          INTEGER
);
CREATE INDEX coding_rules_client ON coding_rules (client_id);

-- How each bank line is sorted now. A line with no row is as imported: unsorted, its live journal
-- `bank_lines.journal_id`.
-- - `state` is `unsorted`, `coded` or `duplicate` (checked in Rust).
-- - `coding` is the line's `acct_core::coding::Coding` as JSON, when coded.
-- - `journal_id` is the line's live journal, NULL when it posts nothing (a duplicate). The two
--   lines of a confirmed transfer share one journal and name each other in `pair_line_id`.
-- - `rule_id` names the rule that coded it; `ird_income_year` the income year an income tax
--   payment was for; `asset_id` the register entry an asset purchase made.
CREATE TABLE bank_line_states (
    bank_line_id    TEXT    PRIMARY KEY REFERENCES bank_lines (id),
    state           TEXT    NOT NULL,
    coding          TEXT,
    journal_id      TEXT    REFERENCES journals (id),
    rule_id         TEXT    REFERENCES coding_rules (id),
    pair_line_id    TEXT    REFERENCES bank_lines (id),
    ird_income_year INTEGER,
    asset_id        TEXT,
    updated_seq     INTEGER NOT NULL
);

-- The date the owner confirmed they hold the supplier's taxable supply information for a line.
CREATE TABLE supply_info_confirmations (
    bank_line_id  TEXT    PRIMARY KEY REFERENCES bank_lines (id),
    confirmed_on  TEXT    NOT NULL,
    confirmed_seq INTEGER NOT NULL
);

-- The owner's answer to "is this a duplicate?" for a line flagged as a possible duplicate.
CREATE TABLE duplicate_answers (
    bank_line_id TEXT    PRIMARY KEY REFERENCES bank_lines (id),
    is_duplicate INTEGER NOT NULL CHECK (is_duplicate IN (0, 1)),
    answered_seq INTEGER NOT NULL
);

-- The owner's answers for an income year: `acct_core::tax::income_tax::YearAnswers` as JSON, less
-- `tax_paid`, which comes from confirmed income tax payments.
CREATE TABLE tax_answers (
    client_id   TEXT    NOT NULL REFERENCES clients (id),
    income_year INTEGER NOT NULL,
    answers     TEXT    NOT NULL,
    updated_seq INTEGER NOT NULL,
    PRIMARY KEY (client_id, income_year)
);
