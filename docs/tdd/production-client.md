# Production account flow: TDD evidence

Date: November 20, 2026. Journeys were derived from the [production readiness review](/Users/phtam/Beter/beter/docs/reviews/production-readiness-2026-11-20.md) and the user's instruction to fix its findings with TDD.

## Journeys and implementation

1. A person who requests sign-out must not silently regain account access when a network failure leaves the private cookie behind.
2. Reloads, new tabs, and existing tabs must honor an unfinished sign-out before displaying private account data or making protected requests.
3. A person must receive an honest, persistent explanation and a retry action if sign-out cannot finish, including when browser storage is unavailable.
4. Account support, privacy information, and account deletion must use real configured destinations, with factual local data information and no invented contacts or promises.

The client stores only `beter-logout-pending-v1=1`, before making the logout request. This is a non-secret action intent; it contains no identity, email, or credential. Restoration retries cookie revocation before querying the session, new sign-in waits for unfinished revocation, and protected requests check the shared marker. The UI hides the account immediately, clears in-memory identity/form details, responds to cross-tab storage events, and offers an in-page retry action until completion. Successful logout preserves the independent personal practice history.

If the browser refuses storage, the intent remains in memory. The persistent notice explicitly warns that reloading or opening another tab may restore the account until a connected retry succeeds. Persistence cannot be guaranteed when the browser refuses to store it; the UI does not claim completion.

The footer opens a native Help and data dialog. It explains email/account storage and the distinction between creating another portfolio and deleting account history. Real support/privacy/deletion links come from the public configuration; the client also rejects executable or non-HTTPS destinations, except local loopback development URLs. Missing destinations produce an explicit preview limitation.

## RED and GREEN

The project uses npm with Node's native `node:test` runner and Playwright. It was not under Git during the RED/GREEN work, so no checkpoint commits are claimed.

| Stage | Executed command | Actual result |
|---|---|---|
| Initial API-client RED | `node --test tests/production-client.test.mjs` | **8 failed, 0 passed**. Failures showed the absent marker, cookie session restoration instead of revocation, private reads from an existing tab, sign-in overtaking logout, absent pending state, and a marker never cleared. |
| Initial API-client GREEN | Same target | **8 passed** after the minimal pending-intent implementation. |
| Shared completion RED | Same target after adding the ninth case | **8 passed, 1 failed**. A second tab's completion left a stale pending notice. |
| Shared completion GREEN | Same target | **9 passed** after synchronizing marker removal without restoring identity. |
| Browser RED | `node node_modules/@playwright/test/cli.js test --config /tmp/beter-readiness-client.playwright.config.mjs --output artifacts/production-client-browser-red` | **5 failed** for missing unfinished-logout feedback, an already-open tab still displaying an account, missing storage-denied warning, and absent Help and data entry. |
| Browser GREEN | Same target with `--output artifacts/production-client-browser-green` | **5 passed (4.8s)** after UI changes. |
| Closed dialog privacy RED | Same target with `--grep 'failed sign-out stays' --output artifacts/production-client-dialog-red` | **1 failed**: the closed account dialog still contained the previous account email after sign-out. |
| Additional browser validation | Same target with `--output artifacts/production-client-browser-final` | **7 passed (6.2s)** after removing the closed dialog's identity text, including compact/safe-link checks and a real local HttpOnly-cookie interruption/retry flow. The two added cases are validation, not claimed initial RED evidence. |
| Scoped coverage | `node --test --experimental-test-coverage --test-coverage-include='dist/api-client.js' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/client.test.mjs tests/production-client.test.mjs` | **38 passed, 0 failed, 0 skipped**. **98.77% lines, 93.18% branches, 100% functions**. |
| Syntax | `node --check dist/app.js` | **Passed**. |

The first unprivileged browser attempt failed to launch Chrome before executing tests. It is excluded from RED evidence. The approved rerun launched Chrome and exercised the intended failures.

