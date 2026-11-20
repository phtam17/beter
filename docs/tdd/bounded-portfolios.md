# Bounded portfolio responses: TDD evidence

Date: November 20, 2026. This follow-up closes the production review's unbounded active-portfolio response gap. Journeys were derived from the review and implementation discussion; no external plan or command file was executed.

## Guarantees

1. A long-lived account can load its portfolio without downloading its entire financial history.
2. Bankroll, open exposure, win rate, ROI, and total counts remain based on every accepted bet.
3. Chart data stays bounded, retains first/latest evidence, and identifies when representative points are used.
4. Account holders can page older records and filter across their whole portfolio, including results outside the recent page.
5. Read-model changes do not remove or rewrite accepted bets, ledger entries, or financial balances.

## Observed RED

Before changing production SQL:

```text
node --test --test-concurrency=1 tests/bounded-portfolio.test.mjs
6 tests, 0 passed, 6 failed
```

The executed fixture created 250 accepted one-cent bets across four events, settled 230, and retained 20 open bets. The canonical response returned 250 bets instead of 100 and 481 ledger entries instead of at most 200 chart points. Summary/cursor metadata and the filtered history signature were absent. These failures exercised the intended missing behavior, not a missing test dependency.

## GREEN and regressions

```text
node --test --test-concurrency=1 tests/bounded-portfolio.test.mjs
6 tests, 6 passed, 0 failed
duration approximately 2.71 seconds

node --test --test-concurrency=1 tests/database.test.mjs tests/readiness-database.test.mjs tests/bounded-portfolio.test.mjs tests/local.test.mjs tests/full-flow.test.mjs
70 tests, 70 passed, 0 failed, 0 skipped
duration approximately 13.81 seconds
```

One existing financial test expected the presentation ledger to contain a stake row. Its assertion now queries the actual financial ledger table, preserving the original three-entry invariant while allowing a chart-only read model. The independent PostgreSQL tests likewise verify stake/win entry counts in the real ledger table. An earlier correction-window fixture also assumed insertion order for equal timestamps; it now uses the same deterministic candidate ordering as the worker. No production settlement rule changed for that fixture correction.

| Guarantee | Test | Type | Result |
|---|---|---|---|
| The canonical response contains the newest 100 bets in chronological presentation order | `bounded-portfolio.test.mjs`: canonical bounds case | Real SQL integration | PASS |
| All-history totals remain exact when every win lies outside the recent page | Same case | Real SQL integration | PASS |
| At most 200 non-stake chart rows span first/latest evidence and disclose sampling | Same file: chart projection case | Real SQL integration | PASS |
| Older history begins immediately before the canonical page without gaps | Same file: older paging case | Real SQL integration | PASS |
| Status filtering searches all accepted records before applying page limits | Same file: whole-portfolio filter case | Real SQL integration | PASS |
| Reads leave all 250 bets and 481 financial ledger entries intact | Same file: financial retention case | Real SQL integration | PASS |
| Empty accounts retain a complete zero summary and their original grant point | Same file: empty account case | Real SQL integration | PASS |
| Existing financial, quota, persistence, worker, and account-isolation guarantees remain intact | The 70-case regression command above | Integration | PASS |

The fixture's authoritative summary is 250 total, 20 open, 230 settled, 100 won, 80 lost, and 50 void; 20 cents at risk, 250 cents total staked, and 180 cents staked on decided won/lost bets. Available balance is 1,000,100 cents, so bankroll is 1,000,120 cents. Voids remain excluded from the ROI denominator.

## Migration and response contract

`supabase/migrations/202611200004_bounded_portfolios.sql` replaces only the private portfolio projection, adds history indexes, extends owner-scoped history filtering, and advertises schema version 4. Earlier migrations remain unchanged.

- `bets`: newest 100 records, returned ascending by `(created_at,id)`.
- `summary`: exact all-history counts and integral cent totals.
- `history_next_cursor`: UUID of the oldest included recent bet when more records exist; otherwise null.
- `ledger`: at most 200 representative non-stake rows in chronological order, including first and latest.
- `ledger_sampled` and `ledger_total_points`: explicit chart sampling metadata.
- `beter_history(p_portfolio_id,p_before,p_limit,p_status)`: descending keyset pages with optional `open`, `won`, `lost`, or `void` status. The old three-argument overload is removed; the fourth parameter defaults to null, keeping three-argument callers compatible without PostgREST overload ambiguity.

The client must use the server summary for global statistics and the history RPC for complete history/export. A bounded sample must not be presented as the complete ledger. Browser/domain integration is verified separately by the parent task.

## Independent PostgreSQL

After migration 004, all nine race scenarios were rerun against another fresh temporary PostgreSQL 15.14 cluster. TCP listening was disabled and only a private Unix socket was used.

```text
node --test tests/postgres-race.integration.mjs
9 tests, 9 passed, 0 failed, 0 skipped
duration approximately 253 milliseconds
schema_version: 4
temporary_cluster_stopped: true
temporary_cluster_removed: true
```

The output and ordered migration checksums are retained in `artifacts/production-postgres-races.log`. No existing database was used. CI PostgreSQL 17 and actual hosted Supabase behavior remain separate deployment verification gates.

## Remaining limits and coverage

Exact summaries and representative chart selection still query retained history, so hosted load testing remains necessary. Worker batches contain at most 100 events but preserve all accepted bets for a selected event; very large event fanout still requires measured capacity planning. No SQL line-coverage percentage is claimed. Parent verification supplies the configured JavaScript/TypeScript coverage and browser results.

At the start of this task the workspace was not a Git repository; this evidence preserves the executed RED/GREEN stages independently of checkpoints. No live provider requests, hosted changes, or user database modifications were performed by this follow-up.
