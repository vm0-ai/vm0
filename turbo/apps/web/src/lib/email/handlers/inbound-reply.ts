import { eq } from "drizzle-orm";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getReceivedEmail } from "../client";
import { stripQuotedReply } from "../quote-strip";
import { verifyReplyToken, lookupEmailThreadSession } from "./shared";
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
 * Handle an inbound email reply. Dispatches an agent run (fire-and-forget).
 * The response email is sent from the completion webhook.
 */
export async function handleInboundEmailReply(
  event: InboundEmailEvent,
): Promise<void> {
  const { email_id: emailId, to } = event.data;

  // 1. Parse plus address from to field
  const replyToAddress = to.find((addr) => addr.includes("reply+"));
  if (!replyToAddress) {
    log.debug("No reply+ address found, ignoring", { to });
    return;
  }

  const tokenMatch = replyToAddress.match(/reply\+([^@]+)@/);
  const token = tokenMatch?.[1];
  if (!token) {
    log.debug("Could not parse reply token", { replyToAddress });
    return;
  }

  // 2. Verify HMAC token
  const sessionId = verifyReplyToken(token);
  if (!sessionId) {
    log.warn("Invalid reply token (HMAC verification failed)", { token });
    return;
  }

  // 3. Look up email thread session
  const session = await lookupEmailThreadSession(token);
  if (!session) {
    log.warn("No email thread session found for token", { token });
    return;
  }

  // 4. Fetch full email body from Resend
  const email = await getReceivedEmail(emailId);

  // 5. Strip quoted text
  const replyContent = stripQuotedReply(email.text);
  if (!replyContent.trim()) {
    log.debug("Empty reply content after stripping", { emailId });
    return;
  }

  // 6. Get compose to find agent name and version
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
    return;
  }

  // 7. Build callbacks for email reply notification
  const callbacks = [
    {
      url: `${getApiUrl()}/api/internal/callbacks/email/reply`,
      secret: generateCallbackSecret(),
      payload: {
        emailThreadSessionId: session.id,
        inboundEmailId: emailId,
      },
    },
  ];

  // 8. Create and dispatch run via unified pipeline
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
}
