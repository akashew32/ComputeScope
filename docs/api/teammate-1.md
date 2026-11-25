# ComputeScope: Milestone 4 API specification, Teammate 1

This section covers Queries 01-04 and a database health check. Combine it with the other teammates' routes for Queries 05-10 before submitting the group PDF.

## Setup

Use Node.js 24 and the project's populated six-table PostgreSQL database. Put the guest connection URL in the ignored `.env` file, then run:

```sh
npm ci
npm start
```

The base URL is `http://127.0.0.1:3000`. You can change the address with `API_HOST` and `PORT` in `.env`.

The rental routes in this section use two backend files:

- `server/app.mjs` contains the four rental handlers, validates parameters and returns JSON. It also dispatches requests to the workload and scenario handlers.
- `server/database.mjs` creates a shared PostgreSQL pool with up to five connections, read-only sessions and a 30-second statement timeout.

Startup checks database connectivity. The database should already have the schema and data described in the root README.

## Shared rules

All routes use GET and take no request body. Each query route accepts these optional query parameters:

| Parameter | Type | Required? | Description |
| --- | --- | --- | --- |
| `limit` | integer | No | Maximum rows returned. Default 100; range 1-1000. |
| `offset` | integer | No | Rows skipped in the route's ordering. Default 0; range 0-1000000. |

Text filters are case-insensitive literal substring searches, limited to 1-100 nonblank characters without control characters. `%`, `_` and backslash are treated literally. Decimal inputs are nonnegative strings with up to 12 integer digits and 6 fractional digits. Invalid, repeated and unknown parameters return HTTP 400. SQL input values use bound parameters.

Successful query routes return:

```json
{
  "data": [],
  "meta": {
    "query_id": "01",
    "returned_rows": 0,
    "limit": 100,
    "offset": 0
  }
}
```

| Response field | Type | Description |
| --- | --- | --- |
| `data` | array of objects | Rows with the fields described for each route below. |
| `meta.query_id` | string | Original Milestone 3 query number. |
| `meta.returned_rows` | integer | Rows returned in this page, not the total number of matches. |
| `meta.limit` | integer | Applied page size. |
| `meta.offset` | integer | Applied offset. |

PostgreSQL bigint IDs/counts and exact decimals are returned as strings to preserve precision. Integer configuration fields are JSON numbers. Timestamps are UTC ISO strings rendered to millisecond precision; the database retains the original timestamp precision. Unknown values remain null. No matching rows, including an unknown offer ID, produces HTTP 200 with `data: []`.

## 01. Rental prices

**GET `/api/rentals`**

Uses [01_rental_prices.sql](../../sql_queries/01_rental_prices.sql). Returns the newest revision of each offer with its latest stored quote. This supports browsing rentals and filtering the results.

### Request and SQL parameters

The common `limit` and `offset` parameters apply. These additional query parameters filter the SQL result:

| Parameter | Location | Type | Required? | Description |
| --- | --- | --- | --- | --- |
| `gpu` | query | string | No | Substring of the displayed GPU name. |
| `provider` | query | string | No | Substring of the provider name. |
| `available` | query | string | No | `true`, `false` or `unknown`. Omit to include all availability states. |
| `currency` | query | string | With `max_price` | Three-letter uppercase currency, such as USD. |
| `max_price` | query | decimal string | No | Inclusive maximum price per GPU-hour in the supplied currency. |

### Response row fields

| Field | Type | Description |
| --- | --- | --- |
| `offer_id` | bigint string | ID of the offer revision. |
| `provider` | string | Marketplace/provider name. |
| `gpu` | string | Reviewed GPU name, or native source label when unmapped. |
| `vram_gb` | decimal string or null | Reviewed GPU memory in GB. |
| `gpu_count` | integer or null | GPUs in the advertised configuration. |
| `rental_mode` | string or null | Stored rental mode, when known. |
| `region` | string or null | Source region label. |
| `price_per_gpu_hour` | decimal string or null | Saved price for one GPU-hour. |
| `price_per_config_hour` | decimal string or null | Per-GPU hourly price multiplied by the configuration GPU count. |
| `currency` | string or null | Quote currency. |
| `reported_available` | boolean or null | Saved stock state; null means unknown. |
| `observed_at` | timestamp string or null | Latest saved capture time for this revision. |
| `source_updated_at` | timestamp string or null | Source generation time. |
| `source_name` | string | Source feed identifier. |
| `source_url` | string | Source feed URL. |

