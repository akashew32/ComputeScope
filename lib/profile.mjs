export async function profileData(client) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const counts = (await client.query(`SELECT
      (SELECT count(*)::int FROM providers) AS providers,
      (SELECT count(*)::int FROM gpu_models) AS gpu_models,
      (SELECT count(*)::int FROM rental_offers) AS offer_revisions,
      (SELECT count(DISTINCT (source_name,source_offer_id))::int FROM rental_offers) AS distinct_source_offers,
      (SELECT count(*)::int FROM rental_observations) AS rental_observations,
      (SELECT count(DISTINCT observed_at)::int FROM rental_observations) AS rental_capture_times,
      (SELECT count(*)::int FROM workload_jobs) AS workload_jobs,
      (SELECT count(DISTINCT organization_id)::int FROM workload_jobs) AS workload_organizations,
      (SELECT count(*)::int FROM workload_gpu_types) AS workload_gpu_types`)).rows[0];
    const workloadTypes = (await client.query(`SELECT t.native_gpu_name, g.name AS exact_gpu_name,
      t.mapping_source_url, count(j.job_id)::int AS jobs FROM workload_gpu_types t
      LEFT JOIN gpu_models g USING (gpu_model_id) LEFT JOIN workload_jobs j USING (native_gpu_name)
      GROUP BY t.native_gpu_name,g.name,t.mapping_source_url ORDER BY t.native_gpu_name`)).rows;
    const rentals = (await client.query(`SELECT min(observed_at) AS first_observed_at,
      max(observed_at) AS last_observed_at,
      count(*) FILTER (WHERE available IS TRUE)::int AS available,
      count(*) FILTER (WHERE available IS FALSE)::int AS unavailable,
      count(*) FILTER (WHERE available IS NULL)::int AS unknown_availability,
      count(*) FILTER (WHERE price_per_gpu_hour IS NULL)::int AS missing_prices,
      count(*) FILTER (WHERE gpu_model_id IS NOT NULL)::int AS exactly_mapped_observations
      FROM rental_observations JOIN rental_offers USING (offer_id)`)).rows[0];
    const overlap = (await client.query(`SELECT count(*)::int AS jobs_with_any_exact_rental_match
      FROM workload_jobs j JOIN workload_gpu_types t USING (native_gpu_name)
      WHERE t.gpu_model_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM rental_offers o JOIN rental_observations r USING (offer_id)
        WHERE o.gpu_model_id=t.gpu_model_id AND r.currency='USD' AND r.price_per_gpu_hour IS NOT NULL)`)).rows[0];
    await client.query('COMMIT');
    return { counts, workloadTypes, rentals, overlap,
      interpretation: {
        overlap: 'Any observed priced exact-hardware match; does not establish freshness, availability, quantity, or feasibility.',
        workloadTime: 'relative seconds, not UTC',
        workloadRequestScope: 'unresolved; workers not multiplied',
        rentalDatasetMeets100kRecommendation: counts.rental_observations >= 100000,
      } };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
}
