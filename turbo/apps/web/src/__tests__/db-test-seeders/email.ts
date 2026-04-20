import type { EmailTemplate, PostSendAction } from "../../lib/zero/email/types";
import { emailThreadSessions } from "../../db/schema/email-thread-session";
import { emailOutbox } from "../../db/schema/email-outbox";
import { initServices } from "../../lib/init-services";

// ============================================================================
// Email Thread Session Seeders
// ============================================================================

/**
 * Create an email thread session directly in the database for test setup.
 *
 * @why-db-direct No API route creates thread sessions directly; sessions are
 * created internally during email callback processing.
 */
export async function createTestEmailThreadSession(params: {
  userId: string;
  agentId: string;
  agentSessionId: string;
  replyToToken: string;
  lastEmailMessageId?: string | null;
}): Promise<{ id: string }> {
  initServices();
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

// ============================================================================
// Email Outbox Seeders
// ============================================================================

/**
 * Insert a raw email outbox item (bypasses enqueueEmail for direct state testing).
 *
 * @why-db-direct Bypasses enqueueEmail() to test specific outbox states
 * (e.g., pre-set attempts, status, createdAt) that cannot be reached through the API.
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
  initServices();
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
