import { withDatabase, fail } from '../lib/database.mjs';

const username = 'computescope_guest';
try {
  const password = process.env.GUEST_PASSWORD;
  if (!password || password.length < 16) throw new Error('Set GUEST_PASSWORD in .env to a new password of at least 16 characters.');
  await withDatabase(async client => {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query(`SELECT current_database() AS database,
        current_schema() AS schema, EXISTS (SELECT 1 FROM pg_roles WHERE rolname=$1) AS exists`, [username]);
      if (rows[0].schema !== 'public') throw new Error('Guest setup expects the team tables in public.');
      if (rows[0].exists) throw new Error('computescope_guest already exists; inspect its permissions instead of resetting it.');
      const create = await client.query(`SELECT format(
        'CREATE ROLE %I LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS sql`, [username, password]);
      await client.query(create.rows[0].sql);
      const grant = await client.query('SELECT format($1::text, $2::text, $3::text) AS sql',
        ['GRANT CONNECT ON DATABASE %I TO %I', rows[0].database, username]);
      await client.query(grant.rows[0].sql);
      await client.query('GRANT USAGE ON SCHEMA public TO computescope_guest');
      await client.query(`GRANT SELECT ON public.providers, public.gpu_models,
        public.rental_offers, public.rental_observations, public.workload_gpu_types,
        public.workload_jobs TO computescope_guest`);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
  });
  console.log('Created computescope_guest with SELECT access to the six project tables.');
} catch (error) { fail(error); }
