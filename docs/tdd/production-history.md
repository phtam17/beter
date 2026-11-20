# Bounded account history and exports: TDD evidence

Date: November 20, 2026. Source: the production readiness review's unbounded history/response-size finding, followed by the user's request to fix production-readiness issues with TDD. These journeys were derived during this run; no external plan commands were used.

## User journeys

1. See accurate all-time totals even when the account loads only its latest 100 bets and sampled chart points.
2. Find older bets and filter the complete account history without accumulating an unlimited list in the browser.
3. Retry a failed history request while keeping the last successfully loaded page available.
4. Export the whole supported history, independently of the currently visible page, with honest progress and cancellation.
5. Prevent delayed history/export responses from revealing a previous account after sign-out or a portfolio change.

## Implementation

The UI keeps one page of at most 100 cards. Newer/Older controls use server cursors; status filters request a fresh server-wide page. Only cursor navigation state is retained between pages. All-time statistics use the validated database summary, while sampled chart history is labeled explicitly. Loading and error feedback do not claim that a failed or pending query has no matching bets.

CSV export requests unfiltered pages of 100 records, builds bounded text chunks for the final Blob, reports progress, and supports cancellation. A repeated cursor fails visibly before another copy of the page is requested. The export checks account ownership/generation and its abort signal between requests and before creating a download. Browser export supports up to **50,000 bets**; larger histories require a separate full-export process and receive a visible error without a partial download.

## Executed RED/GREEN mapping

| Behavior | Executed command | RED | GREEN guarantee |
|---|---|---|---|
| All-time summary and sampled chart labeling | `E2E_BASE_URL=http://127.0.0.1:4175 node node_modules/@playwright/test/cli.js test --project=chromium --grep 'account history\|account CSV' --workers=1 --reporter=line --output artifacts/production-history-red` | Initial run: **6 failed**. The first 100 loaded records were presented as the complete account and chart sampling was not identified. | The matching account contains 101 bets, including a winner outside the recent page; the correct all-time count/win breakdown and sampling label display. |
| Bounded Newer/Older with retry | Same initial RED run | Older controls were absent. | A failed older-page request leaves the 100 loaded cards visible; retry shows the older page; Newer returns to 100 cards rather than appending indefinitely. |
| Server-wide result filter | Same initial RED run | Filtering recent open bets showed no winner instead of querying older history. | The Won filter requests server status `won` and displays the older winning bet. |
| Complete small CSV | Same initial RED run | The download contained only the visible 100 records and omitted the older winner. | The download contains all 101 records, fetching both 100-row pages with no result filter. |
| Account change guard | Same initial RED run | The older-page workflow did not exist. | A held history response released after sign-out cannot replace guest content. |
| Explicit browser export capacity | Same initial RED run | An oversized account exported a recent-only file without warning. | A 50,001-bet account gets an explicit 50,000 limit error before any history request/download. |
| Repeated export cursor and sign-out during export | Same command with `--grep 'repeated history cursor\|export cannot finish' --output artifacts/production-export-guards-red` | **2 failed**: the old export neither inspected cursors nor requested the held older page. | Repeated cursors stop within two requests with no download; signing out during a held export prevents completion. |
| Combined focused GREEN | Same base command with `--grep 'account history\|account CSV' --output artifacts/production-history-green` | — | **8 passed (6.8s)**, covering the guarantees above. |
| Syntax | `node --check dist/app.js` | — | **Passed**. |
| Final combined browser run | `E2E_BASE_URL=http://127.0.0.1:4175 PLAYWRIGHT_BROWSERS_PATH=/private/tmp/beter-readiness-browsers TMPDIR=/private/tmp/beter-readiness-firefox-profiles CFFIXED_USER_HOME=/private/tmp/beter-readiness-firefox-home node node_modules/@playwright/test/cli.js test --workers=1 --reporter=line --output artifacts/production-readiness-final` | — | **97 passed (1.3m)**: **61 Chromium, 18 Firefox, 18 WebKit**, no skipped cases. |
| Delayed filter follow-up | Same environment/runner with `--grep 'result filters search older records' --output artifacts/production-history-loading` | No production change needed: the implementation already rendered loading before empty states. | **3 passed (5.5s)** across Chromium, Firefox, and WebKit. A held Won response shows loading, never a false “No won bets,” and resolves to the older winner. |

Tests live in [production-readiness.spec.mjs](/Users/phtam/Beter/beter/e2e/production-readiness.spec.mjs). The helper, SQL, and exact-summary integration tests are recorded by their owning implementation work; DOM code is exercised by browser tests rather than included in the backend line-coverage percentage.

## Design and web guidance

The existing card layout, fonts, colors, and control styling are retained. Apple's `loading.md › Best practices` says: “Let people do other things in your app or game while they wait for content to load.” History requests and exports retain navigation, expose progress/retry/cancel controls, and do not block account sign-out. Existing accessibility guidance governs focus on the newly displayed page or retry action.

Modern Web Guidance searches `paginate long lists` and `load paginated list` returned no pagination-specific guide. Its broader `performance` guide was retrieved and read in full. The export yields between page-processing steps with feature-detected `scheduler.yield()`, “falling back to `setTimeout` wrapped in a Promise for unsupported browsers.” This also gives controlled, immediately resolved fixture responses a chance to paint progress and process cancellation.

## Browser configuration and limits

Playwright now runs the full suite in Chromium and the critical real-account/readiness suite in Firefox and WebKit. CI installs all three locked Playwright browser builds. An explicit `E2E_BASE_URL` uses an already prepared isolated server; the default managed server uses fresh temporary local/sample data, blanks hosted/provider credentials, and does not silently reuse another process.

The local Firefox app initially failed before opening a page because it could not initialize its profile/app-data directory. Retrying canonical temporary paths did not help. An empty task-only `CFFIXED_USER_HOME` let the locked browser run without touching the user's normal Firefox profile or disabling security settings. This matches the app-data isolation issue discussed in [Playwright's upstream tracker](https://github.com/microsoft/playwright/issues/42768); it is a local test-environment observation, not an application defect.

Browser installation actually executed: `PLAYWRIGHT_BROWSERS_PATH=/tmp/beter-readiness-browsers node node_modules/@playwright/test/cli.js install firefox webkit`. The existing local Chrome binary supplied Chromium verification. CI uses the committed `install --with-deps chromium firefox webkit` command with the project's locked Playwright dependency. The task-created app-data/profile folders and sample preview database are removed after verification; downloaded browser binaries remain available under `/tmp/beter-readiness-browsers` for this session.

The compact 375×1100 history capture is [production-history-mobile.png](/Users/phtam/Beter/beter/artifacts/production-history-mobile.png). It shows an all-time 101-bet summary with the 100-card page controls. The final combined run generated the capture; root inspected it for overflow and control clarity.

The first broader run also exposed a WebKit focus-return difference in the new Help dialog. Its existing expectation provided RED. Explicitly returning focus to the opener on the native dialog's close event fixed it; no custom focus trap was introduced.

Hosted authentication, real provider data, deployed cookies, actual email delivery, remote CI execution, and physical-device accessibility remain separate release checks. The local tests use controlled fixtures or the sample backend.

## Merge evidence

The working directory was not under Git during the RED/GREEN stages. No checkpoint commits are claimed. The reports and committed test sources preserve the stage evidence for the verified release snapshot.
