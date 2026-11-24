import { readFileSync } from 'node:fs';

function loadSql(file) {
  return readFileSync(new URL('../sql_queries/' + file, import.meta.url), 'utf8').trim().replace(/;$/, '');
}

const spotSql = loadSql('09_spot_on_demand_comparison.sql');
const originalBudgetSql = loadSql('10_budget_allocation_scenario.sql');

// Keep the submitted query as the single source of the allocation logic. Replace
// only its three literal parameters; never interpolate user-provided strings.
const paramsPattern = /SELECT\s+1000\.00::numeric\s+AS\s+budget_usd,\s*0\.25::numeric\s+AS\s+organization_budget_fraction,\s*500::bigint\s+AS\s+candidate_limit/i;
if (!paramsPattern.test(originalBudgetSql)) throw new Error('Budget query parameter block does not match the expected SQL.');
const budgetSql = originalBudgetSql.replace(paramsPattern,
  'SELECT $1::numeric AS budget_usd, $2::numeric AS organization_budget_fraction, $3::bigint AS candidate_limit');

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

function optionalId(value) {
  if (value === null) return null;
  if (!value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) {
    badRequest('organization_id must contain 1-100 characters without control characters.');
  }
  return value;
}

function decimal(value, fallback, name) {
  if (value === null) return fallback;
  if (!/^\d{1,12}(?:\.\d{1,6})?$/.test(value)) {
    badRequest(name + ' must be a nonnegative decimal with up to 12 integer and 6 fractional digits.');
  }
  return value;
}

export async function getSpotComparison(db, params, limit, offset) {
  checkParams(params, ['organization_id']);
  const organizationId = optionalId(params.get('organization_id'));
  return db.query(`
    SELECT q.* FROM (${spotSql}) AS q
    WHERE ($1::text IS NULL OR q.organization_id = $1)
    ORDER BY q.spot_savings_scenario_usd DESC NULLS LAST, q.organization_id
    LIMIT $2 OFFSET $3`, [organizationId, limit, offset]);
}

export async function getBudgetAllocation(db, params, limit, offset) {
  checkParams(params, ['budget_usd', 'organization_budget_fraction', 'candidate_limit']);
  const budget = decimal(params.get('budget_usd'), '1000.00', 'budget_usd');
  const fraction = decimal(params.get('organization_budget_fraction'), '0.25', 'organization_budget_fraction');
  if (Number(fraction) > 1) badRequest('organization_budget_fraction must be between 0 and 1.');
  const candidateLimit = params.get('candidate_limit') ?? '500';
  if (!/^\d+$/.test(candidateLimit) || !Number.isSafeInteger(Number(candidateLimit))
    || Number(candidateLimit) < 1 || Number(candidateLimit) > 10000) {
    badRequest('candidate_limit must be an integer from 1 to 10000.');
  }
  // Pagination happens after allocation, so it never changes earlier decisions.
  return db.query(`
    SELECT q.* FROM (${budgetSql}) AS q
    ORDER BY q.position
    LIMIT $4 OFFSET $5`, [budget, fraction, Number(candidateLimit), limit, offset]);
}
