# Additional Milestone 3 queries

Queries 05–06 are smaller queries; 07–10 are the four proposed complex queries.
Together with the four existing files, these provide ten SQL queries. Complexity
is a design classification for mentor review, not a claim about measured runtime.

| File | Description |
|---|---|
| `05_workload_summary.sql` | Summarizes jobs by native GPU type and trace priority, including organization counts, duration percentiles and requested GPU-hours under an explicit request-scope assumption. Unmapped GPU labels remain visible. |
| `06_organization_demand.sql` | Compares organizations by job volume, priority mix, GPU diversity and requested GPU-hours. Submission times remain relative trace seconds. |
| `07_workload_market_coverage.sql` | Measures each organization's job and GPU-hour coverage by exact-hardware rental quotes. Distinguishes unmapped GPU labels from mapped hardware without qualifying quotes, and checks whether every requested type has a quote. |
| `08_organization_price_exposure.sql` | Estimates each organization's cost under the lowest, median and highest available quote for each exact GPU. Reports unpriced jobs and how much lowest-quote scenario spending belongs to the most expensive 10% of priced jobs, rounding that group size up. |
| `09_spot_on_demand_comparison.sql` | Compares cheapest spot and on-demand rates on the same matched workload subset, with weighted dollar and percentage differences. Separately reports spot-only, on-demand-only and unmatched demand. |
| `10_budget_allocation_scenario.sql` | Simulates a greedy round-robin job shortlist under a shared budget and an organization spending cap. Reports each selection or rejection and the remaining budget; rejected jobs do not consume funds. |

## Run

Use the six-table `schema.sql` and populated data from the `data-imports` branch.
These files are read-only SELECT statements and do not require additional tables,
views, migrations or extensions. For example, with `DATABASE_URL` already set:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f sql_queries/07_workload_market_coverage.sql
```

Query 10 has a `params` CTE: `budget_usd` defaults to 1000,
`organization_budget_fraction` to 0.25, and `candidate_limit` to 500. The cap is a
fraction of the original total budget, not its remaining balance. Within each
organization, HP jobs precede Spot-priority jobs, followed by relative submission
time and job ID. Organizations then alternate in organization-ID order. Only
jobs with qualifying quotes enter the queue; the candidate limit bounds the
shortlist and does not mean that every trace job was considered. Invalid
parameters return no candidates. This policy is deterministic, greedy and not
an optimization of job count, dollar utilization or scheduling fairness.

## Interpretation and correctness

- All GPU-hour and cost calculations explicitly assume `gpu_request` is the
  **whole-job request**. The source's request scope is unresolved; worker count
  is not multiplied. Fractional requests are priced linearly. Change this
  assumption only after reviewing the source semantics.
- Queries 07–10 use the latest stored capture **per source** and each listing's
  newest revision. Listings absent from that capture are excluded. This avoids
  treating the last observation of a retired listing as current stock. Captures
  from different sources need not be simultaneous, and a latest stored quote
  is not a freshness guarantee or live availability check.
- Qualifying quotes require `available IS TRUE`, USD, a non-null price and an
  exact reviewed `gpu_model_id`. Unknown availability is excluded. Zero-price
  quotes are retained; percentage denominators use `NULLIF` to avoid division
  by zero.
- Aggregate rental rates before joining jobs, or aggregate demand before joining
  market summaries. A job is not counted once per matching offer.
- Costs apply stored rental quotes to historical workload demand as a
  **scenario**, not historical expenditure. They exclude billing minimums,
  available quantity, minimum order sizes, concurrency, interruption/retry risk
  and other fees. The database cannot establish provisioning feasibility.
- The trace's `job_type = 'Spot'` is a priority label; it is not evidence that a
  job ran on a spot-market rental. Query 09 compares both rental modes regardless
  of that trace label. Positive savings mean spot is cheaper; negative values
  mean the opposite.
- Queries 07–09 retain organizations with unmatched workloads. Query 08 returns
  NULL scenario totals when an organization has no priced jobs, rather than
  suggesting its workloads would cost zero. Query 09 likewise returns NULL
  comparison costs when no jobs have both modes.

## Why the four larger queries are complex

- **07:** combines separately aggregated demand and rental markets across
  datasets, computes weighted coverage, distinguishes two causes of missing
  coverage, and checks coverage for every requested hardware type.
- **08:** builds per-GPU price distributions, prices individual trace jobs,
  ranks jobs within organizations, and aggregates spending concentration while
  preserving the full workload denominator.
- **09:** pivots mode-specific quote minima, aggregates cross-dataset demand,
  partitions jobs into four mutually exclusive coverage categories, and compares
  costs over the same subset rather than incomparable populations.
- **10:** constructs per-organization and global queues with window functions,
  then uses a recursive CTE and per-organization JSONB state to apply two spending
  constraints sequentially. A rejected expensive job does not block later
  cheaper candidates.

The small rental snapshot may make these queries fast or limit their results.
Measure actual plans and runtimes on the populated team database before claiming
the course's performance targets. No artificial delays are included.

## Validation

All six files were executed successfully on PostgreSQL 17.11 against the team's
unchanged schema in an isolated temporary database. Known-result checks covered
empty data, aliases mapping to the same GPU, fractional requests, unmatched
organizations, stale listings, newer unavailable revisions, source-specific
capture times, unknown availability, non-USD and missing prices, zero-price
quotes, mode-comparison denominators, spending concentration, and budget/cap
rejections followed by later selections. These checks used synthetic fixtures;
the queries have not been benchmarked on the full imported dataset or AWS RDS.
