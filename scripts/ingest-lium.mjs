import { readCapture } from '../lib/acquisition.mjs';
import { importLium } from '../lib/lium.mjs';
import { withDatabase, fail } from '../lib/database.mjs';
import { saveReceipt } from '../lib/receipts.mjs';

try {
  const file = process.argv[2];
  if (!file || process.argv.length !== 3) throw new Error('Usage: npm run ingest:lium -- path/to/capture.json');
  const { payload, metadata } = await readCapture(file);
  const result = await withDatabase(client => importLium(client, payload, { observedAt: metadata.observedAt }));
  await saveReceipt('lium-import', { capture: metadata, result });
} catch (error) { fail(error); }
