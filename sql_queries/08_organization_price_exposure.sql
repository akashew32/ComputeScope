-- Complex query: compare organizations' cheapest, median-quote and highest-quote cost
-- scenarios, and measure how concentrated cheapest-scenario spending is in their top 10% jobs.
-- Prices come from each source's latest stored capture, not the historical job's execution date.
-- gpu_request is assumed to be the whole-job request. Fractional requests are priced linearly;
-- worker multiplication, minimum billing, quantity constraints and other charges are excluded.
WITH latest_captures AS (
    SELECT o.source_name, MAX(r.observed_at) AS observed_at
    FROM rental_offers o
    JOIN rental_observations r ON r.offer_id = o.offer_id
    GROUP BY o.source_name
), rates AS (
    SELECT o.gpu_model_id,
           MIN(r.price_per_gpu_hour) AS lowest_rate,
           (PERCENTILE_CONT(0.5) WITHIN GROUP
               (ORDER BY r.price_per_gpu_hour))::numeric AS median_rate,
           MAX(r.price_per_gpu_hour) AS highest_rate
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
), job_scenarios AS (
    SELECT j.job_id, j.organization_id,
           j.gpu_request * j.duration_seconds / 3600.0 * r.lowest_rate AS lowest_cost,
           j.gpu_request * j.duration_seconds / 3600.0 * r.median_rate AS median_quote_cost,
           j.gpu_request * j.duration_seconds / 3600.0 * r.highest_rate AS highest_cost
    FROM workload_jobs j
    JOIN workload_gpu_types t ON t.native_gpu_name = j.native_gpu_name
    LEFT JOIN rates r ON r.gpu_model_id = t.gpu_model_id
), ranked_priced_jobs AS (
    SELECT s.*,
           ROW_NUMBER() OVER (PARTITION BY organization_id
               ORDER BY lowest_cost DESC, job_id) AS cost_rank,
           COUNT(*) OVER (PARTITION BY organization_id) AS priced_jobs
    FROM job_scenarios s
    WHERE lowest_cost IS NOT NULL
), cost_summary AS (
    SELECT organization_id,
           COUNT(*) AS priced_jobs,
           SUM(lowest_cost) AS lowest_total,
           SUM(median_quote_cost) AS median_quote_total,
           SUM(highest_cost) AS highest_total,
           (PERCENTILE_CONT(0.95) WITHIN GROUP
               (ORDER BY lowest_cost))::numeric AS p95_job_cost,
           SUM(lowest_cost) FILTER (WHERE cost_rank <= CEIL(priced_jobs * 0.10))
               AS top_tenth_cost
    FROM ranked_priced_jobs
    GROUP BY organization_id
), organization_totals AS (
    SELECT organization_id, COUNT(*) AS total_jobs
    FROM job_scenarios
    GROUP BY organization_id
)
SELECT t.organization_id, t.total_jobs,
       COALESCE(c.priced_jobs, 0) AS priced_jobs,
       t.total_jobs - COALESCE(c.priced_jobs, 0) AS unpriced_jobs,
       ROUND(100.0 * COALESCE(c.priced_jobs, 0) / t.total_jobs, 2) AS priced_job_pct,
       ROUND(c.lowest_total, 2) AS lowest_quote_scenario_usd,
       ROUND(c.median_quote_total, 2) AS median_quote_scenario_usd,
       ROUND(c.highest_total, 2) AS highest_quote_scenario_usd,
       ROUND(c.highest_total - c.lowest_total, 2) AS quote_spread_scenario_usd,
       ROUND(c.p95_job_cost, 2) AS p95_lowest_quote_job_usd,
       ROUND(100.0 * c.top_tenth_cost / NULLIF(c.lowest_total, 0), 2)
           AS top_10_pct_jobs_share_of_scenario_spend_pct
FROM organization_totals t
LEFT JOIN cost_summary c ON c.organization_id = t.organization_id
ORDER BY c.lowest_total DESC NULLS LAST, t.organization_id;
