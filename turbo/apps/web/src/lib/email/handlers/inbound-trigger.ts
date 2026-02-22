import { getReceivedEmail } from "../client";
import { stripQuotedReply } from "../quote-strip";
import {
  parseEmailTriggerAddress,
  resolveAgentByAddress,
  generateReplyToken,
} from "./shared";
import { createRun } from "../../run";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { getUserIdByEmail } from "../../auth/get-user-id-by-email";
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
 * This is for direct emails to scope+agent@domain addresses.
 *
 * Flow:
 * 1. Parse scope+agent from recipient address
 * 2. Look up sender email in Clerk to get user ID
 * 3. Resolve agent by scope slug + agent name
 * 4. Check if user has permission to access the agent
 * 5. Create agent run with callback for response delivery
 *
 * All failures are silent (no response email) to prevent information leakage.
 */
export async function handleInboundEmailTrigger(
  event: InboundEmailEvent,
): Promise<void> {
  const { email_id: emailId, to, from: senderEmail, subject } = event.data;

  // 1. Find trigger address in recipients
  let triggerAddress: { scope: string; agent: string } | null = null;

  for (const addr of to) {
    const parsed = parseEmailTriggerAddress(addr);
    if (parsed) {
      triggerAddress = parsed;
      break;
    }
  }

  if (!triggerAddress) {
    log.debug("No trigger address found in recipients", { to });
    return;
  }

  log.debug("Processing email trigger", {
    scope: triggerAddress.scope,
    agent: triggerAddress.agent,
    from: senderEmail,
  });

  // 2. Look up sender in Clerk
  const userId = await getUserIdByEmail(senderEmail);
  if (!userId) {
    log.debug("Sender email not registered", { from: senderEmail });
    return;
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

  // 5. Fetch full email and build prompt
  const email = await getReceivedEmail(emailId);
  const bodyContent = stripQuotedReply(email.text);

  // Combine subject + body as prompt
  const prompt = subject
    ? `${subject}\n\n${bodyContent}`.trim()
    : bodyContent.trim();

  if (!prompt) {
    log.debug("Empty prompt after processing", { emailId });
    return;
  }

  // 6. Generate reply token for conversation continuity
  const sessionPlaceholderId = crypto.randomUUID();
  const replyToken = generateReplyToken(sessionPlaceholderId);

  // 7. Build callback
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
      },
    },
  ];

  // 8. Create and dispatch run
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
