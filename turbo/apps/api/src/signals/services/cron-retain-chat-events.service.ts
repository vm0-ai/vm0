import { z } from "zod";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "@okouai/api-contracts/contracts/chat-event-schema-version";
import { command } from "ccstate";
import { sql, type SQL } from "drizzle-orm";
import {
  activeInputDeliveries,
  activeInputDeliveryItems,
} from "@okouai/db/schema/active-input-delivery";
import { agentRuns } from "@okouai/db/schema/agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatEventSearchMessageWatermarks } from "@okouai/db/schema/chat-event-search";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";

import {
  executeRawRows,
  pgTimestampWithoutTimezoneToDateSchema,
} from "../../lib/db-raw-rows";
import { timestampWithoutTimeZone } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { tryLockChatEventRetention } from "./chat-event-retention-lock.service";

const CHAT_EVENT_RETENTION_DAYS = 30;
const CHAT_EVENT_RETENTION_DELETE_LIMIT = 2500;
const CHAT_EVENT_RETENTION_SCAN_LIMIT = 5000;

export interface ChatEventRetentionStats {
  readonly cutoff: string;
  readonly scanLimit: number;
  readonly deleteLimit: number;
  readonly scanned: number;
  readonly candidates: number;
  readonly deleted: number;
  readonly skippedSnapshot: number;
  readonly skippedSearchWatermark: number;
  readonly skippedPendingRunless: number;
  readonly skippedNonterminalRun: number;
  readonly skippedActiveInput: number;
  readonly skippedBatchLimit: number;
  readonly hasMore: boolean;
  readonly overlapPrevented: boolean;
  readonly durationMs: number;
}

type ChatEventRetentionScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "fixtures";
      readonly chatThreadIds: readonly string[];
    };

type ChatEventRetentionDb = Pick<Db, "execute" | "transaction">;

const cutoffRowSchema = z.object({
  cutoff: pgTimestampWithoutTimezoneToDateSchema,
});

const retentionRowSchema = z.object({
  scanned: z.int().nonnegative(),
  candidates: z.int().nonnegative(),
  deleted: z.int().nonnegative(),
  skippedSnapshot: z.int().nonnegative(),
  skippedSearchWatermark: z.int().nonnegative(),
  skippedPendingRunless: z.int().nonnegative(),
  skippedNonterminalRun: z.int().nonnegative(),
  skippedActiveInput: z.int().nonnegative(),
  skippedBatchLimit: z.int().nonnegative(),
});

const hasMoreRowSchema = z.object({ hasMore: z.boolean() });

