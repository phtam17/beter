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

## Optional repeating preview rounds

`BETER_SAMPLE_REPEAT_SECONDS` is optional and allowed only for explicit AWS staging sample mode. When present it must be an integer600–86400 and at least the configured duration plus60 seconds. The provider receives `repeatMs`; omitting it preserves all single-round/local behavior. The initial configured round keeps the existing epoch IDs. After the base start, event ingestion offers the next future round, with a distinct epoch ID. Results retain the current and prior cycles whose final time is within72 hours, including the base pending result before its start, so previously accepted bets and provider correction lookups keep matching.

- `3834214`: RED —12 tests executed,6 existing single-round checks passed/6 repeat checks failed.
- `840e971`: GREEN —39 provider/config/runtime checks passed and TypeScript passed.
- Broader coverage command above plus `tests/aws-sample-repeat.test.mjs`: **63 passed,0 failed,0 skipped**, **98.24% lines /94.71% branches /95.35% functions** across provider/config/runtime. The focused target does not exercise newly added runtime support-route lines; provider coverage is100% lines.

New tests prove stable IDs across cold factories, unique later cycles across all three sports, exact final-time and72-hour boundaries, at most434 returned results at the minimum repeat interval, invalid interval rejection, and worker settlement of a previously accepted base-round bet while ingesting a future round. No SQL files, migration checksums, or hosted resources changed.
