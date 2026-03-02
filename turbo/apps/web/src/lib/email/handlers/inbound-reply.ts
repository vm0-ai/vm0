import { eq } from "drizzle-orm";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getReceivedEmail } from "../client";
import { processEmailAttachments } from "../attachment";
import { extractEmailBody } from "../content-extract";
import {
  verifyReplyToken,
  lookupEmailThreadSession,
  type HandlerResult,
} from "./shared";
import { createRun } from "../../run";
import { generateCallbackSecret, getApiUrl } from "../../callback";
import { logger } from "../../logger";

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
  const replyToAddress = to.find((addr) => addr.includes("reply+"));
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

  // 4. Fetch full email body from Resend
  const email = await getReceivedEmail(emailId);

  // 5. Extract inbound Message-ID and References for threading (case-insensitive lookup)
  const headers = email.headers ?? {};
  const messageIdKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "message-id",
  );
  const inboundMessageId = messageIdKey ? headers[messageIdKey] : undefined;
  const referencesKey = Object.keys(headers).find(
    (k) => k.toLowerCase() === "references",
  );
  const inboundReferences = referencesKey ? headers[referencesKey] : undefined;

  // 6. Extract email body (prefer HTML, fallback to text, strip quotes)
  let replyContent = extractEmailBody(email.html, email.text);
  if (!replyContent.trim()) {
    log.debug("Empty reply content after stripping", { emailId });
    return {
      ok: false,
      errorMessage: "Your reply was empty after processing.",
    };
  }

  // 6b. Process attachments and append to reply content
  const attachmentText = await processEmailAttachments(emailId);
  if (attachmentText) {
    replyContent = `${replyContent}\n\n${attachmentText}`;
  }

  // 7. Get compose to find agent name and version
  const [compose] = await globalThis.services.db
    .select({
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, session.composeId))
    .limit(1);

  if (!compose) {
    log.error("Compose not found for email reply", {
      composeId: session.composeId,
    });
    return {
      ok: false,
      errorMessage: "The agent for this conversation has been removed.",
    };
  }

  // 8. Build callbacks for email reply notification
  const callbacks = [
    {
      url: `${getApiUrl()}/api/internal/callbacks/email/reply`,
      secret: generateCallbackSecret(),
      payload: {
        emailThreadSessionId: session.id,
        inboundEmailId: emailId,
        inboundMessageId,
        inboundReferences,
      },
    },
  ];

  // 9. Create and dispatch run via unified pipeline
  const result = await createRun({
    userId: session.userId,
    agentComposeVersionId: compose.headVersionId ?? "",
    prompt: replyContent,
    composeId: session.composeId,
    sessionId: session.agentSessionId,
    agentName: compose.name,
    callbacks,
  });

  log.info("Dispatched agent run from email reply", {
    runId: result.runId,
    emailId,
    agentName: compose.name,
  });

  return { ok: true };
}
