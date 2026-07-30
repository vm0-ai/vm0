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

The platform app also registers a service worker. Service-worker code is a
browser-resident deployable surface, so changes to its behavior must account for
old controlled clients during rollout.

The backend must therefore tolerate requests from the previous frontend version
after a backend deployment. When changing an API used by the frontend, keep the
old request shape working until old browser clients can no longer reasonably be
active, or introduce a versioned/new endpoint and migrate the frontend first.

### Backend

The backend is the compatibility boundary for both frontend and runner traffic.
In the production release workflow, app promotion starts after the API
production lifecycle completes, including any required migration and API
traffic promotion. Newly loaded frontend code therefore follows API promotion,
while already-open browser pages can keep running the previous frontend against
the new backend. Runner promotion still waits for API promotion when the same
release also changes the API. Old runners keep draining against the new backend,
and traffic promotion is not an atomic process visible to every client at the
same instant.

Production database migrations are part of the API release lifecycle and run
before the new API deployment is promoted. Old backend code can therefore
briefly run against the migrated schema. Migrations must be backward-compatible
with the currently deployed backend until that backend is no longer serving
traffic.

This is a traffic-promotion guarantee, not a guarantee that no deployment
preparation has happened yet. Staged Vercel builds, runner rootfs/snapshot
builds, host provisioning, and other non-serving preparation jobs may complete
before migrations run. API traffic promotion must wait until the required
migrations have completed. App promotion waits for the API production lifecycle,
including its migration and traffic promotion. Runner promotion waits for API
promotion when the same release changes the API.

Backend changes must be safe with:

- old frontend -> new backend
- new frontend -> old backend
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

### Korean locale rollout

The `ko-KR` locale uses a receiver-first rollout because Platform and API
promotion are independent and locale preferences are shared persisted state:

1. Deploy the API and Platform receivers with
   `KOREAN_LOCALE_ROLLOUT_ENABLED=false`. The API accepts stored `ko-KR`
   preferences but projects them to `en-US` when the deploy gate or client
   capability is absent. Locale-capable clients receive a `supportedLocales`
   handshake, and `ko-KR` appears only for clients carrying the
   `ko-kr-locale-v1` capability.
2. Confirm that API readers and rollback candidates which cannot safely parse a
   stored `ko-KR` preference have drained.
3. Enable `KOREAN_LOCALE_ROLLOUT_ENABLED`. The corresponding `KoreanLocale`
   switch is API-controlled and cannot be enabled through user feature-switch
   overrides. Capable clients can then see `ko-KR` in `supportedLocales` and
   persist it.
4. To roll back, disable `KOREAN_LOCALE_ROLLOUT_ENABLED` before promoting an
   older API. This stops new `ko-KR` writes and projects existing preferences
   to English while rollback completes.
5. Remove the projection, capability handshake, and deploy gate only after
   stale browser clients and rollback windows have closed.

### German locale rollout

The `de-DE` locale transition uses a receiver-first rollout because Platform
and API promotion are independent and locale preferences are shared persisted
state:

1. Deploy API and Platform receivers while
   `GERMAN_LOCALE_ROLLOUT_ENABLED` remains disabled in production. The API
   projects stored `de-DE` preferences to `en-US` for incompatible clients and
   advertises German only to clients carrying the `de-de-locale-v1`
   capability.
2. Verify that every API reader which rejects stored `de-DE` values, including
   rollback candidates, has drained.
3. Enable `GERMAN_LOCALE_ROLLOUT_ENABLED`. The corresponding `GermanLocale`
   feature switch is API-controlled and cannot be set through user overrides.
   A capable API then advertises `de-DE`, and Platform exposes the language
   selector only after receiving that handshake.
4. Remove the old-client response projection, capability handshake, and rollout
   switch only after stale browser clients and rollback windows have closed.

Do not enable German preference writes during step 1. A stored `de-DE` value is
not readable by the API release that preceded this receiver change.

