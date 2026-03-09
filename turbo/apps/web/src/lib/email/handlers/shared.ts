import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { emailThreadSessions } from "../../../db/schema/email-thread-session";
import { agentComposes } from "../../../db/schema/agent-compose";
import { scopes } from "../../../db/schema/scope";
import { env } from "../../../env";
import { getPlatformUrl } from "../../url";
import { enqueueEmail } from "../outbox-service";

// ============================================================================
// Handler Result Type
// ============================================================================

export type HandlerResult = { ok: true } | { ok: false; errorMessage: string };

// ============================================================================
// Email Address Parsing
// ============================================================================

interface EmailTriggerAddress {
  scope: string;
  agent: string;
}

/**
 * Parse a trigger email address in the format: scope+agent@domain
 * Returns null if the address doesn't match the expected format.
 *
 * Examples:
 * - "lancy+my-agent@vm0.bot" → { scope: "lancy", agent: "my-agent" }
 * - "reply+token@vm0.bot" → null (reply address, not trigger)
 * - "invalid@vm0.bot" → null (no plus sign)
 */
export function parseEmailTriggerAddress(
  toAddress: string,
): EmailTriggerAddress | null {
  // Match: scope+agent@domain (case-insensitive)
  // Scope and agent must start with alphanumeric, can contain hyphens
  const match = toAddress.match(
    /^([a-z0-9][a-z0-9-]*)\+([a-z0-9][a-z0-9-]*)@/i,
  );
  if (!match || !match[1] || !match[2]) return null;

  const scope = match[1].toLowerCase();
  const agent = match[2].toLowerCase();

  // Exclude reply addresses (reply+token@domain)
  if (scope === "reply") return null;

  return { scope, agent };
}

/**
 * Parse an agent-only email address in the format: agent@domain
 * Returns the agent name if the address is a simple local-part (no plus sign),
 * or null if the address contains a plus sign or doesn't match.
 *
 * Examples:
 * - "my-agent@vm0.bot" → "my-agent"
 * - "scope+agent@vm0.bot" → null (has plus sign, use parseEmailTriggerAddress)
 * - "reply+token@vm0.bot" → null (has plus sign)
 * - "@vm0.bot" → null (empty local part)
 */
export function parseAgentOnlyAddress(toAddress: string): string | null {
  if (toAddress.includes("+")) return null;

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

  const isBotAddress = (addr: string) => emailDomain(addr) === botDomainLower;

  // Primary reply target: honor Reply-To if present, otherwise use From
  const primaryTarget = replyTo.length > 0 ? replyTo[0]! : from;

  // Determine if bot is in the To field
  const botInTo = to.some(isBotAddress);

  // Non-bot To recipients (excluding the bot itself)
  const otherToRecipients = to.filter((addr) => !isBotAddress(addr));

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
  replyToList = replyToList.filter((addr) => !isBotAddress(addr));
  replyCcList = replyCcList.filter((addr) => !isBotAddress(addr));

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
  const toSet = new Set(replyToList.map((a) => a.toLowerCase()));
  replyCcList = replyCcList.filter((addr) => !toSet.has(addr.toLowerCase()));

  return { to: replyToList, cc: replyCcList };
}

// ============================================================================
// Agent Resolution
// ============================================================================

interface ResolvedAgent {
  composeId: string;
  userId: string;
  scopeId: string;
  headVersionId: string;
}

/**
 * Resolve an agent compose by scope slug and agent name.
 * Returns compose details if found, null otherwise.
 */
export async function resolveAgentByAddress(
  scopeSlug: string,
  agentName: string,
): Promise<ResolvedAgent | null> {
  // 1. Find scope by slug
  const [scope] = await globalThis.services.db
    .select({ id: scopes.id })
    .from(scopes)
    .where(eq(scopes.slug, scopeSlug))
    .limit(1);

  if (!scope) return null;

  // 2. Find compose by scopeId + name
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      scopeId: agentComposes.scopeId,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.scopeId, scope.id),
        eq(agentComposes.name, agentName),
      ),
    )
    .limit(1);

  if (!compose) return null;

  // Compose must have a published version to be triggerable
  if (!compose.headVersionId) return null;

  return {
    composeId: compose.id,
    userId: compose.userId,
    scopeId: compose.scopeId,
    headVersionId: compose.headVersionId,
  };
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
 * The localPart is used as both the display name prefix and the email local part,
 * so the response mirrors the address the user sent to.
 */
export function buildFromAddress(localPart: string): string {
  return `${localPart} from VM0 <${localPart}@${getFromDomain()}>`;
}

/**
 * Build the logs URL for a run, linking to the agent detail logs page.
 */
export function buildLogsUrl(runId: string, agentName: string): string {
  return `${getPlatformUrl()}/agents/${encodeURIComponent(agentName)}/logs/${encodeURIComponent(runId)}`;
}

// ============================================================================
// Error Reply
// ============================================================================

/**
 * Send an error reply email to the sender when inbound processing fails.
 * No-ops when Resend is not configured.
 */
export async function sendInboundErrorReply(opts: {
  to: string;
  subject: string;
  errorMessage: string;
}): Promise<void> {
  if (!env().RESEND_API_KEY) return;

  const reSubject = opts.subject
    ? `Re: ${opts.subject.replace(/^Re:\s*/i, "")}`
    : "Email delivery failed";

  await enqueueEmail({
    from: buildFromAddress("vm0"),
    to: opts.to,
    subject: reSubject,
    template: {
      template: "inbound-error",
      props: { errorMessage: opts.errorMessage },
    },
  });
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
