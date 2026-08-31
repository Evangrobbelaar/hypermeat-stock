import os
import sqlite3
from pathlib import Path

DB_PATH = os.environ.get("STOCK_DB_PATH", "/data/stock.db")
SCHEMA = Path(__file__).with_name("schema.sql")


def connect() -> sqlite3.Connection:
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    conn = connect()
    try:
        conn.executescript(SCHEMA.read_text())

        cur = conn.execute("SELECT COUNT(*) AS n FROM operator")
        if cur.fetchone()["n"] == 0:
            conn.executemany(
                "INSERT INTO operator (name, pin, role) VALUES (?, ?, ?)",
                [
                    ("Receiving 1", "1111", "capture"),
                    ("Supervisor", "9999", "supervisor"),
                ],
            )

        cur = conn.execute("SELECT COUNT(*) AS n FROM location")
        if cur.fetchone()["n"] == 0:
            conn.executemany(
                "INSERT INTO location (name, kind) VALUES (?, ?)",
                [
                    ("Freezer 1", "freezer"),
                    ("Chiller 1", "chiller"),
                    ("Dry store", "store"),
                    ("Receiving bay", "floor"),
                ],
            )
        conn.commit()
    finally:
        conn.close()