async function loadRetentionCutoff(db: Pick<Db, "execute">): Promise<Date> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT (
        timezone('UTC', transaction_timestamp())
        - ${CHAT_EVENT_RETENTION_DAYS} * interval '1 day'
      )::timestamp AS cutoff
    `,
    cutoffRowSchema,
  );
  const cutoff = rows[0]?.cutoff;
  if (cutoff === undefined) {
    throw new Error("Chat event retention cutoff query returned no row");
  }
  return cutoff;
}

function retentionScopePredicate(scope: ChatEventRetentionScope): SQL {
  if (scope.kind === "global") {
    return sql`true`;
  }
  if (scope.chatThreadIds.length === 0) {
    return sql`false`;
  }
  return sql`event.chat_thread_id IN (${sql.join(
    scope.chatThreadIds.map((chatThreadId) => {
      return sql`${chatThreadId}::uuid`;
    }),
    sql`, `,
  )})`;
}

function retentionSafetyAndSelectionSql(cutoff: string): SQL {
  return sql`
    classified AS MATERIALIZED (
      SELECT
        event.*,
        CASE
          WHEN NOT EXISTS (
              SELECT 1
              FROM ${chatEventSnapshots} snapshot
              WHERE snapshot.chat_thread_id = event.chat_thread_id
                AND snapshot.archive_schema_version
                  = ${CURRENT_CHAT_EVENT_SCHEMA_VERSION}
                AND snapshot.projection = 'tool-redacted'
                AND snapshot.last_seq_id >= event.seq_id
                AND snapshot.object_key ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'
            )
            THEN 'snapshot'
          WHEN watermark.chat_thread_id IS NULL
            OR watermark.indexed_seq_id < event.seq_id
            THEN 'search_watermark'
          WHEN event.run_id IS NULL
            AND event.event_type IN (
              'input.prompt',
              'input.automation',
              'input.goal',
              'input.budget'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM ${chatEvents} pending_revoker
              WHERE pending_revoker.revokes_event_id = event.id
            )
            THEN 'pending_runless'
          WHEN run.id IS NOT NULL
            AND run.status NOT IN ('completed', 'failed', 'timeout', 'cancelled')
            THEN 'nonterminal_run'
          WHEN EXISTS (
            SELECT 1
            FROM ${activeInputDeliveryItems} delivery_item
            INNER JOIN ${activeInputDeliveries} delivery
              ON delivery.id = delivery_item.delivery_id
            WHERE delivery_item.source_event_id = event.id
              AND (
                delivery.status = 'open'
                OR delivery_item.disposition IS NULL
              )
          )
            THEN 'active_input'
          ELSE NULL
        END AS skip_reason
      FROM locked_events event
      LEFT JOIN ${chatEventSearchMessageWatermarks} watermark
        ON watermark.chat_thread_id = event.chat_thread_id
      LEFT JOIN ${agentRuns} run ON run.id = event.run_id
    ),
    selected_events AS MATERIALIZED (
      SELECT classified.id
      FROM classified
      WHERE classified.skip_reason IS NULL
      ORDER BY classified.created_at ASC, classified.id ASC
      LIMIT ${CHAT_EVENT_RETENTION_DELETE_LIMIT}
    ),
    deleted_rows AS (
      DELETE FROM ${chatEvents} event
      USING selected_events
      WHERE event.id = selected_events.id
        AND event.created_at < ${cutoff}::timestamp
      RETURNING event.id
    )
  `;
}

function retentionSummarySql(): SQL {
  return sql`
    SELECT
      count(*)::int AS scanned,
      count(*) FILTER (WHERE classified.skip_reason IS NULL)::int
        AS candidates,
      (SELECT count(*)::int FROM deleted_rows) AS deleted,
      count(*) FILTER (
        WHERE classified.skip_reason = 'snapshot'
      )::int AS "skippedSnapshot",
      count(*) FILTER (
        WHERE classified.skip_reason = 'search_watermark'
      )::int AS "skippedSearchWatermark",
      count(*) FILTER (
        WHERE classified.skip_reason = 'pending_runless'
      )::int AS "skippedPendingRunless",
      count(*) FILTER (
        WHERE classified.skip_reason = 'nonterminal_run'
      )::int AS "skippedNonterminalRun",
      count(*) FILTER (
        WHERE classified.skip_reason = 'active_input'
      )::int AS "skippedActiveInput",
      (
        count(*) FILTER (WHERE classified.skip_reason IS NULL)
        - (SELECT count(*) FROM deleted_rows)
      )::int AS "skippedBatchLimit"
    FROM classified
  `;
}

function retainChatEventsSql(
  cutoff: string,
  scope: ChatEventRetentionScope,
): SQL {
  return sql`
    WITH locked_events AS MATERIALIZED (
      SELECT
        event.id,
        event.chat_thread_id,
        event.run_id,
        event.event_type,
        event.seq_id,
        event.created_at
      FROM ${chatEvents} event
      WHERE event.created_at < ${cutoff}::timestamp
        AND ${retentionScopePredicate(scope)}
      ORDER BY event.created_at ASC, event.id ASC
      LIMIT ${CHAT_EVENT_RETENTION_SCAN_LIMIT}
      FOR UPDATE OF event SKIP LOCKED
    ),
    ${retentionSafetyAndSelectionSql(cutoff)}
    ${retentionSummarySql()}
  `;
}

async function hasMoreRetainableRows(
  db: Pick<Db, "execute">,
  cutoff: string,
  scope: ChatEventRetentionScope,
): Promise<boolean> {
  const rows = await executeRawRows(
    db,
    sql`
      SELECT EXISTS (
        SELECT 1
        FROM ${chatEvents} event
        INNER JOIN ${chatEventSearchMessageWatermarks} watermark
          ON watermark.chat_thread_id = event.chat_thread_id
         AND watermark.indexed_seq_id >= event.seq_id
        LEFT JOIN ${agentRuns} run ON run.id = event.run_id
        WHERE event.created_at < ${cutoff}::timestamp
          AND ${retentionScopePredicate(scope)}
          AND EXISTS (
            SELECT 1
            FROM ${chatEventSnapshots} snapshot
            WHERE snapshot.chat_thread_id = event.chat_thread_id
              AND snapshot.archive_schema_version
                = ${CURRENT_CHAT_EVENT_SCHEMA_VERSION}
              AND snapshot.projection = 'tool-redacted'
              AND snapshot.last_seq_id >= event.seq_id
              AND snapshot.object_key ~ '-[0-9a-f]{64}[.]ndjson[.]gz$'
          )
          AND NOT (
            event.run_id IS NULL
            AND event.event_type IN (
              'input.prompt',
              'input.automation',
              'input.goal',
              'input.budget'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM ${chatEvents} pending_revoker
              WHERE pending_revoker.revokes_event_id = event.id
            )
          )
          AND (
            run.id IS NULL
            OR run.status IN ('completed', 'failed', 'timeout', 'cancelled')
          )
          AND NOT EXISTS (
            SELECT 1
            FROM ${activeInputDeliveryItems} delivery_item
            INNER JOIN ${activeInputDeliveries} delivery
              ON delivery.id = delivery_item.delivery_id
            WHERE delivery_item.source_event_id = event.id
              AND (
                delivery.status = 'open'
                OR delivery_item.disposition IS NULL
              )
          )
        LIMIT 1
      ) AS "hasMore"
    `,
    hasMoreRowSchema,
  );
  const hasMore = rows[0]?.hasMore;
  if (hasMore === undefined) {
    throw new Error("Chat event retention remainder query returned no row");
  }
  return hasMore;
}

async function retainChatEventBatch(
  db: ChatEventRetentionDb,
  scope: ChatEventRetentionScope,
  signal: AbortSignal,
): Promise<Omit<ChatEventRetentionStats, "durationMs">> {
  return await db.transaction(async (tx) => {
    const cutoffDate = await loadRetentionCutoff(tx);
    const cutoff = timestampWithoutTimeZone(cutoffDate);
    const acquired = await tryLockChatEventRetention(tx);
    signal.throwIfAborted();
    if (!acquired) {
      return {
        cutoff: cutoffDate.toISOString(),
        scanLimit: CHAT_EVENT_RETENTION_SCAN_LIMIT,
        deleteLimit: CHAT_EVENT_RETENTION_DELETE_LIMIT,
        scanned: 0,
        candidates: 0,
        deleted: 0,
        skippedSnapshot: 0,
        skippedSearchWatermark: 0,
        skippedPendingRunless: 0,
        skippedNonterminalRun: 0,
        skippedActiveInput: 0,
        skippedBatchLimit: 0,
        hasMore: false,
        overlapPrevented: true,
      };
    }

    const rows = await executeRawRows(
      tx,
      retainChatEventsSql(cutoff, scope),
      retentionRowSchema,
    );
    const retention = rows[0];
    if (retention === undefined) {
      throw new Error("Chat event retention query returned no summary row");
    }
    signal.throwIfAborted();
    const hasMore = await hasMoreRetainableRows(tx, cutoff, scope);
    signal.throwIfAborted();
    return {
      cutoff: cutoffDate.toISOString(),
      scanLimit: CHAT_EVENT_RETENTION_SCAN_LIMIT,
      deleteLimit: CHAT_EVENT_RETENTION_DELETE_LIMIT,
      ...retention,
      hasMore,
      overlapPrevented: false,
    };
  });
}

export const retainChatEvents$ = command(
  async (
    { set },
    scope: ChatEventRetentionScope,
    signal: AbortSignal,
  ): Promise<ChatEventRetentionStats> => {
    const startedAt = performance.now();
    const result = await retainChatEventBatch(set(writeDb$), scope, signal);
    const stats = {
      ...result,
      durationMs: Math.round(performance.now() - startedAt),
    };
    return stats;
  },
);
