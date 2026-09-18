import os
import sqlite3
from pathlib import Path

DB_PATH = os.environ.get("STOCK_DB_PATH", "/data/stock.db")
SCHEMA = Path(__file__).with_name("schema.sql")

# Photos live on disk, not in the database — but on the same volume as
# stock.db, so this is derived from DB_PATH rather than hardcoded. That also
# means overriding STOCK_DB_PATH (e.g. for tests) relocates photo storage
# right along with it, instead of writing outside the test sandbox.
PHOTOS_DIR = Path(DB_PATH).parent / "photos"

SEED_OPERATORS = [
    ("Receiving 1", "1111", "capture"),
    ("Supervisor", "9999", "supervisor"),
]

SEED_LOCATIONS = [
    ("Freezer 1", "freezer"),
    ("Chiller 1", "chiller"),
    ("Dry store", "store"),
    ("Receiving bay", "floor"),
]


def connect() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def _refresh_views(conn: sqlite3.Connection) -> None:
    """Views hold no data, so it's always safe to drop and recreate them.

    CREATE VIEW IF NOT EXISTS in schema.sql only defines a view the first
    time it's missing — once it exists, an updated view definition in the
    code would otherwise never take effect on a live database.
    """
    conn.execute("DROP VIEW IF EXISTS stock_on_hand")
    conn.execute("DROP VIEW IF EXISTS movement_signed")


def _migrate(conn: sqlite3.Connection) -> None:
    """Add columns to tables that already existed before this column was introduced.

    CREATE TABLE IF NOT EXISTS in schema.sql only creates a table the first
    time it's missing — it never alters one that's already there, so a new
    column needs an explicit ALTER TABLE against a live database.
    """
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(movement)").fetchall()}
    if "breakdown_id" not in cols:
        conn.execute("ALTER TABLE movement ADD COLUMN breakdown_id INTEGER REFERENCES breakdown(id)")
    if "stocktake_id" not in cols:
        conn.execute("ALTER TABLE movement ADD COLUMN stocktake_id INTEGER REFERENCES stocktake(id)")
    if "unit_cost" not in cols:
        conn.execute("ALTER TABLE movement ADD COLUMN unit_cost REAL")
    if "photo_id" not in cols:
        conn.execute("ALTER TABLE movement ADD COLUMN photo_id INTEGER REFERENCES photo(id)")
    if "dispatch_id" not in cols:
        conn.execute("ALTER TABLE movement ADD COLUMN dispatch_id INTEGER REFERENCES dispatch(id)")
    # Only safe to create now that the column above is guaranteed to exist —
    # see the comment in schema.sql for why this can't just live there.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_movement_dispatch ON movement(dispatch_id)")
    if "supplier_id" not in cols:
        conn.execute("ALTER TABLE movement ADD COLUMN supplier_id INTEGER REFERENCES supplier(id)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_movement_supplier ON movement(supplier_id)")

    product_cols = {row["name"] for row in conn.execute("PRAGMA table_info(product)").fetchall()}
    if "kind" not in product_cols:
        conn.execute("ALTER TABLE product ADD COLUMN kind TEXT NOT NULL DEFAULT 'stock'")
    if "cost_price" not in product_cols:
        conn.execute("ALTER TABLE product ADD COLUMN cost_price REAL")
    if "markup_percent" not in product_cols:
        conn.execute("ALTER TABLE product ADD COLUMN markup_percent REAL")
    if "supplier_id" not in product_cols:
        conn.execute("ALTER TABLE product ADD COLUMN supplier_id INTEGER REFERENCES supplier(id)")

    float_product_cols = {row["name"] for row in conn.execute("PRAGMA table_info(float_product)").fetchall()}
    if "location" not in float_product_cols:
        # The default only ever matters for the syntax requirement that a
        # NOT NULL column added via ALTER TABLE must have one — there are no
        # existing float_product rows at the time this was introduced for
        # it to actually apply to.
        conn.execute(
            """ALTER TABLE float_product ADD COLUMN location TEXT
               NOT NULL DEFAULT 'Big freezer'
               CHECK (location IN ('Big freezer', 'Glass door storage'))"""
        )
    if "units_per_crate" not in float_product_cols:
        # How many individual pieces one crate holds — nullable, since it's
        # set by hand per product and not every item will have it recorded
        # right away. Never affects counting or targets, which stay in
        # crates; it only translates a crate count into a piece count for
        # display.
        conn.execute(
            """ALTER TABLE float_product ADD COLUMN units_per_crate INTEGER
               CHECK (units_per_crate IS NULL OR units_per_crate >= 1)"""
        )


def init_db() -> None:
    """Create the schema if it's missing, and seed defaults only on a brand-new database.

    Existing rows are never touched here — operators and locations are managed
    through the API (or directly against stock.db) once the site is live.
    """
    conn = connect()
    try:
        _refresh_views(conn)
        conn.executescript(SCHEMA.read_text())
        _migrate(conn)

        if conn.execute("SELECT COUNT(*) AS n FROM operator").fetchone()["n"] == 0:
            conn.executemany(
                "INSERT INTO operator (name, pin, role) VALUES (?, ?, ?)",
                SEED_OPERATORS,
            )

        if conn.execute("SELECT COUNT(*) AS n FROM location").fetchone()["n"] == 0:
            conn.executemany(
                "INSERT INTO location (name, kind) VALUES (?, ?)",
                SEED_LOCATIONS,
            )

        # One fixed row per known provider, disconnected until someone
        # actually connects it. INSERT OR IGNORE so this is safe to run
        # every startup regardless of whether the row already exists.
        conn.executemany(
            "INSERT OR IGNORE INTO integration (provider) VALUES (?)",
            [("xero",), ("sage",)],
        )

        conn.commit()
    finally:
        conn.close()
