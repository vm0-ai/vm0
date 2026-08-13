import { CHAT_GOAL_MARKER_EVENT_TYPES } from "@okouai/api-contracts/contracts/chat-events";
import { not, type SQL } from "drizzle-orm";

import { chatEventTypeIn } from "./zero-chat-event-type.service";
import { insertChatEvent } from "./zero-chat-event.service";
import { nonEmptyGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";
import type { Tx } from "../../lib/db-types";

type DbTransaction = Tx;

/**
 * Goal state is published into the chat thread as an assistant UI projection.
 * thread_goals remains authoritative for runtime state and mutations.
 */
export async function appendGoalOpenMarker(
  tx: DbTransaction,
  args: {
    readonly chatThreadId: string;
    readonly objectiveBrief: string;
  },
): Promise<void> {
  await insertChatEvent(tx, {
    chatThreadId: args.chatThreadId,
    eventType: "goal.open",
    content: nonEmptyGoalObjectiveBrief(args.objectiveBrief),
  });
}

export async function appendGoalCloseMarker(
  tx: DbTransaction,
  args: { readonly chatThreadId: string },
): Promise<void> {
  await insertChatEvent(tx, {
    chatThreadId: args.chatThreadId,
    eventType: "goal.close",
    content: null,
  });
}

/**
 * Exclude goal marker rows from queries where control rows must not affect
 * user-visible chat semantics. The message-list endpoint does not apply this
 * because the client needs markers to fold active-goal display state.
 */
export function excludeGoalMarkerCondition() {
  return not(chatEventTypeIn(CHAT_GOAL_MARKER_EVENT_TYPES) as SQL);
}
