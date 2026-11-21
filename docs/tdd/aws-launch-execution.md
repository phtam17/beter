# AWS hosted launch verification — November 20, 2026

Beter is deployed in AWS account `025925168269`, region `us-west-2`, at
<https://eo2io8cfp7.execute-api.us-west-2.amazonaws.com/>. It is a closed staging
environment using explicitly labeled sample prices. `LaunchOpen=false` and
`HostedChecksApproved=false` remain in force. This report records executed
checks; it is not public-launch approval.

## Executed verification

| Area | Observed result |
| --- | --- |
| Financial migrations | Six checksummed AWS bootstrap, immutable financial and finalization migrations applied; repeat application reports already applied. Schema version 4. |
| Actual Aurora / Data API | All 9 hosted database checks passed: private roles, user isolation, transaction identity reset, overlapping initial grants, overspend prevention, idempotency/settlement, large Unicode responses and authentication races. |
| Hosted HTTP | All 15 checks passed, including staging protection, safe account failures, configuration, security headers and asset MIME types. |
| Account and recovery | Confirmed Cognito identity signs in through the hosted API, receives an opaque secure HttpOnly cookie, and loads its portfolio. The owner completed the new password setup and reported seeing their portfolio. The pre-reset cookie subsequently has no session and receives 401 for the private portfolio. No temporary account password remains in deployment state. |
| Browser | Actual AWS desktop and mobile smoke checks completed with no failed responses or third-party requests. Local cross-browser suite: 123/123 passed. |
| Transport | TLS 1.2 succeeds; the free API Gateway hostname rejects TLS 1.1. The older CloudFront distribution is disabled. |
| Support | Real hosted support submission was accepted by encrypted SNS with reference `BTR-6cb9b16b-41b2-4eab-9502-13dc1ee1ca3f`. The owner subsequently confirmed both the support notification and test alert arrived in their Outlook inbox. |
| Scheduled processing | EventBridge independently runs ingestion, settlement and maintenance; readiness has passed all 10 checks with zero ledger mismatches. An isolated synthetic account's 1,000-cent stake settled as won and reached exactly 1,001,500 cents, matching its accepted quote. No manual worker invocation was used; the owner's account was untouched. |
| Backup restore | An encrypted snapshot was restored to a separate private Aurora writer. All 15 table schemas/counts, function definitions and migration proof matched. Measured recovery: 968 seconds. Proof SHA-256: `e1ff9d39d6c390d833187ff47b6889caa3cc4fba24d430e89a88322b3e7186d8`. Tagged disposable writer, cluster and snapshot cleanup reached `CLEANED`; the source was preserved. |
| Encrypted alerts | A controlled API-errors alarm transition produced successful CloudWatch-to-SNS action history and one SNS delivery. The owner confirmed inbox receipt. A separate uniquely dimensioned heartbeat alarm then naturally breached after three missing periods and successfully invoked the encrypted SNS action; the temporary alarm was deleted and absence verified. The main API alarm was restored to OK with actions enabled; the main worker alarm and its live metrics were unchanged. The actual customer encryption key is enabled and rotation is on. |
| Protected operator recovery | On a separate synthetic identity/event, HTTP resolve returned 200, an identical retry applied zero extra outcomes, and resume returned 200 with automation released. One stake and one void restored exactly 1,000,000 cents; audit entry present and global ledger mismatches zero. Fixture selections were disabled afterward; no visible hosted-check fixtures remained. |
| Code rollback | The prior known-good ZIP `c302625c9cacd1aa64673724bd9390758f6cac7fefdef14d86a0716abeb8cb76` was downloaded from private versioned artifacts and its SHA checked. All 20 embedded public assets matched. It was deployed briefly with the compatible schema/session configuration preserved, passed all 10 readiness checks, then the current `c67bfb96c5d72ebe142b9a3d7dc2c0c76c841fa91bdb1519a59d1838dc9ca0d4` release was restored and passed the same checks. No password or session-secret change. |
| Funding cutoff | Temporary IAM-only functions with an expired cutoff rejected the API, public gateway, static assets, signup, scheduled process and scheduled monitor before runtime access. The two scheduled tasks used a role with no permissions; denied log/metric writes prevented false main-environment failure metrics. No extra provider call was made. Temporary functions, roles, policy and logs were removed; the dedicated probe secret is scheduled for deletion with seven-day recovery. |
| Final release inventory | All five stack Lambda functions report Active, LastUpdateStatus Successful and the current artifact's code SHA. CloudFormation is UPDATE_COMPLETE; public opening and hosted approval remain false. |
| Local verification | Build/typecheck passed. Latest complete Node run: 549/549 passed, 99.15% lines, 92.45% branches and 98.73% functions. |

