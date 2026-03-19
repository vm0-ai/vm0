import { getReceivedEmail } from "../client";
import { processEmailAttachments } from "../attachment";
import { extractEmailBody } from "../content-extract";
import { verifySenderAuthenticity } from "../sender-auth";
import {
  parseInboundEmailAddress,
  resolveAgentByAddress,
  generateReplyToken,
  computeReplyRecipients,
  getFromDomain,
  type HandlerResult,
} from "./shared";
import { startRun } from "../../run";
import { buildIntegrationContext } from "../../integration-context";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { getUserIdByEmail } from "../../auth/get-user-id-by-email";
import { resolveOrgOrNull } from "../../org/resolve-org";
import { canAccessCompose } from "../../agent/compose-access";
import { logger } from "../../logger";

const log = logger("email:inbound-trigger");

interface InboundEmailEvent {
  type: string;
  data: {
    email_id: string;
    to: string[];
    from: string;
    subject: string;
    created_at: string;
  };
}

interface ResolvedTrigger {
  agentOrg: string;
  agentName: string;
  runtimeOrgId: string;
  runtimeOrgSlug: string;
  triggerLocalPart: string;
  userId: string;
}

/**
 * Parse trigger address from recipients and resolve the sender's user ID.
 *
 * Supports four address formats:
 * - runtimeorg+agentorg/agentname@domain (explicit runtime + agent org)
 * - agentorg/agentname@domain            (agent org explicit, runtime from user default)
 * - org+agent@domain                     (legacy: agentOrg=org, runtime from user default)
 * - agent@domain                         (both from user default)
 */
async function resolveTrigger(
  to: string[],
  senderEmail: string,
): Promise<ResolvedTrigger | HandlerResult> {
  // 1. Parse inbound address from recipients
  let parsed = null;
  let matchedAddress = "";
  for (const addr of to) {
    parsed = parseInboundEmailAddress(addr);
    if (parsed) {
      matchedAddress = addr;
      break;
    }
  }

  if (!parsed) {
    log.debug("No trigger address found in recipients", { to });
    return {
      ok: false,
      errorMessage:
        "The email address could not be recognized as a valid agent address.",
    };
  }

  // 2. Resolve sender userId
  const userId = await getUserIdByEmail(senderEmail);
  if (!userId) {
    log.debug("Sender email not registered", { from: senderEmail });
    return {
      ok: false,
      errorMessage: "Your email address is not associated with a VM0 account.",
    };
  }

  // 3. Resolve runtime org (explicit slug from address, or agent's org as fallback)
  const runtimeOrg = await resolveOrgOrNull(
    { userId },
    parsed.runtimeOrg ?? parsed.agentOrg,
  );
  if (!runtimeOrg) {
    const msg = parsed.runtimeOrg
      ? `Workspace "${parsed.runtimeOrg}" was not found.`
      : "Your account does not have a workspace configured.";
    log.debug("Runtime org resolution failed", {
      from: senderEmail,
      userId,
      explicitOrg: parsed.runtimeOrg,
    });
    return { ok: false, errorMessage: msg };
  }
  const runtimeOrgId = runtimeOrg.orgId;
  const runtimeOrgSlug = runtimeOrg.slug;

  // 4. Resolve agent org (defaults to runtime org if not specified)
  const agentOrg = parsed.agentOrg ?? runtimeOrgSlug;

  // 5. Extract trigger local part from the matched address for reply-from
  const atIndex = matchedAddress.indexOf("@");
  const triggerLocalPart =
    atIndex > 0
      ? matchedAddress.slice(0, atIndex).toLowerCase()
      : parsed.agentName;

  return {
    agentOrg,
    agentName: parsed.agentName,
    runtimeOrgId,
    runtimeOrgSlug,
    triggerLocalPart,
    userId,
  };
}

/**
 * Handle an inbound email that triggers an agent run.
 *
 * Flow:
 * 1. Parse trigger address from recipients (org+agent or agent-only)
 * 2. Look up sender email in Clerk to get user ID
 * 3. Resolve agent by org slug + agent name
 * 4. Check if user has permission to access the agent
 * 5. Fetch full email and verify sender via DMARC
 * 6. Create agent run with callback for response delivery
 *
 * Returns a HandlerResult so the caller can send an error reply on failure.
 */
