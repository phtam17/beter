# Beter production readiness review

This is the review snapshot before the fixes. See the [implementation evidence and remaining hosted gates](../tdd/production-readiness.md) for the follow-up status.

Production audit: **60/100, risky**. Keep the app internal until the sign-out, abuse-control, result-recovery, configuration, and hosted verification gates below are closed.

Reviewed November 20, 2026. Scope: the current local implementation in `/Users/phtam/Beter/beter`, including the browser, Node/Vercel API, Supabase adapter and migration, worker, CI configuration, and release documentation. The intended release is virtual-money practice with connected pregame moneyline singles. Real-money transactions and expansion into other connected markets are outside this review.

The score is a prioritization aid, not a measured reliability percentage. A local checkout cannot establish the status of remote services or configuration. Documentation says hosted checks remain outstanding; no deployed URL, remote CI result, backup-restore record, or current cloud configuration was verified here.

## Blockers before public launch

### 1. P1 — A failed sign-out can restore the account

**Confirmed behavior.** The client clears its in-memory session even when the sign-out request fails. The UI then says “Signed out on this device.” When the response never reaches the browser, its HttpOnly cookie survives and the next session restoration signs the account back in. This is a shared-device privacy problem.

Evidence: [client sign-out](/Users/phtam/Beter/beter/dist/api-client.js:82), [UI sign-out handling](/Users/phtam/Beter/beter/dist/app.js:650), [server cookie expiration](/Users/phtam/Beter/beter/server/browser-session.ts:88). A local fixture using the real API client and session handler reproduced successful sign-in, failed logout, a retained cookie, and restored account access. No hosted service was involved.

**Required change:** make failed logout visibly pending and retryable. If hiding the account immediately, persist a non-secret pending-logout intent that prevents automatic restoration until cookie revocation succeeds. Do not claim logout succeeded when the browser still holds usable credentials.

**Acceptance:** interrupt the logout request before its response, reload, and open another tab. The account must not silently reappear; completion or the remaining action must be explicit. Normal logout and server-side provider failures must still expire the cookie.

### 2. P1 — Public access needs durable abuse controls

**Confirmed implementation gap.** Auth requests have no application throttle. Account holders can repeatedly create portfolios and quotes, producing persistent rows without quotas. The database grants these RPCs directly to authenticated users, so a website-only request limit would leave another write path open. Supabase or hosting protections may exist remotely, but none were verified.

Evidence: [auth routing](/Users/phtam/Beter/beter/server/api.ts:64), [portfolio creation](/Users/phtam/Beter/beter/supabase/migrations/202611200001_beter.sql:134), [quote creation](/Users/phtam/Beter/beter/supabase/migrations/202611200001_beter.sql:205), [direct RPC grants](/Users/phtam/Beter/beter/supabase/migrations/202611200001_beter.sql:389).

**Required change:** add auth/IP throttling and enforce durable per-user write limits at the database boundary, or close the direct RPC path and provide an equivalently protected boundary. Establish signup access controls for the initial rollout. Preserve legitimate placement retries and idempotency.

**Acceptance:** bursts through both the website API and direct authenticated RPC access hit defined limits without unlimited database growth. Normal users, password recovery, and repeated submission of the same accepted request remain usable.

### 3. P1 — Unresolved results need an audited recovery path

**Confirmed behavior.** The provider requests scores with `daysFrom=3`. The worker silently skips missing/incomplete results and can record a successful pipeline despite overdue unresolved bets. Open bets remain durable, but repeated processing does not provide an older-result retrieval path. Cancellations, postponements, and ambiguous results are assigned to “operator review” without a concrete resolution procedure.

Evidence: [score request window](/Users/phtam/Beter/beter/server/provider.ts:187), [missing-result skip](/Users/phtam/Beter/beter/server/jobs.ts:19), [pipeline success](/Users/phtam/Beter/beter/server/jobs.ts:26), [documented review requirement](/Users/phtam/Beter/beter/docs/DEPLOYMENT.md:120). An offline worker fixture with an old pending event and an empty score response returned `errors:0`, `review:0`, `settled:0`, and recorded a successful pipeline.

