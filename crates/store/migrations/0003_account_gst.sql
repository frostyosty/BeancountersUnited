-- Default GST codes on accounts (M10). Append-only, like every migration (CLAUDE.md hard rule 7).
--
-- `default_gst` holds acct-core's `GstCode` (`standard`, `zero`, `exempt` or `none`), or NULL when
-- the account has no default. Only income and expense accounts have one; acct-core checks that
-- when a chart is read.
ALTER TABLE master_chart_accounts ADD COLUMN default_gst TEXT;
ALTER TABLE accounts ADD COLUMN default_gst TEXT;
