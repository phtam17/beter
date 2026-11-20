# Beter on AWS

Beter’s AWS deployment uses private S3 assets behind CloudFront, an HTTP API and Node.js 24 Lambda functions, Cognito, and an encrypted private Aurora PostgreSQL Serverless v2 cluster through the RDS Data API. No database port is exposed and no NAT gateway is created. The API, worker, and readiness monitor share a code artifact but use separate entry permissions and execution tasks.

This is a deployment runbook, not evidence of a completed launch. Retain the actual hosted check results before changing `LaunchOpen`.

## Funding and staging limits

This managed design exceeds a $10 monthly cash budget without credits. At the example Aurora price of $0.12 per ACU-hour, a continuously active 0.5 ACU writer alone costs approximately $43.80 per 730-hour month, before storage, I/O, backups, and other services. Exact costs depend on region and usage. Verify current [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/) and eligible account credits before each deployment or extension.

The operator verified approximately $217.06 of eligible credits on November 20, 2026, with the earliest reported expiry on September 30, 2027. These are dated observations, not a future balance guarantee. The initial review cutoff is November 27, 2026 at 23:59:59 UTC, or the earlier cutoff recorded in the private reviewed deployment plan. Keep the $10 monthly out-of-pocket ceiling and recheck account charges, credit eligibility, and credit expiry before extending that window.

The template requires `CreditsVerified=true` and a nonempty `CreditCutoffAt` in UTC, formatted `YYYY-MM-DDTHH:mm:ss`. Aurora defaults to minimum 0 ACU, maximum 1 ACU, and a ten-minute auto-pause interval. Confirm the exact engine version supports scale to zero and Data API in the chosen region. Every-minute worker and readiness schedules remain `DISABLED` until migrations and a bounded hosted check window are ready. Active schedules can prevent auto-pause; minimum 0 is not evidence of a zero compute bill. See the [Aurora auto-pause documentation](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html).

At the funding cutoff, the CloudFront gate, API adapter, worker, readiness monitor, and signup trigger reject work before loading application secrets or using the database. This allows an otherwise idle database to pause. It does not stop every AWS charge: storage, retained objects/snapshots, secrets, logging, requests rejected at the edge, and other account activity can still cost money. AWS Budgets notifications and the application cutoff are **not a hard billing cap**. The operator must review charges and disable or delete unneeded resources before credits become insufficient. The Lambda role cannot modify or stop RDS resources.

An optional account-wide net-cost budget includes credits and sends email at 50%, 80%, and 100% of the configured ceiling. Set `AlertEmail` and confirm the SNS subscription. Review both gross service use and net charges; credit application and billing reports can lag.

The account’s verified initial Lambda concurrency quota was 10. `EnableReservedConcurrency=false` permits closed staging without reservations. Before public launch, obtain and verify a regional quota of at least 105, then enable the five total reserved slots (API 2, signup 1, worker 1, monitor 1). AWS requires 100 slots to remain unreserved. API Gateway also applies a burst limit of 20 and a steady rate of 10 requests/second. Reservations and throttles limit concurrent work, not total monthly spending.

## Access and credentials

`LaunchOpen=false` is the default. CloudFront requires a private browser Basic credential or the `X-Beter-Staging-Access` machine header. The machine header contains the same complete `Basic …` Authorization value used by the browser, so machine requests can also carry a separate Bearer authorization value. Store this credential privately; do not place it in command arguments, committed files, screenshots, or logs. Only its SHA256 hash is embedded in the CloudFront function. The function removes staging credentials, preserves Bearer authorization, and stamps the actual viewer IP before forwarding.

The API additionally requires a separate random origin-verification secret injected by CloudFront. Direct calls to the API Gateway hostname fail without it. The adapter removes untrusted forwarding headers, uses the configured `SITE_URL`, carries browser cookies through API Gateway’s cookie array, and forces API responses to `Cache-Control: no-store`.

Closed staging also rejects direct Cognito signups unless the normalized email is in `TestEmailAllowlist`. An empty list denies all new registrations. Cognito uses case-insensitive immutable email usernames, confirmation links, verified-email recovery codes, and a public app client with password and refresh authentication. Beter’s server session layer controls browser session rotation. Do not enable Cognito refresh-token rotation independently of that implementation.

Create the private runtime secret before the stack. Its JSON fields are `sessionSecret`, `jobSecret`, `originSecret`, and `oddsApiKey`; use independent high-entropy values. The runtime role reads this secret and the generated **application** database secret. It cannot read the RDS-managed master credential. The migration operator uses the master credential only to bootstrap roles, apply reviewed migrations, and finalize least-privilege grants; application traffic uses `beter_runtime`.

Rotating `originSecret` requires coordinated CloudFront configuration and Lambda runtime refresh: changing the stored secret alone does not refresh an already resolved CloudFormation dynamic reference or a warm runtime cache. Keep staging closed, update the distribution’s origin header, refresh runtime instances, and verify both direct-origin rejection and normal access before retiring the old value. Session-secret rotation invalidates browser sessions. Keep secret values out of deployment output.

## Build and deploy the closed stack

