# Operating and recovering Beter

This runbook covers virtual-money accounts, scheduled moneyline processing, result review, and release recovery. It is a procedure to rehearse, not evidence that hosting, backups, monitoring, or notifications have been configured.

## Release ownership

Fill these values in the private deployment record before public invitations:

| Item | Required record |
|---|---|
| Service owner and backup owner | Named people or an existing on-call rotation |
| Alert destination and escalation | A monitored destination and who responds if unacknowledged |
| Release identifier | Git commit and deployed artifact identifier |
| Database version | All applied forward migration identifiers, currently through `202611200004` |
| Staging and production | Separate app origins, database projects, secret scopes and email settings |
| Recovery objectives | Accepted maximum outage and data loss, with the restore drill's measured values |
| Backup record | Provider-supported backup method, retention, last verified restore, and access owner |

No actual contacts, recovery objectives, backup subscription, or notification destination are invented by this repository.

## Protected operator tool

The application includes `scripts/ops.mjs`, invoked with `npm run ops -- <command>`. Supply `BETER_OPS_URL` (the app's HTTPS origin) and `JOB_SECRET` through the host's secret manager or a private process environment. The tool does not read `.env.local`, accept secrets as arguments, or print credentials. Loopback HTTP is accepted for local exercises. Do not paste secrets into shell history, input JSON, screenshots, or issue reports.

| Command | Purpose |
|---|---|
| `npm run ops -- check` | Check protected dependency readiness; nonzero exit when unready |
| `npm run ops -- status` | Read a safe health summary and pending-review count |
| `npm run ops -- resolve --file /private/path/review.json` | Apply verified outcomes with an operator identity, reason, source evidence, and idempotent version |
| `npm run ops -- resume --file /private/path/resume.json` | Audit the decision to release an event's automation hold |
| `npm run ops -- maintenance --batch-size 1000` | Run a bounded cleanup pass for disposable operational records |

Exit status **0** means the command was confirmed; **1** means unready, failed, or not confirmed; **2** means local setup/input needs correction. A successful `status` read is not a readiness verdict: use `check` for a release/monitoring gate. Requests have a deadline that includes response consumption. After a timeout, inspect current state before retrying a mutation. The tool prints fixed codes, counts, ages, and selected job timestamps; it omits raw provider bodies, job detail, review evidence, operator names and reasons.

The worker secret is privileged: protect its environment and limit who can execute mutation commands. The `operator` field records the supplied reviewer identity; it is not an independent identity-provider assertion. Retain authenticated platform access logs and a separate review/ticket record for attribution. Separate operator credentials or a full administrative identity system can replace this shared-secret operational boundary when the team needs finer access control.

## Monitoring and alert verification

Configure an external scheduler or host monitoring job to run `check` approximately once per minute against the correct deployment. Store its worker credential in that system's secret store. Route nonzero exit status to the named owner; do not expose the protected endpoint or credential in a public status page.

Readiness independently checks the database health response, ledger reconciliation, overdue bets, unresolved review state, the latest worker completion, required odds-feed jobs, recent failures, required schema, and release configuration. A failed `review:` record remains blocking until a later successful record explicitly resolves it; the transient failure window does not dismiss operator work. The default heartbeat budget is 150 seconds: two scheduled one-minute intervals plus delivery grace. `/api/health` remains process liveness and must not be the only release check.

Before invitations, deliberately exercise all of these on staging:

1. Stop the scheduled worker. Confirm stale-worker detection and an alert that reaches the owner.
2. Make a controlled provider or database request fail. Confirm the pipeline becomes unready and diagnostics remain redacted.
3. Create a safe test overdue event without a confirmed result. Confirm a review record and an overdue-settlement alert even if HTTP scheduling still succeeds.
4. Exercise the ledger-mismatch alert with a disposable test fixture; never alter live financial history to create an alert.
5. Confirm recovery clears the alert, and confirm an unacknowledged alert escalates to the backup owner.

Keep provider quota/exhaustion, API/auth error rates, database growth, deployment errors, and email delivery under the platform's monitoring. This repository does not prove a notification was delivered. Preserve the alert drill's timestamps and acknowledgment in the release record.

## Missing results, cancellations and manual correction

The live adapter requests the provider's recent scores. An outage beyond that window cannot be solved by retrying the same feed forever. Missing evidence remains pending; it must not become a guessed loss, cancellation, or refund.

1. Run `status`; inspect the protected database review records and accepted bets using approved private tooling. The CLI intentionally omits detailed evidence and event identifiers from routine monitor output.
2. Establish the event identity and published `beter-full-game-v1` settlement rules. Obtain attributable final/cancellation evidence and its actual source timestamp. Retain the source in the private incident/review record. A postponed or still-ambiguous event remains pending until a justified policy outcome exists.
3. Have the authorized reviewer prepare a JSON file. Supply **every accepted bet ID for the event**, each exactly once, with `won`, `lost`, or `void`. Do not calculate or submit balances or payout amounts; the database applies accepted stakes and payouts atomically.
4. Use a stable, unique `resultVersion` for this reviewed decision. Retry the identical file/version after an interrupted request; changed outcomes or evidence need a new reviewed version and a current attributable timestamp. Do not forge a newer timestamp to bypass conflict checks.
5. Run `resolve`, inspect its result, and confirm zero ledger mismatches. The database appends evidence and operator audit entries, then holds that event's automation. A worker that had already read the event is also prevented from replacing the manual decision.
6. Leave the hold in place unless resumed automation is explicitly intended. To release it, prepare a separate `resume` file with the event, reviewer, and a clear reason; verify the provider evidence and correction order first. Resuming permits later verified automated corrections.

Example shape only; replace identifiers, outcomes, source and timestamp with the verified event's actual records:

```json
{
  "eventId": "verified-provider-event-id",
  "operator": "Reviewer identity",
  "reason": "Verified the final result against the retained source record.",
  "resultVersion": "review-incident-123-v1",
  "evidence": {
    "source": "https://official-source.example/results/event",
    "last_update": "2026-11-20T12:00:00Z"
  },
  "outcomes": [
    {"bet_id": "c91df6cc-cd9b-493f-a721-eaf787a98301", "status": "won"}
  ]
}
```

The example URL is illustrative and must not be treated as result evidence. A resume file contains only `eventId`, `operator`, and `reason`. Review files are bounded to 1 MiB and at most 10,000 outcomes. Larger events require a separately reviewed privileged procedure and capacity work; do not split a decision into conflicting versions or bypass audit protections. Keep review files private and remove disposable local copies according to your operational data policy after their evidence is retained appropriately.

## Routine retention and capacity

Each worker pass processes one page of at most 100 candidate events and persists its next cursor in the pipeline record. End-of-backlog wraps to the beginning. This prevents old unresolved events from permanently occupying the first page. Each event currently carries all its accepted bets so result versions remain stable; a highly popular event can still produce a large payload. Load-test realistic event fan-out and history sizes before expanding traffic.

The worker also runs bounded maintenance. The supplied policy removes unaccepted quotes only after their expiry is more than 24 hours old and prunes disposable job history older than 30 days while preserving essential latest heartbeats and unresolved review state. Accepted quotes, bets, ledger records, result evidence, and operator audit entries are preserved. Auth throttling records have their own short operational cleanup. Record any policy changes in a forward migration; do not clear the ledger to reset a portfolio.

## Incident containment

1. Record the incident owner, affected release/time window, symptoms and a private incident identifier. Avoid copying secrets or personal records into public tickets.
2. Close signup/invitations and pause new placement/quote/portfolio mutations at both the application edge and the directly callable database RPC boundary. A website-only block is insufficient. If needed, an authorized database operator can temporarily revoke the authenticated role's execution of the four financial RPCs listed below. This also interrupts portfolio loading for affected users; communicate the maintenance state through your deployment's incident channel.
3. Suspend the `beter-market-and-result-sync` Cron schedule and wait for in-flight atomic work to finish or inspect its status. Do not assume disabling scheduling cancels an already executing request. Keep the worker secret private; restrict operator access during the incident.
4. Preserve logs, current deployment identifiers, migration versions, job state, and backup metadata before attempting repairs. Investigate using request identifiers and fixed error codes. Do not log raw credentials, session cookies, recovery links, provider URLs with keys, or full request bodies.

The database mutation boundary consists of:

```text
public.beter_portfolio()
public.beter_create_portfolio(text)
public.beter_quote(jsonb)
public.beter_place_bet(uuid,bigint,text)
```

A reviewed containment change can revoke `EXECUTE` on these functions from `authenticated`; restoration must reapply exactly the intended grants after reconciliation. Do not drop functions, disable audit triggers, weaken ownership policies, or alter ledger history during containment. Keep the exact containment and restoration actions in the incident record.

## Application rollback

1. Identify the last compatible release by immutable source/artifact identifier. Verify its compatibility with the current database migration, session format and operational hold behavior on staging. Do not blindly revert to an older app that restores a known privacy bug or bypasses a new control.
2. Keep new mutations and the schedule paused during the decision. Restore the known compatible application artifact and its matching non-secret configuration references; secrets remain in the environment's private settings.
3. Run read-only smoke checks and `check`; verify account isolation, cookie behavior and recovery URLs using isolated staging accounts before production reopening. Inspect accepted requests around the failure window for unknown outcomes.
4. Re-enable only the intended database grants and scheduled job, then observe a completed pass, settled test event and reconciled ledger. Reopen invitations after the owner records the result.

Database migrations are forward-only. Application rollback does not undo an applied migration. Use a reviewed forward repair for schema/data issues where possible; never run an ad hoc destructive down migration against accepted financial history.

## Backup restore and reconciliation drill

Perform this first on isolated staging with no production user traffic or provider keys. Follow the hosting/database provider's supported backup/restore process, including its requirements for a consistent Auth/application database state. This repository does not configure backups or establish their retention.

1. Select a known backup and record its timestamp, source migration version, source release, expected data loss window, and who can authorize recovery. Confirm the backup is accessible independently of the failed deployment.
2. Restore to a separate, isolated project/database. Keep Cron and outbound notifications disabled. Configure destination-specific URLs, keys, session secret and email settings privately; never attach preview services to production credentials.
3. Deploy the compatible application and apply only the required reviewed forward migrations. Verify the expected schema version, RLS and function grants, Auth-account linkage, operator holds, and protected worker access.
4. Reconcile every portfolio's stored balance to the sum of its append-only ledger. Verify accepted bet/quote relationships, open stakes, result versions, and operator audit entries. Run `status` and confirm zero ledger mismatches; a zero mismatch count alone does not prove that all accepted writes survived the backup.
5. Compare accepted operations around the recovery point against the retained release/incident records. Classify requests with unknown outcomes before retrying; reuse their original idempotency keys when available. Do not fabricate missing bets or reconstruct money from screenshots.
6. Exercise an isolated account confirmation/sign-in/recovery, quote and placement, repeated placement, scheduled settlement, duplicate settlement, and an audited correction. Confirm reconciliation after each stage.
7. Review open events older than the provider's retrieval window. Resolve them only through attributable evidence and the audited procedure above. Test that held events resist automatic overwrite.
8. Record the measured recovery time, actual data loss, reconciliation outcome, missing dependencies, alert delivery and owner sign-off. Update the documented objectives and repeat the drill after material schema or hosting changes.

For a real incident, keep production traffic paused while comparing and validating the recovered state. Switch traffic and restore scheduling only after the owner approves the concrete recovery result, grants are correct, and monitoring is ready. A successful isolated restore drill is required evidence; this document is not a claim that one has occurred.
