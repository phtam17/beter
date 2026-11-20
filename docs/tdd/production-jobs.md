# Production worker and readiness: TDD evidence

Date: November 20, 2026. Journeys were derived from the [production readiness review](../reviews/production-readiness-2026-11-20.md), particularly result recovery, bounded processing, and monitoring. This task did not receive a plan file.

## User journeys

- As a user, my overdue bet remains pending until verified evidence exists, and an operator can see that processing needs attention.
- As an operator, I can distinguish a normal pending game from a missing final, failed retrieval, ambiguous grade, or failed settlement backlog.
- As an operator, each bounded pass advances through the backlog without allowing old unresolved events to starve other games.
- As a release monitor, I can detect stale workers, failed feeds, overdue settlements, and ledger discrepancies without receiving provider secrets or personal data.

## Executed RED and GREEN

`node --test tests/jobs.test.mjs` produced a valid RED with **6 passed / 8 failed** before worker changes. Failures covered missing/incomplete overdue results, retrieval failure review, unrecorded backlog failure, absent durable batching, uncleared review state, absent maintenance, and long provider-ID review records. The first attempted RED had a fixture that omitted the legacy candidate RPC; its setup failure was corrected and excluded from evidence. The valid run exercised the old implementation and failed on intended assertions.

After the minimal worker changes, the same target passed **14/14**. A separate Unicode review-name case then reproduced a mismatch between JavaScript code-unit counting and PostgreSQL character counting; its RED was observed before the character-count correction. Final worker target: **15/15 passed**.

`node --test tests/operations.test.mjs` executed **10/10 failures** for the missing readiness evaluator before `server/operations.ts` was created. After implementation, the same ten tests passed.

Final combined command:

```text
node --test tests/operations.test.mjs tests/jobs.test.mjs
25 passed, 0 failed, 0 skipped

node node_modules/typescript/bin/tsc --noEmit
exit 0
```

## Test specification

| Guarantee | Test file / cases | Type | Result |
|---|---|---|---|
| Missing/incomplete results for open bets older than six hours produce review records and an unsuccessful pipeline, with no fabricated outcome | `tests/jobs.test.mjs`: overdue missing/incomplete cases | Worker integration with controlled provider/backend | PASS |
| Future games, the exact six-hour boundary, and already settled correction candidates do not generate overdue-open-bet alerts | Same file: pending threshold and settled correction cases | Worker integration | PASS |
| Result retrieval, grading, backlog, and retention failures become safe operational records instead of leaked raw exceptions or missing pipeline completion | Same file: retrieval, ambiguity, candidate failure, maintenance cases | Worker integration | PASS |
| The next pass resumes from a durable keyset cursor; processing uses a bounded 100-event default page and bounded maintenance | Same file: durable cursor / maintenance cases | Worker integration | PASS |
| Verified finals clear previously recorded review state; long and Unicode provider IDs use valid, consistent job names | Same file: review resolution / long-ID / Unicode cases | Worker integration | PASS |
| Readiness requires a fresh successful pipeline and all required odds feeds, independently checks balances and overdue bets, and fails on recent job errors | `tests/operations.test.mjs`: heartbeat, feeds, ledger, settlements and job failures | Unit | PASS |
| Readiness returns fixed codes and counts rather than private job details, and old transient failures do not permanently prevent recovery | Same file: redaction / obsolete failures / injected time | Unit | PASS |

## Coverage

Executed:

```text
node --test --experimental-test-coverage --test-coverage-include='server/jobs.ts' --test-coverage-include='server/operations.ts' tests/jobs.test.mjs tests/operations.test.mjs
25 passed, 0 failed, 0 skipped
jobs.ts: 100.00% lines / 86.36% branches / 100.00% functions
operations.ts: 100.00% lines / 100.00% branches / 90.00% functions
Combined selected scope: 100.00% lines / 91.26% branches / 95.65% functions
```

## Operational behavior and remaining proof

The worker reads the latest pipeline record's `detail.nextCursor`, processes one keyset page through `beter_settlement_batch`, and persists the next cursor in its pipeline completion record. End-of-backlog resets the cursor so later passes revisit pending events and recent corrections. A failed backlog read retains the prior cursor. Per-event failures remain retryable on the next traversal; they cannot permanently monopolize the first page. Result review details retain event identifiers, scheduled start, age, and a fixed reason code without copying raw provider errors.

