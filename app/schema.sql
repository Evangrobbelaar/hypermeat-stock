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

CREATE TABLE IF NOT EXISTS product (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    UNIQUE,                    -- till/PLU code, used to match weekly sales in phase 2
    name          TEXT    NOT NULL,
    unit          TEXT    NOT NULL,                  -- kg | ea | box | crate | pack | l
    location_id   INTEGER REFERENCES location(id),   -- default storage location
    active        INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    created_by    INTEGER REFERENCES operator(id)
);

CREATE INDEX IF NOT EXISTS idx_product_name ON product(name);

-- Append-only ledger. Nothing is ever updated or deleted.
-- A mistake is corrected by posting a reversal row that points at the original.
CREATE TABLE IF NOT EXISTS movement (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL REFERENCES product(id),
    direction     TEXT    NOT NULL CHECK (direction IN ('IN','OUT','REVERSAL')),
    quantity      REAL    NOT NULL CHECK (quantity > 0),
    unit          TEXT    NOT NULL,
    location_id   INTEGER REFERENCES location(id),
    supplier      TEXT,
    reference     TEXT,                              -- delivery note / invoice number
    note          TEXT,
    operator_id   INTEGER NOT NULL REFERENCES operator(id),
    reverses_id   INTEGER REFERENCES movement(id),
    device        TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_movement_product ON movement(product_id);
CREATE INDEX IF NOT EXISTS idx_movement_created ON movement(created_at);

-- Signed quantity per movement, so on-hand is a plain SUM.
CREATE VIEW IF NOT EXISTS movement_signed AS
SELECT
    m.*,
    CASE
        WHEN m.direction = 'IN' THEN m.quantity
        ELSE -m.quantity
    END AS signed_qty
FROM movement m;

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
