import base64
import math
import os
import secrets
import sqlite3
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Literal
from urllib.parse import urlencode

import requests as http
from fastapi import FastAPI, HTTPException, Header, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .db import connect, init_db, PHOTOS_DIR

UNITS = ["kg", "ea", "box", "crate", "pack", "l"]
LOCATION_KINDS = ["freezer", "chiller", "store", "floor"]

# Accounting integrations. Client ID/Secret are app-level secrets that live
# in the environment, never in the database or a request body — a business
# gets these by registering a developer app on each platform's own portal.
# PUBLIC_BASE_URL must exactly match the redirect URI registered there.
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")

INTEGRATION_PROVIDERS = {
    "xero": {
        "label": "Xero",
        "client_id": os.environ.get("XERO_CLIENT_ID", ""),
        "client_secret": os.environ.get("XERO_CLIENT_SECRET", ""),
        "authorize_url": "https://login.xero.com/identity/connect/authorize",
        "token_url": "https://identity.xero.com/connect/token",
        "scope": "openid profile email offline_access accounting.transactions accounting.contacts accounting.settings",
    },
    "sage": {
        "label": "Sage",
        "client_id": os.environ.get("SAGE_CLIENT_ID", ""),
        "client_secret": os.environ.get("SAGE_CLIENT_SECRET", ""),
        "authorize_url": "https://www.sageone.com/oauth2/auth/central",
        "token_url": "https://oauth.accounting.sage.com/token",
        "scope": "full_access",
    },
}

app = FastAPI(title="Hyper Meat Stock", version="0.2.0")
STATIC = Path(__file__).parent.parent / "static"


def _sanitize_for_json(obj):
    """Non-finite floats (inf/-inf/nan) can't be represented in strict JSON.
    Field(allow_inf_nan=False) correctly rejects them as invalid input, but
    FastAPI's default 422 handler echoes the rejected value straight back in
    the error body's "input" field — and Starlette's JSONResponse renders
    with allow_nan=False, so serializing THAT echo crashes with an unhandled
    500, turning a clean validation error into an outage. Recurse through the
    error payload and swap any non-finite float for its string form before it
    ever reaches the JSON encoder.

    A @field_validator that raises plain ValueError(...) hits the same class
    of problem from a different angle: pydantic tucks the exception object
    itself into error["ctx"]["error"], and that's not JSON-serializable
    either — every validator in this file that rejects a whitespace-only
    string this way (name fields, across products/locations/suppliers/float
    items) would otherwise turn a normal "that's blank" 422 into a 500."""
    if isinstance(obj, float) and not math.isfinite(obj):
        return str(obj)
    if isinstance(obj, BaseException):
        return str(obj)
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_sanitize_for_json(v) for v in obj]
    return obj


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"detail": _sanitize_for_json(exc.errors())})


@app.middleware("http")
async def _security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    # The app shell and its JS/CSS have no cache-busting (no build step, no
    # hashed filenames) and StaticFiles sets no Cache-Control of its own —
    # left alone, browsers apply heuristic caching and a shared tablet that's
    # rarely fully closed can sit on yesterday's app.js for a long time after
    # a deploy. no-cache still lets the browser keep a local copy, it just
    # has to revalidate via ETag on every load — a same-server 304 back, not
    # a real refetch — so this trades a negligible round trip for every
    # deploy actually reaching the tablet on its next reload.
    if request.url.path == "/" or request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.on_event("startup")
def _startup() -> None:
    init_db()


# ---------- auth ------------------------------------------------------------

# A 4-digit PIN is only 10,000 possibilities — with no throttling, a script
# can exhaust that keyspace in minutes. This is a simple in-memory sliding
# window per client IP: cheap, no schema change, and correct for this app's
# single-container deployment (a multi-instance deployment would need a
# shared store instead, e.g. Redis). Keyed by IP rather than by attempted PIN
# so it also catches an attacker rotating PINs to dodge a per-PIN counter.
PIN_ATTEMPT_WINDOW_SECONDS = 300
PIN_ATTEMPT_MAX = 15
_failed_pin_attempts: dict[str, deque] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def current_operator(request: Request, x_operator_pin: str = Header(default="")) -> sqlite3.Row:
    """Shared-tablet auth: a PIN identifies who captured the stock.

    Every ledger row is stamped with this operator, which is the whole point —
    the record has to say who accepted the delivery.
    """
    ip = _client_ip(request)
    now = time.monotonic()
    attempts = _failed_pin_attempts[ip]
    while attempts and now - attempts[0] > PIN_ATTEMPT_WINDOW_SECONDS:
        attempts.popleft()
    if len(attempts) >= PIN_ATTEMPT_MAX:
        raise HTTPException(429, "Too many incorrect PINs. Wait a few minutes and try again.")

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
        attempts.append(now)
        raise HTTPException(401, "That PIN is not recognised.")
    return row


# ---------- request schemas --------------------------------------------------

# A generous ceiling well above anything a real receipt/breakdown/stocktake/
# unit cost should ever be — not a "correct" business limit, just a backstop
# against a fat-fingered extra digit (or a deliberately hostile value)
# creating a ledger entry that's off by orders of magnitude with no pushback,
# and against non-finite floats (inf/nan) poisoning stored sums: a SUM() over
# an inf quantity makes every view built on it permanently non-finite, which
# then fails to serialize as JSON for every caller, not just the bad row.
MAX_QUANTITY = 100_000


def _qty_field(**kwargs):
    return Field(le=MAX_QUANTITY, allow_inf_nan=False, **kwargs)


class LoginIn(BaseModel):
    pin: str


