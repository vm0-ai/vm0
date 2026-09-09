# Historical public artifact registration (#32492)

Register existing public file keys, site aliases and immutable deployment URLs
without moving bytes, changing old URLs or modifying ownership. The script only
writes `artifact-delivery/` JSON records to the hosted-sites bucket. Existing
Public records must match exactly; private/revoked/publication records are never
overwritten. Database access is read-only. The script freezes its v1 format and
has no runtime imports from application contracts or ORM schema modules.

## Before running

Deploy the App/API reference readers, compatible CLI consumers, the API's
public registration writers and the compatible host Worker before enabling
`privateArtifacts`. Existing authenticated API references remain readable for
persisted messages; new private writes return hostless references.

Pre-registry organization and `sh-` Public links also remain readable. Reading
their share status preserves the working legacy URL without writing metadata;
an explicit publication update adopts the registry format. These readers remain
until #32492 accounts for every retained pre-registry share link. The historical
Public inventory below does not rewrite existing share policies.

Drain earlier API writers before finalizing registration. Registration hooks
on existing public writes run regardless of the switch so rollback cannot create
unregistered sites; they add a hosted-bucket metadata write without changing
those public URLs or permissions. Use the same
`privateArtifacts` rollout switch for new artifact behavior; there is no second
feature switch. The R2 completion marker records a completed data migration.
After finalization, API binary rollbacks must retain these registration writers;
turning the shared feature switch off remains supported.

Set `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_USER_ARTIFACTS_BUCKET_NAME`,
`R2_USER_ARTIFACTS_ACCESS_KEY_ID`, `R2_USER_ARTIFACTS_SECRET_ACCESS_KEY`,
`R2_HOSTED_SITES_BUCKET_NAME`, `R2_HOSTED_SITES_ACCESS_KEY_ID`, and
`R2_HOSTED_SITES_SECRET_ACCESS_KEY` in the execution environment. Do not pass
credentials as arguments. Public-bucket credentials need object read/list;
hosted-bucket credentials need read/list and, only for migration, object write.
Never point this inventory at the private-artifact bucket.

## Commands

Run from `turbo/packages/db`:

```bash
# Default: two read-only inventories, DB reconciliation and conflict report.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --report inventory.json

# Register missing Public metadata and verify each record immediately.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --migrate --verify --report registered.json

# Independent read-only verification after registration.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --verify --report verified.json

# After old writers drain and coverage is reconciled, close legacy lookup.
pnpm exec tsx scripts/migrations/014-public-artifact-registration/backfill.ts --migrate --verify --finalize --report finalized.json
```

`--migrate` always performs exact read-back; `--verify` also permits independent
read-only verification.

Every pass is paginated and limited to 100,000 objects per bucket by default;
`--max-objects` can explicitly raise that bound. Truncation, changing inventories,
missing manifests, deleted/unready DB deployments, conflicting aliases and
private metadata block finalization. Rerun after concurrent writes settle; writes
are conditional and restartable. Every existing alias is checked for conflicts
before the first write. A blocked `--report` includes the complete conflicting
alias-key inventory; successful reports contain counts and an inventory digest.
Reports never include credentials or artifact contents. Unclassified file keys must be
reconciled before finalization rather than silently treated as Public.

Historical brandless metadata retains its existing VM0 interpretation. Old site
aliases continue to follow the same mutable active pointer; deployment URLs stay
pinned. The completion marker makes unregistered site aliases unavailable.
Keep it after feature-switch rollback: already-established permissions remain
enforced. Follow-up #32492 removes the pre-registration compatibility reader
after complete production coverage and the old-writer drain are verified.

Old `a.okou.io` and `cdn.*` domains keep their direct public storage behavior.
Registration does not revoke those URLs or already-cached bytes. New public file
shares use `f.okou.io` and policy-checked private storage. New site shares use an
opaque subdomain on `okou.app`, with no visible version prefix.

Before enabling Public file sharing, create a proxied DNS record for `f.okou.io`
in the VM0 Cloudflare account and deploy the reviewed `f.okou.io/*` Worker route
with both public/private bucket bindings. Do not repoint `a.okou.io` or attach a
public domain to the private bucket. Staging uses `files.sites.vm7.io` on the
existing test wildcard. API public-file URL configuration must match that Worker
host. Immutable alias metadata uses a separate edge cache; the mutable share
policy is read from R2 before every content-cache hit. The warm path adds no
API/primary-DB hop or repeated alias lookup. Missing aliases are not cached, so
a newly published URL is immediately discoverable. File aliases use one global
namespace across both brands to prevent ownership collisions on `f.okou.io`.
Measure regional cold/warm latency before production activation. Byte-range
requests use R2 range reads after authorization. Previously issued signed
previews expire within 15 minutes.

This PR does not execute production registration, deploy Workers/DNS or enable
the production feature switch.
