import { getReceivedEmail } from "../client";
import { processEmailAttachments } from "../attachment";
import { extractEmailBody } from "../content-extract";
import { verifySenderAuthenticity } from "../sender-auth";
import {
  parseEmailTriggerAddress,
  parseAgentOnlyAddress,
  resolveAgentByAddress,
  generateReplyToken,
  computeReplyRecipients,
  getFromDomain,
  type HandlerResult,
} from "./shared";
import { createRun } from "../../run";
import { buildIntegrationContext } from "../../integration-context";
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

interface ResolvedTrigger {
  triggerAddress: { scope: string; agent: string };
  triggerLocalPart: string;
  userId: string;
}

/**
 * Parse trigger address from recipients and resolve the sender's user ID.
 * Supports two formats:
 * - scope+agent@domain (explicit scope)
 * - agent@domain (scope auto-detected from sender's personal scope)
 */
async function resolveTrigger(
  to: string[],
  senderEmail: string,
): Promise<ResolvedTrigger | HandlerResult> {
  // 1a. Try scope+agent format first
  for (const addr of to) {
    const parsed = parseEmailTriggerAddress(addr);
    if (parsed) {
      // Look up sender in Clerk
      const userId = await getUserIdByEmail(senderEmail);
      if (!userId) {
        log.debug("Sender email not registered", { from: senderEmail });
        return {
          ok: false,
          errorMessage:
            "Your email address is not associated with a VM0 account.",
        };
      }
      return {
        triggerAddress: parsed,
        triggerLocalPart: `${parsed.scope}+${parsed.agent}`,
        userId,
      };
    }
  }

  // 1b. Try agent-only format
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
    return {
      ok: false,
      errorMessage:
        "The email address could not be recognized as a valid agent address.",
    };
  }

  // For agent-only format, we need the sender's scope
  const userId = await getUserIdByEmail(senderEmail);
  if (!userId) {
    log.debug("Sender email not registered", { from: senderEmail });
    return {
      ok: false,
      errorMessage: "Your email address is not associated with a VM0 account.",
    };
  }

  const userScope = await getUserScopeByClerkId(userId);
  if (!userScope) {
    log.debug("Sender has no scope", { from: senderEmail, userId });
    return {
      ok: false,
      errorMessage: "Your account does not have a workspace configured.",
    };
  }

  return {
    triggerAddress: { scope: userScope.slug, agent: agentName },
    triggerLocalPart: agentName,
    userId,
  };
}

/**
 * Handle an inbound email that triggers an agent run.
 *
 * Flow:
 * 1. Parse trigger address from recipients (scope+agent or agent-only)
 * 2. Look up sender email in Clerk to get user ID
 * 3. Resolve agent by scope slug + agent name
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

  const { triggerAddress, triggerLocalPart, userId } = resolved;

  log.debug("Processing email trigger", {
    scope: triggerAddress.scope,
    agent: triggerAddress.agent,
    from: senderEmail,
  });

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
    return {
      ok: false,
      errorMessage: `Agent "${triggerAddress.agent}" was not found in scope "${triggerAddress.scope}".`,
    };
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
        replyRecipientTo: replyRecipients.to,
        replyRecipientCc: replyRecipients.cc,
      },
    },
  ];

  // 12. Inject integration context and create run
  const fullPrompt = `${buildIntegrationContext("Email")}\n\n# User Prompt\n\n${prompt}`;
  const result = await createRun({
    userId,
    agentComposeVersionId: compose.headVersionId,
    prompt: fullPrompt,
    composeId: compose.composeId,
    agentName: triggerAddress.agent,
    artifactName: "artifact",
    memoryName: "memory",
    callbacks,
  });

  log.info("Dispatched agent run from email trigger", {
    runId: result.runId,
    emailId,
    scope: triggerAddress.scope,
    agent: triggerAddress.agent,
  });

  return { ok: true };
}