Results are ordered by currency, per-GPU price and offer ID, with missing currency/price last. Prices are saved quotes, not live stock; no currency conversion is performed.

```sh
curl 'http://127.0.0.1:3000/api/rentals?gpu=A100&currency=USD&max_price=5&limit=10'
```

## 02. GPU catalog

**GET `/api/gpus`**

Uses [02_gpu_catalog.sql](../../sql_queries/02_gpu_catalog.sql). Summarizes current listing revisions and their latest stored quotes for each reviewed GPU model. This supports a GPU catalog with memory, listing counts and quoted prices.

### Request and SQL parameters

The common `limit` and `offset` parameters apply.

| Parameter | Location | Type | Required? | Description |
| --- | --- | --- | --- | --- |
| `name` | query | string | No | Substring of the reviewed GPU name. |
| `min_vram_gb` | query | decimal string | No | Inclusive minimum memory in GB. Unknown memory does not match. |

### Response row fields

| Field | Type | Description |
| --- | --- | --- |
| `gpu_model_id` | bigint string | Reviewed GPU model ID. |
| `name` | string | Reviewed exact hardware name. |
| `vram_gb` | decimal string or null | Reviewed memory in GB. |
| `listing_count` | bigint string | Number of newest offer revisions. |
| `provider_count` | bigint string | Distinct providers associated with those offers. |
| `lowest_recorded_usd_per_gpu_hour` | decimal string or null | Lowest latest USD quote, including unavailable offers. |
| `last_observed_at` | timestamp string or null | Most recent quote time among the listed offers. |

Results are ordered by name and GPU model ID. Unmapped GPU labels remain visible in the rental route. Listing counts include offers without a quote.

```sh
curl 'http://127.0.0.1:3000/api/gpus?name=A100&min_vram_gb=80'
```

## 03. Provider summary

**GET `/api/providers`**

Uses [03_provider_summary.sql](../../sql_queries/03_provider_summary.sql). Returns each provider's latest listing counts, saved availability states and lowest latest USD price. This supports provider summary cards.

### Request and SQL parameters

The common `limit` and `offset` parameters apply.

| Parameter | Location | Type | Required? | Description |
| --- | --- | --- | --- | --- |
| `name` | query | string | No | Substring of the provider name. |

### Response row fields

| Field | Type | Description |
| --- | --- | --- |
| `provider_id` | bigint string | Provider ID. |
| `name` | string | Provider name. |
| `website` | string or null | Provider website. |
| `listing_count` | bigint string | Number of newest offer revisions. |
| `matched_gpu_models` | bigint string | Distinct reviewed GPU models among those listings. |
| `reported_available_offers` | bigint string | Listings whose latest quote reports true availability. |
| `reported_unavailable_offers` | bigint string | Listings whose latest quote reports false availability. |
| `availability_unknown_offers` | bigint string | Listings with unknown availability, including missing quotes. |
| `lowest_recorded_usd_per_gpu_hour` | decimal string or null | Lowest latest USD quote, regardless of availability. |
| `last_observed_at` | timestamp string or null | Most recent stored quote time for the provider. |

Results are ordered by name and provider ID. Lium counts as one marketplace provider; its node operators are not separate providers in this schema.

```sh
curl 'http://127.0.0.1:3000/api/providers?name=Lium'
```

## 04. Offer price history

**GET `/api/offers/{offerId}/history`**

