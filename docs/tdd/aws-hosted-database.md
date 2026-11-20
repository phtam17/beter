# Hosted database check procedure

`tests/aws-hosted-database.integration.mjs` is outside the normal `*.test.mjs` glob. It requires explicit `BETER_RUN_AWS_HOSTED_DATABASE=1`, a separately supplied `BETER_AWS_EXPECTED_ACCOUNT_ID`, and the private `.data/aws-deploy/state.json` produced by deployment tooling. Configure the verified AWS SDK/CLI profile through the private process environment, then run:

```text
node --test tests/aws-hosted-database.integration.mjs
```

Before any database write, it rejects production, public access, enabled schedules, live data, an expired funding review, an account/resource mismatch, non-private state files, and a changed actual CloudFormation stack. It warms only a read-only `SELECT 1` with bounded retries for Aurora resume/unavailability. Financial mutations are never retried automatically.

The procedure verifies actual runtime role flags and migration ownership, private auth-table denial, RLS between two synthetic subjects, caller-role reset after commit/rollback, one initial grant, overspend protection, request and settlement idempotency, Unicode JSON larger than64KiB through RPC chunking, and refresh/logout/recovery races. Races use distinct backend sessions observed waiting on one advisory lock before release. A failed check stops later mutations and preserves a fixed, redacted failure code.

Fixtures have unique generated identifiers and synthetic `example.invalid` emails. Financial history remains auditable. Finally, any open fixture bets are voided through the reviewed settlement RPC, fixture opaque sessions are revoked, and the ledger is reconciled. No existing financial records are deleted. This procedure exercises the database identity boundary using explicitly injected synthetic verified identities; it does not prove Cognito email delivery, HTTP cookies, CloudFront protection, or real-provider correctness.

## Local validation completed

- `node --test tests/aws-hosted-database.test.mjs`: safety contracts pass for explicit opt-in, private files, expected account, closed staging, resource separation, fresh actual stack validation, and client cleanup. These tests never contact AWS.
- The full procedure was executed against a fresh PostgreSQL15.14 cluster through a Data API command bridge with independent admin/runtime connections and an enforced64KiB row limit: **8/8 tests passed**, including all seven procedure steps. The cluster was stopped and removed afterward.
- `node --check tests/aws-hosted-database.integration.mjs` passed.

**No AWS execution has been performed by the author at this checkpoint.** Retain the actual hosted command result separately before treating these guarantees as proven on Aurora. The template/runtime review found the role and secret mappings compatible; actual managed role behavior, engine compatibility, cold start timing, IAM, and backup recovery require hosted evidence.

An actual AWS deployment exposed managed master secret names beginning with `rds!cluster-`. The dedicated regression was RED5/6 in `b653a79` and GREEN6/6 in `d528042` after the hosted-only validator accepted `!` in secret names. App runtime configuration did not change. `node --test tests/aws-hosted-database.test.mjs` now has6 passing safety tests and still performs no cloud calls.

The first coordinated hosted run passed the role/ownership subtest, then fixture user persistence failed because a Data API text parameter was supplied to a UUID function argument. The original error was masked by a second cleanup error. `a10a0d8` adds a named fixture-user subtest, explicit adapter signature casts, and a finalizer that reports only `HOSTED_FIXTURE_FINALIZATION_FAILED_REVIEW_REQUIRED` separately while preserving the original check failure. The dedicated cleanup regression is included in7 passing offline safety tests. The author performed only a coordinated read-only Aurora type probe; the root agent owns actual hosted fixture execution and its result.
