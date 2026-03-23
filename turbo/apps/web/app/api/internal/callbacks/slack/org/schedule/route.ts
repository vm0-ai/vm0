import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import type { Block, KnownBlock } from "@slack/web-api";
import { initServices } from "../../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../../src/lib/callback";
import { decryptSecretValue } from "../../../../../../../src/lib/crypto/secrets-encryption";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { slackOrgConnections } from "../../../../../../../src/db/schema/slack-org-connection";
import { slackOrgInstallations } from "../../../../../../../src/db/schema/slack-org-installation";
import {
  createSlackClient,
  postMessage,
} from "../../../../../../../src/lib/slack/client";
import { getAllRunOutputTexts } from "../../../../../../../src/lib/run/extract-run-output";
import {
  saveThreadSession,
  buildLogsUrl,
  getWorkspaceAgent,
} from "../../../../../../../src/lib/slack-org/handlers/shared";
import { env } from "../../../../../../../src/env";
import type { SlackScheduleCallbackPayload } from "../../../../../../../src/lib/callback/callback-payloads";
import { logger } from "../../../../../../../src/lib/logger";

const log = logger("callback:slack-org:schedule");

function parsePayload(payload: unknown): SlackScheduleCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.scheduleId !== "string" ||
    typeof p.composeId !== "string" ||
    typeof p.composeName !== "string" ||
    typeof p.userId !== "string" ||
    typeof p.orgId !== "string"
  ) {
    return null;
  }
  return p as unknown as SlackScheduleCallbackPayload;
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

/**
 * Post all result texts as a threaded Slack conversation.
 *
 * The first message includes the header; subsequent results are threaded replies.
 * Only the last message includes the audit link.
 */
async function postScheduleResults(
  client: ReturnType<typeof createSlackClient>,
  channel: string,
  displayName: string,
  texts: string[],
  logsUrl: string,
): Promise<{ messageTs: string | undefined; dmChannelId: string | undefined }> {
  let messageTs: string | undefined;
  let dmChannelId: string | undefined;

  for (let i = 0; i < texts.length; i++) {
    const rawOutput = texts[i]!;
    const truncatedOutput =
      rawOutput.length > 2000 ? `${rawOutput.slice(0, 2000)}…` : rawOutput;

    const isFirst = i === 0;
    const isLast = i === texts.length - 1;

    const blocks: (Block | KnownBlock)[] = [];

    if (isFirst) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Scheduled run for \`${displayName}\` completed*`,
        },
      });
    }

    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: truncatedOutput },
    });

    if (isLast) {
      blocks.push({
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: `<${logsUrl}|Audit> · Reply in this thread to continue the conversation`,
          },
        ],
      });
    }

    const threadTs = messageTs;
    const result = await postMessage(
      client,
      dmChannelId ?? channel,
      isFirst
        ? `Scheduled run for "${displayName}" completed`
        : truncatedOutput,
      {
        ...(threadTs ? { threadTs } : {}),
        blocks,
      },
    );

    if (isFirst) {
      messageTs = result.ts;
      dmChannelId = result.channel;
    }
  }

  return { messageTs, dmChannelId };
}

/**
 * POST /api/internal/callbacks/slack/org/schedule
 *
 * Org-aware schedule callback for Slack notifications.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<SlackScheduleCallbackPayload>(
    request,
    log,
  );
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const { composeName, userId } = payload;

  log.debug("Processing Slack org schedule callback", { runId, status });

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Find connection for this VM0 user
  const [connection] = await globalThis.services.db
    .select({
      id: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
      slackWorkspaceId: slackOrgConnections.slackWorkspaceId,
    })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.vm0UserId, userId))
    .limit(1);

  if (!connection) {
    log.debug("No Slack org connection found, skipping notification", {
      userId,
    });
    return NextResponse.json({ success: true, skipped: true });
  }

  // Get installation and decrypt bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(
      eq(slackOrgInstallations.slackWorkspaceId, connection.slackWorkspaceId),
    )
    .limit(1);

  if (!installation) {
    log.warn("No Slack org installation found for workspace", {
      workspaceId: connection.slackWorkspaceId,
    });
    return errorResponse("Slack installation not found", 404);
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const logsUrl = buildLogsUrl(runId);

  // Resolve display name for user-visible messages
  const agentInfo = await getWorkspaceAgent(payload.composeId);
  const displayName = agentInfo?.displayName ?? composeName;

  if (status === "completed") {
    const allTexts = await getAllRunOutputTexts(runId);
    if (allTexts.length === 0) {
      allTexts.push("Task completed successfully.");
    }

    const { messageTs, dmChannelId } = await postScheduleResults(
      client,
      connection.slackUserId,
      displayName,
      allTexts,
      logsUrl,
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
        connectionId: connection.id,
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
      connection.slackUserId,
      `Scheduled run for "${displayName}" failed`,
      {
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:x: *Scheduled run for \`${displayName}\` failed*\n\n${errMsg}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `<${logsUrl}|Audit>`,
              },
            ],
          },
        ],
      },
    );
  }

  log.info("Sent Slack org schedule notification", {
    runId,
    status,
    agentName: composeName,
  });

  return NextResponse.json({ success: true });
}
