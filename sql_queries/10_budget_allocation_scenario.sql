-- Complex query: simulate a deterministic round-robin job shortlist under a total budget
-- and a per-organization spending cap. Skipped jobs do not consume either budget.
-- Within each organization: HP first, then relative submit time, then job ID.
-- This is a greedy COST-ONLY scenario, not an optimal scheduler or a reservation of GPUs.
-- Each job uses its cheapest exact-GPU available USD quote in the source's latest stored
-- capture, assumes gpu_request is whole-job demand, and ignores workers, billing minimums,
-- concurrent capacity, retry risk and other charges. It is not historical expenditure.
-- Edit params below. The first 500 eligible candidates are considered by default.
WITH RECURSIVE params AS (
    SELECT 1000.00::numeric AS budget_usd,
           0.25::numeric AS organization_budget_fraction,
           500::bigint AS candidate_limit
), latest_captures AS (
    SELECT o.source_name, MAX(r.observed_at) AS observed_at
    FROM rental_offers o
    JOIN rental_observations r ON r.offer_id = o.offer_id
    GROUP BY o.source_name
), rates AS (
    SELECT o.gpu_model_id, MIN(r.price_per_gpu_hour) AS lowest_rate
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
), organization_queues AS (
    SELECT j.job_id, j.organization_id, g.name AS gpu_model,
           j.gpu_request * j.duration_seconds / 3600.0 * r.lowest_rate AS scenario_cost,
           ROW_NUMBER() OVER (PARTITION BY j.organization_id
               ORDER BY CASE WHEN j.job_type = 'HP' THEN 0 ELSE 1 END,
                        j.submit_time_seconds, j.job_id) AS organization_position
    FROM workload_jobs j
    JOIN workload_gpu_types t ON t.native_gpu_name = j.native_gpu_name
    JOIN gpu_models g ON g.gpu_model_id = t.gpu_model_id
    JOIN rates r ON r.gpu_model_id = g.gpu_model_id
), ordered_candidates AS (
    SELECT q.*,
           ROW_NUMBER() OVER (ORDER BY organization_position, organization_id, job_id)
               AS position
    FROM organization_queues q
), candidates AS (
    SELECT c.*
    FROM ordered_candidates c
    CROSS JOIN params p
    WHERE c.position <= p.candidate_limit
      AND p.budget_usd >= 0
      AND p.organization_budget_fraction BETWEEN 0 AND 1
      AND p.candidate_limit > 0
), allocation AS (
    SELECT 0::bigint AS position,
           NULL::text AS job_id, NULL::text AS organization_id, NULL::text AS gpu_model,
           NULL::numeric AS scenario_cost,
           0::numeric AS spent_usd,
           '{}'::jsonb AS organization_spend,
           FALSE AS selected,
           'start'::text AS decision
    UNION ALL
    SELECT c.position, c.job_id, c.organization_id, c.gpu_model, c.scenario_cost,
           a.spent_usd + CASE WHEN d.decision = 'selected' THEN c.scenario_cost ELSE 0 END,
           CASE WHEN d.decision = 'selected'
                THEN JSONB_SET(a.organization_spend, ARRAY[c.organization_id],
                    TO_JSONB(s.organization_spent + c.scenario_cost), TRUE)
                ELSE a.organization_spend END,
           d.decision = 'selected',
           d.decision
    FROM allocation a
    JOIN candidates c ON c.position = a.position + 1
    CROSS JOIN params p
    CROSS JOIN LATERAL (
        SELECT COALESCE((a.organization_spend ->> c.organization_id)::numeric, 0)
            AS organization_spent
    ) s
    CROSS JOIN LATERAL (
        SELECT CASE
            WHEN a.spent_usd + c.scenario_cost > p.budget_usd THEN 'total_budget'
            WHEN s.organization_spent + c.scenario_cost
                > p.budget_usd * p.organization_budget_fraction THEN 'organization_cap'
            ELSE 'selected'
        END AS decision
    ) d
)
SELECT a.position, a.job_id, a.organization_id, a.gpu_model,
       ROUND(a.scenario_cost, 2) AS scenario_cost_usd,
       a.selected, a.decision,
       ROUND(a.spent_usd, 2) AS cumulative_selected_cost_usd,
       ROUND(p.budget_usd - a.spent_usd, 2) AS remaining_budget_usd,
       ROUND(COALESCE((a.organization_spend ->> a.organization_id)::numeric, 0), 2)
           AS organization_selected_cost_so_far_usd,
       ROUND(p.budget_usd * p.organization_budget_fraction, 2)
           AS organization_cap_usd
FROM allocation a
CROSS JOIN params p
WHERE a.position > 0
ORDER BY a.position;
