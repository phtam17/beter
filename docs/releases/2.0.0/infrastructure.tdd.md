# Beter account infrastructure: TDD evidence

Date: November 19, 2026. Source: the infrastructure and implementation plan agreed in this chat. The plan remains in the chat at the user's request; no external plan file or embedded shell instructions were used. The user subsequently requested implementation with `ecc:tdd-workflow` and chose to configure external accounts afterward.

## User journeys

1. Create an account, receive one virtual $10,000 grant, and recover the same portfolio after signing in again.
2. Select a pregame moneyline, review the server's expiring quote, and confirm an accepted price and stake.
3. Retry an interrupted request without receiving another debit or bet.
4. Receive a confirmed final result, apply its payout once, and audit corrections without rewriting ledger history.
5. Keep one user's account records and all demo records separate from another account.
6. See explicit stale-price, connection and configuration failures without invented live prices or sample fallback.
7. Prepare the same application rules for Supabase, scheduled processing, and website deployment.

## Runner and baseline

The package-manager detector identified npm. The existing runner was Node's native `node:test`; the initial 23 simulation/fixture tests passed. The implementation retains that runner and adds Playwright for browser journeys and PGlite for executing the real PostgreSQL migration. Strict TypeScript checks cover backend modules, the Vercel entry, and the generated Supabase function source.

The workspace was not a Git repository. No checkpoint commits were fabricated or created on an unrelated branch. These reports preserve the RED/GREEN evidence instead.

## Execution mapping

| Plan behavior | Test target and actual command | RED evidence | GREEN evidence and guarantee |
|---|---|---|---|
| Authenticated API and protected financial operations | `node --test tests/api.test.mjs` | Initial 14 tests executed and failed: `The server API handler must exist.` Later password completion returned 404 instead of401; unconfigured live quotes returned201 instead of503. | Final16 API tests pass. Identity is checked, cent stakes are validated, privileged result endpoints are inaccessible to users, and missing live configuration blocks acceptance. |
| Accounts, sessions and persistence | `node --test tests/local.test.mjs` | Initial12 tests executed and failed on the missing local backend export. | Final13 tests pass, including password hashing, token rotation/revocation, account isolation, persisted restart and a full financial migration flow. |
| Authoritative ledger and quote boundary | `node --test tests/database.test.mjs` | Initial19 tests failed on missing RPCs, including `function public.beter_portfolio() does not exist`. Follow-up payout regressions reproduced `5 != 6` and `9267 != 9268`. Ordering regressions reproduced an older price replacing a newer one, stale settlement applying, and missing equal-time conflict rejection. | Final33 database tests pass. Grants, quote ownership/expiry, stale/start checks, exact rounding, request replay, RLS, immutable audit records and ordered corrections are verified. |
| Provider normalization and grading | `node --test tests/provider.test.mjs tests/grading.test.mjs` | Initial19 tests executed and failed on absent adapter/grading exports. | Final20 tests pass. Normalizes recorded bookmaker/score shapes, excludes unsupported scopes, rejects malformed/future data, handles provider timeouts and grades full-game rules. No live request is claimed. |
| Browser API contracts and refresh | `node --test tests/client.test.mjs` | Initial27 tests executed and failed on absent client/adapter exports. | Final32 tests pass. Session handling, one refresh for overlapping requests, unchanged placement retry IDs, recovery tokens and canonical cent mapping are covered. |
| Supabase integration and recovery | `node --test tests/supabase.test.mjs` | Initial9 tests failed on the absent adapter. Password completion later reproduced POST rather than PUT. | Final10 tests pass using provider-shaped HTTP fixtures. Caller JWTs and worker credentials are separated; Auth verification and recovery use the correct endpoints. |
| Runtime/configuration and HTTP serving | `node --test tests/config.test.mjs tests/runtime.test.mjs tests/http.test.mjs` | Initial5 config,2 runtime and4 web tests failed on their missing implementations. | All11 pass. Production cannot silently start the local account store; unconfigured live mode does not invent odds; static serving and request limits are checked. |
| Ingestion and repeated settlement | `node --test tests/jobs.test.mjs tests/full-flow.test.mjs` | Initial4 worker tests failed on missing processing. The whole-flow test later reproduced an already-applied result being reported as a new settlement (`1 != 0`). | All5 pass. Account→grant→quote→bet→automatic final→replay reconciles through the real API and database. Worker metrics count applied changes. |
| Hosted route preservation | `node --test tests/deployment.test.mjs` | Both tests executed and failed on missing hosted route handling. | Both pass. Nested account/job endpoints survive the static-site rewrite without external or traversal destinations. |
| Account browser journeys | `npx playwright test e2e/accounts.spec.mjs` | Browser tests executed against the previous UI and timed out on the absent Sign in action. Further recovery/configuration/copy regressions were executed before their fixes. A delayed bet response also reproduced the old balance replacing a newly created portfolio. | Final15 mocked-backend browser scenarios pass, including confirmation, changed/stale prices, interrupted retries, recovery, errors, independent demo mode,375px readability and rejecting responses from an earlier portfolio generation. |
| Actual local backend browser flow | `npm run test:e2e` | Additional validation of the previously implemented paths. A parallel trace-output collision caused teardown-only ENOENT failures, fixed by isolating concurrent output directories; this was not counted as a business RED. | Combined final17 browser tests pass, including actual local signup, quote, persisted bet, reload, signout/signin, account isolation and rejection of user grading. |

