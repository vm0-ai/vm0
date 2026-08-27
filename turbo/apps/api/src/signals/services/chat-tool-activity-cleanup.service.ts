import { z } from "zod";
import { PREVIOUS_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Db } from "../external/db";

const CHAT_TOOL_ACTIVITY_CLEANUP_THREAD_SCAN_LIMIT = 1000;
const CHAT_TOOL_ACTIVITY_CLEANUP_DELETE_LIMIT = 2500;
// Stage 3 cleanup API/cron -> retained V6 DB/R2 state: keep the residual Stage
// 2 cleanup pinned to its physical source format. Remove with #29362 after V7
// heads converge, tool/full blockers remain zero, rollback closes, and Stage 4
// retires this cleanup path.
const CHAT_TOOL_ACTIVITY_CLEANUP_SCHEMA_VERSION =
  PREVIOUS_CHAT_EVENT_SCHEMA_VERSION;

export type ChatToolActivityCleanupScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "fixtures";
      readonly chatThreadIds: readonly string[];
      readonly toolCleanupThreadScanLimit?: number;
      readonly toolCleanupDeleteLimit?: number;
      readonly toolCleanupFailAfterMutation?: boolean;
    };

export interface ChatToolActivityCleanupStats {
  readonly toolCleanupThreadScanLimit: number;
  readonly toolCleanupDeleteLimit: number;
  readonly toolCleanupThreadsScanned: number;
  readonly toolCleanupToolThreadsScanned: number;
  readonly toolCleanupToolThreadsCovered: number;
  readonly toolCleanupToolThreadsBlockedMissingRedactedHead: number;
  readonly toolCleanupToolThreadsBlockedRedactedCoverage: number;
  readonly toolCleanupRowsSelected: number;
  readonly toolCleanupRowsDeleted: number;
  readonly toolCleanupFullPointersCovered: number;
  readonly toolCleanupFullPointersRetired: number;
  readonly toolCleanupRemainingRows: number;
  readonly toolCleanupRemainingFullPointers: number;
  readonly toolCleanupHasMore: boolean;
}

type ChatToolActivityCleanupDb = Pick<Db, "execute">;

const lockedThreadRowSchema = z.object({
  chatThreadId: z.uuid(),
});

const lockedSnapshotHeadRowSchema = z.object({
  id: z.uuid(),
  projection: z.enum(["full", "tool-redacted"]),
});

const cleanupRowSchema = z.object({
  threadsScanned: z.int().nonnegative(),
  toolThreadsScanned: z.int().nonnegative(),
  toolThreadsCovered: z.int().nonnegative(),
  toolThreadsBlockedMissingRedactedHead: z.int().nonnegative(),
  toolThreadsBlockedRedactedCoverage: z.int().nonnegative(),
  rowsSelected: z.int().nonnegative(),
  rowsDeleted: z.int().nonnegative(),
  fullPointersCovered: z.int().nonnegative(),
  fullPointersRetired: z.int().nonnegative(),
});

const cleanupConvergenceRowSchema = z.object({
  remainingRows: z.int().nonnegative(),
  remainingFullPointers: z.int().nonnegative(),
});

function cleanupLimits(scope: ChatToolActivityCleanupScope): {
  readonly threadScanLimit: number;
  readonly deleteLimit: number;
} {
  return {
    threadScanLimit:
      scope.kind === "fixtures" &&
      scope.toolCleanupThreadScanLimit !== undefined
        ? scope.toolCleanupThreadScanLimit
        : CHAT_TOOL_ACTIVITY_CLEANUP_THREAD_SCAN_LIMIT,
    deleteLimit:
      scope.kind === "fixtures" && scope.toolCleanupDeleteLimit !== undefined
        ? scope.toolCleanupDeleteLimit
        : CHAT_TOOL_ACTIVITY_CLEANUP_DELETE_LIMIT,
  };
}

