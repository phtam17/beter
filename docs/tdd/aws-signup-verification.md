# Cognito signup email codes: TDD evidence

The hosted signup link did not confirm the existing account. The requested fix uses Cognito's code confirmation APIs and preserves the existing unconfirmed user. No cause is inferred for the failed link, and no OAuth changes were made by this work.

Journeys: create an account and verify its email code; let an existing unconfirmed user request a new code from Sign in; handle malformed/expired codes, resend limits and cancelled requests; return to explicit sign-in without retaining the signup password or creating a session during confirmation.

## Checkpoints on main

| Stage | Commit | Executed result |
| --- | --- | --- |
| RED | `d75bdc2` |34 Node cases executed:23 pass /11 fail for absent verification/resend actions, routes, limiter classification and client contract. Initial4 Chromium journeys fail on the missing verification view/entry. |
| GREEN | `7b5a5eb` |Same34 Node cases and4 Chromium journeys pass. Anonymous verify/resend, code method metadata and native code view implemented. |
| RED | `0caa893` |Real browser transport target:6 pass /2 fail. Cookie envelope dropped confirmationMethod; whitespace email was rejected before normalization. |
| GREEN | `ab24c9c` |Same8 signup cases plus19 browser-session regressions pass. Method metadata survives the actual browser wrapper and signup issues no session cookie. |
| RED | `531c57a` |Executed Chromium case fails because Verify email remains absent if AWS configuration arrives after the sign-in form opens. |
| GREEN | `81e24a3` |All5 signup journeys pass. The missing action is inserted without rebuilding the form or erasing credentials being typed. |

All checkpoints are reachable on main. Preserve this evidence if squashed. The first broad browser rerun collided with another local Playwright invocation in a shared trace output directory; no behavior failure occurred in its affected saved-session case. A rerun using separate output directories passes all existing account cases.

## Implemented contract

- `auth('signup')` returns `session:null`, `requiresConfirmation:true`, `confirmationMethod:'code'`, including the existing-username response.
- Anonymous `POST /api/auth/verify` accepts normalized `{email,code}`. Code is exactly six digits. `ConfirmSignUp` uses `ForceAliasCreation:false`; success returns `{ok:true}` and does not create an auth.users row, application session or cookie.
- Anonymous `POST /api/auth/resend` accepts `{email}`. `ResendConfirmationCode` has the same generic response for pending, unknown and already-confirmed users. Delivery destinations/provider messages never reach the browser. Other provider outages/throttling use existing safe errors.
- Both actions use the durable shared auth limiter. Resend shares the existing recovery bucket with password recovery:three attempts per database-defined window, without SQL changes.
- Browser `verifySignup` and `resendSignupConfirmation` share auth cancellation/deadlines. Late responses cannot replace a newer account screen.
- AWS sign-in offers Verify email for existing unconfirmed accounts. Code view includes editable email, one verification field, resend and back actions. Signup password is removed before the code step; confirmation success asks for explicit sign-in.
- Existing Supabase confirmation/link recovery and Cognito password recovery remain compatible.

The current AWS [ConfirmSignUp documentation](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ConfirmSignUp.html) describes activating local signup accounts with the delivered code and the alias-migration risk of forcing alias creation. The implementation deliberately disables that option and ignores optional provider sign-in session output. AWS [ResendConfirmationCode documentation](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ResendConfirmationCode.html) specifies resending signup codes followed by ConfirmSignUp; no hosted UI link is needed for these actions.

## Verification actually run

```sh
node --test --test-concurrency=1 --experimental-test-coverage --test-coverage-include='server/aws-auth.ts' --test-coverage-include='dist/api-client.js' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/aws-auth.test.mjs tests/aws-signup-verification.test.mjs tests/client.test.mjs tests/aws-recovery-client.test.mjs tests/production-client.test.mjs tests/browser-session.test.mjs
node --test tests/auth-limits.test.mjs
node node_modules/typescript/bin/tsc --noEmit
env PLAYWRIGHT_BROWSERS_PATH=/tmp/beter-readiness-browsers CFFIXED_USER_HOME=/tmp/beter-recovery-browser-home node node_modules/@playwright/test/cli.js test --config=/tmp/beter-signup-playwright.config.mjs
env E2E_BASE_URL=http://127.0.0.1:4182 node node_modules/@playwright/test/cli.js test e2e/accounts.spec.mjs --project=chromium --reporter=list --output=/tmp/beter-signup-account-regressions
```

Results: **97 Node cases pass**, **5 durable limiter cases pass**, TypeScript passes. Coverage: auth **100% lines /89.76% branches /96.88% functions**; browser client **86.11% lines /90.67% branches /93.02% functions**. All **45 browser cases pass across Chromium, Firefox and WebKit**:five signup and ten recovery/account cases per engine. The existing fifteen account browser journeys also pass. The tests use injected Cognito, actual API/browser-envelope code, private SQL test fixtures and isolated browser API mocks. No AWS account changes or email deliveries occurred during these tests.

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Correct Cognito commands/normalized identity, no alias takeover, local user/session creation or automatic sign-in | `tests/aws-auth.test.mjs` signup code cases | PASS |
| Anonymous routes validate code/email, accept no password, throttle before provider access and fail closed | `tests/aws-signup-verification.test.mjs` | PASS |
| Actual browser transport preserves only supported method metadata and sends no signup session cookie | same | PASS |
| Resend uses shared three-attempt recovery quota; existing durable SQL limit still works | same plus `tests/auth-limits.test.mjs` | PASS |
| New/existing account entry, paste-compatible leading-zero code, invalid-code/resend feedback, no stored secrets or auto-login | `e2e/aws-signup-verification.spec.mjs` | PASS all3 engines |
| Delayed verify/config cannot overwrite account state or erase typed credentials | same | PASS all3 engines |
| Existing recovery and saved-account displays remain intact | `e2e/aws-recovery.spec.mjs`, `e2e/accounts.spec.mjs` | PASS |

## Form and design guidance

Modern guidance was searched **first** with `confirm email code`. The relevant existing full `forms`, `accessibility` and `validate-input-after-interaction` guidance is reused from the prior recovery pass; the complete retrieved file and Apple reference set are recorded in `aws-recovery.md`. `verify-email-ownership` describes a different non-code capability and the SMS/WebOTP guide does not apply to email.

- **`forms`**: “DON'T split a single value ... across multiple `<input>` boxes”. One text input with numeric keyboard and one-time-code autocomplete preserves leading zeros and paste. No WebOTP/SMS API is introduced.
- **`accessibility`**: “Manage focus correctly to and from updated content”. Signup completion focuses the verification code; the existing native dialog/close focus behavior remains. A late configuration adds the native action without moving focus away from typing.
- **`validate-input-after-interaction`**: “DO use standard HTML5 attributes like `type="email"`, `pattern`, and `required`”. Native constraints stop malformed submission; errors appear after submission and resend validates email without requiring a code.

Apple's previously read `entering-data.md › Best practices` says “Never prepopulate a password field.” The code step removes that field entirely. `text-fields.md › Best practices` supports logical field/tab order, and `feedback.md › Best practices` supports feedback near its task. Existing design tokens, labels and native dialog remain.

## Hosted handoff

Deploy the current API and static bundle along with the pool's CODE configuration, then resend once to the authorized existing unconfirmed account. Verify the received code through the app, confirm Cognito reports a confirmed/verified user, and complete explicit sign-in/session checks. This report proves local behavior; it does not claim the owner's actual email/code or hosted sign-in has succeeded. Root owns real delivery, hosted checks and the launch decision.
