import { readFile } from 'node:fs/promises';
import { withDatabase, fail } from '../lib/database.mjs';

try {
  await withDatabase(async client => {
    const { rows } = await client.query(`SELECT count(*)::int AS count FROM information_schema.tables
      WHERE table_schema=current_schema() AND table_type='BASE TABLE'`);
    if (rows[0].count !== 0) throw new Error('Database schema is not empty. Setup does not overwrite existing tables.');
    await client.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    console.log('Created the six-table team schema.');
  }, { verifySchema: false });
} catch (error) { fail(error); }