function cleanupScopePredicate(
  scope: ChatToolActivityCleanupScope,
  chatThreadId: SQLWrapper,
): SQL {
  if (scope.kind === "global") {
    return sql`true`;
  }
  if (scope.chatThreadIds.length === 0) {
    return sql`false`;
  }
  return uuidListPredicate(chatThreadId, scope.chatThreadIds);
}

function uuidListPredicate(column: SQLWrapper, values: readonly string[]): SQL {
  if (values.length === 0) {
    return sql`false`;
  }
  return sql`${column} IN (${sql.join(
    values.map((value) => {
      return sql`${value}::uuid`;
    }),
    sql`, `,
  )})`;
}

function lockCleanupThreadsSql(
  scope: ChatToolActivityCleanupScope,
  threadScanLimit: number,
): SQL {
  return sql`
    WITH tool_candidate_threads AS MATERIALIZED (
      SELECT event.chat_thread_id
      FROM ${chatEvents} event
      WHERE event.event_type = 'output.tool'
        AND ${cleanupScopePredicate(scope, sql`event.chat_thread_id`)}
      GROUP BY event.chat_thread_id
      ORDER BY event.chat_thread_id ASC
      LIMIT ${threadScanLimit}
    ),
    full_candidate_threads AS MATERIALIZED (
      SELECT snapshot.chat_thread_id
      FROM ${chatEventSnapshots} snapshot
      WHERE snapshot.archive_schema_version
          = ${CHAT_TOOL_ACTIVITY_CLEANUP_SCHEMA_VERSION}
        AND snapshot.projection = 'full'
        AND ${cleanupScopePredicate(scope, sql`snapshot.chat_thread_id`)}
      ORDER BY snapshot.chat_thread_id ASC
      LIMIT ${threadScanLimit}
    ),
    candidate_threads AS MATERIALIZED (
      SELECT
        candidate.chat_thread_id,
        bool_or(candidate.has_tool_rows) AS has_tool_rows
      FROM (
        SELECT tool.chat_thread_id, true AS has_tool_rows
        FROM tool_candidate_threads tool
        UNION ALL
        SELECT full_head.chat_thread_id, false AS has_tool_rows
        FROM full_candidate_threads full_head
      ) candidate
      GROUP BY candidate.chat_thread_id
      ORDER BY bool_or(candidate.has_tool_rows) DESC, candidate.chat_thread_id ASC
      LIMIT ${threadScanLimit}
    )
    SELECT thread.id AS "chatThreadId"
    FROM ${chatThreads} thread
    INNER JOIN candidate_threads candidate
      ON candidate.chat_thread_id = thread.id
    ORDER BY candidate.has_tool_rows DESC, thread.id ASC
    LIMIT ${threadScanLimit}
    FOR UPDATE OF thread SKIP LOCKED
  `;
}

function lockCleanupSnapshotHeadsSql(chatThreadIds: readonly string[]): SQL {
  return sql`
    SELECT
      snapshot.id,
      snapshot.projection
    FROM ${chatEventSnapshots} snapshot
    WHERE snapshot.archive_schema_version
        = ${CHAT_TOOL_ACTIVITY_CLEANUP_SCHEMA_VERSION}
      AND snapshot.projection IN ('full', 'tool-redacted')
      AND ${uuidListPredicate(sql`snapshot.chat_thread_id`, chatThreadIds)}
    ORDER BY snapshot.chat_thread_id ASC, snapshot.projection ASC
    FOR UPDATE OF snapshot SKIP LOCKED
  `;
}

function cleanupLockedThreadsCte(chatThreadIds: readonly string[]): SQL {
  return sql`
    locked_threads AS MATERIALIZED (
      SELECT thread.id AS chat_thread_id
      FROM ${chatThreads} thread
      WHERE ${uuidListPredicate(sql`thread.id`, chatThreadIds)}
    )
  `;
}

