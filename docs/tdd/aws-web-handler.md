# Free API Gateway website: TDD evidence

Derived journey: serve Beter's ten reviewed public files and its account API from one free AWS API Gateway hostname, while preserving closed staging, funding expiry, secure browser account transport and the existing CloudFront mode.

## Checkpoints

- RED `f1426f9`: `node --test tests/aws-web-handler.test.mjs tests/aws-handler.test.mjs` executed26 cases:14 existing pass /12 new fail. The missing static factory and public API gateway gate were the intended failures.
- GREEN `ee47b0b`: same26 cases pass after adding `aws/web-handler.ts` and explicit public gateway mode in `aws/handler.ts`.
- `node node_modules/typescript/bin/tsc --noEmit`: pass.

Coverage command actually run:

```sh
node --test --experimental-test-coverage --test-coverage-include='aws/handler.ts' --test-coverage-include='aws/web-handler.ts' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/aws-web-handler.test.mjs tests/aws-handler.test.mjs
```

Result:26 pass /0 fail. Combined **100% lines /84.76% branches /89.66% functions**. API handler:100/81.34/94.12; static handler:100/90.79/83.33. These tests inject public assets and runtime behavior; no AWS calls were made.

## Verified guarantees

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Missing/wrong staging credentials fail before asset/runtime loading; machine gate takes precedence over Basic fallback | static and API gate cases | PASS |
| Valid future funding cutoff is required for static/public Gateway; expiry overrides credentials and an open launch | cutoff cases | PASS |
| Static factory lazy-loads the packaged public asset map only after gate/method/path checks; a failed load can retry safely | load/failure cases | PASS |
| Only canonical map entries are served; malformed/encoded/traversal paths fail; unknown/API/hidden files never fall back to HTML | path cases | PASS |
| MIME is fixed by extension and checked against metadata; invalid base64/map values fail safely; decoded response size is bounded | MIME/map cases | PASS |
| GET/HEAD serve the same metadata; HEAD has no body; binary/base64 bytes are preserved | asset/HEAD cases | PASS |
| Static/API responses include CSP, HSTS, frame/content-type/referrer/permissions protections; private responses are no-store | security cases | PASS |
| Public API strips Basic gate credentials and all incoming proxy/origin-secret/source headers, preserves account Bearer/cookies, and uses actual Gateway sourceIp | identity/transport case | PASS |
| Browser Origin remains untrusted input for downstream CSRF validation; configured SITE_URL alone constructs the application URL | identity case | PASS |
| CloudFront origin-secret mode and worker/monitor isolation still pass their prior regression cases | existing14 cases | PASS |

## Runtime and package contract

`createAwsWebHandler({loadAssets,env?,now?})` receives a map keyed by canonical paths such as `/index.html` and `/app.js`. Each value contains `{body,contentType,isBase64Encoded?}`. The production `assetsHandler` imports the virtual `beter:public-assets` module lazily. Packaging owns this generated public-only map and the shared `index.assetsHandler` export; the static Lambda role must have no database or secrets permissions.

Public API mode is enabled with `BETER_PUBLIC_GATEWAY=true` or the explicit factory option. Both functions use SHA256 `BETER_STAGING_AUTH_HASH`, `BETER_LAUNCH_OPEN` and `BETER_FUNDING_CUTOFF_AT`. Basic authorization is removed before account handling; callers using account/worker Bearer credentials supply staging access separately in `X-Beter-Staging-Access`.

The current [AWS HTTP API Lambda integration documentation](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html) was checked before implementation. Its payload2.0 metadata and separate response cookie list underpin the sourceIp/cookie handling. Incoming request headers are not trusted as Gateway metadata.

Actual AWS integration/deployment, free hostname reachability, packaged byte verification, IAM enforcement, staging browser navigation, email/account journeys and launch checks remain hosted verification. The earlier CloudFront-specific hosted checker must select the new public Gateway topology before being used for a final report.
