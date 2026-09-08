# Runner SSH execution

#32387 implements the Runner-owned execution slice of #32013 (under #31932).
It does not activate SSH, expose a CLI/UI, or support local/PAT Runners.
Current [API authority](runner-ssh-authority.md), including the staff/feature
gate and current Agent grant, remains mandatory on every request. Run source,
chat channel, workflows, goals and trigger metadata add no eligibility gate.

## One-shot request and outcomes

The guest calls `runner-rpc-client` with the [generic envelope](runner-rpc-transport.md).
`ssh.exec` accepts exactly `sshConnectionId` (hyphenated UUID) and `command`
(at most 64 KiB UTF-8). Extra and duplicate fields are rejected. It cannot supply
Run, owner, Agent, endpoint, username, private key, pin, timeout or SSH options.
Unknown methods and invalid params are rejected before credential resolution.

The Runner resolves current credentials, validates the destination, makes one
TCP connection, verifies host trust, authenticates using the private key, opens
one session channel and requests one non-PTY exec with acknowledgement. It sends
EOF on stdin. It never requests shell, environment, PTY, agent forwarding, port
forwarding or subsystems, and rejects unsolicited server channels. There is no
reconnection, alternate-address fallback or command replay.

Business data is contained only in generic `event`/`result` envelopes:

```json
{"type":"event","data":{"type":"accepted"}}
{"type":"event","data":{"type":"output","stream":"stdout","data":"aGVsbG8K"}}
{"type":"result","data":{"type":"finished","exit":{"type":"status","code":0},"effects":"completed","stdout_bytes":6,"stderr_bytes":0,"stdout_truncated":false,"stderr_truncated":false}}
```

`accepted` is emitted only after the peer accepts exec. Output is binary-safe
standard base64, with independent stdout/stderr byte counts and truncation.
Counts describe retained bytes, not discarded excess output. Exit status is an
unsigned SSH status, including nonzero. Signal exit is
`{"type":"signal","signal":"TERM","core_dumped":false}`; only standard known
signal names survive, and unknown names become `UNKNOWN`. Peer diagnostics and
language tags never cross the boundary. Missing exit evidence is not success.

A business failure has `type: failed` and an allow-listed `failure_reason`:
`unavailable`, `authority_failure`, `invalid_credential`,
`unsupported_credential`, `credential_resource_limit`, `unsafe_destination`,
`network_failure`, `host_key_mismatch`, `unsupported_host_key`,
`configuration_changed`, `authentication_failed`, `protocol`, `exec_rejected`,
`disconnected`, `timed_out`, `cancelled`, `resource_exhausted`, or `transport`.
It retains the same output counters/truncation fields.

`effects` is `not_started` before an exec send attempt or after explicit exec
refusal; it becomes `unknown` once sending is attempted without terminal remote
evidence. `completed` means the remote process supplied exit evidence and closed
the channel, not that its exit status was zero. The helper's exit zero means RPC
completion only: future callers must inspect these business fields. Losing a
terminal response never permits automatic replay. Local cancellation closes the
socket but cannot guarantee the remote process stopped.

## Authority, trust and destination

Resolve/pin requests use the host's immutable Runner process identity and exact
current Run assignment. A token prefix selects official transport only; API
authentication and winning-claim checks provide the actual authority. Responses
must be HTTP 200, fit 512 KiB, and satisfy generated DTOs and semantic bounds.
Redirects are rejected. A missing/old API fails closed without affecting normal
Agent execution. An already-authorized handoff remains subject to the API's
documented in-flight revocation window.

Native public-address constants are generated from the canonical connector
destination policy and exercised against its shared JSON fixtures. All DNS
answers must be public, use the exact requested port, and have no IPv6 scope or
flow metadata. Empty or more than 64 answers are rejected. Canonical ASCII DNS
names are queried with a root dot; literals bypass DNS. Legacy numeric, scoped,
URL and bracketed host forms are rejected. The engine connects to one selected
approved `SocketAddr`, without a second lookup.

After KEX proof verification, an existing pin must match algorithm and SHA256
fingerprint locally. Without a pin, the current-authority pin API must return
`pinned` or `matched` at exactly JIT generation plus one before authentication.
Mismatch/stale/unavailable results do not authenticate or overwrite trust.
First-use TOFU still cannot prevent a first-use MITM.

