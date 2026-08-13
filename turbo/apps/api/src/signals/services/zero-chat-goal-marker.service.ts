import type { Tx } from "../../lib/db-types";
import { insertChatEvent } from "./zero-chat-event.service";
import { nonEmptyGoalObjectiveBrief } from "./zero-goal-objective-brief-normalization.service";

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
