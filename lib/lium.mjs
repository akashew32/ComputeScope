// Adapted with Codex assistance from dalessioso/cis-5500's Lium adapter.
// The six-table milestone schema has its own transactional persistence below.
// Source field definitions: https://docs.lium.io/developers/public-nodes-feed
export const LIUM_NODES_URL = 'https://lium.io/api/public/v1/nodes?include_rented=true';
export const EXACT_A100_NAME = 'NVIDIA A100 SXM4 80GB';

function timestamp(value, label) {
  const parts = typeof value === 'string'
    ? value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:\d{2})$/) : null;
  if (!parts || !Number.isFinite(Date.parse(value)) || Number(parts[2]) < 1 || Number(parts[2]) > 12
    || Number(parts[3]) < 1 || Number(parts[3]) > new Date(Date.UTC(Number(parts[1]), Number(parts[2]), 0)).getUTCDate()
    || Number(parts[4]) > 23 || Number(parts[5]) > 59 || Number(parts[6]) > 59) {
    throw new Error(`Invalid ${label}: require an ISO timestamp with timezone`);
  }
  // Date supplies UTC calendar conversion, while the source's PostgreSQL microseconds survive.
  return `${new Date(value).toISOString().slice(0, 19)}.${(parts[7] ?? '').padEnd(6, '0')}Z`;
}

function text(value, label, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 1000 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

function number(value, label, { integer = false, positive = false, optional = false } = {}) {
  if (optional && (value === undefined || value === null)) return null;
  // Accept decimal strings used by some JSON serializers, never blanks or booleans.
  if ((typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)))
    || !Number.isFinite(Number(value)) || Number(value) < 0
    || (positive && Number(value) === 0)
    || (integer && (!Number.isSafeInteger(Number(value)) || Number(value) > 2147483647))) {
    throw new Error(`Invalid ${label}`);
  }
  return Number(value);
}

function exactGpuName(nativeName, memory) {
  // Deliberately narrow reviewed aliases: neither A100 family nor PCIe is exact SXM4.
  const compact = nativeName.toUpperCase().replace(/^NVIDIA\s+/, '').replace(/[\s_-]+/g, '');
  if (compact !== 'A100SXM480GB' || (memory !== null && memory !== 80)) return null;
  return EXACT_A100_NAME;
}

