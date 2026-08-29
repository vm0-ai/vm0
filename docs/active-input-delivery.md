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

- A direct receipt confirms that the Guest accepted the input. Its source is
  replaced by a run-attributed event and the item becomes `delivered`.
- `/api/webhooks/agent/complete` proves that the Guest has quiesced, or that the
  Runner observed process exit, stopped forwarding, and recovered the receipt
  journal. Completion may overlap sandbox finalization after that boundary.
  Delivery IDs in `activeInputDeliveryIds` become `delivered`. If the open
  delivery ID is not present, prompt items become `released` and their original
  source events stay pending; run-scoped budget items become `expired` and
  receive a `control.revoke` event.

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

### Post-timeout Webhook Admission

While timeout still represents an uncertain consumer state, runtime mutation
webhooks stop creating new canonical work for that run. Heartbeat returns `404`,
event batches retain their existing sequence acknowledgement but are ignored,
and new checkpoint or checkpoint-history preparation requests return `400`.
The existing completed Pi checkpoint exact-retry behavior is unchanged.

Usage events, model-usage observations, and telemetry remain accepted after
timeout because they report work that may already have happened. Storage and
firewall admission, together with the atomic timeout-versus-completion boundary,
are separate rollout stages; timeout alone still does not release an active
input delivery.

Codex execution timeout and cancellation first allow an in-flight `turn/steer`
to settle within the bounded sink window. A successful response still persists
its receipt. If the response remains pending, Guest drops the non-reusable
JSON-RPC request, terminates and waits for the owned app-server process, and
only then closes the local sink operation and finalizes receipts. The
unconfirmed delivery ID remains absent from completion, so the existing
completion transaction releases or expires it only after consumer-stop proof.

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
UUIDs, and carries no prompt content. A Guest or Runner omits it when the run
accepted no active input. The API normalizes omission to an empty set, so the
immediately preceding Runner remains compatible during an adjacent deployment.
No protocol version or feature discriminator is persisted.

The Runner always calls the reserve endpoint. A `404` or transport failure is
an ordinary retryable API error and cannot select another delivery path. Both
API and local Runner inputs send a stable `deliveryId`; the Guest rejects a
payload without a canonical delivery ID before queue admission.

Runner and Guest ship in the same artifact, so their internal control payload
does not require cross-version negotiation. Independently deployed API and
Runner versions remain compatible through the stable reserve response shape:
`eventIds` is a one-element array, and empty completion receipts may be omitted.

The browser remains event-oriented: optimistic input is reconciled by its chat
event ID, and receipt/completion replacements use the existing realtime chat
event projection. Delivery IDs remain internal to API, Runner, and Guest, so
activation does not introduce a frontend protocol or deployment dependency.

Deleting a thread or run cascades its delivery state, so an abandoned delivery
cannot block an unrelated thread.
