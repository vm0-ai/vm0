import { chatMessages } from "@vm0/db/schema/chat-message";
import { sql } from "drizzle-orm";

import type { Db } from "../external/db";

/**
 * Goal state is published into the chat thread as assistant marker messages, so
 * the web client can fold the thread's message stream into the current goal
 * state without polling `/api/automations`. Two independent dimensions are
 * emitted at each goal transition — the goal workflow's active state and the
 * goal trigger's enabled state — which the client combines with the same rule
 * the backend `goalResponse` uses (active / blocked / complete).
 *
 * These are control rows, not conversation: the client filters them out of the
 * rendered transcript, and they are excluded from unread and search via
 * `excludeGoalMarkerCondition` so they never light up a thread or surface as a
 * search hit. The workflow markers carry the objective in `content` so the fold
 * can render it; the trigger markers carry no content.
 */
export const GOAL_WORKFLOW_ACTIVE_EVENT_ID = "goal-workflow:active";
export const GOAL_WORKFLOW_INACTIVE_EVENT_ID = "goal-workflow:inactive";
export const GOAL_TRIGGER_ACTIVE_EVENT_ID = "goal-trigger:active";
export const GOAL_TRIGGER_INACTIVE_EVENT_ID = "goal-trigger:inactive";

const GOAL_MARKER_EVENT_IDS = [
  GOAL_WORKFLOW_ACTIVE_EVENT_ID,
  GOAL_WORKFLOW_INACTIVE_EVENT_ID,
  GOAL_TRIGGER_ACTIVE_EVENT_ID,
  GOAL_TRIGGER_INACTIVE_EVENT_ID,
] as const;

type GoalMarkerEventId = (typeof GOAL_MARKER_EVENT_IDS)[number];

/**
 * Append a single goal-state marker row to a thread. Runs inside the same
 * transaction as the state change it records so the marker and the state can
 * never diverge; the caller publishes the realtime message-created signal after
 * the transaction commits.
 */
export async function appendGoalStateMarker(
  tx: Pick<Db, "insert">,
  args: {
    readonly chatThreadId: string;
    readonly eventId: GoalMarkerEventId;
    readonly objective: string | null;
  },
): Promise<void> {
  await tx.insert(chatMessages).values({
    chatThreadId: args.chatThreadId,
    role: "assistant",
    content: args.objective,
    runId: null,
    runEventId: args.eventId,
  });
}

/**
 * Exclude goal marker rows from a query. Goal markers are assistant control
 * rows that must never count toward a thread's unread state or appear in chat
 * search. The message-list endpoint does NOT apply this — the client needs the
 * markers to fold the goal state.
 */
export function excludeGoalMarkerCondition() {
  return sql<boolean>`NOT (
      ${chatMessages.role} = 'assistant'
      AND ${chatMessages.runEventId} IN (
        ${GOAL_WORKFLOW_ACTIVE_EVENT_ID},
        ${GOAL_WORKFLOW_INACTIVE_EVENT_ID},
        ${GOAL_TRIGGER_ACTIVE_EVENT_ID},
        ${GOAL_TRIGGER_INACTIVE_EVENT_ID}
      )
    )`;
}
