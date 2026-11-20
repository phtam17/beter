# AWS infrastructure and entry verification

The AWS entry, CloudFormation security contract, and artifact packaging were developed with executed failing tests before implementation. These checks are local evidence; they do not establish a successful hosted deployment, email delivery, restore, live provider run, or public-launch approval.

| Step | Executed failure | Implementation and passing check |
| --- | --- | --- |
| API/scheduled adapter | `d28e06e`: 10 cases failed because the AWS adapter did not exist | `8772662`: 10 cases passed for fixed origin, cookies, limits, separate schedule tasks, safe errors/metrics, and signup gate |
| Managed infrastructure | `e94f187`: missing template/resource contract failed | `eebe326`: 7 template checks passed for private storage/database, IAM, Cognito, schedules, alarms, and funding defaults |
| Funding cutoff | `d31e34e`: 20 passed/2 failed because API/worker/signup could continue beyond cutoff | `77d43b6`: 22 checks passed; edge and runtime reject before loading secrets/database |
| Deployable package | `c9153ae`: 4 cases failed because packaging was absent | `88e093d`: 4 cases passed for code-only ZIP, manifest hashes, allowed assets, secret/symlink rejection, and no local database bundle |
| Low-quota staging | `d6c0162`: reservation opt-in test failed on the absent parameter | `9ed9c10`: 10 infrastructure cases passed with reservations omitted by default and preserved API throttles |

During cutoff test authoring, two VM setup failures (`require` unavailable in the ESM test context) were corrected before the valid RED execution. Those setup errors are not counted as behavioral RED evidence.

Additional package cases in `cc93a1c` exercise failed builds, stale-manifest removal, nested asset paths, Finder metadata, unsupported public files, unsafe destinations, oversized templates, and missing build metadata. They verify already implemented safety paths rather than claiming a new RED cycle.

The focused command is:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='aws/handler.ts' \
  --test-coverage-include='scripts/aws-package.mjs' \
  tests/aws-handler.test.mjs tests/aws-package.test.mjs
node --test tests/aws-infrastructure.test.mjs
```

Latest focused result: 19/19 adapter/package cases and 10/10 infrastructure cases passed. Adapter coverage: 98.02% lines, 80.00% branches, 87.50% functions. Package coverage: 94.44% lines, 94.12% branches, 100% functions. Combined targeted coverage: 96.77% lines, 83.12% branches, 90.91% functions. Default deployed runtime loading and the command-line error-printing path require the composed runtime/build check in addition to fixture tests.

CloudFormation `validate-template` succeeded against the minimized current template through the deployment operator on November 20, 2026. This validates template syntax/structure, not resource creation permissions, service quotas, dynamic references, or successful service integration. Hosted resource checks remain recorded separately.
