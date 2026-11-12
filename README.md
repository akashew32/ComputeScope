# ComputeScope

ComputeScope combines GPU rental listings from Lium with Alibaba workload data to compare prices, explore workload demand and estimate cost scenarios.

## Project structure

- `docs/`: Data documentation, setup instructions and validation results.
- `lib/`: Data collection, parsing and database helpers.
- `scripts/`: Commands for database setup, imports and data profiling.
- `sql_queries/`: Ten SQL queries and their descriptions.
- `tests/`: Automated tests for the data tools.
- `.github/`: Automated checks run through GitHub Actions.

`schema.sql` defines the database tables. `compose.yaml` provides a local PostgreSQL setup.

See [the data setup guide](docs/data/README.md) for installation and import instructions.
