import { command } from "ccstate";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNull,
  lt,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { chatThreadEvents } from "@vm0/db/schema/chat-thread-event";
import { chatThreadSnapshots } from "@vm0/db/schema/chat-thread-snapshot";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { z } from "zod";
import { executeRawRows } from "../../lib/db-raw-rows";
import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  withCronPassLog,
  type CronPassFields,
  type CronPassResult,
} from "./cron-pass-log.service";

interface SnapshotCompactionStats {
  readonly scopes: number;
  readonly eventsApplied: number;
  readonly removedDeletedAgentThreads: number;
  readonly eventsPruned: number;
}

type SnapshotRootDb = Pick<Db, "execute" | "select" | "transaction">;
const CHAT_THREAD_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_CHAT_THREAD_SNAPSHOT_BATCH_SIZE = 500;
const CHAT_THREAD_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;
const snapshot = alias(chatThreadSnapshots, "snapshot");
const event = alias(chatThreadEvents, "event");
const marker = alias(chatThreadEvents, "marker");
const thread = alias(chatThreads, "thread");
const agent = alias(agentComposes, "agent");

function chatThreadSnapshotBatchSize(): number {
  const raw = optionalEnv("CHAT_THREAD_SNAPSHOT_COMPACTION_BATCH_SIZE");
  if (raw === undefined) {
    return DEFAULT_CHAT_THREAD_SNAPSHOT_BATCH_SIZE;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      "CHAT_THREAD_SNAPSHOT_COMPACTION_BATCH_SIZE must be a positive integer",
    );
  }
  return parsed;
}

const snapshotBatchRowSchema = z.object({
  scopes: z.int(),
  eventsApplied: z.int(),
  removedDeletedAgentThreads: z.int(),
});

const prunedEventsRowSchema = z.object({ count: z.int() });
const snapshotProgressRowSchema = z.object({
  targetScopes: z.int(),
  snapshotScopes: z.int(),
  pendingScopes: z.int(),
  staleScopes: z.int(),
});

const COMPACT_CRON = "compact-chat-thread-snapshots";

function allScopesCte(): SQL {
  return sql`
    all_scopes AS (
      SELECT ${chatThreads.userId} AS user_id, ${agentComposes.orgId} AS org_id
      FROM ${chatThreads}
      INNER JOIN ${agentComposes}
        ON ${eq(agentComposes.id, chatThreads.agentComposeId)}

      UNION

      SELECT ${chatThreadEvents.userId} AS user_id, ${chatThreadEvents.orgId} AS org_id
      FROM ${chatThreadEvents}

      UNION

      SELECT ${chatThreadSnapshots.userId} AS user_id, ${chatThreadSnapshots.orgId} AS org_id
      FROM ${chatThreadSnapshots}
    )
  `;
}

function scopeSnapshotLatestEventJoin(): SQL {
  return sql`
    all_scopes scope
    LEFT JOIN ${chatThreadSnapshots} ${snapshot}
      ON ${and(
        eq(snapshot.userId, sql`scope.user_id`),
        eq(snapshot.orgId, sql`scope.org_id`),
      )}
    LEFT JOIN LATERAL (
      SELECT event.id, event.seq_id
      FROM ${chatThreadEvents} ${event}
      WHERE ${and(
        eq(event.userId, sql`scope.user_id`),
        eq(event.orgId, sql`scope.org_id`),
      )}
      ORDER BY ${desc(event.seqId)}
      LIMIT 1
    ) latest_event ON true
  `;
}

function pendingSnapshotScopeCondition(staleCutoff: Date): SQL {
  return sql`${or(
    isNull(snapshot.userId),
    sql`${snapshot.latestEventSeqId} IS DISTINCT FROM latest_event.seq_id`,
    lt(snapshot.updatedAt, staleCutoff),
  )}`;
}

