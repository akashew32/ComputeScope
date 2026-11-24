import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createDatabase } from './database.mjs';

// Read the original queries once. Each handler adds its own filters below.
function loadSql(file) {
  return readFileSync(new URL('../sql_queries/' + file, import.meta.url), 'utf8').trim().replace(/;$/, '');
}
const rentalSql = loadSql('01_rental_prices.sql');
const gpuSql = loadSql('02_gpu_catalog.sql');
const providerSql = loadSql('03_provider_summary.sql');
const historySql = loadSql('04_offer_history.sql');

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  throw error;
}

function checkParams(params, allowed) {
  for (const name of params.keys()) {
    if (!['limit', 'offset', ...allowed].includes(name)) badRequest('Unknown query parameter: ' + name);
    if (params.getAll(name).length > 1) badRequest(name + ' must appear only once.');
  }
}

function pageNumber(value, fallback, min, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < min || Number(value) > max) {
    badRequest('Pagination values must be integers within the documented limits.');
  }
  return Number(value);
}

function searchText(value) {
  if (value === null) return null;
  if (!value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) badRequest('Search text must contain 1-100 characters without control characters.');
  return '%' + value.replace(/[\\%_]/g, '\\$&') + '%';
}

function decimal(value) {
  if (value !== null && !/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) badRequest('Use a nonnegative decimal with up to 12 integer and 6 fractional digits.');
  return value;
}

function timestamp(value) {
  if (value === null) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/);
  if (!match || !Number.isFinite(Date.parse(value))) badRequest('Use an ISO timestamp with an explicit timezone.');
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()
    || hour > 23 || minute > 59 || second > 59) badRequest('Use a valid calendar timestamp.');
  return value;
}

async function getRentals(db, params, limit, offset) {
  checkParams(params, ['gpu', 'provider', 'available', 'currency', 'max_price']);
  const available = params.get('available');
  if (available !== null && !['true', 'false', 'unknown'].includes(available)) badRequest('available must be true, false, or unknown.');
  const currency = params.get('currency');
  if (currency !== null && !/^[A-Z]{3}$/.test(currency)) badRequest('currency must be an uppercase three-letter code.');
  const maxPrice = decimal(params.get('max_price'));
  if (maxPrice !== null && currency === null) badRequest('currency is required with max_price.');
  // $3 enables the stock filter; $4 carries its true/false/null value.
  return db.query(`
    SELECT q.* FROM (${rentalSql}) AS q
    WHERE ($1::text IS NULL OR q.gpu ILIKE $1)
      AND ($2::text IS NULL OR q.provider ILIKE $2)
      AND (NOT $3::boolean OR q.reported_available IS NOT DISTINCT FROM $4::boolean)
      AND ($5::text IS NULL OR q.currency = $5)
      AND ($6::numeric IS NULL OR q.price_per_gpu_hour <= $6)
    ORDER BY q.currency NULLS LAST, q.price_per_gpu_hour NULLS LAST, q.offer_id
    LIMIT $7 OFFSET $8`, [searchText(params.get('gpu')), searchText(params.get('provider')),
    available !== null, available === 'unknown' ? null : available === 'true', currency, maxPrice, limit, offset]);
}

async function getGpus(db, params, limit, offset) {
  checkParams(params, ['name', 'min_vram_gb']);
  return db.query(`
    SELECT q.* FROM (${gpuSql}) AS q
    WHERE ($1::text IS NULL OR q.name ILIKE $1)
      AND ($2::numeric IS NULL OR q.vram_gb >= $2)
    ORDER BY q.name, q.gpu_model_id
    LIMIT $3 OFFSET $4`, [searchText(params.get('name')), decimal(params.get('min_vram_gb')), limit, offset]);
}

async function getProviders(db, params, limit, offset) {
  checkParams(params, ['name']);
  return db.query(`
    SELECT q.* FROM (${providerSql}) AS q
    WHERE ($1::text IS NULL OR q.name ILIKE $1)
    ORDER BY q.name, q.provider_id
    LIMIT $2 OFFSET $3`, [searchText(params.get('name')), limit, offset]);
}

