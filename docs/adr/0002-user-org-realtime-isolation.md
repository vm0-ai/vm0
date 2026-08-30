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

The permanent App consumes `chatThreadMessageCreated` and `threadListChanged`
from the `user-org:<userId>:<orgId>` channel for each user-org identity. During
the old-App rollout window, the API also mirrors those signals to the existing
user channel for already-loaded clients. Follow-up #30334 removes that bounded
compatibility publish after the client-version floor excludes pre-cutover App
builds; the user-org channel remains the canonical topology.
