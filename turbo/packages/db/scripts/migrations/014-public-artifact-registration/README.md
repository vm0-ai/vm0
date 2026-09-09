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

Deploy incremental registration first while `privateArtifacts` stays off. Every
public file write, immutable write, presigned PUT and multipart initiation must
successfully reserve its exact registry metadata before exposing bytes or upload
credentials. Registration failure fails the upload/generation request. Upload
completion registration remains a backstop for credentials issued by older API
instances. Site aliases register before their public pointers are published.
These hooks run regardless of the switch.

Drain earlier API writers and their already-issued upload credentials before
accepting final coverage; current public PUT credentials last up to one hour.
Multipart completion can outlive those signatures. The migration also inventories
all pending public multipart uploads, including their pagination, before its final
object scan. An old session without a valid public registration blocks verified
coverage until it completes or expires in storage; newly pre-registered sessions
can continue. The report includes pending and unregistered multipart counts.
Run an independent verification after this drain. API binary rollback must
retain incremental registration. Use the same
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
`--max-objects` can explicitly raise that bound. Production already exceeds this
default. R2 operations use bounded concurrency (default 16; `--concurrency` accepts
1–64) and drain in-flight work before reporting failure.

The final pass re-inventories storage, reconciles the database again, and reads
every registry record. Concurrent additions are accepted only when their exact
registration already exists. Missing registrations, unknown keys, incomplete
pagination, missing manifests, deleted/unready DB deployments, conflicting aliases
and private metadata block verification. Conditional writes are restartable; a
retry fills missing records without overwriting existing ones. Every existing alias is checked for conflicts
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

The 2026-09-09 public inventory also contains legacy `html-edit-drafts/<uuid>.html`
objects and 29 Desktop recording sidecars without R2 Content-Type. Drafts undergo
the same private-metadata and authoritative-database checks as all public files.
Missing HTTP metadata first uses an exact existing public registration or a
unique non-null `run_uploaded_files.content_type`. Desktop recorder uploads can
have neither: the old Blob PUT omitted Content-Type, and the DB row is created
only when the recording is attached to chat. For the recorder's exact filename
and storage-key patterns, the migration can recover `application/json` by reading
at most 1 MiB with the HEAD ETag as an `If-Match` condition and verifying the byte
length, UTF-8 JSON and frozen v1 recording signature. A changed object, invalid
JSON, unknown format or oversized body blocks the pass before any registration.
This is limited to the migration; ordinary missing MIME types still fail.
Pre-registration also covers an uploaded object whose
client has not called completion yet. Existing upload headers/signature semantics
remain compatible with already-deployed App, CLI and Desktop clients. This
persisted-data compatibility is owned by #32492 and can be retired when historical
delivery no longer requires this migration. No MIME type is inferred from a file
extension alone, and no source object is rewritten. The read-only audit of all 29
historical sidecars found matching v1 JSON bodies (269–54,078 bytes); both older
click-only records and later optional pointer/typing fields are recognized.

## Production phases

1. Release incremental registration with `privateArtifacts` off. Keep `a.okou.io`
   on its current public R2 path, including its existing Cloudflare cache and image
   transformations. No Worker route or cache-rule changes belong to this phase.
2. Run the protected **Public Artifact Registration** GitHub Action on `main`: first
   `dry-run`, then `migrate`, then an independent `verify` after the old-writer and
   upload-credential drain. It uses production R2 credentials and read-only Neon
   queries, saves the report as a GitHub artifact, and never passes `--finalize`.
   Accept coverage only with zero missing, conflicting or unclassified records
   and zero unregistered pending multipart uploads.
3. Review the separate `a.okou.io` delivery cutover (#32959) after coverage is
   complete. The planned unified host serves old registered public files and new
   opaque public-share aliases through `zero-host-worker`. Existing URLs and old
   public thumbnail behavior must remain compatible. New shares require policy
   checks before any byte-cache hit; global public cache overrides and prefix
   rewrites must be scoped for those routes as part of that later cutover.
4. Finalize registration and enable new private artifact behavior only as separate
   rollout decisions. Completion markers close the legacy site fallback, so they
   are intentionally excluded from the first production phase.

The unlaunched `f.okou.io` domain is retired; it is not a rollout prerequisite.
The current API/Worker file-share host configuration is changed by #32959, not by
this registration rollout. Private preview URL lifetime and renewal are tracked
separately in #32977; image derivatives and private video/HTML previews remain
follow-ups in #32492.
