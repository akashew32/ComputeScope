import pg from 'pg';

const expectedColumns = {
  providers: ['provider_id', 'name', 'website'],
  gpu_models: ['gpu_model_id', 'name', 'vram_gb'],
  rental_offers: ['offer_id', 'provider_id', 'gpu_model_id', 'source_name', 'source_offer_id', 'source_url', 'native_gpu_name', 'gpu_count', 'rental_mode', 'region', 'revision'],
  rental_observations: ['offer_id', 'observed_at', 'source_updated_at', 'price_per_gpu_hour', 'currency', 'available'],
  workload_gpu_types: ['native_gpu_name', 'gpu_model_id', 'mapping_source_url'],
  workload_jobs: ['job_id', 'native_gpu_name', 'organization_id', 'cpu_request', 'gpu_request', 'worker_count', 'submit_time_seconds', 'duration_seconds', 'job_type'],
};

export async function assertTeamSchema(client) {
  const { rows } = await client.query(`SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name=ANY($1::text[])
    ORDER BY table_name,ordinal_position`, [Object.keys(expectedColumns)]);
  for (const [table, columns] of Object.entries(expectedColumns)) {
    const actual = rows.filter(row => row.table_name === table).map(row => row.column_name);
    if (JSON.stringify(actual) !== JSON.stringify(columns)) {
      throw new Error(`Incompatible team schema: ${table}. Use a separate database initialized with this repository's schema.sql.`);
    }
  }
}

export async function withDatabase(action, { verifySchema = true } = {}) {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL explicitly for the team database.');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
    application_name: 'computescope-team-ingestion' });
  try {
    await client.connect();
    if (verifySchema) await assertTeamSchema(client);
    return await action(client);
  } finally { await client.end(); }
}

export function fail(error) {
  console.error(String(error.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/g, '[database URL redacted]'));
  process.exitCode = 1;
}
