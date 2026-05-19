import { eq, and } from "drizzle-orm";
import type { VoiceChatTaskResultEntry } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { initServices } from "../../lib/init-services";
import {
  voiceChatItems,
  voiceChatSessions,
  voiceChatTasks,
} from "@vm0/db/schema/voice-chat";

/**
 * Read the full reasoning-related mutable state of a voice-chat
 * session for reasoner integration test assertions.
 * @why-db-direct No public read API exposes individual session summary fields;
 * this encapsulates the DB read so test files stay lint-clean.
 */
export async function getTestVoiceChatSessionReasoningState(
  id: string,
): Promise<
  | {
      conversationSummary: string | null;
      workingTasksSummary: string | null;
      finishedTasksSummary: string | null;
      summarySeq: number;
      summaryVersion: number;
      reasoningStatus: string;
      reasoningPending: boolean;
      lastSummaryAt: Date | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      conversationSummary: voiceChatSessions.conversationSummary,
      workingTasksSummary: voiceChatSessions.workingTasksSummary,
      finishedTasksSummary: voiceChatSessions.finishedTasksSummary,
      summarySeq: voiceChatSessions.summarySeq,
      summaryVersion: voiceChatSessions.summaryVersion,
      reasoningStatus: voiceChatSessions.reasoningStatus,
      reasoningPending: voiceChatSessions.reasoningPending,
      lastSummaryAt: voiceChatSessions.lastSummaryAt,
    })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id));
  return row;
}

/**
 * Read a voice-chat session's mutable state.
 * @why-db-direct Cron tests verify the reasoner state transitions the route
 * handler writes; no read API exists for those internals.
 */
export async function getTestVoiceChatSession(id: string): Promise<
  | {
      reasoningStatus: string;
      lastSummaryAt: Date | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      reasoningStatus: voiceChatSessions.reasoningStatus,
      lastSummaryAt: voiceChatSessions.lastSummaryAt,
    })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, id));
  return row;
}

/**
 * Count voice-chat sessions by `reasoningStatus`, scoped to a single org
 * to keep large-batch assertions hermetic across a shared dev database.
 * @why-db-direct Aggregations across many seeded rows have no API surface.
 */
export async function countTestVoiceChatSessionsByReasoningStatus(
  orgId: string,
  reasoningStatus: "idle" | "running",
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: voiceChatSessions.id })
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.orgId, orgId),
        eq(voiceChatSessions.reasoningStatus, reasoningStatus),
      ),
    );
  return rows.length;
}

/**
 * Read all conversation items for a voice-chat session.
 * @why-db-direct The item list is used to verify side-effects written by
 * triggerReasoning (e.g. system_note appended on reasoner failure); no public
 * read API is available for the voice-chat item table.
 */
export async function readTestVoiceChatItems(sessionId: string): Promise<
  Array<{
    role: string;
    content: string | null;
    seq: number;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      role: voiceChatItems.role,
      content: voiceChatItems.content,
      seq: voiceChatItems.seq,
    })
    .from(voiceChatItems)
    .where(eq(voiceChatItems.sessionId, sessionId));
}

/**
 * Read a task's result and resultUpdatedAt for compaction assertions.
 * @why-db-direct Compaction side-effects are only observable via the task row;
 * there is no public read API for individual task state in the voice-chat table.
 */
export async function getTestVoiceChatTask(id: string): Promise<
  | {
      result: string | null;
      resultUpdatedAt: Date | null;
      status: string;
      assistantMessages: VoiceChatTaskResultEntry[];
      error: string | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      result: voiceChatTasks.result,
      resultUpdatedAt: voiceChatTasks.resultUpdatedAt,
      status: voiceChatTasks.status,
      assistantMessages: voiceChatTasks.assistantMessages,
      error: voiceChatTasks.error,
    })
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.id, id));
  return row;
}

/**
 * List all task rows for a session for integration test assertions.
 * @why-db-direct The missingTasks Step 5c integration test needs to assert that
 * a task row was created; no public read API exposes individual task rows.
 */
export async function listTestVoiceChatTasks(
  sessionId: string,
): Promise<{ id: string; prompt: string; status: string; callId: string }[]> {
  initServices();
  return globalThis.services.db
    .select({
      id: voiceChatTasks.id,
      prompt: voiceChatTasks.prompt,
      status: voiceChatTasks.status,
      callId: voiceChatTasks.callId,
    })
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.sessionId, sessionId));
}