function candidateScopesCte(staleCutoff: Date, batchSize: number): SQL {
  return sql`
    candidate_scopes AS (
      SELECT
        scope.user_id,
        scope.org_id
      FROM ${scopeSnapshotLatestEventJoin()}
      WHERE ${pendingSnapshotScopeCondition(staleCutoff)}
      ORDER BY
        ${asc(snapshot.updatedAt)} NULLS FIRST,
        latest_event.seq_id ASC NULLS FIRST,
        scope.user_id ASC,
        scope.org_id ASC
      LIMIT ${batchSize}
    )
  `;
}

function rebuiltCte(db: Pick<Db, "select">): SQL {
  return sql`
    rebuilt AS (
      SELECT
        scope.user_id,
        scope.org_id,
        latest_event.id AS latest_event_id,
        latest_event.seq_id AS latest_event_seq_id,
        COALESCE(thread_projection.chat_threads, '[]'::jsonb) AS chat_threads,
        events_after_marker.count AS events_applied,
        deleted_agent_threads.count AS removed_deleted_agent_threads
      FROM candidate_scopes scope
      LEFT JOIN ${chatThreadSnapshots} ${snapshot}
        ON ${and(
          eq(snapshot.userId, sql`scope.user_id`),
          eq(snapshot.orgId, sql`scope.org_id`),
        )}
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', thread.id,
            'agentId', thread.agent_compose_id,
            'title', thread.title,
            'sortAt', thread.last_message_at,
            'createdAt', thread.created_at,
            'updatedAt', thread.updated_at,
            'pinnedAt', thread.pinned_at,
            'renamedAt', thread.renamed_at,
            'selectedModel', thread.selected_model,
            'serviceTier', CASE
              WHEN ${eq(thread.codexServiceTier, sql`'fast'`)} THEN 'priority'
              ELSE NULL
            END,
            'computerUseHostId', thread.computer_use_host_id,
            'cloudBrowserEnabled', thread.cloud_browser_enabled
          )
          ORDER BY
            ${asc(isNull(thread.pinnedAt))},
            ${desc(thread.lastMessageAt)},
            ${desc(thread.id)}
        ) AS chat_threads
        FROM ${chatThreads} ${thread}
        INNER JOIN ${agentComposes} ${agent}
          ON ${eq(agent.id, thread.agentComposeId)}
        WHERE ${and(
          eq(thread.userId, sql`scope.user_id`),
          eq(agent.orgId, sql`scope.org_id`),
        )}
      ) thread_projection ON true
      LEFT JOIN LATERAL (
        SELECT event.id, event.seq_id
        FROM ${chatThreadEvents} ${event}
        WHERE ${and(
          eq(event.userId, sql`scope.user_id`),
          eq(event.orgId, sql`scope.org_id`),
        )}
        ORDER BY ${desc(event.seqId)}
        LIMIT 1
      ) latest_event ON true
      LEFT JOIN LATERAL (
        SELECT ${count()}::int AS count
        FROM ${chatThreadEvents} ${event}
        WHERE ${and(
          eq(event.userId, sql`scope.user_id`),
          eq(event.orgId, sql`scope.org_id`),
          or(
            isNull(snapshot.latestEventSeqId),
            gt(event.seqId, snapshot.latestEventSeqId),
          ),
        )}
      ) events_after_marker ON true
      LEFT JOIN LATERAL (
        SELECT ${count()}::int AS count
        FROM jsonb_array_elements(
          COALESCE(${snapshot.chatThreads}, '[]'::jsonb)
        ) AS old_thread(thread)
        WHERE ${notExists(
          db
            .select({ id: agent.id })
            .from(agent)
            .where(
              and(
                eq(agent.id, sql`(old_thread.thread ->> 'agentId')::uuid`),
                eq(agent.orgId, sql`scope.org_id`),
              ),
            ),
        )}
        ) deleted_agent_threads ON true
    )
  `;
}

