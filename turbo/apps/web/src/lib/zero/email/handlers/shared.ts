import crypto from "crypto";
import { eq } from "drizzle-orm";
import { emailThreadSessions } from "@vm0/db/schema/email-thread-session";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { resolveDefaultAgentId } from "../../resolve-default-agent";
import { env } from "../../../../env";
import { getAppUrl } from "../../url";
import { getApiUrl } from "../../../infra/callback/dispatcher";
import { loadFeatureSwitchOverrides } from "../../user/feature-switches-service";

// ============================================================================
// Handler Result Type
// ============================================================================

export type HandlerResult = { ok: true } | { ok: false; errorMessage: string };

// ============================================================================
// Email Address Parsing
// ============================================================================

/**
 * Parse an org-level email address: org@domain
 * Returns the org slug, or null if not a valid org address.
 * Excludes reply+token addresses and old formats with + or /.
 */
export function parseOrgEmailAddress(toAddress: string): string | null {
  if (isReplyAddress(toAddress)) return null;
  if (toAddress.includes("+") || toAddress.includes("/")) return null;
  const match = toAddress.match(/^([a-z0-9][a-z0-9-]*)@/i);
  if (!match?.[1]) return null;
  return match[1].toLowerCase();
}

/**
 * Check if an email address is a reply address (reply+token@domain)
 */
export function isReplyAddress(toAddress: string): boolean {
  return toAddress.toLowerCase().startsWith("reply+");
}

// ============================================================================
// Reply Recipient Computation
// ============================================================================

interface ReplyRecipients {
  to: string[];
  cc: string[];
}

/**
 * Extract the domain portion of an email address (case-insensitive).
 */
function emailDomain(address: string): string {
  const atIndex = address.lastIndexOf("@");
  return atIndex === -1 ? "" : address.slice(atIndex + 1).toLowerCase();
}

/**
 * Compute reply recipients based on the bot's position in the original email.
 *
 * Strategy:
 * - Bot in To (sole recipient): reply to sender, preserve CC
 * - Bot in To (with others):    reply-all (sender + other To → to), preserve CC
 * - Bot only in CC:             reply to sender, preserve CC
 *
 * Also handles Reply-To honoring, self-loop prevention, and deduplication.
 */
export function computeReplyRecipients(opts: {
  from: string;
  to: string[];
  cc: string[];
  replyTo: string[];
  botDomain: string;
}): ReplyRecipients {
  const { from, to, cc, replyTo, botDomain } = opts;
  const botDomainLower = botDomain.toLowerCase();

  const isBotAddress = (addr: string) => {
    return emailDomain(addr) === botDomainLower;
  };

  // Primary reply target: honor Reply-To if present, otherwise use From
  const primaryTarget = replyTo.length > 0 ? replyTo[0]! : from;

  // Determine if bot is in the To field
  const botInTo = to.some(isBotAddress);

  // Non-bot To recipients (excluding the bot itself)
  const otherToRecipients = to.filter((addr) => {
    return !isBotAddress(addr);
  });

  let replyToList: string[];
  let replyCcList: string[];

  if (botInTo && otherToRecipients.length > 0) {
    // Reply-All: bot was in To with others
    replyToList = [primaryTarget, ...otherToRecipients];
  } else {
    // Simple reply: bot was sole To recipient or only CC'd
    replyToList = [primaryTarget];
  }

  // Always preserve CC (bot-filtering and dedup happens below)
  replyCcList = [...cc];

  // Remove bot's own addresses
  replyToList = replyToList.filter((addr) => {
    return !isBotAddress(addr);
  });
  replyCcList = replyCcList.filter((addr) => {
    return !isBotAddress(addr);
  });

  // Deduplicate (case-insensitive)
  const dedup = (list: string[]): string[] => {
    const seen = new Set<string>();
    return list.filter((addr) => {
      const lower = addr.toLowerCase();
      if (seen.has(lower)) return false;
      seen.add(lower);
      return true;
    });
  };

  replyToList = dedup(replyToList);
  replyCcList = dedup(replyCcList);

  // Remove from CC any address already in To
  const toSet = new Set(
    replyToList.map((a) => {
      return a.toLowerCase();
    }),
  );
  replyCcList = replyCcList.filter((addr) => {
    return !toSet.has(addr.toLowerCase());
  });

  return { to: replyToList, cc: replyCcList };
}

