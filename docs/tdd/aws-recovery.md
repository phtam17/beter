# Cognito email recovery: TDD evidence

Journeys were derived from the AWS-only migration request: request recovery instructions, enter the email code with a new password, handle errors/retry/cancellation, and sign in explicitly after a successful reset. Existing Supabase recovery links must continue to work.

## Checkpoints on main

| Stage | Commit | Executed evidence |
| --- | --- | --- |
| RED | `32e75fb` | `node --test tests/aws-recovery-client.test.mjs`: 0 pass / 5 fail. Missing `confirmRecovery`; existing recovery requests did not abort with account-screen cancellation. Initial Chromium recovery target: 1 pass / 4 fail because the code step was missing. |
| GREEN | `36af0b7` | Same five client cases: 5 pass. Same five Chromium journeys: 5 pass at 375px. Added scoped anonymous recovery/confirmation requests, code screen, resend/change email, transient secrets, and explicit sign-in after success. |
| RED | `b257be2` | Expanded nine journeys across three engines: 26 pass / 1 fail. WebKit Escape dismissal did not return focus to Sign in. The initial immediate code-clearing assertion was corrected to wait for the browser's asynchronous native `close` event; secret clearing itself passed. |
| GREEN | `d8c9764` | Same 27 checks: 27 pass. Explicit focus return on native dialog close resolves WebKit; native dialog focus containment is retained. |

The checkpoint commits are reachable from the current branch. Preserve these records if commits are squashed.

## Guarantees and verification

| Guarantee | Test | Result |
| --- | --- | --- |
| Email/code/password travel only in the anonymous confirmation POST body; no browser bearer token, stored credentials, or automatic sign-in | `tests/aws-recovery-client.test.mjs` | 5 pass |
| Recovery/confirmation cancellation aborts transport and rejects late successful responses; a newer sign-in wins | `tests/aws-recovery-client.test.mjs` | PASS |
| One text input preserves a leading zero, permits paste, uses numeric keyboard and code autocomplete; malformed codes never submit | `e2e/aws-recovery.spec.mjs` | PASS in all three engines |
| Invalid/expired code clears code/password and offers resend; email can be corrected separately | same | PASS |
| Pending requests disable repeat submit; closing or changing screen prevents stale UI updates | same | PASS |
| Successful reset returns to sign-in; incomplete remote reset explains the uncertainty and offers sign-in/recovery | same | PASS |
| Closing clears DOM secrets and returns keyboard focus; 375px and doubled text remain usable | same | PASS |
| Existing recovery instructions and token-based Supabase reset remain compatible | same; existing account/draft recovery tests | PASS |

Commands actually run:

```sh
node --test tests/aws-recovery-client.test.mjs
node --test tests/client.test.mjs tests/browser-session.test.mjs tests/production-client.test.mjs tests/aws-recovery-client.test.mjs
node --test --experimental-test-coverage --test-coverage-include='dist/api-client.js' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/client.test.mjs tests/production-client.test.mjs tests/aws-recovery-client.test.mjs
env PLAYWRIGHT_BROWSERS_PATH=/tmp/beter-readiness-browsers CFFIXED_USER_HOME=/tmp/beter-recovery-browser-home node node_modules/@playwright/test/cli.js test --config=/tmp/beter-recovery-playwright.config.mjs
node node_modules/typescript/bin/tsc --noEmit
node --test tests/aws-auth.test.mjs
```

Results: 62 related account/client tests pass; browser client coverage **85.98% lines / 90.53% branches / 92.68% functions**; 27 recovery browser checks pass; TypeScript passes; 23 Cognito adapter tests pass including the private SQL store. App DOM behavior is verified through browser journeys rather than claiming numeric coverage for all of `app.js`.

Browser checks used an explicit temporary sample runtime and temporary database, without reading `.env` or `.env.local`. The custom task config selects all three engines for this new test file and uses 375px viewports. An earlier static-only run of the existing account/readiness target produced 29 pass and one failure because the real HttpOnly-cookie test needs an API. That same real test passed against the isolated local runtime. The existing personal-draft recovery journey also passed. No AWS/email calls were made by these tests.

## Modern Web Guidance applied

The parent searched **`verify password reset code`** before implementation, then retrieved **`forms`**, **`accessibility`**, and **`validate-input-after-interaction`**. The complete 1,414-line retrieved file was read at `/var/folders/_h/skymk_vd3yl24zg4c86q_gbh0000gn/T/mwg-guide-35969-1795214306402.md`.

- **`forms`**: “DON'T split a single value (such as a 6-digit OTP, phone number, or credit card) across multiple `<input>` boxes”. I used one text field, preserving leading zeros and paste. “DON'T use `type="number"` ... for ... one-time passcodes” prevents numeric spinners and zero loss. The SMS/WebOTP-specific recommendation does not apply to email; no SMS reading API was introduced.
- **`accessibility`**: “Manage focus correctly to and from updated content”. I focus the code on the new step and explicitly restore the account opener on close after WebKit verification exposed a gap. Visible labels and hints are linked using `for`/`id` and `aria-describedby`; the existing native modal dialog remains in place.
- **`validate-input-after-interaction`**: “DO use standard HTML5 attributes like `type="email"`, `pattern`, and `required`”. I use native six-digit/code and password constraints, leaving submit available until a valid submission is pending. Native invalid-submission feedback avoids premature custom live errors while people type; server failures use the existing alert. The guide's complex-password regex example is inapplicable: this service requires length10–200 without additional composition rules.

## Apple design references applied

Read ten files: accessibility, layout, typography, color, designing-for-ios, cross-platform, text-fields, feedback, managing-accounts, entering-data. The web implementation keeps its existing tokens, typography, native dialog, and stacked field design.

- `text-fields.md › Best practices`: “Ensure that tabbing between multiple fields flows as people expect.” Code precedes password and native tab order is retained.
- `entering-data.md › Best practices`: “Never prepopulate a password field.” Only email is prefilled; passwords and codes never enter app persistence and are cleared on close/re-render.
- `feedback.md › Best practices`: “Consider integrating status feedback into your interface.” Status/errors stay beside the task, with completion and recovery advice.
- `managing-accounts.md › Best practices`: “Avoid using the term passcode to refer to account authentication.” The field is labelled Verification code.
- `layout.md › Adaptability`: “Be prepared for text-size changes.” The form is checked at375px with doubled text and scrollable native dialog content.

For web form submission, the concrete Modern guidance to keep submit available for native validation takes precedence over Apple's general suggestion to disable until complete. Only pending submissions/resends are disabled.

## Hosted verification still required

Confirm actual Cognito delivery to the authorized staging email, six-digit email code acceptance/expiry, duplicate resend behavior, provider-wide token revocation plus old browser/session rejection, and post-confirm outage recovery. The backend report `aws-auth.md` describes provider/database independence and the double-outage reconciliation limitation. These local browser mocks do not prove email delivery, TLS/edge configuration, or the deployed application version.
