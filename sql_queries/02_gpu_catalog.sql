-- Summarize each GPU's newest listing revisions and latest recorded USD quotes.
SELECT g.gpu_model_id, g.name, g.vram_gb,
       COUNT(o.offer_id) AS listing_count,
       COUNT(DISTINCT o.provider_id) AS provider_count,
       MIN(CASE WHEN r.currency = 'USD' THEN r.price_per_gpu_hour END)
           AS lowest_recorded_usd_per_gpu_hour,
       MAX(r.observed_at) AS last_observed_at
FROM gpu_models g
LEFT JOIN rental_offers o ON o.gpu_model_id = g.gpu_model_id
    AND o.revision = (
        SELECT MAX(revision) FROM rental_offers
        WHERE source_name = o.source_name AND source_offer_id = o.source_offer_id
    )
LEFT JOIN rental_observations r ON r.offer_id = o.offer_id
    AND r.observed_at = (
        SELECT MAX(observed_at) FROM rental_observations
        WHERE offer_id = o.offer_id
    )
GROUP BY g.gpu_model_id, g.name, g.vram_gb
ORDER BY g.name, g.gpu_model_id;
