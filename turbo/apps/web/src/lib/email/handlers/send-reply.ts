import { eq } from "drizzle-orm";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getUserEmail } from "../../auth/get-user-email";
import { getRunOutput } from "../../slack/handlers/run-agent";
import { sendEmail } from "../client";
import {
  lookupEmailReplyRequest,
  updateEmailThreadSession,
  deleteEmailReplyRequest,
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
} from "./shared";
import { emailThreadSessions } from "../../../db/schema/email-thread-session";
import { AgentReplyEmail } from "../templates/agent-reply";
import { logger } from "../../logger";

const log = logger("email:send-reply");

/**
 * Send a response email for an agent run that was triggered by an email reply.
 * No-op if no email reply request exists for the given runId.
 */
export async function sendEmailReplyIfNeeded(
  runId: string,
  status: "completed" | "failed",
  errorMessage?: string,
): Promise<void> {
  // 1. Check if this run was triggered by an email reply
  const request = await lookupEmailReplyRequest(runId);
  if (!request) return; // Not an email-triggered run

  // 2. Look up the email thread session
  const [session] = await globalThis.services.db
    .select()
    .from(emailThreadSessions)
    .where(eq(emailThreadSessions.id, request.emailThreadSessionId))
    .limit(1);

  if (!session) {
    log.error("Email thread session not found", {
      sessionId: request.emailThreadSessionId,
    });
    return;
  }

  // 3. Get compose name
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, session.composeId))
    .limit(1);

  if (!compose) return;

  // 4. Get user email from Clerk
  const userEmail = await getUserEmail(session.userId);
  if (!userEmail) return;

  // 5. Get run output
  const logsUrl = buildLogsUrl(runId);
  let output: string;

  if (status === "completed") {
    const rawOutput = await getRunOutput(runId);
    output = rawOutput
      ? rawOutput.length > 2000
        ? `${rawOutput.slice(0, 2000)}…`
        : rawOutput
      : "Task completed successfully.";
  } else {
    output = errorMessage ?? "The agent run failed.";
  }

  // 6. Get agentSessionId from run result for session continuity
  const [run] = await globalThis.services.db
    .select({ result: agentRuns.result })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const newAgentSessionId =
    run?.result &&
    typeof run.result === "object" &&
    "agentSessionId" in run.result &&
    typeof run.result.agentSessionId === "string"
      ? run.result.agentSessionId
      : undefined;

  // 7. Send response email with threading headers
  const replyToAddress = buildReplyToAddress(session.replyToToken);
  const headers: Record<string, string> = {};

  if (session.lastEmailMessageId) {
    headers["In-Reply-To"] = session.lastEmailMessageId;
    headers["References"] = session.lastEmailMessageId;
  }

  const { messageId } = await sendEmail({
    from: buildFromAddress(compose.name),
    to: userEmail,
    subject: `Re: Reply from "${compose.name}"`,
    react: AgentReplyEmail({
      agentName: compose.name,
      output,
      logsUrl,
    }),
    replyTo: replyToAddress,
    headers,
  });

  // 8. Update email thread session with new message ID and session
  await updateEmailThreadSession(session.id, {
    ...(newAgentSessionId ? { agentSessionId: newAgentSessionId } : {}),
    lastEmailMessageId: messageId,
  });

  // 9. Delete the consumed reply request
  await deleteEmailReplyRequest(request.id);

  log.info("Sent email reply", {
    runId,
    status,
    agentName: compose.name,
  });
}
