# Milestone 3 data contract

The database uses the six tables in `schema.sql` from the Milestone 2 commit. Data tooling must preserve these names, columns, and keys so teammates can develop SQL against a stable interface. The earlier seventeen-table application is reference material, not the schema of this repository.

## Relations and joins

| Relation | One row represents | Join/key |
|---|---|---|
| `providers` | A named rental marketplace/provider | `provider_id` |
| `gpu_models` | A reviewed exact hardware identity | `gpu_model_id`; unique `name` |
| `rental_offers` | A version of a source listing's configuration | Unique `(source_name, source_offer_id, revision)`; joins provider and nullable exact GPU |
| `rental_observations` | A capture of one offer version | `(offer_id, observed_at)` |
| `workload_gpu_types` | A native GPU label in the pinned trace | `native_gpu_name`; nullable reviewed GPU mapping |
| `workload_jobs` | One original trace job | `job_id`; joins `workload_gpu_types.native_gpu_name` |

Join workloads to rentals through both sides' non-null `gpu_model_id`, not through fuzzy GPU-name matches. A job-to-offer join is many-to-many: choose the appropriate observation/quote before aggregating cost, and report matched jobs separately from unmatched jobs.

## Rental observations

- Lium is the marketplace provider in this schema; individual node operators are not separately identified providers.
- `price_per_gpu_hour` is the advertised USD price per GPU per hour. Per-node prices must be divided by a valid positive GPU count. Conflicting per-node and per-GPU amounts are invalid input. A quote is not a payment or a guarantee that arbitrary quantities can be rented.
- `observed_at` is the saved capture receipt time. `source_updated_at` comes from the feed's `generated_at`. Importing a saved capture retains both timestamps. Missing, stale, or absent listings do not imply unavailable stock.
- `available` is `TRUE`, `FALSE`, or `NULL` for unknown. Conflicting availability evidence is unknown. Queries must not coerce NULL to false.
- A changed GPU identity/count, rental mode, or region creates a new offer revision. Existing observations stay attached to their original configuration. Ingestion never overwrites a historical observation with different values.
- The initial exact cross-dataset match is `NVIDIA A100 SXM4 80GB`. Only explicit reviewed SXM4/80GB aliases qualify; a generic A100, A100 PCIe, or another memory size does not. Unknown hardware retains its native label with a NULL foreign key.
- This minimal schema does not preserve minimum order size, detailed capture completeness, or model-specific free GPU quantity. Do not claim quantity-constrained provisioning feasibility from it. Extend the schema deliberately before analyses requiring those facts.

Source field definitions: [Lium public nodes feed](https://docs.lium.io/developers/public-nodes-feed).

## Workload trace

The importer accepts only Alibaba's pinned `job_info_df.csv` from release `3858992ca41bf92082e6d6522ddf0bebd14e838b`: 23,055,929 bytes, 466,867 jobs, SHA-256 `113ccee4c28f5c3bbaaca974cd164b9280b7d4c39e53b745443b28eea05e03dd`. These identify a source artifact, not a claim that this database has already been populated.

`submit_time_seconds` and `duration_seconds` retain relative seconds. There is no verified calendar alignment to current rental captures. `gpu_request`, `cpu_request`, and `worker_count` are retained independently; the request scope remains unresolved, so multiplication by workers requires an explicitly labeled scenario. `job_type` is trace priority (`HP` or `Spot`), not the rental marketplace's pricing mode.

Only the native `A100-SXM4-80GB` label receives the reviewed exact mapping. Other native types remain available for coverage analysis even when they have no rental match. A current-price calculation over historical jobs is a scenario, not historical expenditure.

Source: [Alibaba trace documentation](https://github.com/alibaba/clusterdata/blob/3858992ca41bf92082e6d6522ddf0bebd14e838b/cluster-trace-v2026-spot-gpu/README.md).

## Ownership and review

Sebastian's current work is schema/data compatibility, acquisition, ingestion, population validation, and the database handoff. Jefferson is taking four SQL queries; the remaining six need coordination with Aakash. Exact query IDs should be claimed before implementation. This change does not implement or claim ownership of their queries.

Use a task branch and a PR with one teammate review. Commit completed, verified changes with their actual timestamps and author. Keep existing history and state code reuse and AI assistance accurately. Schema changes require a separate coordinated migration; do not rerun `schema.sql` over a populated database.

## Implementation provenance

The new data tools adapt ideas, parsing rules, and source constants from the earlier `dalessioso/cis-5500` implementation at `e9ca6fe`, particularly `src/ingestion/workloads.ts` and `src/ingestion/adapters/lium.ts`. They are being rewritten for this repository's six-table schema. Codex assists with implementation and automated checks; teammates must review the resulting code and explain the submitted behavior.