async function getHistory(db, offerId, params, limit, offset) {
  checkParams(params, ['since', 'until']);
  if (!/^[1-9]\d{0,18}$/.test(offerId) || BigInt(offerId) > 9223372036854775807n) badRequest('offerId must be a positive PostgreSQL bigint.');
  const since = timestamp(params.get('since'));
  const until = timestamp(params.get('until'));
  if (since && until && Date.parse(since) > Date.parse(until)) badRequest('since must be at or before until.');
  // Filter after the original LAG calculation so the previous quote is preserved.
  return db.query(`
    SELECT q.* FROM (${historySql}) AS q
    WHERE q.offer_id = $1::bigint
      AND ($2::timestamptz IS NULL OR q.observed_at >= $2)
      AND ($3::timestamptz IS NULL OR q.observed_at <= $3)
    ORDER BY q.offer_id, q.observed_at
    LIMIT $4 OFFSET $5`, [offerId, since, until, limit, offset]);
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(body));
}

export function createApiServer({ db, logger = console }) {
  return createServer(async (request, response) => {
    let headers = {};
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const params = url.searchParams;
      const history = path.match(/^\/api\/offers\/([^/]+)\/history$/);
      if (!['/api/health', '/api/rentals', '/api/gpus', '/api/providers'].includes(path) && !history) {
        return send(response, 404, { error: { code: 'NOT_FOUND', message: 'This route does not exist.' } });
      }
      if (request.method !== 'GET') {
        headers = { Allow: 'GET' };
        return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET for this route.' } }, headers);
      }
      if (path === '/api/health') {
        if (url.search) badRequest('The health route takes no query parameters.');
        await db.query('SELECT 1 AS ok');
        return send(response, 200, { status: 'ok', database: 'reachable' });
      }
      const limit = pageNumber(params.get('limit'), 100, 1, 1000);
      const offset = pageNumber(params.get('offset'), 0, 0, 1000000);
      let result, queryId;
      if (path === '/api/rentals') {
        result = await getRentals(db, params, limit, offset);
        queryId = '01';
      } else if (path === '/api/gpus') {
        result = await getGpus(db, params, limit, offset);
        queryId = '02';
      } else if (path === '/api/providers') {
        result = await getProviders(db, params, limit, offset);
        queryId = '03';
      } else {
        let offerId;
        try { offerId = decodeURIComponent(history[1]); } catch { badRequest('Invalid offerId encoding.'); }
        result = await getHistory(db, offerId, params, limit, offset);
        queryId = '04';
      }
      send(response, 200, { data: result.rows, meta: {
        query_id: queryId, returned_rows: result.rows.length, limit, offset,
      } });
    } catch (error) {
      let status = error.status ?? 500;
      let code = 'INVALID_PARAMETER', message = error.message;
      if (!error.status) {
        logger.error('API database error', { code: error.code ?? 'UNKNOWN' });
        code = 'INTERNAL_ERROR'; message = 'The request could not be completed.';
        if (error.code === '57014') { status = 504; code = 'QUERY_TIMEOUT'; message = 'The query timed out.'; }
        else if (/^(08|28)/.test(error.code ?? '') || ['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', '57P01', '57P02', '57P03', '3D000'].includes(error.code)) {
          status = 503; code = 'DATABASE_UNAVAILABLE'; message = 'The database is temporarily unavailable.';
        }
      }
      send(response, status, { error: { code, message } }, headers);
    }
  });
}

// Start listening only when run directly; tests import createApiServer instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let db;
  try {
    const port = Number(process.env.PORT ?? 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
    const host = process.env.API_HOST ?? '127.0.0.1';
    db = createDatabase();
    await db.query('SELECT 1');
    const server = createApiServer({ db });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    console.log('ComputeScope API listening on http://' + host + ':' + port);
    const stop = () => server.close(() => db.end());
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error('API startup failed. Check DATABASE_URL, PORT, and database access.');
    if (db) await db.end();
    process.exitCode = 1;
  }
}