The original23 simulation/fixture tests remain green. See [database evidence](../../tdd/database.md), [provider evidence](../../tdd/provider.md), [client evidence](../../tdd/client.md), [local evidence](../../tdd/local.md), and [UI evidence](../../tdd/ui.md) for detailed test names and intermediate results.

## Final executed verification

```text
npm run build
Strict TypeScript check and portable deployment-source preparation: exit0

npm run test:coverage
tests 165
pass 165
fail 0
skipped 0
duration approximately 8.9 seconds
all files: 98.17% lines, 90.24% branches, 96.60% functions

npm run test:e2e -- --output=artifacts/final-test-results --reporter=list
17 passed (14.5s)

node --check serve.mjs
node --check dist/app.js
node --check tests/postgres-race.integration.mjs
all exit0
```

Coverage thresholds are enforced at80% for lines, branches and functions. The measured set is `server/*.ts`, `dist/api-client.js`, `dist/engine.js`, and `dist/markets.js`. Browser rendering is covered by Playwright acceptance tests rather than included in that unit coverage percentage. SQL behavior is integration-tested; no SQL line-coverage percentage is claimed. Deployment entry points are typechecked; actual platform execution is not claimed.

The final whole-flow test uses a controlled synthetic provider schedule while keeping evidence timestamps consistent with the database clock. A future-dated fixture initially failed after timestamp validation was tightened; the fixture was corrected without weakening production timestamp checks.

## Known gaps and staging gates

- No external Supabase, odds-provider or Vercel credentials were configured. The user explicitly chose later configuration. The available Supabase/Vercel connectors are disabled by workspace administration.
- No paid service, external database project, API subscription or public deployment was created.
- Provider parsing, hosted Auth/REST integration and recovery are tested against representative HTTP fixtures. Actual provider access, Supabase Auth/PostgREST behavior, SMTP delivery, scheduled HTTP execution and cloud deployment remain unverified until configured.
- Embedded PostgreSQL serializes requests. Seven independent-session PostgreSQL race scenarios are prepared in `tests/postgres-race.integration.mjs` and wired into CI, but have not run locally because no PostgreSQL server, Docker or `TEST_DATABASE_URL` is available. The opt-in target fails clearly when required configuration is absent; it is not silently skipped in the default suite. See [race evidence](../../tdd/postgres-race.md).
- A hosted backup restore and reconciliation drill remains a release requirement. CI configuration is present, but no remote CI run has been claimed.
- The connected beta intentionally supports pregame moneyline singles. The separate demo retains spreads, totals and parlays. Ambiguous/missing results remain pending for review.
- Open bets and recent settlements form the durable processing backlog; scheduled passes replay that database state. A separate queue service is not implemented for this initial beta.

## Merge evidence

There are no Git commits to squash in this workspace. Preserve this report and its linked RED/GREEN records when creating the project repository or a later pull request. Do not label unexecuted staging or independent-session checks as passing.
