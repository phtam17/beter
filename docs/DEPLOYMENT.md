# Deploying Beter

The code supports persistent local development and hosted Supabase accounts. Actual bookmaker data and hosted services require your configured accounts. Repository configuration does not provision or establish the state of those services; verify the actual hosted release separately.

## Local development

Use Node.js 22.18 or newer:

```sh
npm ci
npm start
```

Open `http://127.0.0.1:4173`. Signed-out visitors can explore the existing demo. Choose **Sign in → Create account** to exercise server-held portfolios against the local PostgreSQL engine. Those accounts use a clearly labeled sample feed, not live prices. Local accounts and token digests persist under `.data/postgres`, which is ignored by Git. Local email recovery is explicitly unavailable because no email service is configured.

The local sample adapter anchors its fixtures at server startup; restarting development reanchors its sample games. It is for testing application flows. Production never silently selects it.

## 1. Supabase database and accounts

1. Create separate staging and production Supabase projects.
2. Apply all versioned files in `supabase/migrations/` in order to staging first using your linked Supabase CLI, then production after validation. Existing installations apply only unapplied forward migrations. The current required version is `202611200004`; the original financial migration remains unchanged. The migrations expect Supabase's existing auth schema and roles.
3. Configure the application Site URL and allowed redirect URLs for each environment. Keep them separate; production credentials must not be exposed to preview deployments.
4. Enable email confirmation, choose account access controls appropriate for your private beta, and configure your production SMTP sender and sending domain. Test confirmation, sign-in, and recovery emails with real delivery.
5. Store the Supabase project URL, publishable/anon key, and server service-role key as environment variables. The service-role key is private and must never appear in the browser, a URL, or a committed file.

No browser role can write financial tables or call ingestion/settlement RPCs. Account identity comes from a verified Supabase Auth token. Quote creation and placement use `auth.uid()` inside the database transaction.

## 2. Odds provider

Configure The Odds API account and set these server variables:

```text
ODDS_API_KEY=<private provider key>
ODDS_BOOKMAKER=draftkings
BETER_DATA_MODE=live
```

The reference bookmaker is configurable. Verify the selected book supplies the supported league and market in your actual subscription. Missing bookmaker prices are retired, not replaced with prices from another book. Prices, provider update times, retrieval times, and accepted quotes are retained with each bet.

The connected beta permits one pregame moneyline selection per ticket. Spreads, totals, and parlays remain available in the separate demo; the provider normalizer and grader have additional tested groundwork, but connected quotes reject those markets.

## 3. Vercel website and API

Import this project directory as the repository root, use the supplied `vercel.json`, and select a supported Node runtime at least 22.18. Build command: `npm run build`; static directory: `dist`.

Configure these variables separately for staging and production:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Environment's Supabase origin |
| `SUPABASE_ANON_KEY` | Environment's publishable/anon key |
| `SUPABASE_SERVICE_ROLE_KEY` | Private server key |
| `BETER_SESSION_SECRET` | Optional dedicated random secret, at least 32 characters; otherwise domain-separated derivation from the private service key |
| `ODDS_API_KEY` | Private provider key |
| `ODDS_BOOKMAKER` | Chosen reference bookmaker |
| `BETER_DATA_MODE` | `live` |
| `BETER_ENVIRONMENT` | `production` for public release; `staging` for isolated staging |
| `SITE_URL` | Actual HTTPS app origin |
| `ALLOWED_ORIGINS` | Comma-separated approved app origins, no trailing slashes |
| `JOB_SECRET` | Private random value, at least 32 characters |
| `BETER_SUPPORT_URL` | Working HTTPS support destination |
| `BETER_PRIVACY_URL` | Published HTTPS data-use/retention policy |
| `BETER_ACCOUNT_DELETION_URL` | Working HTTPS destination that initiates account deletion |

