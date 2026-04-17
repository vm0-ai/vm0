import { getReceivedEmail } from "../client";
import { processEmailAttachments } from "../attachment";
import { extractEmailBody } from "../content-extract";
import { verifySenderAuthenticity } from "../sender-auth";
import {
  verifyReplyToken,
  lookupEmailThreadSession,
  computeReplyRecipients,
  getFromDomain,
  type HandlerResult,
} from "./shared";
import { createZeroRun } from "../../zero-run-service";
import { adaptEmailReplyTrigger } from "./adapt-email-reply";
import { getUserIdByEmail } from "../../../auth/get-user-id-by-email";
import { logger } from "../../../shared/logger";

const log = logger("email:inbound-reply");

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
 * Handle an inbound email reply. Dispatches an agent run.
 * The response email is sent from the completion callback.
 *
 * Returns a HandlerResult so the caller can send an error reply on failure.
 */
export async function handleInboundEmailReply(
  event: InboundEmailEvent,
): Promise<HandlerResult> {
  const { email_id: emailId, to } = event.data;

  // 1. Parse plus address from to field
  const replyToAddress = to.find((addr) => {
    return addr.includes("reply+");
  });
  if (!replyToAddress) {
    log.debug("No reply+ address found, ignoring", { to });
    return {
      ok: false,
      errorMessage: "The reply address could not be recognized.",
    };
  }

  const tokenMatch = replyToAddress.match(/reply\+([^@]+)@/);
  const token = tokenMatch?.[1];
  if (!token) {
    log.debug("Could not parse reply token", { replyToAddress });
    return {
      ok: false,
      errorMessage: "The reply address could not be recognized.",
    };
  }

  // 2. Verify HMAC token
  const sessionId = verifyReplyToken(token);
  if (!sessionId) {
    log.warn("Invalid reply token (HMAC verification failed)", { token });
    return {
      ok: false,
      errorMessage:
        "This conversation thread has expired or is no longer valid.",
    };
  }

  // 3. Look up email thread session
  const session = await lookupEmailThreadSession(token);
  if (!session) {
    log.warn("No email thread session found for token", { token });
    return {
      ok: false,
      errorMessage:
        "This conversation thread has expired or is no longer valid.",
    };
  }

  // 4. Verify sender is the session owner
  const senderEmail = event.data.from;
  const senderUserId = await getUserIdByEmail(senderEmail);
  if (!senderUserId) {
    log.debug("Reply sender email not registered", { from: senderEmail });
    return {
      ok: false,
      errorMessage: "Your email address is not associated with a VM0 account.",
    };
  }

  if (senderUserId !== session.userId) {
    log.warn("Reply sender does not match session owner", {
      from: senderEmail,
      senderUserId,
      sessionUserId: session.userId,
    });
    return {
      ok: false,
      errorMessage:
        "Only the original sender can continue this email conversation.",
    };
  }

  // 5. Fetch full email body from Resend
  const email = await getReceivedEmail(emailId);

  // 6. Verify sender authenticity via DMARC
  const verification = verifySenderAuthenticity(email.headers);
  if (!verification.verified) {
    log.warn("Reply sender authentication failed", {
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

  // 7. Compute reply recipients based on bot position in To/CC
  const replyRecipients = computeReplyRecipients({
    from: event.data.from,
    to: email.to,
    cc: email.cc,
    replyTo: email.replyTo,
    botDomain: getFromDomain(),
  });

  // 8. Extract inbound Message-ID and References for threading (case-insensitive lookup)
  const headers = email.headers ?? {};
  const messageIdKey = Object.keys(headers).find((k) => {
    return k.toLowerCase() === "message-id";
  });
  const inboundMessageId = messageIdKey ? headers[messageIdKey] : undefined;
  const referencesKey = Object.keys(headers).find((k) => {
    return k.toLowerCase() === "references";
  });
  const inboundReferences = referencesKey ? headers[referencesKey] : undefined;

  // 9. Extract email body (prefer HTML, fallback to text, strip quotes)
  let replyContent = extractEmailBody(email.html, email.text);
  if (!replyContent.trim()) {
    log.debug("Empty reply content after stripping", { emailId });
    return {
      ok: false,
      errorMessage: "Your reply was empty after processing.",
    };
  }

  // 9b. Process attachments and append to reply content
  const attachmentText = await processEmailAttachments(emailId);
  if (attachmentText) {
    replyContent = `${replyContent}\n\n${attachmentText}`;
  }

  // 10. Dispatch agent run via pure adapter
  const result = await createZeroRun(
    adaptEmailReplyTrigger({
      userId: session.userId,
      agentId: session.agentId,
      sessionId: session.agentSessionId,
      prompt: replyContent,
      callbackPayload: {
        emailThreadSessionId: session.id,
        inboundEmailId: emailId,
        inboundMessageId,
        inboundReferences,
        replyRecipientTo: replyRecipients.to,
        replyRecipientCc: replyRecipients.cc,
      },
    }),
  );

  log.info("Dispatched agent run from email reply", {
    runId: result.runId,
    emailId,
    agentId: session.agentId,
  });

  return { ok: true };
}