function cleanupCoverageCtes(
  fullHeadIds: readonly string[],
  redactedHeadIds: readonly string[],
): SQL {
  return sql`
    full_heads AS MATERIALIZED (
      SELECT
        snapshot.id,
        snapshot.chat_thread_id,
        snapshot.last_seq_id
      FROM ${chatEventSnapshots} snapshot
      INNER JOIN locked_threads locked
        ON locked.chat_thread_id = snapshot.chat_thread_id
      WHERE ${uuidListPredicate(sql`snapshot.id`, fullHeadIds)}
        AND snapshot.archive_schema_version
          = ${CHAT_TOOL_ACTIVITY_CLEANUP_SCHEMA_VERSION}
        AND snapshot.projection = 'full'
    ),
    redacted_heads AS MATERIALIZED (
      SELECT
        snapshot.id,
        snapshot.chat_thread_id,
        snapshot.last_seq_id,
        snapshot.object_key
      FROM ${chatEventSnapshots} snapshot
      INNER JOIN locked_threads locked
        ON locked.chat_thread_id = snapshot.chat_thread_id
      WHERE ${uuidListPredicate(sql`snapshot.id`, redactedHeadIds)}
        AND snapshot.archive_schema_version
          = ${CHAT_TOOL_ACTIVITY_CLEANUP_SCHEMA_VERSION}
        AND snapshot.projection = 'tool-redacted'
    ),
    thread_state AS MATERIALIZED (
      SELECT
        locked.chat_thread_id,
        full_head.id AS full_head_id,
        full_head.last_seq_id AS full_head_last_seq_id,
        redacted_head.id AS redacted_head_id,
        redacted_head.last_seq_id AS redacted_head_last_seq_id,
        redacted_head.object_key AS redacted_head_object_key,
        tool_bound.max_tool_seq_id
      FROM locked_threads locked
      LEFT JOIN full_heads full_head
        ON full_head.chat_thread_id = locked.chat_thread_id
      LEFT JOIN redacted_heads redacted_head
        ON redacted_head.chat_thread_id = locked.chat_thread_id
      LEFT JOIN LATERAL (
        SELECT event.seq_id AS max_tool_seq_id
        FROM ${chatEvents} event
        WHERE event.chat_thread_id = locked.chat_thread_id
          AND event.event_type = 'output.tool'
        ORDER BY event.seq_id DESC
        LIMIT 1
      ) tool_bound ON true
    ),
    classified_threads AS MATERIALIZED (
      SELECT
        state.*,
        (
          state.redacted_head_id IS NOT NULL
          AND state.redacted_head_last_seq_id > 0
          AND state.redacted_head_object_key
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'
        ) AS redacted_head_durable,
        (
          state.max_tool_seq_id IS NOT NULL
          AND state.redacted_head_id IS NOT NULL
          AND state.redacted_head_last_seq_id > 0
          AND state.redacted_head_object_key
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'
          AND state.redacted_head_last_seq_id >= state.max_tool_seq_id
        ) AS tool_rows_covered,
        (
          state.full_head_id IS NOT NULL
          AND state.redacted_head_id IS NOT NULL
          AND state.redacted_head_last_seq_id > 0
          AND state.redacted_head_object_key
            ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'
          AND state.redacted_head_last_seq_id >= state.full_head_last_seq_id
          AND (
            state.max_tool_seq_id IS NULL
            OR state.redacted_head_last_seq_id >= state.max_tool_seq_id
          )
        ) AS full_pointer_covered
      FROM thread_state state
    )
  `;
}

