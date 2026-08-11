# Active Input Delivery

Active input delivery prevents a prompt accepted by a running Guest from being
lost or executed twice when run completion, cancellation, and queue scheduling
overlap.

## Lifecycle

The Runner reserves the oldest active-input event before sending it to the
Guest. New reservations contain one source event so each user message reaches
the CLI as a separate input with its own delivery identity. Reservation creates
one `active_input_deliveries` row and one `active_input_delivery_items` row, but
it does not revoke or copy the source chat event. Retrying the reservation
returns the same delivery ID, event ID, and materialized prompt while that
delivery remains open.

The delivery becomes settled through one of two proof-bearing paths:

- A direct receipt confirms that the Guest accepted the batch. Each source is
  replaced by a run-attributed event and every item becomes `delivered`.
- `/api/webhooks/agent/complete` proves that the Guest has quiesced, or that the
  Runner observed process exit and completed sandbox teardown. Delivery IDs in
  `activeInputDeliveryIds` become `delivered`. If the open delivery ID is not
  present, prompt items become `released` and their original source events stay
  pending; run-scoped budget items become `expired` and receive a
  `control.revoke` event.

All item and delivery transitions are monotonic. A late receipt for a released
or expired delivery is rejected, while a repeated receipt for an already
delivered delivery is idempotent. Duplicate completion still processes an open
delivery even when the run is already terminal.

## Terminal Status and Quiescence

A terminal run status does not by itself prove that the old consumer is gone.
Cancellation is visible immediately, and heartbeat timeout records an unknown
consumer state, but neither path releases a reservation. Cooperative Guest
completion and Runner post-exit completion are the existing quiescence signals.

An open delivery is therefore a non-expiring thread-ordering barrier. The queue
scheduler cannot skip its source events or launch later input on the same
thread, even after cancellation recovery becomes stale. Once completion settles
the delivery, released prompts return to their original FIFO position and the
post-commit scheduler may create the successor run.

## Transaction Boundary

Reservation, direct receipt, and completion finalization serialize database
state in this order:

1. chat thread;
2. agent run;
3. delivery and delivery items;
4. source and revoking chat events.

Completion finalizes the delivery and applies or observes the terminal run
state in one short transaction. Realtime publication, callbacks, usage work,
and queue drain run only after commit. A first late finalization drains the
thread without replaying the run's ordinary terminal callbacks or billing work.

## Compatibility

`activeInputDeliveryIds` is optional, contains at most 1,024 unique canonical
UUIDs, and carries no prompt content. Older callers can continue to omit it.
Runs without durable delivery rows retain the legacy completion behavior; no
protocol version or feature discriminator is persisted.

The current server support is dormant until the Runner begins reserving active
input. Runner journal recovery and activation are delivered separately in
[#26060](https://github.com/vm0-ai/vm0/issues/26060).

During rollout, the legacy list/claim endpoint still accepts multiple event IDs
for old Runners. Current Runners claim only the oldest listed event and
immediately recheck when more are pending. The legacy batch shape can be removed
under [#26061](https://github.com/vm0-ai/vm0/issues/26061) after old Runners and
their claimed runs drain.

Deleting a thread or run cascades its delivery state, so an abandoned delivery
cannot block an unrelated thread.