### Treat Deploy-before-migrate Windows as a First-class Risk

Schema changes have two independent compatibility directions:

- **Old code after migration**: the migration has changed the schema while
  previous API instances are still serving or draining. Every statement the old
  API can issue must remain legal, including columns that an ORM adds to
  `SELECT` or `RETURNING` lists even when application logic does not otherwise
  read them.
- **New code before migration**: the new API is serving before the migration is
  visible to it. New readers and writers must not require the new column, enum
  value, relation, constraint, or function until the migration is complete.

The production workflow must continue to order required migrations before API
traffic promotion, but intended ordering is not a substitute for compatibility.
Promotion drift, rollback, draining instances, and other environments can expose
either direction. A compatibility object that protects old code after migration
does not by itself protect new code before migration.

The ChatEvent schema-contraction releases from July 27-29, 2026 provide concrete
examples:

- [PR #23148](https://github.com/vm0-ai/vm0/pull/23148), migration `0697`,
  added `event_type`. From about 09:11 to 10:52 UTC on July 27 (102 minutes),
  new App reads, crons, and the automation poller queried it before the migration
  ran and received PostgreSQL error `42703` (`column does not exist`). An
  additive column still breaks a new reader when code wins the race.
- The [PR #23252](https://github.com/vm0-ai/vm0/pull/23252)-era migration
  `0700` added the `teams_user_message` enum value. From about 00:38 to 00:47 UTC
  on July 28 (10 minutes), new code used the value before the migration ran and
  received `22P02` (`invalid input value for enum`), including a 57% failure
  spike on `/chat-threads/:threadId/events`. Enum additions are schema changes,
  not data changes.
- [PR #23656](https://github.com/vm0-ai/vm0/pull/23656), migration `0722`,
  dropped `chat_messages.role`. From about 06:55 to 06:57 UTC on July 29 (two
  minutes), the draining previous API still included the declared column in
  `INSERT ... RETURNING` and received `42703`. Read-never and write-never are
  insufficient while the old ORM schema can still generate the column name.
- [PR #23451](https://github.com/vm0-ai/vm0/pull/23451), migration `0714`,
  at 12:42 UTC on July 28 and
  [PR #23741](https://github.com/vm0-ai/vm0/pull/23741), migration `0725`, at
  09:34 UTC on July 29 produced zero-incident releases. They used in-place
  renames with same-name auto-updatable compatibility views, including column
  aliasing in `0725`. Temporary no-op or mirror triggers from `0714` and
  [PR #23594](https://github.com/vm0-ai/vm0/pull/23594), migration `0719`, kept
  both versions' statements legal during the transition.
- [PR #23696](https://github.com/vm0-ai/vm0/pull/23696), migration `0723`,
  renamed the table. Its compatibility view protected old code after migration,
  but new crons queried `chat_events` before migration from about 08:42 to 08:53
  UTC on July 29 (12 minutes) and received `42P01` (`relation does not exist`).
  User chat routes remained clean. Migration-before-promotion ordering, or
  explicitly tolerant new code, is still required for the other direction.

Persisted database objects are also consumers of table names: PL/pgSQL
functions, triggers, and column defaults can retain references that no source
scan will find, so query the PostgreSQL catalogs before contracting a schema.
[PR #23816](https://github.com/vm0-ai/vm0/pull/23816) had to retarget
`queue_artifact_catalog_file()` in migration `0736`, while
[PR #23858](https://github.com/vm0-ai/vm0/pull/23858) demonstrates the broader
catalog audit required before removing a compatibility relation.

Use one of the following proven schema-transition patterns. Keep each
compatibility layer only until the release it protects has fully drained.

#### Nullable Transition Column, Then Backfill and Contract

**When to use:** A new required field must be populated for existing rows. Add
the nullable column before any code requires it, backfill it in a later release,
and add the constraint only after both old and new writers populate it. The
`0697` -> `0698` -> `0701` sequence followed these three phases; the `0697`
incident also shows why new readers cannot precede the first migration.

```sql
-- Release 1: expand.
ALTER TABLE messages ADD COLUMN event_type text;

-- Release 2: backfill while the column remains nullable.
UPDATE messages
SET event_type = 'message'
WHERE event_type IS NULL;

-- Release 3: contract after every writer supplies the value.
ALTER TABLE messages ALTER COLUMN event_type SET NOT NULL;
```

#### Drop a Column as a Two-release Contract

**When to use:** A physical column is no longer needed. In the first release,
remove it from the ORM schema declaration and from every explicit reader and
writer. Wait for the preceding API version to drain. Only a later release may
drop the physical column. Migration `0722` violated this rule because the
previous Drizzle declaration still changed the generated `RETURNING` shape.

```sql
-- Release 1 changes code only; the physical column remains.

-- Release 2, after the previous API has drained:
ALTER TABLE messages DROP COLUMN legacy_role;
```

#### Rename in Place and Preserve the Old Name with a View

**When to use:** A table or column needs a canonical name while old API
instances still use the old name. Rename the base object in place and create a
simple same-name view over it in the same migration. A single-table view with
direct column references remains auto-updatable; aliases can expose old column
names. Drop the view in a later release after old code drains. Migrations `0723`
and `0725` used this pattern.

```sql
ALTER TABLE old_messages RENAME TO messages;

CREATE VIEW old_messages AS
SELECT
  id,
  event_type AS legacy_type
FROM messages;

-- A later release, after old code drains:
DROP VIEW old_messages;
```

This pattern protects old code after migration. It does not make `messages`
exist for new code before the rename migration, so migration ordering or a
separate new-code fallback must protect that direction.

#### Build Temporary Compatibility Objects in the Migration

**When to use:** The outgoing release issues a narrow statement that a normal
rename view cannot satisfy, or temporarily writes both the legacy and canonical
shape. Create the smallest trigger or zero-row view that preserves that exact
statement. Mirror triggers can keep transition columns synchronized; a zero-row
view plus an `INSTEAD OF` trigger can retain a retired write target without
persisting the obsolete row. Migrations `0714` and `0719` used temporary no-op
and mirror triggers.

```sql
CREATE FUNCTION mirror_legacy_type() RETURNS trigger AS $$
BEGIN
  NEW.event_type := COALESCE(NEW.event_type, NEW.legacy_type);
  NEW.legacy_type := COALESCE(NEW.legacy_type, NEW.event_type);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mirror_legacy_type
BEFORE INSERT OR UPDATE ON messages
FOR EACH ROW EXECUTE FUNCTION mirror_legacy_type();

CREATE VIEW retired_messages AS
SELECT id FROM messages WHERE false;

CREATE FUNCTION ignore_retired_message() RETURNS trigger AS $$
BEGIN
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ignore_retired_message
INSTEAD OF INSERT ON retired_messages
FOR EACH ROW EXECUTE FUNCTION ignore_retired_message();
```

These objects are contracts, not generic fallbacks. Verify the exact outgoing
SQL against them, record the release they protect, and remove the functions,
triggers, and views after that release drains.

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

For persisted state changes:

- Test reading rows or payloads written by the previous version.
- Test old backend behavior against the migrated schema when the migration runs
  before code promotion.
- Populate the pre-migration schema, upgrade it, and exercise the previous API's
  real statement shapes through every compatibility view or trigger. Include
  `INSERT ... RETURNING` and `INSERT ... ON CONFLICT` paths, plus ORM-generated
  column lists; testing only handwritten reads missed the `0722` failure mode.
- Test that new writes do not break the previous deployed reader during the
  rollout window, or document why the old reader cannot observe the new data.

Do not add broad defensive fallbacks just to hide incompatibility. The goal is a
specific compatibility contract for the rollout window, with clear deletion
criteria after the old version is gone.
