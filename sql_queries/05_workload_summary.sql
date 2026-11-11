-- Smaller query: summarize trace demand by native GPU label and job priority.
-- GPU-hours assume gpu_request is the whole-job request; workers are not multiplied.
SELECT j.native_gpu_name,
       g.name AS exact_gpu_model,
       j.job_type AS trace_priority,
       COUNT(*) AS jobs,
       COUNT(DISTINCT j.organization_id) AS organizations,
       ROUND(AVG(j.gpu_request), 4) AS mean_requested_gpus,
       ROUND(AVG(j.duration_seconds) / 3600.0, 4) AS mean_duration_hours,
       ROUND((PERCENTILE_CONT(0.95) WITHIN GROUP
           (ORDER BY j.duration_seconds) / 3600.0)::numeric, 4) AS p95_duration_hours,
       ROUND(SUM(j.gpu_request * j.duration_seconds / 3600.0), 4)
           AS scenario_requested_gpu_hours
FROM workload_jobs j
JOIN workload_gpu_types t ON t.native_gpu_name = j.native_gpu_name
LEFT JOIN gpu_models g ON g.gpu_model_id = t.gpu_model_id
GROUP BY j.native_gpu_name, g.name, j.job_type
ORDER BY scenario_requested_gpu_hours DESC, j.native_gpu_name, j.job_type;
