import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { getUserEmail } from "../../../../../../src/lib/auth/get-user-email";
import { getRunOutput } from "../../../../../../src/lib/slack/handlers/run-agent";
import { enqueueEmail } from "../../../../../../src/lib/email/outbox-service";
import {
  generateReplyToken,
  buildReplyToAddress,
  buildFromAddress,
  buildLogsUrl,
} from "../../../../../../src/lib/email/handlers/shared";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:email:schedule");

interface CallbackPayload {
  scheduleId: string;
  composeId: string;
  composeName: string;
  userId: string;
}

function parsePayload(payload: unknown): CallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.scheduleId !== "string" ||
    typeof p.composeId !== "string" ||
    typeof p.composeName !== "string" ||
    typeof p.userId !== "string"
  ) {
    return null;
  }
  return p as unknown as CallbackPayload;
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

  const result = await verifyCallback<CallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { composeId, composeName, userId } = payload;

  log.debug("Processing email schedule callback", { runId, status });

  // Progress notifications are not applicable for email — no-op.
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  // Get user email
  const userEmail = await getUserEmail(userId);
  if (!userEmail) {
    log.debug("No email found for user, skipping notification", { userId });
    return NextResponse.json({ success: true, skipped: true });
  }

  const logsUrl = buildLogsUrl(runId, composeName);

  if (status === "completed") {
    // Get agent output
    const output = await getRunOutput(runId);
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
      from: buildFromAddress(composeName),
      to: userEmail,
      subject: `VM0 - Scheduled run for "${composeName}" completed`,
      template: {
        template: "schedule-completed",
        props: { agentName: composeName, output: truncatedOutput, logsUrl },
      },
      replyTo: replyToAddress,
      threadAction: agentSessionId
        ? {
            action: "save_thread_session",
            userId,
            composeId,
            agentSessionId,
            replyToToken: replyToken,
          }
        : undefined,
    });
  } else {
    // Failed run
    await enqueueEmail({
      from: buildFromAddress(composeName),
      to: userEmail,
      subject: `VM0 - Scheduled run for "${composeName}" failed`,
      template: {
        template: "schedule-failed",
        props: {
          agentName: composeName,
          errorMessage: error ?? "Unknown error",
          logsUrl,
        },
      },
    });
  }

  log.info("Sent email schedule notification", {
    runId,
    status,
    agentName: composeName,
  });

  return NextResponse.json({ success: true });
}
