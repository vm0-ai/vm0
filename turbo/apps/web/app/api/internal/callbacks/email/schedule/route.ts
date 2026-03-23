import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { resolveComposeByZeroAgentId } from "../../../../../../src/lib/schedule/schedule-service";
import { getRunOutputText } from "../../../../../../src/lib/run/extract-run-output";
import { enqueueEmail } from "../../../../../../src/lib/email/outbox-service";
import {
  generateReplyToken,
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
  buildUnsubscribeUrl,
  buildUnsubscribeHeaders,
} from "../../../../../../src/lib/email/handlers/shared";
import { isUserUnsubscribed } from "../../../../../../src/lib/email/unsubscribe-service";
import { env } from "../../../../../../src/env";
import type { EmailScheduleCallbackPayload } from "../../../../../../src/lib/callback/callback-payloads";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:email:schedule");

function parsePayload(payload: unknown): EmailScheduleCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.scheduleId !== "string" ||
    typeof p.zeroAgentId !== "string" ||
    typeof p.agentName !== "string" ||
    typeof p.userId !== "string"
  ) {
    return null;
  }
  return p as unknown as EmailScheduleCallbackPayload;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  // Skip if Resend is not configured
  if (!env().RESEND_API_KEY) {
    return NextResponse.json({ success: true, skipped: true });
  }

  const result = await verifyCallback<EmailScheduleCallbackPayload>(
    request,
    log,
  );
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { agentName, userId } = payload;

  log.debug("Processing email schedule callback", { runId, status });

  // Progress notifications are not applicable for email — no-op.
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  // Check if user has unsubscribed from system emails
  if (await isUserUnsubscribed(userId)) {
    log.debug("User has unsubscribed, skipping email notification", { userId });
    return NextResponse.json({ success: true, skipped: true });
  }

  // Get user email
  const userEmail = await getUserEmail(userId);
  if (!userEmail) {
    log.debug("No email found for user, skipping notification", { userId });
    return NextResponse.json({ success: true, skipped: true });
  }

  const logsUrl = buildLogsUrl(runId);
  const unsubscribeUrl = buildUnsubscribeUrl(userId);
  const unsubscribeHeaders = buildUnsubscribeHeaders(unsubscribeUrl);

  if (status === "completed") {
    // Get agent output
    const output = await getRunOutputText(runId);
    const truncatedOutput = output
      ? output.length > 2000
        ? `${output.slice(0, 2000)}…`
        : output
      : "Task completed successfully.";

    // Extract agentSessionId from run result
    const [run] = await globalThis.services.db
      .select({ result: agentRuns.result })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    const runResult = run?.result;
    const agentSessionId =
      runResult &&
      typeof runResult === "object" &&
      "agentSessionId" in runResult &&
      typeof runResult.agentSessionId === "string"
        ? runResult.agentSessionId
        : undefined;

    // Generate reply token and send email
    const sessionPlaceholderId = crypto.randomUUID();
    const replyToken = generateReplyToken(sessionPlaceholderId);
    const replyToAddress = buildReplyToAddress(replyToken);

    await enqueueEmail({
      from: buildFromAddress(agentName),
      to: userEmail,
      subject: `VM0 - Scheduled run for "${agentName}" completed`,
      template: {
        template: "schedule-completed",
        props: {
          agentName,
          output: truncatedOutput,
          logsUrl,
          unsubscribeUrl,
        },
      },
      replyTo: replyToAddress,
      headers: unsubscribeHeaders,
      threadAction: agentSessionId
        ? await (async () => {
            const compose = await resolveComposeByZeroAgentId(
              payload.zeroAgentId,
            );
            if (!compose) return undefined;
            return {
              action: "save_thread_session" as const,
              userId,
              composeId: compose.id,
              agentSessionId,
              replyToToken: replyToken,
            };
          })()
        : undefined,
    });
  } else {
    // Failed run
    await enqueueEmail({
      from: buildFromAddress(agentName),
      to: userEmail,
      subject: `VM0 - Scheduled run for "${agentName}" failed`,
      template: {
        template: "schedule-failed",
        props: {
          agentName,
          errorMessage: error ?? "Unknown error",
          logsUrl,
          unsubscribeUrl,
        },
      },
      headers: unsubscribeHeaders,
    });
  }

  log.info("Sent email schedule notification", {
    runId,
    status,
    agentName,
  });

  return NextResponse.json({ success: true });
}
