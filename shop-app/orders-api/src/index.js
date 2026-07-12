'use strict';

const express = require('express');
const client = require('prom-client');
const { pool, checkConnection, initSchema } = require('./db');

const PORT = parseInt(process.env.PORT || '3000', 10);
const PRODUCTS_API_URL = process.env.PRODUCTS_API_URL || 'http://products-api:8000';

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------
const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'path', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds',
  labelNames: ['method', 'path', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

// Downstream (products-api) availability is a METRIC, not a readiness signal.
// Coupling readiness to a downstream dependency causes cascading failure: if
// products-api goes down, every orders pod would fail readiness and be pulled
// from the Service, taking down endpoints (GET /orders, /health) that don't even
// need products-api. Instead we surface downstream health here and let requests
// that actually need it fail with a controlled 503.
const productsApiUp = new client.Gauge({
  name: 'products_api_up',
  help: '1 if products-api /health responded OK on the last probe, else 0',
  registers: [register],
});

async function probeProductsApi() {
  try {
    const resp = await fetch(`${PRODUCTS_API_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    productsApiUp.set(resp.ok ? 1 : 0);
  } catch {
    productsApiUp.set(0);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Metrics middleware: records count + latency, labelled by the matched route
// (falls back to the raw path) to keep label cardinality bounded.
app.use((req, res, next) => {
  const end = httpRequestDuration.startTimer();
  res.on('finish', () => {
    const path = req.route ? req.baseUrl + req.route.path : req.path;
    const labels = {
      method: req.method,
      path,
      status: String(res.statusCode),
    };
    httpRequestsTotal.inc(labels);
    end(labels);
  });
  next();
});

// ---------------------------------------------------------------------------
// Health / readiness / metrics
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness reflects ONLY what this service needs to serve requests: its own DB.
// It deliberately does NOT probe products-api (see productsApiUp gauge above).
app.get('/ready', async (req, res) => {
  const dbOk = await checkConnection();
  if (dbOk) {
    return res.status(200).json({ status: 'ready' });
  }
  return res.status(503).json({ status: 'not ready', db: dbOk });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------
app.get('/orders', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, product_id, quantity, created_at FROM orders ORDER BY id'
    );
    res.status(200).json(rows);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('GET /orders failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

app.post('/orders', async (req, res) => {
  const { product_id, quantity } = req.body || {};

  if (!Number.isInteger(product_id) || !Number.isInteger(quantity) || quantity <= 0) {
    return res.status(400).json({
      error: 'product_id (int) and quantity (positive int) are required',
    });
  }

  // Validate the product exists by calling products-api. This is the ONLY place
  // the downstream dependency matters: when it's unavailable we return a
  // controlled 503 (with Retry-After) for THIS request, rather than marking the
  // whole pod unready. GET /orders and /health keep working regardless.
  let productResp;
  try {
    productResp = await fetch(`${PRODUCTS_API_URL}/products/${product_id}`, {
      signal: AbortSignal.timeout(5000),
    });
    productsApiUp.set(1);
  } catch (err) {
    productsApiUp.set(0);
    // eslint-disable-next-line no-console
    console.error('product validation call failed:', err.message);
    return res
      .status(503)
      .set('Retry-After', '5')
      .json({ error: 'product validation temporarily unavailable' });
  }

  if (productResp.status === 404) {
    return res.status(404).json({ error: `product ${product_id} not found` });
  }
  if (!productResp.ok) {
    productsApiUp.set(0);
    return res
      .status(503)
      .set('Retry-After', '5')
      .json({ error: 'product validation temporarily unavailable' });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO orders (product_id, quantity)
       VALUES ($1, $2)
       RETURNING id, product_id, quantity, created_at`,
      [product_id, quantity]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('POST /orders insert failed:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
async function start() {
  await initSchema();
  // Probe the downstream on an interval so products_api_up (and its alert) stay
  // accurate even with no order traffic. This never affects readiness.
  probeProductsApi();
  setInterval(probeProductsApi, 15000).unref();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`orders-api listening on :${PORT}, products-api at ${PRODUCTS_API_URL}`);
  });
}

// Only auto-start when run directly, so tests can import the app.
if (require.main === module) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to start orders-api:', err);
    process.exit(1);
  });
}

module.exports = app;
