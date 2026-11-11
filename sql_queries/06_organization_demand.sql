-- Smaller query: compare organizations' workload volume, priority mix and demand.
-- GPU-hours assume gpu_request is the whole-job request; trace times are relative seconds.
SELECT organization_id,
       COUNT(*) AS jobs,
       COUNT(*) FILTER (WHERE job_type = 'HP') AS hp_jobs,
       COUNT(*) FILTER (WHERE job_type = 'Spot') AS spot_priority_jobs,
       COUNT(DISTINCT native_gpu_name) AS native_gpu_types,
       ROUND(SUM(gpu_request * duration_seconds / 3600.0), 4)
           AS scenario_requested_gpu_hours,
       ROUND(AVG(worker_count), 2) AS mean_workers,
       MIN(submit_time_seconds) AS first_submit_relative_seconds,
       MAX(submit_time_seconds) AS last_submit_relative_seconds
FROM workload_jobs
GROUP BY organization_id
ORDER BY scenario_requested_gpu_hours DESC, organization_id;
