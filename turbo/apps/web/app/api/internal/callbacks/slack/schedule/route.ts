import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../../src/lib/crypto/secrets-encryption";
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

  const result = await verifyCallback<CallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { composeName, userId } = payload;

  log.debug("Processing Slack schedule callback", { runId, status });

  const { SECRETS_ENCRYPTION_KEY } = env();

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
