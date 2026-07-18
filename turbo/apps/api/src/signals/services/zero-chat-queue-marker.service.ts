import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { and, eq, sql } from "drizzle-orm";

import type { Db } from "../external/db";
import {
  deleteChatMessage,
  insertChatMessage,
} from "./zero-chat-message.service";

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

  await insertChatMessage(tx, {
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
  const markers = await tx
    .select({
      id: chatMessages.id,
      chatThreadId: chatMessages.chatThreadId,
      runGroupId: chatMessages.runGroupId,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, args.runId),
        eq(chatMessages.role, "assistant"),
        eq(chatMessages.runEventId, QUEUED_RUN_MARKER_EVENT_ID),
        sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM ${chatMessages} AS revoker
          WHERE revoker.revokes_message_id = ${chatMessages.id}
        )`,
      ),
    );

  let notifiedThreadId: string | null = null;
  for (const marker of markers) {
    const inserted = await deleteChatMessage(tx, marker.id, {
      chatThreadId: marker.chatThreadId,
      role: "assistant",
      runId: args.runId,
      runGroupId: marker.runGroupId ?? undefined,
      runEventId: QUEUED_RUN_MARKER_REVOKE_EVENT_ID,
    });
    if (inserted) {
      notifiedThreadId = marker.chatThreadId;
    }
  }

  return notifiedThreadId
    ? { chatThreadId: notifiedThreadId, userId: args.userId }
    : null;
}
