'use strict';

// Unit tests for orders-api that do not require a real Postgres or a live
// products-api. We mock ./db and global fetch so the HTTP layer, validation,
// and downstream-dependency behaviour can be exercised in isolation.

jest.mock('../src/db', () => {
  const rows = [];
  let nextId = 1;
  return {
    pool: {
      query: jest.fn(async (sql, params) => {
        if (/^SELECT id, product_id/i.test(sql)) {
          return { rows: [...rows] };
        }
        if (/^INSERT INTO orders/i.test(sql)) {
          const row = {
            id: nextId++,
            product_id: params[0],
            quantity: params[1],
            created_at: new Date().toISOString(),
          };
          rows.push(row);
          return { rows: [row] };
        }
        return { rows: [] };
      }),
    },
    checkConnection: jest.fn(async () => true),
    initSchema: jest.fn(async () => {}),
  };
});

const request = require('supertest');
const app = require('../src/index');

describe('orders-api', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('GET /health returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

	//test('GET /ready returns 200 when DB and products-api are healthy', async () => {
		// global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });
		// const res = await request(app).get('/ready');
   // expect(res.status).toBe(200);
   // expect(res.body.status).toBe('ready');
  //});
  test('GET /ready returns 200 when database is healthy', async () => {
    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
});

  //test('GET /ready returns 503 when products-api is unreachable', async () => {
   // global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
   // const res = await request(app).get('/ready');
   // expect(res.status).toBe(503);
  //});
  test('GET /ready remains healthy when products-api is unreachable', async () => {
    global.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(app).get('/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
});	

  test('GET /metrics exposes prometheus text', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('http_requests_total');
  });

  test('POST /orders validates payload', async () => {
    const res = await request(app).post('/orders').send({ product_id: 'x' });
    expect(res.status).toBe(400);
  });

  test('POST /orders returns 404 when product does not exist', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const res = await request(app)
      .post('/orders')
      .send({ product_id: 999, quantity: 2 });
    expect(res.status).toBe(404);
  });

  test('POST /orders creates an order when product exists', async () => {
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const res = await request(app)
      .post('/orders')
      .send({ product_id: 1, quantity: 3 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ product_id: 1, quantity: 3 });
    expect(res.body).toHaveProperty('id');
  });

  test('GET /orders lists created orders', async () => {
    const res = await request(app).get('/orders');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
