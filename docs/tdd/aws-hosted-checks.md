# Closed AWS staging verification: TDD evidence

## Free Gateway topology update

The current default is the free API Gateway hostname. RED `efb7a8d`:12 cases executed,7 pass /5 fail because the checker required CloudFront and had no delivered-script check. GREEN `7bacd50`:same12 cases pass. The current coverage command below reports **93.46% lines /86.55% branches /92.50% functions**.

When `parameters.FreeGatewayHosting` is not `'false'`, the checker requires `outputs.PublicGatewayOrigin` to exactly match the validated HTTPS `outputs.ApiEndpoint` and sends no traffic to disabled CloudFront. Its bare public API request must encounter the staging401/403 gate; that origin is now the intended public website. Explicit CloudFront mode retains the separate direct-origin403 check.

The current default is **13 checks using12 GET requests**, including `/app.js` JavaScript-module delivery. `--auth-probes` adds two synthetic POST checks for15 total checks. The output identifies `topology` and continues to keep `publicLaunchReady:false`. Malformed/missing/mismatched free endpoint outputs are rejected before access details are sent. The historical checkpoint records below describe the earlier CloudFront-only implementation.

Derived journey: verify the deployed private staging perimeter, AWS sample configuration, schema/ledger health, public/private endpoints, secure cookie clearing, and safe account rejection without leaking access details. This tool does not declare the application ready for public launch.

## Checkpoints

| Stage | Commit | Executed result |
| --- | --- | --- |
| RED | `5c9ffc3` | `node --test tests/aws-hosted-checks.test.mjs`: 0 pass /8 fail because the hosted-check exports did not exist. |
| GREEN | `fb66dc8` | Same8 cases pass with read-only defaults, explicit auth probes, scoped credentials, body/time limits, and redacted outcomes. |
| RED | `4b829f6` | Expanded9-case target:8 pass /1 fail. Matching auth error codes could hide provider diagnostics or unexpected token/session fields. |
| GREEN | `f4294dd` | Same9 cases pass after checking the exact safe anonymous error envelope. |

Coverage command actually run:

```sh
node --test --experimental-test-coverage --test-coverage-include='scripts/aws-hosted-checks.mjs' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/aws-hosted-checks.test.mjs
```

Actual result: **9 pass /0 fail,92.93% lines /85.58% branches /92.31% functions**. The branch figure in the `f4294dd` commit message was transcribed incorrectly;85.58% is the executed output. CLI-only argument/error presentation remains outside this unit coverage. Current checkpoint commits remain on main; preserve this evidence if squashed.

## Guarantees

| Behavior | Evidence | Result |
| --- | --- | --- |
| Default run makes12 checks through GET requests only | `default hosted checks are read-only...` | PASS |
| Staging credentials go only to the validated CloudFront host; worker credential goes only to private health; origin/session secrets are never transmitted | same | PASS |
| Public site and API stay closed; direct API origin denies access | default fixture plus opened-gate regression | PASS |
| Gated configuration identifies AWS/sample; health has schema>=4, zero ledger mismatches, zero overdue unsettled bets | default fixture plus stale-schema regression | PASS |
| HTML carries security policy headers; API reads are no-store; anonymous reads create no session; tampered cookie is cleared using Secure, HttpOnly, SameSite=Lax, host-only Path=/ | default fixture plus missing-header/unsafe-cookie regressions | PASS |
| `--auth-probes` alone enables two POST requests to nonexistent-signin/denied-signup using random reserved `.invalid` email and a transient random password | explicit auth probe test | PASS |
| Generic503, diagnostics, unexpected sessions, open signup, and unsafe auth envelopes cannot pass account checks | outage and auth-envelope regressions | PASS |
| Malformed/incomplete/opened state is rejected before fetch; redirects are refused before following; body<=128KiB and request deadline includes body reads | state/network/deadline tests | PASS |
| Response bodies, headers, credentials, account identifiers, provider messages, and raw network exceptions never enter the report | redaction tests | PASS |

## Running against the actual deployment

The default private state location is `.data/aws-deploy/state.json`; the CLI never accepts credentials as arguments or loads environment files.

```sh
node scripts/aws-hosted-checks.mjs
node scripts/aws-hosted-checks.mjs --auth-probes
```

Outputs contain only check names, pass/fail, HTTP statuses or safe diagnostic codes, timestamp and scope. `publicLaunchReady` always remainsfalse. Auth probes do not call recovery/confirmation, use the owner email, or send a test email. The denied-signup probe relies on the deployed Cognito pre-signup restriction; if that restriction is broken it can create a synthetic unconfirmed `.invalid` account, which must be investigated before launch.

**Hosted status at implementation handoff:** not run. Private recovery state exists, but CloudFront/API outputs are absent while provisioning is retried. Passing injected HTTP fixtures proves the checker, not the AWS deployment. Run the two commands after resources, migrations, runtime origin, and current artifacts are installed, then retain the redacted actual result separately.

Actual confirmed-user signup/email delivery, reset code delivery/acceptance/expiry, sign-in and secure cookie issuance, refresh/replay/logout, account isolation, processing schedules, alarms, backup/restore and live-data readiness remain separate hosted checks. Cookie deletion flags verified here do not establish successful session issuance. The root agent owns real-email verification and the public launch decision.