The Vercel API entry delegates to the tested TypeScript handler. Supabase hosts durable records and authentication; Vercel stores neither balances nor a local database. `/api/config` reveals only configuration status and supported capabilities, never private keys.

Production now refuses startup without a complete secure account backend, strong worker/session secrets, a real HTTPS site origin, and the configured live-provider key. Hosted sample mode requires `BETER_ENVIRONMENT=staging`. Copying development `.env.example` values unchanged is not a production setup. Public account destinations are validated and checked by protected readiness; configure the actual policies and working support/deletion process before opening access.

### Browser sessions

The account UI calls the same-origin `/api` using an encrypted, authenticated HttpOnly cookie. On HTTPS its name is `__Host-beter-session`, with `Secure`, `SameSite=Lax`, and `Path=/`; loopback HTTP development uses a separate `beter-session-dev` cookie. Browser responses contain only public user/expiry metadata. Access and refresh credentials never enter browser storage. Browser mutations require a matching origin; raw bearer API clients remain supported independently.

`BETER_SESSION_SECRET` must remain consistent across application instances and the Edge Function. When omitted on hosted deployments, a domain-separated encryption key is derived from the private Supabase service key. Rotating either secret invalidates existing browser cookies and requires sign-in again. Local development generates `.browser-session-key` with private permissions in `BETER_DATA_DIR`; preserve that file with the local database to retain sessions across restarts.

The migration removes the old script-readable session key and requires one fresh sign-in. Personal practice history and draft selections remain separate. Signout expires the authentication cookie without wiping that independent practice data. Do not place a frontend on another origin while relying on these same-origin cookies; a separate browser origin needs an explicitly designed credential/CSRF deployment policy.

Unfinished browser sign-out persists only a non-secret intent marker and blocks account restoration/private calls until cookie termination is confirmed. When storage is denied the interface explains the reload risk and offers retry. An acknowledged local sign-out expires the browser cookie even if provider revocation is unavailable; it does not claim that copied remote credentials were revoked. Verify the provider's session-revocation behavior on staging.

Auth attempts use shared database budgets keyed by server HMACs, not raw emails/addresses: identity 10 per 10 minutes, recovery 3 per hour, trusted source 30 per minute, and global 600 per minute. Only the Vercel runtime trusts its platform-overwritten forwarding header; other hosts use identity/global limits and require their own trusted edge controls. The direct Supabase Auth endpoint also needs its native throttling and access controls configured and tested. Database insert quotas independently cover direct authenticated financial RPC calls: portfolios 5/hour and 20/day, quotes 30/minute and 500/day, new bets 30/minute and 300/day. Accepted request retries retain idempotent behavior.

## 4. Automatic ingestion and settlement

`npm run build` copies the portable server modules into `supabase/functions/_shared`. Deploy the `beter` Edge Function using your linked Supabase CLI. Configure the same Supabase, odds, site-origin and worker-secret values in that function's environment. The function uses its own authentication checks; `verify_jwt=false` allows the separate scheduled-job credential, not anonymous financial mutations.

In Supabase Vault, create:

- `beter_worker_url`: `https://<project-ref>.supabase.co/functions/v1/beter/api/jobs/process`
- `beter_job_secret`: the same private `JOB_SECRET` used by the function.

Apply `supabase/setup-jobs.sql` after those entries exist. It schedules a protected POST every minute. Inspect both Cron and `pg_net` responses; an HTTP request being queued is not proof its worker completed.

The database's open bets and recent settlements form its durable work backlog. Each pass reads at most 100 events and saves a keyset cursor for the next pass, preventing unresolved older events from permanently occupying the first page. Result versions and financial effects are idempotent. Missing or incomplete results beyond six hours become explicit review records and make processing unready. An audited operator resolution and automation hold/resume procedure covers evidence outside the provider's recent score window. See [operations and recovery](OPERATIONS.md).

Hosted sample mode is opt-in only and is unsuitable for performance claims. Keep it confined to staging demonstrations.

