import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { acquireWorkloadFile, captureLium, downloadBytes, readCapture } from '../lib/acquisition.mjs';
import { LIUM_NODES_URL } from '../lib/lium.mjs';

const observedAt = '2026-11-11T12:00:00.000Z';
const payload = { generated_at: '2026-11-11T11:59:00.000Z', count: 1, nodes: [{ id: 'node-1',
  gpu_model: 'A100-SXM4-80GB', gpu_count: 8, gpu_memory_gb: 80, price_per_gpu_hour: 1,
  price_per_node_hour: 8, available_now: true, available_gpu_count: 8 }] };
const respond = value => async (url, options) => {
  assert.equal(url, LIUM_NODES_URL);
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  return new Response(JSON.stringify(value), { status: 200 });
};

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), 'computescope-acquisition-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('capture preserves provenance, permissions and the original observation on identical replay', async t => {
  const dir = await directory(t);
  const first = await captureLium({ directory: dir, observedAt, fetchImpl: respond(payload) });
  assert.equal(first.reused, false);
  // Windows uses inherited ACLs, not POSIX permission bits.
  if (process.platform !== 'win32') {
    assert.equal((await stat(first.path)).mode & 0o777, 0o600);
    assert.equal((await stat(`${first.path}.metadata.json`)).mode & 0o777, 0o600);
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
  }
  assert.deepEqual((await readCapture(first.path)).payload, payload);
  const replay = await captureLium({ directory: dir, observedAt: '2026-11-11T12:01:00.000Z', fetchImpl: respond(payload) });
  assert.equal(replay.reused, true);
  assert.equal(replay.path, first.path);
  assert.equal(replay.metadata.observedAt, observedAt);
  assert.equal((await readdir(dir)).length, 2);
});

test('replay rejects changed raw bytes and altered provenance', async t => {
  const dir = await directory(t);
  const result = await captureLium({ directory: dir, observedAt, fetchImpl: respond(payload) });
  const original = await readFile(result.path);
  await writeFile(result.path, Buffer.concat([original, Buffer.from(' ')]));
  await assert.rejects(readCapture(result.path), /provenance|checksum|size/);
  await writeFile(result.path, original);
  const metadata = { ...result.metadata, sourceUrl: 'https://example.com/not-the-source' };
  await writeFile(`${result.path}.metadata.json`, JSON.stringify(metadata));
  await assert.rejects(readCapture(result.path), /provenance/);
});

test('compressed captures preserve the original bytes and reject altered data', async t => {
  const dir = await directory(t);
  const capture = await captureLium({ directory: dir, observedAt, fetchImpl: respond(payload) });
  const compressed = `${capture.path}.gz`;
  const original = await readFile(capture.path);
  await writeFile(compressed, gzipSync(original));
  await writeFile(`${compressed}.metadata.json`, await readFile(`${capture.path}.metadata.json`));
  assert.deepEqual(await readCapture(compressed), await readCapture(capture.path));
  await writeFile(compressed, gzipSync(Buffer.concat([original, Buffer.from(' ')])));
  await assert.rejects(readCapture(compressed), /checksum|size/);
});

test('source microseconds survive replay, and the default observation clock follows receipt', async t => {
  const dir = await directory(t);
  let responseTime;
  const result = await captureLium({ directory: dir, fetchImpl: async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
    responseTime = Date.now();
    const source = new Date(responseTime - 1000).toISOString().replace(/\d{3}Z$/, '123456Z');
    return new Response(JSON.stringify({ ...payload, generated_at: source }));
  } });
  assert.ok(Date.parse(result.metadata.observedAt) >= responseTime);
  assert.match(result.metadata.sourceUpdatedAt, /\.123456Z$/);
  assert.deepEqual((await readCapture(result.path)).metadata, result.metadata);
});

test('changed payload with the same generated_at fails without writing another capture', async t => {
  const dir = await directory(t);
  await captureLium({ directory: dir, observedAt, fetchImpl: respond(payload) });
  const changed = structuredClone(payload);
  changed.nodes[0].available_now = false;
  changed.nodes[0].available_gpu_count = 0;
  await assert.rejects(captureLium({ directory: dir, observedAt: '2026-11-11T12:01:00.000Z', fetchImpl: respond(changed) }), /generation timestamp/);
  assert.equal((await readdir(dir)).length, 2);
});

test('invalid feeds never publish raw files or sidecars', async t => {
  const dir = await directory(t);
  await assert.rejects(captureLium({ directory: dir, observedAt, fetchImpl: respond({ nodes: [] }) }), /generated_at/);
  assert.deepEqual(await readdir(dir), []);
});

test('bounded downloads reject HTTP errors, redirects, oversized headers and streamed overflow', async () => {
  const url = 'https://example.com/source';
  await assert.rejects(downloadBytes(url, { maxBytes: 2, fetchImpl: async () => new Response('bad', { status: 503 }) }), /HTTP 503/);
  await assert.rejects(downloadBytes(url, { maxBytes: 2, fetchImpl: async () => new Response(null, { status: 302, headers: { location: '/other' } }) }), /redirected/);
  await assert.rejects(downloadBytes(url, { maxBytes: 2, fetchImpl: async () => new Response('a', { headers: { 'content-length': '3' } }) }), /Content-Length/);
  await assert.rejects(downloadBytes(url, { maxBytes: 2, fetchImpl: async () => new Response('abc') }), /byte limit/);
});

test('download deadline terminates an unresponsive fetch', async () => {
  await assert.rejects(downloadBytes('https://example.com/source', {
    maxBytes: 2, timeoutMs: 10, fetchImpl: async () => new Promise(() => {}),
  }), /timed out/);
});

test('capture will not replace an occupied output filename', async t => {
  const dir = await directory(t);
  const file = join(dir, 'occupied.json');
  await writeFile(file, 'keep me');
  await assert.rejects(captureLium({ file, observedAt, fetchImpl: respond(payload) }), { code: 'EEXIST' });
  assert.equal(await readFile(file, 'utf8'), 'keep me');
  assert.deepEqual(await readdir(dir), ['occupied.json']);
});

test('workload acquisition validates pinned bytes before publishing', async t => {
  const dir = await directory(t);
  const file = join(dir, 'jobs.csv');
  await assert.rejects(acquireWorkloadFile(file, { fetchImpl: async () => new Response('wrong pinned contents') }), /size|byte|checksum|SHA/i);
  assert.deepEqual(await readdir(dir), []);
});
