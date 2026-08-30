import { agentSessions } from "@okouai/db/schema/agent-session";
import { checkpoints } from "@okouai/db/schema/checkpoint";
import { conversations } from "@okouai/db/schema/conversation";
import { eq } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { nowDate } from "../../lib/time";

export async function promoteAgentRunCheckpoint(
  tx: Tx,
  runId: string,
  sessionId: string,
  policy: "completion" | "generic-terminal",
): Promise<boolean> {
  const [checkpoint] = await tx
    .select({
      agentSessionPromotionPending: checkpoints.agentSessionPromotionPending,
      cliAgentType: conversations.cliAgentType,
      conversationId: checkpoints.conversationId,
    })
    .from(checkpoints)
    .innerJoin(conversations, eq(conversations.id, checkpoints.conversationId))
    .where(eq(checkpoints.runId, runId))
    .limit(1);
  if (!checkpoint) {
    return false;
  }
  const piCheckpoint = checkpoint.cliAgentType === "pi";
  const eligible = checkpoint.agentSessionPromotionPending
    ? policy === "completion" || !piCheckpoint
    : policy === "completion" && piCheckpoint;
  if (!eligible) {
    return false;
  }

  const [session] = await tx
    .update(agentSessions)
    .set({ conversationId: checkpoint.conversationId, updatedAt: nowDate() })
    .where(eq(agentSessions.id, sessionId))
    .returning({ id: agentSessions.id });
  if (!session) {
    throw new Error("Agent run checkpoint is missing its AgentSession");
  }
  if (checkpoint.agentSessionPromotionPending) {
    const [cleared] = await tx
      .update(checkpoints)
      .set({ agentSessionPromotionPending: false })
      .where(eq(checkpoints.runId, runId))
      .returning({ id: checkpoints.id });
    if (!cleared) {
      throw new Error("Promoted Agent run checkpoint could not be updated");
    }
  }
  return true;
}
