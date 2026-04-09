import { eq } from "drizzle-orm";
import type { EmailTemplate, PostSendAction } from "../../lib/zero/email/types";
import { emailThreadSessions } from "../../db/schema/email-thread-session";
import { emailOutbox } from "../../db/schema/email-outbox";
import { generateReplyToken } from "../../lib/zero/email/handlers/shared";

// ============================================================================
// Email Thread Session Test Helpers
// ============================================================================

/**
 * Create an email thread session directly in the database for test setup.
 */
export async function createTestEmailThreadSession(params: {
  userId: string;
  agentId: string;
  agentSessionId: string;
  replyToToken: string;
  lastEmailMessageId?: string | null;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(emailThreadSessions)
    .values({
      userId: params.userId,
      agentId: params.agentId,
      agentSessionId: params.agentSessionId,
      replyToToken: params.replyToToken,
      lastEmailMessageId: params.lastEmailMessageId ?? null,
    })
    .returning({ id: emailThreadSessions.id });
  return row!;
}

/**
 * Find an email thread session by its reply-to token.
 */
export async function findTestEmailThreadSession(replyToToken: string) {
  const [row] = await globalThis.services.db
    .select()
    .from(emailThreadSessions)
    .where(eq(emailThreadSessions.replyToToken, replyToToken))
    .limit(1);
  return row ?? null;
}

// ============================================================================
// Email Outbox Helpers
// ============================================================================

/**
 * Insert a raw email outbox item (bypasses enqueueEmail for direct state testing).
 */
export async function insertTestOutboxItem(values: {
  fromAddress: string;
  toAddresses: string | string[];
  subject: string;
  template: EmailTemplate;
  status?: string;
  attempts?: number;
  postSendAction?: PostSendAction;
  createdAt?: Date;
  resendId?: string;
}) {
  const [row] = await globalThis.services.db
    .insert(emailOutbox)
    .values({
      fromAddress: values.fromAddress,
      toAddresses: values.toAddresses,
      subject: values.subject,
      template: values.template,
      status: values.status ?? "pending",
      attempts: values.attempts ?? 0,
      postSendAction: values.postSendAction ?? null,
      createdAt: values.createdAt,
      resendId: values.resendId,
    })
    .returning({ id: emailOutbox.id });
  return row!;
}

/**
 * Find email outbox items by status.
 */
export async function findTestOutboxItems(status?: string) {
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
  const [row] = await globalThis.services.db
    .select()
    .from(emailOutbox)
    .where(eq(emailOutbox.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Generate a reply token for testing email thread sessions.
 * Re-exports generateReplyToken from the email handler shared module.
 */
export function generateTestReplyToken(sessionId: string): string {
  return generateReplyToken(sessionId);
}
