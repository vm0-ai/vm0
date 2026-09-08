# Guest private-write timeout diagnostics

When a private-file request has fully left the host but its terminal response
does not arrive within the existing 60-second write budget, the Firecracker
backend makes one read-only Guest control query. It logs
`private file-write timeout guest diagnostic` and returns the original typed
`WriteFile / AwaitingTerminalResponse / 60000ms` error.

The query has a separate one-second total budget, including sending the frame
and waiting for its reply. Failed-run reporting can therefore take up to one
additional second. It never retries the write, completes its operation ownership,
or makes an uncertain sandbox reusable. Successful writes send no diagnostic
queries; Guest tracking only updates a constant-space in-memory snapshot.

## Fields and interpretation

- `id`: sandbox ID, used to join the existing Runner/run lifecycle logs.
- `write_sequence`: the timed-out private write's connection-local sequence.
- `diagnostic_outcome`: `matched`, `different_request`, or `unavailable`.
- On a reply, `observed_write_sequence` and `guest_write_stage` describe the latest
  write admitted by this Guest connection, including completed writes.
- On query failure, `diagnostic_error_kind` contains only the fixed I/O error kind.

The snapshot contains no file paths, file contents, credentials, or helper error
output. Sequence numbers are meaningful only within the same Guest connection.

| Stage                | Last observed boundary                                             |
| -------------------- | ------------------------------------------------------------------ |
| `idle`               | No write has been admitted on this connection.                     |
| `queued`             | The dispatcher admitted a request to the file-write worker.        |
| `starting_helper`    | The worker is starting the fixed helper process.                   |
| `waiting_for_helper` | The helper exists; pipe setup, child wait, or reaping is pending.  |
| `joining_stdin`      | The helper wait returned; the stdin writer is being joined.        |
| `draining_stderr`    | The stderr drain is being completed and joined.                    |
| `waiting_for_writer` | A terminal response is ready and waiting for the shared writer.    |
| `writing_response`   | The terminal response owns the shared writer.                      |
| `response_sent`      | The complete terminal frame was written, not necessarily received. |

These are snapshots, not a full timeline or terminal proof. In particular,
`response_sent` does not establish that the write succeeded: both success and
failure terminal frames reach that stage. `different_request` does not establish
that the timed-out request was never received. `unavailable` cannot distinguish a
stalled dispatcher, shared writer, transport, or whole Guest.

The read-only query is allowed while normal operations are quiescing or uncertain.
It uses the same serialized Guest response writer, so a writer stall can also
prevent diagnostic collection. Reading the snapshot releases its memory lock
before taking that writer lock.

## Deployment and investigation

Runner and its bundled Guest binaries are one deployment artifact; see
[deployment compatibility](deployment-compatibility.md). This addition does not
change an API, queue, or persisted schema. Deploy or roll back the whole artifact.

This instrumentation supports the investigation in
[#32455](https://github.com/vm0-ai/vm0/issues/32455). It does not establish or fix the
cause of the historical missing-response incident. Keep the investigation open
until new evidence supports a causal conclusion.