/** Validate one captured feed. Invalid rows reject the whole capture, never partial success. */
export function parseLium(payload, observedAt) {
  const observed = timestamp(observedAt, 'observedAt');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.nodes)) {
    throw new Error('Lium response must contain a nodes array');
  }
  const sourceUpdatedAt = timestamp(payload.generated_at, 'generated_at');
  if (Date.parse(sourceUpdatedAt) > Date.parse(observed) + 300000) {
    throw new Error('Lium generated_at exceeds observedAt by more than five minutes');
  }
  if (payload.count !== undefined && payload.count !== null
    && number(payload.count, 'count', { integer: true }) !== payload.nodes.length) {
    throw new Error('Lium declared count does not match nodes length');
  }
  const ids = new Set();
  const qualityCounts = {};
  const offers = payload.nodes.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Invalid Lium node ${index}`);
    const sourceOfferId = text(row.id, `node ${index} id`);
    if (ids.has(sourceOfferId)) throw new Error(`Duplicate Lium node id: ${sourceOfferId}`);
    ids.add(sourceOfferId);
    const nativeGpuName = text(row.gpu_model, `node ${index} gpu_model`);
    const gpuCount = number(row.gpu_count, `node ${index} gpu_count`, { integer: true, positive: true });
    const memory = number(row.gpu_memory_gb, `node ${index} gpu_memory_gb`, { positive: true, optional: true });
    const perGpu = number(row.price_per_gpu_hour, `node ${index} price_per_gpu_hour`, { optional: true });
    const perNode = number(row.price_per_node_hour, `node ${index} price_per_node_hour`, { optional: true });
    if (perGpu !== null && perNode !== null && Math.abs(perGpu * gpuCount - perNode) > 0.00001) {
      throw new Error(`Lium node ${sourceOfferId} has conflicting per-GPU and per-node prices`);
    }
    const price = perGpu ?? (perNode === null ? null : perNode / gpuCount);
    // Match numeric(12,6) explicitly and publish the rounding rule in the contract.
    const pricePerGpuHour = price === null ? null : price.toFixed(6);
    if (pricePerGpuHour !== null && (!Number.isFinite(price) || Number(pricePerGpuHour) >= 1000000)) {
      throw new Error(`Lium node ${sourceOfferId} price exceeds numeric(12,6)`);
    }
    const availableCount = number(row.available_gpu_count, `node ${index} available_gpu_count`, { integer: true, optional: true });
    if (row.available_now !== undefined && row.available_now !== null && typeof row.available_now !== 'boolean') {
      throw new Error(`Invalid node ${index} available_now`);
    }
    const qualityFlags = [];
    if (availableCount !== null && availableCount > gpuCount) qualityFlags.push('capacity_exceeds_total');
    if ((row.available_now === false && availableCount !== null && availableCount > 0)
      || (row.available_now === true && availableCount === 0)) qualityFlags.push('availability_conflict');
    if (price === null) qualityFlags.push('missing_price');
    const gpuModelName = exactGpuName(nativeGpuName, memory);
    if (gpuModelName === null) qualityFlags.push('unmapped_gpu');
    qualityFlags.forEach(flag => { qualityCounts[flag] = (qualityCounts[flag] ?? 0) + 1; });
    return {
      sourceOfferId, nativeGpuName, gpuModelName, gpuCount,
      rentalMode: row.tier === 'spot' ? 'spot' : row.tier === 'secure' ? 'on-demand' : null,
      region: text(row.region, `node ${index} region`, true),
      pricePerGpuHour, currency: 'USD',
      available: qualityFlags.includes('capacity_exceeds_total') || qualityFlags.includes('availability_conflict')
        ? null : (row.available_now ?? null),
      qualityFlags,
    };
  });
  return { sourceUrl: LIUM_NODES_URL, observedAt: observed, sourceUpdatedAt, offers, qualityCounts };
}

function sameIdentity(stored, offer, providerId, gpuModelId) {
  return String(stored.provider_id) === String(providerId)
    && (stored.gpu_model_id === null ? gpuModelId === null : String(stored.gpu_model_id) === String(gpuModelId))
    && stored.source_url === LIUM_NODES_URL
    && stored.native_gpu_name === offer.nativeGpuName
    && stored.gpu_count === offer.gpuCount
    && stored.rental_mode === offer.rentalMode
    && stored.region === offer.region;
}

/** Import one captured response atomically. Caller supplies a dedicated connected pg client. */
export async function importLium(client, payload, { observedAt } = {}) {
  const capture = parseLium(payload, observedAt);
  const report = {
    source: 'lium', sourceUrl: LIUM_NODES_URL, observedAt: capture.observedAt,
    sourceUpdatedAt: capture.sourceUpdatedAt, received: capture.offers.length,
    inserted: 0, replayed: 0, revisions: 0, qualityCounts: capture.qualityCounts,
  };
  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('computescope:lium-import'))");
    await client.query('INSERT INTO providers (name,website) VALUES ($1,$2) ON CONFLICT (name) DO NOTHING', ['Lium', 'https://lium.io']);
    const providerId = (await client.query('SELECT provider_id FROM providers WHERE name=$1', ['Lium'])).rows[0].provider_id;
    let a100Id = null;
    if (capture.offers.some(offer => offer.gpuModelName !== null)) {
      await client.query('INSERT INTO gpu_models (name,vram_gb) VALUES ($1,80) ON CONFLICT (name) DO NOTHING', [EXACT_A100_NAME]);
      const model = (await client.query('SELECT gpu_model_id,vram_gb FROM gpu_models WHERE name=$1', [EXACT_A100_NAME])).rows[0];
      if (Number(model.vram_gb) !== 80) throw new Error('Existing exact A100 model has inconsistent VRAM');
      a100Id = model.gpu_model_id;
    }
    for (const offer of capture.offers) {
      const gpuModelId = offer.gpuModelName === null ? null : a100Id;
      // Check replay before consulting the newest revision, so replaying A after A->B is safe.
      const replay = (await client.query(`SELECT o.*, r.source_updated_at, r.price_per_gpu_hour,
          r.currency, r.available,
          (r.source_updated_at IS NOT DISTINCT FROM $3::timestamptz
            AND r.price_per_gpu_hour IS NOT DISTINCT FROM $4::numeric
            AND r.currency IS NOT DISTINCT FROM $5::char(3)
            AND r.available IS NOT DISTINCT FROM $6::boolean) AS same_observation
        FROM rental_offers o JOIN rental_observations r USING (offer_id)
        WHERE o.source_name='lium' AND o.source_offer_id=$1 AND r.observed_at=$2::timestamptz`,
      [offer.sourceOfferId, capture.observedAt, capture.sourceUpdatedAt, offer.pricePerGpuHour, offer.currency, offer.available])).rows;
      if (replay.length) {
        if (replay.length !== 1 || !replay[0].same_observation || !sameIdentity(replay[0], offer, providerId, gpuModelId)) {
          throw new Error(`Conflicting replay for Lium node ${offer.sourceOfferId}`);
        }
        report.replayed += 1;
        continue;
      }
      const newerCapture = (await client.query(`SELECT max(r.observed_at) > $2::timestamptz AS newer
        FROM rental_offers o JOIN rental_observations r USING (offer_id)
        WHERE o.source_name='lium' AND o.source_offer_id=$1`, [offer.sourceOfferId, capture.observedAt])).rows[0].newer;
      if (newerCapture) {
        throw new Error(`Out-of-order new capture for Lium node ${offer.sourceOfferId}; import captures chronologically`);
      }
      const latest = (await client.query(`SELECT * FROM rental_offers
        WHERE source_name='lium' AND source_offer_id=$1 ORDER BY revision DESC LIMIT 1`, [offer.sourceOfferId])).rows[0];
      let offerId;
      if (latest && sameIdentity(latest, offer, providerId, gpuModelId)) offerId = latest.offer_id;
      else {
        const revision = latest ? latest.revision + 1 : 1;
        offerId = (await client.query(`INSERT INTO rental_offers
          (provider_id,gpu_model_id,source_name,source_offer_id,source_url,native_gpu_name,gpu_count,rental_mode,region,revision)
          VALUES ($1,$2,'lium',$3,$4,$5,$6,$7,$8,$9) RETURNING offer_id`,
        [providerId, gpuModelId, offer.sourceOfferId, LIUM_NODES_URL, offer.nativeGpuName,
          offer.gpuCount, offer.rentalMode, offer.region, revision])).rows[0].offer_id;
        report.revisions += 1;
      }
      await client.query(`INSERT INTO rental_observations
        (offer_id,observed_at,source_updated_at,price_per_gpu_hour,currency,available)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [offerId, capture.observedAt, capture.sourceUpdatedAt, offer.pricePerGpuHour, offer.currency, offer.available]);
      report.inserted += 1;
    }
    await client.query('COMMIT');
    return report;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
