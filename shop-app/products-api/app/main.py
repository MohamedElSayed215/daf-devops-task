"""products-api — a tiny FastAPI service for the Shop backend.

Endpoints:
  GET  /health          liveness (no DB)
  GET  /ready           readiness (SELECT 1)
  GET  /metrics         Prometheus text
  GET  /products        list products
  GET  /products/{id}   one product (404 if missing)
  POST /products        create a product
"""

import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from prometheus_client import (
    CONTENT_TYPE_LATEST,
    Counter,
    Histogram,
    generate_latest,
)

from . import db


# ---------------------------------------------------------------------------
# Prometheus metrics
# ---------------------------------------------------------------------------
HTTP_REQUESTS_TOTAL = Counter(
    "http_requests_total",
    "Total HTTP requests.",
    ["method", "path", "status"],
)

HTTP_REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency in seconds.",
    ["method", "path"],
)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------
class ProductIn(BaseModel):
    name: str = Field(..., min_length=1)
    price_cents: int = Field(..., ge=0)


# ---------------------------------------------------------------------------
# Lifespan: open pool + create table on startup, close pool on shutdown
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    db.open_pool()
    db.create_table_if_missing()
    try:
        yield
    finally:
        db.close_pool()


app = FastAPI(title="products-api", version="0.1.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Metrics middleware
# ---------------------------------------------------------------------------
def _route_template(request: Request) -> str:
    """Return the matched route template (e.g. /products/{id}) so metric
    cardinality stays bounded, falling back to the raw path."""
    route = request.scope.get("route")
    if route is not None and getattr(route, "path", None):
        return route.path
    return request.url.path


@app.middleware("http")
async def prometheus_middleware(request: Request, call_next):
    start = time.perf_counter()
    try:
        response = await call_next(request)
        status = response.status_code
    except Exception:
        status = 500
        raise
    finally:
        path = _route_template(request)
        # Do not record the /metrics scrape itself against latency buckets in a
        # way that pollutes app metrics; still count it for completeness.
        elapsed = time.perf_counter() - start
        HTTP_REQUEST_LATENCY.labels(request.method, path).observe(elapsed)
        HTTP_REQUESTS_TOTAL.labels(request.method, path, str(status)).inc()
    return response


# ---------------------------------------------------------------------------
# Health / readiness / metrics
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/ready")
def ready():
    if db.check_db():
        return {"status": "ready"}
    return JSONResponse(status_code=503, content={"status": "not-ready"})


@app.get("/metrics")
def metrics():
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


# ---------------------------------------------------------------------------
# Products
# ---------------------------------------------------------------------------
@app.get("/products")
def list_products():
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, price_cents, created_at "
                "FROM products ORDER BY id"
            )
            rows = cur.fetchall()
    return rows


@app.get("/products/{product_id}")
def get_product(product_id: int):
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id, name, price_cents, created_at "
                "FROM products WHERE id = %s",
                (product_id,),
            )
            row = cur.fetchone()
    if row is None:
        return JSONResponse(status_code=404, content={"detail": "not found"})
    return row


@app.post("/products", status_code=201)
def create_product(product: ProductIn):
    with db.get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO products (name, price_cents) "
                "VALUES (%s, %s) "
                "RETURNING id, name, price_cents, created_at",
                (product.name, product.price_cents),
            )
            row = cur.fetchone()
        conn.commit()
    return row
