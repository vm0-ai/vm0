# Isolate chat database realtime by user and organization

Status: Accepted — 2026-08-29

## Context

The Shared Worker must receive chat completion invalidations and persist those
threads to IndexedDB even when no page is currently viewing them. A user can
belong to multiple organizations, so a user-only Ably channel cannot provide
physical delivery isolation between those organizations.

## Decision

Chat database invalidations use a dedicated
`user-org:<userId>:<orgId>` Ably channel, and Shared Worker realtime sessions
are owned by the same `(userId, orgId)` identity. This prevents one
organization's chat activity from being delivered to another organization and
lets the worker select the matching credential and IndexedDB database without
client-side filtering or thread-to-organization inference.

## Consequences

The App consumes `chatThreadMessageCreated`, `threadListChanged`, and
`chatThreadReadCursorUpdated` exclusively from the
`user-org:<userId>:<orgId>` channel through the SharedWorker. The worker fans
indicator invalidations out to every matching tab and preserves the read-cursor
payload needed to reconcile optimistic read marks. The user channel remains
reserved for unrelated user-scoped signals. The canonical web-client floor is
`0.812.3`, the first released App build containing the unconditional
SharedWorker consumer, so the API rejects older user-channel-only clients
before serving application routes.
