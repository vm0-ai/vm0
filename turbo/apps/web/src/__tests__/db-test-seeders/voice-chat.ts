import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { voiceChatSessions, voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { appendVoiceChatItem } from "../../lib/zero/voice-chat/item-service";
import { createVoiceChatSession } from "../../lib/zero/voice-chat/session-service";
import { uniqueId } from "../test-helpers";

/**
 * Append a conversation item to a voice-chat session via the service
 * layer so test files stay free of direct service imports.
 * @why-service-layer Encapsulates the service call so tests can seed items
 * without importing *-service modules directly.
 */
export async function appendTestVoiceChatItem(params: {
  sessionId: string;
  role: "user" | "assistant" | "task_result" | "system_note";
  content: string | null;
  realtimeItemId?: string | null;
}): Promise<{ seq: number } | null> {
  initServices();
  const row = await appendVoiceChatItem(params);
  return row ? { seq: row.seq } : null;
}

/**
 * Insert a "done" task row for a voice-chat session directly.
 * @why-db-direct Compaction tests need to construct specific result lengths and
 * resultUpdatedAt timestamps that no public API would produce — these edge-case
 * states are required to exercise the compaction skip/trigger logic.
 */
export async function insertTestVoiceChatTask(
  sessionId: string,
  overrides: {
    result?: string;
    resultUpdatedAt?: Date;
    finishedAt?: Date;
    status?: "pending" | "queued" | "running" | "done" | "failed";
  } = {},
): Promise<string> {
  initServices();
  const twoMinutesAgo = new Date(Date.now() - 120_000);
  const status = overrides.status ?? "done";
  const isFinished = status === "done" || status === "failed";
  const [row] = await globalThis.services.db
    .insert(voiceChatTasks)
    .values({
      sessionId,
      callId: uniqueId("call"),
      prompt: "Summarize the situation",
      status,
      result: overrides.result ?? "A".repeat(500) + " important data",
      resultUpdatedAt: overrides.resultUpdatedAt ?? twoMinutesAgo,
      finishedAt: isFinished ? (overrides.finishedAt ?? twoMinutesAgo) : null,
    })
    .returning({ id: voiceChatTasks.id });
  return row!.id;
}

/**
 * Create an active voice-chat session via the service layer.
 * @why-service-layer Reasoner tests need a fully initialised session with a
 * real agentId so triggerReasoning can read the agent's system prompt.
 */
export async function seedTestVoiceChatSession(params: {
  userId: string;
  orgId: string;
  agentId: string;
}): Promise<string> {
  initServices();
  const session = await createVoiceChatSession(params);
  return session.id;
}

/**
 * Force-set a session's summaryVersion and conversationSummary to simulate a
 * concurrent optimistic-update collision during reasoner tests.
 * @why-db-direct No public API produces this mid-flight state; the test needs
 * to race the in-flight reasoner write to verify the CAS drop-silently logic.
 */
export async function simulateConcurrentVoiceChatSessionWrite(
  sessionId: string,
  summaryVersion: number,
  conversationSummary: string,
): Promise<void> {
  initServices();
  await globalThis.services.db
    .update(voiceChatSessions)
    .set({ summaryVersion, conversationSummary })
    .where(eq(voiceChatSessions.id, sessionId));
}

/**
 * Insert a voice-chat session directly.
 * @why-db-direct Cron tests need to construct impossible states (stuck
 * reasoner) that no public API would produce.
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
