import { initServices } from "../../lib/init-services";
import { featureCandidateVoiceChatSessions } from "../../db/schema/voice-chat-candidate";

/**
 * Insert a voice-chat-candidate session directly.
 * @why-db-direct Cron tests need to construct impossible states (stale
 * heartbeats, stuck reasoner) that no public API would produce.
 */
export async function insertTestVoiceChatCandidateSession(overrides: {
  orgId: string;
  userId: string;
  agentId?: string | null;
  status?: "active" | "ended" | "timeout";
  reasoningStatus?: "idle" | "running";
  lastReasoningAt?: Date | null;
  createdAt?: Date;
  lastHeartbeatAt?: Date;
}): Promise<string> {
  initServices();
  const now = new Date();
  const [row] = await globalThis.services.db
    .insert(featureCandidateVoiceChatSessions)
    .values({
      orgId: overrides.orgId,
      userId: overrides.userId,
      agentId: overrides.agentId ?? null,
      status: overrides.status ?? "active",
      reasoningStatus: overrides.reasoningStatus ?? "idle",
      lastReasoningAt: overrides.lastReasoningAt ?? null,
      createdAt: overrides.createdAt ?? now,
      lastHeartbeatAt: overrides.lastHeartbeatAt ?? now,
    })
    .returning({ id: featureCandidateVoiceChatSessions.id });
  return row!.id;
}
