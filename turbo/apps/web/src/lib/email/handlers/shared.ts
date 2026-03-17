import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { emailThreadSessions } from "../../../db/schema/email-thread-session";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getOrgBySlug } from "../../org/org-cache-service";
import { env } from "../../../env";
import { getPlatformUrl } from "../../url";
import { getApiUrl } from "../../callback/dispatcher";
import { enqueueEmail } from "../outbox-service";

// ============================================================================
// Handler Result Type
// ============================================================================

export type HandlerResult = { ok: true } | { ok: false; errorMessage: string };

// ============================================================================
// Email Address Parsing
// ============================================================================

interface EmailTriggerAddress {
  org: string;
  agent: string;
}

/**
 * Parse a trigger email address in the format: org+agent@domain
 * Returns null if the address doesn't match the expected format.
 *
 * Examples:
 * - "lancy+my-agent@vm0.bot" → { org: "lancy", agent: "my-agent" }
 * - "reply+token@vm0.bot" → null (reply address, not trigger)
 * - "invalid@vm0.bot" → null (no plus sign)
 */
function parseEmailTriggerAddress(
  toAddress: string,
): EmailTriggerAddress | null {
  // Match: org+agent@domain (case-insensitive)
  // Org and agent must start with alphanumeric, can contain hyphens
  const match = toAddress.match(
    /^([a-z0-9][a-z0-9-]*)\+([a-z0-9][a-z0-9-]*)@/i,
  );
  if (!match || !match[1] || !match[2]) return null;

  const org = match[1].toLowerCase();
  const agent = match[2].toLowerCase();

  // Exclude reply addresses (reply+token@domain)
  if (org === "reply") return null;

  return { org, agent };
}

/**
 * Parse an agent-only email address in the format: agent@domain
 * Returns the agent name if the address is a simple local-part (no plus sign),
 * or null if the address contains a plus sign or doesn't match.
 *
 * Examples:
 * - "my-agent@vm0.bot" → "my-agent"
 * - "org+agent@vm0.bot" → null (has plus sign, use parseEmailTriggerAddress)
 * - "reply+token@vm0.bot" → null (has plus sign)
 * - "@vm0.bot" → null (empty local part)
 */
function parseAgentOnlyAddress(toAddress: string): string | null {
  if (toAddress.includes("+")) return null;

  const match = toAddress.match(/^([a-z0-9][a-z0-9-]*)@/i);
  if (!match?.[1]) return null;

  return match[1].toLowerCase();
}

/**
 * Parsed inbound email address with separate runtime org and agent org.
 *
 * - runtimeOrg: explicit runtime org slug, or null (resolve from user default)
 * - agentOrg: explicit agent org slug, or null (same as runtime org)
 * - agentName: the agent name
 */
interface ParsedEmailAddress {
  runtimeOrg: string | null;
  agentOrg: string | null;
  agentName: string;
}

// Slug segment: starts with alphanumeric, may contain hyphens
const SLUG = "[a-z0-9][a-z0-9-]*";

// runtimeorg+agentorg/agentname@domain
const RE_FULL = new RegExp(`^(${SLUG})\\+(${SLUG})/(${SLUG})@`, "i");
// agentorg/agentname@domain
const RE_ORG_SLASH_AGENT = new RegExp(`^(${SLUG})/(${SLUG})@`, "i");

/**
 * Unified inbound email address parser.
 *
 * Supports four formats (tried in order of specificity):
 * 1. runtimeorg+agentorg/agentname@domain  → explicit runtime + agent org
 * 2. agentorg/agentname@domain             → agent org explicit, runtime from user default
 * 3. org+agent@domain (legacy)             → agentOrg=org, runtime from user default
 * 4. agentname@domain                      → both orgs from user default
 *
 * Returns null for reply+token addresses and unrecognized formats.
 */
export function parseInboundEmailAddress(
  toAddress: string,
): ParsedEmailAddress | null {
  if (isReplyAddress(toAddress)) return null;

  // 1. runtimeorg+agentorg/agentname@domain
  const fullMatch = toAddress.match(RE_FULL);
  if (fullMatch?.[1] && fullMatch[2] && fullMatch[3]) {
    return {
      runtimeOrg: fullMatch[1].toLowerCase(),
      agentOrg: fullMatch[2].toLowerCase(),
      agentName: fullMatch[3].toLowerCase(),
    };
  }

  // 2. agentorg/agentname@domain
  const slashMatch = toAddress.match(RE_ORG_SLASH_AGENT);
  if (slashMatch?.[1] && slashMatch[2]) {
    return {
      runtimeOrg: null,
      agentOrg: slashMatch[1].toLowerCase(),
      agentName: slashMatch[2].toLowerCase(),
    };
  }

  // 3. org+agent@domain (legacy)
  const triggerAddr = parseEmailTriggerAddress(toAddress);
  if (triggerAddr) {
    return {
      runtimeOrg: null,
      agentOrg: triggerAddr.org,
      agentName: triggerAddr.agent,
    };
  }

  // 4. agentname@domain
  const agentOnly = parseAgentOnlyAddress(toAddress);
  if (agentOnly) {
    return {
      runtimeOrg: null,
      agentOrg: null,
      agentName: agentOnly,
    };
  }

  return null;
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
  orgId: string;
  orgSlug: string;
  headVersionId: string;
}

/**
 * Resolve an agent compose by org slug and agent name.
 * Returns compose details if found, null otherwise.
 */
export async function resolveAgentByAddress(
  orgSlug: string,
  agentName: string,
): Promise<ResolvedAgent | null> {
  // 1. Resolve org by slug via org cache
  const orgData = await getOrgBySlug(orgSlug);
  if (!orgData) return null;

  // 2. Find compose by orgId + name
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      userId: agentComposes.userId,
      orgId: agentComposes.orgId,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, orgData.orgId),
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
    orgId: compose.orgId,
    orgSlug,
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
export function buildLogsUrl(runId: string): string {
  return `${getPlatformUrl()}/zero/activity/${encodeURIComponent(runId)}`;
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
// Error Reply
// ============================================================================

/**
 * Send an error reply email to the sender when inbound processing fails.
 * No-ops when Resend is not configured.
 * When userId is provided, includes List-Unsubscribe headers and template link.
 */
export async function sendInboundErrorReply(opts: {
  to: string;
  subject: string;
  errorMessage: string;
  userId?: string;
}): Promise<void> {
  if (!env().RESEND_API_KEY) return;

  const reSubject = opts.subject
    ? `Re: ${opts.subject.replace(/^Re:\s*/i, "")}`
    : "Email delivery failed";

  const unsubscribeUrl = opts.userId
    ? buildUnsubscribeUrl(opts.userId)
    : undefined;
  const headers = unsubscribeUrl
    ? buildUnsubscribeHeaders(unsubscribeUrl)
    : undefined;

  await enqueueEmail({
    from: buildFromAddress("vm0"),
    to: opts.to,
    subject: reSubject,
    template: {
      template: "inbound-error",
      props: { errorMessage: opts.errorMessage, unsubscribeUrl },
    },
    headers,
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
  orgId?: string;
}): Promise<void> {
  await globalThis.services.db.insert(emailThreadSessions).values({
    userId: opts.userId,
    composeId: opts.composeId,
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
