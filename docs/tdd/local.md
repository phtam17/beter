# Local account backend TDD evidence

## Source and journeys

Derived from the approved implementation plan in this chat and the parent task’s local-verification requirement. The same PostgreSQL migration and financial RPCs run locally in PGlite; hosted identity remains Supabase Auth.

- A developer can create an account and keep its server-held portfolio across browser sessions and server restarts.
- Sign-in, expiry, refresh rotation and sign-out protect account access.
- Financial RPCs execute as the correct database subject, with independent anonymous, authenticated and worker roles.
- Local setup never pretends to send account-recovery email.

## RED / GREEN

Before adding `server/local.ts`, ran:

```sh
node --test --test-name-pattern='local accounts use normalized' tests/local.test.mjs
```

RED: exit code 1, 1 executed test failed with `The persistent local account backend must exist`; actual `undefined`, expected `function`. The test target executed correctly and asserted the intentionally missing implementation.

After implementing the local backend, ran:

```sh
node --test tests/local.test.mjs
```

GREEN: 12 tests passed, 0 failed, 0 skipped. Added direct on-disk digest inspection and a complete migration-backed financial journey, then ran the coverage target below: 13 passed, 0 failed, 0 skipped.

## Test specification

| Guarantee | Test file | Type | Result |
|---|---|---|---|
| Normalized account identity and independent random access/refresh credentials | `tests/local.test.mjs` | Integration | PASS |
| Wrong passwords and unknown accounts share a generic failure | `tests/local.test.mjs` | Integration | PASS |
| Duplicate accounts and invalid inputs are rejected | `tests/local.test.mjs` | Integration | PASS |
| Refresh credentials rotate once and invalidate their prior session | `tests/local.test.mjs` | Integration | PASS |
| Sign-out revokes access and refresh credentials together | `tests/local.test.mjs` | Integration | PASS |
| Access and refresh expiry are enforced independently | `tests/local.test.mjs` | Integration with controlled clock | PASS |
| Worker sentinels and forged credentials cannot authenticate as a user | `tests/local.test.mjs` | Authorization | PASS |
| Concurrent RPC calls keep each caller’s identity and restore database roles | `tests/local.test.mjs` | PostgreSQL integration | PASS |
| Anonymous/user callers cannot invoke a worker-only operation | `tests/local.test.mjs` | Authorization | PASS |
| Function and argument names reject SQL and namespace injection | `tests/local.test.mjs` | Integration | PASS |
| Unsupported local recovery returns an explicit error | `tests/local.test.mjs` | Integration | PASS |
| Only token digests, random salt and password derivations are persisted; accounts survive restart | `tests/local.test.mjs` | On-disk database integration | PASS |
| Actual account → grant → quote → place → idempotent retry → settlement → reconciliation works | `tests/local.test.mjs` | Complete PostgreSQL financial integration | PASS |

## Coverage

```sh
node --test --experimental-test-coverage --test-coverage-include='server/local.ts' --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 tests/local.test.mjs
```

Actual result: exit code 0, 13 tests passed. Coverage for `server/local.ts`: **98.57% lines, 95.12% branches, 94.44% functions**.

Scoped strict TypeScript validation passed:

```sh
node_modules/.bin/tsc --ignoreConfig --noEmit --target ES2023 --module esnext --moduleResolution bundler --allowImportingTsExtensions --strict --skipLibCheck --types node server/local.ts server/provider.ts server/grading.ts
```

## Boundaries and remaining verification

- Local development authentication uses salted scrypt password derivation, random 256-bit session credentials and SHA-256 persisted credential digests. Access lasts one hour; refresh lasts 30 days and rotates on use.
- The parent application must select this backend only for local development. Production uses the Supabase adapter and must reject local backend configuration.
- Migration checksums prevent silently reapplying changed schema definitions to persisted local data. Future schema changes require follow-up migrations or a separate local test data directory.
- PGlite serializes work in one embedded PostgreSQL instance. Multi-process locking and networked PostgreSQL race behavior require the hosted/staging verification described in the consolidated release report.
- This component performs no email delivery, cloud provisioning or paid provider calls.
- No Git checkpoints were possible because the supplied project was not a Git repository.
