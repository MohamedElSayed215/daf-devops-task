# orders-api

Node 20 + Express service for the **Shop** backend. Stores orders in PostgreSQL
and validates each order against the downstream **products-api** before writing it.

## Endpoints

| Method | Path            | Description |
|--------|-----------------|-------------|
| GET    | `/health`       | Liveness. Always `200 {"status":"ok"}` — process check only, no DB access, no downstream call. |
| GET    | `/ready`        | Readiness. `200 {"status":"ready"}` **iff** this service's OWN Postgres is reachable (`SELECT 1`), else `503`. It does **not** probe products-api. |
| GET    | `/metrics`      | Prometheus text: default Node metrics + `http_requests_total{method,path,status}` + `http_request_duration_seconds` histogram + `products_api_up` gauge. |
| GET    | `/orders`       | `200` list of orders. Works even when products-api is down. |
| POST   | `/orders`       | Body `{"product_id":int,"quantity":int}`. Calls products-api `GET /products/{id}` to validate the product. `201` with the created row on success; `404` if the product is unknown; `400` on invalid body; a controlled `503` (with a `Retry-After` header) if products-api is unavailable. |

### Readiness vs liveness (the deliberate design)

This service depends on a downstream (products-api), but that dependency is
**not** wired into readiness. The split is intentional:

- **Liveness (`/health`)** — process only. If the event loop is running, it
  returns `200`. Nothing about the DB or the downstream can flip it.
- **Readiness (`/ready`)** — this service's OWN dependency (its Postgres) only.
  It returns `200` iff `SELECT 1` succeeds, and `503` otherwise. It does **not**
  call products-api.

Readiness must reflect only what *this* pod owns, because Kubernetes pulls a pod
out of the Service endpoints when it goes not-ready. If readiness probed
products-api, then a products-api outage would mark **every** orders-api pod
not-ready at once — removing them all from the Service and taking down endpoints
that don't even need the downstream (`GET /orders`, `/health`). That is a
cascading failure: a single downstream blip amplifies into a full orders-api
outage. Keeping readiness scoped to the pod's own Postgres avoids it.

### Downstream health as a metric, not a probe

products-api availability is surfaced as a gauge instead of a probe:

- **`products_api_up`** — `1` when products-api is reachable, `0` when it is not.
- It is refreshed by a **background probe every 15 seconds** and re-evaluated on
  **each `POST /orders`** (so the signal is fresh at the moment it matters).

This lets dashboards and alerts track downstream health without coupling it to
orders-api readiness.

### Behaviour when products-api is unavailable

- **`POST /orders`** returns a controlled `503` with a `Retry-After` header
  (it cannot validate the product, so it declines the write) and sets
  `products_api_up` to `0`.
- **`GET /orders`, `GET /health`, `GET /ready`** keep working normally — none of
  them need products-api, so a downstream outage never affects them.

## Environment variables

| Var               | Default                     | Description |
|-------------------|-----------------------------|-------------|
| `DB_HOST`         | `localhost`                 | Postgres host. |
| `DB_PORT`         | `5432`                      | Postgres port. |
| `DB_NAME`         | `shop`                      | Database name. |
| `DB_USER`         | `shop`                      | Database user. |
| `DB_PASSWORD`     | `shop`                      | Database password. |
| `PORT`            | `3000`                      | HTTP listen port. |
| `PRODUCTS_API_URL`| `http://products-api:8000`  | Base URL of the products-api service. |

The `orders` table is created on startup if it does not exist:

```sql
orders(id serial primary key,
       product_id integer not null,
       quantity integer not null,
       created_at timestamptz not null default now())
```

## Run locally

From the repo `apps/` directory the whole system comes up with Docker Compose:

```bash
docker compose up
```

Or run just this service (needs a reachable Postgres and products-api):

```bash
npm install
DB_HOST=localhost DB_NAME=shop DB_USER=shop DB_PASSWORD=shop \
  PRODUCTS_API_URL=http://localhost:8000 npm start
```

## curl examples

```bash
# liveness (process only) / readiness (own Postgres only)
curl -s localhost:3000/health
curl -s localhost:3000/ready

# metrics (includes the products_api_up gauge)
curl -s localhost:3000/metrics | grep products_api_up

# create an order (products-api validates that product_id exists) -> 201
curl -s -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"product_id":1,"quantity":3}'

# unknown product -> 404
curl -s -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"product_id":999999,"quantity":1}'

# if products-api is down, POST /orders returns a controlled 503 + Retry-After
curl -s -D - -o /dev/null -X POST localhost:3000/orders \
  -H 'content-type: application/json' \
  -d '{"product_id":1,"quantity":1}'

# list orders (keeps working even when products-api is down)
curl -s localhost:3000/orders
```

## Test

```bash
npm test
```

Tests mock the database layer and `fetch`, so no live Postgres or products-api
is required to run them.