Scores beyond the provider's configured retrieval window are not invented or automatically backfilled. Overdue events require the separately protected, audited operator resolution procedure. SQL automation holds prevent a later automatic pass from replacing an intentional manual resolution. The SQL migration and real local database integration are validated separately by the database task.

The readiness evaluator uses a 150-second heartbeat budget by default (two one-minute intervals plus delivery grace), allows a small future-clock tolerance, and exposes only safe status codes/counts/ages. Deployment monitoring still needs to poll the endpoint, deliver alerts to an owner, and prove receipt in staging. Real provider availability, hosted schedules, independently concurrent workers, operator authorization, and alert delivery are not established by these controlled tests.

## Merge evidence

The workspace was not a Git repository when this work began, so no checkpoint commits were created. Preserve this RED/GREEN index alongside the eventual release. No hosted requests or production credentials were used in these worker/readiness tests.

## Operator CLI and recovery runbook

The parent task subsequently assigned the protected monitor/operator CLI and recovery documentation. Before creating `scripts/ops.mjs`, `node --test tests/operator-cli.test.mjs` executed **11/11 failures** on the missing exported runner. The same target then passed **11/11**, including readiness exit status, authenticated requests, protected result/resume payloads, bounded maintenance, invalid setup and review files, output redaction, loopback development, and a stalled response-body deadline.

Executed:

```text
node --test --experimental-test-coverage --test-coverage-include='scripts/ops.mjs' tests/operator-cli.test.mjs
11 passed, 0 failed, 0 skipped
ops.mjs: 94.90% lines / 86.73% branches / 95.00% functions

node --check scripts/ops.mjs
exit 0

node --test tests/full-flow.test.mjs
1 passed, 0 failed, 0 skipped
```

The full-flow case uses the actual local API, migrated database and worker, confirming account → quote → accepted bet → automated final → idempotent replay reconciliation with the new worker RPCs. It does not establish hosted execution.

[Operations and recovery runbook](../OPERATIONS.md) documents monitoring, audited resolution and holds, incident containment at both HTTP and direct-RPC boundaries, application rollback compatibility, and an isolated backup restore/reconciliation drill. Real owners, alert destinations, objectives, backup access, staging execution and restore results remain deployment work. The CLI takes credentials only through the private environment, uses HTTPS except loopback, bounds review input and requests, and outputs only allowlisted summaries. The supplied operator identity is an audit label; attribution also depends on restricted secret access and retained platform/review records.

## Independent review follow-up: persistent operator reviews

An independent review identified that unresolved review records must not age out with transient job failures. Added two evaluator cases and a monitor-output case before changing production logic. The combined evaluator/CLI target executed **21 passed / 3 failed**: an old failed review incorrectly left readiness true, the explicit review check was absent, and the CLI rejected the new review status. The minimal fix adds an independent `reviews` check (`UNRESOLVED_REVIEWS` / `NO_UNRESOLVED_REVIEWS`), keeps unresolved latest review records blocking without a time limit, and retains the time window only for transient failures. The CLI allowlist recognizes these fixed safe codes.

Final executed verification:

```text
node --test tests/operations.test.mjs tests/operator-cli.test.mjs tests/jobs.test.mjs
39 passed, 0 failed, 0 skipped

node --test --experimental-test-coverage --test-coverage-include='server/jobs.ts' --test-coverage-include='server/operations.ts' --test-coverage-include='scripts/ops.mjs' tests/jobs.test.mjs tests/operations.test.mjs tests/operator-cli.test.mjs
39 passed, 0 failed, 0 skipped
jobs.ts: 100.00% lines / 86.36% branches / 100.00% functions
operations.ts: 100.00% lines / 100.00% branches / 91.67% functions
ops.mjs: 94.90% lines / 87.61% branches / 95.00% functions
Combined selected scope: 97.90% lines / 89.64% branches / 95.56% functions

node node_modules/typescript/bin/tsc --noEmit
exit 0
```
