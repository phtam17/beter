# Production readiness fixes: TDD evidence

Date: November 20, 2026. Source: the [production readiness review](../reviews/production-readiness-2026-11-20.md) and the user's instruction to fix its findings using TDD. No executable plan file was supplied. Journeys and guarantees were derived from that review.

## User journeys

1. A requested sign-out hides private account data across tabs and cannot silently restore an account after an interrupted request.
2. A public visitor can sign in or recover access within defined budgets; one account cannot create unlimited financial records through either the website or direct database RPCs.
3. A missing result becomes visible, stays pending without invented payouts, and can be resolved with attributable operator evidence without a late worker reversing it.
4. A deployer receives a clear failure for incomplete production configuration and a separate protected readiness verdict for actual dependencies, reconciliation, worker/feed freshness, and unresolved reviews.
5. An operator can inspect safe health output, perform an audited recovery, receive a nonzero monitor result, and follow a concrete rollback/restore procedure.
6. A release preserves accepted financial history while applying forward migrations, pruning disposable records, and processing a bounded, fair event backlog.

## Execution and RED/GREEN evidence

The ECC detector selected npm from `package.json`; the application uses Node's native `node:test` runner and Playwright. The app was not a Git repository during these RED/GREEN cycles. No checkpoint commits are fabricated; the reports below preserve the executed stages.

| Behavior | Actual target | Observed RED | GREEN and guarantee |
|---|---|---|---|
| Persistent sign-out intent, cross-tab gating, sign-in ordering, and honest storage fallback | `node --test tests/production-client.test.mjs` | 8 intended failures, followed by an additional shared-completion regression | 9 new cases pass; the marker contains only `1`, restoration retries termination first, private requests stop, and completion propagates without restoring identity. See [client evidence](production-client.md). |
| Persistent retry feedback, hidden account details, safe account-help links | `e2e/production-readiness.spec.mjs` | 5 executed browser failures; a later regression also exposed private email left in a closed dialog | The focused browser cases pass, including interrupted real HttpOnly-cookie termination/retry and compact help. Engine-specific final evidence is recorded in the client report. |
| Durable financial quotas, safe retention, audited resolution/holds, keyset history/batches and forward upgrades | `node --test --test-concurrency=1 tests/readiness-database.test.mjs tests/database.test.mjs tests/local.test.mjs` | Initial 12 new cases failed for absent safeguards; additional late-worker and incomplete-resolution regressions were executed before fixes | 63 focused cases passed; existing balances survive upgrade and the original financial migration is unchanged. See [database evidence](production-database.md). |
| Overdue result review, fair durable cursor, maintenance and safe readiness | `tests/jobs.test.mjs`, `tests/operations.test.mjs` | 8 worker failures and 10 missing-helper failures; later Unicode review-key regression | Passing worker/readiness tests cover ordinary pending games, overdue missing/incomplete results, provider failure, resumed batches and explicit review completion. See [worker evidence](production-jobs.md). |
| Readiness cannot age away unresolved review state | Same targets plus `tests/operator-cli.test.mjs` | 21 passed, 3 intended failures | 39 focused tests passed; an unresolved review stays blocking regardless of age until explicitly resolved. |
| Strict production setup, protected operator routes/readiness, safe diagnostics, quotas and destination validation | `node --test --test-concurrency=1 tests/readiness-api.test.mjs` | 13/13 failed for missing behavior; logs `/tmp/beter-readiness-api-red.log` | Same new cases passed after implementation. Extra boundary REDs covered long event IDs, UUID history cursors, runtime limiter wiring and larger protected review payloads. |
| Shared authentication limits and privacy-safe bucket keys | `node --test --test-concurrency=1 tests/auth-limits.test.mjs` | 4/4 failed for missing limiter/RPC; a later RED exposed new identity rows being inserted after a shared budget was depleted | All cases pass. HMAC bucket keys contain no raw email/IP; limits are durable; denial persists; exhausted shared budgets do not create arbitrary identity rows. |
| Local cookie termination acknowledgment and safe HTTP methods | `node --test tests/browser-session.test.mjs tests/http.test.mjs` | Intended failures for failed-provider logout acknowledgment and Node's operator-body cap; later GET/HEAD/preflight regression failed before its fix | 24 focused cases passed. Delivered browser logout responses expire the cookie and acknowledge local termination; network failure remains pending. GET/HEAD/preflight do not terminate it. Public bodies remain capped at 32 KiB; protected review evidence has a 1 MiB transport/API cap. |
| Private operator/monitor CLI | `node --test tests/operator-cli.test.mjs` | 11/11 failed before implementation | Passing cases cover protected readiness/status/resolve/resume/maintenance, invalid setup/input, authorization failure, safe output and response-consumption timeouts. See [worker/tool evidence](production-jobs.md). |

