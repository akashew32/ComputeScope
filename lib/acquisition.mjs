import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, link, copyFile, unlink, readdir, chmod, rmdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve, join } from 'node:path';
import { LIUM_NODES_URL, parseLium } from './lium.mjs';

export const LIUM_MAX_BYTES = 10 * 1024 * 1024;
export const PARSER_VERSION = 'team-six-table-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const sidecar = file => `${file}.metadata.json`;

function isoTime(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error(`Invalid ${label}: expected a canonical UTC ISO timestamp`);
  }
  return value;
}

async function exists(file) {
  try { await stat(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function privateDirectory(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/** Fixed callers supply an allowlisted public URL; redirects are never followed. */
export async function downloadBytes(url, { maxBytes, timeoutMs = 30000, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error('Download limits must be positive integers');
  }
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Download timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  const request = async () => {
    const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok || response.redirected || (response.url && response.url !== url)) {
      await response.body?.cancel();
      throw new Error(`Public source request failed or redirected (HTTP ${response.status})`);
    }
    const length = response.headers.get('content-length');
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
      await response.body?.cancel();
      throw new Error(`Source Content-Length exceeds the ${maxBytes}-byte limit or is invalid`);
    }
    if (!response.body) throw new Error('Public source response has no body');
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > maxBytes) throw new Error(`Source exceeds the ${maxBytes}-byte limit`);
        chunks.push(Buffer.from(next.value));
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks, bytes);
  };
  try { return await Promise.race([request(), timeout]); }
  finally { clearTimeout(timer); }
}

/** Store both files without replacing either existing path. Interrupted partial pairs fail closed. */
async function publishPair(file, bytes, metadata, validateTemporary) {
  await privateDirectory(dirname(file));
  const temporary = join(dirname(file), `.${randomUUID()}.part`);
  const temporaryMetadata = `${temporary}.metadata.json`;
  let linkedRaw = false;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    if (validateTemporary) await validateTemporary(temporary);
    await writeFile(temporaryMetadata, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    // Windows environments can disallow hard links. Exclusive copy preserves
    // no-overwrite behavior; readers still require a complete, verified pair.
    const publish = process.platform === 'win32'
      ? (source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL)
      : link;
    await publish(temporary, file);
    linkedRaw = true;
    await publish(temporaryMetadata, sidecar(file));
  } catch (error) {
    if (linkedRaw) await unlink(file).catch(() => {});
    throw error;
  } finally {
    await unlink(temporary).catch(() => {});
    await unlink(temporaryMetadata).catch(() => {});
  }
}

/** Validate provenance and the raw bytes before any replay can reach the database. */
export async function readCapture(file) {
  const path = resolve(file);
  const info = await stat(path);
  if (!info.isFile() || info.size > LIUM_MAX_BYTES) throw new Error('Invalid or oversized capture file');
  const metadataInfo = await stat(sidecar(path));
  if (!metadataInfo.isFile() || metadataInfo.size > 16384) throw new Error('Invalid capture metadata size');
  const metadata = JSON.parse(await readFile(sidecar(path), 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.source !== 'lium' || metadata.sourceUrl !== LIUM_NODES_URL
    || metadata.parserVersion !== PARSER_VERSION || !/^[a-f0-9]{64}$/.test(metadata.sha256)
    || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 || metadata.bytes > LIUM_MAX_BYTES) {
    throw new Error('Invalid capture provenance metadata');
  }
  isoTime(metadata.observedAt, 'observedAt');
  const stored = await readFile(path);
  const bytes = path.endsWith('.gz') ? gunzipSync(stored, { maxOutputLength: LIUM_MAX_BYTES }) : stored;
  if (bytes.length !== metadata.bytes || digest(bytes) !== metadata.sha256) throw new Error('Capture checksum or size mismatch');
  const payload = JSON.parse(bytes.toString('utf8'));
  const parsed = parseLium(payload, metadata.observedAt);
  if (parsed.sourceUpdatedAt !== metadata.sourceUpdatedAt) throw new Error('Capture source timestamp mismatch');
  return { payload, metadata };
}

export async function captureLium({ file, directory = 'data/raw/lium', observedAt, fetchImpl = fetch,
  timeoutMs = 30000, maxBytes = LIUM_MAX_BYTES } = {}) {
  if (observedAt !== undefined) isoTime(observedAt, 'observedAt');
  if (file !== undefined && !file.endsWith('.json')) throw new Error('Lium capture output must end in .json');
  const bytes = await downloadBytes(LIUM_NODES_URL, { maxBytes: Math.min(maxBytes, LIUM_MAX_BYTES), timeoutMs, fetchImpl });
  // Receipt time, after the complete bounded response has arrived, is the observation clock.
  const receivedAt = observedAt ?? new Date().toISOString();
  const output = resolve(file ?? join(directory, `${receivedAt.replaceAll(':', '-')}.json`));
  const payload = JSON.parse(bytes.toString('utf8'));
  const parsed = parseLium(payload, receivedAt);
  const metadata = { schemaVersion: 1, source: 'lium', sourceUrl: LIUM_NODES_URL, observedAt: receivedAt,
    sha256: digest(bytes), bytes: bytes.length, sourceUpdatedAt: parsed.sourceUpdatedAt, parserVersion: PARSER_VERSION };
  await privateDirectory(dirname(output));
  // Serialize duplicate checking and publication within this capture directory.
  const lock = join(dirname(output), '.capture.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Capture directory is locked; wait for the other capture or review an interrupted capture');
    throw error;
  }
  try {
    // Same raw bytes are a replay, not a fresh observation. Verify every candidate before reuse.
    const entries = (await readdir(dirname(output))).filter(name => name.endsWith('.json.metadata.json')).sort();
    for (const entry of entries) {
      const priorPath = join(dirname(output), entry.slice(0, -'.metadata.json'.length));
      const prior = await readCapture(priorPath);
      if (prior.metadata.sha256 === metadata.sha256) return { path: priorPath, metadata: prior.metadata, reused: true };
      if (prior.metadata.sourceUpdatedAt === metadata.sourceUpdatedAt) {
        throw new Error('Different Lium bytes share a source generation timestamp; review instead of creating another capture');
      }
    }
    await publishPair(output, bytes, metadata);
    return { path: output, metadata, reused: false };
  } finally {
    await rmdir(lock);
  }
}

export async function acquireWorkloadFile(file = 'data/raw/alibaba-spot-gpu-2026/job_info_df.csv',
  { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const { WORKLOAD_SOURCE, verifyWorkloadFile } = await import('./workloads.mjs');
  const path = resolve(file);
  if (await exists(path)) return { ...(await verifyWorkloadFile(path)), reused: true };
  const bytes = await downloadBytes(WORKLOAD_SOURCE.url, { maxBytes: WORKLOAD_SOURCE.bytes, timeoutMs, fetchImpl });
  const metadata = { schemaVersion: 1, source: 'alibaba-spot-gpu-2026', sourceUrl: WORKLOAD_SOURCE.url,
    observedAt: new Date().toISOString(), sha256: digest(bytes), bytes: bytes.length,
    releaseRef: WORKLOAD_SOURCE.releaseRef, documentationUrl: WORKLOAD_SOURCE.documentationUrl,
    permissionUrl: WORKLOAD_SOURCE.permissionUrl };
  await publishPair(path, bytes, metadata, verifyWorkloadFile);
  return { ...(await verifyWorkloadFile(path)), metadata, reused: false };
}
