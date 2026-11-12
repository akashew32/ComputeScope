# ComputeScope

GPU rental listings from Lium and Alibaba workload data, using PostgreSQL. The ten application queries are in [`sql_queries/`](sql_queries/).

## Populate the database

Requires Node.js 24, npm and PostgreSQL 17 or later. From the repository root, run `npm ci` and create an ignored `.env` file:

```dotenv
DATABASE_URL=postgresql://OWNER:PASSWORD@HOST:5432/DATABASE?sslmode=verify-full
```

Use a separate database with this project's six-table schema. Run these commands in order:

```sh
npm run db:setup
npm run ingest:workloads
npm run ingest:lium -- datasets/lium-2026-11-12.json.gz
npm run data:profile
```

Run `db:setup` only for a new empty database. The workload importer downloads and verifies the pinned Alibaba CSV used in the original project: **466,867 jobs**. The compressed Lium file contains **593 real observations** captured on November 12, 2026; its sidecar preserves the original timestamp and checksum. Repeating either import does not add duplicates.

For local PostgreSQL setup, see [the data guide](docs/data/README.md). For a new live rental capture, run `npm run capture:lium`, then pass its printed JSON path to `npm run ingest:lium -- PATH`.

## Guest access

Add a new `GUEST_PASSWORD` of at least 16 characters to the private `.env`, then run:

```sh
npm run db:guest
```

This creates `computescope_guest` with SELECT access to the six project tables. It refuses to reset an existing account. The hosted milestone database is `neondb` at `ep-young-leaf-bbqj3ov7.c-15.us-east-1.aws.neon.tech`, port 5432. The guest password is in the private course submission.

In DataGrip or another PostgreSQL client, enter those connection details and enable TLS with certificate verification. With psql 16 or later:

```sh
psql "host=ep-young-leaf-bbqj3ov7.c-15.us-east-1.aws.neon.tech port=5432 dbname=neondb user=computescope_guest sslmode=verify-full sslrootcert=system" -W -f sql_queries/01_rental_prices.sql
```

If your client has no system CA bundle, supply a trusted CA certificate file instead; see [Neon's connection guide](https://neon.com/docs/connect/connect-securely). Run the remaining numbered files the same way. Queries 07-10 are complex workload/price scenarios; they retain missing matches, and Query 10 returns no candidates when no exact-matched rental is available.

## Checks

`npm test` runs the parser and acquisition checks. Set `TEST_DATABASE_URL` to a disposable database and `WORKLOAD_TEST_FILE` to the pinned CSV to include the database and full-import tests. See [the data contract](docs/data-contract.md) for matching and price assumptions.
