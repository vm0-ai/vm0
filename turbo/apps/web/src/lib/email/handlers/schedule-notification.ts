import { eq } from "drizzle-orm";
import { agentRuns } from "../../../db/schema/agent-run";
import { agentSchedules } from "../../../db/schema/agent-schedule";
import { agentComposes } from "../../../db/schema/agent-compose";
import { getUserEmail } from "../../auth/get-user-email";
import { getRunOutput } from "../../slack/handlers/run-agent";
import { sendEmail } from "../client";
import {
  generateReplyToken,
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
  saveEmailThreadSession,
} from "./shared";
import { ScheduleCompletedEmail } from "../templates/schedule-completed";
import { ScheduleFailedEmail } from "../templates/schedule-failed";
import { env } from "../../../env";
import { logger } from "../../logger";

const log = logger("email:schedule-notification");

/**
 * Send an email notification when a scheduled agent run completes.
 * Creates an email thread session so the user can reply to continue.
 */
export async function notifyScheduleRunCompleteEmail(
  runId: string,
  status: "completed" | "failed",
  errorMessage?: string,
): Promise<void> {
  // Skip if Resend is not configured
  if (!env().RESEND_API_KEY) return;

  // 1. Get run to find scheduleId and agentSessionId
  const [run] = await globalThis.services.db
    .select({
      scheduleId: agentRuns.scheduleId,
      result: agentRuns.result,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run?.scheduleId) return;

  // 2. Get schedule to find composeId
  const [schedule] = await globalThis.services.db
    .select({
      composeId: agentSchedules.composeId,
    })
    .from(agentSchedules)
    .where(eq(agentSchedules.id, run.scheduleId))
    .limit(1);

  if (!schedule) return;

  // 3. Get compose info (agent name + user)
  const [compose] = await globalThis.services.db
    .select({
      userId: agentComposes.userId,
      name: agentComposes.name,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, schedule.composeId))
    .limit(1);

  if (!compose) return;

  // 4. Get user email from Clerk
  const userEmail = await getUserEmail(compose.userId);
  if (!userEmail) {
    log.debug("No email found for user, skipping notification", {
      userId: compose.userId,
    });
    return;
  }

  const logsUrl = buildLogsUrl(runId);

  if (status === "completed") {
    // 5. Get agent output
    const output = await getRunOutput(runId);
    const truncatedOutput = output
      ? output.length > 2000
        ? `${output.slice(0, 2000)}…`
        : output
      : "Task completed successfully.";

    // 6. Extract agentSessionId from run result
    const result = run.result;
    const agentSessionId =
      result &&
      typeof result === "object" &&
      "agentSessionId" in result &&
      typeof result.agentSessionId === "string"
        ? result.agentSessionId
        : undefined;

    // 7. Generate reply token and send email
    const sessionPlaceholderId = crypto.randomUUID();
    const replyToken = generateReplyToken(sessionPlaceholderId);
    const replyToAddress = buildReplyToAddress(replyToken);

    const { messageId } = await sendEmail({
      from: buildFromAddress(compose.name),
      to: userEmail,
      subject: `Scheduled run for "${compose.name}" completed`,
      react: ScheduleCompletedEmail({
        agentName: compose.name,
        output: truncatedOutput,
        logsUrl,
      }),
      replyTo: replyToAddress,
    });

    // 8. Save email thread session for reply-to-continue
    if (agentSessionId) {
      await saveEmailThreadSession({
        userId: compose.userId,
        composeId: schedule.composeId,
        agentSessionId,
        lastEmailMessageId: messageId,
        replyToToken: replyToken,
      });
    }
  } else {
    // Failed run
    await sendEmail({
      from: buildFromAddress(compose.name),
      to: userEmail,
      subject: `Scheduled run for "${compose.name}" failed`,
      react: ScheduleFailedEmail({
        agentName: compose.name,
        errorMessage: errorMessage ?? "Unknown error",
        logsUrl,
      }),
    });
  }

  log.info("Sent email schedule notification", {
    runId,
    status,
    agentName: compose.name,
  });
}