One unrelated mock-backend failure appeared during the transport RED run after the durable auth contract changed. Its mock was updated to acknowledge the new limiter RPC; it is not counted as intended RED. A first browser launch failed before executing tests and is also excluded from application RED evidence.

## Integrated verification

Fresh commands run after the production changes:

```text
npm run build
PASS — TypeScript and generated portable Edge sources

npm run test:coverage
295 tests; 295 passed; 0 failed; 0 skipped
99.01% lines / 91.21% branches / 99.06% functions
```

Coverage is the configured backend/shared browser API/domain scope. It does not claim SQL line coverage or DOM-rendering line coverage. The operator CLI has separate focused coverage evidence; browser behavior has Playwright acceptance coverage.

**Real PostgreSQL concurrency:** 9/9 passed, 0 failed/skipped, on installed PostgreSQL 15.14 in a fresh temporary database using a private Unix socket. The server was stopped and its task-owned temporary cluster removed. This covers the seven original races plus quota contention and operator recovery racing a worker. See [race evidence](postgres-race.md) and [raw output](/Users/phtam/Beter/beter/artifacts/production-postgres-races.log). CI's PostgreSQL 17 execution and actual Supabase behavior remain separate checks.

The final combined browser run passed **97/97, 0 skipped**, in approximately 1.3 minutes: **61 Chromium, 18 Firefox, 18 WebKit**. This includes the new bounded-history/export journeys. The runner uses a fresh sample-only local environment by default; an explicit `E2E_BASE_URL` uses the supplied server without starting another one. Firefox needed a task-only isolated application-data home on this Mac; no user browser profile or browser security setting was changed. WebKit exposed a focus-return defect that was reproduced and fixed before the final green run. See [client evidence](production-client.md). A [375px history screenshot](/Users/phtam/Beter/beter/artifacts/production-history-mobile.png) was visually checked for readable totals, clear paging, and overflow.

## Bounded-history follow-up

The remaining response-size issue was closed with a further observed RED/GREEN cycle. Six SQL cases first failed on 250 returned bets, 481 ledger rows, absent exact summary metadata, and filtered history outside the recent page. The forward migration now returns at most 100 recent bets and 200 representative chart points while computing exact all-history totals. Financial tests query the underlying ledger so sampling does not weaken their audit guarantees. The focused SQL/local suite passed **70/70**, and the real PostgreSQL race suite passed **9/9 again with schema version 4**.

Additional validation `node --test tests/operator-flow.test.mjs` passed a real local CLI → API → migrated SQL journey: reviewed cancellation, duplicate retry, reconciled balance, automation hold against a late worker, explicit resume, maintenance, and readiness. This is integration validation of implemented behavior, not a claimed new RED stage.

The browser adapter/domain target first executed **9 failed / 2 passed** before implementation. Additional sampling-metadata regressions were observed before their fixes. **65 selected tests passed** after validated exact summaries, immutable aggregate metadata, bounded cursor/filter requests, and cancellation were implemented. Two API regressions separately failed before schema-4 readiness and server-wide history filtering were wired, then passed. See [bounded SQL evidence](bounded-portfolios.md), [summary/client evidence](production-summary.md), and the client report for pagination/export browser evidence. Eight browser regressions were observed RED before the UI/export fixes; the same eight then passed. An additional delayed-filter validation passed on all three engines without a production change, confirming that loading/error states do not falsely claim no matching bets. They cover all-history totals, older/newer pages, server-wide filters, complete paged CSV export, stale-owner responses, the explicit 50,000-bet browser export limit, repeated cursors, and cancellation.

