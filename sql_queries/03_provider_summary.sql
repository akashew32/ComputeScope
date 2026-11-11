-- Summarize newest listings and their last reported availability for each provider.
SELECT p.provider_id, p.name, p.website,
       COUNT(o.offer_id) AS listing_count,
       COUNT(DISTINCT o.gpu_model_id) AS matched_gpu_models,
       COUNT(CASE WHEN r.available IS TRUE THEN 1 END) AS reported_available_offers,
       COUNT(CASE WHEN r.available IS FALSE THEN 1 END) AS reported_unavailable_offers,
       COUNT(CASE WHEN o.offer_id IS NOT NULL AND r.available IS NULL THEN 1 END)
           AS availability_unknown_offers,
       MIN(CASE WHEN r.currency = 'USD' THEN r.price_per_gpu_hour END)
           AS lowest_recorded_usd_per_gpu_hour,
       MAX(r.observed_at) AS last_observed_at
FROM providers p
LEFT JOIN rental_offers o ON o.provider_id = p.provider_id
    AND o.revision = (
        SELECT MAX(revision) FROM rental_offers
        WHERE source_name = o.source_name AND source_offer_id = o.source_offer_id
    )
LEFT JOIN rental_observations r ON r.offer_id = o.offer_id
    AND r.observed_at = (
        SELECT MAX(observed_at) FROM rental_observations
        WHERE offer_id = o.offer_id
    )
GROUP BY p.provider_id, p.name, p.website
ORDER BY p.name, p.provider_id;