function cleanupMutationCtes(deleteLimit: number): SQL {
  return sql`
    selected_tool_rows AS MATERIALIZED (
      SELECT event.id
      FROM ${chatEvents} event
      INNER JOIN classified_threads thread_state
        ON thread_state.chat_thread_id = event.chat_thread_id
      WHERE thread_state.tool_rows_covered
        AND event.event_type = 'output.tool'
      ORDER BY event.chat_thread_id ASC, event.seq_id ASC
      LIMIT ${deleteLimit}
      FOR UPDATE OF event SKIP LOCKED
    ),
    deleted_tool_rows AS (
      DELETE FROM ${chatEvents} event
      USING selected_tool_rows selected
      WHERE event.id = selected.id
        AND event.event_type = 'output.tool'
      RETURNING event.id
    ),
    retired_full_pointers AS (
      DELETE FROM ${chatEventSnapshots} snapshot
      USING classified_threads thread_state
      WHERE thread_state.full_pointer_covered
        AND snapshot.id = thread_state.full_head_id
        AND snapshot.archive_schema_version
          = ${CHAT_TOOL_ACTIVITY_CLEANUP_SCHEMA_VERSION}
        AND snapshot.projection = 'full'
      RETURNING snapshot.id
    )
  `;
}

function cleanupSql(
  chatThreadIds: readonly string[],
  fullHeadIds: readonly string[],
  redactedHeadIds: readonly string[],
  deleteLimit: number,
): SQL {
  return sql`
    WITH
    ${cleanupLockedThreadsCte(chatThreadIds)},
    ${cleanupCoverageCtes(fullHeadIds, redactedHeadIds)},
    ${cleanupMutationCtes(deleteLimit)}
    SELECT
      count(*)::int AS "threadsScanned",
      count(*) FILTER (
        WHERE classified_threads.max_tool_seq_id IS NOT NULL
      )::int AS "toolThreadsScanned",
      count(*) FILTER (
        WHERE classified_threads.tool_rows_covered
      )::int AS "toolThreadsCovered",
      count(*) FILTER (
        WHERE classified_threads.max_tool_seq_id IS NOT NULL
          AND NOT classified_threads.redacted_head_durable
      )::int AS "toolThreadsBlockedMissingRedactedHead",
      count(*) FILTER (
        WHERE classified_threads.max_tool_seq_id IS NOT NULL
          AND classified_threads.redacted_head_durable
          AND NOT classified_threads.tool_rows_covered
      )::int AS "toolThreadsBlockedRedactedCoverage",
      (SELECT count(*)::int FROM selected_tool_rows) AS "rowsSelected",
      (SELECT count(*)::int FROM deleted_tool_rows) AS "rowsDeleted",
      count(*) FILTER (
        WHERE classified_threads.full_pointer_covered
      )::int AS "fullPointersCovered",
      (SELECT count(*)::int FROM retired_full_pointers)
        AS "fullPointersRetired"
    FROM classified_threads
  `;
}

function cleanupConvergenceSql(scope: ChatToolActivityCleanupScope): SQL {
  return sql`
    SELECT
      (
        SELECT count(*)::int
        FROM ${chatEvents} event
        WHERE event.event_type = 'output.tool'
          AND ${cleanupScopePredicate(scope, sql`event.chat_thread_id`)}
      ) AS "remainingRows",
      (
        SELECT count(*)::int
        FROM ${chatEventSnapshots} snapshot
        WHERE snapshot.archive_schema_version
            = ${CHAT_TOOL_ACTIVITY_CLEANUP_SCHEMA_VERSION}
          AND snapshot.projection = 'full'
          AND ${cleanupScopePredicate(scope, sql`snapshot.chat_thread_id`)}
      ) AS "remainingFullPointers"
  `;
}

export function skippedChatToolActivityCleanupStats(
  scope: ChatToolActivityCleanupScope,
): ChatToolActivityCleanupStats {
  const limits = cleanupLimits(scope);
  return {
    toolCleanupThreadScanLimit: limits.threadScanLimit,
    toolCleanupDeleteLimit: limits.deleteLimit,
    toolCleanupThreadsScanned: 0,
    toolCleanupToolThreadsScanned: 0,
    toolCleanupToolThreadsCovered: 0,
    toolCleanupToolThreadsBlockedMissingRedactedHead: 0,
    toolCleanupToolThreadsBlockedRedactedCoverage: 0,
    toolCleanupRowsSelected: 0,
    toolCleanupRowsDeleted: 0,
    toolCleanupFullPointersCovered: 0,
    toolCleanupFullPointersRetired: 0,
    toolCleanupRemainingRows: 0,
    toolCleanupRemainingFullPointers: 0,
    toolCleanupHasMore: false,
  };
}