## 5. Verification before invitations

```sh
npm run build
npm run test:coverage
npm run test:e2e
```

Coverage enforces at least 80% lines, branches and functions for the backend, client API adapter, simulation engine and market utilities. Browser flows are exercised separately with Playwright. PostgreSQL policy and financial behavior are integration-tested using PGlite; SQL line coverage is not claimed.

Run the independent-session race target against a **new, empty, disposable** PostgreSQL database whose name ends with `_test`:

```sh
npm run test:postgres
```

Configure `TEST_DATABASE_URL` through your environment before invoking it. It refuses existing application tables and system databases. It creates test objects and does not clear them afterward; use a fresh database each time. CI supplies an ephemeral PostgreSQL 17 service.

Local embedded checks do not replace staging validation of actual Supabase Auth, PostgREST roles, independent connections, cron delivery, SMTP, provider access, and restoration. Exercise a backup restore and reconciliation before opening the beta. Live provider and hosted deployment checks cannot pass until those accounts are configured.

## Monitoring and operations

- `/api/health` is process liveness, not dependency readiness.
- `/api/ready` requires the worker credential and returns HTTP 503 when the database/schema, feed/worker heartbeat, reconciliation, unresolved review state, or public release configuration is unready. Use `npm run ops -- check` as a release/monitor gate with `BETER_OPS_URL` and `JOB_SECRET` privately configured.
- `/api/health/details` requires the worker credential and returns ledger mismatch counts, unresolved bets and job heartbeats.
- Monitor `beter_jobs` for failures and stale successful `pipeline` runs; alert on a missing heartbeat beyond two scheduled intervals.
- Alert on any nonzero ledger mismatch or results requiring review. Missing results must stay pending; absence is not a cancellation.
- Inspect provider quota, database growth, auth failures and API error rates. Use the platform's request-rate controls before public access.
- Raw provider errors and request URLs must not be logged, because provider credentials are carried in their query strings.
- Bounded maintenance removes unaccepted quotes more than 24 hours past expiry, disposable jobs older than 30 days while retaining essential latest heartbeats/unresolved reviews, and auth-budget rows older than 24 hours. Accepted quotes, financial history, result evidence, and operator audit are retained. Never delete ledger records to reset a bankroll.

Unexpected API faults now emit fixed, private diagnostic fields with a generated `X-Request-ID`; raw request bodies, provider exceptions/URLs, credentials and emails are omitted. Connect platform log retention and alert delivery, and rehearse the [incident, rollback, and backup-restore procedures](OPERATIONS.md). A checked-in procedure is not evidence that backups or notifications work.

`GET /api/history?portfolioId=<uuid>&before=<bet-uuid>&limit=50&status=won` provides owner-scoped keyset history pages (maximum 100), with optional server-wide result filtering. Portfolio responses contain at most 100 recent bets and 200 representative non-stake chart points; exact all-history summary counts and cents remain authoritative. These chart points are a presentation projection, not the complete audit ledger. The underlying ledger and accepted evidence remain intact. Each selected settlement event still carries its full accepted bet set for stable correction evidence. Validate realistic event fan-out, history size and polling load on staging before expanding traffic; do not treat the event-page limit as a bound on all per-event work.

Result corrections may reverse winnings that have already been spent. This can expose a negative available balance with an audit entry. New stakes remain blocked until a fresh portfolio is chosen or sufficient funds exist.

## Settlement policy

The connected beta uses full-game two-way moneyline outcomes and the provider's confirmed final scores, including its overtime/shootout score accounting. A tied result voids a two-way moneyline ticket. Cancellations, postponements, unsupported result scopes and missing/ambiguous evidence need operator review; they are not guessed from a missing feed item. Every bet stores `beter-full-game-v1` so later policy changes do not silently change accepted terms.

This application has no real-money deposits, withdrawals, prizes, or wagering transactions.