export async function handleInboundEmailTrigger(
  event: InboundEmailEvent,
): Promise<HandlerResult> {
  const { email_id: emailId, to, from: senderEmail, subject } = event.data;

  // 1-2. Resolve trigger address and sender
  const resolved = await resolveTrigger(to, senderEmail);
  if ("ok" in resolved) return resolved;

  const {
    agentOrg,
    agentName,
    runtimeOrgId,
    runtimeOrgSlug,
    triggerLocalPart,
    userId,
  } = resolved;

  log.debug("Processing email trigger", {
    agentOrg,
    agentName,
    runtimeOrg: runtimeOrgSlug,
    from: senderEmail,
  });

  // 3. Resolve agent
  const compose = await resolveAgentByAddress(agentOrg, agentName);
  if (!compose) {
    log.debug("Agent not found", { org: agentOrg, agent: agentName });
    return {
      ok: false,
      errorMessage: `Agent "${agentName}" was not found in org "${agentOrg}".`,
    };
  }

  // 4. Check permission
  const hasAccess = canAccessCompose(userId, runtimeOrgId, {
    id: compose.composeId,
    userId: compose.userId,
    orgId: compose.orgId,
  });

  if (!hasAccess) {
    log.debug("User does not have access to agent", {
      userId,
      composeId: compose.composeId,
    });
    return {
      ok: false,
      errorMessage: "You do not have permission to access this agent.",
    };
  }

  // 5. Fetch full email
  const email = await getReceivedEmail(emailId);

  // 6. Compute reply recipients based on bot position in To/CC
  const replyRecipients = computeReplyRecipients({
    from: senderEmail,
    to: email.to,
    cc: email.cc,
    replyTo: email.replyTo,
    botDomain: getFromDomain(),
  });

  // 7. Extract inbound Message-ID for threading (case-insensitive lookup)
  const headers = email.headers ?? {};
  const messageIdKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "message-id",
  );
  const inboundMessageId = messageIdKey ? headers[messageIdKey] : undefined;
  const referencesKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "references",
  );
  const inboundReferences = referencesKey ? headers[referencesKey] : undefined;

  // 8. Verify sender authenticity via DMARC
  const verification = verifySenderAuthenticity(email.headers);
  if (!verification.verified) {
    log.warn("Sender authentication failed, ignoring email", {
      from: senderEmail,
      reason: verification.reason,
      emailId,
    });
    return {
      ok: false,
      errorMessage:
        "Your email could not be authenticated (DMARC verification failed).",
    };
  }

  // 9. Build prompt from email content
  const bodyContent = extractEmailBody(email.html, email.text);

  // Combine subject + body as prompt
  let prompt = subject
    ? `${subject}\n\n${bodyContent}`.trim()
    : bodyContent.trim();

  if (!prompt) {
    log.debug("Empty prompt after processing", { emailId });
    return {
      ok: false,
      errorMessage: "Your email body was empty after processing.",
    };
  }

  // 9b. Process attachments and append to prompt
  const attachmentText = await processEmailAttachments(emailId);
  if (attachmentText) {
    prompt = `${prompt}\n\n${attachmentText}`;
  }

  // 10. Generate reply token for conversation continuity
  const sessionPlaceholderId = crypto.randomUUID();
  const replyToken = generateReplyToken(sessionPlaceholderId);

  // 11. Build callback
  const callbacks = [
    {
      url: `${getApiUrl()}/api/internal/callbacks/email/trigger`,
      secret: generateCallbackSecret(),
      payload: {
        senderEmail,
        composeId: compose.composeId,
        userId,
        inboundEmailId: emailId,
        replyToken,
        inboundMessageId,
        inboundReferences,
        subject,
        triggerLocalPart,
        runtimeOrgId,
        replyRecipientTo: replyRecipients.to,
        replyRecipientCc: replyRecipients.cc,
      },
    },
  ];

  // 12. Inject integration context and create run
  const fullPrompt = `${buildIntegrationContext("Email")}\n\n# User Prompt\n\n${prompt}`;
  const result = await startRun({
    userId,
    prompt: fullPrompt,
    composeId: compose.composeId,
    triggerSource: "email",
    callbacks,
  });

  log.info("Dispatched agent run from email trigger", {
    runId: result.runId,
    emailId,
    agentOrg,
    agentName,
    runtimeOrg: runtimeOrgSlug,
  });

  return { ok: true };
}
