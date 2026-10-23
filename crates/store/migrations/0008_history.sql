-- M13, who changed what. Append-only (CLAUDE.md hard rule 7).
--
-- What each command changed, as JSON (`acct_server::history::Changes`): the business's tax to pay
-- before and after, and the before and after of each value it touched. It's part of the command's
-- own log entry, so there's still one record of changes. NULL for commands logged before M13.
ALTER TABLE command_log ADD COLUMN changes TEXT;

-- The history panel filters a business's log by person and date.
CREATE INDEX command_log_user ON command_log (user_id, seq);
