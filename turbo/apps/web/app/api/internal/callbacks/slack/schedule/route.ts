import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { agentRunCallbacks } from "../../../../../../src/db/schema/agent-run-callback";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { slackUserLinks } from "../../../../../../src/db/schema/slack-user-link";
import { slackInstallations } from "../../../../../../src/db/schema/slack-installation";
import {
  createSlackClient,
  postMessage,
} from "../../../../../../src/lib/slack";
import { getRunOutput } from "../../../../../../src/lib/slack/handlers/run-agent";
import {
  saveThreadSession,
  buildLogsUrl,
} from "../../../../../../src/lib/slack/handlers/shared";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";

const log = logger("callback:slack:schedule");

interface CallbackPayload {
  scheduleId: string;
  composeId: string;
  composeName: string;
  userId: string;
}

interface CallbackBody {
  runId: string;
  status: "completed" | "failed";
  result?: Record<string, unknown>;
  error?: string;
  payload: CallbackPayload;
}

function parsePayload(body: CallbackBody): CallbackPayload | null {
  if (!body.payload) return null;
  const p = body.payload;
  if (
    typeof p.scheduleId !== "string" ||
    typeof p.composeId !== "string" ||
    typeof p.composeName !== "string" ||
    typeof p.userId !== "string"
  ) {
    return null;
  }
  return p;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

function extractAgentSessionId(result: unknown): string | undefined {
  if (
    result &&
    typeof result === "object" &&
    "agentSessionId" in result &&
    typeof result.agentSessionId === "string"
  ) {
    return result.agentSessionId;
  }
  return undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = env();

  // Read raw body for signature verification
  const rawBody = await request.text();

  let body: CallbackBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  const { runId, status, error } = body;

  if (!runId) {
    return errorResponse("Missing runId", 400);
  }

  // Query callback record to get the per-callback secret
  const [callback] = await globalThis.services.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(eq(agentRunCallbacks.runId, runId))
    .limit(1);

  if (!callback) {
    log.warn("Callback record not found", { runId });
    return errorResponse("Callback not found", 404);
  }

  // Decrypt the per-callback secret and verify signature
  const callbackSecret = decryptCredentialValue(
    callback.encryptedSecret,
    SECRETS_ENCRYPTION_KEY,
  );

  const signature = request.headers.get("X-VM0-Signature");
  const timestamp = request.headers.get("X-VM0-Timestamp");

  const verification = verifyCallbackRequest(
    rawBody,
    callbackSecret,
    signature,
    timestamp,
  );

  if (!verification.valid) {
    log.warn("Callback signature verification failed", {
      runId,
      error: verification.error,
    });
    return errorResponse(verification.error ?? "Invalid signature", 401);
  }

  const payload = parsePayload(body);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { composeName, userId } = payload;

  log.debug("Processing Slack schedule callback", { runId, status });

  // Find slack user link for this VM0 user
  const [userLink] = await globalThis.services.db
    .select({
      id: slackUserLinks.id,
      slackUserId: slackUserLinks.slackUserId,
      slackWorkspaceId: slackUserLinks.slackWorkspaceId,
    })
    .from(slackUserLinks)
    .where(eq(slackUserLinks.vm0UserId, userId))
    .limit(1);

  if (!userLink) {
    log.debug("No Slack user link found, skipping notification", { userId });
    return NextResponse.json({ success: true, skipped: true });
  }

  // Get installation and decrypt bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, userLink.slackWorkspaceId))
    .limit(1);

  if (!installation) {
    log.warn("No Slack installation found for workspace", {
      workspaceId: userLink.slackWorkspaceId,
    });
    return errorResponse("Slack installation not found", 404);
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // Build and send notification
  const logsUrl = buildLogsUrl(runId);

  if (status === "completed") {
    const rawOutput = await getRunOutput(runId);
    const truncatedOutput = rawOutput
      ? rawOutput.length > 2000
        ? `${rawOutput.slice(0, 2000)}…`
        : rawOutput
      : "Task completed successfully.";

    const { ts: messageTs, channel: dmChannelId } = await postMessage(
      client,
      userLink.slackUserId,
      `Scheduled run for "${composeName}" completed`,
      {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:white_check_mark: *Scheduled run for \`${composeName}\` completed*`,
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: truncatedOutput,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<${logsUrl}|View logs> · Reply in this thread to continue the conversation`,
              },
            ],
          },
        ],
      },
    );

    // Create thread session so user can reply to continue
    const [run] = await globalThis.services.db
      .select({ result: agentRuns.result })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    const agentSessionId = extractAgentSessionId(run?.result);

    if (messageTs && dmChannelId && agentSessionId) {
      await saveThreadSession({
        userLinkId: userLink.id,
        channelId: dmChannelId,
        threadTs: messageTs,
        existingSessionId: undefined,
        newSessionId: agentSessionId,
        messageTs,
        runStatus: "completed",
      });
    }
  } else {
    // Failed run
    const errMsg = error ?? "Unknown error";
    await postMessage(
      client,
      userLink.slackUserId,
      `Scheduled run for "${composeName}" failed`,
      {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:x: *Scheduled run for \`${composeName}\` failed*\n\n${errMsg}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<${logsUrl}|View logs>`,
              },
            ],
          },
        ],
      },
    );
  }

  log.info("Sent Slack schedule notification", {
    runId,
    status,
    agentName: composeName,
  });

  return NextResponse.json({ success: true });
}