export async function cleanChatToolActivity(
  db: ChatToolActivityCleanupDb,
  scope: ChatToolActivityCleanupScope,
  signal: AbortSignal,
): Promise<ChatToolActivityCleanupStats> {
  const limits = cleanupLimits(scope);
  // Thread event writers reserve their sequence position while holding this
  // same row lock. Coverage is read in a later statement so its READ COMMITTED
  // snapshot includes any stale writer that committed before the lock landed.
  const lockedThreadRows = await executeRawRows(
    db,
    lockCleanupThreadsSql(scope, limits.threadScanLimit),
    lockedThreadRowSchema,
  );
  signal.throwIfAborted();
  const lockedThreadIds = lockedThreadRows.map((row) => {
    return row.chatThreadId;
  });
  const lockedSnapshotHeads =
    lockedThreadIds.length === 0
      ? []
      : await executeRawRows(
          db,
          lockCleanupSnapshotHeadsSql(lockedThreadIds),
          lockedSnapshotHeadRowSchema,
        );
  signal.throwIfAborted();
  const fullHeadIds = lockedSnapshotHeads.flatMap((head) => {
    return head.projection === "full" ? [head.id] : [];
  });
  const redactedHeadIds = lockedSnapshotHeads.flatMap((head) => {
    return head.projection === "tool-redacted" ? [head.id] : [];
  });
  const rows = await executeRawRows(
    db,
    cleanupSql(
      lockedThreadIds,
      fullHeadIds,
      redactedHeadIds,
      limits.deleteLimit,
    ),
    cleanupRowSchema,
  );
  signal.throwIfAborted();
  if (
    scope.kind === "fixtures" &&
    scope.toolCleanupFailAfterMutation === true
  ) {
    throw new Error("Injected failure after tool cleanup mutation");
  }
  const cleanup = rows[0];
  if (cleanup === undefined) {
    throw new Error("Chat tool activity cleanup query returned no summary row");
  }
  const convergenceRows = await executeRawRows(
    db,
    cleanupConvergenceSql(scope),
    cleanupConvergenceRowSchema,
  );
  signal.throwIfAborted();
  const convergence = convergenceRows[0];
  if (convergence === undefined) {
    throw new Error(
      "Chat tool activity cleanup convergence query returned no row",
    );
  }
  return {
    toolCleanupThreadScanLimit: limits.threadScanLimit,
    toolCleanupDeleteLimit: limits.deleteLimit,
    toolCleanupThreadsScanned: cleanup.threadsScanned,
    toolCleanupToolThreadsScanned: cleanup.toolThreadsScanned,
    toolCleanupToolThreadsCovered: cleanup.toolThreadsCovered,
    toolCleanupToolThreadsBlockedMissingRedactedHead:
      cleanup.toolThreadsBlockedMissingRedactedHead,
    toolCleanupToolThreadsBlockedRedactedCoverage:
      cleanup.toolThreadsBlockedRedactedCoverage,
    toolCleanupRowsSelected: cleanup.rowsSelected,
    toolCleanupRowsDeleted: cleanup.rowsDeleted,
    toolCleanupFullPointersCovered: cleanup.fullPointersCovered,
    toolCleanupFullPointersRetired: cleanup.fullPointersRetired,
    toolCleanupRemainingRows: convergence.remainingRows,
    toolCleanupRemainingFullPointers: convergence.remainingFullPointers,
    toolCleanupHasMore:
      convergence.remainingRows > 0 || convergence.remainingFullPointers > 0,
  };
}
