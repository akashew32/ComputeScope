-- Show recorded price changes within each offer revision, comparing matching currencies only.
WITH history AS (
    SELECT r.*,
           LAG(price_per_gpu_hour) OVER (PARTITION BY offer_id ORDER BY observed_at) AS previous_price,
           LAG(currency) OVER (PARTITION BY offer_id ORDER BY observed_at) AS previous_currency,
           LAG(observed_at) OVER (PARTITION BY offer_id ORDER BY observed_at) AS previous_observed_at
    FROM rental_observations r
)
SELECT h.offer_id, p.name AS provider, COALESCE(g.name, o.native_gpu_name) AS gpu,
       o.revision, o.gpu_count, o.rental_mode, o.region,
       h.observed_at, h.previous_observed_at, h.price_per_gpu_hour, h.currency,
       h.available AS reported_available,
       CASE WHEN h.currency = h.previous_currency AND h.previous_price > 0
            THEN 100.0 * (h.price_per_gpu_hour - h.previous_price) / h.previous_price
       END AS price_change_pct,
       h.source_updated_at, o.source_name, o.source_url
FROM history h
JOIN rental_offers o ON o.offer_id = h.offer_id
JOIN providers p ON p.provider_id = o.provider_id
LEFT JOIN gpu_models g ON g.gpu_model_id = o.gpu_model_id
ORDER BY h.offer_id, h.observed_at;
