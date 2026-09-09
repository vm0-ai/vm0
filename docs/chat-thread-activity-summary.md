# Thread activity summaries

`threadActivitySummary` is disabled by default, with no rollout audience. Both
accepted-event capture and direct summary requests resolve the canonical
owner's organization/user database overrides. This backend slice leaves the
existing initial-thinking producer and all frontend behavior intact.

## API contract

`POST /api/chat-threads/:id/activity-summary` accepts only `{ "runId": "<uuid>" }`.
It requires organization authentication and `chat-event:read`; ownership,
organization, thread association, and the thread's canonical admitted run are
checked on the server. Queued and terminal runs are ineligible. Commentary does
not end eligibility. Responses use `Cache-Control: no-store`.

The typed contract is `chatThreadActivitySummaryContract` in
`@okouai/api-contracts/contracts/chat-thread-activity-summary`.

| Field                                   | Meaning                                                                               |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| `runId`                                 | Requested and verified run identity                                                   |
| `phrase`                                | One plain-text line, at most 60 grapheme clusters, or `null`                          |
| `status`                                | `fresh`, `stale`, `pending`, `cooldown`, `ineligible`, or `unavailable`               |
| `sourceRevision`                        | Opaque revision of the currently retained activity and visible-message cursor         |
| `summaryRevision`                       | Actual revision read by the successful generation, or `null`                          |
| `sourceSequence`, `summarySequence`     | Latest retained event sequence now and at generation, or `null` before tools/messages |
| `messageCursor`, `summaryMessageCursor` | Canonical visible-message sequence now and at generation                              |
| `summarizedAt`                          | UTC generation completion time, or `null`                                             |
| `retryAfterMs`                          | Bounded delay before another useful request; fresh results suggest 15 seconds         |

Authentication/validation errors use the existing 400/401/403 error contract.
Disabled accounts receive 403. Missing, inaccessible, or mismatched thread/run
identities receive 404 without cache exposure. An owned but ineligible run
receives 200 with `status: ineligible`, no phrase, and no generation. An optional
storage failure returns `unavailable` without exposing the snapshot.

A cached phrase may be returned with a different current revision while a claim
or cooldown prevents another attempt. Only `summaryRevision` identifies what
that phrase describes. A delayed completion never claims to summarize newer
activity. The response includes no raw tool arguments or activity entries.

## Storage and concurrency

`run_activity_snapshots` is disposable Postgres state with one row per run and a
cascading run foreign key. The accepted-event consumer is shared by guest
webhooks and Pi API-first delivery. It selects public message/tool/result fields;
private reasoning, images, heartbeats, usage-only records, and unsupported
variants are ignored. Existing runtime masking remains intact; structured
credential-shaped argument keys are additionally redacted.

- Retain at most 16 entries and 16 KiB of serialized activity, with 700-character
  excerpts. Keep sequence and block identity, discard oldest evidence first,
  and canonicalize object keys before hashing so JSONB ordering cannot create
  false revisions. Relevant late events can merge into the retained window.
- Merge and claim under a short row-locking transaction with a 250 ms lock
  timeout and 3 second statement timeout. Provider I/O runs outside the
  transaction. Optional capture failures cannot reject accepted execution
  events or suppress normal message publication.
- Claims last 12 seconds. The database clock enforces at least 15 seconds
  between attempts across API instances and tabs. A crashed owner's claim
  expires. Completion requires the exact claim ID and claimed revision, an
  unexpired lease/snapshot, and continued run eligibility.
- Load up to eight canonical visible user/assistant messages, including the
  current task, with 700-character excerpts. Queued messages enter the context
  after the runtime acknowledges delivery. Indicator copy is excluded.
- Reuse `FAST_PATH_MODEL` and `generateText`, a reasoning-inclusive 1024-token
  budget with low reasoning, and a 10-second provider deadline. No request
  means no new summarizer call. Invalid/unconfigured/failed generation keeps
  the last phrase or `null`; it never retries inside the request.
- Failed attempts use a shared 60-second cooldown. HTTP `Retry-After` can extend
  it up to five minutes. Expired or replaced claim owners cannot write results.
- Relevant capture or visible messages retain evidence for at most 24 hours
  from activity; first observing an old message does not restart its retention. Expired evidence is never returned. An expiry index supports
  one cleanup batch of at most 500 rows with `FOR UPDATE SKIP LOCKED`, attached
  to existing sandbox maintenance and available with the switch off.

Debug diagnostics record capture outcomes, cache states, attempt/completion
counts, latency, cooldown, and cleanup counts. They never contain prompts,
arguments, results, or provider response bodies.

## Deployment and the next slice

The migration only creates an empty table and index; it changes no existing
persisted contract and backfills no historical rows. Existing API/Runner/App
versions continue their current paths. Apply the additive migration before
activating readers/writers; normal API production promotion already enforces
that ordering. This PR does not perform a release or enable production users.

The next slice should use the same switch to stop automatic initial-thinking
creation for enabled runs and request this endpoint only from the visible active
thread. It must discard responses for a changed/ended run or disabled switch,
keep phrases transient, and honor retry metadata without overlapping requests.
Dynamic phrases must never be appended to durable chat history or agent context.
