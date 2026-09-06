# Pi 0.84.1 pending-tool integration

`AgentSession.continuePendingTools()` is a local additive API, paired with
`Agent.continuePendingTools()` and their declarations. Upstream `continue()`
and both low-level continuation APIs reject a trailing assistant; consuming
queued input is not an equivalent handoff. Keep the version pinned at 0.84.1.

The entrypoint validates the current assistant and its unresolved calls, then
claims native Agent ownership before session startup acknowledgement or any
awaited event/tool work. The existing loop handles the pending assistant's
tools without emitting or appending that assistant or its original user again.
It retains argument preparation, hooks, sequential/parallel execution, partial
updates, result metadata, persistence, turn preparation, and the length guard.

The Agent's native abort controller remains active through AgentSession's
post-run retry/compaction/queue handling and awaited terminal extension hooks.
These run within the original lifecycle through the integration callbacks;
`finishRun()` releases it only afterwards. Normal prompt calls retain their
existing post-run path. Optional signals on shared session helpers identify
the pending operation; retry/compaction retain their own explicit abort controls
while also observing that native owner. A fresh explicit prompt obtains a new
signal.

For this entrypoint, extension `agent_settled` handlers are awaited preparation,
called once per owner while both native lifecycles remain busy. They can queue
input or request cancellation through the supported, non-waiting `ctx.abort()`;
they must not wait for their own owner to become idle. New turns caused by that
input retain ordinary turn/message hooks, but do not re-enter settlement
handlers. The public `agent_settled` event is the terminal commit notification.

After preparation, the same owner reconciles cancellation first. Otherwise it
drains accepted input in native steering/follow-up order, including post-run
retry/compaction, and rechecks after every await. An empty queue and un-aborted
signal close admission synchronously with public settlement and owner release.
There is no asynchronous callback after this decision.

When cancellation wins, native queue admission closes before awaited message
callbacks. Accepted input is drained once into native message events and JSONL,
without a new turn, tool, HTTP request, retry or compaction. The final assistant
outcome is aborted before the sole public settlement. If a provider already
emitted an aborted assistant, retain that fact instead of appending a duplicate;
subsequently accepted input can follow it in history. A fresh prompt sees those
messages as persisted context, never as a revived pending queue. Input arriving
after admission closes receives the existing RPC error response, before queue
display state changes. Guest therefore retains its existing failed-delivery
path; successful acknowledgements never rely on a future prompt or process.

Cancellation gates surround awaited context conversion, auth, turn preparation,
and prepared-tool entry. Started tools and event callbacks are joined even if
a sibling fails. Interrupted/unstarted calls retain upstream history handling;
there is no second result journal, replay engine, or checkpoint format.

Cancellation is cooperative: completed external effects are not rolled back,
and a tool that ignores cancellation can delay settlement. Guest's existing
10-second RPC abort acknowledgement deadline and child termination/reaping
remain authoritative; this patch changes neither the protocol nor that bound.

`pending-tool-cancellation.test.ts` uses real sessions/files, MSW and barriers in
owned child tests. `rpc-cancellation.test.ts` drives the official stdin/stdout
host with a separate kill deadline, including delayed settlement extensions.
Its normalized aborted terminal fixture is also consumed by Guest's public
CLI settlement integration test. Existing memory, route, handoff-mode and
history-validation tests cover the surrounding contracts.

When editing the integration, change the matching compiled JS and `.d.ts`
patch hunks together, regenerate the pnpm patch hashes, and verify a frozen
install plus the runtime/CLI type, build and focused test checks. Preserve the
independent photon and provider account-binding patches.
