# Chat Event schema versioning

Snapshot NDJSON rows and Raw Chat Event API rows are two representations of
the same Chat Event schema. Clients select that schema with
`X-Chat-Event-Schema-Version` on both read endpoints, and successful responses
echo the selected version in the same header.

Platform and CLI readers require that echoed header and require Snapshot
responses to include the paired `lastEventId`; they do not reconstruct missing
response metadata from the immutable NDJSON body.

## Version negotiation

- The current and only supported version is V7. The request header is required.
- A malformed version returns `400 CHAT_EVENT_SCHEMA_VERSION_INVALID`.
- A version below the current version returns
  `426 CHAT_EVENT_SCHEMA_VERSION_RETIRED` so the client can force an upgrade.
- A version newer than the API returns
  `409 CHAT_EVENT_SCHEMA_VERSION_AHEAD`.

Raw Events are read from the current database schema and returned in V7. The
API does not downgrade rows or Snapshot objects to retired versions.

### Optional V7 failure reasons

V7 `run.failed` readers accept an optional `failureReason` field and continue
to accept historical rows that omit it. Other event types reject the field.

Because existing V7 readers are strict, adding the optional field uses a
reader-first rollout even though the version number does not change:

1. Deploy the tolerant contract to every API, app, CLI, and persisted-history
   reader while all writers continue to omit the field.
2. Wait until previous app bundles, commit-addressed CLI artifacts, serving and
   rollback APIs, and other strict V7 readers have drained or are blocked by an
   enforced compatibility floor.
3. Enable writers in a later release.

The reader preparation does not change Snapshot pointers, client cache
versions, or persisted database rows. A V7 cache can therefore contain both
historical reasonless failures and later failures with a reason once writer
activation is safe.

## Snapshot storage and reads

The API owns exactly one canonical pointer per
`(chat_thread_id, archive_schema_version)`, enforced by a unique database
index. Readers select the current-version pointer directly.

The pointer contains the immutable, content-addressed R2 object key and a
paired `{lastEventId, lastSeqId}` terminal cursor. `last_event_id` is required.
Snapshot pointers have no parent or head identity columns.

Snapshot reads persist and return the current-version pointer. A request cannot
fall back to a stored retired-version pointer when the current pointer is
unavailable.

## Snapshot upgrade invariant

Only the first Snapshot for a thread may bootstrap from the currently available
Raw Event prefix. Sequence positions may start above 1 and contain gaps. Once
any Snapshot exists, every refresh or schema upgrade must:

1. Download and validate the stored Snapshot object.
2. Run the adjacent Snapshot migration chain on that historical prefix.
3. Read only Raw Events after the stored paired cursor.
4. Append that tail, upload a new immutable object, then publish its database
   pointer with an exact compare-and-swap.

A missing object, invalid Snapshot, missing migration, or missing historical
prefix fails closed. It must never authorize a full Raw Event rebuild because
older Raw Events may already have been reclaimed.

Future Chat Event schema bumps must include every required adjacent Snapshot
migration before release; if an old version is not migratable, all pointers
relying on it must first converge to a migratable version.

## Browser cache

The IndexedDB database version combines a cache-layout base version with the
requested Chat Event schema version. Any IndexedDB version change deletes and
recreates all Chat Event cache stores. The cache cursor stores the schema
version and paired event/sequence boundary, and row-plus-cursor writes are
atomic.

Raw Event retention and orphaned R2 object collection policy are outside this
change. The invariant above makes later Raw Event reclamation safe without
adding retention behavior here.
