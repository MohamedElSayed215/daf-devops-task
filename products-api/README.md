# products-api

A tiny **FastAPI** service that manages products for the Shop backend. It owns
the `products` table in the shared `shop` PostgreSQL database and exposes health,
readiness, and Prometheus metrics endpoints for operating it in Kubernetes.

- Language / stack: **Python 3.12 + FastAPI + uvicorn + psycopg + prometheus-client**
- Listens on **port 8000** (override with `PORT`)

## Endpoints

| Method | Path             | Description                                                        |
|--------|------------------|--------------------------------------------------------------------|
| GET    | `/health`        | Liveness. Always `200 {"status":"ok"}` (no DB access).             |
| GET    | `/ready`         | Readiness. `200 {"status":"ready"}` if `SELECT 1` works, else `503`.|
| GET    | `/metrics`       | Prometheus text exposition (default metrics + HTTP counters/latency).|
| GET    | `/products`      | `200` list of all products.                                        |
| GET    | `/products/{id}` | `200` a single product, `404` if it does not exist.                |
| POST   | `/products`      | Create a product. Body `{"name": str, "price_cents": int}` → `201`.|

### `products` table

Created automatically on startup if missing:

```sql
CREATE TABLE IF NOT EXISTS products (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    price_cents integer NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
```

### Metrics

In addition to the default `prometheus-client` process/GC metrics, the service
exports:

- `http_requests_total{method,path,status}` — request counter.
- `http_request_duration_seconds{method,path}` — request latency histogram.

The `path` label uses the matched route template (e.g. `/products/{product_id}`)
to keep cardinality bounded.

## Environment variables

| Variable      | Default     | Description                     |
|---------------|-------------|---------------------------------|
| `DB_HOST`     | `localhost` | PostgreSQL host.                |
| `DB_PORT`     | `5432`      | PostgreSQL port.                |
| `DB_NAME`     | `shop`      | Database name.                  |
| `DB_USER`     | `shop`      | Database user.                  |
| `DB_PASSWORD` | `shop`      | Database password.              |
| `PORT`        | `8000`      | HTTP port the server binds to.  |

## Run locally

### With docker-compose (recommended)

From `apps/`:

```bash
docker compose up --build
```

This starts PostgreSQL, products-api (on `:8000`), and orders-api.

### Directly (Python)

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

export DB_HOST=localhost DB_PORT=5432 DB_NAME=shop DB_USER=shop DB_PASSWORD=shop
uvicorn app.main:app --host 0.0.0.0 --port 8000
```

### With Docker

```bash
docker build -t products-api:0.1.0 .
docker run --rm -p 8000:8000 \
  -e DB_HOST=host.docker.internal -e DB_NAME=shop \
  -e DB_USER=shop -e DB_PASSWORD=shop \
  products-api:0.1.0
```

## curl examples

```bash
# Liveness
curl -s http://localhost:8000/health
# {"status":"ok"}

# Readiness
curl -s -i http://localhost:8000/ready
# 200 {"status":"ready"}  (or 503 if the DB is down)

# Create a product
curl -s -X POST http://localhost:8000/products \
  -H 'Content-Type: application/json' \
  -d '{"name":"Widget","price_cents":1999}'
# {"id":1,"name":"Widget","price_cents":1999,"created_at":"..."}

# List products
curl -s http://localhost:8000/products

# Get one product
curl -s http://localhost:8000/products/1

# Missing product -> 404
curl -s -i http://localhost:8000/products/999999

# Metrics
curl -s http://localhost:8000/metrics | head -n 20
```
