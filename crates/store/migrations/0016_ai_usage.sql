-- One row per AI ask (M22, ADR 016). Append-only (CLAUDE.md hard rule 7).
--
-- An ask is one user action that may reach a model: one suggestions run, or one explanation. Each
-- writes exactly one row, refused asks and runs answered without the model included. The row is
-- written directly after the call, as metering, not as a command: `ai_usage` isn't practice or
-- client data, so it isn't in `command_log`, the sync feed or Changes (hard rule 6 as amended).
--
-- Never stored: prompts, responses, bank descriptions, card wording, explanation text, names, IP
-- addresses or error messages (ADR 009's retention rule). Every column is an id, a time, a count, a
-- model id or a short enum.
--
-- - `at` is a UTC timestamp, when the row was written.
-- - `business_id` has no foreign key, so an expired trial's rows stay as counts.
-- - `user_id` is the real user (the overseer while viewing as someone); `acting_as` is the effective
--   user (M19). A guest is a real `users` row, so guests keep their id here.
-- - `model` is NULL when no call was made. `cost_micro_usd` is whole US micro-dollars, NULL when the
--   model's prices are unknown. `latency_ms` is the model calls' durations added up.
-- - The layer columns are for suggestion runs only: `lines_total` cards in the queue, `by_rules`,
--   `by_history` and `by_merchants` answered by layers 1 to 3, `lines_asked` sent to the model,
--   `by_model` pre-fills the run stored.
-- - M23 adds `invoice_read` to `kind` in its own migration, which rebuilds the check.
CREATE TABLE ai_usage (
    id                 TEXT    PRIMARY KEY,
    at                 TEXT    NOT NULL,
    kind               TEXT    NOT NULL CHECK (kind IN ('suggestion', 'explain')),
    business_id        TEXT    NOT NULL,
    user_id            TEXT,
    plan               TEXT    NOT NULL
                       CHECK (plan IN ('guest', 'free', 'owner', 'practice', 'practice_plus')),
    is_overseer        INTEGER NOT NULL CHECK (is_overseer IN (0, 1)),
    acting_as          TEXT,
    model              TEXT,
    model_calls        INTEGER NOT NULL DEFAULT 0,
    input_tokens       INTEGER NOT NULL DEFAULT 0,
    output_tokens      INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens INTEGER NOT NULL DEFAULT 0,
    cost_micro_usd     INTEGER,
    latency_ms         INTEGER,
    outcome            TEXT    NOT NULL
                       CHECK (outcome IN ('ok', 'declined', 'invalid', 'error',
                                          'refused_limit', 'refused_budget')),
    lines_total        INTEGER,
    by_rules           INTEGER,
    by_history         INTEGER,
    by_merchants       INTEGER,
    lines_asked        INTEGER,
    by_model           INTEGER
);

-- The limits count a business's asks of one kind today; the overseer view reads by user and by time.
CREATE INDEX ai_usage_business ON ai_usage (business_id, kind, at);
CREATE INDEX ai_usage_user ON ai_usage (user_id, at);
CREATE INDEX ai_usage_at ON ai_usage (at, kind);
