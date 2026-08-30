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

The permanent App path consumes `chatThreadMessageCreated` and
`threadListChanged` exclusively from the `user-org:<userId>:<orgId>` channel
through the SharedWorker. During rollout, the API also publishes those two
topics to the existing `user:<userId>` channel so already-loaded App clients
compiled against the disabled switch continue receiving invalidations.
Follow-up #30334 removes that duplicate publication after the two-day stale-App
window has drained and the client-version floor excludes pre-cutover builds;
the user channel otherwise remains reserved for unrelated user-scoped signals.
