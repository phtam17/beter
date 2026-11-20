# Isolated live provider check: TDD evidence

## Safe provider diagnostics update

RED `8c26d0b`:12 cases executed,6 pass /6 fail because account failures were generic and observed quota disappeared on failure. GREEN `89e9d06`:same12 cases pass; TypeScript passes. The coverage command below now reports **100% lines /92.63% branches /92.86% functions**.

The temporary probe captures only the provider's HTTP status and validated numeric quota headers before the existing adapter processes the response. The task-specified classifications are401=`PROVIDER_KEY_INVALID`,402=`PROVIDER_QUOTA_EXHAUSTED`,403=`PROVIDER_ACCESS_DENIED`,429=`PROVIDER_RATE_LIMITED`; other HTTP errors and network failures remain `PROVIDER_UNAVAILABLE`. HTTP200 malformed payload/normalization errors return `PROVIDER_INVALID_DATA`. No provider response bodies or messages are parsed into diagnostics or returned.

Failures retain a quota object when any valid numeric headers were observed; missing/untrusted values are omitted. Successful checks still require all three quota fields. Quota also survives no-future-market, invalid-data, quota-validation and observed-header timeout paths.

The current [official provider error guide](https://the-odds-api.com/liveapi/guides/v4/api-error-codes.html) distinguishes invalid/deactivated keys from exhausted usage credits and explicitly documents HTTP429 for rate limits. It does not specify every HTTP-status/error-code pairing, so the operator should consider retained quota values alongside the requested classifier. Actual provider/hosted invocation remains the root agent's task; this update made no AWS/provider requests.

Journey: an IAM-authorized temporary AWS function checks real provider egress, normalized future NBA moneylines, and remaining quota without loading application/database credentials or writing financial records. The root agent owns its deployment, invocation and cleanup.

- RED `eea30d5`: `node --test tests/aws-provider-check.test.mjs` executed9 cases,0 pass /9 fail for the missing factory/export.
- GREEN `77dd597`: same9 cases pass. `node node_modules/typescript/bin/tsc --noEmit` passes.
- Regression: `node --test tests/aws-provider-check.test.mjs tests/provider.test.mjs tests/aws-handler.test.mjs` passes39 cases.
- Coverage: `node --test --experimental-test-coverage --test-coverage-include='aws/provider-check.ts' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/aws-provider-check.test.mjs` passes9 cases with **100% lines /91.03% branches /92.86% functions**.

| Guarantee | Tests | Result |
| --- | --- | --- |
| Only source=beter.operator/task=verify-provider is accepted; HTTP/scheduler inputs and expired/missing funding cutoff stop before loading secrets | operator/cutoff cases | PASS |
| Only the dedicated BETER_PROVIDER_SECRET_ARN is read using GetSecretValue; runtime/environment odds keys are never substituted | dedicated secret cases | PASS |
| Dedicated secret is a bounded JSON object containing only apiKey; malformed secrets/provider exceptions return fixed safe codes | secret/error cases | PASS |
| Existing real provider adapter requests NBA/draftkings odds once with h2h,spreads,totals and American prices, without requesting results | live normalization case | PASS |
| Only normalized future events with moneylines contribute to positive success counts; no synthetic provider is used | future/moneyline cases | PASS |
| Quota output contains only nonnegative safe integers from x-requests-remaining/used/last; no event IDs, teams, bodies, URLs, keys or provider error text leave the function | quota/error/shape cases | PASS |
| One default14-second deadline, capped at15 seconds, aborts SDK lookup, fetch and response-body consumption; redirects are refused | deadline case | PASS |
| providerProbeHandler is an explicit export separate from the public API handler; probe imports no database/runtime modules | export test and source inspection | PASS |

The current [official The Odds API v4 documentation](https://the-odds-api.com/liveapi/guides/v4/) was checked before implementation. It defines the three quota headers as remaining usage, usage since reset, and the last call's credit cost. The probe reports the numeric response values rather than inferring remaining quota from event count. The existing adapter requests three markets from one bookmaker; no scores/results request is made.

Factory: `createProviderProbe({env,secretClient?,fetchImpl?,now?,timeoutMs?})`. Production export: `providerProbeHandler` from `aws/handler.ts`; the generated deployment entry must re-export it as `index.providerProbeHandler`. No other API handler behavior changed in this task.

No AWS/provider requests were made by these tests. Actual proof still requires root to create the temporary IAM-only function and dedicated secret, invoke it once, retain only the redacted count/quota result, and delete temporary resources. Successful local fixtures do not claim hosted egress or current provider quota has been verified.