Private proof is kept under ignored `.data/aws-deploy/` with owner-only
permissions. Public test logs/screenshots are under ignored `artifacts/`.
Do not commit authentication cookies, staging credentials, runtime secrets,
provider keys, or unfiltered AWS responses.

## Defects found through hosted checks

The real Data API required explicit function-argument casts and support for
the actual RDS-managed secret ARN. Actual Cognito subjects also exposed an
incorrect UUID version/variant assumption that rejected verified users.
Regression tests failed before the corresponding fixes were applied.

Account setup now provides one explicit code-and-password form and a truthful
partial-success message. Recovery revokes old local sessions. The provider
diagnostic recognizes an exhausted quota even when the provider returns 401.
Sample staging uses a stable epoch with optional repeating rounds, preserving
existing accepted bets. The closed-staging updater verifies artifact bytes,
preserves private parameters and requires zero open bets before changing that
epoch. Self-hosted fonts remove browser calls to external font services.

Detailed RED/GREEN evidence remains in the individual AWS documents in this
directory, including password setup, recovery, database, provider, scheduling,
support and infrastructure records.

## Public-launch gates still requiring external action

1. **Live data quota:** the actual provider reported remaining `0`, used `500`.
   Live ingestion and live result settlement cannot be signed off until the
   quota renews or the operator supplies an adequate plan. AWS credits do not
   fund this separate provider. No paid provider upgrade was purchased.
2. **Production account email:** default Cognito email is suitable for this
   small private verification window. Public opening requires a verified SES
   sending identity, the appropriate production email limits, and delivery /
   recovery checks against that configuration. A paid domain has not been
   purchased; the app itself can retain the free AWS hostname.
3. **Capacity:** the account currently has a Lambda concurrency quota of 10.
   The increase request is open; intended production reservations and a
   representative load/abuse check remain required after capacity is approved.
4. **Operator policy review:** privacy and account-deletion pages are factual
   drafts. The owner must approve their wording and the manual identity-verified
   deletion process, including retained/deidentified ledger records. No owner
   account was deleted as a test. Staging support and alarm inbox placement are
   confirmed; production email configuration still needs its own delivery checks.
5. **Release governance:** no Git remote is configured, so hosted CI execution
   and protected-branch deployment have not been verified. The local workflow
   and checks are present.

Actual database auto-pause and resume still require an idle-window verification:
a complete 24-hour source/writer RDS event
lookup contained no such event, and 81 actual one-minute capacity samples ranged
from 0.5 to 1 ACU with no zero samples. Missing datapoints were not counted as
zero. Minimum zero and 600-second auto-pause are verified configuration, not
measured pause evidence. Complete this idle-window check before setting
`HostedChecksApproved=true`.

## Funding and access

The verified AWS credits permitted this isolated staging deployment and
disposable restore rehearsal. The app's initial funding review cutoff is
**November 27, 2026 at 22:46:31 UTC**. At that point requests and scheduled
processing stop before application-secret/database access; an otherwise idle
database can auto-pause after 600 seconds. This does not remove storage,
Secrets Manager, backups, logs, the retained KMS key or all other AWS charges.
The $10 budget has email thresholds; it is not a hard spending cap.

The owner's new account password is private. Browser preview access is a
separate credential stored only in `.data/aws-deploy/staging-access.txt`.
Keep the existing account and session intact while completing external gates.
Schedules remain enabled for this bounded private preview so sample positions
can settle. Every-minute jobs can keep Aurora active; the zero-ACU minimum does
not imply zero compute charges during this period.

The empty assets bucket retained by the failed first stack was deleted only
after the owner explicitly approved that exact bucket. Fresh checks verified
the deleted stack's resource mapping, matching application tags, no current
objects, versions, delete markers or multipart uploads, and exclusion of both
active buckets. Its absence and the active buckets' presence were verified.
