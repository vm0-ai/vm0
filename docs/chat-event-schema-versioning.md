# Chat Event schema versioning

Snapshot NDJSON rows and Raw Chat Event API rows are two representations of
the same Chat Event schema. Clients must select that schema with
`X-Chat-Event-Schema-Version` on both read endpoints, and every successful
response must echo the selected version in the same header.

Platform and CLI readers require the echoed header. Snapshot responses also
require the paired `lastEventId`; the CLI history reader validates the
immutable NDJSON body against that terminal identity instead of deriving
missing response metadata.

## Version negotiation

- The current and oldest supported version are both V5, so the supported
  interval is `[5, 5]`.
- A missing or malformed version returns
  `400 CHAT_EVENT_SCHEMA_VERSION_INVALID`.
- A version below the supported floor returns
  `426 CHAT_EVENT_SCHEMA_VERSION_RETIRED` so the client can force an upgrade.
- A version newer than the API returns
  `409 CHAT_EVENT_SCHEMA_VERSION_AHEAD`.

Raw Events are read directly from the current database representation. The API
does not project current rows or Snapshot objects into retired wire versions.

## Snapshot storage and reads

The database owns exactly one canonical pointer per
`(chat_thread_id, archive_schema_version)`. The pair is unique, and each pointer
contains a non-null `{lastEventId, lastSeqId}` terminal cursor plus the
immutable, content-addressed R2 object key. Readers select the current-version
pointer directly; there is no separate head flag or parent-pointer chain.

The Snapshot endpoint serves only the current wire version. It never generates
a transient object for a retired requested version and never substitutes a
stored pointer from another requested version.

## Snapshot upgrade invariant

Only the first Snapshot for a thread may bootstrap from the currently available
Raw Event prefix. Sequence positions may start above 1 and contain gaps. Once
any Snapshot exists, every refresh or future schema upgrade must:

1. Download and validate the stored Snapshot object.
2. Run the adjacent Snapshot migration chain on that historical prefix.
3. Read only Raw Events after the stored paired cursor.
4. Append that tail, upload a new immutable object, then publish its database
   pointer with an exact compare-and-swap.

A missing object, invalid Snapshot, missing migration, or missing historical
prefix fails closed. It must never authorize a full Raw Event rebuild because
older Raw Events may already have been reclaimed. Future schema bumps must add
every required adjacent Snapshot migration before release.

## Raw Event cursors

Every non-cold-start Raw Event cursor is the pair
`{sinceEventId, sinceSeqId}`. The only cursor without an event identity is
`sinceSeqId: 0`, which represents the position before the first event and is
valid only while the thread has no Snapshot pointer.

## Browser cache

The IndexedDB database version combines a cache-layout base version with the
requested Chat Event schema version. Any IndexedDB version change deletes and
recreates all Chat Event cache stores. The cache cursor stores the schema
version and the same paired event/sequence boundary, and row-plus-cursor writes
remain atomic. If IndexedDB fails, the existing degraded in-memory path remains
available.

Raw Event retention and orphaned R2 object collection policy are outside this
contract.
