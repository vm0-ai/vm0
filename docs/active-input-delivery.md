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

The Runner sends the delivery UUID with the Guest control payload. The Guest
deduplicates that identity, persists it after the CLI backend accepts the
follow-up, and attempts the direct receipt asynchronously. A delivered or
acknowledgement-uncertain batch is not sent again while the API keeps returning
the same reservation. Explicit pre-write failures and retryable Guest capacity
statuses retry the same identity.

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

After the Guest process exits, the Runner reads the bounded run-scoped receipt
journal while it still owns the sandbox. It attempts those receipts within one
total five-second budget and includes unresolved IDs in the normal completion
request. This uses completion's existing retry and idempotency boundary as the
final recovery path. A successful direct receipt also reuses the existing
Runner notification channel when settlement exposes another queued prompt; the
30-second poll remains notification-loss recovery rather than normal steering
latency.

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

On its first active-input read, a Runner probes the reserve route. Only an
immediate route-level `404` selects the legacy list/claim protocol for that run.
Any response or ambiguous failure selects durable reserve mode permanently, so
a committed reservation can never later fall through to destructive legacy
claim. Legacy payloads omit the delivery UUID; durable API and local Runner
payloads include a stable UUID. Older Runners continue to use the retained
legacy routes against a newer API.

The cutover Runner must run with a receipt-capable Guest from #26058. A legacy
Guest treats process-control acceptance as queue admission and has no durable
receipt, so it is not a compatible execution peer for a Runner that reserves a
delivery. Deploy the Guest capability and drain any sandboxes that can still
start that legacy Guest before enabling the cutover Runner. This is a rollout
gate rather than a permanent protocol-negotiation branch.

The browser remains event-oriented: optimistic input is reconciled by its chat
event ID, and receipt/completion replacements use the existing realtime chat
event projection. Delivery IDs remain internal to API, Runner, and Guest, so
activation does not introduce a frontend protocol or deployment dependency.

Durable delivery is active as of
[#26060](https://github.com/vm0-ai/vm0/issues/26060). The legacy compatibility
routes and optional Guest payload shape remain until the post-deployment
contraction in [#26061](https://github.com/vm0-ai/vm0/issues/26061).

During rollout, the legacy list/claim endpoint still accepts multiple event IDs
for old Runners. Current Runners claim only the oldest listed event and
immediately recheck when more are pending. The legacy batch shape can be removed
under [#26061](https://github.com/vm0-ai/vm0/issues/26061) after old Runners and
their claimed runs drain.

Deleting a thread or run cascades its delivery state, so an abandoned delivery
cannot block an unrelated thread.
