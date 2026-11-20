# Odds-provider and grading TDD evidence

## Source and journeys

Journeys were derived from the infrastructure and implementation plan in this chat. No plan file was executed. This work covers server-side feed normalization and final-score grading, not a live provider connection or hosted deployment.

- A practice user sees a reference bookmaker’s prices with source and retrieval timestamps.
- An expired, malformed, unsupported, or unavailable feed does not become a fabricated live market.
- A server worker grades supported full-game selections only from confirmed matching final scores.
- Reprocessing the same final evidence produces the same result version; corrected evidence produces a different version.
- Local development uses a clearly identified synthetic feed, with results determined by the server clock.

## RED / GREEN evidence

### Initial feature cycle

Before adding either production module, ran:

```sh
node --test --test-reporter=dot tests/provider.test.mjs tests/grading.test.mjs
```

Result: exit code 1, all 19 tests failed. Representative failures were `The real odds-provider adapter must exist` and `Server-side final-result grading must exist`, with actual `undefined` instead of `function`. Dynamic imports deliberately returned an empty module only while the implementation was absent, allowing the missing behavior to be asserted at runtime.

After implementing the adapter and grader, ran:

```sh
node --test tests/provider.test.mjs tests/grading.test.mjs
```

Result: 19 tests passed, 0 failed, 0 skipped.

### Spread consistency regression

Added a test proving that inconsistent opposite spread lines must be rejected, then ran:

```sh
node --test --test-name-pattern='inconsistent spread handicaps' tests/provider.test.mjs
```

RED: 1 test failed with `Missing expected rejection.` Added the paired-line validation and reran the complete scoped coverage command below.

GREEN: 20 tests passed, 0 failed, 0 skipped.

## Test specification

| Guarantee | Test target | Type | Result |
|---|---|---|---|
| Six primary two-way selections normalize with stable IDs, prices and timestamps | `tests/provider.test.mjs` | Provider contract with realistic recorded-shape fixtures | PASS |
| Line and price changes retain the selection’s identity | `tests/provider.test.mjs` | Unit | PASS |
| Missing bookmaker data produces zero available selections | `tests/provider.test.mjs` | Unit | PASS |
| Three-way and unsupported markets are excluded | `tests/provider.test.mjs` | Unit | PASS |
| Unsupported sports, malformed events, bad prices and future update timestamps are rejected | `tests/provider.test.mjs` | Unit | PASS |
| Opposite spread lines and shared over/under thresholds remain consistent | `tests/provider.test.mjs` | Unit | PASS |
| Rate limits, downtime, invalid JSON, network failures and timeouts return sanitized errors | `tests/provider.test.mjs` | Mocked HTTP integration | PASS |
| Pending results remain pending; finals require matching integer scores and dated evidence | `tests/provider.test.mjs` | Provider contract | PASS |
| Synthetic events retain a stable schedule and become final only after the server clock advances | `tests/provider.test.mjs` | Unit | PASS |
| Moneylines, signed spreads, totals, ties, pushes, and zero scores grade deterministically | `tests/grading.test.mjs` | Unit | PASS |
| Incomplete or mismatched evidence and unsupported scopes cannot be graded | `tests/grading.test.mjs` | Unit | PASS |
| Result revisions are deterministic and distinguish corrected evidence | `tests/grading.test.mjs` | Unit | PASS |

## Coverage and type validation

```sh
node --test --experimental-test-coverage --test-coverage-include='server/provider.ts' --test-coverage-include='server/grading.ts' --test-coverage-lines=80 --test-coverage-functions=80 --test-coverage-branches=80 tests/provider.test.mjs tests/grading.test.mjs
```

Actual result: 20 tests passed; exit code 0. Scoped coverage:

| File | Lines | Branches | Functions |
|---|---:|---:|---:|
| `server/provider.ts` | 100.00% | 92.25% | 92.00% |
| `server/grading.ts` | 100.00% | 94.55% | 100.00% |
| Combined | 100.00% | 92.89% | 93.10% |

Strict TypeScript validation also completed successfully:

```sh
node_modules/.bin/tsc --noEmit --target ES2023 --module esnext --moduleResolution bundler --allowImportingTsExtensions --strict --skipLibCheck server/provider.ts server/grading.ts
```

## Operational boundaries

- Real HTTP requests require a private provider key. Tests mock HTTP; no paid provider requests or live odds checks were performed.
- NBA, NFL and NHL are the supported sport keys. Only full-game, two-way moneylines, spreads and totals are normalized.
- Full-game grading uses the provider’s final score, including its overtime and NHL shootout accounting. Period, regulation-only, three-way, Asian quarter-line and player-prop markets are excluded.
- A two-way moneyline tie or an exact whole-number spread/total pushes the selection and produces `void` for a refund.
- Missing/cancelled/postponed events are not automatically declared void from absence. The caller must retain unresolved events for review.
- Provider update timestamps more than 60 seconds ahead of the server clock are rejected. The calling service must separately enforce quote age and market freshness.
- Each refreshed event is an authoritative selection set for the configured reference bookmaker. Database ingestion must close selections that disappear, including when a bookmaker is missing.
- The sample adapter’s schedule is anchored to adapter construction. Keep one adapter instance for a local running process; process restarts intentionally create a new local sample schedule.
- Financial settlement and correction idempotency belong to the database integration, not these pure grading functions.

## Checkpoints

The supplied project was not a Git repository. No Git checkpoint commits were created. RED/GREEN evidence is preserved here for the parent task’s consolidated report.
