# AWS PostgreSQL and migration adapter: TDD evidence

Date: November 20, 2026. Source: the user's AWS-only adaptation request and the existing production-readiness guarantees. No external plan file or embedded shell instructions supplied validation commands.

## Guarantees

- Existing financial migrations001–004 run unchanged after an AWS-only identity/role bootstrap.
- Every financial RPC starts a transaction, binds a verified subject and fixed role locally, and commits or rolls back before releasing the connection.
- SQL names are allowlisted and values are bound. Data API JSON results are chunked into4096-character rows to avoid its64KiB row cap; SQL null remains JSON null.
- Runtime identity is a non-owner `NOINHERIT` role. It receives no direct Auth table grants; private Auth functions are service-only. RDS/Aurora does not require PostgreSQL superuser or `BYPASSRLS` for the existing security-definer application RPCs.
- Provider tokens are encrypted by the Cognito adapter before storage. SQL stores only encrypted payloads and hashes of opaque application handles.
- Refresh has one winner; late logout follows hashed family lineage; password-recovery revocation cannot miss a concurrent refresh.
- Migrations are statement-split with PostgreSQL quoting/comment rules, transactionally versioned, checksum protected, safe to retry, and read-only under `--check`.
- Runtime database credentials are read privately from Secrets Manager and bound to the configuration query, never accepted as command-line values or printed.

## RED/GREEN checkpoints

All listed checkpoints were created on the current `main` branch for this task; no earlier work is counted.

| Stage | Actual execution | Result and checkpoint |
|---|---|---|
| Initial adapter/bootstrap RED | `node --test tests/aws-database.test.mjs tests/aws-bootstrap.integration.mjs` |12 executed failures for absent implementation; `f333969`. The bootstrap target was later renamed to `.test.mjs` so it runs in default coverage. |
| Session lineage RED | Bootstrap target with late logout/recovery cases |6 intended failures while bootstrap was absent; `7d1793b`. |
| Initial GREEN | Same adapter/bootstrap targets |13 passed; private SQL storage and adapter implementation `b3ad388`. |
| SQL transport/migrator RED | Bootstrap Data API fixture + `tests/aws-migrate.test.mjs` |2 meaningful Data API SQL failures (duplicate projection labels and SQL null handling),7 missing migrator/splitter failures; `f8c0cb0`. |
| Direct PostgreSQL RED | `node --test tests/aws-postgres.test.mjs` |4 intended failures on missing executor; `9ce875a`. |
| Transport/migrator GREEN | Combined four owned targets |27 passed; `ae77742`. |
| Complete-chain/private setup RED | `node --test tests/aws-migrate.test.mjs` |7 passed/2 failed: unsupported Data API void result from the advisory lock and absent runtime-secret retrieval; `76d4e33`. |
| Migration GREEN | Same target |9 passed after casting the advisory-lock result and reading the runtime secret privately; `c37f65f`. |
| Real independent-session RED | `node --test tests/aws-auth-race.integration.mjs` |1 passed/2 failed: logout failed to return the refreshed successor and recovery missed the new session; `a4912e1`. |
| Real race GREEN | Same target against a new temporary PostgreSQL database |3 passed after per-user Auth locking and fresh re-read; `4563fbc`. |

The first unprivileged PostgreSQL initializer failed before executing any test and is excluded from RED evidence. The approved rerun used installed PostgreSQL15.14, a fresh disposable database ending in`_test`, and a private Unix socket with TCP disabled. Both RED/GREEN temporary clusters were stopped and removed. No existing database was used.

## Final verification

```text
node --test --experimental-test-coverage \
  --test-coverage-include='server/aws-database.ts' \
  --test-coverage-include='server/sql.ts' \
  --test-coverage-include='scripts/aws-migrate.mjs' \
  tests/aws-database.test.mjs tests/aws-bootstrap.test.mjs \
  tests/aws-postgres.test.mjs tests/aws-migrate.test.mjs

30 passed,0 failed,0 skipped
Selected scope:98.83% lines /87.59% branches /94.74% functions
aws-database.ts:97.62% lines /86.96% branches /95.00% functions
sql.ts:100% lines /93.98% branches /100% functions
aws-migrate.mjs:100% lines /80.88% branches /90.91% functions

node node_modules/typescript/bin/tsc --noEmit
exit0
```

Additional passing integration validates the actual private store factory against PostgreSQL through the Data API-shaped transport, including upsert, read, rotation, late revocation, user revocation, and recovery-email revocation. The complete migration-chain fixture applies bootstrap, all four existing migrations and finalization statement by statement, then retries without reapplying them and verifies schema version4.

## Runtime/deployment contract

Factories in `server/aws-database.ts`:

- `createDataApiDatabase({resourceArn,secretArn,database,region?,client?,timeoutMs?})`
- `createPostgresDatabase({pool?,connectionString?,ssl?,allowLocalInsecure?})`
- `createAwsDatabaseBackend({database,authenticate,auth})`
- `createAwsAuthStore(database)`

The database interface has `query(sql,namedParameters?)`, `transaction(callback)` and optional `close()`. Direct PostgreSQL verifies remote TLS and permits plaintext only for an explicitly enabled loopback connection. The Aurora Data API remains the planned managed deployment transport; the direct executor also supports local integration and future migration paths.

Run `node scripts/aws-migrate.mjs --check` for a read-only plan or `--apply` to apply reviewed files. Set private configuration through the process environment. Data API setup uses `BETER_DATABASE_RESOURCE_ARN`, `BETER_DATABASE_ADMIN_SECRET_ARN`, `BETER_DATABASE_NAME`, `BETER_DATABASE_RUNTIME_SECRET_ARN`, and `AWS_REGION`. The runtime secret must identify `beter_runtime`; its password is never printed. Direct migration mode uses `BETER_DATABASE_URL` and optionally `BETER_DATABASE_ALLOW_LOCAL_INSECURE=true` for loopback only. No secrets are accepted as flags.

`aws/sql/finalize.sql` wraps normal maintenance with bounded removal of expired private sessions and historical access-hash lineage. It preserves active refresh families and the short replay grace. Bootstrap and financial migrations are immutable after application; subsequent changes need a new reviewed migration.

## Sources and limits

AWS documents the [64KiB per-row limit and single-statement requirement](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.troubleshooting.html), [10MiB formatted JSON result limit](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html), and [transaction operations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api-operations.html). Chunking and SQL splitting implement those specific constraints; fixture tests do not substitute for an actual hosted Data API run.

No live AWS resources, credentials, provider requests, migrations or backups were accessed by this subtask. Hosted Aurora permissions, runtime-secret wiring, cold-resume behavior, actual migration execution, budget/credit state and Cognito/SES delivery remain parent deployment checks. SQL line coverage is not claimed. The existing financial concurrency suite remains separate from the three new Auth races.
