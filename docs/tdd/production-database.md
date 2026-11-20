# Production database safeguards: TDD evidence

Date: November 20, 2026. Journeys were derived from the [production review](../reviews/production-readiness-2026-11-20.md) and the user's instruction to fix its implementation gaps. No external plan or command file was executed.

## User and operator guarantees

1. Repeated authenticated requests cannot create unlimited portfolios, quotes, or bets through direct SQL RPC access.
2. An already accepted placement can be retried after its write budget is exhausted without a second debit.
3. Disposable operational data can be pruned in bounded batches while accepted quote, bet, ledger, and result evidence remain intact.
4. An operator can resolve a missing or cancelled result with attributable evidence and an immutable reason; automatic workers cannot undo the held resolution.
5. Settlement pages and owner-scoped history pages do not omit or leak records across page boundaries.
6. Applying forward migrations to a persistent local database preserves the existing portfolio and balance.

## Executed RED and GREEN

Initial command:

```text
node --test --test-concurrency=1 tests/readiness-database.test.mjs
12 tests, 0 passed, 12 failed
```

The four quota cases failed with `Missing expected rejection`. New maintenance, recovery, batch, and history cases failed because their intended RPCs did not exist. Schema and persistent-upgrade cases failed because the health response had no readiness schema version. These were executed behavioral failures before the forward migration or production loader changes.

The first implementation passed 11/12 cases. The remaining assertion attempted to test an immutable trigger under a role that already lacked write privilege; the assertion setup was corrected to exercise the owner trigger. That interim assertion was not treated as a production defect.

Two additional tests were then executed before the corresponding settlement changes:

```text
node --test --test-concurrency=1 tests/readiness-database.test.mjs
14 tests, 12 passed, 2 failed
Missing expected rejection
```

They reproduced a worker overriding a manual hold after reading its candidate, and an operator resolving only part of an event's accepted bets. The fix enforces the hold under the result lock inside the actual settlement RPC, restricts its private implementation, and requires complete bet identities for operator resolution. Successful audited recovery also clears the unresolved-review heartbeat.

Final targeted command, including daily boundary verification and existing regression suites:

```text
node --test --test-concurrency=1 tests/readiness-database.test.mjs tests/database.test.mjs tests/local.test.mjs
63 tests, 63 passed, 0 failed, 0 skipped
duration approximately 9.91 seconds

node --check tests/postgres-race.integration.mjs
exit 0
```

The final run also applied the subsequent authentication-limit migration through the shared sorted migration loader. The original financial migration was not edited.

## Test specification

| Guarantee | Test target | Type | Result |
|---|---|---|---|
| Portfolios are limited to 5/hour and 20/day per user; another user's budget is independent | `readiness-database.test.mjs`: portfolio and daily portfolio cases | Real SQL integration in PGlite | PASS |
| Quotes are limited to 30/minute and 500/day per user | Same file: quote burst and daily boundary cases | Real SQL integration | PASS |
| New bets are limited to 30/minute and 300/day; an accepted request still replays once | Same file: placement and daily boundary cases | Real SQL integration | PASS |
| Expired unaccepted quotes and old operational records are pruned in bounded batches; accepted quote and ledger survive | Same file: maintenance case | Real SQL integration | PASS |
| Ordinary accounts cannot invoke maintenance, resolve, or resume | Same file: protected operations case | SQL permission integration | PASS |
| Operator recovery retains actor/reason/evidence, pauses automation, and resumes only through an audited operation | Same file: operator recovery cases | Real SQL integration | PASS |
| A late worker cannot reverse an operator resolution or call the private application function | Same file: in-flight worker case | Real SQL integration | PASS |
| Operator outcomes must cover all accepted bets; successful resolution clears failed review state | Same file: complete outcomes case | Real SQL integration | PASS |
| Bounded event pages and owner-only bet-history pages are stable | Same file: settlement and history cases | Real SQL integration | PASS |
| Older unchanged bets remain in a selected event's outcome set; repeated result versions still replay without conflict | Same file: correction-window case | Real SQL integration | PASS |
| Long event IDs clear the same hashed review heartbeat used by the worker | Same file: long identifier case | Real SQL integration | PASS |
| A persistent database upgrades from the original migration with its account and portfolio intact | Same file: persistent upgrade case | Local backend/persistence integration | PASS |
| Existing balances, idempotency, stale data rejection, corrections, ownership policies, and local sessions remain intact | `database.test.mjs`, `local.test.mjs` | Regression integration | PASS |
| Concurrent portfolio requests cannot exceed quota; a concurrent worker cannot reverse operator recovery | `postgres-race.integration.mjs`: two added independent-session cases | Real PostgreSQL concurrency | PASS on isolated PostgreSQL 15.14 |

