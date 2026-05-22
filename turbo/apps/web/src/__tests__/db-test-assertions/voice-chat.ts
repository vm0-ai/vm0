import { eq, and } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { voiceChatSessions } from "@vm0/db/schema/voice-chat";

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
