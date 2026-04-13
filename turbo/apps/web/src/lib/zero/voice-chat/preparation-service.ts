import { eq, and, lt, gt } from "drizzle-orm";
import { voiceChatPreparations } from "../../../db/schema/voice-chat";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat:preparation");

// ---------------------------------------------------------------------------
// Preparation CRUD
// ---------------------------------------------------------------------------

const FRESH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function createPreparation(
  orgId: string,
  userId: string,
  agentId: string,
  mode: string,
  prompt?: string,
) {
  const db = globalThis.services.db;
  const [row] = await db
    .insert(voiceChatPreparations)
    .values({
      orgId,
      userId,
      agentId,
      mode,
      prompt: prompt ?? null,
      status: "preparing",
    })
    .returning();

  return row!;
}

export async function findFreshPreparation(
  userId: string,
  agentId: string,
  mode: string,
  prompt?: string,
) {
  const db = globalThis.services.db;
  const freshThreshold = new Date(Date.now() - FRESH_TTL_MS);

  const conditions = [
    eq(voiceChatPreparations.userId, userId),
    eq(voiceChatPreparations.agentId, agentId),
    eq(voiceChatPreparations.mode, mode),
    eq(voiceChatPreparations.status, "ready"),
    gt(voiceChatPreparations.createdAt, freshThreshold),
  ];

  if (prompt != null) {
    conditions.push(eq(voiceChatPreparations.prompt, prompt));
  }

  const [row] = await db
    .select()
    .from(voiceChatPreparations)
    .where(and(...conditions))
    .limit(1);

  return row ?? null;
}

export async function findPreparationById(id: string) {
  const db = globalThis.services.db;
  const [row] = await db
    .select()
    .from(voiceChatPreparations)
    .where(eq(voiceChatPreparations.id, id))
    .limit(1);

  return row ?? null;
}

export async function updatePreparationStatus(
  id: string,
  status: string,
  directiveContent?: string,
) {
  const db = globalThis.services.db;
  const updates: Record<string, string> = { status };
  if (directiveContent != null) {
    updates.directiveContent = directiveContent;
  }

  const [row] = await db
    .update(voiceChatPreparations)
    .set(updates)
    .where(eq(voiceChatPreparations.id, id))
    .returning();

  return row ?? null;
}

export async function findInFlightPreparation(
  userId: string,
  agentId: string,
  mode: string,
) {
  const db = globalThis.services.db;
  const [row] = await db
    .select()
    .from(voiceChatPreparations)
    .where(
      and(
        eq(voiceChatPreparations.userId, userId),
        eq(voiceChatPreparations.agentId, agentId),
        eq(voiceChatPreparations.mode, mode),
        eq(voiceChatPreparations.status, "preparing"),
      ),
    )
    .limit(1);

  return row ?? null;
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
