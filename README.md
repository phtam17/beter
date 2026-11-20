# Beter

A sports betting practice app with virtual bankrolls, a separate demo portfolio, saved accounts, server-issued quotes, and automated result processing. All stakes are virtual.

## Run

Node.js 22.18 or newer is required.

```sh
npm ci
npm start
```

Open `http://127.0.0.1:4173`. **Sign in → Create account** starts a new $10,000 server-held portfolio. Development uses a clearly identified **sample feed** and a persistent local PostgreSQL engine. There are no default credentials. The signed-out demo retains its separate browser-local history and manual simulation controls.

Local development accounts do not send email. Hosted accounts and actual bookmaker odds become available after configuring Supabase, The Odds API, and the deployment environment. The app never substitutes sample prices for an unavailable live provider.

## Included

- Account signup/sign-in/signout, session refresh, and hosted password recovery.
- Persistent portfolios, exact-cent balances, append-only ledger, and account isolation.
- Pregame moneyline quotes with expiry, price-change review, start cutoffs, and duplicate-request protection.
- Backend results ingestion, repeatable grading, corrections, and operational health records.
- Durable write/auth limits, overdue-result reviews, audited operator recovery, and protected readiness checks.
- Portfolio charts, win rate, bet history, CSV export, search, and sport filters.
- The Odds API adapter for NBA, NFL, and NHL with a configurable reference bookmaker.
- Supabase migrations, protected scheduled worker, Vercel configuration, and CI checks.
- A separate demonstration mode with illustrative spread/total markets and cross-game parlays.

Connected betting currently supports moneyline singles. Unsupported markets cannot be accepted through the API. Missing or ambiguous results stay pending for review. A reset creates a new portfolio while preserving previous account records.

## Verify

```sh
npm run build
npm run test:coverage
npm run test:install-browsers
npm run test:e2e
```

The coverage command enforces 80% lines, branches, and functions across backend and shared domain/client modules. Playwright covers browser journeys. Embedded PostgreSQL integration tests verify the actual financial migration and row policies.

`npm run test:postgres` is a separate real PostgreSQL concurrency target. It requires `TEST_DATABASE_URL` pointing at a fresh disposable database; it refuses system databases and existing application tables. CI provisions that database automatically.

## Setup and evidence

- [Deployment and account configuration](docs/DEPLOYMENT.md)
- [TDD evidence](docs/releases/2.0.0/infrastructure.tdd.md)
- [Database guarantees and RED/GREEN results](docs/tdd/database.md)
- [Independent-session race checks](docs/tdd/postgres-race.md)
- [Operations, monitoring, rollback, and restore runbook](docs/OPERATIONS.md)
- [Production readiness fixes and remaining hosted gates](docs/tdd/production-readiness.md)

The complete static UI is in `dist/`, portable backend modules are in `server/`, and database/runtime deployment sources are in `supabase/`. Private keys belong in environment settings, never in `dist/` or Git. Copy `.env.example` to `.env.local` when configuring services.

Live-provider, hosted-auth, deployment, email delivery, scheduled HTTP delivery, independent hosted connections, and backup-restoration checks remain required in staging after those external accounts are configured.