1. Verify account identity, region, eligible credits/expiry, current net charges, and the private funding plan. Verify Aurora engine support and service quotas. Review the CloudFormation change set and costs before executing it.
2. Run the app’s local checks and production build. Run `node scripts/aws-package.mjs`. It writes `artifacts/aws/manifest.json`, a code-only Lambda ZIP, a minimized CloudFormation template, and an explicit static-asset upload list. The packager requires the `zip` tool. It rejects symlinks, hidden files, unreviewed public file types, missing public entry pages, and bundles containing the local PGlite database. It never reads application environment files into the bundle.
3. Preserve the manifest’s SHA256 values. Recheck every artifact before uploading, use the ZIP hash in its S3 key, and retain the previous approved manifest for rollback. The formatted source template exceeds CloudFormation’s inline size limit; deploy the minimized generated template or a reviewed S3 template URL.
4. Create the encrypted private artifact bucket and private runtime secret using the deployment operator. Keep the private recovery state under `.data/aws-deploy/` with directory mode 0700 and file mode 0600. Never commit or print it.
5. Create closed staging with `LaunchOpen=false`, `ScheduleState=DISABLED`, `CreditsVerified=true`, the reviewed cutoff, the private staging hash, and an explicit test-email allowlist. The initial `SiteOrigin` may be `https://pending.invalid` because referencing the distribution from the Lambda environment would create a CloudFormation dependency cycle.
6. Wait for `CREATE_COMPLETE`. Run `node scripts/aws-publish.mjs` to upload only hash-verified manifest assets to the stack’s private assets bucket with their reviewed content types and `Cache-Control: no-cache`. Update `SiteOrigin` to the actual `https://<CloudFrontDomain>` while preserving every other stack parameter, then wait for `UPDATE_COMPLETE`. The publisher requests the distribution invalidation and preserves the other stack parameters. Do not test signup or cookie/origin behavior while the placeholder origin remains.
7. Use the reviewed AWS database migration runner to bootstrap and migrate, then verify the application credential cannot write protected tables directly or impersonate another user. Do not seed accounts or positions through administrative SQL.

`server/aws-runtime.ts` consumes `BETER_BACKEND=aws`, `BETER_DATABASE_NAME`, `BETER_DATABASE_RESOURCE_ARN`, `BETER_DATABASE_SECRET_ARN`, `BETER_COGNITO_USER_POOL_ID`, `BETER_COGNITO_CLIENT_ID`, `BETER_RUNTIME_SECRET_ARN`, `BETER_FUNDING_CUTOFF_AT`, and `SITE_URL`. Dedicated scheduled functions also receive `BETER_AWS_TASK=process` or `monitor`. Environment variables hold references and configuration, not the runtime secret values.

## Hosted checks to retain

Record the URL, build/artifact hash, stack ID, migration versions, timestamp, safe results, and cleanup status for each check. Keep sensitive emails, tokens, and private state out of the report.

- Confirm staging requires its private credential, disallowed emails cannot register through the app or Cognito directly, and direct API Gateway access returns a safe rejection. Verify spoofed viewer/source headers do not defeat per-source limits.
- Confirm HTTPS, security headers, cookies (`Secure`, `HttpOnly`, correct `SameSite`), fixed canonical origin, same-origin mutation protection, no API caching, and no credentials or personal data in logs, page source, static uploads, or deployment outputs.
- Run real allowlisted signup, email-link confirmation, sign-in, reload, sign-out, expired-session recovery, password-reset code, password change, stale-session revocation, account deletion, and a second isolated test account. Check both desktop and mobile browser flows and accessibility.
- Verify migrations and database verification queries against hosted Aurora. Exercise simultaneous trading, insufficient funds, duplicate/replayed operations, ownership isolation, transaction rollback, and idempotent settlement using isolated fixtures. Confirm the runtime credential has the intended least privileges.
- Configure the live odds provider in the private secret. Verify real ingestion, provider limits/timeouts, stale-data behavior, settlement/review handling, and protected operator actions. Production cannot launch with sample data.
- Enable schedules only for the bounded test window. Verify successful worker and readiness metrics, deliberately trigger a safe failure, receive the SNS alert, and prove that a missing heartbeat alarms. Check schedule permissions and retries. Disable schedules again when testing ends.
- Prove backup recovery by restoring a staging snapshot or point-in-time backup into an isolated cluster, running integrity checks there, recording elapsed recovery time/data loss, and deleting the temporary paid resources. A configured backup policy does not establish restore success.
- Deploy the previous approved code/static artifact as a rollback rehearsal while preserving compatible schema, then restore the intended release and verify health. Prefer a forward migration for schema repairs; never assume deleting a stack reverses data changes.
- Test a near-future cutoff in isolated staging and verify edge, API, scheduled work, and signup all stop before DB access. Restore the reviewed cutoff, wait for DB auto-pause with schedules disabled, and inspect actual billed service usage and credit drawdown.

The template configures snapshot-on-removal for Aurora and retains the versioned assets bucket. Production also enables database and Cognito deletion protection. These safeguards mean stack deletion is not complete cleanup and retained resources may remain billable. Inventory and intentionally retain or remove them under the operator’s recovery decision.

## Public-launch requirements still requiring setup or proof

Provide a domain, a matching ACM certificate in `us-east-1`, a verified SES sender with suitable production sending access, real support/privacy/account-deletion URLs, a live odds provider key, and an alert owner. Verify email deliverability and SES/Cognito production limits. The default Cognito sender is suitable only for controlled staging checks.

A CloudFront default hostname provides HTTPS for private staging, but AWS applies its default certificate security policy. The template requires a custom domain/certificate before opening public production so the configured viewer policy can enforce `TLSv1.2_2021`. See [CloudFront ViewerCertificate](https://docs.aws.amazon.com/cloudfront/latest/APIReference/API_ViewerCertificate.html).

Complete and retain every applicable hosted check, verify credit runway and the next cutoff, confirm the alert destination, review load/abuse protection and quotas, and enable reviewed reservations before launch. `HostedChecksApproved=true` is an operator attestation after this evidence exists. Public opening also requires `Environment=production`, `DataMode=live`, and the domain, SES, alert, and policy parameters. Do not set this attestation merely because the local test suite passes.
