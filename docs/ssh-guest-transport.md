# Guest SSH transport (feature off)

The transport delivered by #32012 is infrastructure for #31932. It does not
resolve credentials, call an API, connect to an SSH server, or install a Runner
request handler. No production caller accepts this capability yet. Local/mock
sandbox providers return no SSH capability. Keep SSH disabled until the later
execution, Agent/UI, and activation slices are complete.

## Guest boundary

`/usr/local/bin/guest-ssh-rpc` accepts no arguments. Its stdin is one JSON object,
terminated by EOF:

```json
{
  "version": 1,
  "sshConnectionId": "ad729daa-0606-4113-ae6e-a8c553260f9d",
  "command": "uname -s"
}
```

The strict schema contains no host, username, credential, trusted host key, Run,
owner, or Runner identity. Unknown fields, nil/malformed UUIDs, unsupported
versions, empty commands, and commands over 64 KiB are rejected. Command bytes
are passed unchanged; the helper invokes no shell and writes no files or payload
logs. Arbitrary command output is opaque user data, not trusted identity metadata.

The helper connects once to AF_VSOCK CID 2, port 52001. Firecracker routes this to
the private host listener at `vsock.sock_52001`. There is no destination override,
reconnection, or command replay. Each wire frame is a big-endian u32 length and
strict JSON. Length is checked before body allocation: requests allow worst-case
JSON escaping of a 64 KiB command, and response frames are limited to 24 KiB.
The guest half-closes its write side after the request; extra request bytes fail.

## Responses and ambiguity

Responses have a `type` discriminator:

- `accepted`: the future handler has observed SSH exec-success. Merely accepting
  a transport socket must never produce this response.
- `stdout` / `stderr`: `data` is canonical base64 for 1–16 KiB of arbitrary bytes.
  Each stream is independently limited to 1 MiB.
- `finished`: `status` is `{kind: "exit", code: <u32>}` or
  `{kind: "signal", name: <bounded signal>}`; `stdout_truncated` and
  `stderr_truncated` are independent booleans.
- `error`: a typed `code`, an `effect` of `not_started` or `unknown`, and the two
  independent truncation flags. It contains no arbitrary diagnostic string.

Output and finished require accepted. Accepted can occur only once. Every valid
stream has exactly one terminal finished/error frame followed by EOF. The
stateful writer shuts down its write side after terminal. The helper emits the
same validated responses as NDJSON, withholding terminal until EOF so duplicate
terminal/trailing bytes cannot expose false success.

Losing the connection before receiving accepted is not proof of non-execution:
the remote command and its acceptance reply may already have been sent. The
helper conservatively reports `unknown` after its request write starts and never
retries. The future handler must use the actual SSH exec-send boundary to classify
effects. An explicit pre-execution host rejection may report `not_started`.

The helper has a 60-second total budget, including stdin, connection, framing,
and stdout. The last 100 ms are reserved for terminal diagnostics. A failed or
cancelled partial stdout write cannot safely append a replacement terminal; the
helper exits unsuccessfully instead. Terminal delivery cannot be guaranteed on
a broken pipe. Helper exit success means a valid finished frame was delivered;
the CLI must interpret its remote exit code/signal separately.

## Host ownership

The provider-neutral `Sandbox::ssh_rpc(expected_run_id)` capability captures a
host-derived Run ID and one listener epoch. It returns a trusted sandbox ID, an
owned stream, and lifecycle cancellation. The stream holds the existing
`VsockHost` normal-operation reservation until Drop, even after terminal bytes
have been sent. It cannot be extracted separately from its reservation.

Admission validates the Open/current assignment while acquiring the same tracker
reservation used by park. If park wins, admission fails; if SSH wins, park is
Busy. Both normal park and final-exec-park/handoff invalidate the old endpoint
after successful park. Rebinding precedes guest resume; old handles/backlog cannot
follow the new assignment. No separate in-flight counter or park authority exists.

The listener is synchronously bound in the private 0700 vsock directory with
mode 0600 before fresh boot or snapshot restore. Startup owns it locally until
success; errors/cancellation drop it. Stop, kill, Drop, runtime exit, and successful
park close it. Failed unpark drops its newly bound endpoint. Bind failure never
unlinks an existing entry owned by someone else.

Termination cancels pending admission and accepted I/O without waiting for remote
effects. The future Runner handler **must select lifecycle cancellation during
JIT and SSH work**, retain the owned stream for the full request, enforce its own
deadline and concurrency limits, and never spawn work that outlives those owners.
Cancellation cannot guarantee termination of a remote process.

## Delivery

Cargo/release metadata, the canonical guest inventory, generated bundle inputs,
Runner build arguments, and rootfs verification include the helper. Runner and
guest binaries ship as one artifact. Existing control-channel bytes and all API
contracts remain unchanged. Before later activation, verify the complete eligible
Runner/rootfs fleet and the selected commit-addressed CLI artifact; add no Runner
version header or fallback routing. See [deployment compatibility](deployment-compatibility.md).

Local tests use real Unix sockets, the real generic vsock handshake and operation
tracker, and deterministic external peers. They do not need a web server. Actual
fresh/restored KVM boot and packaged rootfs execution are separate metal-host
CI/E2E validation surfaces.
