# Account UI TDD evidence

Source: the infrastructure and implementation plan in this chat. The user asked to keep that planning baseline in the chat; this document records implementation evidence only.

## User journeys

- Sign in and retrieve a server-held portfolio without mixing it with the browser demo.
- Select one pregame moneyline, review a server quote, and explicitly confirm the recorded bet.
- Receive clear stale-quote and connection errors without substituting sample account data.
- Reload a saved account session and create another portfolio while preserving earlier server records.
- Request account recovery and complete a password update without retaining a recovery token in the URL or browser session storage.
- Use the account board on mobile and understand which controls belong to demo mode.

## RED and GREEN sequence

1. Wrote eight account acceptance tests in `e2e/accounts.spec.mjs` before implementing account controls. Executed:

   ```sh
   node node_modules/@playwright/test/cli.js test e2e/accounts.spec.mjs --workers=4 --reporter=line
   ```

   Result: **8 failed**. Seven flows failed waiting for the absent `Sign in` button; saved-session restoration failed waiting for `Local account / Sample feed`. The browser and existing application loaded successfully, so these were intended missing-feature failures.

2. Added a recovery-link test before implementing that screen. The targeted command with `--grep 'password recovery removes'` failed because the `Choose a new password` dialog did not exist.

3. Implemented the existing-interface account integration. The nine tests passed: **9 passed (7.7s)**.

4. Added delayed-configuration, changed-price, interrupted-confirmation and mobile regressions. The targeted delayed-configuration test failed: the typed email was reset to an empty value after the configuration response. Changed the background initialization so it does not rebuild the active account form, and protected active form interactions from background account rendering.

5. The complete 13-test suite passed: **13 passed (10.4s)**. One earlier combined run had trace-file teardown collisions with a simultaneous browser suite; those ENOENT failures were test-output contention, not accepted as feature evidence. Rerunning with separate output ownership passed.

6. Added a connected-account learning regression. After a transient preview restart was resolved, it failed because automatic-settlement guidance was missing. Updated the learning copy to distinguish account singles and server settlement from demo parlays and manual sample outcomes.

7. Final validation:

   ```sh
   node node_modules/@playwright/test/cli.js test e2e/accounts.spec.mjs --workers=1 --reporter=line
   ```

   Result: **14 passed (11.8s)**.

8. Added a delayed-confirmation/portfolio-switch regression before changing the handlers. Executed the targeted test using `--output artifacts/portfolio-race-results --grep 'late bet confirmation'`. It failed as intended: after a new portfolio was created, the old response replaced its display with `$9,900 available / $100 in play`.

   Advanced the account generation when a new portfolio succeeds, cleared the previous request/loading/error/busy state, and made stale request completion handlers leave the new generation untouched. Sign-in, signout and recovery transitions also reset their own busy state explicitly.

   Executed:

   ```sh
   node node_modules/@playwright/test/cli.js test e2e/accounts.spec.mjs --workers=1 --reporter=line --output artifacts/portfolio-race-results
   ```

   Result: **15 passed (13.6s)**. The regression confirms that a delayed bet response cannot replace the newly created portfolio or add the old portfolio’s open bet to its navigation count.

## Test specification

| Guarantee | Test in `e2e/accounts.spec.mjs` | Type | Result |
|---|---|---|---|
| Sign-in retrieves protected server records and clearly labels a local sample feed | `sign in and receive…` | Browser E2E, mocked API | PASS |
| Reviewing a quote does not place a bet; confirmation sends integer cents and a request ID | `review and confirm…` | Browser E2E, mocked API | PASS |
| Account history has no client-side won/lost/void controls | `review and confirm…` | Browser E2E | PASS |
| Stale quotes do not place bets or change the account balance locally | `quote rejection…` | Browser E2E | PASS |
| Account failures show a retry state instead of the seeded demo portfolio | `an account load failure…` | Browser E2E | PASS |
| Saved sessions reload the authoritative account portfolio | `saved account sessions…` | Browser E2E | PASS |
| Confirmation-required signup does not invent a signed-in session | `signup requiring confirmation…` | Browser E2E | PASS |
| Fresh account portfolios require confirmation and call the server operation | `new account portfolios…` | Browser E2E | PASS |
| Signout returns to the independent browser demo | `signout returns…` | Browser E2E | PASS |
| Recovery tokens are removed from the URL, remain out of session storage, and are sent only as the password endpoint's bearer token | `password recovery removes…` | Browser E2E | PASS |
| Background configuration does not erase typed credentials | `a delayed configuration…` | Browser E2E | PASS |
| Changed odds require explicit quote review | `changed prices…` | Browser E2E | PASS |
| A network-interrupted confirmation retains its original request ID on retry | `interrupted confirmation…` | Browser E2E | PASS |
| A 375px account board has 14px odds text and no horizontal overflow | `mobile account markets…` | Browser E2E | PASS |
| Learning instructions distinguish server-held accounts from manual demo outcomes | `account learning explains…` | Browser E2E | PASS |
| Delayed responses from a previous portfolio cannot replace the new portfolio’s balance, bets or navigation count | `a late bet confirmation…` | Browser E2E | PASS |

## Coverage and limits

The browser acceptance suite exercises complete UI flows with controlled API responses. It does not claim to validate hosted Supabase, provider credentials, email delivery, or database transactions. The root implementation has separate backend integration and real-server browser coverage for those boundaries.

API-client coverage is recorded separately in `docs/tdd/client.md`: **32 tests; 98.97% lines, 85.38% branches, 96.55% functions**, all above the 80% gates. No aggregate browser line-coverage percentage is claimed by this report.

The project was not a Git repository at the beginning of this work, so no Git checkpoint commits were created for these cycles.
