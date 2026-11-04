-- Viewing as someone else (M19, ADR 013). Append-only (CLAUDE.md hard rule 7).
--
-- Acting as someone is a state of one login session. These columns are login state, like the rest
-- of `sessions`; the commands that change them (`start_impersonation`, `allow_impersonation_changes`,
-- `end_impersonation`) are logged like any other (hard rule 6).
-- - `acting_as`: who this session is acting as. NULL when it isn't.
-- - `acting_id`: the acting session's id, the `entity_id` of its `start_impersonation`, so the
--   end can name the start it closes.
-- - `acting_since`: when it started. It lasts 30 minutes from then.
-- - `allow_changes`: whether `allow_impersonation_changes` has turned writes on.
-- The four are set together and cleared together.
ALTER TABLE sessions ADD COLUMN acting_as TEXT REFERENCES users (id);
ALTER TABLE sessions ADD COLUMN acting_id TEXT;
ALTER TABLE sessions ADD COLUMN acting_since TEXT;
ALTER TABLE sessions ADD COLUMN allow_changes INTEGER NOT NULL DEFAULT 0
    CHECK (allow_changes IN (0, 1));
CREATE UNIQUE INDEX sessions_acting_id ON sessions (acting_id) WHERE acting_id IS NOT NULL;

-- The person a command was made as, while an overseer acted as them. `user_id` stays the
-- overseer. The index serves the person's own feed: every row whose `acting_as` is them.
ALTER TABLE command_log ADD COLUMN acting_as TEXT REFERENCES users (id);
CREATE INDEX command_log_acting_as ON command_log (acting_as, seq);

-- The once-a-minute sweep finds acting sessions that started and haven't ended by kind, so it
-- reads only those rows, not the whole log.
CREATE INDEX command_log_kind ON command_log (kind, seq);
