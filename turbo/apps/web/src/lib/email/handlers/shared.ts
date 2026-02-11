import crypto from "crypto";
import { eq } from "drizzle-orm";
import { emailThreadSessions } from "../../../db/schema/email-thread-session";
import { env } from "../../../env";
import { getPlatformUrl } from "../../url";

/**
 * Generate an HMAC-signed reply token for plus addressing.
 * Format: {sessionId}.{hmac8chars}
 */
export function generateReplyToken(sessionId: string): string {
  const hmac = crypto
    .createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);
  return `${sessionId}.${hmac}`;
}

/**
 * Verify an HMAC-signed reply token and return the sessionId.
 * Returns null if the token is invalid or tampered.
 */
export function verifyReplyToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const sessionId = token.slice(0, dotIndex);
  const providedHmac = token.slice(dotIndex + 1);

  const expectedHmac = crypto
    .createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);

  // Timing-safe comparison
  if (providedHmac.length !== expectedHmac.length) return null;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedHmac),
    Buffer.from(expectedHmac),
  );

  return isValid ? sessionId : null;
}

/**
 * Build a reply-to email address with the token embedded via plus addressing.
 */
export function buildReplyToAddress(token: string): string {
  const domain = env().RESEND_FROM_DOMAIN;
  return `reply+${token}@${domain}`;
}

/**
 * Build the from address for outbound emails.
 */
export function buildFromAddress(agentName: string): string {
  const domain = env().RESEND_FROM_DOMAIN;
  return `${agentName} <agent@${domain}>`;
}

/**
 * Build the logs URL for a run.
 */
export function buildLogsUrl(runId: string): string {
  return `${getPlatformUrl()}/logs/${runId}`;
}

/**
 * Look up an email thread session by its reply-to token.
 */
export async function lookupEmailThreadSession(replyToToken: string) {
  const [session] = await globalThis.services.db
    .select()
    .from(emailThreadSessions)
    .where(eq(emailThreadSessions.replyToToken, replyToToken))
    .limit(1);

  return session ?? null;
}

/**
 * Create a new email thread session.
 */
export async function saveEmailThreadSession(opts: {
  userId: string;
  composeId: string;
  agentSessionId: string;
  lastEmailMessageId: string | null;
  replyToToken: string;
}): Promise<void> {
  await globalThis.services.db.insert(emailThreadSessions).values({
    userId: opts.userId,
    composeId: opts.composeId,
    agentSessionId: opts.agentSessionId,
    lastEmailMessageId: opts.lastEmailMessageId,
    replyToToken: opts.replyToToken,
  });
}

/**
 * Update an existing email thread session (new agentSessionId / messageId).
 */
export async function updateEmailThreadSession(
  sessionId: string,
  updates: {
    agentSessionId?: string;
    lastEmailMessageId?: string | null;
  },
): Promise<void> {
  await globalThis.services.db
    .update(emailThreadSessions)
    .set({
      ...updates,
      updatedAt: new Date(),
    })
    .where(eq(emailThreadSessions.id, sessionId));
}