function upsertedCte(updatedAt: Date): SQL {
  return sql`
    upserted AS (
      INSERT INTO ${chatThreadSnapshots} (
        user_id,
        org_id,
        latest_event_id,
        latest_event_seq_id,
        chat_threads,
        created_at,
        updated_at
      )
      SELECT
        rebuilt.user_id,
        rebuilt.org_id,
        rebuilt.latest_event_id,
        rebuilt.latest_event_seq_id,
        rebuilt.chat_threads,
        ${sql.param(updatedAt, chatThreadSnapshots.createdAt)},
        ${sql.param(updatedAt, chatThreadSnapshots.updatedAt)}
      FROM rebuilt
      ON CONFLICT (user_id, org_id)
      DO UPDATE SET
        latest_event_id = EXCLUDED.latest_event_id,
        latest_event_seq_id = EXCLUDED.latest_event_seq_id,
        chat_threads = EXCLUDED.chat_threads,
        updated_at = EXCLUDED.updated_at
      RETURNING user_id, org_id
    )
  `;
}

function compactChatThreadSnapshotBatchSql(
  db: Pick<Db, "select">,
  args: {
    readonly updatedAt: Date;
    readonly staleCutoff: Date;
    readonly batchSize: number;
  },
): SQL {
  return sql`
    WITH ${allScopesCte()},
    ${candidateScopesCte(args.staleCutoff, args.batchSize)},
    ${rebuiltCte(db)},
    ${upsertedCte(args.updatedAt)}
    SELECT
      ${count()}::int AS "scopes",
      COALESCE(SUM(rebuilt.events_applied), 0)::int AS "eventsApplied",
      COALESCE(SUM(rebuilt.removed_deleted_agent_threads), 0)::int AS "removedDeletedAgentThreads"
    FROM rebuilt
    INNER JOIN upserted
      ON upserted.user_id = rebuilt.user_id
     AND upserted.org_id = rebuilt.org_id
  `;
}

async function compactChatThreadSnapshotBatch(
  db: SnapshotRootDb,
): Promise<Omit<SnapshotCompactionStats, "eventsPruned">> {
  const updatedAt = nowDate();
  const staleCutoff = new Date(
    updatedAt.getTime() - CHAT_THREAD_SNAPSHOT_STALE_MS,
  );
  const rows = await executeRawRows(
    db,
    compactChatThreadSnapshotBatchSql(db, {
      updatedAt,
      staleCutoff,
      batchSize: chatThreadSnapshotBatchSize(),
    }),
    snapshotBatchRowSchema,
  );

  return {
    scopes: rows[0]?.scopes ?? 0,
    eventsApplied: rows[0]?.eventsApplied ?? 0,
    removedDeletedAgentThreads: rows[0]?.removedDeletedAgentThreads ?? 0,
  };
}

/**
 * Snapshot scopes joined to their marker event: the rows that decide which
 * expired events are safe to delete. Shared by the prune statement and by the
 * gauge that reports how many prunable events are still left afterwards.
 */
function markerJoinedSnapshots(): SQL {
  return sql`
    ${chatThreadSnapshots} ${snapshot}
    INNER JOIN ${chatThreadEvents} ${marker}
      ON ${and(
        eq(marker.id, snapshot.latestEventId),
        eq(marker.seqId, snapshot.latestEventSeqId),
        eq(marker.userId, snapshot.userId),
        eq(marker.orgId, snapshot.orgId),
      )}
  `;
}

function prunableEventCondition(cutoff: Date): SQL {
  return sql`${and(
    eq(event.userId, snapshot.userId),
    eq(event.orgId, snapshot.orgId),
    lt(event.createdAt, cutoff),
    lt(event.seqId, marker.seqId),
  )}`;
}

function chatThreadEventRetentionCutoff(): Date {
  return new Date(nowDate().getTime() - CHAT_THREAD_EVENT_RETENTION_MS);
}

/**
 * Absolute compaction progress over the same scope universe and pending
 * predicate as the bounded pass. `pendingScopes` includes every missing,
 * marker-lagging, or stale snapshot still left after the pass.
 */
