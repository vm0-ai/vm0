import { getReceivedEmail } from "../client";
import { processEmailAttachments } from "../attachment";
import { extractEmailBody } from "../content-extract";
import { verifySenderAuthenticity } from "../sender-auth";
import {
  parseEmailTriggerAddress,
  parseAgentOnlyAddress,
  resolveAgentByAddress,
  generateReplyToken,
} from "./shared";
import { createRun } from "../../run";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { getUserIdByEmail } from "../../auth/get-user-id-by-email";
import { getUserScopeByClerkId } from "../../scope/scope-service";
import { canAccessCompose } from "../../agent/permission-service";
import { getUserEmail } from "../../auth/get-user-email";
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

/**
 * Handle an inbound email that triggers an agent run.
 * Supports two address formats:
 * - scope+agent@domain (explicit scope)
 * - agent@domain (scope auto-detected from sender's personal scope)
 *
 * Flow:
 * 1. Parse trigger address from recipients (scope+agent or agent-only)
 * 2. Look up sender email in Clerk to get user ID
 * 3. Resolve agent by scope slug + agent name
 * 4. Check if user has permission to access the agent
 * 5. Fetch full email and verify sender via DMARC
 * 6. Create agent run with callback for response delivery
 *
 * All failures are silent (no response email) to prevent information leakage.
 */
export async function handleInboundEmailTrigger(
  event: InboundEmailEvent,
): Promise<void> {
  const { email_id: emailId, to, from: senderEmail, subject } = event.data;

  // 1. Find trigger address in recipients
  //    Supports two formats:
  //    - scope+agent@domain (explicit scope)
  //    - agent@domain (scope auto-detected from sender)
  let triggerAddress: { scope: string; agent: string } | null = null;
  let triggerLocalPart: string | undefined;
  let userId: string | null = null;

  // 1a. Try scope+agent format first
  for (const addr of to) {
    const parsed = parseEmailTriggerAddress(addr);
    if (parsed) {
      triggerAddress = parsed;
      triggerLocalPart = `${parsed.scope}+${parsed.agent}`;
      break;
    }
  }

  // 1b. If no scope+agent match, try agent-only format
  if (!triggerAddress) {
    let agentName: string | null = null;

    for (const addr of to) {
      const parsed = parseAgentOnlyAddress(addr);
      if (parsed) {
        agentName = parsed;
        break;
      }
    }

    if (!agentName) {
      log.debug("No trigger address found in recipients", { to });
      return;
    }

    triggerLocalPart = agentName;

    // For agent-only format, we need the sender's scope.
    // Look up sender in Clerk first (needed for scope lookup).
    userId = await getUserIdByEmail(senderEmail);
    if (!userId) {
      log.debug("Sender email not registered", { from: senderEmail });
      return;
    }

    const userScope = await getUserScopeByClerkId(userId);
    if (!userScope) {
      log.debug("Sender has no scope", { from: senderEmail, userId });
      return;
    }

    triggerAddress = { scope: userScope.slug, agent: agentName };
  }

  log.debug("Processing email trigger", {
    scope: triggerAddress.scope,
    agent: triggerAddress.agent,
    from: senderEmail,
  });

  // 2. Look up sender in Clerk (skip if already done for agent-only format)
  if (!userId) {
    userId = await getUserIdByEmail(senderEmail);
    if (!userId) {
      log.debug("Sender email not registered", { from: senderEmail });
      return;
    }
  }

  // 3. Resolve agent
  const compose = await resolveAgentByAddress(
    triggerAddress.scope,
    triggerAddress.agent,
  );
  if (!compose) {
    log.debug("Agent not found", {
      scope: triggerAddress.scope,
      agent: triggerAddress.agent,
    });
    return;
  }

  // 4. Check permission
  const userEmail = await getUserEmail(userId);
  const hasAccess = await canAccessCompose(userId, userEmail, {
    id: compose.composeId,
    userId: compose.userId,
    scopeId: compose.scopeId,
  });

  if (!hasAccess) {
    log.debug("User does not have access to agent", {
      userId,
      composeId: compose.composeId,
    });
    return;
  }

  // 5. Fetch full email
  const email = await getReceivedEmail(emailId);

  // 6. Extract inbound Message-ID for threading (case-insensitive lookup)
  const headers = email.headers ?? {};
  const messageIdKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "message-id",
  );
  const inboundMessageId = messageIdKey ? headers[messageIdKey] : undefined;
  const referencesKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "references",
  );
  const inboundReferences = referencesKey ? headers[referencesKey] : undefined;

  // 7. Verify sender authenticity via DMARC
  const verification = verifySenderAuthenticity(email.headers);
  if (!verification.verified) {
    log.warn("Sender authentication failed, ignoring email", {
      from: senderEmail,
      reason: verification.reason,
      emailId,
    });
    return;
  }

  // 8. Build prompt from email content
  const bodyContent = extractEmailBody(email.html, email.text);

  // Combine subject + body as prompt
  let prompt = subject
    ? `${subject}\n\n${bodyContent}`.trim()
    : bodyContent.trim();

  if (!prompt) {
    log.debug("Empty prompt after processing", { emailId });
    return;
  }

  // 8b. Process attachments and append to prompt
  const attachmentText = await processEmailAttachments(emailId);
  if (attachmentText) {
    prompt = `${prompt}\n\n${attachmentText}`;
  }

  // 9. Generate reply token for conversation continuity
  const sessionPlaceholderId = crypto.randomUUID();
  const replyToken = generateReplyToken(sessionPlaceholderId);

  // 10. Build callback
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
      },
    },
  ];

  // 11. Create and dispatch run
  const result = await createRun({
    userId,
    agentComposeVersionId: compose.headVersionId,
    prompt,
    composeId: compose.composeId,
    agentName: triggerAddress.agent,
    artifactName: "artifact",
    callbacks,
  });

  log.info("Dispatched agent run from email trigger", {
    runId: result.runId,
    emailId,
    scope: triggerAddress.scope,
    agent: triggerAddress.agent,
  });
}
