# Chat Event schema versioning

Snapshot NDJSON rows and Raw Chat Event API rows are two representations of
the same versioned schema. Clients select that schema with
`X-Chat-Event-Schema-Version` on both read endpoints. Every successful or
expected-miss response echoes the selected version in the same header.

Platform and CLI readers require the echoed header and require Snapshot
responses to include the paired `lastEventId`. They never reconstruct missing
response metadata from the immutable NDJSON body.

## Supported versions

V8 is current and V7 is the one bounded previous version supported during the
rollout bridge.

- A malformed version returns `400 CHAT_EVENT_SCHEMA_VERSION_INVALID`.
- A version below V7 returns `426 CHAT_EVENT_SCHEMA_VERSION_RETIRED`.
- A version above V8 returns `409 CHAT_EVENT_SCHEMA_VERSION_AHEAD`.
- V7 and V8 requests are served in the exact requested version.

V8 adds the optional `failureReason` field to `run.failed` rows and projected
events. V7 output removes that field and preserves every other canonical row
field. Historical reasonless failures remain valid V8 rows, and no other event
type may contain the field.

New clients request V8 first. They retry V7 only when the API returns the
specific V8 `AHEAD` response, which permits a new client to run briefly against
the previous API during traffic promotion.

## Snapshot storage and publication

The API owns one canonical pointer per
`(chat_thread_id, archive_schema_version)`, enforced by a unique database
index. During the V8 bridge, the Snapshot writer maintains both V8 and V7
pointers:

- V8 objects use the `r2` object-key contract revision.
- V7 objects retain the `r1` object-key contract revision.
- Both objects represent one physical coverage boundary and paired terminal
  cursor.

For each refresh, the writer chooses the furthest reusable V8-compatible V8 or
V7 prefix, preferring V8 at equal physical coverage. It validates that prefix,
appends only the Raw Event tail, prepares the canonical V8 body, derives the V7
body through the strict downgrade, and uploads both immutable objects.

The two pointers are published in one transaction after locking both exact
observed sources. If either source changed concurrently, neither pointer moves;
the immutable uploads remain safe for reference-aware garbage collection.

## Snapshot reads and history

A V7 reader selects only the V7 pointer. A V8 reader selects the furthest V8 or
V7 pointer and may use a V7 object as an identity-compatible historical prefix:
every V7 row is already a valid V8 row, and the V8 Raw Event tail carries any
new failure reasons.

Internal current-history reads use the same furthest-compatible-prefix rule.
They never rebuild from sequence zero after a Snapshot pointer exists because
older Raw Events may already have been reclaimed.

A missing object, invalid Snapshot, unsupported object revision, incomplete
cursor, or invalid historical prefix fails closed. It cannot authorize a Raw
Event rebuild.

## Retention and object collection

Raw Event retention requires adequate V8 `r2` and V7 `r1` Snapshot coverage
before deleting a row. This keeps both the current API and the retained V7 API
able to serve complete history throughout the bridge.

R2 garbage collection treats every Snapshot pointer version as a live
reference. Replaced objects become collectible only after no pointer refers to
them and the normal grace period has elapsed.

## Client caches

CLI disk caches and Platform IndexedDB cursors record the schema version that
was actually negotiated. Every network synchronization probes V8 first and
falls back as described above. Tail pages use that one selected version.

If the selected version differs from the cached version, the client replaces
the entire managed thread generation from the selected Snapshot before
tailing. It never append-enriches a V7 cursor with V8 rows. The Platform V8
IndexedDB generation also clears the previous compile-time V7 database layout;
row and cursor writes remain atomic.

## Removing the V7 bridge

V7 support is temporary. Remove it only after production evidence confirms all
of the following:

1. Previous app and CLI readers have drained or are outside their support
   window.
2. No serving or rollback API needs to read or publish V7 Snapshots.
3. Commit-addressed CLI artifacts selected by queued or active runs no longer
   request V7.
4. V8 Snapshot coverage is complete and healthy for retention authority.
5. Stored V7 object references have drained before changing garbage-collection
   or database constraints.

Cleanup must be a later release. It must not be combined with the release that
first deploys V8 readers and writers.
