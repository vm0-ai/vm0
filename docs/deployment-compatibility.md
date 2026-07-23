# Deployment Compatibility

This document focuses on three independently deployed surfaces that have
cross-version API or persisted-state compatibility boundaries:

- **Frontend**: browser-delivered web application code.
- **Backend**: API service code in `turbo/apps/api`, plus any intentional
  web-origin rewrites that forward selected `/api/*` paths to the API service.
- **Runner**: long-running runner processes plus the guest binaries shipped
  with that runner.

Other release artifacts, such as the desktop app and host-worker deployments,
have their own release paths and are outside this compatibility model unless
they interact with these frontend, backend, or runner boundaries.

New versions are normally deployed together, but they do not become active at the
same instant. Code and tests must account for short periods where different
surfaces are on different versions.

## Deployment Model

### Frontend

Frontend deployments publish new browser assets, but users who already have an
app page open keep running the JavaScript that page loaded until the page
navigates, refreshes, or the app forces a reload.

The platform app also registers a service worker for static assets, navigation
fallback, and push notifications. The current service worker treats API
requests as network-only, while navigation requests are network-first with a
cached fallback for offline cold-open. Service-worker code is still a browser
resident deployable surface. Changes to service-worker behavior should also
account for old controlled clients during rollout.

The backend must therefore tolerate requests from the previous frontend version
after a backend deployment. When changing an API used by the frontend, keep the
old request shape working until old browser clients can no longer reasonably be
active, or introduce a versioned/new endpoint and migrate the frontend first.

### Backend

The backend is the compatibility boundary for both frontend and runner traffic.
In the production release workflow, app and runner promotion wait for API
promotion when the same release also changes the API. That ordering reduces the
chance of a new frontend or runner talking to an old backend, but it does not
remove cross-version windows: old browser pages can still call the new backend,
old runners keep draining against the new backend, and traffic promotion is not
an atomic process visible to every client at the same instant.

Production database migrations are part of the API release lifecycle and run
before the new API deployment is promoted. Old backend code can therefore
briefly run against the migrated schema. Migrations must be backward-compatible
with the currently deployed backend until that backend is no longer serving
traffic.

This is a traffic-promotion guarantee, not a guarantee that no deployment
preparation has happened yet. Staged Vercel builds, runner rootfs/snapshot
builds, host provisioning, and other non-serving preparation jobs may complete
before migrations run. API traffic promotion must wait until the required
migrations have completed; app and runner promotion also wait for API promotion
when the same release changes the API.

Backend changes must be safe with:

- old frontend -> new backend
- new frontend -> old backend, if traffic propagation or non-production
  deployment order can expose that pairing
- old runner -> new backend
- new runner -> old backend, if traffic propagation or non-production
  deployment order can expose that pairing

### Runner

Runner deployment is draining, not instant. The production promote playbook
starts the new runner service, verifies it, and then sends a soft-drain signal
to old runner services. Before that signal arrives, there can be a short overlap
where both old and new runners are running. After old runners enter draining,
they stop claiming new runs but keep executing already claimed runs until those
runs finish. During that drain window, old runners continue calling backend APIs
with the old protocol.

The backend must support old runner requests until old runners have fully
drained. Runner changes that require backend support must be staged so a new
runner can also survive briefly talking to an old backend.

Runner and guest binaries are deployed as one runner artifact. Compatibility is
not required between a runner binary and a guest binary from a different version.

## What Requires Compatibility

Compatibility is required across deployable boundaries:

- Frontend -> backend API requests and responses.
- Runner -> backend poll, claim, heartbeat, log, artifact, completion, and other
  runner-facing APIs.
- Backend data written by one version and read by another version during a
  rollout.
- Database schema migrations applied before every backend instance is running
  the new code.
- Queue, persisted job payload, and run/session state consumed by runner or
  backend code from different versions.

Compatibility is not required inside one deployed artifact:

- Frontend package-to-package internals inside the same browser build.
- Backend package internals that are deployed as one API build.
- Runner internals shipped in the same runner binary.
- Runner-to-guest binary internals shipped in the same runner artifact.

## Required Change Patterns

Prefer additive changes at cross-version boundaries:

- Add optional request fields before making them required.
- Add response fields without requiring old clients to read them.
- Keep accepting old enum values while old clients can still send them.
- Keep old endpoint paths or add a forwarding/versioned path during migration.
- Make readers tolerant of missing newly added persisted fields.
- Keep migrations additive or otherwise compatible with the old backend during
  the rollout window.
- Write data in a format that the previous deployed reader can ignore or safely
  process during the rollout window.

Avoid one-shot protocol flips:

- Do not require a new request field from frontend or runner in the same PR that
  first adds the client sender.
- Do not remove a response field while old frontend or runner code may still
  read it.
- Do not delete runner-facing endpoints or payload variants until old runners
  have drained in production.
- Do not persist data that the previous backend or runner version cannot parse
  unless the old reader is no longer active before the writer is deployed.

When an incompatible change is unavoidable, split it into phases:

1. **Prepare**: backend accepts both old and new protocol; readers tolerate both
   old and new persisted data.
2. **Migrate**: frontend or runner starts using the new protocol.
3. **Clean up**: remove compatibility logic only after the old deployed version
   is no longer active.

Before a destructive clean-up migration, verify that the replacement version is
healthy and every reader that needs the old schema has drained. After the
cleanup, rolling back to a version that requires the removed schema is unsafe;
recovery must restore compatibility first or roll forward.

