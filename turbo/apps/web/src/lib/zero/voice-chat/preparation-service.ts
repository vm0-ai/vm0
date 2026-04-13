import { eq, and, gt, lt, desc, isNull } from "drizzle-orm";
import { voiceChatPreparations } from "../../../db/schema/voice-chat";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat:preparation");

const PREPARATION_FRESHNESS_MS = 60 * 60 * 1000; // 1 hour

export async function findFreshPreparation(
  userId: string,
  agentId: string,
  mode: string,
  prompt?: string,
): Promise<{ id: string; directiveContent: string } | null> {
  const db = globalThis.services.db;
  const threshold = new Date(Date.now() - PREPARATION_FRESHNESS_MS);

  const conditions = [
    eq(voiceChatPreparations.userId, userId),
    eq(voiceChatPreparations.agentId, agentId),
    eq(voiceChatPreparations.mode, mode),
    eq(voiceChatPreparations.status, "ready"),
    gt(voiceChatPreparations.createdAt, threshold),
  ];

  if (prompt) {
    conditions.push(eq(voiceChatPreparations.prompt, prompt));
  } else {
    conditions.push(isNull(voiceChatPreparations.prompt));
  }

  const [result] = await db
    .select({
      id: voiceChatPreparations.id,
      directiveContent: voiceChatPreparations.directiveContent,
    })
    .from(voiceChatPreparations)
    .where(and(...conditions))
    .orderBy(desc(voiceChatPreparations.createdAt))
    .limit(1);

  if (!result?.directiveContent) return null;
  return { id: result.id, directiveContent: result.directiveContent };
}

export async function deleteExpiredPreparations(ttlMs: number) {
  const db = globalThis.services.db;
  const threshold = new Date(Date.now() - ttlMs);

  const deleted = await db
    .delete(voiceChatPreparations)
    .where(lt(voiceChatPreparations.createdAt, threshold))
    .returning({ id: voiceChatPreparations.id });

  if (deleted.length > 0) {
    log.info("Expired preparations cleaned up", { cleaned: deleted.length });
  }

  return deleted;
}
