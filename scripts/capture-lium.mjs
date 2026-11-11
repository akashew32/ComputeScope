import { captureLium } from '../lib/acquisition.mjs';

try {
  if (process.argv.length > 3 || process.argv[2]?.startsWith('-')) {
    throw new Error('Usage: npm run capture:lium -- [output.json]');
  }
  const result = await captureLium({ file: process.argv[2] });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`Lium capture failed: ${error.message}`);
  process.exitCode = 1;
}
