import { initServices } from "../../lib/init-services";
import { voiceChatSessions } from "@vm0/db/schema/voice-chat";

/**
 * Insert a voice-chat session directly.
 * @why-db-direct Route parity and cron tests need explicit row states
 * (cross-org rows, bulk lists, stuck reasoner) that no public API would
 * produce without exercising unrelated behavior.
 */
export async function insertTestVoiceChatSession(overrides: {
  orgId: string;
  userId: string;
  agentId?: string | null;
  reasoningStatus?: "idle" | "running";
  lastSummaryAt?: Date | null;
  createdAt?: Date;
}): Promise<string> {
  initServices();
  const now = new Date();
  const [row] = await globalThis.services.db
    .insert(voiceChatSessions)
    .values({
      orgId: overrides.orgId,
      userId: overrides.userId,
      agentId: overrides.agentId ?? null,
      reasoningStatus: overrides.reasoningStatus ?? "idle",
      lastSummaryAt: overrides.lastSummaryAt ?? null,
      createdAt: overrides.createdAt ?? now,
    })
    .returning({ id: voiceChatSessions.id });
  return row!.id;
}
