// Adapted for the team's six-table schema from dalessioso/cis-5500
// src/ingestion/workloads.ts. Codex assisted with this adaptation and its checks.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parse } from 'csv-parse';
import { from as copyFrom } from 'pg-copy-streams';

const RELEASE = '3858992ca41bf92082e6d6522ddf0bebd14e838b';
export const WORKLOAD_SOURCE = Object.freeze({
  name: 'Alibaba 2026 spot-GPU jobs',
  releaseRef: RELEASE,
  documentationUrl: `https://github.com/alibaba/clusterdata/blob/${RELEASE}/cluster-trace-v2026-spot-gpu/README.md`,
  permissionUrl: `https://github.com/alibaba/clusterdata/blob/${RELEASE}/README.md`,
  url: `https://raw.githubusercontent.com/alibaba/clusterdata/${RELEASE}/cluster-trace-v2026-spot-gpu/job_info_df.csv`,
  sha256: '113ccee4c28f5c3bbaaca974cd164b9280b7d4c39e53b745443b28eea05e03dd',
  bytes: 23_055_929,
  rows: 466_867,
});

export const WORKLOAD_CSV_HEADERS = Object.freeze([
  'job_name', 'organization', 'gpu_model', 'cpu_request', 'gpu_request',
  'worker_num', 'submit_time', 'duration', 'job_type',
]);
const EXACT_NATIVE = 'A100-SXM4-80GB';
const EXACT_NAME = 'NVIDIA A100 SXM4 80GB';

function requiredText(value, field, line) {
  if (typeof value !== 'string' || !value.trim() || value.length > 255 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`CSV row ${line}: invalid ${field}`);
  }
  return value;
}

function decimal(value, field, line, integerDigits, positive = false) {
  // PostgreSQL numeric(p,4) rounds excess fractional digits. Reject them here
  // so ingestion never silently changes source requests or durations.
  if (typeof value !== 'string' || !/^\d+(?:\.\d{1,4})?$/.test(value)) {
    throw new Error(`CSV row ${line}: invalid ${field}`);
  }
  const integer = value.split('.')[0].replace(/^0+/, '') || '0';
  if (integer.length > integerDigits || (positive && !/[1-9]/.test(value))) {
    throw new Error(`CSV row ${line}: out-of-range ${field}`);
  }
  return value;
}

/** Source quantities stay independent: gpu_request is never multiplied by workers. */
export function parseWorkloadRecord(row, line) {
  if (!Number.isSafeInteger(line) || line < 2) throw new Error('Invalid CSV data row number');
  const worker = row.worker_num;
  if (typeof worker !== 'string' || !/^\d+$/.test(worker)
    || !Number.isSafeInteger(Number(worker)) || Number(worker) < 1 || Number(worker) > 2_147_483_647) {
    throw new Error(`CSV row ${line}: invalid worker_num`);
  }
  if (row.job_type !== 'HP' && row.job_type !== 'Spot') throw new Error(`CSV row ${line}: invalid job_type`);
  return {
    jobId: requiredText(row.job_name, 'job_name', line),
    organizationId: requiredText(row.organization, 'organization', line),
    nativeGpuName: requiredText(row.gpu_model, 'gpu_model', line),
    cpuRequest: decimal(row.cpu_request, 'cpu_request', line, 8),
    gpuRequest: decimal(row.gpu_request, 'gpu_request', line, 8, true),
    workerCount: Number(worker),
    submitTimeSeconds: decimal(row.submit_time, 'submit_time', line, 12),
    durationSeconds: decimal(row.duration, 'duration', line, 12, true),
    jobType: row.job_type,
  };
}

export async function* parseWorkloadCsv(input) {
  let sawHeader = false;
  const parser = parse({
    bom: true, info: true, max_record_size: 8192,
    columns(headers) {
      if (headers.length !== WORKLOAD_CSV_HEADERS.length || headers.some((h, i) => h !== WORKLOAD_CSV_HEADERS[i])) {
        throw new Error('Unexpected workload CSV headers; source schema requires review');
      }
      sawHeader = true;
      return headers;
    },
  });
  const finished = pipeline(input, parser);
  // Attach a handler immediately, then propagate errors through iteration/await.
  finished.catch(() => {});
  try {
    for await (const item of parser) yield parseWorkloadRecord(item.record, item.info.lines);
    await finished;
    if (!sawHeader) throw new Error('Workload CSV is empty');
  } finally {
    input.destroy();
    parser.destroy();
    await finished.catch(() => {});
  }
}

