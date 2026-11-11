import { acquireWorkloadFile } from '../lib/acquisition.mjs';
import { importWorkloads, WORKLOAD_SOURCE, verifyWorkloadFile } from '../lib/workloads.mjs';
import { withDatabase, fail } from '../lib/database.mjs';
import { saveReceipt } from '../lib/receipts.mjs';

try {
  if (process.argv.length > 3) throw new Error('Usage: npm run ingest:workloads -- [path/to/job_info_df.csv]');
  const file = process.argv[2] ?? 'data/raw/alibaba-spot-gpu-2026/job_info_df.csv';
  if (process.argv[2]) await verifyWorkloadFile(file);
  else await acquireWorkloadFile(file);
  const result = await withDatabase(client => importWorkloads(client, file));
  await saveReceipt('workload-import', { source: WORKLOAD_SOURCE, result });
} catch (error) { fail(error); }
