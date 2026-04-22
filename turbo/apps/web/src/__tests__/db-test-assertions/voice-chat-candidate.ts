import { eq, and } from "drizzle-orm";
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
 * @why-db-direct Cron tests verify the timeout/reasoning state transitions
 * the route handler writes; no read API exists for the candidate table.
 */
export async function getTestVoiceChatCandidateSession(id: string): Promise<
  | {
      status: string;
      endedAt: Date | null;
      reasoningStatus: string;
      lastSummaryAt: Date | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      status: featureCandidateVoiceChatSessions.status,
      endedAt: featureCandidateVoiceChatSessions.endedAt,
      reasoningStatus: featureCandidateVoiceChatSessions.reasoningStatus,
      lastSummaryAt: featureCandidateVoiceChatSessions.lastSummaryAt,
    })
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, id));
  return row;
}

/**
 * Count candidate sessions by `status`, scoped to a single org to keep
 * large-batch test assertions hermetic across a shared dev database.
 * @why-db-direct Aggregations across many seeded rows have no API surface.
 */
export async function countTestVoiceChatCandidateSessionsByStatus(
  orgId: string,
  status: "active" | "ended" | "timeout",
): Promise<number> {
  initServices();
  const rows = await globalThis.services.db
    .select({ id: featureCandidateVoiceChatSessions.id })
    .from(featureCandidateVoiceChatSessions)
    .where(
      and(
        eq(featureCandidateVoiceChatSessions.orgId, orgId),
        eq(featureCandidateVoiceChatSessions.status, status),
      ),
    );
  return rows.length;
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
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      result: featureCandidateVoiceChatTasks.result,
      resultUpdatedAt: featureCandidateVoiceChatTasks.resultUpdatedAt,
      status: featureCandidateVoiceChatTasks.status,
    })
    .from(featureCandidateVoiceChatTasks)
    .where(eq(featureCandidateVoiceChatTasks.id, id));
  return row;
}