class LocationIn(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    kind: Literal["freezer", "chiller", "store", "floor"] = "store"

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        # A whitespace-only string (e.g. two spaces) satisfies
        # Field(min_length=1) before stripping, and the handler then stores
        # v.strip() — which can land below the minimum (even empty) with
        # nothing left to reject it. Re-check length AFTER stripping and
        # normalize here, so what's validated is exactly what gets stored.
        v = v.strip()
        if len(v) < 1:
            raise ValueError("Name can't be blank.")
        return v


class ProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    unit: str
    location_id: Optional[int] = None
    code: Optional[str] = Field(default=None, max_length=40)
    kind: Literal["stock", "packaging"] = "stock"
    supplier_id: Optional[int] = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v


class ProductPatchIn(BaseModel):
    # Every field optional: a caller sends only what it wants to change.
    # At least one has to be present (checked in the handler) — an empty
    # patch is almost certainly a client bug, not a deliberate no-op.
    name: Optional[str] = Field(default=None, min_length=2, max_length=120)
    cost_price: Optional[float] = _qty_field(default=None, ge=0)
    supplier_id: Optional[int] = None
    # Tri-state on purpose: absent (don't touch), True, or False. Setting a
    # product's active flag to False is how "remove this product" works —
    # its ledger history stays intact, it just drops out of the pick lists.
    active: Optional[bool] = None

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v


class SupplierIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 1:
            raise ValueError("Name can't be blank.")
        return v


class ReceiptItem(BaseModel):
    product_id: int
    quantity: float = _qty_field(gt=0)
    location_id: Optional[int] = None
    unit_cost: Optional[float] = _qty_field(default=None, gt=0)


class ReceiptIn(BaseModel):
    items: list[ReceiptItem] = Field(min_length=1)
    # supplier (free text) predates supplier_id and still works on its own —
    # a caller that only sends text gets the old behaviour untouched. When
    # supplier_id is given the handler resolves it and uses that name
    # instead, so the two never disagree on one receipt.
    supplier: Optional[str] = Field(default=None, max_length=200)
    supplier_id: Optional[int] = None
    reference: Optional[str] = Field(default=None, max_length=200)
    note: Optional[str] = Field(default=None, max_length=1000)
    photo_id: Optional[int] = None
    device: Optional[str] = Field(default=None, max_length=200)


class PhotoIn(BaseModel):
    # ~15M base64 chars comfortably covers an 8MB photo (this app's own
    # camera capture already downscales to <=1280px + JPEG quality 0.7,
    # which lands well under 1MB — this is a backstop against a much larger
    # payload sent directly to the API, not the expected size).
    data_url: str = Field(max_length=15_000_000)


class ReversalIn(BaseModel):
    movement_id: int
    note: Optional[str] = Field(default=None, max_length=1000)


class DispatchItemIn(BaseModel):
    product_id: int
    quantity: float = _qty_field(gt=0)  # the requested amount


class DispatchIn(BaseModel):
    items: list[DispatchItemIn] = Field(min_length=1)
    note: Optional[str] = Field(default=None, max_length=1000)


class DispatchActualIn(BaseModel):
    # 0 is allowed — the whole line turned out not to be available and
    # nothing was actually sent.
    actual_quantity: float = _qty_field(ge=0)


class StocktakeCount(BaseModel):
    product_id: int
    counted_quantity: float = _qty_field(ge=0)


class StocktakeIn(BaseModel):
    counts: list[StocktakeCount] = Field(min_length=1)
    note: Optional[str] = Field(default=None, max_length=1000)


FLOAT_LOCATIONS = ["Big freezer", "Glass door storage"]


class FloatProductIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    location: Literal["Big freezer", "Glass door storage"]
    target_quantity: Optional[float] = _qty_field(default=None, ge=0)
    units_per_crate: Optional[int] = Field(default=None, ge=1, le=10_000)

    @field_validator("name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if len(v) < 2:
            raise ValueError("Name must be at least 2 characters.")
        return v


class FloatTargetIn(BaseModel):
    target_quantity: Optional[float] = _qty_field(default=None, ge=0)


class FloatUnitsPerCrateIn(BaseModel):
    units_per_crate: Optional[int] = Field(default=None, ge=1, le=10_000)


class FloatCountItemIn(BaseModel):
    float_product_id: int
    counted_quantity: float = _qty_field(ge=0)


class FloatCountIn(BaseModel):
    counts: list[FloatCountItemIn] = Field(min_length=1)


def _clean(s: Optional[str]) -> Optional[str]:
    return (s or "").strip() or None


def _check_location(conn: sqlite3.Connection, location_id: Optional[int]) -> None:
    """A given location_id must point at a real, active location.

    Without this, an unknown id reaches the INSERT and fails as a foreign-key
    violation — which either surfaces as a raw 500, or gets mis-attributed to
    an unrelated UNIQUE check by a broad `except IntegrityError`.
    """
    if location_id is None:
        return
    if not conn.execute(
        "SELECT 1 FROM location WHERE id = ? AND active = 1", (location_id,)
    ).fetchone():
        raise HTTPException(404, "That location no longer exists.")


def _check_photo(conn: sqlite3.Connection, photo_id: Optional[int]) -> None:
    """A given photo_id must point at a real photo row.

    Mirrors _check_location — without this, an unknown id reaches the INSERT
    and fails as a raw foreign-key violation instead of a plain message.
    """
    if photo_id is None:
        return
    if not conn.execute("SELECT 1 FROM photo WHERE id = ?", (photo_id,)).fetchone():
        raise HTTPException(404, "That photo could not be found.")


def _get_supplier_name(conn: sqlite3.Connection, supplier_id: Optional[int]) -> Optional[str]:
    """Resolve a supplier_id to its current name, or 404 if it doesn't exist.

    Mirrors _check_location — without this, an unknown id reaches the INSERT
    and fails as a raw foreign-key violation instead of a plain message.
    """
    if supplier_id is None:
        return None
    row = conn.execute(
        "SELECT name FROM supplier WHERE id = ? AND active = 1", (supplier_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "That supplier no longer exists.")
    return row["name"]


# ---------- health + meta -----------------------------------------------------

@app.get("/healthz")
def healthz():
    return {"ok": True}


@app.get("/api/meta")
def meta():
    return {"units": UNITS, "location_kinds": LOCATION_KINDS}


# ---------- auth --------------------------------------------------------------

@app.post("/api/login")
def login(body: LoginIn, request: Request):
    op = current_operator(request, body.pin)
    return {"id": op["id"], "name": op["name"], "role": op["role"]}


# ---------- locations -----------------------------------------------------

@app.get("/api/locations")
def list_locations(op=Depends(current_operator)):
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


# ---------- products --------------------------------------------------------

@app.get("/api/products")
def list_products(
    q: str = "",
    kind: Optional[Literal["stock", "packaging"]] = None,
    include_inactive: bool = False,
    op=Depends(current_operator),
):
    conn = connect()
    try:
        sql = """SELECT p.id, p.code, p.name, p.unit, p.location_id, p.kind, p.cost_price,
                         p.supplier_id, p.active, l.name AS location, sup.name AS supplier
                 FROM product p
                 LEFT JOIN location l ON l.id = p.location_id
                 LEFT JOIN supplier sup ON sup.id = p.supplier_id
                 WHERE 1=1"""
        args: list = []
        if not include_inactive:
            sql += " AND p.active = 1"
        if kind:
            sql += " AND p.kind = ?"
            args.append(kind)
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
        _check_location(conn, body.location_id)
        _get_supplier_name(conn, body.supplier_id)  # validates existence; name unused here
        cur = conn.execute(
            """INSERT INTO product (code, name, unit, location_id, created_by, kind, supplier_id)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                _clean(body.code),
                body.name.strip(),
                body.unit,
                body.location_id,
                op["id"],
                body.kind,
                body.supplier_id,
            ),
        )
        conn.commit()
        return {"id": cur.lastrowid, "name": body.name.strip(), "unit": body.unit, "kind": body.kind}
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That product code is already in use.")
    finally:
        conn.close()


@app.patch("/api/products/{product_id}")
def update_product(product_id: int, body: ProductPatchIn, op=Depends(current_operator)):
    """Edit a product's name, cost price, default supplier, or active flag.

    Deactivating is how "remove this product" works — its ledger history
    (movements, breakdowns, dispatches it was ever part of) stays intact and
    keeps referencing it; it just drops out of pick lists (list_products
    filters to active=1 by default) and its stock_on_hand row disappears
    (the view's WHERE p.active = 1). Reactivating brings it straight back
    with that same history, nothing to restore.
    """
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        raise HTTPException(422, "Nothing to update.")

    conn = connect()
    try:
        product = conn.execute("SELECT * FROM product WHERE id = ?", (product_id,)).fetchone()
        if not product:
            raise HTTPException(404, "That product no longer exists.")

        sets, args = [], []
        if "name" in fields:
            sets.append("name = ?")
            args.append(fields["name"].strip())
        if "cost_price" in fields:
            sets.append("cost_price = ?")
            args.append(fields["cost_price"])
        if "supplier_id" in fields:
            _get_supplier_name(conn, fields["supplier_id"])
            sets.append("supplier_id = ?")
            args.append(fields["supplier_id"])
        if "active" in fields:
            sets.append("active = ?")
            args.append(1 if fields["active"] else 0)

        args.append(product_id)
        conn.execute(f"UPDATE product SET {', '.join(sets)} WHERE id = ?", args)
        conn.commit()

        updated = conn.execute(
            """SELECT p.id, p.code, p.name, p.unit, p.location_id, p.kind, p.cost_price,
                      p.supplier_id, p.active, l.name AS location, sup.name AS supplier
               FROM product p
               LEFT JOIN location l ON l.id = p.location_id
               LEFT JOIN supplier sup ON sup.id = p.supplier_id
               WHERE p.id = ?""",
            (product_id,),
        ).fetchone()
        return dict(updated)
    finally:
        conn.close()


# ---------- suppliers ---------------------------------------------------------

@app.get("/api/suppliers")
def list_suppliers(include_inactive: bool = False, op=Depends(current_operator)):
    conn = connect()
    try:
        sql = "SELECT id, name, active FROM supplier"
        if not include_inactive:
            sql += " WHERE active = 1"
        sql += " ORDER BY name"
        rows = conn.execute(sql).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.post("/api/suppliers", status_code=201)
def create_supplier(body: SupplierIn, op=Depends(current_operator)):
    conn = connect()
    try:
        cur = conn.execute("INSERT INTO supplier (name) VALUES (?)", (body.name,))
        conn.commit()
        return {"id": cur.lastrowid, "name": body.name}
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That supplier is already in the list.")
    finally:
        conn.close()


# ---------- photos -----------------------------------------------------------

@app.post("/api/photos", status_code=201)
def upload_photo(body: PhotoIn, op=Depends(current_operator)):
    """Store an uploaded photo's bytes on disk, its metadata in the db.

    Kept out of stock.db itself — a year of daily photos as BLOBs would bloat
    the single database file and slow the nightly .backup cron job.
    """
    if not body.data_url.startswith("data:image/") or "," not in body.data_url:
        raise HTTPException(400, "That doesn't look like a photo.")
    header, _, encoded = body.data_url.partition(",")
    if not encoded:
        raise HTTPException(400, "That doesn't look like a photo.")
    mime_type = header[len("data:"):].split(";")[0]
    try:
        photo_bytes = base64.b64decode(encoded, validate=True)
    except Exception:
        raise HTTPException(400, "That doesn't look like a photo.")
    if not photo_bytes:
        raise HTTPException(400, "That doesn't look like a photo.")
    if len(photo_bytes) > 8 * 1024 * 1024:
        raise HTTPException(400, "That photo is too large. Try taking it again.")

    conn = connect()
    try:
        # Reserve the row first (to get an id), but hold off recording it as
        # committed until the bytes are actually on disk — a write failure
        # after the DB commit would otherwise leave a photo_id that
        # GET /api/photos/{id} can never serve.
        cur = conn.execute("INSERT INTO photo (mime_type) VALUES (?)", (mime_type,))
        photo_id = cur.lastrowid

        PHOTOS_DIR.mkdir(parents=True, exist_ok=True)
        (PHOTOS_DIR / f"{photo_id}.jpg").write_bytes(photo_bytes)

        conn.commit()
    finally:
        conn.close()

    return {"photo_id": photo_id}


@app.get("/api/photos/{photo_id}")
def get_photo(photo_id: int, op=Depends(current_operator)):
    conn = connect()
    try:
        row = conn.execute("SELECT 1 FROM photo WHERE id = ?", (photo_id,)).fetchone()
    finally:
        conn.close()
    if not row:
        raise HTTPException(404, "That photo no longer exists.")
    path = PHOTOS_DIR / f"{photo_id}.jpg"
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        raise HTTPException(404, "That photo no longer exists.")
    return Response(content=data, media_type="image/jpeg")


# ---------- receiving (the ledger) ------------------------------------------

@app.post("/api/receipts", status_code=201)
def receive_stock(body: ReceiptIn, op=Depends(current_operator)):
    conn = connect()
    try:
        _check_photo(conn, body.photo_id)
        # supplier_id, when given, is the source of truth for the name too —
        # keeps the legacy free-text column populated for every existing
        # reader (Log, /api/movements, old rows) without them needing to
        # know supplier_id exists at all.
        supplier_name = _get_supplier_name(conn, body.supplier_id) or _clean(body.supplier)

        # Resolve + validate every item up front, so a failure never leaves a
        # partial batch applied: nothing is inserted until every line checks
        # out — same "resolve everything before writing anything" pattern
        # used by /api/breakdowns and /api/stocktakes.
        resolved = []
        for item in body.items:
            product = conn.execute(
                "SELECT * FROM product WHERE id = ? AND active = 1", (item.product_id,)
            ).fetchone()
            if not product:
                raise HTTPException(404, "That product no longer exists.")
            _check_location(conn, item.location_id)
            resolved.append((item, product))

        results = []
        for item, product in resolved:
            # Needed (only if unit_cost is given) to weight the running
            # average below — must be read fresh on every iteration, not
            # taken from the `resolved` snapshot above, which was captured
            # before any of this request's writes. Reads see this same
            # connection's own earlier writes in this loop even before the
            # final commit, so a product appearing more than once in one
            # batch blends line 2 against what line 1 just wrote, not
            # against the value it had before the request started.
            old_on_hand_row = conn.execute(
                "SELECT on_hand FROM stock_on_hand WHERE product_id = ?", (product["id"],)
            ).fetchone()
            old_on_hand = old_on_hand_row["on_hand"] if old_on_hand_row else 0
            current_cost_row = conn.execute(
                "SELECT cost_price FROM product WHERE id = ?", (product["id"],)
            ).fetchone()
            current_cost_price = current_cost_row["cost_price"] if current_cost_row else None

            cur = conn.execute(
                """INSERT INTO movement
                   (product_id, direction, quantity, unit, location_id,
                    supplier, supplier_id, reference, note, operator_id, device, unit_cost, photo_id)
                   VALUES (?, 'IN', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (
                    product["id"],
                    item.quantity,
                    product["unit"],
                    item.location_id or product["location_id"],
                    supplier_name,
                    body.supplier_id,
                    _clean(body.reference),
                    _clean(body.note),
                    op["id"],
                    body.device,
                    item.unit_cost,
                    body.photo_id,
                ),
            )

            # Weighted-average cost: blended in only when this delivery's
            # cost is known. If it isn't, cost_price is left exactly as it was.
            new_cost_price = current_cost_price
            if item.unit_cost is not None:
                if current_cost_price is None:
                    new_cost_price = item.unit_cost
                else:
                    weight = old_on_hand if old_on_hand > 0 else 0
                    new_cost_price = (
                        weight * current_cost_price + item.quantity * item.unit_cost
                    ) / (weight + item.quantity)
                conn.execute(
                    "UPDATE product SET cost_price = ? WHERE id = ?", (new_cost_price, product["id"])
                )

            on_hand = conn.execute(
                "SELECT on_hand FROM stock_on_hand WHERE product_id = ?", (product["id"],)
            ).fetchone()
            results.append(
                {
                    "movement_id": cur.lastrowid,
                    "product": product["name"],
                    "quantity": item.quantity,
                    "unit": product["unit"],
                    "on_hand": on_hand["on_hand"] if on_hand else item.quantity,
                    "cost_price": new_cost_price,
                }
            )

        conn.commit()
        return {"items": results, "operator": op["name"]}
    finally:
        conn.close()


@app.post("/api/reversals", status_code=201)
def reverse_movement(body: ReversalIn, op=Depends(current_operator)):
    """Corrections never edit history — they post an opposing row."""
    conn = connect()
    try:
        # BEGIN IMMEDIATE takes SQLite's write lock right away, before the
        # "already reversed?" / "would this go negative?" checks below run —
        # without it, two simultaneous reversals of the same entry can both
        # read "not yet reversed" and both commit, double-reversing it. The
        # unique index on movement(reverses_id) is the backstop if that ever
        # regresses; this is what actually prevents it from being reached.
        conn.execute("BEGIN IMMEDIATE")
        orig = conn.execute(
            "SELECT * FROM movement WHERE id = ?", (body.movement_id,)
        ).fetchone()
        if not orig:
            raise HTTPException(404, "That entry could not be found.")
        if conn.execute(
            "SELECT id FROM movement WHERE reverses_id = ?", (body.movement_id,)
        ).fetchone():
            raise HTTPException(409, "That entry has already been reversed.")

        # A reversal's effect is the negation of whatever it targets resolved
        # to (movement_signed already computes that recursively). If stock
        # from this receipt has since been used elsewhere — a breakdown, say
        # — undoing it now can drive on-hand negative, which is never a real
        # physical state. Block that; a stock take is the right tool to
        # reconcile a count that's genuinely off, not reversing old history.
        target_signed = conn.execute(
            "SELECT signed_qty FROM movement_signed WHERE id = ?", (orig["id"],)
        ).fetchone()["signed_qty"]
        current_on_hand_row = conn.execute(
            "SELECT on_hand FROM stock_on_hand WHERE product_id = ?", (orig["product_id"],)
        ).fetchone()
        current_on_hand = current_on_hand_row["on_hand"] if current_on_hand_row else 0
        predicted_on_hand = current_on_hand - target_signed
        if predicted_on_hand < -1e-4:
            product = conn.execute(
                "SELECT name FROM product WHERE id = ?", (orig["product_id"],)
            ).fetchone()
            raise HTTPException(
                409,
                f"Can't reverse that — {product['name'] if product else 'this product'} only has "
                f"{current_on_hand:g} {orig['unit']} on hand, and some of what this entry added has "
                "already been used elsewhere. Use Stock take to correct the real count instead.",
            )

        try:
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
                    _clean(body.note),
                    op["id"],
                    orig["id"],
                ),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "That entry has already been reversed.")
        conn.commit()
        return {"movement_id": cur.lastrowid, "reverses": orig["id"]}
    finally:
        conn.close()


# ---------- dispatch (send stock out, printed as a pick list) ---------------
# A dispatch deducts stock immediately against the requested quantity — what
# it becomes afterward (breakdown, waste, whatever) isn't tracked. Each line
# keeps both requested_quantity and actual_quantity so "what did we plan to
# send vs what actually left" survives as visible history, not just a
# silently-overwritten number: /api/dispatches/{id}/items/{item_id}/actual
# corrects the latter (posting an adjusting movement for the difference)
# without touching the original requested figure.

@app.post("/api/dispatches", status_code=201)
def create_dispatch(body: DispatchIn, op=Depends(current_operator)):
    conn = connect()
    try:
        # BEGIN IMMEDIATE takes SQLite's write lock right away, before the
        # on-hand checks below run — without it, two simultaneous dispatches
        # of the same product can both read the same on-hand figure and both
        # pass the "enough stock?" check, jointly overdrawing it.
        conn.execute("BEGIN IMMEDIATE")

        # Resolve + validate every line up front, on-hand checks included, so
        # a failure never leaves a partial dispatch applied: nothing is
        # inserted until every line checks out. reserved tracks quantity
        # already claimed by an earlier line for the same product in this
        # same request, so the check is against combined demand, not each
        # line checked in isolation.
        reserved: dict = {}
        lines = []
        for line in body.items:
            p = conn.execute(
                "SELECT * FROM product WHERE id = ? AND active = 1", (line.product_id,)
            ).fetchone()
            if not p:
                raise HTTPException(404, "That product no longer exists.")

            on_hand_row = conn.execute(
                "SELECT on_hand FROM stock_on_hand WHERE product_id = ?", (p["id"],)
            ).fetchone()
            available = on_hand_row["on_hand"] if on_hand_row else 0
            already_reserved = reserved.get(p["id"], 0.0)
            if already_reserved + line.quantity > available + 1e-4:
                raise HTTPException(
                    409,
                    f"Only {available:g} {p['unit']} of {p['name']} is on hand — "
                    "receive it or count it in stock take before dispatching it.",
                )
            reserved[p["id"]] = already_reserved + line.quantity
            lines.append((line, p))

        batch = conn.execute(
            "INSERT INTO dispatch (note, operator_id) VALUES (?, ?)",
            (_clean(body.note), op["id"]),
        )
        dispatch_id = batch.lastrowid

        results = []
        for line, p in lines:
            conn.execute(
                """INSERT INTO movement
                   (product_id, direction, quantity, unit, location_id,
                    note, operator_id, dispatch_id)
                   VALUES (?, 'OUT', ?, ?, ?, ?, ?, ?)""",
                (
                    p["id"],
                    line.quantity,
                    p["unit"],
                    p["location_id"],
                    _clean(body.note),
                    op["id"],
                    dispatch_id,
                ),
            )
            item_cur = conn.execute(
                """INSERT INTO dispatch_item
                   (dispatch_id, product_id, location_id, unit,
                    requested_quantity, actual_quantity)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (dispatch_id, p["id"], p["location_id"], p["unit"], line.quantity, line.quantity),
            )
            on_hand = conn.execute(
                "SELECT on_hand FROM stock_on_hand WHERE product_id = ?", (p["id"],)
            ).fetchone()
            results.append(
                {
                    "item_id": item_cur.lastrowid,
                    "product_id": p["id"],
                    "product": p["name"],
                    "location": conn.execute(
                        "SELECT name FROM location WHERE id = ?", (p["location_id"],)
                    ).fetchone()["name"] if p["location_id"] else None,
                    "unit": p["unit"],
                    "requested_quantity": line.quantity,
                    "actual_quantity": line.quantity,
                    "on_hand": on_hand["on_hand"] if on_hand else 0,
                }
            )

        conn.commit()
        return {"dispatch_id": dispatch_id, "items": results, "operator": op["name"]}
    finally:
        conn.close()


@app.get("/api/dispatches")
def list_dispatches(limit: int = 50, op=Depends(current_operator)):
    conn = connect()
    try:
        rows = conn.execute(
            """SELECT d.id, d.note, d.created_at, o.name AS operator,
                      COUNT(di.id) AS item_count,
                      SUM(CASE WHEN di.actual_quantity != di.requested_quantity
                               THEN 1 ELSE 0 END) AS adjusted_count
               FROM dispatch d
               JOIN operator o ON o.id = d.operator_id
               LEFT JOIN dispatch_item di ON di.dispatch_id = d.id
               GROUP BY d.id
               ORDER BY d.id DESC LIMIT ?""",
            # See the matching comment on /api/movements — same reasoning.
            (max(1, min(limit, 5000)),),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.get("/api/dispatches/{dispatch_id}")
def get_dispatch(dispatch_id: int, op=Depends(current_operator)):
    conn = connect()
    try:
        dispatch = conn.execute(
            """SELECT d.id, d.note, d.created_at, o.name AS operator
               FROM dispatch d JOIN operator o ON o.id = d.operator_id
               WHERE d.id = ?""",
            (dispatch_id,),
        ).fetchone()
        if not dispatch:
            raise HTTPException(404, "That dispatch could not be found.")
        # Ordered by location then product so the frontend can render the
        # print-friendly pick list (grouped by freezer/cold room) straight
        # from this response with no client-side regrouping.
        items = conn.execute(
            """SELECT di.id, di.product_id, p.name AS product, di.unit,
                      di.requested_quantity, di.actual_quantity, di.updated_at,
                      l.name AS location
               FROM dispatch_item di
               JOIN product p ON p.id = di.product_id
               LEFT JOIN location l ON l.id = di.location_id
               WHERE di.dispatch_id = ?
               ORDER BY l.name, p.name""",
            (dispatch_id,),
        ).fetchall()
    finally:
        conn.close()
    return {**dict(dispatch), "items": [dict(r) for r in items]}


@app.post("/api/dispatches/{dispatch_id}/items/{item_id}/actual")
def set_dispatch_actual(
    dispatch_id: int, item_id: int, body: DispatchActualIn, op=Depends(current_operator)
):
    """Correct how much was actually taken for one dispatch line. Posts an
    adjusting movement for just the difference (OUT if more was actually
    taken than currently recorded, IN if less — crediting the rest back to
    the float) and updates actual_quantity, leaving requested_quantity
    exactly as it was so the comparison survives."""
    conn = connect()
    try:
        # Same reasoning as every other write here: read-then-write on
        # on-hand needs the write lock taken before the read, not after.
        conn.execute("BEGIN IMMEDIATE")
        item = conn.execute(
            "SELECT * FROM dispatch_item WHERE id = ? AND dispatch_id = ?",
            (item_id, dispatch_id),
        ).fetchone()
        if not item:
            raise HTTPException(404, "That dispatch line could not be found.")

        delta = round(body.actual_quantity - item["actual_quantity"], 6)
        if abs(delta) > 1e-9:
            if delta > 0:
                # More was actually taken than currently recorded — check
                # enough is still on hand to cover the extra amount.
                on_hand_row = conn.execute(
                    "SELECT on_hand FROM stock_on_hand WHERE product_id = ?",
                    (item["product_id"],),
                ).fetchone()
                available = on_hand_row["on_hand"] if on_hand_row else 0
                if delta > available + 1e-4:
                    product = conn.execute(
                        "SELECT name FROM product WHERE id = ?", (item["product_id"],)
                    ).fetchone()
                    raise HTTPException(
                        409,
                        f"Only {available:g} {item['unit']} of "
                        f"{product['name'] if product else 'this product'} is on hand — "
                        "can't record more than that as actually taken.",
                    )
            conn.execute(
                """INSERT INTO movement
                   (product_id, direction, quantity, unit, location_id,
                    operator_id, dispatch_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                (
                    item["product_id"],
                    "OUT" if delta > 0 else "IN",
                    abs(delta),
                    item["unit"],
                    item["location_id"],
                    op["id"],
                    dispatch_id,
                ),
            )
            conn.execute(
                "UPDATE dispatch_item SET actual_quantity = ?, updated_at = datetime('now') WHERE id = ?",
                (body.actual_quantity, item_id),
            )
        conn.commit()
        return {
            "item_id": item_id,
            "requested_quantity": item["requested_quantity"],
            "actual_quantity": body.actual_quantity,
        }
    finally:
        conn.close()


@app.post("/api/stocktakes", status_code=201)
def take_stock(body: StocktakeIn, op=Depends(current_operator)):
    """Reconcile the ledger to what's physically on the shelf.

    Each product counted gets one adjusting movement for the difference —
    nothing is edited or deleted, the count just becomes the next entry.
    A brand-new product's very first count is simply its opening balance.
    """
    conn = connect()
    try:
        # Same reasoning as /api/breakdowns and /api/reversals: this reads
        # on-hand, computes an adjustment from it, then writes — two
        # simultaneous counts of the same product would otherwise both base
        # their adjustment on the same stale on-hand figure and double it.
        conn.execute("BEGIN IMMEDIATE")
        for line in body.counts:
            if not conn.execute(
                "SELECT 1 FROM product WHERE id = ? AND active = 1", (line.product_id,)
            ).fetchone():
                raise HTTPException(404, "One of those products no longer exists.")

        batch = conn.execute(
            "INSERT INTO stocktake (note, operator_id) VALUES (?, ?)",
            (_clean(body.note), op["id"]),
        )
        stocktake_id = batch.lastrowid

        results = []
        for line in body.counts:
            p = conn.execute("SELECT * FROM product WHERE id = ?", (line.product_id,)).fetchone()
            current = conn.execute(
                "SELECT on_hand FROM stock_on_hand WHERE product_id = ?", (p["id"],)
            ).fetchone()
            was = current["on_hand"] if current else 0
            diff = round(line.counted_quantity - was, 6)

            if abs(diff) > 1e-9:
                conn.execute(
                    """INSERT INTO movement
                       (product_id, direction, quantity, unit, location_id,
                        note, operator_id, stocktake_id)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        p["id"],
                        "IN" if diff > 0 else "OUT",
                        abs(diff),
                        p["unit"],
                        p["location_id"],
                        _clean(body.note),
                        op["id"],
                        stocktake_id,
                    ),
                )
            results.append(
                {
                    "product": p["name"],
                    "counted": line.counted_quantity,
                    "was": was,
                    "adjustment": diff,
                    "unit": p["unit"],
                }
            )

        conn.commit()
        return {"stocktake_id": stocktake_id, "results": results, "operator": op["name"]}
    finally:
        conn.close()


# ---------- shelf float (independent of the ledger) -------------------------
# Packed items kept in the freezer overnight to restock shelves each morning
# (e.g. "Beef stew, 69-size tray"). Entirely disconnected from
# product/movement/stock_on_hand — counting here never touches the real
# ledger. Each morning's count is its own fresh snapshot, so "the float
# resets to zero every morning" needs no reset logic at all: yesterday's
# numbers simply become history the moment today's count is submitted.

@app.get("/api/float-products")
def list_float_products(op=Depends(current_operator)):
    conn = connect()
    try:
        # Ordered by location then name so the picker/print sheet can group
        # by location straight off this response, same as products already
        # do for the real locations.
        rows = conn.execute(
            """SELECT id, name, location, target_quantity, units_per_crate FROM float_product
               WHERE active = 1 ORDER BY location, name"""
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.post("/api/float-products", status_code=201)
def create_float_product(body: FloatProductIn, op=Depends(current_operator)):
    conn = connect()
    try:
        cur = conn.execute(
            "INSERT INTO float_product (name, location, target_quantity, units_per_crate) VALUES (?, ?, ?, ?)",
            (body.name.strip(), body.location, body.target_quantity, body.units_per_crate),
        )
        conn.commit()
        return {
            "id": cur.lastrowid,
            "name": body.name.strip(),
            "location": body.location,
            "target_quantity": body.target_quantity,
            "units_per_crate": body.units_per_crate,
        }
    except sqlite3.IntegrityError:
        raise HTTPException(409, f"A float item called {body.name} already exists.")
    finally:
        conn.close()


@app.post("/api/float-products/{float_product_id}/target")
def set_float_target(float_product_id: int, body: FloatTargetIn, op=Depends(current_operator)):
    """The par level a manager wants staff packing toward — set by hand,
    never derived from anything, and can be cleared back to "no target" by
    passing null."""
    conn = connect()
    try:
        product = conn.execute(
            "SELECT id FROM float_product WHERE id = ? AND active = 1", (float_product_id,)
        ).fetchone()
        if not product:
            raise HTTPException(404, "That float item no longer exists.")
        conn.execute(
            "UPDATE float_product SET target_quantity = ? WHERE id = ?",
            (body.target_quantity, float_product_id),
        )
        conn.commit()
        return {"id": float_product_id, "target_quantity": body.target_quantity}
    finally:
        conn.close()


@app.post("/api/float-products/{float_product_id}/units-per-crate")
def set_float_units_per_crate(
    float_product_id: int, body: FloatUnitsPerCrateIn, op=Depends(current_operator)
):
    """How many individual pieces one crate of this item holds — set by
    hand, used only to translate a crate count into a piece count on the
    review screen and printouts. Never affects how counting or targets
    work; those always stay in crates. Cleared back to "not set" by
    passing null."""
    conn = connect()
    try:
        product = conn.execute(
            "SELECT id FROM float_product WHERE id = ? AND active = 1", (float_product_id,)
        ).fetchone()
        if not product:
            raise HTTPException(404, "That float item no longer exists.")
        conn.execute(
            "UPDATE float_product SET units_per_crate = ? WHERE id = ?",
            (body.units_per_crate, float_product_id),
        )
        conn.commit()
        return {"id": float_product_id, "units_per_crate": body.units_per_crate}
    finally:
        conn.close()


def _float_count_response(conn: sqlite3.Connection, count_row: sqlite3.Row) -> dict:
    """Shared shape for a float count's detail. Joins in each float
    product's CURRENT target rather than one frozen at count time — a
    manager changing a target should immediately change the shown shortfall
    for every count, past or present; this isn't a financial ledger that
    needs a frozen-at-the-time record, just a live par-level comparison."""
    items = conn.execute(
        """SELECT fci.id, fci.float_product_id, fp.name AS product, fp.location,
                  fci.counted_quantity, fp.target_quantity, fp.units_per_crate
           FROM float_count_item fci
           JOIN float_product fp ON fp.id = fci.float_product_id
           WHERE fci.float_count_id = ?
           ORDER BY fp.location, fp.name""",
        (count_row["id"],),
    ).fetchall()
    result_items = []
    for it in items:
        row = dict(it)
        row["shortfall"] = (
            max(0.0, row["target_quantity"] - row["counted_quantity"])
            if row["target_quantity"] is not None
            else None
        )
        # Pure display conversions from crates to individual pieces — never
        # fed back into counting or targets, which always stay in crates.
        row["counted_items"] = (
            row["counted_quantity"] * row["units_per_crate"]
            if row["units_per_crate"] is not None
            else None
        )
        row["shortfall_items"] = (
            row["shortfall"] * row["units_per_crate"]
            if row["shortfall"] is not None and row["units_per_crate"] is not None
            else None
        )
        result_items.append(row)
    return {
        "id": count_row["id"],
        "created_at": count_row["created_at"],
        "operator": count_row["operator"],
        "items": result_items,
    }


@app.post("/api/float-counts", status_code=201)
def create_float_count(body: FloatCountIn, op=Depends(current_operator)):
    conn = connect()
    try:
        for line in body.counts:
            if not conn.execute(
                "SELECT 1 FROM float_product WHERE id = ? AND active = 1", (line.float_product_id,)
            ).fetchone():
                raise HTTPException(404, "One of those float items no longer exists.")

        batch = conn.execute("INSERT INTO float_count (operator_id) VALUES (?)", (op["id"],))
        float_count_id = batch.lastrowid
        for line in body.counts:
            conn.execute(
                """INSERT INTO float_count_item (float_count_id, float_product_id, counted_quantity)
                   VALUES (?, ?, ?)""",
                (float_count_id, line.float_product_id, line.counted_quantity),
            )
        conn.commit()

        count_row = conn.execute(
            """SELECT fc.id, fc.created_at, o.name AS operator
               FROM float_count fc JOIN operator o ON o.id = fc.operator_id
               WHERE fc.id = ?""",
            (float_count_id,),
        ).fetchone()
        return _float_count_response(conn, count_row)
    finally:
        conn.close()


@app.get("/api/float-counts")
def list_float_counts(limit: int = 30, op=Depends(current_operator)):
    conn = connect()
    try:
        rows = conn.execute(
            """SELECT fc.id, fc.created_at, o.name AS operator,
                      COUNT(fci.id) AS item_count
               FROM float_count fc
               JOIN operator o ON o.id = fc.operator_id
               LEFT JOIN float_count_item fci ON fci.float_count_id = fc.id
               GROUP BY fc.id
               ORDER BY fc.id DESC LIMIT ?""",
            (max(1, min(limit, 200)),),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.get("/api/float-counts/latest")
def latest_float_count(op=Depends(current_operator)):
    """The morning's count, for the review/print-a-pack-list screen. Null
    (not a 404) when nobody has counted yet today — this is a normal state,
    not an error.

    "Today" is judged in SAST (UTC+2, no DST) since that's this shop's local
    day, not the UTC day `datetime('now')` stores timestamps in — without
    the shift, a count made shortly after local midnight would still read
    as "yesterday" for hours, which is exactly the early-morning window
    float counting actually happens in."""
    conn = connect()
    try:
        count_row = conn.execute(
            """SELECT fc.id, fc.created_at, o.name AS operator
               FROM float_count fc JOIN operator o ON o.id = fc.operator_id
               WHERE date(fc.created_at, '+2 hours') = date('now', '+2 hours')
               ORDER BY fc.id DESC LIMIT 1"""
        ).fetchone()
        if not count_row:
            return None
        return _float_count_response(conn, count_row)
    finally:
        conn.close()


@app.get("/api/float-counts/{float_count_id}")
def get_float_count(float_count_id: int, op=Depends(current_operator)):
    conn = connect()
    try:
        count_row = conn.execute(
            """SELECT fc.id, fc.created_at, o.name AS operator
               FROM float_count fc JOIN operator o ON o.id = fc.operator_id
               WHERE fc.id = ?""",
            (float_count_id,),
        ).fetchone()
        if not count_row:
            raise HTTPException(404, "That count could not be found.")
        return _float_count_response(conn, count_row)
    finally:
        conn.close()


# ---------- reporting --------------------------------------------------------

@app.get("/api/stock")
def stock(op=Depends(current_operator)):
    conn = connect()
    try:
        # stock_on_hand itself is left untouched (its on-hand math doesn't
        # need kind/cost_price) — join product just for those extra columns.
        rows = conn.execute(
            """SELECT s.*, p.kind AS kind, p.cost_price AS cost_price
               FROM stock_on_hand s
               JOIN product p ON p.id = s.product_id
               ORDER BY s.name"""
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.get("/api/movements")
def movements(limit: int = 50, op=Depends(current_operator)):
    conn = connect()
    try:
        rows = conn.execute(
            """SELECT m.id, m.direction, m.quantity, m.unit, m.supplier,
                      m.reference, m.note, m.created_at, m.reverses_id,
                      m.breakdown_id, m.stocktake_id, m.dispatch_id, m.photo_id,
                      p.name AS product, o.name AS operator, l.name AS location,
                      (SELECT COUNT(*) FROM movement r WHERE r.reverses_id = m.id) AS reversed
               FROM movement m
               JOIN product  p ON p.id = m.product_id
               JOIN operator o ON o.id = m.operator_id
               LEFT JOIN location l ON l.id = m.location_id
               ORDER BY m.id DESC LIMIT ?""",
            # The default (50) is for callers that just want a quick recent
            # look; the Log screen asks for more and pages further back via
            # "Load more" — 5000 is comfortably beyond what this system will
            # accumulate for a very long time, not a real ceiling on history.
            (max(1, min(limit, 5000)),),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


@app.get("/api/analytics/summary")
def analytics_summary(op=Depends(current_operator)):
    conn = connect()
    try:
        # Inventory value + priced/unpriced counts: one pass over on-hand for
        # every active product. A product with no cost_price yet is skipped
        # from the value sum entirely — not treated as worth 0 — since a
        # missing cost is "unknown", not "free".
        stock_rows = conn.execute(
            """SELECT s.name, s.unit, s.on_hand, p.cost_price
               FROM stock_on_hand s
               JOIN product p ON p.id = s.product_id"""
        ).fetchall()

        inventory_value = 0.0
        priced_products = 0
        unpriced_products = 0
        valued_products = []
        for r in stock_rows:
            if r["cost_price"] is None:
                unpriced_products += 1
                continue
            priced_products += 1
            value = r["on_hand"] * r["cost_price"]
            inventory_value += value
            if r["on_hand"] > 0:
                valued_products.append(
                    {
                        "product": r["name"],
                        "unit": r["unit"],
                        "on_hand": r["on_hand"],
                        "cost_price": r["cost_price"],
                        "value": round(value, 2),
                    }
                )
        valued_products.sort(key=lambda v: v["value"], reverse=True)
        top_value_products = valued_products[:10]

        # Top suppliers by total value received. A receipt with no unit_cost
        # captured still counts toward receipt_count (it happened) but adds
        # nothing to total_value (its cost simply isn't known).
        #
        # Grouped by supplier_id where a receipt has one — stable even if the
        # supplier is later renamed, unlike grouping by the free-text column,
        # which would split "Beefcor" from a later-corrected "Beefcor Ltd".
        # Receipts from before the supplier table existed have no
        # supplier_id, so they fall back to grouping by their own text.
        supplier_rows = conn.execute(
            """SELECT
                      COALESCE(MAX(sup.name), MAX(m.supplier)) AS supplier,
                      COUNT(*) AS receipt_count,
                      SUM(m.quantity * IFNULL(m.unit_cost, 0)) AS total_value
               FROM movement m
               LEFT JOIN supplier sup ON sup.id = m.supplier_id
               WHERE m.direction = 'IN' AND (m.supplier_id IS NOT NULL OR m.supplier IS NOT NULL)
               GROUP BY m.supplier_id, CASE WHEN m.supplier_id IS NULL THEN m.supplier END
               ORDER BY total_value DESC
               LIMIT 10"""
        ).fetchall()
        top_suppliers = [
            {
                "supplier": r["supplier"],
                "receipt_count": r["receipt_count"],
                "total_value": round(r["total_value"] or 0.0, 2),
            }
            for r in supplier_rows
        ]

        receipts_last_30_days = conn.execute(
            """SELECT COUNT(*) AS n FROM movement
               WHERE direction = 'IN' AND stocktake_id IS NULL AND dispatch_id IS NULL
                 AND created_at >= datetime('now', '-30 days')"""
        ).fetchone()["n"]

        dispatches_last_30_days = conn.execute(
            """SELECT COUNT(*) AS n FROM dispatch
               WHERE created_at >= datetime('now', '-30 days')"""
        ).fetchone()["n"]

        stocktakes_last_30_days = conn.execute(
            """SELECT COUNT(*) AS n FROM stocktake
               WHERE created_at >= datetime('now', '-30 days')"""
        ).fetchone()["n"]

        return {
            "inventory_value": round(inventory_value, 2),
            "priced_products": priced_products,
            "unpriced_products": unpriced_products,
            "top_value_products": top_value_products,
            "top_suppliers": top_suppliers,
            "receipts_last_30_days": receipts_last_30_days,
            "dispatches_last_30_days": dispatches_last_30_days,
            "stocktakes_last_30_days": stocktakes_last_30_days,
        }
    finally:
        conn.close()


# ---------- accounting integrations -------------------------------------------
# Connect this site to Xero and/or Sage so a business can push what it
# receives out as bills in whichever accounting system it already uses.
# Client ID/Secret are configured as environment variables by whoever runs
# the server, never entered through the app itself — until a provider has
# both set, its "Connect" action is refused with a clear explanation rather
# than attempting a doomed OAuth round-trip.

@app.get("/api/integrations")
def list_integrations(op=Depends(current_operator)):
    conn = connect()
    try:
        rows = {
            r["provider"]: r
            for r in conn.execute(
                "SELECT provider, status, tenant_name, connected_at FROM integration"
            ).fetchall()
        }
    finally:
        conn.close()
    result = []
    for provider, cfg in INTEGRATION_PROVIDERS.items():
        row = rows.get(provider)
        result.append(
            {
                "provider": provider,
                "label": cfg["label"],
                "configured": bool(cfg["client_id"] and cfg["client_secret"]),
                "connected": bool(row and row["status"] == "connected"),
                "tenant_name": row["tenant_name"] if row else None,
                "connected_at": row["connected_at"] if row else None,
            }
        )
    return result


@app.post("/api/integrations/{provider}/connect")
def start_integration_connect(provider: str, op=Depends(current_operator)):
    if provider not in INTEGRATION_PROVIDERS:
        raise HTTPException(404, "That isn't a known integration.")
    cfg = INTEGRATION_PROVIDERS[provider]
    if not (cfg["client_id"] and cfg["client_secret"]):
        raise HTTPException(
            409,
            f"{cfg['label']} isn't set up on this server yet — it needs a Client ID "
            "and Secret from its developer portal first.",
        )
    if not PUBLIC_BASE_URL:
        raise HTTPException(409, "This site's public address isn't configured yet.")

    # A fresh random token per attempt, checked again when the provider
    # redirects back — the only thing standing between that callback and
    # someone else's authorization code being swapped in for ours.
    state = secrets.token_urlsafe(24)
    conn = connect()
    try:
        conn.execute(
            "UPDATE integration SET pending_state = ?, updated_at = datetime('now') WHERE provider = ?",
            (state, provider),
        )
        conn.commit()
    finally:
        conn.close()

    redirect_uri = f"{PUBLIC_BASE_URL}/api/integrations/{provider}/callback"
    params = {
        "response_type": "code",
        "client_id": cfg["client_id"],
        "redirect_uri": redirect_uri,
        "scope": cfg["scope"],
        "state": state,
    }
    return {"authorize_url": f"{cfg['authorize_url']}?{urlencode(params)}"}


@app.get("/api/integrations/{provider}/callback")
def integration_callback(provider: str, code: str = "", state: str = "", error: str = ""):
    # The provider lands the browser here directly (a plain top-level
    # redirect from xero.com/sage.com), so this can't require our own PIN
    # header the way every other write in this app does — the pending_state
    # check above is what stands in for that here.
    home = PUBLIC_BASE_URL or ""

    def landing(status: str, reason: Optional[str] = None) -> RedirectResponse:
        q = {"integration": provider, "status": status}
        if reason:
            q["reason"] = reason
        return RedirectResponse(f"{home}/?{urlencode(q)}")

    if provider not in INTEGRATION_PROVIDERS:
        return landing("error", "unknown_provider")
    if error:
        return landing("error", error)
    if not code or not state:
        return landing("error", "missing_code")

    cfg = INTEGRATION_PROVIDERS[provider]
    conn = connect()
    try:
        row = conn.execute(
            "SELECT * FROM integration WHERE provider = ?", (provider,)
        ).fetchone()
        if not row or not row["pending_state"] or row["pending_state"] != state:
            return landing("error", "invalid_state")

        redirect_uri = f"{PUBLIC_BASE_URL}/api/integrations/{provider}/callback"
        try:
            resp = http.post(
                cfg["token_url"],
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                },
                auth=(cfg["client_id"], cfg["client_secret"]),
                timeout=15,
            )
        except http.RequestException:
            return landing("error", "token_request_failed")
        if resp.status_code != 200:
            return landing("error", "token_exchange_failed")
        tokens = resp.json()

        tenant_id = None
        tenant_name = None
        if provider == "xero" and tokens.get("access_token"):
            # Xero is multi-tenant: the token alone doesn't say which
            # organisation was authorized, so ask.
            try:
                conns = http.get(
                    "https://api.xero.com/connections",
                    headers={"Authorization": f"Bearer {tokens['access_token']}"},
                    timeout=15,
                )
                if conns.status_code == 200 and conns.json():
                    first = conns.json()[0]
                    tenant_id = first.get("tenantId")
                    tenant_name = first.get("tenantName")
            except http.RequestException:
                pass  # connected, just without a display name yet — not fatal

        expires_at = None
        if tokens.get("expires_in"):
            expires_at = (
                datetime.now(timezone.utc) + timedelta(seconds=int(tokens["expires_in"]))
            ).isoformat()

        conn.execute(
            """UPDATE integration SET
                 status = 'connected', pending_state = NULL,
                 access_token = ?, refresh_token = ?, token_expires_at = ?,
                 tenant_id = ?, tenant_name = ?,
                 connected_at = datetime('now'), updated_at = datetime('now')
               WHERE provider = ?""",
            (
                tokens.get("access_token"),
                tokens.get("refresh_token"),
                expires_at,
                tenant_id,
                tenant_name,
                provider,
            ),
        )
        conn.commit()
    finally:
        conn.close()

    return landing("connected")


@app.post("/api/integrations/{provider}/disconnect")
def disconnect_integration(provider: str, op=Depends(current_operator)):
    if provider not in INTEGRATION_PROVIDERS:
        raise HTTPException(404, "That isn't a known integration.")
    conn = connect()
    try:
        conn.execute(
            """UPDATE integration SET
                 status = 'disconnected', pending_state = NULL,
                 access_token = NULL, refresh_token = NULL, token_expires_at = NULL,
                 tenant_id = NULL, tenant_name = NULL,
                 updated_at = datetime('now')
               WHERE provider = ?""",
            (provider,),
        )
        conn.commit()
    finally:
        conn.close()
    return {"provider": provider, "connected": False}


# ---------- static frontend --------------------------------------------------

@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")
