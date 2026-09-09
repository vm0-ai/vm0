# Thread activity summaries

`threadActivitySummary` remains globally disabled (`enabled: false`). Once the
staff-cohort configuration is deployed, its registry default enables only the
existing staff organization through `STAFF_ORG_ID_HASHES`. Explicit database
overrides still take precedence: a staff user's `false` override opts out, and
the existing non-staff `true` opt-in remains available. Both accepted-event
capture and direct summary requests resolve the canonical owner's
organization/user database overrides. The same switch hands off the
initial-thinking producer to demand from the visible main thread. Disabled
accounts retain the existing producer, display and historical behavior.

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

## Production diagnostics

The existing activity records use `info` for normal outcomes and `warn` for
failed operations so they survive the default Axiom transport's `info` threshold.
The shared logger and unrelated debug filtering are unchanged. Axiom events
retain `source: api`, the stable message, and the following nested `fields`:

| Message                        | Context                | Level                                             | Safe fields besides context                                                                                |
| ------------------------------ | ---------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Activity summary cache`       | `api:activity-summary` | info                                              | `runId`, `outcome` (existing response status)                                                              |
| `Activity summary attempt`     | `api:activity-summary` | info                                              | `runId`                                                                                                    |
| `Activity summary completion`  | `api:activity-summary` | info on success; warn otherwise                   | `runId`, `outcome`, `durationMs`, `cooldownMs`; numeric `providerStatus` only for `OpenRouterRequestError` |
| `Activity summary unavailable` | `api:activity-summary` | warn                                              | `runId`, `outcome: storage_failed`                                                                         |
| `Activity snapshot capture`    | `api:run-activity`     | info for written/unchanged; warn for write_failed | `runId`, `outcome`, `eventCount`                                                                           |
| `Activity snapshot cleanup`    | `api:run-activity`     | info on success; warn on failure                  | `outcome`, `removed`, `retentionMs`                                                                        |

Completion outcomes remain `success`, `timeout`, `provider_failure`, and
`invalid_or_unconfigured`. A provider HTTP 429 is distinguishable by
`fields.providerStatus: 429`; no error object or provider body is attached.

Granularity is unchanged: one cache record for a request resolved without a
claim, one attempt/completion pair per generation attempt, one unavailable
record for an optional summary storage failure, one capture record per relevant
batch (including unchanged duplicates), and one cleanup record per maintenance
operation (including zero removals). Disabled, irrelevant, and ineligible
captures remain silent. `eventCount` counts the submitted batch, not new retained
entries. Failed cleanup reports `removed: 0` with `outcome: failed`; that is not a
successful empty cleanup.

These records never contain prompts, phrases, messages, arguments, evidence,
credentials, database-driver errors, or provider response bodies. The tests call
real endpoints and exercise the production logger and real Axiom SDK/transport,
with ingestion captured by MSW and unrelated debug records verified as filtered.
No test logs go to production. Attempt records measure this service's generation
attempts; they do not establish provider billing, token usage, or cost savings.
Production verification remains controller-owned after release.

## Visible viewer lifecycle

The committed main-thread container owns summary demand through its local
callback-ref AbortSignal and page lifecycle. Sidebar panels and unmounted routes
do not request summaries. A visible, enabled viewer requests immediately for the
latest eligible live run from the canonical event fold; the API independently
verifies the admitted-run pointer and authorization. Subsequent requests use a
15-second baseline and never precede `retryAfterMs`. Cooldown deadlines survive
visibility changes. Each viewer serializes requests, including an aborted
transport still settling after a ref change.

Hiding, navigating away, unmounting, switching off, losing thread access, queuing,
ending or replacing a run cancels demand and rejects late responses. An
`ineligible`, 401, 403 or 404 response clears dynamic copy and stops retries for
that run identity. An unavailable, malformed or failed optional response keeps
the current run's last usable phrase (or the existing generic indicator) and
backs off at least 60 seconds, stopping after three consecutive failures.

Cached `pending`, `cooldown` and `stale` phrases keep their actual
`summaryRevision`, sequence, message cursor and completion time. Hashes are
opaque; only monotonic summary provenance may replace current copy. Identical
text preserves the mounted typewriter; changed text restarts it even after
commentary or a completed animation. Run status remains the existing programmatic
projection. All dynamic copy stays in transient page state, outside chat events,
browser persistence, history and model context.

Normal-send preparation suppresses automatic initial thinking for enabled
owners through the shared gate used by both retained scheduling branches. The
producer rechecks canonical overrides before starting a model request, covering
work scheduled before activation. Already-started provider calls cannot be
recalled. Thread-title generation and the main model are independent and remain
unchanged. Current normal sends all enter queue-first; the retained
associated-message scheduling branch has no reachable normal-send caller.

## Deployment and rollout

The migration only creates an empty table and index; it changes no existing
persisted contract and backfills no historical rows. Existing API/Runner/App
versions continue their current paths. Apply the additive migration before
activating readers/writers; normal API production promotion already enforces
that ordering. The staff-cohort configuration adds no migration, backfill or
production override mutation.

The staff default takes effect only after a subsequent release containing this
registry change is deployed. Merging the configuration does not establish
production activation. General availability remains off; no additional user,
email or organization exceptions are added, and the shared staff identity list
and override scope are unchanged.

New App against an older API without this endpoint receives 404 and retains the
generic indicator without repeated requests. Older Apps against a new API retain
their generic indicator for enabled runs because opening-copy generation is
suppressed. Switch rollback restores the legacy path for subsequent runs; it
does not backfill opening copy into an already-created run. A staff user's
explicit `false` override provides an individual opt-out. Removing
`enabledOrgIdHashes` from this registry entry restores the no-cohort source
default without changing the shared staff identity list or stored overrides.

The Epic #32819 controller owns independent acceptance of the merged change,
subsequent release coordination, and production behavior and billing
verification. Visible/hidden/never-viewed demand, the shared 15-second attempt
bound, provider cooldown/fallback/recovery, and measured model-call traffic and
costs remain pending production acceptance. The Epic also owns removal of the
mixed-version fallback once older API rollback targets are retired.
