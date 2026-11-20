# Modern web fixes: TDD evidence

## Source and scope

Journeys were derived from the implementation review in `artifacts/review-modern-web.md` and the user's request to fix its nine findings and three smaller guidance gaps. No separate plan file was supplied. The package-manager detector selected npm from package.json; tests use Node's native test runner and Playwright. This project is not a Git repository, so checkpoint commits were unavailable; the executed RED/GREEN record is preserved here and in the test artifacts.

The changes preserve Beter's existing visual identity and native web controls. Apple's accessibility, layout, input, and focus principles were translated to the web; native iOS/macOS navigation conventions were not imposed.

## User journeys and guarantees

| Journey or guarantee | Test specification | Type | Final result |
|---|---|---|---|
| A late quote cannot confirm a different or cleared selection | `e2e/web-behavior.spec.mjs`: earlier-selection quote and Clear-during-quote cases | Browser | PASS |
| Once placement starts, later selection/Clear actions cannot change the recorded intent | Same file: actual-placement ownership case | Browser | PASS |
| Old authentication responses cannot replace a newer account or dismissed mode | Same file: close/reopen and pending mode-switch races; `tests/client.test.mjs` | Browser/unit | PASS |
| Old protected responses and logout completion cannot clear a newer public session | `tests/client.test.mjs` | Unit | PASS |
| Request deadlines include response-body consumption, including native/fallback abort APIs | `tests/client.test.mjs` | Unit | PASS |
| Browser credentials remain outside JavaScript-visible storage and response bodies | `tests/browser-session.test.mjs`; real-cookie case in `e2e/server-flow.spec.mjs` | Integration/browser | PASS |
| Cookie sessions reload, refresh, reject tampering/cross-origin mutation, and expire on logout | `tests/browser-session.test.mjs`; real local account/browser-cookie journeys | Integration/browser | PASS |
| Initial cookie identity restoration cannot be cancelled by a premature account action | `e2e/web-behavior.spec.mjs`: initial account identity case | Browser | PASS |
| Clear, remove, and authentication-mode changes leave meaningful keyboard focus | Same file: three focus cases | Browser | PASS |
| Statistics have valid description-list groups | Same file: statistics structure case | Browser | PASS |
| Payout calculations remain live while errors wait for blur/submit and clear during correction | Same file: stake-validation timing case | Browser | PASS |
| Input boundaries meet 3:1 contrast and Forced Colors retains selected-state shapes | `e2e/web-styles.spec.mjs`: field contrast and selected-state cases | Browser | PASS |
| Modal backdrop scrolling does not displace the page in supporting engines | Same file: modal backdrop case | Browser | PASS |
| Tablet touch targets are 44px independently of viewport width | Same file: coarse-pointer 768px case | Browser | PASS |
| Tokens/base CSS requests start even while the app stylesheet response is held | Same file: critical stylesheet discovery case | Browser/network | PASS |
| Previous account, portfolio, draft, recovery, price-change, retry, and responsive guarantees remain intact | Existing account, UI-refinement, and server-flow suites | Browser/API | PASS |

## RED record: tests before production changes

1. **Application behavior:**

   `E2E_BASE_URL=http://127.0.0.1:4174 node node_modules/@playwright/test/cli.js test e2e/web-behavior.spec.mjs --workers=1 --reporter=line --output artifacts/web-behavior-red`

   All seven original cases executed and failed for their intended reasons: a stale quote remained confirmable; old signin A replaced B; Clear/remove/auth-mode changes lost focus; four illegal `<small>` siblings appeared in statistics groups; clearing an actively edited stake immediately announced an error.

2. **Styling:**

   Same runner with `e2e/web-styles.spec.mjs` and output `artifacts/web-styles-red`: five executed and failed. Measured boundary contrast was1.369:1/1.417:1, selected-state outlines were absent in Forced Colors, backdrop scrolling moved the root 0→700, tablet targets were 30/32px, and imported stylesheets were not directly discoverable.

   The stylesheet test was strengthened to hold the app stylesheet response. With the prior loading arrangement briefly restored, token/base requests remained absent and that case failed. Direct links were then restored and the stronger case passed. This tested request discovery, not merely a source-string match.

3. **Secure sessions and deadlines:**

   `node --test tests/browser-session.test.mjs` initially executed 15 cases:12 failed, 3 passed. Missing browser-session sanitization, cookie restoration, origin policy, refresh/logout handling, and persistent sealing keys caused the intended failures; raw bearer compatibility already passed.

   `node --test --test-name-pattern='legacy script-readable|signin sends cookie|body consumption remains' tests/client.test.mjs` executed 3 and failed 3. The stalled body was still pending at 100ms despite a 25ms deadline.

   The real browser cookie/privacy case also failed before the server changes because browser signup JSON exposed access/refresh tokens (`artifacts/web-cookie-red`).

