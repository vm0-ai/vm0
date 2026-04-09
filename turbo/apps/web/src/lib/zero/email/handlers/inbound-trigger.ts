import { getReceivedEmail } from "../client";
import { processEmailAttachments } from "../attachment";
import { extractEmailBody } from "../content-extract";
import { verifySenderAuthenticity } from "../sender-auth";
import {
  parseOrgEmailAddress,
  resolveDefaultAgent,
  generateReplyToken,
  computeReplyRecipients,
  getFromDomain,
  type HandlerResult,
} from "./shared";
import { createZeroRun } from "../../zero-run-service";
import { buildIntegrationPrompt } from "../../integration-prompt";
import { generateCallbackSecret, getApiUrl } from "../../../infra/callback";
import { getUserIdByEmail } from "../../../auth/get-user-id-by-email";
import { getOrgIdBySlug } from "../../../auth/org-cache";
import { getMemberRole } from "../../../auth/org-membership-cache";
import { logger } from "../../../shared/logger";

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
  orgId: string;
  orgSlug: string;
  userId: string;
  agentId: string;
}

/**
 * Parse org address from recipients, resolve sender, org, membership, and default agent.
 */
async function resolveTrigger(
  to: string[],
  senderEmail: string,
): Promise<ResolvedTrigger | HandlerResult> {
  // 1. Parse org slug from recipients
  let orgSlug: string | null = null;
  for (const addr of to) {
    orgSlug = parseOrgEmailAddress(addr);
    if (orgSlug) break;
  }

  if (!orgSlug) {
    log.debug("No org address found in recipients", { to });
    return {
      ok: false,
      errorMessage:
        "The email address could not be recognized as a valid org address.",
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

  // 3. Resolve org by slug
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) {
    log.debug("Org not found", { orgSlug });
    return {
      ok: false,
      errorMessage: `Workspace "${orgSlug}" was not found.`,
    };
  }

  // 4. Verify org membership
  const membership = await getMemberRole(orgId, userId);
  if (!membership) {
    log.debug("User is not a member of org", { userId, orgId });
    return {
      ok: false,
      errorMessage: "You are not a member of this workspace.",
    };
  }

  // 5. Resolve default agent
  const agentId = await resolveDefaultAgent(orgId);
  if (!agentId) {
    log.debug("No default agent configured", { orgId });
    return {
      ok: false,
      errorMessage: "This workspace does not have a default agent configured.",
    };
  }

  return {
    orgId,
    orgSlug,
    userId,
    agentId,
  };
}

/**
 * Handle an inbound email that triggers an agent run.
 *
 * Flow:
 * 1. Parse org address from recipients
 * 2. Look up sender email to get user ID
 * 3. Verify org membership
 * 4. Resolve org's default agent
 * 5. Fetch full email and verify sender via DMARC
 * 6. Create agent run with callback for response delivery
 *
 * Returns a HandlerResult so the caller can send an error reply on failure.
 */
export async function handleInboundEmailTrigger(
  event: InboundEmailEvent,
): Promise<HandlerResult> {
  const { email_id: emailId, to, from: senderEmail, subject } = event.data;

  // 1-4. Resolve trigger: address, sender, org, membership, default agent
  const resolved = await resolveTrigger(to, senderEmail);
  if ("ok" in resolved) return resolved;

  const { orgId, orgSlug, userId, agentId } = resolved;

  log.debug("Processing email trigger", {
    orgSlug,
    from: senderEmail,
  });

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
  const messageIdKey = Object.keys(headers).find((k) => {
    return k.toLowerCase() === "message-id";
  });
  const inboundMessageId = messageIdKey ? headers[messageIdKey] : undefined;
  const referencesKey = Object.keys(headers).find((k) => {
    return k.toLowerCase() === "references";
  });
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
      url: `${getApiUrl()}/api/zero/email/callbacks/trigger`,
      secret: generateCallbackSecret(),
      payload: {
        senderEmail,
        agentId,
        userId,
        inboundEmailId: emailId,
        replyToken,
        inboundMessageId,
        inboundReferences,
        subject,
        runtimeOrgId: orgId,
        replyRecipientTo: replyRecipients.to,
        replyRecipientCc: replyRecipients.cc,
      },
    },
  ];

  // 12. Create run with integration context as system prompt
  const appendSystemPrompt = buildIntegrationPrompt("Email");
  const result = await createZeroRun({
    userId,
    prompt,
    appendSystemPrompt,
    agentId,
    triggerSource: "email",
    callbacks,
  });

  log.info("Dispatched agent run from email trigger", {
    runId: result.runId,
    emailId,
    orgSlug,
  });

  return { ok: true };
}
