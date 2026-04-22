import { initServices } from "../../lib/init-services";
import {
  featureCandidateVoiceChatSessions,
  featureCandidateVoiceChatTasks,
} from "../../db/schema/voice-chat-candidate";
import { uniqueId } from "../test-helpers";

/**
 * Insert a "done" task row for a voice-chat-candidate session directly.
 * @why-db-direct Compaction tests need to construct specific result lengths and
 * resultUpdatedAt timestamps that no public API would produce — these edge-case
 * states are required to exercise the compaction skip/trigger logic.
 */
export async function insertTestVoiceChatCandidateTask(
  sessionId: string,
  overrides: {
    result?: string;
    resultUpdatedAt?: Date;
    status?: "pending" | "queued" | "running" | "done" | "failed";
  } = {},
): Promise<string> {
  initServices();
  const twoMinutesAgo = new Date(Date.now() - 120_000);
  const status = overrides.status ?? "done";
  const isFinished = status === "done" || status === "failed";
  const [row] = await globalThis.services.db
    .insert(featureCandidateVoiceChatTasks)
    .values({
      sessionId,
      callId: uniqueId("call"),
      prompt: "Summarize the situation",
      status,
      result: overrides.result ?? "A".repeat(500) + " important data",
      resultUpdatedAt: overrides.resultUpdatedAt ?? twoMinutesAgo,
      finishedAt: isFinished ? twoMinutesAgo : null,
    })
    .returning({ id: featureCandidateVoiceChatTasks.id });
  return row!.id;
}

/**
 * Insert a voice-chat-candidate session directly.
 * @why-db-direct Cron tests need to construct impossible states (stuck
 * reasoner) that no public API would produce.
 */
export async function insertTestVoiceChatCandidateSession(overrides: {
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
    .insert(featureCandidateVoiceChatSessions)
    .values({
      orgId: overrides.orgId,
      userId: overrides.userId,
      agentId: overrides.agentId ?? null,
      reasoningStatus: overrides.reasoningStatus ?? "idle",
      lastSummaryAt: overrides.lastSummaryAt ?? null,
      createdAt: overrides.createdAt ?? now,
    })
    .returning({ id: featureCandidateVoiceChatSessions.id });
  return row!.id;
}
