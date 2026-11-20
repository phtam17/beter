# Independent-session PostgreSQL race checks

This is an additional validation target for the accepted infrastructure plan. PGlite executes PostgreSQL rules but serializes embedded requests, so its passing database tests do not establish behavior across independent hosted connections.

## Target and safeguards

Run `node --test tests/postgres-race.integration.mjs` against a new, empty, disposable PostgreSQL database using `TEST_DATABASE_URL`.

- Database names must end in `_test`. `BETER_ALLOW_TEST_DATABASE=1` permits another explicitly disposable name.
- System databases are always refused.
- Existing public tables or an `auth` schema cause an immediate refusal before any DDL.
- The test provisions a minimal auth compatibility schema and all ordered application migrations.
- It creates only generated example users and events. It never clears ledger history and never drops a database.
- The target needs a database administrator that can create test roles and schemas. Existing cluster roles are left unchanged.
- Use a fresh database per run; CI should supply an ephemeral PostgreSQL service.

The test file is intentionally named `.integration.mjs` so that the regular `tests/*.test.mjs` target does not silently skip unavailable infrastructure. Invoking this target without a database fails clearly.

## Guarantees exercised

| Guarantee | Mechanism |
|---|---|
| Simultaneous first visits create one initial grant | Two independent sessions contend on the same owner lock |
| Two $6,000 stakes cannot spend the same $10,000 bankroll | Exactly one succeeds, leaving $4,000 available |
| Simultaneous retries have one financial effect | Same request ID returns one bet and one stake entry |
| Reset and placement cannot charge the wrong portfolio | Old quote can debit only its original portfolio, or is rejected |
| Duplicate settlement workers credit once | One result application, one winning ledger entry, reconciled balance |
| Concurrent provider snapshots retain the latest accepted source | Both workers contend on an event lock before freshness checks; final quote uses the newer price |
| Concurrent unseen result versions preserve the newest correction | Provider evidence timestamps decide ordering, preserving the newest balance and result |
| Concurrent portfolio creation stays within its durable quota | At the last available slot, exactly one of two overlapping requests succeeds |
| A worker cannot reverse an audited operator resolution | Worker and operator share the result lock; the verified operator result and automation hold remain authoritative |

Each race holds a common advisory lock and checks `pg_stat_activity` until both distinct backend process IDs are simultaneously waiting. It then releases the lock and checks the financial outcomes. Tests therefore require actual overlapping independent sessions rather than merely issuing two sequential requests.

## Current local evidence: November 20, 2026

A broader read-only search found an existing Homebrew PostgreSQL 15 installation at `/opt/homebrew/opt/postgresql@15`. All nine scenarios have now executed successfully on PostgreSQL 15.14. No software installation or existing user database was involved.

The run created a fresh cluster and `beter_readiness_test` database under a unique temporary directory. TCP listening was disabled, and clients used a private Unix socket. `TEST_DATABASE_URL` was configured only for that test process. The cluster was stopped and the temporary directory removed afterward.

```text
postgres (PostgreSQL) 15.14 (Homebrew)
node --test tests/postgres-race.integration.mjs
tests 9
pass 9
fail 0
skipped 0
duration approximately 253 milliseconds
schema_version: 4
temporary_cluster_stopped: true
temporary_cluster_removed: true
```

The latest run applied all four ordered migrations and verified schema version 4. Output and migration checksums are retained in `artifacts/production-postgres-races.log`. This establishes the tested independent-session financial and quota invariants locally. It does not replace the configured CI PostgreSQL 17 run or hosted Supabase Auth/PostgREST, scheduling, SMTP, and backup-restoration checks.

## Earlier discovery and configuration-guard evidence

The earlier discovery found no `postgres`, `initdb`, `pg_ctl`, `psql`, `docker`, or `podman` on PATH or the Homebrew PostgreSQL 16–18 locations. PostgreSQL 15 was outside that initial search. `TEST_DATABASE_URL` was not configured for the following earlier command, so it tested only the configuration guard.

This target validates existing invariants; no new production change is justified solely by writing it. A failing configured run must be retained as RED evidence before applying any race fix. The passing embedded database suite remains documented separately in `database.md`.

Actual local commands:

```text
node --check tests/postgres-race.integration.mjs
exit 0

node --test tests/postgres-race.integration.mjs
exit 1
Error: TEST_DATABASE_URL is required for independent-session PostgreSQL race tests.
```

The latter proves the required-configuration guard, not the financial race invariants.
