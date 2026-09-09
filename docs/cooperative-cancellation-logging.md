# Cooperative cancellation logging

A user cancellation first asks Guest Agent to save recovery state and exit.
If delivery fails, Runner still sends the existing bounded supervised-process
cancel request and waits for its terminal result. This fallback does not prove
that the cooperative checkpoint completed, and its synthetic cancelled result
does not prove that the Guest process stopped.

The `failed to send cooperative user cancellation` event is INFO only when:

- The structured control outcome identifies an inactive operation, a connected
  Guest sink that closed during I/O (`SinkClosed`), or a non-backend-crash
  transport closure (`BrokenPipe`, `ConnectionReset`, or `UnexpectedEof`).
- The existing forced-cancellation wait observes an actual `Exited` or
  `Cancelled` provider result without a diagnostic.

These events carry `recovered_after_cancellation=true`. A candidate closure
without that terminal proof remains WARN with the field set to false. Other
control failures remain WARN immediately. A generic `SinkError` is not closure
proof: it also covers protocol and application failures, even though the legacy
acknowledgement adapter represents it as `BrokenPipe`.

Guest control retains the first connected-sink failure's classification for
queued and later requests. Active-input delivery remains uncertain after
`SinkClosed`; a closed channel is not an acknowledgement or permission to retry
a potentially non-idempotent delivery.

The private control status ships with all producers and consumers in one Runner
artifact. No API, database, persisted workspace-cache format, cancellation
deadline, retry, checkpoint, or sandbox reuse rule changes. Hard cancellation
continues to make the sandbox ineligible for reuse.

For issue #32755, observe a full 24 hours after deployment before closure.
Correlate INFO recovery events in host logs with the actual Guest terminal result
and sandbox retirement, and inspect production WARN/ERROR logs for unconfirmed
cancellation or genuine control failures. WARN-only Axiom queries do not contain
the downgraded INFO events. A quiet query without exercised cancellations does
not establish recovery coverage.
