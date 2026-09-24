-- Fixed assets (M4). Append-only, like every migration (CLAUDE.md hard rule 7).
--
-- `settings` columns hold acct-core's `DepreciationSettings` as JSON, and `accounts` columns its
-- `AssetAccounts`. Both are checked in Rust when they're read.

-- The practice's asset classes for an entity type, set by the master user. `key` is a stable,
-- human-chosen name (such as `plant`) that the asset schedule uses, since a ReportDoc holds no
-- generated ids. Editing a class never changes existing assets: they carry copies.
CREATE TABLE asset_classes (
    id          TEXT    PRIMARY KEY,
    entity_type TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    settings    TEXT    NOT NULL,
    accounts    TEXT    NOT NULL,
    created_seq INTEGER NOT NULL,
    updated_seq INTEGER NOT NULL,
    UNIQUE (entity_type, key)
);

-- A client's override of a practice class. A NULL column means "use the practice's".
CREATE TABLE client_asset_classes (
    client_id   TEXT    NOT NULL REFERENCES clients (id),
    class_id    TEXT    NOT NULL REFERENCES asset_classes (id),
    settings    TEXT,
    accounts    TEXT,
    updated_seq INTEGER NOT NULL,
    PRIMARY KEY (client_id, class_id)
) WITHOUT ROWID;

-- A client's asset register. The resolved settings and accounts are copied onto the asset when
-- it's created; `rate_source` records where the settings came from (`practice`, `client` or
-- `custom`). `opening_*` is accumulated depreciation brought forward at the start of a
-- client-year, for an asset acquired before the register's first year. `disposal_*` are all
-- NULL or all set.
CREATE TABLE assets (
    id                  TEXT    PRIMARY KEY,
    client_id           TEXT    NOT NULL REFERENCES clients (id),
    class_id            TEXT    NOT NULL REFERENCES asset_classes (id),
    name                TEXT    NOT NULL,
    cost                INTEGER NOT NULL,
    residual            INTEGER NOT NULL,
    acquired            TEXT    NOT NULL,
    settings            TEXT    NOT NULL,
    rate_source         TEXT    NOT NULL,
    accounts            TEXT    NOT NULL,
    opening_date        TEXT,
    opening_accumulated INTEGER,
    disposal_date       TEXT,
    disposal_proceeds   INTEGER,
    disposal_account    TEXT,
    created_seq         INTEGER NOT NULL,
    updated_seq         INTEGER NOT NULL,
    CHECK ((opening_date IS NULL) = (opening_accumulated IS NULL)),
    CHECK ((disposal_date IS NULL) = (disposal_proceeds IS NULL)
       AND (disposal_date IS NULL) = (disposal_account IS NULL))
);
CREATE INDEX assets_client ON assets (client_id);

-- Each asset's depreciation charge as last posted for a year, written by the depreciation run.
-- A finalised year's charges are used as they are when later years are computed, so a change
-- of method or rate only applies from the first open year.
CREATE TABLE asset_charges (
    asset_id       TEXT    NOT NULL REFERENCES assets (id),
    client_year_id TEXT    NOT NULL REFERENCES client_years (id),
    amount         INTEGER NOT NULL,
    posted_seq     INTEGER NOT NULL,
    PRIMARY KEY (asset_id, client_year_id)
) WITHOUT ROWID;
