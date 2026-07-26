import {
  chatMessages,
  type ChatMessageGoalEvent,
} from "@vm0/db/schema/chat-message";
import { and, eq, isNotNull, not, type SQL } from "drizzle-orm";

import type { Db } from "../external/db";
import { insertChatMessage } from "./zero-chat-message.service";
import { nonEmptyGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Goal state is published into the chat thread as assistant control messages so
 * the web client can fold the current goal state from the message stream
 * without calling the goal API for display. Marker rows are not conversation:
 * they carry only goal_event, and transcript/search/unread queries exclude
 * them.
 */
export async function appendGoalEventMarker(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly event: ChatMessageGoalEvent;
  },
): Promise<void> {
  await insertChatMessage(tx, {
    chatThreadId: args.chatThreadId,
    role: "assistant",
    content: null,
    runId: null,
    runEventId: null,
    goalEvent: args.event,
  });
}

export function activeGoalEvent(objectiveBrief: string): ChatMessageGoalEvent {
  return {
    type: "state",
    status: "active",
    objectiveBrief: nonEmptyGoalObjectiveBrief(objectiveBrief),
  };
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
  return not(
    and(
      eq(chatMessages.role, "assistant"),
      isNotNull(chatMessages.goalEvent),
    ) as SQL,
  );
}
