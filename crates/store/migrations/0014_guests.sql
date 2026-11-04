-- Guests: trying it on the home page with no sign-up (M20, ADR 014). Append-only (CLAUDE.md hard
-- rule 7).

-- A guest is a business owner with no credentials yet: `guest_since` set and `claimed_at` empty.
-- Claiming sets `claimed_at` (and the username, name and password) on the same row, so every line,
-- answer and log entry stays where it is. `guest_since` stays as a record they started as a guest.
-- Both are UTC timestamps.
ALTER TABLE users ADD COLUMN guest_since TEXT;
ALTER TABLE users ADD COLUMN claimed_at TEXT;

-- Which example a business was made from (1 to 3), for an example a guest opened. NULL for every
-- other business. An example takes no uploads of the visitor's own, can't be claimed and lasts
-- 24 hours.
ALTER TABLE businesses ADD COLUMN example INTEGER CHECK (example IN (1, 2, 3));

-- Where the business's GST registration came from (ADR 014, 3):
-- - `detected`: a GST payment to IRD or a GST refund from IRD in its statements; `gst_evidence` is
--   that bank line.
-- - `assumed`: nothing proved it either way, so it's treated as registered, the higher figure.
-- - `owner`: the owner said so.
-- - `ird`: IRD's filing obligations said so (M14).
-- NULL for businesses set up before M20, which were given their registration at setup: `owner`.
-- `gst_evidence` has no foreign key: removing the statement that held it is allowed, and detection
-- runs again over what's left (`crates/server/src/guests.rs`).
ALTER TABLE businesses ADD COLUMN gst_source TEXT
    CHECK (gst_source IN ('detected', 'assumed', 'owner', 'ird'));
ALTER TABLE businesses ADD COLUMN gst_evidence TEXT;

-- `command_log` is append-only, with one documented exception: when an unclaimed guest's business
-- is deleted (`expire_guest`, or replaced by `add_guest_business` or `claim_guest`), the rows about
-- it are redacted in place. `payload` becomes `{"redacted":"guest"}`, `result` keeps only `seq` and
-- `entity_id`, `changes` becomes NULL, and `redacted_seq` is the `seq` of the command that did it.
-- `seq`, `id`, `kind`, `user_id`, `client_id`, `client_year_id` and `at` stay, so `seq` stays
-- gapless and the log still shows that something happened, and when.
ALTER TABLE command_log ADD COLUMN redacted_seq INTEGER;

-- The sweep and the limits look guests up by these.
CREATE INDEX users_guest ON users (guest_since) WHERE guest_since IS NOT NULL;
CREATE INDEX businesses_example ON businesses (example) WHERE example IS NOT NULL;
