# Historical user attribution import

This is the foundation/import phase of [#33452](https://github.com/vm0-ai/vm0/issues/33452).
It copies Clerk-owned user first touch, its existing marketing privacy receipt
reference, and acquisition delivery history into additive database projections.
Clerk remains the serving authority. App and marketing readers, signup writes,
Stripe invoice snapshots, and Google Ads delivery behavior have not switched.

## Deploy the bridge first

1. Deploy the additive schema and API together through the normal API release.
   The existing signed `/api/webhooks/clerk` endpoint now awaits transactional
   imports of `user.created` and `user.updated`; incomplete snapshots or failed
   imports return non-2xx so Clerk can retry. It performs no Clerk directory GET.
2. Verify the actual Clerk webhook subscription includes `user.created`,
   `user.updated`, and `user.deleted` in the matching environment. Code changes
   do not configure provider subscriptions. Confirm delivery of a normal signup
   and a normal marketing delivery-marker update, and inspect failed/retried
   deliveries. Without that evidence the bridge is not ready for cutover.
3. Preserve existing Clerk signup and marketing delivery writes throughout this
   phase. Both produce the same user-update stream. The next consumer PR must
   still account for webhook lag; this projection is not a synchronous outbox
   or an authorization source.

Webhook retries and backfill use the same per-user transaction lock. Full source
observations are fingerprinted and retained, original first touch is not replaced,
and older delivery events cannot erase an accepted receipt. Different existing
touches or equal-version conflicting delivery values require reconciliation.
Absent, captured, invalid, conflict, and deleted states remain distinct; no row
means not imported. A malformed delivery map is preserved as source evidence
and puts the projection in conflict instead of silently losing its contents.

`user.deleted` clears imported payloads/checkpoints and leaves only a tombstone.
Delayed webhooks or already-fetched backfill pages cannot restore deleted data.
The projection does not create local identity rows, change consent, or grant
access. A copied privacy receipt remains a reference to the existing canonical
privacy service; historical attribution is never new consent evidence.

## Preconditions

- Set `DATABASE_URL` to the intended database and `CLERK_SECRET_KEY` to its
  matching Clerk instance. Independently verify the deployment/branch binding;
  the command checks Clerk's `environment_type`, not the database's deployment
  ownership or the secret's string prefix.
- Run from `turbo/packages/db` after installing the locked dependencies.
- Confirm the new tables exist before beginning. No users/organizations are
  filtered by activity, local identity coverage, bans, internal email, or Ads
  eligibility. Provider-deleted identities cannot be reconstructed from Clerk.
- Choose a stable run ID for checkpoints and a private directory for reports.
  Reports contain aggregate counts, not user IDs or raw click payloads. Detailed
  source evidence stays in the restricted application database.

## Dry run, bounded apply, and resume

Dry run is the default and writes no database rows:

```sh
pnpm exec tsx scripts/migrations/015-user-attribution/backfill.ts \
  --environment production --run-id attribution-2026-09 \
  --report ./attribution-dry-run.json --max-users 1000
```

Apply only after reviewing the intended environment and dry-run results:

```sh
pnpm exec tsx scripts/migrations/015-user-attribution/backfill.ts \
  --environment production --run-id attribution-2026-09 \
  --report ./attribution-apply-1.json --migrate --max-users 1000
```

Continue from the report's `nextOffset` with `--start-offset <nextOffset>` and
the same run ID. The offset is a convenience, **not proof of coverage**. Each
committed user has a durable fingerprint checkpoint in the same transaction;
replaying a page is safe. If deletion/insertion shifted the provider's offsets,
restart from zero for the final full catch-up scan.

Defaults: one worker, pages of 100 users, 1 second between provider requests,
at most 1000 users per invocation, 30-second request timeout, and at most four
attempts for HTTP 429/503. `Retry-After` is honored; waits longer than 60 seconds
stop the batch for a later resumption. Options `--page-size` (1–500),
`--delay-ms`, and `--max-users` control the operator's request budget. Keep the
default pace or slower on a shared instance. SIGINT/SIGTERM cancels the scan;
the next invocation can replay its last page.

No operation sends a conversion, rewrites Clerk/Stripe metadata, repairs
campaign ownership, or creates a privacy receipt.

## Full catch-up and verification

Use a reviewed `--max-users` bound large enough for the complete population,
start at zero, and repeat apply to catch changes during earlier pages:

```sh
pnpm exec tsx scripts/migrations/015-user-attribution/backfill.ts \
  --environment production --run-id attribution-2026-09 \
  --report ./attribution-catch-up.json --migrate --max-users 20000

pnpm exec tsx scripts/migrations/015-user-attribution/backfill.ts \
  --environment production --run-id attribution-2026-09 \
  --report ./attribution-verify.json --verify --max-users 20000
```

Verification is read-only and exits unsuccessfully unless a complete pass has
stable before/after Clerk counts, unique ordered users, exact imported first
touch/receipt/version and delivery payload matches, preserved accepted markers,
and no outstanding source conflicts or database-only identities. Newer webhook
state encountered during a scan is reported separately and requires a fresh
pass. Full raw equality also preserves aliases, missing fields, timestamps and
inputs to the unchanged Ads account resolver.

Database-only users/imports are reported separately; never mark them absent
simply because a source is unavailable. Investigate and resolve their identity
or deletion lifecycle through its normal authority before cutover. A stopped
or resumed partial scan can never certify full inventory. An invalid saved
first touch may match exactly and remains invalid; it must not borrow a later
campaign. A conflict cannot be cleared by rerunning the importer.

Verify again after provider retries and older writers have drained. Compare
`inventoryFingerprint` across complete passes to identify source changes, and
review `accountedDeletedUsers` separately from unavailable database-only users.
This comparison is not a transactional snapshot of Clerk, nor evidence that webhook
subscriptions, deployment versions, or rollback gates are ready. Attach the
aggregate reports and live bridge evidence to #33452 before proposing a reader
switch. The issue stays open after this foundation PR.

## Restricted inspection

With a separately provisioned `MARKETING_ATTRIBUTION_API_SECRET` (at least 32
characters), operators can call `POST /api/internal/marketing/attribution/import`
using Bearer authentication and `{ "userId": "..." }`. It returns the import
state, normalized first touch and existing receipt reference, and up to 100
delivery rows; pass `afterTransactionId` from `nextTransactionId` to continue.
The endpoint is `no-store`, unavailable without configuration, and does not
accept a user session as operator authorization. Configure no marketing sender
to use this inspection projection as delivery authorization.

## Rollback and later phases

During this phase all operational readers/writers still use Clerk, so reverting
the API leaves existing behavior intact. Keep the additive data. An older API
may acknowledge user updates without importing them; after restoring the bridge,
repeat a full catch-up and verification rather than assuming webhook replay.

Follow-up PRs must add DB-authoritative capture and reliable Clerk mirroring,
switch all App/API and marketing consumers, preserve current privacy/Impact
behavior, and establish delivery claims and ownership. They may retire Clerk
compatibility only after historical/incremental reconciliation and supported
serving/rollback gates pass. Existing Stripe `gdm_*` receipts stay on their
invoices; this importer does not replay or rewrite them.
