import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { and, eq, notExists } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Db } from "../external/db";
import {
  deleteChatMessage,
  insertChatMessage,
} from "./zero-chat-message.service";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const QUEUED_RUN_ASSISTANT_MESSAGE = "Waiting in queue...";

const QUEUED_RUN_MARKER_EVENT_ID = "queue:queued";

const revoker = alias(chatMessages, "revoker");
const QUEUED_RUN_MARKER_REVOKE_EVENT_ID = "queue:dequeued";

export interface QueueMarkerRevokeNotification {
  readonly chatThreadId: string;
  readonly userId: string;
}

export type QueuedRunMarkerAppendResult =
  | { readonly kind: "not-queued" }
  | { readonly kind: "existing" }
  | { readonly kind: "appended"; readonly markerId: string };

export async function appendQueuedRunAssistantMarker(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly runId: string;
    readonly runGroupId?: string;
    readonly createdAfter?: Date;
  },
): Promise<QueuedRunMarkerAppendResult> {
  const [run] = await tx
    .select({ status: agentRuns.status })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .for("update");
  if (run?.status !== "queued") {
    return { kind: "not-queued" };
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
    return { kind: "existing" };
  }

  const marker = await insertChatMessage(tx, {
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
  if (!marker) {
    return { kind: "existing" };
  }
  return { kind: "appended", markerId: marker.id };
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
        notExists(
          tx
            .select({ one: revoker.id })
            .from(revoker)
            .where(eq(revoker.revokesMessageId, chatMessages.id)),
        ),
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
