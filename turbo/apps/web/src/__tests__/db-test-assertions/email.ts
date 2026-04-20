import { eq } from "drizzle-orm";
import { emailThreadSessions } from "../../db/schema/email-thread-session";
import { emailOutbox } from "../../db/schema/email-outbox";
import { initServices } from "../../lib/init-services";

// ============================================================================
// Email Thread Session Assertions
// ============================================================================

/**
 * Find an email thread session by its reply-to token.
 */
export async function findTestEmailThreadSession(replyToToken: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(emailThreadSessions)
    .where(eq(emailThreadSessions.replyToToken, replyToToken))
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Email Outbox Assertions
// ============================================================================

/**
 * Find email outbox items by status.
 */
export async function findTestOutboxItems(status?: string) {
  initServices();
  if (status) {
    return globalThis.services.db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.status, status));
  }
  return globalThis.services.db.select().from(emailOutbox);
}

/**
 * Find a single email outbox item by ID.
 */
export async function findTestOutboxItemById(id: string) {
  initServices();
  const [row] = await globalThis.services.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.id, id))
    .limit(1);
  return row ?? null;
}