**Required change:** detect overdue unresolved events, surface degraded processing, and implement an audited operator/backfill procedure using verified evidence. A documented, protected operational tool is sufficient; a full admin application is unnecessary. Missing data must continue to stay pending rather than becoming an invented result.

**Acceptance:** simulate an outage longer than the configured score window, a postponed game, and an ambiguous result. Each must become visible to an operator, be resolvable with retained evidence, and reconcile without duplicate financial effects after retries.

### 4. P1 — Production configuration and readiness can look healthy while unusable

**Confirmed behavior.** Production settings accept a missing worker secret and default the site URL to localhost. The public health endpoint always reports process liveness. A missing worker secret disables both job execution and detailed health. This can leave recovery links misdirected or processing disabled after an apparently healthy deployment.

Evidence: [settings validation and defaults](/Users/phtam/Beter/beter/server/config.ts:2), [liveness and protected operations](/Users/phtam/Beter/beter/server/api.ts:57), [recovery redirect construction](/Users/phtam/Beter/beter/server/supabase.ts:26). A network-free configuration/handler fixture confirmed HTTP 200 liveness for an unconfigured production setup. Liveness itself is correctly documented as limited; a separate readiness/release gate is missing.

**Required change:** validate required hosted settings, a sufficiently strong worker secret, a real HTTPS site origin, and the intended data mode. Add a separate bounded readiness check or deployment preflight for database access, required schema, worker configuration, and initial feed/job state. Preserve a cheap liveness endpoint.

**Acceptance:** intentionally omit or corrupt each required setting and ensure the release is refused or clearly marked unready. Verify the actual recovery URL and a fresh completed scheduled pass before invitations.

### 5. P1 — The hosted user journey and financial concurrency need release evidence

**Evidence gap, not a proven hosted failure.** Local embedded database tests and mocked provider/Auth responses do not establish actual Supabase roles, independent concurrent connections, email delivery, HTTPS routing, cookie refresh across instances, or scheduled HTTP completion. The independent PostgreSQL race target exists, but its recorded evidence explicitly says it has not executed locally. No remote passing run was verified.

Evidence: [independent-session test status](/Users/phtam/Beter/beter/docs/tdd/postgres-race.md:33), [configured CI checks](/Users/phtam/Beter/beter/.github/workflows/verify.yml:25), [remaining staging checks](/Users/phtam/Beter/beter/docs/DEPLOYMENT.md:104).

**Required verification:** run the PostgreSQL race target in a fresh disposable database and retain the passing result. On isolated hosted staging, verify two-user isolation; confirmation, sign-in, expiry/refresh and recovery email; a provider quote and accepted placement; duplicate retries; scheduled settlement and correction; and ledger reconciliation. Check actual provider entitlement and quota against the selected feed and polling schedule.

**Acceptance:** retain results tied to the exact release, including independent concurrent placement/replay/settlement checks and proof that Cron's HTTP request completed successfully. A queued request or green mocked test is insufficient.

### 6. P1 — Establish a recoverable, versioned release

**Evidence gap.** Neither the workspace nor app directory is a Git repository. A CI workflow exists, but no remote execution, immutable release identifier, deployed rollback, or restored database reconciliation was verified. Deployment documentation requires a backup drill but does not provide a tested recovery procedure.

Evidence: fresh `git status --short --branch` checks failed at both roots; [release evidence](/Users/phtam/Beter/beter/docs/releases/2.0.0/infrastructure.tdd.md:66), [backup requirement](/Users/phtam/Beter/beter/docs/DEPLOYMENT.md:104).

**Required change:** put the app under version control, run its CI, and record the deployed revision with its migration version. Write and rehearse application rollback and database recovery procedures, including how to pause new placements/jobs, protect accepted bets, restore into an isolated environment, and reconcile before resuming. Prefer forward repairs for financial data over destructive reversal.

**Acceptance:** another maintainer can identify the release, restore a backup, reconcile balances to the ledger, and recover service using the written procedure. Record recovery time and acceptable data loss for the intended rollout.

### 7. P1 — Connect monitoring to an owner and response procedure

**Implementation/configuration gap.** The protected health query and job history are useful foundations. Alert delivery, incident ownership, and operator response remain deployment instructions. Unexpected API exceptions are sanitized for users but discarded without private diagnostic reporting or request identifiers. Remote monitoring may exist, but it was not verified.

