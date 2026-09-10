# Target AWS audit setup for issue 32264

The production KMS backfill is complete. This operation establishes equivalent
CloudTrail and AWS Config recording in account `251964670836`, with home region
`us-west-2`, before the source audit services can be retired.

## Resources and retention

| Resource                             | Target                                         |
| ------------------------------------ | ---------------------------------------------- |
| Multi-region management-event trail  | `vm0-drata-cloudtrail`                         |
| CloudTrail bucket                    | `vm0-cloudtrail-logs-251964670836-us-west-2`   |
| Config recorder and delivery channel | `default`                                      |
| Config service role                  | `vm0-dcf478-config-recorder-role`              |
| Config bucket                        | `vm0-dcf478-aws-config-251964670836-us-west-2` |

The trail includes read and write management events and global service events,
with log validation enabled. Config continuously records all supported resource
types, including global IAM resources, and requests a daily snapshot.

Both buckets use SSE-S3, enforced bucket ownership, all four public-access
blocks, versioning, HTTPS enforcement, and service delivery policies restricted
to the target account/trail. Logs and noncurrent object versions do not expire.
The only lifecycle rule removes incomplete multipart uploads after seven days;
it does not delete delivered audit records. The operation does not introduce a
dependency on either production KMS key or enable irreversible Object Lock.

Historical source-account logs remain in their original buckets. Their retention
or copy decision, backup restore dependencies, and the source-account retirement
decision remain separate acceptance items.

## Existing Actions identity

Reuse `arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264` and its
existing GitHub OIDC provider and `production` environment trust. No credentials,
OIDC providers, role trust, KMS policy, or deployment secrets are replaced.

Attach the exact [audit permissions](../.github/aws-audit-32264/operator-permissions.json)
as a separate inline policy named `audit-target-setup-32264`. Preserve the existing
KMS migration inline policy. This additional policy grants only the two target
audit buckets, target trail, and Config service-role setup, plus the required
regional Config APIs and bucket inventory. It grants no KMS operations or deletion.

The bootstrap caller needs the scoped [bootstrap permissions](../.github/aws-audit-32264/bootstrap-permissions.json).
The expected existing trust is recorded in
[operator-trust.json](../.github/aws-audit-32264/operator-trust.json) for read-only
comparison, not replacement. The Config service role uses AWS's `AWS_ConfigRole`
read policy plus a delivery policy limited to its audit bucket.

## Execution and verification

After the PR is merged, dispatch **AWS Audit Target Setup** on `main`. The job
requires the existing protected `production` environment approval, assumes the
existing Actions role using a one-hour OIDC session, and verifies its exact
account and role before configuring resources. SDK credentials stay in memory.
The OIDC request accepts only the GitHub Actions HTTPS origin and rejects
redirects before requesting AWS credentials.

Existing resources must match their expected identity and configuration. A
conflicting bucket, role, channel, or trail stops the job; it does not overwrite
unrelated configuration. Partially configured buckets fail closed on rerun and
need their recorded partial state reviewed before continuing. Newly propagated
service policies have a bounded retry window; permission denials remain errors.

The job waits up to 25 minutes for actual delivered evidence:

1. A read-only `GetTrailStatus` canary appears in a new S3 CloudTrail object,
   matched by its exact AWS request ID and target account/region.
2. Config discovers both new audit buckets and delivers a newly requested
   snapshot containing their configuration items to the target Config bucket.
3. The recorder and snapshot delivery report success, and the trail remains
   logging without a delivery error.

The artifact `aws-audit-target-<run>-<attempt>` contains a sanitized JSON report
with resource names, request/snapshot IDs, object keys, counts, and verification
results. It contains no object bodies, configuration payloads, or credentials.
A timeout or provider error fails the job and retains the incomplete report.
Created resources remain available for diagnosis; there is no automatic deletion.
Snapshot verification uses the S3 export schema (`fileVersion`, `configSnapshotId`,
and item `awsAccountId`) documented in the
[AWS Config/Athena example](https://aws.amazon.com/blogs/mt/how-to-query-your-aws-resource-configuration-states-using-aws-config-and-amazon-athena/),
with the snapshot ID matched against the actual object filename.

Source CloudTrail, Config, KMS, historical buckets, database backfill, application
deployments, and backup settings are outside this workflow's write scope.
Successful target delivery does not by itself authorize their retirement.

## Local verification

Run `.github/scripts/tests/aws-audit-target-setup-test.sh` for SDK-boundary tests.
They check the production-entry guard, wrong-account and access-denied behavior,
and actual delivered-object evidence including unrelated events, wrong-account
snapshots, missing bucket items, and sensitive payload exclusion. The repository
workflow-script test job also discovers and runs this test.
