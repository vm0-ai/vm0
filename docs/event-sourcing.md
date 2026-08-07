# Event Sourcing and Optimistic Events

This guide defines how the frontend combines persistent events with optimistic
events. It applies to event-sourced chat content, thread metadata, and other
frontend projections that show a local event before the server round trip
finishes.

## Event Roles

Persistent events are durable server facts. They have the server-owned ordering
and are the authoritative input when the frontend rebuilds a projection from an
event log or snapshot.

Optimistic events are page-local projections created before persistence
completes. They make an accepted user action visible immediately, but they are
not a second source of truth and do not have server ordering.

## Normal Reconciliation

The frontend creates an event ID, appends an optimistic event with that ID, and
passes the same ID to the server mutation. When the corresponding persistent
event arrives through the normal event stream:

1. The projection prefers the persistent event and filters out the optimistic
   event with the same ID.
2. Reconciliation removes that matching optimistic event from the page-local
   buffer.

This persistent-event match is the only in-session cleanup path for optimistic
events. The persistent event remains authoritative even if it arrives through a
later sync rather than the mutation response.

## Failure Semantics

The frontend must not remove or roll back an optimistic event merely because a
request fails, aborts, times out, returns no persistent lifecycle event, or
otherwise takes an exceptional path. Do not add error-handler cleanup,
`finally` cleanup, fallback timers, or heuristics that guess whether an
optimistic event should be deleted.

These exceptional inconsistencies are rare. Maintaining a second rollback
lifecycle for them adds defensive complexity and can remove an event that was
persisted but has not reached the client yet. A stale optimistic projection is
recoverable: refreshing the page discards page-local optimistic state and
reloads the authoritative persistent state, restoring eventual consistency.

## Review Checklist

- The client-generated event ID is reused by the server mutation.
- Persistent and optimistic projections deduplicate by that shared event ID.
- Persistent events are the only normal trigger for removing matching
  optimistic events.
- Failure, cancellation, timeout, and missing-event paths do not imperatively
  remove optimistic events.
- A page refresh remains the recovery path for rare exceptional inconsistency.
