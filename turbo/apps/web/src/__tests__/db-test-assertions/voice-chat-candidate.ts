import { eq, and } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { featureCandidateVoiceChatSessions } from "../../db/schema/voice-chat-candidate";

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
      lastReasoningAt: Date | null;
    }
  | undefined
> {
  initServices();
  const [row] = await globalThis.services.db
    .select({
      status: featureCandidateVoiceChatSessions.status,
      endedAt: featureCandidateVoiceChatSessions.endedAt,
      reasoningStatus: featureCandidateVoiceChatSessions.reasoningStatus,
      lastReasoningAt: featureCandidateVoiceChatSessions.lastReasoningAt,
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
