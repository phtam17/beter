# AWS infrastructure and entry verification

The AWS entry, CloudFormation security contract, and artifact packaging were developed with executed failing tests before implementation. These checks are local evidence; they do not establish a successful hosted deployment, email delivery, restore, live provider run, or public-launch approval.

| Step | Executed failure | Implementation and passing check |
| --- | --- | --- |
| API/scheduled adapter | `d28e06e`: 10 cases failed because the AWS adapter did not exist | `8772662`: 10 cases passed for fixed origin, cookies, limits, separate schedule tasks, safe errors/metrics, and signup gate |
| Managed infrastructure | `e94f187`: missing template/resource contract failed | `eebe326`: 7 template checks passed for private storage/database, IAM, Cognito, schedules, alarms, and funding defaults |
| Funding cutoff | `d31e34e`: 20 passed/2 failed because API/worker/signup could continue beyond cutoff | `77d43b6`: 22 checks passed; edge and runtime reject before loading secrets/database |
| Deployable package | `c9153ae`: 4 cases failed because packaging was absent | `88e093d`: 4 cases passed for code-only ZIP, manifest hashes, allowed assets, secret/symlink rejection, and no local database bundle |
| Low-quota staging | `d6c0162`: reservation opt-in test failed on the absent parameter | `9ed9c10`: 10 infrastructure cases passed with reservations omitted by default and preserved API throttles |
| Public asset publishing | `f6a19f9`: 4 cases failed because the publisher did not exist | `214e4df`: 4 cases passed for hash verification, closed stack checks, preserved parameters, canonical origin, private state, and invalidation |
| CloudFront policy regression | Hosted create-stack failed on a nonexistent managed cache-policy ID; `2bfd288` reproduced it locally with 2 failures | `c8caee9`: both API behaviors use the documented CachingDisabled ID; all 11 infrastructure cases passed |
| Lambda JSON metrics | `4dff246`: a simulated Lambda console wrapper hid the root EMF metadata | `2842899`: metrics use raw stdout; all 14 adapter cases passed |

During cutoff test authoring, two VM setup failures (`require` unavailable in the ESM test context) were corrected before the valid RED execution. Those setup errors are not counted as behavioral RED evidence.

Additional package cases in `cc93a1c` exercise failed builds, stale-manifest removal, nested asset paths, Finder metadata, unsupported public files, unsafe destinations, oversized templates, and missing build metadata. They verify already implemented safety paths rather than claiming a new RED cycle.

The focused command is:

```sh
node --test --experimental-test-coverage \
  --test-coverage-include='aws/handler.ts' \
  --test-coverage-include='scripts/aws-package.mjs' \
  --test-coverage-include='scripts/aws-publish.mjs' \
  tests/aws-handler.test.mjs tests/aws-package.test.mjs \
  tests/aws-publish.test.mjs tests/aws-infrastructure.test.mjs
```

Latest focused result: 38/38 cases passed (14 adapter, 6 package, 7 publisher, 11 infrastructure). Adapter coverage: 100% lines, 80.17% branches, 93.75% functions. Package coverage: 94.44% lines, 94.12% branches, 100% functions. Publisher coverage: 95.45% lines, 83.61% branches, 100% functions. Combined targeted coverage: 97.49% lines, 83.33% branches, 96.55% functions. Publisher failure checks also cover malformed private JSON, source symlinks, invalid public metadata, changed accounts, and missing remote outputs.

The real composed runtime bundle was packaged into an isolated temporary output directory and imported successfully. It exported the three expected entry/factory functions, included 10 reviewed public assets, and rejected a direct-origin HTTP smoke event with 403 before AWS access. The minimized template was 34,800 bytes. Artifact sizes and hashes change with later source changes; regenerate the reviewed deployment package after changes.

The first hosted create-stack attempt exposed an incorrect managed policy ID that the original unit expectation had repeated. The regression now checks both API behaviors against the ID in the [official AWS managed-policy reference](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/using-managed-cache-policies.html). Passing template syntax validation had not validated that external policy’s existence. Stack recovery and retained-resource cleanup belong in the hosted deployment record.

The heartbeat fix follows [AWS Node.js logging guidance](https://docs.aws.amazon.com/lambda/latest/dg/nodejs-logging.html): direct EMF output uses stdout so Lambda JSON console wrapping does not prevent metric extraction. Actual CloudWatch metric extraction and alert delivery still require hosted checks.

CloudFormation `validate-template` succeeded against the minimized current template through the deployment operator on November 20, 2026. This validates template syntax/structure, not resource creation permissions, service quotas, dynamic references, or successful service integration. Hosted resource checks remain recorded separately.
