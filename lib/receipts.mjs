import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export async function saveReceipt(kind, result) {
  const completedAt = new Date().toISOString();
  const directory = resolve('data/receipts');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = `${directory}/${kind}-${completedAt.replaceAll(':', '-')}-${randomUUID().slice(0, 8)}.json`;
  const receipt = { schemaVersion: 1, parserVersion: 'team-six-table-v1', operation: kind, completedAt, ...result };
  await writeFile(path, JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`Receipt: ${path}`);
  return receipt;
}