export async function verifyWorkloadFile(file) {
  const path = resolve(file);
  const info = await stat(path);
  if (!info.isFile() || info.size !== WORKLOAD_SOURCE.bytes) throw new Error('Workload file byte count differs from the pinned release');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    if (bytes > WORKLOAD_SOURCE.bytes) throw new Error('Workload file exceeded the pinned byte count');
    hash.update(chunk);
  }
  if (bytes !== WORKLOAD_SOURCE.bytes || hash.digest('hex') !== WORKLOAD_SOURCE.sha256) {
    throw new Error('Workload file checksum differs from the pinned release');
  }
  return { path, bytes, sha256: WORKLOAD_SOURCE.sha256, verifiedAt: new Date().toISOString() };
}

export function workloadCopyRow(row) {
  return [row.jobId, row.nativeGpuName, row.organizationId, row.cpuRequest,
    row.gpuRequest, row.workerCount, row.submitTimeSeconds, row.durationSeconds, row.jobType]
    .map(value => `"${String(value).replaceAll('"', '""')}"`).join(',') + '\n';
}

/**
 * Import the one pinned release into an already-connected team-schema client.
 * Owns its transaction; call outside another transaction. No rows are overwritten.
 */
export async function importWorkloads(client, file) {
  const source = await verifyWorkloadFile(file);
  let transaction = false;
  try {
    await client.query('BEGIN');
    transaction = true;
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [5500, 3]);
    // The lock also prevents an unrelated writer from changing rows between the
    // comparison and insertion. Only workload tables are locked for this import.
    await client.query('LOCK TABLE workload_jobs, workload_gpu_types IN SHARE ROW EXCLUSIVE MODE');
    await client.query('CREATE TEMP TABLE workload_import_stage (LIKE workload_jobs INCLUDING DEFAULTS INCLUDING CONSTRAINTS) ON COMMIT DROP');
    const copy = client.query(copyFrom(`COPY workload_import_stage
      (job_id,native_gpu_name,organization_id,cpu_request,gpu_request,worker_count,submit_time_seconds,duration_seconds,job_type)
      FROM STDIN WITH (FORMAT csv)`));
    const hash = createHash('sha256');
    let bytes = 0;
    let records = 0;
    const input = createReadStream(source.path);
    input.on('data', chunk => {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes > WORKLOAD_SOURCE.bytes) input.destroy(new Error('Workload file changed during import'));
    });
    async function* encodedRows() {
      for await (const row of parseWorkloadCsv(input)) {
        records++;
        if (records > WORKLOAD_SOURCE.rows) throw new Error('Workload file has more rows than the pinned release');
        yield workloadCopyRow(row);
      }
      if (records !== WORKLOAD_SOURCE.rows || bytes !== WORKLOAD_SOURCE.bytes || hash.digest('hex') !== WORKLOAD_SOURCE.sha256) {
        throw new Error('Workload file content/count changed during import');
      }
    }
    await pipeline(Readable.from(encodedRows()), copy);
    const duplicates = await client.query('SELECT 1 FROM workload_import_stage GROUP BY job_id HAVING count(*) > 1 LIMIT 1');
    if (duplicates.rowCount) throw new Error('Pinned workload file contains duplicate job IDs');
    await client.query('CREATE UNIQUE INDEX ON workload_import_stage (job_id)');
    await client.query('ANALYZE workload_import_stage');
    const extra = await client.query(`SELECT 1 FROM workload_jobs j
      WHERE NOT EXISTS (SELECT 1 FROM workload_import_stage s WHERE s.job_id=j.job_id) LIMIT 1`);
    if (extra.rowCount) throw new Error('Existing workload jobs contain IDs outside the pinned release');
    const conflicts = await client.query(`SELECT 1 FROM workload_jobs j JOIN workload_import_stage s USING (job_id)
      WHERE ROW(j.native_gpu_name,j.organization_id,j.cpu_request,j.gpu_request,j.worker_count,j.submit_time_seconds,j.duration_seconds,j.job_type)
      IS DISTINCT FROM ROW(s.native_gpu_name,s.organization_id,s.cpu_request,s.gpu_request,s.worker_count,s.submit_time_seconds,s.duration_seconds,s.job_type)
      LIMIT 1`);
    if (conflicts.rowCount) throw new Error('Existing workload job values conflict with the pinned release');

    await client.query('INSERT INTO gpu_models (name,vram_gb) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', [EXACT_NAME, 80]);
    const gpu = await client.query('SELECT gpu_model_id, vram_gb FROM gpu_models WHERE name=$1 FOR SHARE', [EXACT_NAME]);
    if (gpu.rowCount !== 1 || Number(gpu.rows[0].vram_gb) !== 80) throw new Error('Existing exact GPU model conflicts with reviewed 80GB identity');
    const gpuId = gpu.rows[0].gpu_model_id;
    await client.query(`INSERT INTO workload_gpu_types (native_gpu_name,gpu_model_id,mapping_source_url)
      SELECT DISTINCT native_gpu_name,
        CASE WHEN native_gpu_name=$1 THEN $2::bigint ELSE NULL END,
        CASE WHEN native_gpu_name=$1 THEN $3::text ELSE NULL END
      FROM workload_import_stage ON CONFLICT (native_gpu_name) DO NOTHING`, [EXACT_NATIVE, gpuId, WORKLOAD_SOURCE.documentationUrl]);
    // Promote the documented exact label only when it has no prior mapping.
    await client.query(`UPDATE workload_gpu_types SET gpu_model_id=$2,mapping_source_url=$3
      WHERE native_gpu_name=$1 AND gpu_model_id IS NULL AND mapping_source_url IS NULL`, [EXACT_NATIVE, gpuId, WORKLOAD_SOURCE.documentationUrl]);
    const mappings = await client.query(`SELECT 1 FROM workload_gpu_types t
      WHERE EXISTS (SELECT 1 FROM workload_import_stage s WHERE s.native_gpu_name=t.native_gpu_name)
      AND ((t.native_gpu_name=$1 AND (t.gpu_model_id IS DISTINCT FROM $2::bigint OR t.mapping_source_url IS DISTINCT FROM $3::text))
        OR (t.native_gpu_name<>$1 AND (t.gpu_model_id IS NOT NULL OR t.mapping_source_url IS NOT NULL))) LIMIT 1`,
    [EXACT_NATIVE, gpuId, WORKLOAD_SOURCE.documentationUrl]);
    if (mappings.rowCount) throw new Error('Existing workload GPU mapping differs from the reviewed mapping contract');
    const inserted = await client.query(`INSERT INTO workload_jobs
      (job_id,native_gpu_name,organization_id,cpu_request,gpu_request,worker_count,submit_time_seconds,duration_seconds,job_type)
      SELECT job_id,native_gpu_name,organization_id,cpu_request,gpu_request,worker_count,submit_time_seconds,duration_seconds,job_type
      FROM workload_import_stage ON CONFLICT (job_id) DO NOTHING`);
    const counts = await client.query(`SELECT count(*)::int AS jobs,
      count(DISTINCT native_gpu_name)::int AS gpu_types,
      count(DISTINCT organization_id)::int AS organizations,
      count(*) FILTER (WHERE native_gpu_name=$1)::int AS exact_mapped_jobs FROM workload_jobs`, [EXACT_NATIVE]);
    if (counts.rows[0].jobs !== WORKLOAD_SOURCE.rows) throw new Error('Stored workload count differs from pinned release');
    await client.query('COMMIT');
    transaction = false;
    return {
      sourceSha256: source.sha256, sourceBytes: source.bytes, releaseRef: RELEASE,
      jobs: counts.rows[0].jobs, insertedJobs: inserted.rowCount,
      gpuTypes: counts.rows[0].gpu_types, organizations: counts.rows[0].organizations,
      exactMappedJobs: counts.rows[0].exact_mapped_jobs, replayed: inserted.rowCount === 0,
    };
  } catch (error) {
    if (transaction) await client.query('ROLLBACK');
    throw error;
  }
}
