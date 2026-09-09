# Runner SSH authority API

This is the API slice (#32386) of SSH execution (#32013, under #31932).
It does not enable SSH. The [Runner execution slice](runner-ssh-execution.md)
(#32387) consumes these routes through generated private Rust DTOs;
Agent/CLI/UI and activation remain later delivery stages.

## Authority and secret handoff

Both endpoints accept only the official fleet Runner credential. A local Runner
PAT, browser session or guest token cannot resolve credentials or learn trust.
The request identifies a Run, connection and winning Runner process
(`runnerId`, `heartbeatGeneration`); it cannot supply owner, Agent, endpoint,
credentials or command. The shared fleet secret authenticates the fleet, not an
individual machine: the process identity is checked against the Run's immutable
winning claim. Protecting the fleet secret remains a trust assumption.

Each call joins the current running Run, session, Agent owner,
Agent SSH grant, exact owner connection and its credential. Ownership and org
must agree. The hard staff-org gate and current `SshAccess` override both apply.
SSH access depends on the user's current configuration and the Agent's current
grant, not how the Run started. All chat channels, workflow schedule/event
automations, goals, delegated Agents, webhooks, SDK/non-chat and test Runs use
the same authority path. A chat thread or trigger metadata is not required;
workflow automation and goal associations do not restrict access. The session
identifies the Agent without using chat-thread state as an authorization gate.
The existing staff/feature rollout and official-Runner credential boundary are
unchanged; this does not activate SSH or expose credentials to local Runners.

`POST /api/runners/runs/:runId/ssh/resolve` takes:

```json
{
  "connectionId": "b1f329f0-8010-48fb-9884-f78c839b35bf",
  "runnerIdentity": {
    "runnerId": "08999e12-3b53-4206-8088-374f3c0f6a54",
    "heartbeatGeneration": 7
  }
}
```

HTTP 200 has `outcome: resolved` with host, port, username, generation,
nullable learnedHostKey, privateKey and nullable passphrase. Secret whitespace
is preserved. This response is private to the trusted Runner, never guest RPC
output, Run snapshots, checkpoints, logs or audit metadata. The response is
`Cache-Control: no-store`. Downstream code must not log the response or arbitrary
errors containing it.

Missing, hidden, revoked or ineligible references all produce HTTP 200 with
only `{"outcome":"unavailable"}`, before decryption. Invalid syntax is 400;
missing/invalid auth is 401; authenticated local Runner auth is 403. Broken DB,
KMS or stored local invariants remain server errors, not unavailable references.

Configuration, encrypted credentials and relational authority are captured in
one joined read, followed by the feature check. That authorized snapshot is an
in-flight handoff: revocation cannot retract a response already authorized.
Every later resolve checks again and sees committed rotation/deletion/revocation.
The Runner can reuse a successfully resolved snapshot and parsed key for the
current Run while Ably is connected; it does not resolve on every command. This
explicit application-owned retention is not HTTP/proxy caching.
KMS decryption runs outside transactions and row locks, so slow KMS does not
block owner edits or revocation. Resolve never writes a learned host key.

### Invalidation and accepted freshness

After a successful connection edit (including credential rotation), deletion or
explicit host-key reset, the API sends identifier-only `ssh-authority-invalidated`
messages on `runner-group:<group>` for affected running owner Runs. Payloads are
`{runId, connectionId}`; null `connectionId` means the whole Run. Recipient discovery
must not require a grant or connection row that the mutation may have deleted.
The Run-wide hook accepts an Agent scope; future Agent-access/ownership writers
must invoke it before SSH activation. Current production access/inventory APIs
remain a later delivery stage.

Notices are sent after commit and before the request observes cancellation. A
failed publish is logged, not reported as failure of the already-committed edit.
The Runner only evicts local authority; it obtains any replacement from the API.
Before Ably readiness and during disconnect/failure it resolves per command,
clears cached entries on observed connection loss, and refills lazily after recovery.

There is no fixed TTL or periodic authorization poll. Missed publication or a
dropped subscriber message may leave previous configuration/credentials/grants
usable for the remainder of the Run, including after deletion/revocation. This
Run-lifetime stale-authority window is explicitly accepted; Ably is not a reliable
revocation protocol. Cached parsed keys remain bounded in process memory and are
retired on invalidation or Run teardown. Per-connection public-destination and
cryptographic proof/pin checks remain mandatory, and invalidation never authorizes
command replay or guarantees termination of a remote command already started.

## Atomic trust on first use

`POST /api/runners/runs/:runId/ssh/pin` additionally takes
`expectedGeneration` and `observedHostKey: {algorithm, fingerprint}`. The Runner
must first validate the server's key-exchange proof of possession, then pin
before sending authentication. This API cannot verify that network handshake.
Accepted identities are Ed25519, NIST P-256/P-384/P-521 ECDSA and RSA, with a
canonical unpadded SHA256 fingerprint. `ssh-rsa` identifies an RSA public key;
it does **not** select SHA-1 signatures. The Runner advertises and signs RSA-SHA2;
see the execution document's explicitly deferred russh host-proof algorithm
consistency limitation.

Pin first authorizes without locking. It then locks the owned connection row
used by owner edit/reset, rechecks current authority and rollout state after
any wait, and holds shared authority/credential row locks through the write.
No KMS or other external call occurs in that transaction. Unauthorized calls
do not acquire another owner's connection lock.

| Stored state                                       | Result                  | Mutation                       |
| -------------------------------------------------- | ----------------------- | ------------------------------ |
| Unpinned, generation N equals expected             | `pinned`, N+1           | Learn key and increment once   |
| Same key, generation exactly expected+1            | `matched`               | None                           |
| Different key already pinned                       | `host_key_mismatch`     | None, regardless of generation |
| Any other generation, including integer exhaustion | `configuration_changed` | None                           |
| Current authority unavailable                      | `unavailable`           | None                           |

Concurrent identical first observations converge on one pin. A different key
never overwrites trust. Endpoint edits, credential edits and explicit reset
retain the existing generation semantics; stale observations cannot silently
repin. TOFU cannot prevent a first-use MITM, and resetting trust intentionally
reopens that first-use window.

## Deployment

This is additive, feature-disabled API with no migration. Old Runners and
clients do not call it. It can deploy before the consuming Runner PR; it does
not establish fleet convergence or authorize enabling SSH. See
[deployment compatibility](deployment-compatibility.md) and
[guest RPC transport](runner-rpc-transport.md) for the remaining boundaries.
