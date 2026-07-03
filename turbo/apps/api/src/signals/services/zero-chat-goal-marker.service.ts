import {
  chatMessages,
  type ChatMessageGoalEvent,
} from "@vm0/db/schema/chat-message";
import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

/**
 * Goal state is published into the chat thread as assistant control messages so
 * the web client can fold the current goal state from the message stream
 * without calling the goal API for display. Marker rows are not conversation:
 * they carry only goal_event, and transcript/search/unread queries exclude
 * them.
 */
export async function appendGoalEventMarker(
  tx: Pick<Db, "insert">,
  args: {
    readonly chatThreadId: string;
    readonly event: ChatMessageGoalEvent;
  },
): Promise<void> {
  await tx.insert(chatMessages).values({
    chatThreadId: args.chatThreadId,
    role: "assistant",
    content: null,
    runId: null,
    runEventId: null,
    goalEvent: args.event,
  });
}

export function activeGoalEvent(objectiveBrief: string): ChatMessageGoalEvent {
  return { type: "state", status: "active", objectiveBrief };
}

export function hiddenGoalStateEvent(
  status: "paused" | "blocked" | "complete",
): ChatMessageGoalEvent {
  return { type: "state", status };
}

export function clearedGoalEvent(): ChatMessageGoalEvent {
  return { type: "cleared" };
}

/**
 * Exclude goal marker rows from queries where control rows must not affect
 * user-visible chat semantics. The message-list endpoint does not apply this
 * because the client needs markers to fold active-goal display state.
 */
export function excludeGoalMarkerCondition() {
  return sql<boolean>`NOT (
      ${chatMessages.role} = 'assistant'
      AND ${chatMessages.goalEvent} IS NOT NULL
    )`;
}
