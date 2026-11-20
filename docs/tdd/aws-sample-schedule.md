# Fixed AWS staging sample schedule

The synthetic feed previously chose its start relative to each process startup. Separate Lambda cold starts could keep moving the same event forward, preventing an accepted sample bet from ever reaching final state. AWS staging sample mode now requires one configured absolute start and passes it to every provider instance. A new explicit start also creates a new event/result/selection identity, preserving the previous epoch's history.

Environment contract for API, worker and monitor:

- `BETER_SAMPLE_START_AT`: required UTC ISO timestamp ending in `Z`; seconds and optional1–3 fractional digits are accepted and normalized to milliseconds.
- `BETER_SAMPLE_DURATION_SECONDS`: optional integer60–10800, default10800. For the short rehearsal,120 seconds is valid.
- Both options are accepted only with `BETER_BACKEND=aws`, `BETER_ENVIRONMENT=staging`, `BETER_DATA_MODE=sample`. Overrides elsewhere are rejected.

Default local sample behavior stays at one hour after factory construction, a three-hour event duration, and the original local sample IDs. Explicit dates are copied so caller mutation cannot move a fixture. Invalid clocks, dates, durations, impossible timestamps and out-of-scope overrides fail validation.

| Behavior | RED | GREEN |
| --- | --- | --- |
| Separate cold factories retain one start/final timeline, validate schedule bounds, and receive the AWS runtime's fixed configuration | `29b1fd9`:27 passed/5 failed | `233a268`:32/32 passed; TypeScript passed |
| Same explicit epoch keeps matching event/result IDs; a different epoch creates distinct identities; local IDs remain unchanged | `695e2bc`:5 passed/1 failed | `d458b58`:57/57 relevant tests passed; TypeScript passed |

Validation command:

```text
node --test --experimental-test-coverage --test-coverage-include='server/provider.ts' --test-coverage-include='server/config.ts' --test-coverage-include='server/aws-runtime.ts' tests/aws-sample-schedule.test.mjs tests/aws-config.test.mjs tests/aws-runtime.test.mjs tests/provider.test.mjs tests/config.test.mjs tests/readiness-api.test.mjs
```

Final result: **57 passed,0 failed,0 skipped**. Coverage across provider/config/AWS runtime: **100% lines /95.58% branches /97.50% functions**. `npx tsc --noEmit` passed. Worker tests create separate runtimes before and after the fixed final boundary and observe the same absolute start with upcoming/final ingestion states. No hosted calls were made for this change; actual worker settlement remains a hosted rehearsal check.
