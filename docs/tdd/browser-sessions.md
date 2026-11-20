# Browser sessions, authentication ownership, and request deadlines

Journeys were derived from the implementation review and this TDD run. The project is not a Git repository, so no checkpoint commits were possible; the RED/GREEN evidence is recorded here.

## Guarantees

| User journey or behavior | Test target | Type | Evidence |
|---|---|---|---|
| Sign in and reload without storing credentials or email in script-readable storage | `tests/client.test.mjs`, `tests/browser-session.test.mjs` | Unit/integration | Legacy storage, cookie transport, public session restoration, and encryption tests |
| A late authentication result cannot replace a newer account | `tests/client.test.mjs` | Unit | Older signin, cancelled signin, stale bootstrap, stale401, and stale logout tests |
| Delayed response bodies still respect request deadlines | `tests/client.test.mjs` | Unit | Abort-aware stalled body with25ms deadline; native and fallback cancellation |
| Cookie access expires/refreshes safely without exposing backend credentials | `tests/browser-session.test.mjs` | Integration | Expired access, invalid refresh, shared rotation result, no auth mutation from public configuration |
| A copied/tampered cookie or foreign browser origin cannot authorize access | `tests/browser-session.test.mjs` | Integration | Tamper/oversize/missing cookie and cross-origin mutation checks |
| Signout revokes the server session and removes its cookie | `tests/browser-session.test.mjs` | Integration | Normal and unavailable-backend logout checks |
| Local sessions survive runtime restart; hosted instances can share a consistent sealing key | `tests/browser-session.test.mjs` | Integration | Persistent private local key and same-key handler restoration |
| Existing programmatic bearer API remains compatible | `tests/browser-session.test.mjs`, existing API tests | Integration | Raw token API remains independent of browser cookie transport |

## RED evidence

Before production edits:

- `node --test tests/browser-session.test.mjs`:15 executed,12 failed and3 passed. Failures included unsanitized token response, absent secure cookie/session restoration, missing browser-specific origin policy, refresh/logout handling, and local key persistence. Raw bearer compatibility already passed.
- `node --test --test-name-pattern='legacy script-readable|signin sends cookie|body consumption remains' tests/client.test.mjs`:3 executed,3 failed. The body remained pending at100ms despite the25ms configured deadline.

Additional edge cases were individually made RED before their fixes:

- Older protected response after newer login: `node --test --test-name-pattern='older protected request' tests/client.test.mjs` failed because current session became null.
- Refresh rotation and public configuration: `node --test --test-name-pattern='overlapping requests|public configuration' tests/browser-session.test.mjs` executed2 and failed2; one original-cookie request failed after rotation, and a public configuration request cleared the cookie.
- Older signout after newer login: `node --test --test-name-pattern='older logout response' tests/client.test.mjs` failed because the newer public session became null.

## GREEN and coverage evidence

After the minimal fixes, `node --test tests/client.test.mjs tests/browser-session.test.mjs` passed all46 cases with no failures, cancellations, or skips. `npm run build` passed. The earlier stable full `npm run test:coverage` run passed188 tests with97.98% lines,90.06% branches, and98.83% functions overall; the later logout-generation fix is covered by the added GREEN test. The parent task records the final combined-suite coverage after all concurrent fixes.

New `server/browser-session.ts` measured96.84% lines,82.46% branches,100% functions in that coverage run. `dist/api-client.js` measured98.55%,91.16%,100% respectively.

## Design and operational limits

Cookies use WebCrypto AES-GCM with a domain-separated encryption key. A dedicated `BETER_SESSION_SECRET` is supported; hosted deployments can derive from their private service key; local runtime persists a newly generated private secret. No in-process session store is required for authorization. A bounded ten-second refresh-result cache handles requests sharing a just-rotated cookie; the backend continues to verify access tokens before private operations.

Client metadata is memory-only. The legacy session storage key is removed, requiring a one-time fresh sign-in. Logout intentionally expires the authentication cookie rather than sending blanket `Clear-Site-Data`, which would erase separate personal practice and draft data.

Native `AbortSignal.timeout` and `AbortSignal.any` are used when available; a feature-detected `AbortController` fallback retains deadlines and lifecycle cancellation in other supported browsers. Deadline coverage includes response-body consumption and distinguishes `TimeoutError` from `AbortError`.

Hosted Supabase, SMTP delivery, cross-instance provider refresh behavior, and live deployment remain staging checks. Unit/integration tests do not claim to replace those external checks. The parent browser suite exercises the real local cookie journey separately.
