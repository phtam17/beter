# AWS Cognito authentication: TDD evidence

Date: November 20, 2026. Journeys were derived from the user's AWS-only deployment request and the existing account/session guarantees.

## Implemented guarantees

- Sign-in uses Cognito's password authentication flow, then verifies the actual user with `GetUser`. Only a verified email and valid provider subject create an application identity.
- The application issues compact random opaque access/refresh handles. PostgreSQL stores only their hashes and AES-GCM-encrypted Cognito credentials. Cognito ID tokens are not needed or returned. The existing encrypted HttpOnly browser cookie remains comfortably below its size limit, including when provider refresh tokens are large.
- Every private authentication checks the opaque session's expiry, decrypts its provider credentials, and calls Cognito. A locally valid JWT signature is not treated as proof that a token remains unrevoked.
- Refresh rotates opaque handles atomically and preserves the original absolute refresh deadline. Deterministic HMAC successors let different instances return the same winning pair during a database-backed ten-second reuse grace. Replays after that grace fail.
- The private SQL store tracks hashed family lineage. Logout by an earlier handle revokes the current family, and a racing refresh cannot recreate a deleted family. Local revocation completes even when provider revocation is unavailable.
- Signup waits for email confirmation and does not create a premature local account/session. Existing-user signup responses and recovery responses do not disclose account existence.
- Password recovery sends a code. Successful completion confirms the code, verifies a sign-in with the new password, globally revokes provider sessions, and revokes old opaque sessions. Direct password replacement without the recovery proof is refused.
- Provider errors, stored credentials, raw database failures, and unsupported challenges are not returned to the browser. Calls have a shared operation deadline for provider requests.

The integration expects a case-insensitive stable email username, verification links for signup, code-based password recovery, token revocation enabled, and Cognito provider refresh rotation disabled. Beter's opaque layer supplies rotation. Additional MFA/challenge UX and email-changing features are outside this implementation; unexpected sign-in challenges fail explicitly rather than being bypassed.

## Executed RED/GREEN stages

| Stage | Actual command | Result |
|---|---|---|
| Initial runtime RED | `node --test tests/aws-auth.test.mjs` | **21 failed / 0 passed** on the missing `createCognitoAuthBackend`; the test module compiled and executed. |
| Initial GREEN | Same target | **21 passed / 0 failed** after the adapter implementation. |
| Lifetime boundary RED | Same target after adding a short-refresh/long-access case | **21 passed / 1 failed** because initial access expiry could exceed the configured absolute refresh expiry. |
| Lifetime GREEN | Same target | **22 passed / 0 failed** after capping initial access expiry at refresh expiry. |
| Additional integration validation | Same target, adding an actual Data API query adapter and private PostgreSQL store | **23 passed / 0 failed**. This is validation of the implemented contract, not a claimed new production RED stage. |

The integration case exercises real encryption, private PostgreSQL functions, transaction-local service permissions, Data API scalar reconstruction, refresh successor reuse, and late family logout. It uses PGlite and an SDK transport that executes the generated SQL locally, plus controlled Cognito API replies. It makes no hosted request.

Security/error cases include raw or privileged-token rejection, expired access, a mismatched provider subject during refresh, unverified or malformed provider identities, encrypted-payload tampering, concurrent refresh across independent adapters, expired replay grace, logout racing refresh, provider-revocation failure, code errors, throttling, unsupported challenges, database failure, provider timeout, and both partial recovery failure directions.

## Git checkpoints

All checkpoints were created on the shared `main` branch for this task:

- `be235e3`: observed initial RED and tests.
- `632d62e`: minimal Cognito session/recovery GREEN implementation.
- `4380aca`: observed lifetime boundary RED.
- `8e232e7`: lifetime cap GREEN.

The final evidence/integration test commit preserves these stages if a later release uses a squash merge. No unrelated parent-task commits are claimed as RED/GREEN evidence.

## Verification

```text
node --test --experimental-test-coverage --test-coverage-include='server/aws-auth.ts' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 tests/aws-auth.test.mjs
23 passed, 0 failed, 0 skipped
100% lines / 89.47% branches / 96.88% functions

node node_modules/typescript/bin/tsc --noEmit
PASS at the completed adapter stage
```

Focused coverage is recorded by the parent task with the final combined checks. The initial 21-case scoped run measured **100% lines / 89.33% branches / 96.88% functions**. No SQL line-coverage or actual hosted Cognito behavior is claimed.

## Source references and hosted checks

- [Cognito GetUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_GetUser.html) authorizes the user lookup with a provider access token. [AWS token validation guidance](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html) explains why offline JWT checks do not establish revocation.
- [Cognito refresh behavior](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html) distinguishes provider rotation from `REFRESH_TOKEN_AUTH`.
- [Cognito email settings](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-email.html) distinguish signup verification links from password-reset codes.
- [Token revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/token-revocation.html) documents per-refresh-token revocation and global sign-out. The adapter explicitly invokes global sign-out after a verified recovery instead of assuming password confirmation alone has revoked every session.

Still required on AWS staging: verify real delivery and confirmation links; correct-password, wrong-password, unconfirmed and recovery-code flows; Cognito token lifetime/settings; GetUser rejection after revocation; opaque cookie behavior across Lambda instances; actual private database roles; and provider/database fault recovery. A successful recovery response requires both provider and local revocation to finish. If either channel fails after the password changes, the adapter returns `PASSWORD_RESET_INCOMPLETE` with explicit advice, and never reports completion. A simultaneous provider-and-database failure needs retry/operator reconciliation and belongs in the hosted incident drill.

No live credentials, actual user email, provider tokens, or session handles are written into this report. No hosted account was created, emailed, or modified by these tests.