## Implementation and limits

- The forward migration is `supabase/migrations/202611200002_readiness.sql`; deployment must apply all migrations in order. The local backend, shared database helper, and independent-session target now load ordered migration files. Previously applied local checksums remain protected.
- Quotas are enforced by insert triggers under a per-owner transaction lock, including direct authenticated RPC requests. Rejected writes roll back atomically. This is separate from the authentication throttling implemented in the next migration.
- Maintenance deletes unaccepted quotes only when expiry is over 24 hours old, and operational jobs after 30 days. It preserves latest core heartbeats and unresolved review records. Accepted financial evidence is never part of cleanup.
- `beter_resolve_event` records full-event outcomes through the existing financial logic, adds immutable operator evidence, holds automation, and resolves the review heartbeat. `beter_resume_event` records why automation was re-enabled. Those operations require service privilege and must be invoked by an authorized operator using verified evidence.
- `beter_settlement_batch` returns at most 100 events and preserves every accepted bet for each selected event. A single heavily used event can still produce a large payload; hosted load testing and further within-event batching require care around result-version idempotency.
- `beter_history` supplies owner-scoped keyset pagination. A subsequent [bounded portfolio follow-up](bounded-portfolios.md) closes the complete-response scaling gap with a fourth migration: exact server summaries, at most 100 recent bets, at most 200 representative chart points, and whole-history status filtering. Browser statistics, paging, and export integration are verified separately.
- After the initial targeted run, all nine independent-session PostgreSQL scenarios passed on an isolated PostgreSQL 15.14 cluster using only a private Unix socket. The temporary cluster was stopped and removed. This does not establish Supabase/PostgREST behavior, the CI PostgreSQL 17 target, scheduled delivery, alert delivery, or hosted backup restoration. See the follow-up below.
- SQL line coverage is not claimed. Root's final full coverage run covers the configured TypeScript/shared JavaScript scope and reports its result separately.

## Checkpoints

At the start of this work the workspace had no Git repository, so no Git RED/GREEN checkpoint commits were available. This report preserves the executed failing and passing stages. No user database was cleared, no live provider was contacted, and no hosted infrastructure was created by this database task.

## Follow-up: independent PostgreSQL execution

A broader read-only installation check found an existing Homebrew PostgreSQL 15 installation that the previous 16–18-only discovery had missed. No new database software was installed. A fresh cluster and a fresh `beter_readiness_test` database were created under a unique temporary directory. TCP listening was disabled; the test connected through that directory's private Unix socket. Only the test process received its temporary `TEST_DATABASE_URL`.

```text
postgres (PostgreSQL) 15.14 (Homebrew)
node --test tests/postgres-race.integration.mjs
9 tests, 9 passed, 0 failed, 0 skipped
duration approximately 253 milliseconds
schema_version: 4
temporary_cluster_stopped: true
temporary_cluster_removed: true
```

All seven prior financial races and the two new quota/operator-hold races executed against independent PostgreSQL sessions. The latest run reapplied all four migrations in a new cluster and verified schema version 4. The retained output and ordered migration checksums are in `artifacts/production-postgres-races.log`. This result closes the local independent-session evidence gap; actual hosted Supabase and CI execution remain separate release checks.
