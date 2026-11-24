import pg from 'pg';

export function createDatabase(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('Set DATABASE_URL in .env.');
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10000,
    statement_timeout: 30000,
    options: '-c default_transaction_read_only=on -c timezone=UTC',
  });
  pool.on('error', error => console.error('Database connection error', { code: error.code }));
  return pool;
}
