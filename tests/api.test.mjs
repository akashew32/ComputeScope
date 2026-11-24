import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../server/app.mjs';

// Exercise request dispatch, validation, routing and JSON serialization with
// injected request/response objects and database. No socket or SQL is used.
test('API routes and validation', async t => {
  const calls = [];
  let failure = null;
  const fixture = { marker: 'database response' };
  const db = { async query(sql, params) {
    calls.push({ sql, params });
    if (failure) throw Object.assign(new Error('sensitive details'), { code: failure });
    return { rows: [fixture] };
  } };
  const server = createApiServer({ db, logger: { error() {} } });
  async function request(path, options) {
    return await new Promise(resolve => {
      const response = {
        writeHead(status, headers) { this.status = status; this.headers = headers; },
        end(body) { resolve({ status: this.status, headers: this.headers, body: JSON.parse(body) }); },
      };
      server.emit('request', { url: path, method: options?.method ?? 'GET' }, response);
    });
  }

  const routes = [
    ['01', '/api/rentals?gpu=A100&provider=Li&available=unknown&currency=USD&max_price=2.5&limit=7&offset=3', ['%A100%', '%Li%', true, null, 'USD', '2.5', 7, 3]],
    ['02', '/api/gpus?name=A100&min_vram_gb=80&limit=7&offset=3', ['%A100%', '80', 7, 3]],
    ['03', '/api/providers?name=Li&limit=7&offset=3', ['%Li%', 7, 3]],
    ['04', '/api/offers/42/history?since=2026-01-01T00%3A00%3A00Z&until=2026-02-01T00%3A00%3A00Z&limit=7&offset=3', ['42', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 7, 3]],
    ['05', '/api/workloads/summary?native_gpu_name=A100&trace_priority=HP&limit=7&offset=3', ['%A100%', 'HP', 7, 3]],
    ['06', '/api/organizations/demand?organization_id=org1&limit=7&offset=3', ['org1', 7, 3]],
    ['07', '/api/organizations/market-coverage?organization_id=org1&limit=7&offset=3', ['org1', 7, 3]],
    ['08', '/api/organizations/price-exposure?organization_id=org1&limit=7&offset=3', ['org1', 7, 3]],
    ['09', '/api/organizations/spot-comparison?organization_id=org1&limit=7&offset=3', ['org1', 7, 3]],
    ['10', '/api/budget-allocation?budget_usd=2000.5&organization_budget_fraction=0.4&candidate_limit=12&limit=7&offset=3', ['2000.5', '0.4', 12, 7, 3]],
  ];
  for (const [id, path, expected] of routes) await t.test(`query ${id} returns a paginated result and binds its filters`, async () => {
    const previous = calls.length;
    const result = await request(path);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.data, [fixture]);
    assert.deepEqual(result.body.meta, { query_id: id, returned_rows: 1, limit: 7, offset: 3 });
    assert.equal(calls.length, previous + 1);
    assert.deepEqual(calls.at(-1).params, expected);
    assert.match(calls.at(-1).sql, /\$1/);
  });

  await t.test('defaults and safe parameterization for allocation', async () => {
    const result = await request('/api/budget-allocation');
    assert.equal(result.status, 200);
    assert.deepEqual(calls.at(-1).params, ['1000.00', '0.25', 500, 100, 0]);
    assert.match(calls.at(-1).sql, /\$1::numeric AS budget_usd/);
    assert.match(calls.at(-1).sql, /\$2::numeric AS organization_budget_fraction/);
    assert.match(calls.at(-1).sql, /\$3::bigint AS candidate_limit/);
  });
  await t.test('search literals and SQL injection are bound, not interpolated', async () => {
    const input = "A_%' OR 1=1 --";
    const result = await request('/api/workloads/summary?native_gpu_name=' + encodeURIComponent(input));
    assert.equal(result.status, 200);
    assert.equal(calls.at(-1).params[0], "%A\\_\\%' OR 1=1 --%");
    assert.ok(!calls.at(-1).sql.includes(input));
  });
  await t.test('invalid parameters are rejected before the database', async () => {
    const invalid = [
      '/api/rentals?available=yes', '/api/rentals?max_price=1', '/api/rentals?currency=usd',
      '/api/gpus?limit=0', '/api/providers?limit=1001', '/api/providers?offset=-1',
      '/api/providers?name=a&name=b', '/api/providers?unknown=x',
      '/api/offers/0/history', '/api/offers/1/history?since=2026-02-30T00%3A00%3A00Z',
      '/api/offers/1/history?since=2026-02-01T00%3A00%3A00Z&until=2026-01-01T00%3A00%3A00Z',
      '/api/workloads/summary?trace_priority=spot', '/api/organizations/demand?organization_id=',
      '/api/organizations/market-coverage?organization_id=+','/api/organizations/price-exposure?other=x',
      '/api/organizations/spot-comparison?organization_id=one&organization_id=two',
      '/api/budget-allocation?budget_usd=-1', '/api/budget-allocation?organization_budget_fraction=1.1',
      '/api/budget-allocation?candidate_limit=0', '/api/budget-allocation?candidate_limit=10001',
      '/api/budget-allocation?candidate_limit=1.5',
    ];
    for (const path of invalid) {
      const previous = calls.length;
      const result = await request(path);
      assert.equal(result.status, 400, path);
      assert.equal(result.body.error.code, 'INVALID_PARAMETER', path);
      assert.equal(calls.length, previous, path);
    }
  });
  await t.test('health, missing routes, methods and database failure codes', async () => {
    assert.deepEqual((await request('/api/health')).body, { status: 'ok', database: 'reachable' });
    assert.equal((await request('/api/health?unused=1')).status, 400);
    assert.equal((await request('/api/no-such-route')).status, 404);
    const method = await request('/api/rentals', { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.Allow, 'GET');
    for (const [code, status] of [['57014', 504], ['ECONNREFUSED', 503], ['OTHER', 500]]) {
      failure = code;
      const result = await request('/api/rentals');
      assert.equal(result.status, status);
      assert.ok(!JSON.stringify(result.body).includes('sensitive details'));
    }
    failure = null;
  });
});
