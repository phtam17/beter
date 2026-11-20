# Bounded account summaries and history client: TDD evidence

Date: November 20, 2026. Journeys were derived during the production-readiness fix from the remaining unbounded-history finding and the agreed fourth migration contract. No plan file or embedded validation commands were used.

## User journeys

- As an account holder with more than one page of bets, I see portfolio-wide statistics rather than totals computed from the most recent page.
- As an account holder, I can request older/filter-specific history with bounded pages and cancel it when the owning view or account changes.
- As an account holder, I can distinguish sampled chart data from a complete ledger history.
- As a maintainer, malformed counts, unsafe cent arithmetic, incomplete summaries, and invalid pagination metadata fail explicitly instead of rendering plausible but incorrect totals.

## Executed RED/GREEN

Before production edits:

```text
node --test tests/readiness-summary.test.mjs
2 passed, 9 failed, 0 skipped
```

The failures exercised the existing implementation: it reported 1 visible bet instead of 600 total bets, omitted pagination/sampling metadata, accepted invalid summaries, failed to reject unsafe summary arithmetic, and lacked the history client method. Existing empty/demo behavior passed and was retained.

After implementation:

```text
node --test tests/readiness-summary.test.mjs tests/client.test.mjs tests/engine.test.mjs
56 passed, 0 failed, 0 skipped
```

An additional metadata case then proved that explicit `null` sampling values were incorrectly treated as missing defaults. The focused metadata target executed one failing assertion before the undefined-only fallback was applied. Missing optional metadata remains compatible with earlier fixtures; explicitly invalid metadata is rejected.

Final executed verification, including pending-logout regressions from the parallel client task:

```text
node --test --experimental-test-coverage --test-coverage-include='dist/api-client.js' --test-coverage-include='dist/engine.js' tests/readiness-summary.test.mjs tests/client.test.mjs tests/engine.test.mjs tests/production-client.test.mjs
65 passed, 0 failed, 0 skipped
api-client.js: 100.00% lines / 94.69% branches / 100.00% functions
engine.js: 100.00% lines / 94.02% branches / 97.37% functions
Combined selected scope: 100.00% lines / 94.46% branches / 98.73% functions
```

## Test specification

| Guarantee | Test target | Type | Result |
|---|---|---|---|
| Global counts, bankroll, risk, profit, ROI, win rate and wins/losses/voids use complete server summaries rather than recent rows | `tests/readiness-summary.test.mjs`: complete statistics case | Unit | PASS |
| Summaries require complete safe nonnegative counts/cents and internally consistent totals; cent additions cannot exceed safe integer precision | Same file: invalid summary and unsafe arithmetic cases | Unit | PASS |
| Audited negative balances are preserved; empty summaries have defined zero ratios; legacy/demo calculations remain compatible | Same file: negative balance, empty summary and legacy/demo cases | Unit | PASS |
| Cursors and sampled-ledger metadata are exposed in the presentation model and invalid metadata fails explicitly | Same file: metadata cases | Unit | PASS |
| History queries safely encode parameter values, retain newest-first order and share the accepted-bet adapter | Same file: encoded history case | Client integration with controlled HTTP | PASS |
| History requests carry lifecycle cancellation and reject invalid pages, currency or options | Same file: cancellation and validation cases | Client integration with controlled HTTP | PASS |
| Existing public cookie-session, pending-logout, placement and demo behavior remain intact | Existing client/production-client/engine targets in final command | Regression | PASS |

## Implementation contract and privacy

The fourth migration supplies `summary` with `total_bets`, `open_bets`, `settled_bets`, `wins`, `losses`, `voids`, `amount_at_risk_cents`, `total_staked_cents`, and `settled_staked_cents`. The last field covers won/lost stakes, excluding voids, matching the existing ROI definition. `adaptPortfolio` validates and freezes the normalized `accountSummary`; `getStats` returns a separate copy. Derived values use validated integer cents before conversion to dollars.

Optional presentation fields are `historyNextCursor`, `ledgerSampled`, and `ledgerTotalPoints`, sourced from `history_next_cursor`, `ledger_sampled`, and `ledger_total_points`. Legacy fixtures without the fields retain the existing calculation path. Explicitly malformed metadata is rejected. The summary stores aggregate numbers in memory only; it introduces no Web Storage persistence, credentials, logging, or cross-origin fetches. Existing cookie transport, pending-logout checks and request-generation handling are preserved.

`api.history(portfolioId,{before,limit=100,status=null,signal})` uses authenticated same-origin GET requests, a maximum page size of 100, a validated optional UUID cursor/status, and the existing deadline/cancellation helper. It returns `{bets,nextCursor}` with shared normalized bet records, preserving the server's newest-first page order. The UI owns view/account generation checks and full CSV traversal/cap handling; those browser tests are maintained in the parallel UI task.

## Modern Web Guidance

Searched `paginate history requests`, rephrased once as `fetch paginated list`, then retrieved `js`. No dedicated pagination guide matched. The complete 396-line guide was read from `/var/folders/_h/skymk_vd3yl24zg4c86q_gbh0000gn/T/mwg-guide-28111-1795212364295.md`.

- **`js`**: I used `URLSearchParams` for the new history query so reserved characters in values cannot inject another parameter, while omitted cursor/status values remain absent. The applicable rule is “rely on `URLSearchParams` to preserve `=` characters inside parameter values”. Existing abort fallbacks were reused rather than changed.

## Known gaps and merge evidence

The bounded database behavior, UI pagination/export flows, hosted release, capacity tests and cross-browser acceptance are recorded by the corresponding tasks. These unit/client tests do not claim hosted execution. No Git repository existed at task start, so no checkpoint commits were fabricated. Preserve this RED/GREEN report with the eventual release.
