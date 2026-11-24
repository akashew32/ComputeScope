import { readFileSync } from 'node:fs';

// Reuse the original milestone queries, filtering their output after aggregation.
function loadSql(file) {
  return readFileSync(new URL('../sql_queries/' + file, import.meta.url), 'utf8').trim().replace(/;$/, '');
}
const workloadSql = loadSql('05_workload_summary.sql');
const demandSql = loadSql('06_organization_demand.sql');
const coverageSql = loadSql('07_workload_market_coverage.sql');
const exposureSql = loadSql('08_organization_price_exposure.sql');

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

function validText(value) {
  if (value === null) return null;
  if (!value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    badRequest('Search text must contain 1-100 characters without control characters.');
  }
  return value;
}

function searchText(value) {
  value = validText(value);
  return value === null ? null : '%' + value.replace(/[\\%_]/g, '\\$&') + '%';
}

export async function getWorkloadSummary(db, params, limit, offset) {
  checkParams(params, ['native_gpu_name', 'trace_priority']);
  const priority = params.get('trace_priority');
  if (priority !== null && !['HP', 'Spot'].includes(priority)) badRequest('trace_priority must be HP or Spot.');
  return db.query(`
    SELECT q.* FROM (${workloadSql}) AS q
    WHERE ($1::text IS NULL OR q.native_gpu_name ILIKE $1)
      AND ($2::text IS NULL OR q.trace_priority = $2)
    ORDER BY q.scenario_requested_gpu_hours DESC, q.native_gpu_name, q.trace_priority
    LIMIT $3 OFFSET $4`, [searchText(params.get('native_gpu_name')), priority, limit, offset]);
}

export async function getOrganizationDemand(db, params, limit, offset) {
  checkParams(params, ['organization_id']);
  return db.query(`
    SELECT q.* FROM (${demandSql}) AS q
    WHERE ($1::text IS NULL OR q.organization_id = $1)
    ORDER BY q.scenario_requested_gpu_hours DESC, q.organization_id
    LIMIT $2 OFFSET $3`, [validText(params.get('organization_id')), limit, offset]);
}

export async function getWorkloadMarketCoverage(db, params, limit, offset) {
  checkParams(params, ['organization_id']);
  return db.query(`
    SELECT q.* FROM (${coverageSql}) AS q
    WHERE ($1::text IS NULL OR q.organization_id = $1)
    ORDER BY q.matched_job_pct, q.total_jobs DESC, q.organization_id
    LIMIT $2 OFFSET $3`, [validText(params.get('organization_id')), limit, offset]);
}

export async function getOrganizationPriceExposure(db, params, limit, offset) {
  checkParams(params, ['organization_id']);
  return db.query(`
    SELECT q.* FROM (${exposureSql}) AS q
    WHERE ($1::text IS NULL OR q.organization_id = $1)
    ORDER BY q.lowest_quote_scenario_usd DESC NULLS LAST, q.organization_id
    LIMIT $2 OFFSET $3`, [validText(params.get('organization_id')), limit, offset]);
}