The engine advertises Curve25519 and DH group14 SHA256 KEX, Ed25519/ECDSA and
RSA-SHA2 host signatures, ChaCha20-Poly1305/AES-GCM/AES-CTR, and SHA2 MACs. RSA
client authentication uses SHA2 only. DSA, SHA1 negotiation and certificates are
not offered.

### Explicitly deferred dependency limitation

The published `russh 0.63.2` verifies cryptographic host signatures but does not
require the signature blob's algorithm to equal the negotiated host-signature
algorithm. A real-peer probe showed a valid RSA-SHA1 proof can be accepted after
RSA-SHA512-only negotiation. This is a verified algorithm-policy gap, not a
demonstrated host-pin bypass or practical impersonation exploit. The user
explicitly deferred fixing it on 2026-09-08. This PR uses the stock dependency,
not a fork/vendor patch, and does not claim zero risk or strict enforcement of
the actual server proof hash. Pin, proof-of-possession, current-authority and
client-signing checks remain in force.

## Credential and resource envelope

Accepted private key containers are OpenSSH, PKCS8, encrypted PKCS8 and PKCS1
RSA. Keys may be Ed25519, NIST P-256/P-384/P-521 or RSA 2048..8192 bits. RSA
components are bounded to 1024 bytes, with an exponent at most 4 bytes; multiprime
RSA is unsupported. PEM legacy encryption, standalone SEC1 EC, DSA, certificates,
security keys and PPK are not accepted.

Encrypted OpenSSH permits modern AES schemes with bcrypt 1..64 rounds and
16..64-byte salt. Encrypted PKCS8 requires PBES2/AES with PBKDF2 SHA256/384/512
at most 600,000 iterations, or scrypt with at most 32 MiB estimated working memory,
`r <= 8`, `p = 1` and power-of-two `N > 1`. Advertised excessive cost is rejected
before derivation. These are intentional service resource limits: a valid key
outside them must be re-exported within the supported envelope.

Private key/passphrase text uses canonical UTF-16 bounds (65536/4096), preserving
whitespace. Credential-bearing generated DTOs cannot Debug/Clone/Serialize and
deserialize fields directly rather than through tagged generic-value buffers.
Application-owned response, PEM and decrypted buffers are bounded and zeroizing;
this is not a claim that serde/HTTP/crypto libraries eliminate every internal
plaintext copy. Credentials are never written to guest files or checkpoints.

Per-sandbox admission is 2 requests and per-Runner admission is 16, before request
parsing and JIT. Expensive key decoding uses 2 process-wide blocking slots.
Cancelled blocking work and system DNS retain the actual accepted stream and its
existing normal-operation/park reservation until they really finish. Cancelling
a waiter does not release those resources prematurely. The dispatcher does not
introduce an independent park counter.

Each stream retains at most 1 MiB output, coalesced into at most 16 KiB chunks,
with periodic low-volume flushing. Both full streams fit the generic 24 KiB
frame/4 MiB aggregate envelope, including terminal reserve. Incoming SSH channel
queues hold at most 64 messages. The advertised packet size is 32 KiB, with
russh's hard transport cap of 256 KiB plus framing headroom bounding packets
from nonconforming peers too. Excess output is discarded with truncation, not
accumulated.
Every external await observes Run/sandbox cancellation and the helper-coordinated
60-second maximum deadline. Partial cancelled frame writes are never resumed.

The shared fresh/reused Run boundary installs the dispatcher before Agent work
and cancels/joins it before cleanup. Dropping the Run also cancels it. A connected
socket guard closes detached russh I/O, while that I/O retains the actual stream
reservation until it exits. Telemetry contains only owned identifiers, fixed
outcomes, timing, byte counts, truncation and terminal-delivery state. Production
fmt/Axiom sinks suppress raw russh/ssh-key/ssh-cipher diagnostics at every level.

## Remaining delivery gates

Agent inventory/CLI/UI delivery, packaged-helper verification in fresh/restored
KVM guests, complete Runner/rootfs convergence and controlled production
activation remain later parent-owned slices. Local mocked-boundary/real-peer
tests do not establish those rollout gates. No SSH activation is authorized by
this implementation.
