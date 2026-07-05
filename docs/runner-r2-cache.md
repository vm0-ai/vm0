# Runner R2 Cache

Runner rootfs/template cache objects live in the dedicated
`R2_RUNNER_CACHE_BUCKET_NAME` bucket. User storage remains separate and
continues to use `R2_USER_STORAGES_BUCKET_NAME`.

Normal `runner gc` is host-local. It removes unused local images, workspaces,
locks, logs, and storage archive cache entries; it does not list or delete R2
objects. Completed runner R2 cache objects are expired by Cloudflare R2
lifecycle rules instead.

## Lifecycle Rules

The repo-owned lifecycle configuration is
[`scripts/runner-r2-cache-lifecycle.json`](../scripts/runner-r2-cache-lifecycle.json).
It expires both disposable runner cache prefixes after 7 days:

- `runner-images/`
- `runner-templates/`

Apply it with an operator token that has Cloudflare Workers R2 Storage Write
permission:

```bash
R2_RUNNER_CACHE_BUCKET_NAME=vm0-runner-cache \
  scripts/apply-runner-r2-cache-lifecycle.sh
```

For jurisdiction-specific buckets, pass `R2_JURISDICTION`.

```bash
R2_RUNNER_CACHE_BUCKET_NAME=vm0-runner-cache \
R2_JURISDICTION=eu \
  scripts/apply-runner-r2-cache-lifecycle.sh
```

The apply script uses `npx --yes wrangler` by default. Set `WRANGLER_BIN` to use
an already-installed Wrangler binary.

Cloudflare applies lifecycle deletes asynchronously. Do not expect deploy-time
deleted object counts or exact freed bytes from `runner gc`.

## Manual Fallback

If lifecycle rollout fails or an emergency one-off cleanup is needed, use the
explicit R2 cleanup command:

```bash
R2_ACCOUNT_ID=... \
R2_ACCESS_KEY_ID=... \
R2_SECRET_ACCESS_KEY=... \
R2_RUNNER_CACHE_BUCKET_NAME=vm0-runner-cache \
  runner r2-cache gc --keep-days 7
```

Use `--dry-run` only to verify command wiring and R2 configuration. It does not
list R2 objects or produce delete candidates.

## Rollback

To roll back lifecycle expiration, remove or disable the lifecycle rules from
the Cloudflare dashboard or apply a replacement lifecycle configuration without
the runner cache expiration rules. Host-local `runner gc` behavior is unchanged.

If legacy runner cache objects still exist in the old user-storage bucket under
`runner-images/` or `runner-templates/`, clean them with a one-time operator
process after verifying those prefixes contain only disposable runner cache
objects.

## Operator Check

After applying lifecycle rules, periodically check the dedicated runner cache
bucket:

- object count under `runner-images/`;
- oldest object age under `runner-images/`;
- object count under `runner-templates/`;
- oldest object age under `runner-templates/`.

Objects older than the lifecycle age may remain briefly because lifecycle
expiration is asynchronous. Sustained growth or very old objects indicates that
the lifecycle configuration or permissions should be checked.
