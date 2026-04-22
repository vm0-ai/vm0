import { eq, and } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import {
  featureCandidateVoiceChatSessions,
  featureCandidateVoiceChatTasks,
} from "../../db/schema/voice-chat-candidate";

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
