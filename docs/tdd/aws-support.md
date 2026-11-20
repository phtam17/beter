# AWS support and policy pages: TDD evidence

The journeys were derived from the requested public support path: send a useful request without disclosing the operator’s personal email, understand what happened if delivery fails, and find an accurate privacy/account-closure process. The operator must still approve policy wording and perform the actual hosted notification-delivery check.

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Only POST `/api/support` is intercepted; exact canonical origin, JSON, actual 8 KiB maximum, email/topic/message bounds are enforced | `tests/aws-support.test.mjs` | PASS |
| Shared support quotas use recovery limits with an independently derived secret and trusted AWS source address; raw identities do not enter quota keys | `tests/aws-support.test.mjs` | PASS |
| Acceptance waits for the injected sender to resolve; failed quotas or sender calls return safe errors without payload logging | `tests/aws-support.test.mjs` | PASS |
| Browser sends same-origin JSON and accepts only a 202 with an explicit reference; malformed/failed responses do not display false success | `tests/aws-support-client.test.mjs` | PASS |
| Native labels, topic selection, validation after interaction, first-invalid focus, real reference display, and retained text/retry after failure work | `e2e/aws-support.spec.mjs` | PASS |
| Draft privacy/deletion pages retain manual-review language and work at 320 px with reduced motion | `e2e/aws-support.spec.mjs` | PASS |

The backend RED checkpoint was `efc56a9`: the support wrapper was absent. `8fafe35` made all nine backend cases pass. During implementation, a TypeScript parameter-property syntax unsupported by Node’s strip-only mode was replaced with ordinary fields; it is not counted as behavioral RED. The sender-order test originally assumed one event-loop turn was enough for WebCrypto; it was corrected to synchronize on an explicit sender-start signal before the GREEN run.

The UI RED checkpoint was `afff079`: all three browser cases failed because the standalone pages did not exist. A first attempt could not start the local preview because listening required the local browser execution permission; that setup error is not counted as RED. The valid execution used the existing local preview. `1a63d19` made the three browser cases pass after scoping a test locator to the header navigation (Support is intentionally also linked from the footer).

Executed final local checks:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='server/aws-support.ts' \
  tests/aws-support.test.mjs tests/aws-support-client.test.mjs
E2E_BASE_URL=http://127.0.0.1:4173 npx playwright test \
  e2e/aws-support.spec.mjs --project chromium --reporter line --timeout 10000
npm run typecheck
```

Results: 12/12 unit cases, 3/3 browser cases, and typecheck passed. Backend coverage was 100% lines, 94.64% branches, and 100% functions. Sender calls in these tests were injected fixtures; browser support requests were intercepted locally. No actual email or SNS message was sent by this work.

Mobile support (390 px) and desktop privacy (1280 px) screenshots were visually inspected. The pages reuse Beter’s paper/ink/blue palette and self-hosted fonts, use a single reading column, 48 px controls, visible focus, native radios, and reduced-motion/forced-color support. Policy copy distinguishes AWS services from the operator’s email mailbox, local browser practice from connected Beter accounts, and session revocation from complete record removal. It promises neither automatic deletion nor a retention deadline.

## Applied web guidance

- `forms`: “DO disable the button after a valid submission is clicked” informed duplicate-submission prevention; failed requests retain the message and restore the button.
- `validate-input-after-interaction`: “DON’T use the raw `:invalid` CSS pseudo-class alone” informed neutral initial fields, native constraints, blur/submit errors, and dynamic error descriptions.
- `accessibility`: “Explicitly associate `<label>` with its control via `for`/`id`” informed native field labels, radio labels, and a logical keyboard order. Status updates use a single live region; first-invalid focus remains native.

Apple’s `text-fields.md › Best practices` recommends stacking fields and validating email when people switch fields; `entering-data.md › Best practices` recommends choices over unnecessary typing. The form applies those principles with a single column, three native topic radios, and no custom keyboard shortcuts.

The requested endpoint accepts JSON only. Consequently, sending requires JavaScript; a no-script notice explains this rather than submitting URL-encoded data to an incompatible endpoint. Policy text and navigation remain readable without JavaScript. This is an intentional limitation of the specified API contract, not a completed server-rendered form fallback.

## Hosted work still required

Wire the wrapper to the AWS runtime and SNS publisher, deploy the newly packaged pages, submit a clearly labeled hosted test request, verify the configured operator mailbox received its notification, and retain only the safe reference/result. A successful SNS publish is acceptance by the notification service; local tests do not establish mailbox delivery. Keep `LaunchOpen=false` and `HostedChecksApproved=false` until the owner approves policy wording and the remaining launch checks pass.
