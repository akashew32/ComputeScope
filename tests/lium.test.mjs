import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parseLium, importLium, EXACT_A100_NAME } from '../lib/lium.mjs';

const time = '2026-11-11T20:00:00.000Z';
const later = '2026-11-11T20:15:00.000Z';
const node = {
  id: 'synthetic-node', gpu_model: 'A100-SXM4-80GB', gpu_count: 4, gpu_memory_gb: 80,
  price_per_gpu_hour: 2, price_per_node_hour: 8, available_now: true,
  available_gpu_count: 4, tier: 'secure', region: 'synthetic-region',
};
const payload = (nodes = [node]) => ({ generated_at: time, count: nodes.length, nodes });

test('normalizes units, explicit exact hardware, and unknown availability without inventing stock', () => {
  const captured = parseLium(payload([{ ...node, available_now: null }]), time);
  assert.equal(captured.offers[0].gpuModelName, EXACT_A100_NAME);
  assert.equal(captured.offers[0].pricePerGpuHour, '2.000000');
  assert.equal(captured.offers[0].available, null);
  assert.equal(captured.offers[0].rentalMode, 'on-demand');
  assert.equal(parseLium(payload([{ ...node, price_per_gpu_hour: null }]), time).offers[0].pricePerGpuHour, '2.000000');
});

test('ambiguous or conflicting hardware remains unmapped', () => {
  for (const gpu_model of ['A100', 'A100 PCIe 80GB', 'A100 SXM4', 'A800-SXM4-80GB']) {
    assert.equal(parseLium(payload([{ ...node, gpu_model }]), time).offers[0].gpuModelName, null);
  }
  assert.equal(parseLium(payload([{ ...node, gpu_memory_gb: 40 }]), time).offers[0].gpuModelName, null);
  assert.equal(parseLium(payload([{ ...node, gpu_model: 'NVIDIA A100 SXM4 80GB' }]), time).offers[0].gpuModelName, EXACT_A100_NAME);
});

test('contradictory stock evidence becomes unknown; no price becomes null', () => {
  for (const row of [
    { ...node, available_now: false },
    { ...node, available_gpu_count: 0 },
    { ...node, available_gpu_count: 5 },
  ]) assert.equal(parseLium(payload([row]), time).offers[0].available, null);
  const missing = parseLium(payload([{ ...node, price_per_gpu_hour: null, price_per_node_hour: null }]), time);
  assert.equal(missing.offers[0].pricePerGpuHour, null);
  assert.equal(missing.qualityCounts.missing_price, 1);
});

test('derived per-GPU prices round to the six decimal places stored by the schema', () => {
  const quote = total => parseLium(payload([{
    ...node, gpu_count: 3, available_gpu_count: 3, price_per_gpu_hour: null, price_per_node_hour: total,
  }]), time).offers[0].pricePerGpuHour;
  assert.equal(quote(1), '0.333333');
  assert.equal(quote(2), '0.666667');
  assert.equal(quote(0), '0.000000');
});

test('rejects malformed envelopes, duplicate identities, invalid numbers and price disagreements', () => {
  for (const bad of [
    {}, { ...payload(), generated_at: 'yesterday' },
    { ...payload(), generated_at: '2026-11-11T20:06:00Z' },
    { ...payload(), count: 3 }, payload([node, node]),
    payload([{ ...node, gpu_count: 0 }]), payload([{ ...node, gpu_count: 1.5 }]),
    payload([{ ...node, price_per_gpu_hour: Infinity }]),
    payload([{ ...node, price_per_gpu_hour: true }]),
    payload([{ ...node, price_per_gpu_hour: '' }]),
    payload([{ ...node, price_per_node_hour: 9 }]),
    payload([{ ...node, price_per_gpu_hour: 1000000, price_per_node_hour: null }]),
    payload([{ ...node, available_now: 'true' }]),
  ]) assert.throws(() => parseLium(bad, time));
  assert.throws(() => parseLium(payload(), '2026-11-11 20:00:00'));
});

test('empty valid snapshots do not manufacture unavailable rows', () => {
  assert.deepEqual(parseLium(payload([]), time).offers, []);
});

test('retains source timestamp microseconds and rejects normalized invalid dates', () => {
  const capture = parseLium({ ...payload(), generated_at: '2026-11-11T15:00:00.123456-05:00' }, later);
  assert.equal(capture.sourceUpdatedAt, '2026-11-11T20:00:00.123456Z');
  assert.throws(() => parseLium({ ...payload(), generated_at: '2026-02-30T20:00:00Z' }, time));
});

test('transactional import preserves revisions and historical replay, rejects conflicts, and rolls back', {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `lium_test_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(await readFile(new URL('../schema.sql', import.meta.url), 'utf8'));
    assert.equal((await importLium(client, payload(), { observedAt: time })).inserted, 1);
    assert.equal((await importLium(client, payload(), { observedAt: time })).replayed, 1);
    const changed = payload([{ ...node, gpu_count: 8, price_per_node_hour: 16 }]);
    assert.equal((await importLium(client, changed, { observedAt: later })).revisions, 1);
    assert.equal((await importLium(client, payload(), { observedAt: time })).replayed, 1);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM rental_offers')).rows[0].count, 2);
    await assert.rejects(importLium(client, payload([{ ...node, price_per_gpu_hour: 3, price_per_node_hour: 12 }]), { observedAt: time }), /Conflicting replay/);
    await assert.rejects(importLium(client, payload(), { observedAt: '2026-11-11T20:10:00Z' }), /Out-of-order/);
    // The first row would insert; conflict in the second must roll the whole transaction back.
    await assert.rejects(importLium(client, payload([
      { ...node, id: 'must-rollback' }, { ...node, price_per_gpu_hour: 3, price_per_node_hour: 12 },
    ]), { observedAt: time }), /Conflicting replay/);
    assert.equal((await client.query("SELECT count(*)::int AS count FROM rental_offers WHERE source_offer_id='must-rollback'")).rows[0].count, 0);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM rental_observations')).rows[0].count, 2);
    await importLium(client, payload([]), { observedAt: later });
    assert.equal((await client.query('SELECT bool_and(available) AS available FROM rental_observations')).rows[0].available, true);
  } finally {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  }
});
