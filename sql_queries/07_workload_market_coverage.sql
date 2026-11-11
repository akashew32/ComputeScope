-- Complex query: which organizations have an observed rental match for all their GPU types,
-- and how much job demand remains uncovered? Aggregate before joining to avoid fan-out.
-- A match means exact hardware + priced USD quote + explicitly available in that source's
-- latest stored capture. It does not establish quantity feasibility or live availability.
-- GPU-hours assume gpu_request is the whole-job request; workers are not multiplied.
WITH latest_captures AS (
    SELECT o.source_name, MAX(r.observed_at) AS observed_at
    FROM rental_offers o
    JOIN rental_observations r ON r.offer_id = o.offer_id
    GROUP BY o.source_name
), market_by_gpu AS (
    SELECT o.gpu_model_id,
           COUNT(*) AS quoted_offers,
           COUNT(DISTINCT p.provider_id) AS quoted_providers
    FROM rental_offers o
    JOIN providers p ON p.provider_id = o.provider_id
    JOIN rental_observations r ON r.offer_id = o.offer_id
    JOIN latest_captures c
      ON c.source_name = o.source_name AND c.observed_at = r.observed_at
    WHERE o.gpu_model_id IS NOT NULL
      AND r.available IS TRUE
      AND r.currency = 'USD'
      AND r.price_per_gpu_hour IS NOT NULL
      AND o.revision = (
          SELECT MAX(x.revision) FROM rental_offers x
          WHERE x.source_name = o.source_name AND x.source_offer_id = o.source_offer_id
      )
    GROUP BY o.gpu_model_id
), demand_by_type AS (
    SELECT j.organization_id, j.native_gpu_name, t.gpu_model_id,
           COUNT(*) AS jobs,
           SUM(j.gpu_request * j.duration_seconds / 3600.0) AS gpu_hours
    FROM workload_jobs j
    JOIN workload_gpu_types t ON t.native_gpu_name = j.native_gpu_name
    GROUP BY j.organization_id, j.native_gpu_name, t.gpu_model_id
)
SELECT d.organization_id,
       SUM(d.jobs)::bigint AS total_jobs,
       COALESCE(SUM(d.jobs) FILTER (WHERE m.gpu_model_id IS NOT NULL), 0)::bigint
           AS matched_jobs,
       ROUND(100.0 * COALESCE(SUM(d.jobs) FILTER (WHERE m.gpu_model_id IS NOT NULL), 0)
           / NULLIF(SUM(d.jobs), 0), 2) AS matched_job_pct,
       ROUND(SUM(d.gpu_hours), 4) AS scenario_total_gpu_hours,
       ROUND(100.0 * COALESCE(SUM(d.gpu_hours)
           FILTER (WHERE m.gpu_model_id IS NOT NULL), 0)
           / NULLIF(SUM(d.gpu_hours), 0), 2) AS matched_gpu_hour_pct,
       BOOL_AND(m.gpu_model_id IS NOT NULL) AS all_requested_types_have_a_quote,
       ARRAY_AGG(d.native_gpu_name ORDER BY d.native_gpu_name)
           FILTER (WHERE d.gpu_model_id IS NULL) AS unmapped_native_gpu_types,
       ARRAY_AGG(d.native_gpu_name ORDER BY d.native_gpu_name)
           FILTER (WHERE d.gpu_model_id IS NOT NULL AND m.gpu_model_id IS NULL)
           AS mapped_types_without_available_usd_quotes,
       MIN(m.quoted_offers) FILTER (WHERE m.gpu_model_id IS NOT NULL)
           AS fewest_offers_for_a_matched_type,
       MIN(m.quoted_providers) FILTER (WHERE m.gpu_model_id IS NOT NULL)
           AS fewest_providers_for_a_matched_type
FROM demand_by_type d
LEFT JOIN market_by_gpu m ON m.gpu_model_id = d.gpu_model_id
GROUP BY d.organization_id
ORDER BY matched_job_pct, total_jobs DESC, d.organization_id;
