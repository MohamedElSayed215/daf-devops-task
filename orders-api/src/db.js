'use strict';

const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'shop',
  user: process.env.DB_USER || 'shop',
  password: process.env.DB_PASSWORD || 'shop',
  max: parseInt(process.env.DB_POOL_MAX || '10', 10),
});

// Surface pool-level errors instead of crashing the process silently.
pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error on idle Postgres client', err);
});

/**
 * Lightweight connectivity check used by the readiness probe.
 * Returns true if 'SELECT 1' succeeds, false otherwise.
 */
async function checkConnection() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('DB readiness check failed:', err.message);
    return false;
  }
}

/**
 * Create the orders table if it does not already exist.
 * Called once on startup.
 */
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id serial PRIMARY KEY,
      product_id integer NOT NULL,
      quantity integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

module.exports = {
  pool,
  checkConnection,
  initSchema,
};
