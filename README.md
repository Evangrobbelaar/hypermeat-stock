# Hyper Meat — Stock Control

Tablet-first goods-received portal for Hyper Meat Randfontein. Runs alongside
ClockPay on the same VPS, on its own port, with its own database.

**Phase 1 (this repo):** create products, capture what was received, see stock on hand.
**Phase 2 (next):** import the weekly sales export and reconcile it against receipts by till code.

## What it does now

- **PIN sign-in.** The tablet is shared, so a 4-digit PIN identifies who captured each delivery. Seeded PINs: `1111` (Receiving 1), `9999` (Supervisor). Change these before go-live.
- **Products.** Title, unit of measure (kg / ea / box / crate / pack / l), storage location, and an optional till code. The till code is what phase 2 will match sales against, so capture it now where you know it.
- **Receiving.** Pick a product, punch the quantity on a scale-style keypad, add supplier and delivery note number, accept. That writes one ledger row.
- **Stock on hand.** A live sum per product.
- **Log.** Every entry, with who captured it and when.

## The ledger

`movement` is append-only. Nothing is edited or deleted. A mistake is corrected by
posting a `REVERSAL` row that points back at the original, and both stay visible in
the log. On-hand is always `SUM(signed_qty)` — it can be recomputed from scratch at
any time, and there is a defensible record of who accepted what.

## Deploy on the VPS

The repo is private, so the first clone needs your GitHub token:

```bash
git clone https://Evangrobbelaar:YOUR_PAT@github.com/Evangrobbelaar/hypermeat-stock.git /opt/hypermeat-stock
cd /opt/hypermeat-stock && bash deploy.sh
```

`deploy.sh` builds the image, starts the container, waits for the health check to
pass, runs a smoke test and prints the tablet URL. To update later, just
`cd /opt/hypermeat-stock && bash deploy.sh` again — it pulls and redeploys.

Serves on port **8100**. Check it: `curl localhost:8100/healthz`

The SQLite database lives in the `stock-data` volume at `/data/stock.db`.

Back it up with:

```bash
docker exec hypermeat-stock sqlite3 /data/stock.db ".backup /data/backup.db"
```

### Run without Docker

```bash
pip install -r requirements.txt
STOCK_DB_PATH=./stock.db uvicorn app.main:app --host 0.0.0.0 --port 8100
```

### Before the tablets go on the floor

- [ ] Replace the seeded PINs with the real receiving staff
- [ ] Put it behind HTTPS (Caddy or nginx) — PINs travel in a header
- [ ] Set the real storage locations (freezers, chillers, dry store)
- [ ] Add the products with their till codes

## API

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/login` | `{pin}` → operator |
| GET | `/api/products?q=` | search by name or code |
| POST | `/api/products` | `{name, unit, location_id, code}` |
| GET | `/api/locations` | |
| POST | `/api/locations` | `{name, kind}` |
| POST | `/api/receipts` | `{product_id, quantity, location_id, supplier, reference, note}` |
| POST | `/api/reversals` | `{movement_id, note}` |
| GET | `/api/stock` | on hand per product |
| GET | `/api/movements?limit=` | ledger, newest first |

All write endpoints need the `X-Operator-Pin` header.

## Phase 2 sketch

Add a `sales_import` table and a `sale` line table keyed on till code, then compare
received quantity against sold quantity per product per week. Products already carry
`code`, and every receipt is already dated and attributed, so the reconciliation is a
join rather than a rebuild.
