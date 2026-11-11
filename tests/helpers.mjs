import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function withTestDatabase(action) {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL must identify a disposable database.');
  const schema = `test_ms3_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    return await action(client);
  } finally {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
}