Uses [04_offer_history.sql](../../sql_queries/04_offer_history.sql). Returns saved observations and price changes for one offer revision. This supports an offer detail page and a price-history chart when multiple observations exist.

### Request and SQL parameters

The common `limit` and `offset` parameters apply.

| Parameter | Location | Type | Required? | Description |
| --- | --- | --- | --- | --- |
| `offerId` | path | bigint string | Yes | Positive offer revision ID, up to 9223372036854775807. |
| `since` | query | timestamp string | No | Inclusive earliest observation time. ISO 8601 with an explicit timezone, up to 6 fractional digits. |
| `until` | query | timestamp string | No | Inclusive latest observation time. Same format as since; must be at or after since. |

### Response row fields

| Field | Type | Description |
| --- | --- | --- |
| `offer_id` | bigint string | ID of the offer revision. |
| `provider` | string | Provider name. |
| `gpu` | string | Reviewed GPU name or native label. |
| `revision` | integer | Source listing configuration revision. |
| `gpu_count` | integer or null | GPUs in the configuration. |
| `rental_mode` | string or null | Stored rental mode. |
| `region` | string or null | Source region label. |
| `observed_at` | timestamp string | Saved observation time. |
| `previous_observed_at` | timestamp string or null | Previous observation for this same revision. |
| `price_per_gpu_hour` | decimal string or null | Saved per-GPU hourly price. |
| `currency` | string or null | Saved quote currency. |
| `reported_available` | boolean or null | Saved availability; null means unknown. |
| `price_change_pct` | decimal string or null | Percentage change when both quotes have prices, currencies agree and the previous price is positive. |
| `source_updated_at` | timestamp string or null | Source generation time. |
| `source_name` | string | Source feed identifier. |
| `source_url` | string | Source feed URL. |

Results are ordered by observation time. Date filters apply after the original LAG calculation, so the previous quote may fall outside the requested range. An offer ID refers to one configuration revision. With only one capture, the previous observation and price change are null.

```sh
curl 'http://127.0.0.1:3000/api/offers/1/history?since=2026-11-01T00:00:00Z'
```

## Database health

**GET `/api/health`**

No request or query parameters. Runs `SELECT 1` and returns HTTP 200 with `{"status":"ok","database":"reachable"}` when the connection works. This supports checking that the backend can reach PostgreSQL before the demo.

## Errors

Error responses have the form `{"error":{"code":"INVALID_PARAMETER","message":"..."}}`. Database errors return a general message without exposing credentials or SQL text.

| HTTP status | Code | Meaning |
| --- | --- | --- |
| 400 | INVALID_PARAMETER | Invalid, unknown, repeated or inconsistent parameters. |
| 404 | NOT_FOUND | Unknown API path. An unknown offer ID on the history route instead returns an empty successful result. |
| 405 | METHOD_NOT_ALLOWED | Use GET; the response includes `Allow: GET`. |
| 500 | INTERNAL_ERROR | Unexpected server or SQL failure. |
| 503 | DATABASE_UNAVAILABLE | Database connection or authentication failed. |
| 504 | QUERY_TIMEOUT | PostgreSQL exceeded the 30-second statement timeout. |

## Testing and handoff

Run `npm test` for the repository tests. The API tests check routing and validation with a stub database; use the requests above with the configured guest connection to check live results. Setting `TEST_DATABASE_URL` to a disposable PostgreSQL database enables the data tools' database integration tests, which create temporary test schemas.

For the meeting, start with `/api/health`, then show the rental, GPU and provider routes. Copy an offer ID from the rental response to open its history. Show an invalid request such as `/api/rentals?limit=0` returning HTTP 400. The rental route reports the saved availability of each offer, including unavailable A100 listings.

Queries 05-10 are already implemented in `server/routes-workloads.mjs` and `server/routes-scenarios.mjs`. Their request and response documentation should be combined with this section for the full group PDF. The group submission should also address complex-query timings and the availability scenario plan; the mentor check-in is a separate group activity.
