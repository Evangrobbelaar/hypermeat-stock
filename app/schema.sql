PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS operator (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL,
    pin         TEXT    NOT NULL UNIQUE,
    role        TEXT    NOT NULL DEFAULT 'capture',  -- capture | supervisor
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS location (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    kind        TEXT    NOT NULL DEFAULT 'store',    -- freezer | chiller | store | floor
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- A business that supplies stock (e.g. a wholesaler or abattoir). Kept as its
-- own table (rather than a free-text field on product/movement) so a name
-- typed once can be selected consistently ever after, and so analytics can
-- group spend by supplier exactly instead of by whatever text was typed that
-- day. movement.supplier (free text) predates this table and stays in place
-- for history; new receipts set both.
CREATE TABLE IF NOT EXISTS supplier (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    UNIQUE,                    -- till/PLU code, used to match weekly sales in phase 2
    name          TEXT    NOT NULL,
    unit          TEXT    NOT NULL,                  -- kg | ea | box | crate | pack | l
    location_id   INTEGER REFERENCES location(id),   -- default storage location
    kind          TEXT    NOT NULL DEFAULT 'stock',  -- stock | packaging
    cost_price    REAL,                              -- current weighted-average cost per unit
    markup_percent REAL,                             -- NULL = use the site-wide default markup
    supplier_id   INTEGER REFERENCES supplier(id),   -- usual/default supplier, editable
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by    INTEGER REFERENCES operator(id)
);

CREATE INDEX IF NOT EXISTS idx_product_name ON product(name);

-- One breakdown = one "we turned raw stock into these products" event.
-- The movements it produced (one OUT for the raw item, one IN per product
-- that came out of it) are linked back to it via movement.breakdown_id.
CREATE TABLE IF NOT EXISTS breakdown (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    note          TEXT,
    operator_id   INTEGER NOT NULL REFERENCES operator(id),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One stocktake = one "here's what's actually on the shelf" event. Each
-- product counted gets one adjusting movement (IN if more was found than the
-- ledger expected, OUT if less) linked back via movement.stocktake_id.
-- A brand-new product's very first stocktake is just its opening balance.
CREATE TABLE IF NOT EXISTS stocktake (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    note          TEXT,
    operator_id   INTEGER NOT NULL REFERENCES operator(id),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One dispatch = one "send this stock out for processing" event, printed as
-- a pick list for staff to fulfil physically. Stock is deducted the moment
-- the dispatch is created (against the requested quantities) — nothing
-- downstream of the freezer is tracked, it's simply gone. dispatch_item
-- keeps requested vs actual side by side so that history survives a
-- correction; the movement(s) it produced are linked via movement.dispatch_id
-- (one OUT per item at creation, plus an extra adjusting IN/OUT if the
-- actual amount taken is later corrected away from the requested amount).
CREATE TABLE IF NOT EXISTS dispatch (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    note          TEXT,
    operator_id   INTEGER NOT NULL REFERENCES operator(id),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dispatch_item (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    dispatch_id         INTEGER NOT NULL REFERENCES dispatch(id),
    product_id          INTEGER NOT NULL REFERENCES product(id),
    location_id         INTEGER REFERENCES location(id),   -- product's own location at dispatch time
    unit                TEXT    NOT NULL,
    requested_quantity  REAL    NOT NULL CHECK (requested_quantity > 0),
    actual_quantity     REAL    NOT NULL CHECK (actual_quantity >= 0),
    updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dispatch_item_dispatch ON dispatch_item(dispatch_id);

-- One row per uploaded photo. The image bytes themselves live on disk under
-- /data/photos/{id}.jpg (same volume as stock.db) — storing a year of daily
-- photos as BLOBs in here would bloat the single database file and slow the
-- nightly .backup cron job, so this table only tracks metadata.
CREATE TABLE IF NOT EXISTS photo (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    mime_type     TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One row per accounting provider this site can connect to. Client ID/Secret
-- are app-level config (environment variables, not stored here) — this row
-- holds the per-business connection: whether it's linked, and the tokens
-- from that OAuth handshake. pending_state is a short-lived CSRF token set
-- when a connect flow starts and checked when the provider redirects back.
CREATE TABLE IF NOT EXISTS integration (
    provider          TEXT PRIMARY KEY CHECK (provider IN ('xero','sage')),
    status            TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected')),
    pending_state     TEXT,
    access_token      TEXT,
    refresh_token     TEXT,
    token_expires_at  TEXT,
    tenant_id         TEXT,
    tenant_name       TEXT,
    connected_at      TEXT,
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The shelf float: packed/ready items kept overnight to restock shelves each
-- morning (e.g. "Beef stew, 69-size tray"). Deliberately unconnected to
-- product/movement/stock_on_hand — no cost, no ledger effect; the two
-- locations here are just where staff physically go to count, not a link to
-- the real `location` table. target_quantity is set by a manager by hand
-- (not derived from anything) and is the par level staff pack toward; NULL
-- until someone sets one. units_per_crate is likewise set by hand — how
-- many individual pieces one crate of this item holds, used only to turn a
-- crate count into a piece count for display; counting and targets always
-- stay in crates regardless of whether this is set.
CREATE TABLE IF NOT EXISTS float_product (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    name              TEXT    NOT NULL UNIQUE,
    location          TEXT    NOT NULL CHECK (location IN ('Big freezer', 'Glass door storage')),
    target_quantity   REAL,
    units_per_crate   INTEGER CHECK (units_per_crate IS NULL OR units_per_crate >= 1),
    active            INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- One float_count = one morning's counting pass. There's no running balance
-- to reset — each morning is simply a fresh count, so "the float resets to
-- zero every morning" needs no reset logic at all: yesterday's numbers just
-- become history the moment today's count is submitted.
CREATE TABLE IF NOT EXISTS float_count (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_id   INTEGER NOT NULL REFERENCES operator(id),
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS float_count_item (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    float_count_id    INTEGER NOT NULL REFERENCES float_count(id),
    float_product_id  INTEGER NOT NULL REFERENCES float_product(id),
    counted_quantity  REAL    NOT NULL CHECK (counted_quantity >= 0)
);

CREATE INDEX IF NOT EXISTS idx_float_count_item_count ON float_count_item(float_count_id);

-- Append-only ledger. Nothing is ever updated or deleted.
-- A mistake is corrected by posting a reversal row that points at the original.
CREATE TABLE IF NOT EXISTS movement (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL REFERENCES product(id),
    direction     TEXT    NOT NULL CHECK (direction IN ('IN','OUT','REVERSAL')),
    quantity      REAL    NOT NULL CHECK (quantity > 0),
    unit          TEXT    NOT NULL,
    unit_cost     REAL,                              -- what was paid per unit (receipts only)
    location_id   INTEGER REFERENCES location(id),
    supplier      TEXT,                              -- legacy free text; kept for pre-supplier-table history
    supplier_id   INTEGER REFERENCES supplier(id),   -- receipts only, set alongside supplier (name at the time)
    reference     TEXT,                              -- delivery note / invoice number
    note          TEXT,
    operator_id   INTEGER NOT NULL REFERENCES operator(id),
    reverses_id   INTEGER REFERENCES movement(id),
    breakdown_id  INTEGER REFERENCES breakdown(id),   -- set for both sides of a breakdown
    stocktake_id  INTEGER REFERENCES stocktake(id),    -- set for a stocktake's adjustment rows
    dispatch_id   INTEGER REFERENCES dispatch(id),      -- set for a dispatch's OUT row and any later correction
    photo_id      INTEGER REFERENCES photo(id),        -- proof photo (required on breakdown rows)
    device        TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movement_product ON movement(product_id);
CREATE INDEX IF NOT EXISTS idx_movement_created ON movement(created_at);
CREATE INDEX IF NOT EXISTS idx_movement_breakdown ON movement(breakdown_id);
CREATE INDEX IF NOT EXISTS idx_movement_stocktake ON movement(stocktake_id);
-- idx_movement_dispatch is NOT created here: on a fresh database the column
-- exists by the time this runs (it's in the CREATE TABLE above), but on an
-- existing database this script runs before _migrate() adds the column via
-- ALTER TABLE, and CREATE INDEX on a column that doesn't exist yet fails.
-- It's created in _migrate() instead, right after the column is added.

-- A movement can only ever be reversed once — this backs up the same check
-- /api/reversals makes itself, at the level that actually matters under
-- concurrent requests (two simultaneous reversals of the same entry both
-- reading "not yet reversed" before either commits). The endpoint also
-- serializes writers with BEGIN IMMEDIATE, which is what actually prevents
-- that race; this index is the hard backstop in case that ever regresses.
CREATE UNIQUE INDEX IF NOT EXISTS ux_movement_reverses_once
    ON movement(reverses_id) WHERE reverses_id IS NOT NULL;

-- Signed quantity per movement, so on-hand is a plain SUM.
-- A REVERSAL must cancel whatever it reverses — including another REVERSAL,
-- since "undo the undo" has to restore the original effect. That can only be
-- computed by walking the chain: a REVERSAL's sign is the negation of
-- whatever its target resolved to, resolved recursively (a single WHEN
-- 'OUT' check here would get every second link in the chain backwards).
CREATE VIEW IF NOT EXISTS movement_signed AS
WITH RECURSIVE resolved(id, signed_qty) AS (
    SELECT id, CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END
    FROM movement WHERE direction IN ('IN', 'OUT')
    UNION ALL
    SELECT m.id, -resolved.signed_qty
    FROM movement m
    JOIN resolved ON resolved.id = m.reverses_id
    WHERE m.direction = 'REVERSAL'
)
SELECT m.*, resolved.signed_qty
FROM movement m
JOIN resolved ON resolved.id = m.id;

CREATE VIEW IF NOT EXISTS stock_on_hand AS
SELECT
    p.id            AS product_id,
    p.code          AS code,
    p.name          AS name,
    p.unit          AS unit,
    l.name          AS location,
    COALESCE(SUM(ms.signed_qty), 0) AS on_hand,
    MAX(ms.created_at)              AS last_movement_at
FROM product p
LEFT JOIN movement_signed ms ON ms.product_id = p.id
LEFT JOIN location l         ON l.id = p.location_id
WHERE p.active = 1
GROUP BY p.id;
