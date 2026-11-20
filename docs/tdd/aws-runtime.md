# AWS runtime integration evidence

Journeys were derived from the authorized AWS adaptation: hosted visitors use Cognito accounts and shared PostgreSQL state; operators run the same settlement and retention jobs; browser responses never disclose deployment credentials. The AWS entry must stay independent of local storage code.

| Guarantee | Tests | Result |
| --- | --- | --- |
| Explicit AWS mode accepts complete managed service settings without Supabase and always applies hosted safeguards | `tests/aws-config.test.mjs` | PASS |
| Database and secret identifiers stay in one region/account; HTTPS, private credentials, explicit staging sample mode, and a live provider key are required | `tests/aws-config.test.mjs` | PASS |
| Secrets Manager supplies the four trusted runtime secrets and overrides environment values before settings validation | `tests/aws-runtime.test.mjs` | PASS |
| Missing, invalid, binary-only, malformed, oversized, and failed private settings fail safely; stalled retrieval aborts at a deadline | `tests/aws-runtime.test.mjs` | PASS |
| The public configuration endpoint excludes private keys and resource identifiers | `tests/aws-runtime.test.mjs` | PASS |
| Cognito recovery runs behind persistent global/identity/source limits using the AWS entry's verified source address | `tests/aws-runtime.test.mjs` | PASS |
| The Data API transport carries the runtime database secret, anonymous role context, and committed API queries | `tests/aws-runtime.test.mjs` | PASS |
| Concurrent jobs share one pass, bounded retention remains in that pass, and closing waits for jobs and releases owned clients | `tests/aws-runtime.test.mjs` | PASS |
| Default process settings and SDK constructors work in live mode without importing local runtime/PGlite; TypeScript includes AWS entrypoints | `tests/aws-runtime.test.mjs` | PASS |

## Checkpoints

- `f9a4d72`: initial RED — 10 tests executed, 9 failed for missing AWS settings/runtime, 1 existing rejection passed.
- `a624409`: initial GREEN — all 36 new and relevant existing tests passed; `npx tsc --noEmit` passed.
- `6fafbdf`: additional RED — 13 passed, 1 failed because AWS could report `production:false` when `NODE_ENV` was omitted. Added deadline, binary-secret, and default SDK coverage also passed.
- `766c6ca`: additional GREEN — all 40 relevant tests passed; AWS is hosted regardless of `NODE_ENV`; TypeScript passed again.

Final coverage command:

```text
node --test --experimental-test-coverage --test-coverage-include='server/aws-runtime.ts' --test-coverage-include='server/config.ts' tests/aws-config.test.mjs tests/aws-runtime.test.mjs tests/config.test.mjs tests/runtime.test.mjs tests/readiness-api.test.mjs
```

Result: **40 passed, 0 failed, 0 skipped**. Across the two implementation files: **100% lines, 95.16% branches, 100% functions**. `aws-runtime.ts`: 100/94.12/100; `config.ts`: 100/95.56/100.

`npx tsc --noEmit` passed after both GREEN checkpoints. Tests used injected stores/SDK transports, and mocked Secrets Manager for default SDK construction. They did not contact hosted AWS.

Hosted work remains: verify IAM least privilege and private runtime database grants against the actual cluster; apply/check all migrations; prove CloudFront origin protection and source-header replacement; verify Cognito confirmation/recovery delivery, TLS/CSP/cookies, cross-instance quotas, actual Data API responses, worker/readiness/retention, alarm delivery, and backup restoration. Sample staging does not establish live-provider correctness or public launch readiness.