async function chatThreadSnapshotProgress(
  db: SnapshotRootDb,
): Promise<CronPassFields> {
  const staleCutoff = new Date(
    nowDate().getTime() - CHAT_THREAD_SNAPSHOT_STALE_MS,
  );
  const rows = await executeRawRows(
    db,
    sql`
      WITH ${allScopesCte()}
      SELECT
        ${count()}::int AS "targetScopes",
        ${count(snapshot.userId)}::int AS "snapshotScopes",
        count(*) FILTER (
          WHERE ${pendingSnapshotScopeCondition(staleCutoff)}
        )::int AS "pendingScopes",
        count(*) FILTER (
          WHERE ${lt(snapshot.updatedAt, staleCutoff)}
        )::int AS "staleScopes"
      FROM ${scopeSnapshotLatestEventJoin()}
    `,
    snapshotProgressRowSchema,
  );
  const progress = rows[0];
  if (progress === undefined) {
    throw new Error("chat thread snapshot progress query returned no row");
  }
  return progress;
}

/**
 * Size of the compacted source table plus the events the next prune would
 * delete. Every scope keeps its marker event forever, so the row count stays
 * above zero even when retention is healthy; `prunableThreadEvents` is the
 * number that has to stay near zero.
 */
async function chatThreadEventScale(
  db: SnapshotRootDb,
): Promise<CronPassFields> {
  const scaleRows = await db
    .select({
      threadEventRows: count(),
      threadEventBytes: sql`pg_total_relation_size('chat_thread_events')`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("threadEventBytes"),
    })
    .from(chatThreadEvents);
  const scale = scaleRows[0];
  if (scale === undefined) {
    throw new Error("chat thread event scale query returned no row");
  }

  const prunableRows = await executeRawRows(
    db,
    sql`
      SELECT ${count()}::int AS "count"
      FROM ${chatThreadEvents} ${event}, ${markerJoinedSnapshots()}
      WHERE ${prunableEventCondition(chatThreadEventRetentionCutoff())}
    `,
    prunedEventsRowSchema,
  );
  const prunable = prunableRows[0];
  if (prunable === undefined) {
    throw new Error("prunable thread event query returned no row");
  }

  return {
    ...scale,
    prunableThreadEvents: prunable.count,
  };
}

async function compactChatThreadSnapshotsForAllScopes(
  db: SnapshotRootDb,
  signal?: AbortSignal,
): Promise<SnapshotCompactionStats> {
  const compacted = await db.transaction(
    async (tx) => {
      return await compactChatThreadSnapshotBatch(tx);
    },
    { isolationLevel: "repeatable read" },
  );

  signal?.throwIfAborted();
  const pruned = await executeRawRows(
    db,
    sql`
      WITH pruned AS (
        DELETE FROM ${chatThreadEvents} ${event}
        USING ${markerJoinedSnapshots()}
        WHERE ${prunableEventCondition(chatThreadEventRetentionCutoff())}
        RETURNING 1
      )
      SELECT ${count()}::int AS "count"
      FROM pruned
    `,
    prunedEventsRowSchema,
  );

  return {
    scopes: compacted.scopes,
    eventsApplied: compacted.eventsApplied,
    removedDeletedAgentThreads: compacted.removedDeletedAgentThreads,
    eventsPruned: pruned[0]?.count ?? 0,
  };
}

const compactChatThreadSnapshotsPass$ = command(
  async (
    { set },
    signal: AbortSignal,
  ): Promise<CronPassResult<SnapshotCompactionStats>> => {
    const db = set(writeDb$);
    const stats = await compactChatThreadSnapshotsForAllScopes(db, signal);
    const progress = await chatThreadSnapshotProgress(db);
    signal.throwIfAborted();
    const scale = await chatThreadEventScale(db);
    signal.throwIfAborted();
    return {
      result: stats,
      fields: {
        ...progress,
        ...scale,
        passScopes: stats.scopes,
        passEventsApplied: stats.eventsApplied,
        passEventsPruned: stats.eventsPruned,
        passRemovedDeletedAgentThreads: stats.removedDeletedAgentThreads,
      },
    };
  },
);

export const compactChatThreadSnapshots$ = command(
  async ({ set }, signal: AbortSignal): Promise<SnapshotCompactionStats> => {
    return await withCronPassLog(
      COMPACT_CRON,
      set(compactChatThreadSnapshotsPass$, signal),
      signal,
    );
  },
);
