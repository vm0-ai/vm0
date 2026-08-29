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

During migration, the API publishes `chatThreadMessageCreated` and
`threadListChanged` to both the existing user channel and the new user-org
channel so already-loaded clients continue to receive updates. The Shared
Worker moves to the user-org channel only after its token grants that channel;
the legacy publication can be removed after the stale App-client and API
rollback windows close.