## What changed operationally

- Forward migrations `202611200002` through `202611200004` add durable quotas, operator controls/audit, bounded processing/history, exact portfolio summaries, representative chart points, maintenance, auth budgets and required schema metadata. Apply in order; never reapply or edit the original financial migration on an existing database.
- `GET /api/ready` is protected by the worker credential and fails with 503 when required checks fail. Process liveness remains separate at `/api/health`.
- `npm run ops -- check` provides a safe scheduler/monitor gate. Protected operator commands and recovery/rollback/backup procedures are documented in [OPERATIONS.md](../OPERATIONS.md).
- API failures use generated request identifiers and fixed diagnostic fields. Raw credentials, personal data, request bodies and provider URLs/errors are excluded.
- Auth/IP handling trusts Vercel forwarding headers only in the Vercel runtime, based on its documented overwrite behavior. Other hosts need their own trusted edge controls. [Vercel request-header documentation](https://vercel.com/docs/headers/request-headers).
- Public support/privacy/deletion destinations are validated, exposed without secrets, and discoverable in Help and data. Their actual hosted content and operation must be configured truthfully.

## Hosted setup and verification still required

These are not claimed complete by local tests:

| Gate | Required evidence before public invitations |
|---|---|
| Hosted release and CI | Create/link the remote repository and isolated staging/production deployments; retain the exact deployed revision and a green remote CI run, including PostgreSQL 17. |
| Supabase and secret scopes | Apply all forward migrations; verify actual RLS/grants/PostgREST and separate preview/staging/production secrets. Test hosted multi-instance session refresh, logout/revocation and account isolation. |
| Account email and abuse controls | Configure confirmation, sender/domain/SMTP, recovery redirects and direct Supabase Auth throttling/access controls; prove delivery and limits using isolated accounts. |
| Provider and processing | Confirm selected bookmaker/league entitlement and quota; prove a completed Cron/HTTP worker pass, quote/placement, automatic settlement, duplicate processing and correction. A queued HTTP request is insufficient. |
| Monitoring and ownership | Configure a named owner/backup owner, private log retention, monitored checks and alert escalation. Exercise missed-worker, unresolved-review, ledger mismatch and provider/API failure alerts and confirm delivery. |
| Recovery | Configure backups and retention; perform an isolated restore/reconciliation and compatible application rollback rehearsal, recording recovery time and data loss. |
| User support/data handling | Publish real support, data-use/retention and direct deletion destinations; operate and verify the stated account deletion/anonymization process while preserving required audit integrity. No contacts or policy promises were invented. |
| Capacity and devices | Load-test the intended history/event fan-out and polling schedule on staging; verify physical touch-device and supported browser behavior. |

Portfolio responses now contain at most 100 recent bets and 200 representative non-stake chart points, with exact all-history summaries. The browser history uses bounded pages and whole-history server filtering; CSV uses bounded page requests with an explicit browser-export limit rather than silent truncation. Each selected settlement event still contains all accepted bets for stable result evidence. Validate realistic event fan-out, polling, and export load for the intended rollout; the event-page limit does not prove unlimited per-event settlement capacity.

When browser storage is denied, a failed offline logout cannot persist intent across reloads; the interface explicitly warns about that risk and offers retry. Provider-side revocation and actual hosted cookie behavior still require verification. Local acknowledgment proves cookie termination on the device when the response arrives, not revocation of copied remote credentials.

## Release evidence

The original workspace had no Git history or remote CI run. RED/GREEN evidence is preserved in this report and its linked test reports. After the RED/GREEN cycles and successful verification, a local repository was initialized on `main` to record the initial verified source snapshot. No earlier checkpoint history is claimed. The release identifier is available with `git rev-parse HEAD` in the app directory. Remote repository hosting, branch protection, deployment linkage, rollback execution and owner acceptance remain setup/verification work. No external service was purchased or deployed, no live odds request was made, and no hosted restore or alert delivery is claimed.
