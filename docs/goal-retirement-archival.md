# Goal retirement archival (S2)

Issue [#32797](https://github.com/vm0-ai/vm0/issues/32797) implements S2 of
[#32653](https://github.com/vm0-ai/vm0/issues/32653). The normal production S1
boundary is accepted: creation/reactivation and continuation are retired. The
2026-09-09 03:11 UTC metadata census measured 4,162 Goals across 13 organizations
and 19 owners: 3,819 complete, 141 paused, 200 blocked and two residual active
records. Actual Goal-origin nonterminal runs were zero. All 103,295 original
runless Goal inputs had canonical revokers, with an empty subsequent input tail.
These observations were paginated live reads, not an atomic snapshot.

## Delivery and recovery

`1093_goal_retirement_receipt` adds nullable event-ID/sequence receipt columns
with paired-nullability and positive JavaScript-safe sequence constraints. It
uses the transactional runner's 1-second lock and 10-second statement bounds.
There is deliberately no foreign key to hot events. Outgoing APIs can continue
using their existing columns and writers. Normal release ordering applies the
schema before the new ORM declaration reaches traffic.

`1094_archive_retired_goals` is non-transactional. Its temporary SQL procedure:

- Pages at most 100 unique thread IDs, including unrevoked Goal-input threads
  with no remaining Goal row. It never exports an objective to an application.
- Acquires the existing Goal advisory lock before the thread row lock, then
  rereads the Goal and checks its thread, owner, agent and agent organization.
  A shared agent's owner need not be the thread owner. Pending Goal context
  pointers must not resolve to another thread or owner.
- Appends an ordinary runless `output.message`, preserving the full unchanged
  objective as the content suffix and recording the original status and Goal
  ID in readable text. Only `active` becomes `paused`. One payload-free
  `goal.close`, the receipt and up to 100 canonical revokes commit with it.
  Additional pending inputs use further transactions on that one thread.
- Excludes claimed inputs, existing revokers and unresolved open deliveries.
  An open reservation is a blocker. Sequence allocation advances the locked
  thread counter; revokes retain the target's context and have later sequence
  IDs and timestamps. The operation does not create a run or invoke callbacks,
  notifications, usage writes, shared budgets or queue dispatch.
- Skips contended advisory/thread locks, advances the candidate cursor and
  rejects success if any unarchived, active, true-pending, reserved or actual
  Goal-origin nonterminal state remains. Checks classify runs by
  `trigger_source = 'goal'`, never by historical `goal_id` provenance.

The `CALL` has a 15-minute statement bound, covering the complete 4,162-thread
census rather than resetting a timer on each commit. Lock waits are bounded at
one second; contended initial locks skip immediately. No table lock, trigger
relaxation or new scheduling index is introduced. PostgreSQL tests measure the
pending query at the observed 103,295-input scale using `EXPLAIN (ANALYZE,
BUFFERS)` and also archive 4,162 long synthetic objectives.

On failure, the current thread transaction rolls back and earlier committed
threads remain durable. Error messages contain only phase, SQLSTATE and IDs;
progress/completion notices contain counts. The migration runner writes the
journal only after every statement succeeds. A normal authorized release retry
recreates the procedure and resumes using the receipts, including when an
archive/close has already moved into a valid snapshot. Do not delete receipts,
edit the journal, relax constraints, or reset completed threads to retry.
Resolve ownership, reservation, new-work or lock blockers before retrying.
The implementation PR's merge is not production migration or release evidence.

## Count-only production acceptance

Controller/release owners perform these checks after authorized delivery using
an approved database path. This does not expand the seven-column MaskDB policy.
Do not select objective or payload content into logs or application processes.
Record the exact release, migration journal frontier and query timestamps.

```sql
SELECT status, count(*) FROM thread_goals GROUP BY status ORDER BY status;
SELECT count(*) FILTER (WHERE retirement_archive_event_id IS NULL) AS unarchived,
       count(*) FILTER (WHERE status = 'active') AS active
FROM thread_goals;

WITH unrevoked AS (
  SELECT e.id FROM chat_events e
  WHERE e.event_type = 'input.goal' AND e.run_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM chat_events r WHERE r.revokes_event_id = e.id)
), classified AS (
  SELECT EXISTS (
    SELECT 1 FROM active_input_delivery_items item
    JOIN active_input_deliveries delivery ON delivery.id = item.delivery_id
    WHERE item.source_event_id = e.id AND item.disposition IS NULL
      AND delivery.status = 'open'
  ) AS reserved FROM unrevoked e
)
SELECT count(*) FILTER (WHERE NOT reserved) AS true_pending,
       count(*) FILTER (WHERE reserved) AS open_reservations
FROM classified;

SELECT count(*) AS actual_goal_nonterminal FROM agent_runs
WHERE trigger_source = 'goal' AND status IN ('queued', 'pending', 'running');

-- Exact full-content comparison stays inside PostgreSQL and returns a count.
-- Run promptly while new archive rows are hot; snapshot coverage below is not
-- a substitute for this content check or the canonical history regression.
SELECT count(*) AS invalid_hot_archive
FROM thread_goals g JOIN chat_events e ON e.id = g.retirement_archive_event_id
WHERE e.chat_thread_id IS DISTINCT FROM g.chat_thread_id
   OR e.seq_id IS DISTINCT FROM g.retirement_archive_seq_id
   OR e.event_type <> 'output.message' OR e.run_id IS NOT NULL
   OR e.payload - 'content' IS DISTINCT FROM '{}'::jsonb
   OR right(e.payload->>'content', char_length(g.objective)) IS DISTINCT FROM g.objective;

SELECT count(*) AS receipts_without_hot_or_snapshot_coverage
FROM thread_goals g
WHERE g.retirement_archive_event_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM chat_events e
    WHERE e.id = g.retirement_archive_event_id AND e.chat_thread_id = g.chat_thread_id
      AND e.seq_id = g.retirement_archive_seq_id)
  AND NOT EXISTS (SELECT 1 FROM chat_event_snapshots s
    WHERE s.chat_thread_id = g.chat_thread_id AND s.archive_schema_version = 7
      AND s.last_seq_id >= g.retirement_archive_seq_id
      AND s.object_key ~ '-[0-9a-f]{64}[.]ndjson[.]gz$');
```

All remainder/error counts must be zero. Without concurrent user clears, expected
post-state is 3,819 complete / 143 paused / 200 blocked, with 4,162 receipts.
Reconcile legitimate clears/cascades with the bounded progress counts; never
reconstruct cleared objectives. Verify fresh ordinary-message and historical
read positive controls and inspect relevant migration/API errors. The journal
and count-only completion notice must correspond to this migration, not an
unrelated deployment or chat-run completion.

## Removal point

The procedure is dropped on successful migration; its immutable SQL remains the
replay source. Keep the physical Goal table, receipt columns, `agent_runs.goal_id`
and historical events through S4. Only after the consumer-free S4 release is
serving may S5 recreate this idempotent preservation/settlement operation,
recheck every remainder and preservation gate, then drop obsolete physical
state and its temporary helpers in that later migration. The transition test
stays until the deployed S5 contract completes and surviving history invariants
are covered permanently, per [MIGRATIONS.md](../turbo/packages/db/MIGRATIONS.md).
No elapsed waiting period replaces these gates.

## Literal historical projection (#32834)

The full objective is arbitrary historical text. A citation envelope, unmatched
opener, inline code, fence, Unicode, or whitespace in that suffix is not assistant
citation transport. The reader recognizes **only** the immutable 1094 format:
`output.message`, null run/revoker/context/run-event coordinates, exactly one string
`content` payload key, and the entire frozen notice with a valid UUID and the exact
status-specific explanation. Unknown formats and actual assistant copies keep the
ordinary citation filter. This support has no Goal lifecycle or lookup authority.
Do not rewrite 1093/1094, hot events, snapshots, or append another archive.

| Consumer                                 | Preservation boundary                                                                                                                                                                         |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Raw history, Platform hot/snapshot cache | `chatEventFromRow` uses the strict shared raw-source projection. Raw CLI files remain unchanged.                                                                                              |
| SQL history consumers                    | `canonicalChatEventVisibleContent` carries provenance only in SELECT; `canonicalChatEventContent` retains its original text/null/regex expression for predicates and run-scoped consumers.    |
| Snapshot history and user export         | `canonicalArchivedChatEventContent` uses the same strict raw-source projection, independently of receipts or Goal tables.                                                                     |
| New shares and saved intact shares       | Hot and snapshot selection project first; the saved reader checks absence of run/group indices plus the complete frozen grammar before preserving already-projected text.                     |
| Search projection/results                | Canonical projection preserves exact whitespace; the result reader checks null run ID plus full grammar before avoiding a second filter.                                                      |
| Chat and public-share pages              | Identified runless archives use a text tree with preserved whitespace, without HTML/Markdown interpretation, generated closing tags, or action cards. Copy/export retain the original source. |

The remaining SQL content callers are run-scoped callback/session/incomplete-context
readers, run-bound initial-thinking readers, or input/control/followup validation.
Their selections and text/null/regex predicates retain the previous behavior.
Title/followup context selection uses the provenance-aware projection because its
thread-wide query can include runless historical output. No callback, queue,
notification, usage, budget, or native-runtime policy is changed.

An old search projector can advance its watermark after stripping objective text.
The bounded, idempotent [014 search recovery](../turbo/packages/db/scripts/migrations/014-goal-archive-search/README.md)
reads only receipt-addressed canonical history inside the authorized repair process
and replaces only those derived search documents. Its default is read-only; its
reports contain counts and opaque cursors, never objective text. This operational
processing exception does not expand MaskDB's seven-field policy or authorize an
objective census/export. The separate release owner must run and verify recovery
after the repaired API serves and outgoing projectors finish, before controller S2
acceptance and before S5 removes the repair inventory.

Public shares are intentionally immutable copies. A previously stripped copy is
not automatically changed or republished. Its owner can explicitly create a new
share. This repair establishes that limitation with synthetic fixtures; no affected
production public share inventory has been observed or claimed. Existing raw data
remains lossless. Merge alone establishes neither controller acceptance nor release.
