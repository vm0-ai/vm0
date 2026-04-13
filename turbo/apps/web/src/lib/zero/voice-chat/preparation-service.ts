import { lt } from "drizzle-orm";
import { voiceChatPreparations } from "../../../db/schema/voice-chat";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat:preparation");

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
