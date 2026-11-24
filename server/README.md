# ComputeScope API

Install the dependencies with `npm ci`, configure `DATABASE_URL` in a local
`.env`, and start the server with `npm start`. The server defaults to
`127.0.0.1:3000`; `API_HOST` and `PORT` may be set in the environment.
Use a read-only PostgreSQL account. Do not commit credentials.

All endpoints use GET. Query results are returned as
`{"data": [...], "meta": {"query_id": "01", "returned_rows": 0,
"limit": 100, "offset": 0}}`. Pagination is optional: limit defaults to 100
(1-1000), offset defaults to 0 (0-1000000). PostgreSQL numeric and bigint
values are serialized as strings by node-postgres; SQL NULL becomes JSON null.
Invalid parameters return HTTP 400; unknown paths return 404; other methods
return 405. Search text uses case-insensitive substring matching; organization
identifiers are exact matches.

| Query | Route | Optional filters |
| --- | --- | --- |
| 01 | /api/rentals | gpu, provider, available (true/false/unknown), currency, max_price |
| 02 | /api/gpus | name, min_vram_gb |
| 03 | /api/providers | name |
| 04 | /api/offers/:offerId/history | since, until (ISO timestamps with timezone); offerId is required |
| 05 | /api/workloads/summary | native_gpu_name, trace_priority (HP/Spot) |
| 06 | /api/organizations/demand | organization_id |
| 07 | /api/organizations/market-coverage | organization_id |
| 08 | /api/organizations/price-exposure | organization_id |
| 09 | /api/organizations/spot-comparison | organization_id |
| 10 | /api/budget-allocation | budget_usd, organization_budget_fraction, candidate_limit |

For rentals, `currency` (uppercase three-letter code) is required when
`max_price` is supplied. Budget defaults are 1000 USD, a 0.25
per-organization fraction (range 0-1), and 500 candidates (range 1-10000).
The allocation considers its candidates before applying pagination. Monetary
and GPU-hour outputs are scenarios, not reservations or historical bills;
the initial dataset has no available exact matches, so coverage and cost
results can be empty or null.

`GET /api/health` checks database reachability. See the Milestone 4 API
specification for each route's returned fields.