// ============================================================================
// Agent Resolution
// ============================================================================

/**
 * Resolve the org's default agent ID (zero layer).
 * Delegates to resolveDefaultAgentId which handles both the org_metadata
 * primary path and the VM0_DEFAULT_AGENT env var fallback.
 */
export async function resolveDefaultAgent(
  orgId: string,
): Promise<string | null> {
  return resolveDefaultAgentId(orgId);
}

// ============================================================================
// Reply Token Management
// ============================================================================

/**
 * Generate an HMAC-signed reply token for plus addressing.
 * Format: {sessionId}.{hmac16chars}
 */
export function generateReplyToken(sessionId: string): string {
  const hmac = crypto
    .createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
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
    .slice(0, 16);

  // Timing-safe comparison
  if (providedHmac.length !== expectedHmac.length) return null;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedHmac),
    Buffer.from(expectedHmac),
  );

  return isValid ? sessionId : null;
}

export function getFromDomain(): string {
  const domain = env().RESEND_FROM_DOMAIN;
  if (!domain) {
    throw new Error("RESEND_FROM_DOMAIN is not configured");
  }
  return domain;
}

/**
 * Build a reply-to email address with the token embedded via plus addressing.
 */
export function buildReplyToAddress(token: string): string {
  return `reply+${token}@${getFromDomain()}`;
}

/**
 * Build the from address for outbound emails.
 * Display name is always "Zero"; localPart is the org slug used as the email local part.
 */
export function buildFromAddress(localPart: string): string {
  return `Zero <${localPart}@${getFromDomain()}>`;
}

/**
 * Build the logs URL for a run, linking to the agent detail logs page.
 */
function buildLogsUrl(runId: string): string {
  return `${getAppUrl()}/activities/${encodeURIComponent(runId)}`;
}

export async function resolveEmailAuditLogsUrl(opts: {
  orgId: string;
  userId: string;
  runId: string;
}): Promise<string | undefined> {
  const overrides = await loadFeatureSwitchOverrides(opts.orgId, opts.userId);
  const enabled = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: opts.userId,
    orgId: opts.orgId,
    overrides,
  });
  return enabled ? buildLogsUrl(opts.runId) : undefined;
}

// ============================================================================
// Unsubscribe Token Management
// ============================================================================

/**
 * Generate an HMAC-signed unsubscribe token for a user.
 * Format: {userId}.{hmac32chars}
 */
function generateUnsubscribeToken(userId: string): string {
  const hmac = crypto
    .createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);
  return `${userId}.${hmac}`;
}

/**
 * Verify an HMAC-signed unsubscribe token and return the userId.
 * Returns null if the token is invalid or tampered.
 */
export function verifyUnsubscribeToken(token: string): string | null {
  const dotIndex = token.lastIndexOf(".");
  if (dotIndex === -1) return null;

  const userId = token.slice(0, dotIndex);
  const providedHmac = token.slice(dotIndex + 1);

  if (!userId || !providedHmac) return null;

  const expectedHmac = crypto
    .createHmac("sha256", env().SECRETS_ENCRYPTION_KEY)
    .update(`unsubscribe:${userId}`)
    .digest("hex")
    .slice(0, 32);

  // Timing-safe comparison
  if (providedHmac.length !== expectedHmac.length) return null;

  const isValid = crypto.timingSafeEqual(
    Buffer.from(providedHmac),
    Buffer.from(expectedHmac),
  );

  return isValid ? userId : null;
}

/**
 * Build the unsubscribe URL for a user.
 */
export function buildUnsubscribeUrl(userId: string): string {
  const token = generateUnsubscribeToken(userId);
  return `${getApiUrl()}/api/email/unsubscribe?token=${token}`;
}

/**
 * Build List-Unsubscribe headers for RFC 8058 compliance.
 */
export function buildUnsubscribeHeaders(url: string): Record<string, string> {
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// ============================================================================
// Email Thread Session
// ============================================================================

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
  agentId: string;
  agentSessionId: string;
  lastEmailMessageId: string | null;
  replyToToken: string;
  orgId?: string;
}): Promise<void> {
  await globalThis.services.db.insert(emailThreadSessions).values({
    userId: opts.userId,
    agentId: opts.agentId,
    agentSessionId: opts.agentSessionId,
    lastEmailMessageId: opts.lastEmailMessageId,
    replyToToken: opts.replyToToken,
    orgId: opts.orgId ?? null,
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
