# GitHub Actions KMS migration identity

The production application remains the existing `vm0-kms-prod` IAM user.
GitHub Actions uses a separate OIDC role for ciphertext rewrap. No new access
keys or static operator credentials are required.

## One-time IAM prerequisite

An AWS administrator must provision or reconcile this exact role in account
`251964670836` through the approved IAM change process:

`arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264`

- Reuse the account's `token.actions.githubusercontent.com` OIDC provider if it
  already exists. Its URL is `https://token.actions.githubusercontent.com` and
  its client ID is `sts.amazonaws.com`; create it only if absent.
- Apply [role-trust.json](role-trust.json). Trust is restricted to
  `vm0-ai/vm0` jobs in the protected `production` environment and the STS
  audience. Keep that environment's protected-branch and human-reviewer rules.
  Both migration workflow jobs also require `refs/heads/main`.
- Set the role's maximum session duration to 7,200 seconds and attach
  [role-permissions.json](role-permissions.json) as an inline policy. This
  allows decrypt and bidirectional rewrap only on the two production keys, and
  data-key generation only on the target key for nested queue payloads. Every
  operation requires `purpose=vm0-stored-secret`.
- After the role exists, the owners of the source and target accounts add the
  respective [source](source-key-policy-statement.json) and
  [target](target-key-policy-statement.json) statements to the existing key
  policies. These files are **individual additive statements**, not replacement
  policies. Preserve all current administration, runtime, and rollback grants.
- Set the GitHub `production` environment variable `KMS_MIGRATION_ROLE_ARN` to
  the role ARN above. It is configuration, not a secret.

The IAM setup identity needs role administration only for this named role,
OIDC-provider administration only if the GitHub provider is missing, and
`kms:GetKeyPolicy` / `kms:PutKeyPolicy` on the corresponding production key in
each account. These setup permissions are not granted to the migration role.
The workflows never bootstrap IAM using application credentials and never
add `ReEncrypt` to runtime users.

The currently recorded personal `AWSReservedSSO_KMSMigrationAccess` session is
not a GitHub OIDC identity. Its existence does not prove this role is ready.
Role provisioning is a prerequisite, not an operation performed by these
workflow files. Verify it live before dispatching a production migration.

## Protected execution

1. Run **KMS Production Preflight** on `main` with the current production API
   Vercel deployment ID. Approve its `production` job. It checks the exact
   current target IAM user, loads the old user only from the verified rollback
   backup, proves synthetic forward and rollback reads, and authenticates all
   stored ciphertext using the target runtime user. It creates no role and
   writes no database rows.
2. Verify the deployed API's secret create/read/update and legacy-read business
   flows before approving a mutation. The runtime canary and database scan do
   not by themselves certify deployed application behavior. Retain the evidence
   and exact deployment ID with the operational record.
3. Run **KMS Production Migrate** with that deployment ID, initially with the
   default 1,000-field limit. Each dispatch repeats the full target-runtime
   scan, then obtains a temporary operator session using GitHub OIDC. It
   verifies the exact role with STS and exercises the real migration tool's
   forward and reverse `ReEncrypt` paths on synthetic envelope and legacy
   ciphertext before changing database rows.
4. Review `operation.json`, `verification.json`, and `migration.json` in the
   run's artifact. `complete: false` is a bounded partial migration; the next
   dispatch can use its `cursor`. Conditional writes preserve concurrent user
   changes. Check `concurrentChanges` and scan from the beginning to recover
   rows changed or deleted during a prior batch. A failed or cancelled run can
   have partial writes: inspect its retained checkpoint before resuming.
5. Run **KMS Production Preflight** again without a cursor. Only a fresh,
   complete target-runtime report with `databaseVerifiedOnTarget: true` is the
   final database certificate. A successful bounded migration is not that
   certificate.

The two workflows share a concurrency group and require manual production
approval. Each dispatch uses the existing GitHub production Neon credentials,
the exact `production` branch of `hidden-lab-39609750`, an unpooled connection,
and TLS certificate verification. No agent-side Neon connection is necessary.
The backup digest is pinned in the workflow and the backup's original run/head
provenance is checked before using its configuration. Plaintext credentials,
database URIs, OIDC tokens, and data keys remain in process memory and child
environments; only sanitized metadata and checkpoints enter artifacts.

The expected deployment is checked before verification, before mutation, and
after the operation. A concurrent deployment stops successful certification;
it does not automatically undo completed rows. Keep both keys and both runtime
users' cross-account read access throughout the rollout. These workflows do
not modify deployments, restore stale database snapshots, touch shared staging,
or retire keys, users, retained sandbox state, or backup recovery access.
