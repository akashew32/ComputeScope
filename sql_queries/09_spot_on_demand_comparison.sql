-- Complex query: compare spot and on-demand scenarios on the SAME matched workload subset,
-- while exposing organizations' mode-specific coverage gaps instead of dropping them.
-- Trace job_type is priority, not rental mode. Spot interruption/retry risk is not modeled.
-- Latest stored available USD quotes, exact GPU mapping, whole-job gpu_request assumption;
-- no worker multiplication, quantity/billing feasibility claim or historical spending claim.
WITH latest_captures AS (
    SELECT o.source_name, MAX(r.observed_at) AS observed_at
    FROM rental_offers o
    JOIN rental_observations r ON r.offer_id = o.offer_id
    GROUP BY o.source_name
), mode_rates AS (
    SELECT o.gpu_model_id,
           MIN(r.price_per_gpu_hour) FILTER (WHERE o.rental_mode = 'spot') AS spot_rate,
           MIN(r.price_per_gpu_hour) FILTER (WHERE o.rental_mode = 'on-demand')
               AS on_demand_rate
    FROM rental_offers o
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
), demand AS (
    SELECT j.organization_id, j.native_gpu_name, t.gpu_model_id,
           COUNT(*) AS jobs,
           SUM(j.gpu_request * j.duration_seconds / 3600.0) AS gpu_hours
    FROM workload_jobs j
    JOIN workload_gpu_types t ON t.native_gpu_name = j.native_gpu_name
    GROUP BY j.organization_id, j.native_gpu_name, t.gpu_model_id
), comparison AS (
    SELECT d.*, r.spot_rate, r.on_demand_rate,
           r.spot_rate IS NOT NULL AND r.on_demand_rate IS NOT NULL AS both_modes
    FROM demand d
    LEFT JOIN mode_rates r ON r.gpu_model_id = d.gpu_model_id
), organization_comparison AS (
    SELECT organization_id,
           SUM(jobs)::bigint AS total_jobs,
           COALESCE(SUM(jobs) FILTER (WHERE both_modes), 0)::bigint AS comparable_jobs,
           COALESCE(SUM(jobs) FILTER
               (WHERE spot_rate IS NOT NULL AND on_demand_rate IS NULL), 0)::bigint
               AS spot_only_jobs,
           COALESCE(SUM(jobs) FILTER
               (WHERE spot_rate IS NULL AND on_demand_rate IS NOT NULL), 0)::bigint
               AS on_demand_only_jobs,
           COALESCE(SUM(jobs) FILTER
               (WHERE spot_rate IS NULL AND on_demand_rate IS NULL), 0)::bigint
               AS jobs_with_neither_mode,
           BOOL_AND(both_modes) AS both_modes_cover_every_requested_type,
           SUM(gpu_hours * spot_rate) FILTER (WHERE both_modes) AS comparable_spot_cost,
           SUM(gpu_hours * on_demand_rate) FILTER (WHERE both_modes)
               AS comparable_on_demand_cost,
           ARRAY_AGG(native_gpu_name ORDER BY native_gpu_name)
               FILTER (WHERE NOT both_modes) AS types_missing_a_comparable_mode
    FROM comparison
    GROUP BY organization_id
)
SELECT organization_id, total_jobs, comparable_jobs,
       ROUND(100.0 * comparable_jobs / total_jobs, 2) AS comparable_job_pct,
       spot_only_jobs, on_demand_only_jobs, jobs_with_neither_mode,
       both_modes_cover_every_requested_type, types_missing_a_comparable_mode,
       ROUND(comparable_spot_cost, 2) AS comparable_spot_scenario_usd,
       ROUND(comparable_on_demand_cost, 2) AS comparable_on_demand_scenario_usd,
       ROUND(comparable_on_demand_cost - comparable_spot_cost, 2)
           AS spot_savings_scenario_usd,
       ROUND(100.0 * (comparable_on_demand_cost - comparable_spot_cost)
           / NULLIF(comparable_on_demand_cost, 0), 2) AS spot_savings_pct
FROM organization_comparison
ORDER BY spot_savings_scenario_usd DESC NULLS LAST, organization_id;
