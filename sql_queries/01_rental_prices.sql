-- List each offer's newest revision and latest recorded quote, keeping unknown values.
-- Configuration cost assumes the per-GPU hourly price applies to every GPU in the offer.
SELECT o.offer_id, p.name AS provider, COALESCE(g.name, o.native_gpu_name) AS gpu,
       g.vram_gb, o.gpu_count, o.rental_mode, o.region,
       r.price_per_gpu_hour,
       r.price_per_gpu_hour * o.gpu_count AS price_per_config_hour,
       r.currency, r.available AS reported_available, r.observed_at,
       r.source_updated_at, o.source_name, o.source_url
FROM rental_offers o
JOIN providers p ON p.provider_id = o.provider_id
LEFT JOIN gpu_models g ON g.gpu_model_id = o.gpu_model_id
LEFT JOIN rental_observations r ON r.offer_id = o.offer_id
    AND r.observed_at = (
        SELECT MAX(observed_at) FROM rental_observations
        WHERE offer_id = o.offer_id
    )
WHERE o.revision = (
    SELECT MAX(revision) FROM rental_offers
    WHERE source_name = o.source_name AND source_offer_id = o.source_offer_id
)
ORDER BY r.currency NULLS LAST, r.price_per_gpu_hour NULLS LAST, o.offer_id;