4. **Additional ownership cases:**

   Individual client tests made stale401 cleanup, overlapping refresh rotation/public-config cookie mutation, and stale logout cleanup RED before their fixes. Full commands/results are recorded in `docs/tdd/browser-sessions.md`.

   Pending sign-in mode switching was separately RED (`artifacts/web-auth-mode-red`): the Create account view disappeared when an older signin finished. Initial cookie restoration was separately RED (`artifacts/web-bootstrap-red`): the account trigger remained available before identity restoration. Their corresponding GREEN cases are in the final suite.

An interim test assertion incorrectly treated an opponent's name in event copy as the selected team. It was corrected to inspect the selection heading and was excluded from product RED evidence.

## Implementation and GREEN record

- Slip requests now have revision ownership, selection-ID validation, cancellation, and placement-time mutation protection.
- Authentication has client session-commit generations and UI attempt ownership. Closing/changing the auth mode cancels obsolete attempts. Initial cookie restoration has its own busy gate, independent of configuration loading.
- Fetch deadlines cover headers and JSON consumption, with `AbortSignal.timeout`/`AbortSignal.any` and feature-detected fallbacks.
- Browser sessions use an authenticated encrypted HttpOnly cookie; only public metadata stays in memory. Legacy script-readable sessions are removed. Browser responses expose no backend access/refresh tokens. Raw programmatic bearer API compatibility remains tested.
- Focus destinations are explicit, statistics markup is valid, and stake validation is separated from live calculation.
- Field borders use a separate stronger token; Forced Colors supplies system colors and shape distinctions; coarse-pointer targets are 44px; modal scroll chaining is contained; CSS discovery no longer depends on imports.

The expanded client/session target passed 46 focused unit/integration cases. The five styling cases passed after both the original and stronger resource-loading RED stages.

The first combined browser run passed 41/42; its quote-rejection regression exposed a current-request revision invalidation that skipped error rendering. After that valid regression failure, the request retained error-render ownership; the same quote-rejection case passed. Pending auth-mode cancellation also passed its focused rerun. Supplementary quote/Clear/placement cases passed before final validation.

Final complete browser command:

`E2E_BASE_URL=http://127.0.0.1:4174 node node_modules/@playwright/test/cli.js test --workers=1 --reporter=line --output artifacts/web-fixes-final`

**46 passed in 39.4s, no failures or skipped tests**, using the restarted current server and frozen source. This includes all previous account/draft/portfolio/recovery/responsive tests, the real HttpOnly-cookie journey, both authentication cancellation paths, delayed configuration, initial identity restoration, quote/Clear/placement ownership, and all styling checks.

## Build, coverage, and visual verification

`npm run build` passed.

`npm run test:coverage` passed **189 tests, 0 failures,0 skipped**. Overall measured coverage: **97.98% lines /90.07% branches /98.83% functions**. The command enforces the project's 80% thresholds. Its full output is `artifacts/web-fixes-coverage.log`.

New `server/browser-session.ts`:96.84% lines /82.46% branches /100% functions. Shared `dist/api-client.js`:98.55% /91.22% /100%. Node coverage measures server/shared domain and client modules; DOM UI behavior is covered by the browser suite, not represented as Node line coverage.

Lighthouse snapshot improved from accessibility 96 to **100**, with best practices 100 and SEO 100. The current report is `artifacts/web-fixes-lighthouse.json`. One unweighted accessible-name notice remains outside that score; no claim of a complete assistive-technology audit is made. Native browser inspection verified the desktop and 390px layouts, valid statistics, visible field boundaries, stake focus, no horizontal overflow, and no console warnings/errors. The browser suite also retains 320–1440px and 200% text checks.

## Browser and deployment limits

- Non-scrollable dialog/backdrop containment is progressive enhancement per the retrieved guidance. Safari can retain native modal focus/inertness and contain overflowing dialog content without supporting full non-scrollable-backdrop containment. No prohibited root overflow/fixed-position workaround was added; physical Safari was not tested.
- Existing saved logins require one fresh sign-in after migration. Separate personal practice/history/drafts are preserved; blanket Clear-Site-Data was intentionally avoided.
- HTTPS uses a Secure, HttpOnly, SameSite=Lax `__Host-beter-session` cookie. Loopback development has a separate HttpOnly cookie. Session secret persistence and hosted configuration are documented in `docs/DEPLOYMENT.md` and `.env.example`.
- Hosted Supabase, email delivery, real TLS deployment, and live provider behavior remain staging checks; local integration tests do not claim to exercise those services.

## Guidance applied

- `js`: lifecycle cancellation and deadlines through JSON consumption, distinguishing AbortError/TimeoutError with fallbacks.
- `privacy` and `security`: no sensitive Web Storage session data; protected same-origin cookies and origin checks.
- `html`: valid semantic grouping and logical focus after removal/replacement.
- `forms`: live calculations with blur/submit validation rather than keystroke alerts.
- `color`: 3:1 interactive boundaries and Forced Colors system-color/shape support.
- `form-factor-adaptation`: touch sizing independent of viewport layout.
- `prevent-page-scroll-under-modal-dialog`: dialog/backdrop containment with its explicit progressive-enhancement behavior.
- `performance`: direct critical stylesheet discovery instead of CSS imports.