Browser verification used a sample-only runtime on `127.0.0.1:4175`, with a dedicated temporary database and no `.env` loading. The temporary Playwright config avoids starting `npm start`, which could load private provider configuration. The normal project runner can execute the committed spec after preparing an isolated server.

## Guarantees

| Guarantee | Test | Type | Result |
|---|---|---|---|
| A failed logout stores only a non-secret intent and hides public session metadata | `tests/production-client.test.mjs`: failed logout persists a non-secret intent | Unit | PASS |
| Reload revokes before restoring; failed revocation does not read the cookie session | Same file: reload retry and failed pending logout cases | Unit | PASS |
| Existing tabs refuse protected reads and new sign-in waits for logout | Same file: existing-tab, unfinished-login, in-flight ordering cases | Unit | PASS |
| Denied storage reports a non-persistent pending state | Same file: denied storage case | Unit | PASS |
| Completing logout preserves personal practice and clears a shared pending notice | Same file: completion cases | Unit | PASS |
| Reload/new tabs keep visible retry feedback and hide account content | `e2e/production-readiness.spec.mjs`: failed sign-out and existing-tab cases | Browser | PASS |
| A real retained HttpOnly cookie does not silently restore access; retry removes it | Same file: real HttpOnly cookie case | Local browser/API integration | PASS |
| Help exposes configured links, rejects executable URLs, and remains readable at 375px | Same file: help cases | Browser | PASS |

## Design and web guidance

Apple's principles apply to this responsive web app; native Mac/iOS navigation conventions are not imposed. The change preserves the current typefaces, palette, and hierarchy.

- `feedback.md › Best practices`: “Show people when a command can’t be carried out and help them understand why.” The unfinished-signout state stays visible and gives a direct retry action.
- `writing.md › Best practices`: “Write clear error messages.” The interface names the unfinished action and explains the next step, without a false success toast.
- `managing-accounts.md › Deleting accounts`: “Provide a clear way to initiate account deletion within your app or game.” The configured direct deletion destination is discoverable through Help and data. The hosted destination and its working deletion procedure still need setup and verification.

Modern Web Guidance was searched for persistent logout intent and its `security`, `privacy`, and `accessibility` guides were retrieved and read. Newly applied choices:

- **`privacy`**: “DON'T store sensitive tokens or PII in `localStorage`”. The only new persisted account-control value is the non-secret marker `1`; credentials remain in the existing HttpOnly cookie.
- **`accessibility`**: “Don't implement focus traps for native modal dialogs”. Help uses `showModal()` with native modality, a labeled heading, close action, and explicit focus return to its opener on close. A WebKit regression exposed the need for explicit return after a pointer click; the fix retains native modality. Failed sign-out instead uses a persistent reachable alert outside the closed account dialog, with focus on Retry sign-out.

The security/privacy guides suggest origin-wide `Clear-Site-Data` on logout. That would also delete the independent personal practice portfolio and saved drafts, contrary to the accepted product behavior. This change therefore preserves those records and scopes credential termination to the server-managed cookie. Offline privacy is protected by recording the sign-out intent before the request; a response header alone cannot solve a request that never reaches the browser.

## Hosted setup and verification still required

- Configure actual support, privacy-policy, and direct account-deletion URLs, and operate the stated support/deletion process. The UI does not create those external services.
- Exercise real hosted logout, expired/rotated sessions, multi-instance refresh, and email confirmation/recovery. Browser tests here use either controlled responses or the local sample backend.
- Physical Safari/touch-device and assistive-technology checks remain useful. The later [history/browser verification](/Users/phtam/Beter/beter/docs/tdd/production-history.md) executed the critical account flows in Firefox and WebKit as well as the complete Chromium suite: **97 browser cases passed** in total.
- Root's full build, coverage, release procedure, and server-side readiness work are recorded separately. This report does not claim those results.
