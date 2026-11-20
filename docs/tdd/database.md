# Database TDD evidence

Source: the infrastructure and implementation plan agreed in this chat. No separate plan file was supplied. Database work uses the existing Node test runner and PGlite PostgreSQL for repeatable integration tests.

## Journeys

- A signed-in user receives one $10,000 virtual grant, can return to the same portfolio, and can start another portfolio while preserving the old history.
- A user can view current practice markets, request a short-lived price quote, and place a single without spending the same virtual balance twice.
- A duplicate placement request has one effect; changed payloads, stale prices, closed events, and insufficient funds are rejected.
- The service can grade the accepted bet snapshot, replay a result safely, and apply an audited correction.
- Users can read their own records and cannot alter financial records or grade results directly.
- Operators can inspect ledger reconciliation, unsettled bets, and job heartbeats.

## RED / GREEN evidence

Tests were authored before the production migration. PGlite was installed before executing them, so the failure was missing database behavior rather than a missing dependency.

Initial RED command: `node --test tests/database.test.mjs`.

Actual output excerpt:

```text
tests 19
pass 0
fail 19
error: function public.beter_portfolio() does not exist
```

After implementing the migration, the same target passed all 19 tests. Subsequent integration review added cases for provider status aliases, result validation, connected-beta market restrictions, future timestamps, immutable records, and result-version ordering.

Additional RED commands:

```text
node --test --test-name-pattern='provider live|conflicting duplicate' tests/database.test.mjs
tests 2 / pass 0 / fail 2
new row for relation "beter_events" violates check constraint "beter_events_status_check"
AssertionError: Missing expected rejection.

node --test --test-name-pattern='connected beta|future event' tests/database.test.mjs
tests 2 / pass 0 / fail 2
AssertionError: Missing expected rejection.
```

Those failures were corrected by normalizing provider statuses, validating result targets, enforcing moneyline-only quoting/placement, and rejecting future data timestamps.

Final GREEN command: `node --test tests/database.test.mjs`.

```text
tests 33
pass 33
fail 0
cancelled 0
skipped 0
duration_ms 1515.095667
```

Quote/placement lock acquisition was aligned with ingestion's event-then-selection order. Quote expiry uses the current database clock after locks have been acquired.

Independent review found a further SQL payout issue: multiplying a repeating decimal representation of −120 odds underpaid exact half-cent returns. New tests were run before changing production SQL:

```text
node --test --test-name-pattern='negative repeating American' tests/database.test.mjs
tests 2 / pass 0 / fail 2
5 !== 6
9267 !== 9268
```

The corrected payout uses the accepted American-odds integer numerator and denominator directly, applying `div((2 × stake × numerator + denominator), (2 × denominator))` once. Both negative-odds regressions and the existing +101 regression pass.

Review also identified out-of-order provider and result risks. New behavioral tests produced:

```text
node --test --test-name-pattern='later retrieval|unseen older|equal provider timestamp' tests/database.test.mjs
tests 3 / pass 0 / fail 3
180 !== 150
1 !== 0
AssertionError: Missing expected rejection.
```

Ingestion now acquires a per-event advisory lock before checking freshness, in sorted event order for overlapping batches. Selection prices do not regress to older provider evidence. Settlement compares provider result timestamps under its event-result lock; unseen old versions are retained as unapplied audit records. Conflicting outcomes with an equal source timestamp require operator review. The 33-test GREEN result above includes all fixes.

No Git checkpoints apply: the project is not a Git repository.

## Test specification

The authoritative integration target is `node --test tests/database.test.mjs`. Each test starts a database transaction and rolls back afterward; account identity and SQL roles are switched explicitly to exercise ownership and privileges.

| Guarantee | Integration evidence | Result |
|---|---|---|
| One initial virtual grant and an isolated portfolio per user | `account initialization issues one durable virtual grant`; `account portfolios and ledger reads are isolated` | PASS |
| Reset preserves historical portfolios | `starting fresh preserves the old portfolio and its audit trail` | PASS |
| Provider identity is retained and supported status aliases normalize | `normalised markets are readable and retain their provider identity`; `provider live and final aliases normalize to closed canonical statuses` | PASS |
| Only supported, fresh, pregame moneyline selections can be quoted | Quote, stale-feed, imminent-start, market-restriction, future-timestamp tests | PASS |
| Stake acceptance records immutable prices, cent amounts, and available funds atomically | `placement atomically records the stake and immutable accepted price`; funds boundary tests | PASS |
| Repeated requests have one effect and altered payloads fail | `repeated request IDs have one effect and reject changed payloads` | PASS |
| Other accounts, expired prices, changed prices, and retired selections cannot be spent | Ownership, expiry/price-change, and removed-selection tests | PASS |
| Browser roles cannot write balances or invoke service grading | Direct-write and service-identity privilege tests | PASS |
| Exact half-cent returns, voids, and replay-safe settlement reconcile | Half-cent, void/correction, and earlier-result replay tests | PASS |
| Repeating negative American odds retain exact half-cent returns | Three-cent and 5,055-cent stakes at −120 | PASS |
| Accepted snapshots and old portfolios remain available for grading | `settlement uses each bet identity and candidates retain accepted prices and old portfolios` | PASS |
| Duplicate/unknown result targets and reused versions with changed evidence fail | Result-validation and version-evidence tests | PASS |
| Audit entries remain append-only | `financial audit entries cannot be rewritten even through a service table grant` | PASS |
| Old provider polls cannot replace newer prices | `an older provider poll cannot roll back a newer price` | PASS |
| A later retrieval cannot replace a price with older source evidence | `a later retrieval cannot replace a price with older provider evidence` | PASS |
| An unseen older result cannot undo a newer correction | `an unseen older result version cannot reverse a newer correction` | PASS |
| Conflicting equal-time result evidence is quarantined for review | `conflicting results with an equal provider timestamp require review` | PASS |
| Reversing spent winnings records debt, blocks new stakes, and preserves reconciliation | `reversing spent winnings records debt and blocks additional stakes` | PASS |
| Health checks reconcile ledger sums and expose worker heartbeats | `service health reports reconciled balances and durable job heartbeats` | PASS |

## Coverage and deployment limits

PGlite executes the PostgreSQL migration and functions rather than mocking SQL behavior. All application RPC families are exercised. Node's V8 source-coverage instrumentation does not measure PostgreSQL function bodies, so no SQL statement/branch percentage is claimed here.

A hosted PostgreSQL concurrency rehearsal and Supabase Auth integration remain separate deployment checks; the embedded engine serializes access and does not prove independent-session locking behavior. Role-based authorization is exercised with real SQL roles and row-level security inside PGlite, with a local `auth.uid()` compatibility function.

Corrections append an adjustment. A correction that reverses already-spent winnings may expose a negative available balance; new stakes are then refused until sufficient funds exist. No ledger history is silently rewritten.

Connected beta quoting and placement deliberately support moneyline singles only. Spread/total fields are retained in normalized provider records and accepted-record schema for later versioned expansion. Parlays are not accepted by these RPCs.
