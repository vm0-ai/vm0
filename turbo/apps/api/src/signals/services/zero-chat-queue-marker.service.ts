import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../external/db";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const QUEUED_RUN_ASSISTANT_MESSAGE = "Waiting in queue...";

const QUEUED_RUN_MARKER_EVENT_ID = "queue:queued";
const QUEUED_RUN_MARKER_REVOKE_EVENT_ID = "queue:dequeued";

export interface QueueMarkerRevokeNotification {
  readonly chatThreadId: string;
  readonly userId: string;
}

interface LockedRunStatusRow extends Record<string, unknown> {
  readonly status: string;
}

interface RevokedQueueMarkerRow extends Record<string, unknown> {
  readonly chatThreadId: string;
}

export async function appendQueuedRunAssistantMarker(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly runId: string;
    readonly runGroupId?: string;
    readonly createdAfter?: Date;
  },
): Promise<void> {
  const runRows = await tx.execute<LockedRunStatusRow>(sql`
    SELECT ${agentRuns.status} AS "status"
    FROM ${agentRuns}
    WHERE ${agentRuns.id} = ${args.runId}
    FOR UPDATE
  `);
  const run = runRows.rows[0];
  if (run?.status !== "queued") {
    return;
  }

  const [existing] = await tx
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, args.runId),
        eq(chatMessages.role, "assistant"),
        eq(chatMessages.runEventId, QUEUED_RUN_MARKER_EVENT_ID),
      ),
    )
    .limit(1);
  if (existing) {
    return;
  }

  await tx.insert(chatMessages).values({
    chatThreadId: args.chatThreadId,
    role: "assistant",
    content: QUEUED_RUN_ASSISTANT_MESSAGE,
    runId: args.runId,
    runGroupId: args.runGroupId,
    runEventId: QUEUED_RUN_MARKER_EVENT_ID,
    ...(args.createdAfter
      ? { createdAt: new Date(args.createdAfter.getTime() + 1) }
      : {}),
  });
}

export async function revokeQueuedRunAssistantMarkers(
  tx: DbTransaction,
  args: {
    readonly runId: string;
    readonly userId: string;
  },
): Promise<QueueMarkerRevokeNotification | null> {
  const insertedRows = await tx.execute<RevokedQueueMarkerRow>(sql`
    INSERT INTO chat_messages (
      chat_thread_id,
      role,
      content,
      run_id,
      run_group_id,
      revokes_message_id,
      run_event_id
    )
    SELECT
      marker.chat_thread_id,
      ${"assistant"},
      NULL,
      ${args.runId},
      marker.run_group_id,
      marker.id,
      ${QUEUED_RUN_MARKER_REVOKE_EVENT_ID}
    FROM ${chatMessages} AS marker
    INNER JOIN ${chatThreads} AS thread
      ON thread.id = marker.chat_thread_id
    WHERE marker.run_id = ${args.runId}
      AND marker.role = ${"assistant"}
      AND marker.run_event_id = ${QUEUED_RUN_MARKER_EVENT_ID}
      AND NOT EXISTS (
        SELECT 1
        FROM ${chatMessages} AS revoker
        WHERE revoker.revokes_message_id = marker.id
      )
    FOR KEY SHARE OF thread
    ON CONFLICT (revokes_message_id) DO NOTHING
    RETURNING chat_thread_id AS "chatThreadId"
  `);
  const notifiedThreadId = insertedRows.rows.at(-1)?.chatThreadId ?? null;
  return notifiedThreadId
    ? { chatThreadId: notifiedThreadId, userId: args.userId }
    : null;
}