Evidence: [health metrics](/Users/phtam/Beter/beter/supabase/migrations/202611200001_beter.sql:357), [API error handling](/Users/phtam/Beter/beter/server/api.ts:103), [monitoring instructions](/Users/phtam/Beter/beter/docs/DEPLOYMENT.md:106).

**Required change:** wire alerts for missed successful worker runs, overdue settlements, ledger mismatches, provider quota/failures, and elevated API/auth failures. Add redacted private exception reporting and request correlation. Never record credentials, cookies, recovery tokens, or provider URLs containing keys. Assign an owner and a short response procedure.

**Acceptance:** deliberately stop the worker and introduce a safe test failure on staging. Confirm an actionable alert reaches the owner and can be traced to the failed operation. Verify ledger mismatch and unresolved-result alerts independently of the pipeline success flag.

## High-value fixes

1. **P2 — Bound growth and response sizes.** Quotes and job records have no scheduled pruning. Portfolio responses aggregate the entire bet and ledger history; settlement retrieves all open/recent candidates at once. Define retention for disposable records, preserve accepted financial evidence, paginate history, bound worker batches, and load-test realistic history sizes. See [portfolio aggregation](/Users/phtam/Beter/beter/supabase/migrations/202611200001_beter.sql:126), [settlement candidates](/Users/phtam/Beter/beter/supabase/migrations/202611200001_beter.sql:283), and [retention instruction](/Users/phtam/Beter/beter/docs/DEPLOYMENT.md:114).
2. **P2 — Complete account support and data handling.** The current account dialog provides sign-out; the footer provides practice settings. No user-facing support contact, data-use/retention explanation, or account deletion/anonymization request path was found. Define those product policies and an operational process that accounts for retained audit history before collecting public account data. See [account dialog](/Users/phtam/Beter/beter/dist/app.js:613) and [footer](/Users/phtam/Beter/beter/dist/index.html:37).
3. **P2 — Broaden browser and deployed smoke evidence.** Playwright currently runs Chromium. Verify Safari/WebKit and Firefox plus touch-device account, recovery, quote, and modal behavior. Add a small deployed staging smoke suite using isolated accounts. See [Playwright configuration](/Users/phtam/Beter/beter/playwright.config.mjs:4).

## Strengths already present

- Sensitive operations verify identity server-side and run caller-scoped database operations with ownership policies.
- Exact-cent placement, request idempotency, stale/start cutoffs, append-only ledger/evidence, and ordered corrections have meaningful local integration coverage.
- Browser credentials use encrypted HttpOnly cookies, secure production attributes, origin checks, and sanitized public errors.
- The connected market scope is explicit and unsupported bets are rejected; live-provider failures do not silently substitute sample prices.

## Evidence checked

Freshly executed in this review:

- `npm run test:coverage`: **189 passed, 0 failed, 0 skipped**; **97.98% lines, 90.07% branches, 98.83% functions** in the configured backend/shared-client/domain scope. This percentage does not include DOM rendering or SQL line coverage.
- `node node_modules/typescript/bin/tsc --noEmit`: **passed** against the existing generated Edge sources; no build regeneration was performed.
- Targeted offline reproductions of failed logout, missing-result pipeline success, and permissive production configuration.
- Read-only inspection of browser lifecycle, API/auth/session boundaries, SQL/RLS/grants, provider/jobs, Supabase/Vercel setup, CI, test configuration, and deployment/release records.

Earlier evidence inspected: **46 passing browser tests** from the preceding implementation pass. Those browser tests were not rerun for this review. They include controlled API fixtures and real local account/cookie flows; they do not prove a hosted release.

Not established here: deployed service state, remote CI success, independent PostgreSQL race success, live-provider entitlement, actual SMTP/confirmation/recovery delivery, multi-instance hosted session behavior, completed cloud scheduling, alert delivery, or backup restoration. No live provider requests, external scans, infrastructure creation, or production code changes were performed.

## Next action

Fix failed sign-out with a regression covering network interruption and reload, then enforce durable write quotas. Close the result-recovery/configuration gaps before running the hosted staging release rehearsal. Keep public signup closed until the seven launch gates have recorded acceptance evidence.
