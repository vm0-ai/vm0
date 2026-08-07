import type { ChatEventGoalEvent } from "@vm0/db/schema/chat-event";
import { CHAT_GOAL_MARKER_EVENT_TYPES } from "@vm0/api-contracts/contracts/chat-events";
import { not, type SQL } from "drizzle-orm";

import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { insertChatEvent } from "./zero-chat-event.service";
import { nonEmptyGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";
import type { Tx } from "../../lib/db-types";

type DbTransaction = Tx;

/**
 * Goal state is published into the chat thread as an assistant UI projection.
 * thread_goals remains authoritative for runtime state and mutations. This
 * Stage 3 writer intentionally keeps the legacy goal.changed + goal_event wire
 * shape until the Stage 5 content-marker cutover.
 */
export async function appendGoalEventMarker(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly event: ChatEventGoalEvent;
  },
): Promise<void> {
  await insertChatEvent(tx, {
    chatThreadId: args.chatThreadId,
    eventType: "goal.changed",
    content: null,
    runId: null,
    runEventId: null,
    goalEvent: args.event,
  });
}

export function activeGoalEvent(objectiveBrief: string): ChatEventGoalEvent {
  return {
    type: "state",
    status: "active",
    objectiveBrief: nonEmptyGoalObjectiveBrief(objectiveBrief),
  };
}

export function hiddenGoalStateEvent(
  status: "paused" | "blocked" | "complete",
): ChatEventGoalEvent {
  return { type: "state", status };
}

export function clearedGoalEvent(): ChatEventGoalEvent {
  return { type: "cleared" };
}

/**
 * Exclude goal marker rows from queries where control rows must not affect
 * user-visible chat semantics. The message-list endpoint does not apply this
 * because the client needs markers to fold active-goal display state.
 */
export function excludeGoalMarkerCondition() {
  return not(chatEventTypeIn(CHAT_GOAL_MARKER_EVENT_TYPES) as SQL);
}
