import { eq, and } from "drizzle-orm";
import type { VoiceChatCandidateTaskResultEntry } from "@vm0/core";
import { initServices } from "../../lib/init-services";
import {
  featureCandidateVoiceChatItems,
  featureCandidateVoiceChatSessions,
  featureCandidateVoiceChatTasks,
} from "../../db/schema/voice-chat-candidate";

/**
 * Read the full reasoning-related mutable state of a voice-chat-candidate
 * session for reasoner integration test assertions.
 * @why-db-direct No public read API exposes individual session summary fields;
 * this encapsulates the DB read so test files stay lint-clean.
 */
export async function getTestVoiceChatCandidateSessionReasoningState(
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
      conversationSummary:
        featureCandidateVoiceChatSessions.conversationSummary,
      workingTasksSummary:
        featureCandidateVoiceChatSessions.workingTasksSummary,
      finishedTasksSummary:
        featureCandidateVoiceChatSessions.finishedTasksSummary,
      summarySeq: featureCandidateVoiceChatSessions.summarySeq,
      summaryVersion: featureCandidateVoiceChatSessions.summaryVersion,
      reasoningStatus: featureCandidateVoiceChatSessions.reasoningStatus,
      reasoningPending: featureCandidateVoiceChatSessions.reasoningPending,
      lastSummaryAt: featureCandidateVoiceChatSessions.lastSummaryAt,
    })
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, id));
  return row;
}

/**
 * Read a candidate voice-chat session's mutable state.
 * @why-db-direct Cron tests verify the reasoner state transitions the route
 * handler writes; no read API exists for those internals.
 */
export async function getTestVoiceChatCandidateSession(id: string): Promise<
  | {
      reasoningStatus: string;
      lastSummaryAt: Date | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      reasoningStatus: featureCandidateVoiceChatSessions.reasoningStatus,
      lastSummaryAt: featureCandidateVoiceChatSessions.lastSummaryAt,
    })
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, id));
  return row;
}

/**
 * Count candidate sessions by `reasoningStatus`, scoped to a single org
 * to keep large-batch assertions hermetic across a shared dev database.
 * @why-db-direct Aggregations across many seeded rows have no API surface.
 */
export async function countTestVoiceChatCandidateSessionsByReasoningStatus(
  orgId: string,
  reasoningStatus: "idle" | "running",
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: featureCandidateVoiceChatSessions.id })
    .from(featureCandidateVoiceChatSessions)
    .where(
      and(
        eq(featureCandidateVoiceChatSessions.orgId, orgId),
        eq(featureCandidateVoiceChatSessions.reasoningStatus, reasoningStatus),
      ),
    );
  return rows.length;
}

/**
 * Read all conversation items for a voice-chat-candidate session.
 * @why-db-direct The item list is used to verify side-effects written by
 * triggerReasoning (e.g. system_note appended on reasoner failure); no public
 * read API is available for the candidate item table.
 */
export async function readTestVoiceChatCandidateItems(
  sessionId: string,
): Promise<
  Array<{
    role: string;
    content: string | null;
    seq: number;
  }>
> {
  initServices();
  return globalThis.services.db
    .select({
      role: featureCandidateVoiceChatItems.role,
      content: featureCandidateVoiceChatItems.content,
      seq: featureCandidateVoiceChatItems.seq,
    })
    .from(featureCandidateVoiceChatItems)
    .where(eq(featureCandidateVoiceChatItems.sessionId, sessionId));
}

/**
 * Read a task's result and resultUpdatedAt for compaction assertions.
 * @why-db-direct Compaction side-effects are only observable via the task row;
 * there is no public read API for individual task state in the candidate table.
 */
export async function getTestVoiceChatCandidateTask(id: string): Promise<
  | {
      result: string | null;
      resultUpdatedAt: Date | null;
      status: string;
      assistantMessages: VoiceChatCandidateTaskResultEntry[];
      error: string | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      result: featureCandidateVoiceChatTasks.result,
      resultUpdatedAt: featureCandidateVoiceChatTasks.resultUpdatedAt,
      status: featureCandidateVoiceChatTasks.status,
      assistantMessages: featureCandidateVoiceChatTasks.assistantMessages,
      error: featureCandidateVoiceChatTasks.error,
    })
    .from(featureCandidateVoiceChatTasks)
    .where(eq(featureCandidateVoiceChatTasks.id, id));
  return row;
}

/**
 * List all task rows for a session for integration test assertions.
 * @why-db-direct The missingTasks Step 5c integration test needs to assert that
 * a task row was created; no public read API exposes individual task rows.
 */
export async function listTestVoiceChatCandidateTasks(
  sessionId: string,
): Promise<{ id: string; prompt: string; status: string; callId: string }[]> {
  initServices();
  return globalThis.services.db
    .select({
      id: featureCandidateVoiceChatTasks.id,
      prompt: featureCandidateVoiceChatTasks.prompt,
      status: featureCandidateVoiceChatTasks.status,
      callId: featureCandidateVoiceChatTasks.callId,
    })
    .from(featureCandidateVoiceChatTasks)
    .where(eq(featureCandidateVoiceChatTasks.sessionId, sessionId));
}

/**
 * Read all items for a session for callback side-effect assertions.
 * @why-db-direct Callback tests need to assert task_result and system_note
 * items written by the callback handler; there is no public list-items API
 * that returns all roles for a session.
 */
export async function listTestVoiceChatCandidateItems(
  sessionId: string,
): Promise<{ id: string; role: string; content: string | null }[]> {
  initServices();
  return globalThis.services.db
    .select({
      id: featureCandidateVoiceChatItems.id,
      role: featureCandidateVoiceChatItems.role,
      content: featureCandidateVoiceChatItems.content,
    })
    .from(featureCandidateVoiceChatItems)
    .where(eq(featureCandidateVoiceChatItems.sessionId, sessionId));
}