Compatibility code should be temporary and explicit. Include a short comment
with the rollout reason and the condition for deletion, or track the cleanup in
a follow-up issue when the deletion cannot happen in the same PR.

## Testing Expectations

Tests should cover cross-version behavior when a change touches a deployment
boundary.

For frontend/backend API changes:

- Test the current request shape.
- Test the previous frontend request shape when the API contract changes.
- Test missing new response fields or old response shapes when frontend code can
  receive them during rollout.

For runner/backend API changes:

- Test old runner requests against the new backend handler.
- Test new runner code with old/missing backend response fields when the runner
  can be deployed before all backend instances are updated.
- Include poll, claim, heartbeat, completion, artifact, and session-resume paths
  when those protocols change.

### Storage mount manifest rollout

The runtime Storage unification uses a receiver-first Runner rollout. New
Runners advertise `storage-mounts-v1` through the existing claim
`capabilities[]` field and accept exactly one of these response shapes:

- canonical `storageMounts`
- legacy `storages` plus `artifacts`

Mixed, incomplete, and representation-free manifests are invalid. The initial
receiver release left backend output unchanged. After that receiver fleet was
deployed, the API began sending `storageMounts` only to a Runner that advertises
the capability; old Runners continue receiving both legacy arrays.

New run, session, and checkpoint writers persist canonical Storage mounts only.
Readers prefer canonical persistence and fall back to legacy columns for
historical rows. Legacy API response shapes are projected from canonical mounts
for new rows. Explicit legacy checkpoint overrides remain on the compatibility
reader because canonical mounts intentionally do not retain the old
compose-volume versus additional-volume distinction. The short-lived runner job
queue also retains its legacy claim projection until old Runner output is
removed.

Remove the legacy columns and readers only after historical rows have been
backfilled and verification finds zero legacy writes, zero unmigrated rows, and
no lossy conversion.

Runner and guest binaries ship together, so the Runner-to-guest manifest uses
the canonical shape immediately while the guest reader temporarily accepts both
representations. Remove the legacy readers and the capability only after the
canonical API output has been stable across the fully upgraded Runner fleet.

### Codex rollout path resume

Codex resume snapshots may include an optional `codexRolloutPath`. The guest
only sends this field after checkpoint history preparation returns
`acceptsCodexRolloutPath: true`, so a new runner artifact can still checkpoint
against an old backend. The API stores the field in a nullable conversation
column and only includes it in a claim response when the runner advertises
`codex-rollout-path-v1`; old runners continue receiving the previous resume
shape.

The persisted value is the canonical logical path relative to
`~/.codex/sessions` and ends in `.jsonl`. A zstd history blob is restored to the
same path with the physical `.zst` sibling suffix (`.jsonl.zst`). Runner
validation binds the relative path to the Codex thread id before using it.

For a historical row without path metadata, verified warm-sandbox reuse keeps
the existing rollout at its original path. If that state cannot be verified,
including on a cold sandbox, the runner retains the deterministic UTC
timestamp-based fallback and does not guess from the current timezone.
Workspace sidecars cache verified history bytes rather than placement metadata;
a hit is materialized at the current request's independently validated path.

### Firewall hostname policy

The backend is the single owner of firewall configuration hostname policy.
Generated firewall definitions must already contain canonical lowercase ASCII
hostname literals; catalog tests enforce that invariant, and dispatch forwards
those static definitions without rewriting them. The backend converts rendered
custom connector hostnames and hostname-bearing built-in variable values to the
same canonical identity before putting them into existing runner payload
fields. Raw custom connector definitions and encrypted variable values remain
unchanged in storage.

Runner validation remains unchanged and fail closed. It defensively validates
configuration received from old and new backends, resolved credential-bearing
targets, and untrusted request authorities. The fixed backend policy must emit
only canonical ASCII identities accepted unchanged by draining old runners; a
policy upgrade requires deliberate compatibility analysis before deployment.

A fully dynamic secret-backed `auth.base` remains runner-validated because the
existing auth request has no policy/capability marker that can distinguish old
and new runs. Changing that path requires an explicit backward-compatible
protocol design rather than silently tightening old in-flight runs.

For persisted state changes:

- Test reading rows or payloads written by the previous version.
- Test old backend behavior against the migrated schema when the migration runs
  before code promotion.
- Test that new writes do not break the previous deployed reader during the
  rollout window, or document why the old reader cannot observe the new data.

### Connector credential ownership contraction

The final connector credential ownership contraction may run only after every
active and rollback-eligible API version writes a positive storage version,
and assigns each connector credential to its stable connector id. Drain older
API instances that lack either guarantee, then require the protected production
readiness counts to be zero before applying the migration.

The contraction reruns its immutable reconciliation and validates aggregate
invariant counts in the same transaction as the hard constraints. An unresolved
row aborts the migration without retaining reconciliation changes; remediate
the data and retry. After success, connector storage versions are required,
connector credential ownership is exact, and deleting a connector cascades to
its owned secrets and variables so cleanup remains atomic across every deletion
path. Application disconnect and replacement flows still delete owned
credentials explicitly; the cascade is the final data-integrity guarantee, not
a replacement for domain cleanup or provider revocation.

After contraction, do not roll back directly to an API version that lacks the
required write guarantees. Recovery must roll forward or restore the nullable
schema before promoting that older API.

Do not add broad defensive fallbacks just to hide incompatibility. The goal is a
specific compatibility contract for the rollout window, with clear deletion
criteria after the old version is gone.
