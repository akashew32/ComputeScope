import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { withTestDatabase } from './helpers.mjs';
import {
  WORKLOAD_SOURCE, WORKLOAD_CSV_HEADERS, parseWorkloadRecord, parseWorkloadCsv,
  workloadCopyRow, verifyWorkloadFile, importWorkloads,
} from '../lib/workloads.mjs';

const record = (overrides = {}) => ({ job_name: 'job-1', organization: 'org-1', gpu_model: 'A100-SXM4-80GB',
  cpu_request: '2.5', gpu_request: '0.25', worker_num: '8', submit_time: '0.0', duration: '10.0', job_type: 'Spot', ...overrides });
const csvRow = row => WORKLOAD_CSV_HEADERS.map(h => `"${row[h].replaceAll('"', '""')}"`).join(',') + '\n';
const csv = row => WORKLOAD_CSV_HEADERS.join(',') + '\n' + csvRow(row);

test('preserves fractional requests, worker counts, and relative time separately', () => {
  const parsed = parseWorkloadRecord(record(), 2);
  assert.equal(parsed.gpuRequest, '0.25');
  assert.equal(parsed.workerCount, 8);
  assert.equal(parsed.submitTimeSeconds, '0.0');
  assert.equal(parsed.nativeGpuName, 'A100-SXM4-80GB');
});

test('rejects invalid numbers and silent PostgreSQL rounding', () => {
  for (const field of ['cpu_request', 'gpu_request', 'submit_time', 'duration']) {
    for (const value of ['NaN', 'Infinity', '-1', '', '1e3', '1.00001']) {
      assert.throws(() => parseWorkloadRecord(record({ [field]: value }), 2), /invalid|out-of-range/);
    }
  }
  assert.throws(() => parseWorkloadRecord(record({ gpu_request: '100000000' }), 2), /out-of-range/);
  assert.throws(() => parseWorkloadRecord(record({ duration: '1000000000000' }), 2), /out-of-range/);
  assert.throws(() => parseWorkloadRecord(record({ gpu_request: '0.0000' }), 2), /out-of-range/);
  assert.throws(() => parseWorkloadRecord(record({ duration: '0' }), 2), /out-of-range/);
  assert.equal(parseWorkloadRecord(record({ cpu_request: '0' }), 2).cpuRequest, '0');
  assert.equal(parseWorkloadRecord(record({ gpu_request: '99999999.9999' }), 2).gpuRequest, '99999999.9999');
});

test('rejects invalid workers, empty identities, and unknown job types', () => {
  for (const worker_num of ['0', '1.5', '2147483648', 'NaN', '-1']) {
    assert.throws(() => parseWorkloadRecord(record({ worker_num }), 2), /worker_num/);
  }
  for (const job_name of ['', '  ', 'bad\nname']) {
    assert.throws(() => parseWorkloadRecord(record({ job_name }), 2), /job_name/);
  }
  assert.throws(() => parseWorkloadRecord(record({ job_type: 'on-demand' }), 2), /job_type/);
});

test('stream parser handles quotes/chunk boundaries and COPY encoding safely', async () => {
  const input = csv(record({ job_name: 'j,"1', organization: 'x\\N' }));
  const rows = [];
  for await (const row of parseWorkloadCsv(Readable.from([...input]))) rows.push(row);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jobId, 'j,"1');
  assert.match(workloadCopyRow(rows[0]), /^"j,""1","A100-SXM4-80GB","x\\N",/);
});

test('stream parser rejects changed headers, empty files, and malformed CSV', async () => {
  for (const input of ['', csv(record()).replace('job_name', 'job_id'), csv(record()) + 'extra,bad\n']) {
    await assert.rejects(async () => {
      for await (const row of parseWorkloadCsv(Readable.from([input]))) void row;
    });
  }
});

test('pinned input validation rejects wrong size and same-size altered data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'computescope-pin-'));
  try {
    const path = join(dir, 'data.csv');
    await writeFile(path, csv(record()));
    await assert.rejects(verifyWorkloadFile(path), /byte count/);
    await writeFile(path, Buffer.alloc(WORKLOAD_SOURCE.bytes));
    await assert.rejects(verifyWorkloadFile(path), /checksum/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('real pinned import is atomic, idempotent, and rejects conflicting prior values', {
  skip: !(process.env.TEST_DATABASE_URL && process.env.WORKLOAD_TEST_FILE),
  timeout: 120_000,
}, async () => {
  await withTestDatabase(async client => {
    const first = await importWorkloads(client, process.env.WORKLOAD_TEST_FILE);
    assert.equal(first.jobs, WORKLOAD_SOURCE.rows);
    assert.equal(first.insertedJobs, WORKLOAD_SOURCE.rows);
    assert.equal(first.exactMappedJobs, 169_020);
    assert.equal(first.gpuTypes, 6);
    assert.equal(first.organizations, 84);
    const second = await importWorkloads(client, process.env.WORKLOAD_TEST_FILE);
    assert.equal(second.replayed, true);
    assert.equal(second.insertedJobs, 0);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM workload_gpu_types WHERE gpu_model_id IS NOT NULL')).rows[0].n, 1);
    await client.query('UPDATE workload_jobs SET duration_seconds=duration_seconds+1 WHERE job_id=(SELECT min(job_id) FROM workload_jobs)');
    await assert.rejects(importWorkloads(client, process.env.WORKLOAD_TEST_FILE), /values conflict/);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM workload_jobs')).rows[0].n, WORKLOAD_SOURCE.rows);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_class WHERE relname='workload_import_stage' AND relnamespace=pg_my_temp_schema()")).rows[0].n, 0);
  });
});
