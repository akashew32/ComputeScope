# Data setup and handoff

This is Sebastian's data work for the existing six-table team schema. SQL queries are developed separately: Jefferson is taking four, and the remaining six need coordination with Aakash. The [data contract](../data-contract.md) defines the shared columns and interpretation.

## Reproduce locally

Requires Node.js 24, npm, and PostgreSQL 17. Run commands from the repository root.

```sh
npm ci
cp .env.example .env
```

Choose a local password in `.env` before running `docker compose up -d --wait`. The existing Compose configuration creates the database and runs `schema.sql` once on an empty volume. It uses loopback port 5437; do not start it on a port occupied by another checkout's database. Do not delete another database's volume to resolve a conflict.

Add `DATABASE_URL` to the ignored `.env`, using the same password and database/user from Compose, for example:

```text
DATABASE_URL=postgresql://computescope:YOUR_URL_SAFE_PASSWORD@127.0.0.1:5437/computescope
```

For a separately created empty PostgreSQL database, set its connection URL and run `npm run db:setup` instead. Setup refuses to overwrite a nonempty schema. The import commands check the expected six-table column layout and reject the older application's incompatible schema. This guard is not a complete migration or constraint audit.

```sh
npm run ingest:workloads
npm run capture:lium
```

The first command downloads and verifies the pinned 23 MB Alibaba CSV, then imports it atomically. To use an already downloaded copy, run `npm run ingest:workloads -- /absolute/path/to/job_info_df.csv`; the same checksum and size checks still apply.

The capture command makes one bounded request to Lium and prints a saved JSON path plus its provenance. Import the exact path it prints:

```sh
npm run ingest:lium -- data/raw/lium/TIMESTAMP.json
npm run data:profile
```

`TIMESTAMP.json` is a placeholder. Its adjacent `.metadata.json` file is required. Both raw bytes and metadata must travel together when reproducing that capture. Raw data and receipts stay under ignored `data/`; never add `.env`, database dumps, or credentials to Git.

The profile writes a timestamped receipt with actual counts, missingness, and exact-hardware overlap. Inspect the result instead of assuming successful setup implies population. A fresh rental snapshot may have different offers or no exact A100 match. It cannot reproduce older benchmark inputs or demonstrate meaningful price history by itself.

## Verified local population

The [November 11 validation receipt](local-validation-2026-11-11.json) records a run against an isolated local PostgreSQL 17 database using implementation commit `48e53b20b78bfd90923e7ce908e4c6e69d4884c3`. All 25 automated tests passed with zero skips, including full pinned-file import, replay, and conflicting-value rollback.

| Measure | Observed result |
|---|---:|
| Alibaba jobs / organizations / native GPU types | 466,867 / 84 / 6 |
| Lium offer revisions / observations / capture times | 594 / 594 / 1 |
| Available / unavailable / unknown availability | 153 / 441 / 0 |
| Missing rental prices | 0 |
| Exactly mapped rental observations | 31 |
| Jobs with any priced exact-hardware rental match | 169,020 |

The Lium response was received at `2026-11-11T20:53:57.364Z`; its source generation time was `2026-11-11T20:53:11.947726Z`. Re-importing those saved bytes inserted zero observations and replayed all 594. The full-file automated workload replay likewise inserted zero jobs. Raw source hashes and counts are preserved in the linked receipt; raw files themselves remain outside Git. Reproducing this exact rental result requires the original capture and sidecar; a new capture will differ.

The workload exceeds 100,000 rows, but the rental dataset has only 594 observations from one capture. This is not evidence of price history or that the rental dataset meets the course's size recommendation. The hardware overlap measures possible matching only; it does not establish availability, quantity feasibility, or historical costs. Hosted population and staff connectivity have not been verified.

## Replay and validation

Re-run the same two import commands to verify that the data is unchanged. Existing workload IDs must agree with the pinned source. A rental replay retains the saved capture timestamp; differing data at the same observation key fails and rolls back the entire transaction. New rental captures must be imported in chronological order. An already imported historical capture can still be replayed after a newer revision.

The capture tool reuses identical raw bytes already saved in that directory. Different bytes with the same source generation timestamp require review. Collection is one-shot: no background collector or spending service is started.

Tests:

```sh
npm test
# With an explicit disposable PostgreSQL database:
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/TEST_DB' npm test
# Also run the full pinned workload import/replay/conflict test:
TEST_DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:PORT/TEST_DB' \
  WORKLOAD_TEST_FILE=data/raw/alibaba-spot-gpu-2026/job_info_df.csv npm test
```

Integration tests create and drop uniquely named temporary schemas inside the test database. Never point `TEST_DATABASE_URL` at a shared or production database. Without it, database tests are skipped. The full 466,867-row test additionally needs `WORKLOAD_TEST_FILE`; the default CI service covers the other database checks and reports that full-file test as skipped.

## Boundaries that affect SQL

- Numeric quantities are checked before import. Workload values exceeding the schema's four decimal places are rejected. Lium per-GPU prices are rounded explicitly to six decimals using JavaScript `toFixed(6)`; original numbers remain in the raw response. Overflow and inconsistent per-node/per-GPU prices reject the capture.
- Lium timestamps retain up to six fractional digits. Unknown availability remains NULL. The importer does not infer unavailable stock from a missing node.
- Only the explicit A100 SXM4 80GB match is mapped initially. Other native GPU labels remain present but unmapped; this is a conservative coverage limit.
- Offer revisions track the stored native label, exact mapping, GPU count, rental mode, and region. A reported-memory-only change under an unchanged unmapped label cannot be represented separately by this schema. Minimum rental size, source-health history, and quantity feasibility also need further modeling before those analyses can be claimed.
- Raw capture sidecars provide provenance, but there is no database ingestion ledger. Keep the sidecars and sanitized verification receipts with the handoff.

## Hosted database and milestone handoff

Local validation does not establish that the hosted database is populated or reachable by staff. Use an explicitly identified team database, verify it uses this schema, transfer the pinned CSV and desired capture/sidecar pair, and run the same import/profile commands there. Preserve existing populated databases. Arrange staff access through the approved private channel; credentials do not belong in this README, Git, or the report.

The milestone handoff should name the final merged commit, identify source versions and actual row counts, and include the ten reviewed queries and their descriptions. Have every query author execute against that same schema and dataset. Check the live course deadline and submission fields. Dataset size, mentor interpretation of the rental/workload pairing, and hosted access remain separate course requirements.

## Attribution

The workload and Lium parsers adapt the earlier `dalessioso/cis-5500` implementation at `e9ca6fe` for this schema. Codex assisted with implementation and checks. Review and understand the code before presenting it as the team's submission. Source definitions are linked in the [data contract](../data-contract.md).
