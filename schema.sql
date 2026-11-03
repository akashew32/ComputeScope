-- Milestone 2: initial schema; application and data import are future work.
-- Initially supports one pinned Alibaba GPU job-trace release.
-- Only reviewed exact GPU matches receive a gpu_model_id; unknowns stay NULL.
BEGIN;

CREATE TABLE providers (
    provider_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE,
    website text
);

CREATE TABLE gpu_models (
    gpu_model_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name text NOT NULL UNIQUE,
    vram_gb numeric(8,2) CHECK (vram_gb > 0 AND vram_gb <> 'NaN'::numeric)
);

CREATE TABLE rental_offers (
    offer_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    provider_id bigint NOT NULL REFERENCES providers(provider_id),
    gpu_model_id bigint REFERENCES gpu_models(gpu_model_id),
    source_name text NOT NULL,
    source_offer_id text NOT NULL,
    source_url text NOT NULL,
    native_gpu_name text NOT NULL,
    gpu_count integer CHECK (gpu_count > 0),
    rental_mode text,
    region text,
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    UNIQUE (source_name, source_offer_id, revision)
);

CREATE TABLE rental_observations (
    offer_id bigint NOT NULL REFERENCES rental_offers(offer_id),
    observed_at timestamptz NOT NULL,
    source_updated_at timestamptz,
    price_per_gpu_hour numeric(12,6)
        CHECK (price_per_gpu_hour >= 0 AND price_per_gpu_hour <> 'NaN'::numeric),
    currency char(3) CHECK (currency ~ '^[A-Z]{3}$'),
    available boolean,
    PRIMARY KEY (offer_id, observed_at),
    CHECK (price_per_gpu_hour IS NULL OR currency IS NOT NULL)
);

CREATE TABLE workload_gpu_types (
    native_gpu_name text PRIMARY KEY,
    gpu_model_id bigint REFERENCES gpu_models(gpu_model_id),
    mapping_source_url text,
    CHECK (gpu_model_id IS NULL OR mapping_source_url IS NOT NULL)
);

CREATE TABLE workload_jobs (
    job_id text PRIMARY KEY,
    native_gpu_name text NOT NULL REFERENCES workload_gpu_types(native_gpu_name),
    organization_id text NOT NULL,
    cpu_request numeric(12,4)
        CHECK (cpu_request >= 0 AND cpu_request <> 'NaN'::numeric),
    gpu_request numeric(12,4) NOT NULL
        CHECK (gpu_request > 0 AND gpu_request <> 'NaN'::numeric),
    worker_count integer NOT NULL CHECK (worker_count > 0),
    submit_time_seconds numeric(16,4) NOT NULL
        CHECK (submit_time_seconds >= 0 AND submit_time_seconds <> 'NaN'::numeric),
    duration_seconds numeric(16,4) NOT NULL
        CHECK (duration_seconds > 0 AND duration_seconds <> 'NaN'::numeric),
    job_type text NOT NULL CHECK (job_type IN ('HP', 'Spot'))
);

-- available: TRUE = available, FALSE = unavailable, NULL = unknown.
-- Keep capture times on replay; create a new revision if hardware or offer terms change.
-- Job times are relative seconds. Request scope (per job/worker) remains unresolved.
COMMIT;
