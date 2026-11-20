# Explicit password setup and Cognito identity: TDD evidence

Two related fixes were requested during hosted verification: accept a verified Cognito subject without assuming UUID version/variant bits, and let the owner choose a password with an already-sent recovery code in one explicit form.

## Checkpoints

| Stage | Commit | Executed evidence |
| --- | --- | --- |
| Setup RED | `29bcfa0` |6 Chromium setup-link cases execute and fail because the link/form is absent. |
| Identity RED | `4585504` |28 auth cases execute:27 pass /1 fail. Synthetic verified subject `11111111-1111-7111-0111-111111111111` is rejected before creating a session. |
| Identity GREEN | `3364841` |Same28 cases pass, including signup, sign-in, authentication, refresh and sign-out for that subject. |
| Setup GREEN | `d5064d3` |Same6 setup cases pass; TypeScript passes. Added verification cases for filled-form cancellation and same-page fragments also pass. |

The identity validator now requires canonical8-4-4-4-12 hexadecimal grouping. Provider GetUser identity/email verification, encrypted sessions and user linkage remain required. Browser-session and browser-client user-id validation already accept these values. Remaining RFC-shaped browser cursor validation applies to history record identifiers.

## Setup behavior

The fragment `#setup-password=<encodeURIComponent(email)>` is consumed before normal API startup and immediately replaced with the clean overview URL. Only one valid email value is accepted. The intent stays in memory until AWS configuration is available; this setup visit skips automatic cookie-session restoration.

The existing code/new-password view opens with the email prefilled and the primary action **Set password and sign in**. Opening the link sends no recovery/resend email and places no email in a request URL, query string or app storage. On explicit submission, the existing confirmRecovery request completes before sign-in begins. Only this setup intent chains those actions; ordinary recovery continues to ask for separate sign-in.

Closing or changing account mode clears setup intent and DOM secrets. Both authAttempt and dialog-open checks prevent a cancelled reset from initiating a later sign-in. If reset succeeds and sign-in fails, the form truthfully says: “Your password has been saved. Sign in with your new password to continue.” Code/password fields are cleared when forms are replaced and when the dialog closes.

## Verification actually run

```sh
node --test tests/aws-auth.test.mjs
node --test --test-concurrency=1 --experimental-test-coverage --test-coverage-include='server/aws-auth.ts' --test-coverage-include='dist/api-client.js' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/aws-auth.test.mjs tests/aws-signup-verification.test.mjs tests/client.test.mjs tests/aws-recovery-client.test.mjs tests/production-client.test.mjs tests/browser-session.test.mjs
env PLAYWRIGHT_BROWSERS_PATH=/tmp/beter-readiness-browsers CFFIXED_USER_HOME=/tmp/beter-recovery-browser-home node node_modules/@playwright/test/cli.js test --config=/tmp/beter-password-setup-playwright.config.mjs
env E2E_BASE_URL=http://127.0.0.1:4182 node node_modules/@playwright/test/cli.js test e2e/accounts.spec.mjs --project=chromium --reporter=list --output=/tmp/beter-password-setup-account-regressions
node node_modules/typescript/bin/tsc --noEmit
```

Results: **98 Node cases pass**, TypeScript passes. Auth coverage **100% lines /89.70% branches /96.88% functions**; client coverage **86.11% lines /90.67% branches /93.02% functions**. **69 browser cases pass across Chromium, Firefox and WebKit**:eight setup, ten recovery and five signup cases per engine. All fifteen existing account browser cases pass separately.

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Verified Cognito subject accepts canonical hex grouping through full session lifecycle | `tests/aws-auth.test.mjs` canonical subject case | PASS |
| One explicit setup action resets then signs in and loads the private portfolio | `e2e/aws-password-setup.spec.mjs` | PASS all3 engines |
| URL is cleaned, no email is sent automatically, no app storage contains email/code/password | same | PASS all3 engines |
| Close/back during reset prevents later sign-in; filled-form cancellation clears secrets | same | PASS all3 engines |
| Post-reset sign-in failure reports password saved | same | PASS all3 engines |
| Invalid email is ignored; early config and same-page fragment navigation retain the intended setup/focus | same | PASS all3 engines |
| Ordinary recovery, signup verification and existing account behavior remain compatible | recovery/signup/account browser targets | PASS |

Modern guidance was searched first with `set password form`. The already-read `forms`, `accessibility` and `validate-input-after-interaction` guides continue to shape the reused code/password view; their full retrieval and Apple reference set are recorded in `aws-recovery.md`. `forms` warns “DON'T split a single value” across inputs; the single code field and native constraints remain. `accessibility` says “Manage focus correctly to and from updated content”; setup focuses the code after configuration and retains native dialog dismissal. The explicit combined-action label and truthful partial-success copy follow the requested user intent and the previously read Apple feedback guidance.

These tests used an isolated local preview and injected API/provider fixtures. No actual email or AWS calls were made. Root must deploy both identity and setup fixes, send the code once, provide the clean fragment link, and verify the owner's actual password setup/sign-in plus old-session revocation before claiming hosted success.
