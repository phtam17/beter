# Browser API client TDD evidence

Journeys were derived from the infrastructure plan in this chat: sign in, retrieve a protected portfolio, quote and place a bet without duplicate effects, and display canonical database amounts accurately.

## Executed evidence

1. Wrote `tests/client.test.mjs` before creating the implementation. `node --test tests/client.test.mjs` executed 27 tests: **0 passed, 27 failed**. The first failure was the intentional assertion that `createApiClient` must be a function; no such implementation existed.
2. Added `dist/api-client.js`. The same command then passed **27/27** tests.
3. Added two regression tests before changing the implementation. The same command executed 29 tests: **27 passed, 2 failed**. A late 401 response unnecessarily refreshed twice (`2 !== 1`), and a successful JSON `null` payload did not reject (`Missing expected rejection`).
4. Updated token comparison and response validation. All **29/29** tests passed.
5. Added a signed-correction balance regression: **29 passed, 1 failed** because negative audited balances were rejected. Permitted signed portfolio and ledger balances while preserving nonnegative stakes and payouts; **30/30** passed.
6. Added password-update tests before adding the method: **30 passed, 2 failed** because `updatePassword` was missing. Implemented authenticated and recovery-token updates without persisting recovery tokens; **32/32** passed.

## Guarantees

| Guarantee | Test target | Type | Result |
|---|---|---|---|
| Protected API calls require a session and carry a bearer token | `private requests fail before sending…`, `authenticated requests send…` | Client integration with mocked transport | PASS |
| Public configuration and recovery calls do not transmit account tokens | `public config…`, `password recovery…` | Client integration | PASS |
| Failed placement transport is not retried automatically | `network failures do not retry placement…` | Client integration | PASS |
| Auth-renewal retries preserve the original placement body and request ID | `401 refresh replays a bet…` | Client integration | PASS |
| Concurrent expiry and late 401 responses share the renewed session safely | `concurrent expired-session…`, `a late 401…` | Client integration | PASS |
| Invalidated sessions are cleared and cannot refresh indefinitely | `failed refresh…`, `a second 401…` | Client integration | PASS |
| Database cents convert accurately and invalid currency cannot become NaN | `portfolio adapter…`, `adapter rejects invalid…` | Unit | PASS |
| Signup confirmation, signout, blocked storage and malformed responses have explicit behavior | Respective named tests in `tests/client.test.mjs` | Unit / client integration | PASS |

## Coverage

Executed:

```sh
node --test --experimental-test-coverage --test-coverage-include=dist/api-client.js --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/client.test.mjs
```

Result after the additional correction and recovery cases: **32 passed; 98.97% lines, 85.38% branches, 96.55% functions**. All three 80% gates passed. This report measures the API client only; backend and UI evidence are separate.

The checkout was not a Git repository when this work began, so there are no checkpoint commits for this sequence. No hosted Supabase or provider calls were used in these tests; live account and feed verification awaits deployment credentials.
