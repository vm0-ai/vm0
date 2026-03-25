import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
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
import {
  extractAllRunOutputs,
  buildDeepLinksFromFlags,
  type RunOutput,
} from "../../../../../../../src/lib/run/extract-run-output";
import {
  saveThreadSession,
  buildLogsUrl,
} from "../../../../../../../src/lib/slack-org/handlers/shared";
import {
  buildAgentResponseMessage,
  detectDeepLinks,
} from "../../../../../../../src/lib/slack/blocks";
import { getAppUrl } from "../../../../../../../src/lib/url";
import { zeroAgents } from "../../../../../../../src/db/schema/zero-agent";
import { env } from "../../../../../../../src/env";
import type { SlackScheduleCallbackPayload } from "../../../../../../../src/lib/callback/callback-payloads";
import { logger } from "../../../../../../../src/lib/logger";

const log = logger("callback:slack-org:schedule");

function isSlackSchedulePayload(
  payload: unknown,
): payload is SlackScheduleCallbackPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.scheduleId === "string" &&
    typeof p.agentId === "string" &&
    typeof p.agentName === "string" &&
    typeof p.userId === "string" &&
    typeof p.orgId === "string"
  );
}

function parsePayload(payload: unknown): SlackScheduleCallbackPayload | null {
  return isSlackSchedulePayload(payload) ? payload : null;
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
 * Only the last message includes the audit link and deep links.
 */
async function postScheduleResults(
  client: ReturnType<typeof createSlackClient>,
  channel: string,
  displayName: string,
  outputs: RunOutput[],
  logsUrl: string,
  agentName: string,
): Promise<{ messageTs: string | undefined; dmChannelId: string | undefined }> {
  let messageTs: string | undefined;
  let dmChannelId: string | undefined;

  const header = `:white_check_mark: **Scheduled run for \`${displayName}\` completed**\n\n`;

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i]!;
    const rawOutput = output.result ?? "Task completed successfully.";
    const isFirst = i === 0;
    const isLast = i === outputs.length - 1;

    const content = isFirst ? header + rawOutput : rawOutput;
    const deepLinks = isLast
      ? buildDeepLinksFromFlags(output, getAppUrl(), agentName)
      : [];
    const blocks = buildAgentResponseMessage(
      content,
      isLast ? logsUrl : undefined,
      deepLinks,
    );

    const threadTs = messageTs;
    const result = await postMessage(
      client,
      dmChannelId ?? channel,
      isFirst
        ? `Scheduled run for "${displayName}" completed`
        : rawOutput.slice(0, 2000),
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

  const { agentName, userId } = payload;
  const targetChannelId = payload.slackChannelId;

  log.debug("Processing Slack org schedule callback", {
    runId,
    status,
    targetChannelId,
  });

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

  // Resolve display name from zeroAgents
  const [agentInfo] = await globalThis.services.db
    .select({ displayName: zeroAgents.displayName })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, payload.agentId))
    .limit(1);
  const displayName = agentInfo?.displayName ?? agentName;

  // Use configured channel if set, otherwise fall back to user DM
  const notifyChannel = targetChannelId ?? connection.slackUserId;

  if (status === "completed") {
    const allOutputs = await extractAllRunOutputs(runId);

    const { messageTs, dmChannelId } = await postScheduleResults(
      client,
      notifyChannel,
      displayName,
      allOutputs,
      logsUrl,
      agentName,
    );

    // Create thread session so user can reply to continue (only for DM)
    if (!targetChannelId) {
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
    }
  } else {
    // Failed run
    const errMsg = error ?? "Unknown error";
    const failureContent = `:x: **Scheduled run for \`${displayName}\` failed**\n\n${errMsg}`;
    const deepLinks = detectDeepLinks(errMsg, getAppUrl(), agentName);
    await postMessage(
      client,
      notifyChannel,
      `Scheduled run for "${displayName}" failed`,
      {
        blocks: buildAgentResponseMessage(failureContent, logsUrl, deepLinks),
      },
    );
  }

  log.info("Sent Slack org schedule notification", {
    runId,
    status,
    agentName,
  });

  return NextResponse.json({ success: true });
}
