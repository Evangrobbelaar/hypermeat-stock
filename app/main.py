import sqlite3
from pathlib import Path
from typing import Optional, Literal

from fastapi import FastAPI, HTTPException, Header, Depends
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .db import connect, init_db

UNITS = ["kg", "ea", "box", "crate", "pack", "l"]

app = FastAPI(title="Hyper Meat Stock", version="0.1.0")
STATIC = Path(__file__).parent.parent / "static"


@app.on_event("startup")
def _startup() -> None:
    init_db()


# ---------- auth ----------------------------------------------------------

def current_operator(x_operator_pin: str = Header(default="")) -> sqlite3.Row:
    """Shared-tablet auth: a PIN identifies who captured the stock.

    Every ledger row is stamped with this operator, which is the whole point —
    the record has to say who accepted the delivery.
    """
    if not x_operator_pin:
        raise HTTPException(401, "Enter your PIN to continue.")
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM operator WHERE pin = ? AND active = 1", (x_operator_pin,)
        ).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(401, "That PIN is not recognised.")
    return row


# ---------- schemas -------------------------------------------------------

class LoginIn(BaseModel):
    pin: str


class ProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    unit: str
    location_id: Optional[int] = None
    code: Optional[str] = None


class LocationIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["freezer", "chiller", "store", "floor"] = "store"


class ReceiptIn(BaseModel):
    product_id: int
    quantity: float = Field(gt=0)
    location_id: Optional[int] = None
    supplier: Optional[str] = None
    reference: Optional[str] = None
    note: Optional[str] = None
    device: Optional[str] = None


class ReversalIn(BaseModel):
    movement_id: int
    note: Optional[str] = None


# ---------- api -----------------------------------------------------------

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/meta")
def meta():
    return {"units": UNITS}


@app.post("/api/login")
def login(body: LoginIn):
    op = current_operator(body.pin)
    return {"id": op["id"], "name": op["name"], "role": op["role"]}


@app.get("/api/locations")
def list_locations():
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT id, name, kind FROM location WHERE active = 1 ORDER BY name"
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.post("/api/locations", status_code=201)
def create_location(body: LocationIn, op=Depends(current_operator)):
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO location (name, kind) VALUES (?, ?)",
            (body.name.strip(), body.kind),
        )
        conn.commit()
        return {"id": cur.lastrowid, "name": body.name.strip(), "kind": body.kind}
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"A location called {body.name} already exists.")
    finally:
        conn.close()


@app.get("/api/products")
def list_products(q: str = ""):
    conn = connect()
    try:
        sql = """SELECT p.id, p.code, p.name, p.unit, p.location_id, l.name AS location
                 FROM product p LEFT JOIN location l ON l.id = p.location_id
                 WHERE p.active = 1"""
        args: list = []
        if q:
            sql += " AND (p.name LIKE ? OR IFNULL(p.code,'') LIKE ?)"
            args += [f"%{q}%", f"%{q}%"]
        sql += " ORDER BY p.name"
        rows = conn.execute(sql, args).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.post("/api/products", status_code=201)
def create_product(body: ProductIn, op=Depends(current_operator)):
    if body.unit not in UNITS:
        raise HTTPException(422, f"Unit must be one of: {', '.join(UNITS)}")
    conn = connect()
    try:
        cur = conn.execute(
            """INSERT INTO product (code, name, unit, location_id, created_by)
               VALUES (?, ?, ?, ?, ?)""",
            (
                (body.code or "").strip() or None,
                body.name.strip(),
                body.unit,
                body.location_id,
                op["id"],
            ),
        )
        conn.commit()
        return {"id": cur.lastrowid, "name": body.name.strip(), "unit": body.unit}
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That product code is already in use.")
    finally:
        conn.close()


@app.post("/api/receipts", status_code=201)
def receive_stock(body: ReceiptIn, op=Depends(current_operator)):
    conn = connect()
    try:
        product = conn.execute(
            "SELECT * FROM product WHERE id = ? AND active = 1", (body.product_id,)
        ).fetchone()
        if not product:
            raise HTTPException(404, "That product no longer exists.")

        cur = conn.execute(
            """INSERT INTO movement
               (product_id, direction, quantity, unit, location_id,
                supplier, reference, note, operator_id, device)
               VALUES (?, 'IN', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                product["id"],
                body.quantity,
                product["unit"],
                body.location_id or product["location_id"],
                (body.supplier or "").strip() or None,
                (body.reference or "").strip() or None,
                (body.note or "").strip() or None,
                op["id"],
                body.device,
            ),
        )
        conn.commit()
        on_hand = conn.execute(
            "SELECT on_hand FROM stock_on_hand WHERE product_id = ?", (product["id"],)
        ).fetchone()
        return {
            "movement_id": cur.lastrowid,
            "product": product["name"],
            "quantity": body.quantity,
            "unit": product["unit"],
            "on_hand": on_hand["on_hand"] if on_hand else body.quantity,
            "operator": op["name"],
        }
    finally:
        conn.close()


@app.post("/api/reversals", status_code=201)
def reverse_movement(body: ReversalIn, op=Depends(current_operator)):
    """Corrections never edit history — they post an opposing row."""
    conn = connect()
    try:
        orig = conn.execute(
            "SELECT * FROM movement WHERE id = ?", (body.movement_id,)
        ).fetchone()
        if not orig:
            raise HTTPException(404, "That entry could not be found.")
        already = conn.execute(
            "SELECT id FROM movement WHERE reverses_id = ?", (body.movement_id,)
        ).fetchone()
        if already:
            raise HTTPException(409, "That entry has already been reversed.")

        cur = conn.execute(
            """INSERT INTO movement
               (product_id, direction, quantity, unit, location_id,
                supplier, reference, note, operator_id, reverses_id)
               VALUES (?, 'REVERSAL', ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                orig["product_id"],
                orig["quantity"],
                orig["unit"],
                orig["location_id"],
                orig["supplier"],
                orig["reference"],
                (body.note or "").strip() or None,
                op["id"],
                orig["id"],
            ),
        )
        conn.commit()
        return {"movement_id": cur.lastrowid, "reverses": orig["id"]}
    finally:
        conn.close()


@app.get("/api/stock")
def stock():
    conn = connect()
    try:
        rows = conn.execute(
            "SELECT * FROM stock_on_hand ORDER BY name"
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.get("/api/movements")
def movements(limit: int = 50):
    conn = connect()
    try:
        rows = conn.execute(
            """SELECT m.id, m.direction, m.quantity, m.unit, m.supplier,
                      m.reference, m.note, m.created_at, m.reverses_id,
                      p.name AS product, o.name AS operator, l.name AS location,
                      (SELECT COUNT(*) FROM movement r WHERE r.reverses_id = m.id) AS reversed
               FROM movement m
               JOIN product  p ON p.id = m.product_id
               JOIN operator o ON o.id = m.operator_id
               LEFT JOIN location l ON l.id = m.location_id
               ORDER BY m.id DESC LIMIT ?""",
            (min(limit, 500),),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


# ---------- static --------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
