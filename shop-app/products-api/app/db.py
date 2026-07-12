"""Database access layer for products-api.

Uses a psycopg connection pool. Exposes helpers to check connectivity
(SELECT 1) and to create the products table if it does not already exist.
"""

import os
from contextlib import contextmanager

from psycopg_pool import ConnectionPool
from psycopg.rows import dict_row

# ---------------------------------------------------------------------------
# Configuration (via environment)
# ---------------------------------------------------------------------------
DB_HOST = os.getenv("DB_HOST", "localhost")
DB_PORT = os.getenv("DB_PORT", "5432")
DB_NAME = os.getenv("DB_NAME", "shop")
DB_USER = os.getenv("DB_USER", "shop")
DB_PASSWORD = os.getenv("DB_PASSWORD", "shop")

CONNINFO = (
    f"host={DB_HOST} port={DB_PORT} dbname={DB_NAME} "
    f"user={DB_USER} password={DB_PASSWORD}"
)

# The pool is created lazily/opened on startup by main.py. We keep a module
# level singleton so all request handlers share the same pool.
_pool: ConnectionPool | None = None


def get_pool() -> ConnectionPool:
    """Return the shared connection pool, creating it on first use."""
    global _pool
    if _pool is None:
        # open=False so we control opening explicitly during app startup.
        _pool = ConnectionPool(
            conninfo=CONNINFO,
            min_size=1,
            max_size=10,
            open=False,
            kwargs={"row_factory": dict_row},
        )
    return _pool


def open_pool() -> None:
    """Open the pool (called on application startup)."""
    pool = get_pool()
    pool.open()
    # Wait until at least one connection is usable so readiness is meaningful.
    pool.wait(timeout=10.0)


def close_pool() -> None:
    """Close the pool (called on application shutdown)."""
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


@contextmanager
def get_conn():
    """Context manager yielding a pooled connection."""
    pool = get_pool()
    with pool.connection() as conn:
        yield conn


def check_db() -> bool:
    """Run 'SELECT 1' to verify the database is reachable.

    Returns True on success, False on any failure.
    """
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
                cur.fetchone()
        return True
    except Exception:
        return False


def create_table_if_missing() -> None:
    """Create the products table if it does not exist."""
    ddl = """
    CREATE TABLE IF NOT EXISTS products (
        id          serial PRIMARY KEY,
        name        text NOT NULL,
        price_cents integer NOT NULL,
        created_at  timestamptz NOT NULL DEFAULT now()
    );
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(ddl)
        conn.commit()
