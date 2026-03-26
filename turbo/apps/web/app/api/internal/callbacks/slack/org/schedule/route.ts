import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
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
  type RunOutput,
} from "../../../../../../../src/lib/run/extract-run-output";
import {
  saveThreadSession,
  buildLogsUrl,
} from "../../../../../../../src/lib/slack-org/handlers/shared";
import { buildAgentResponseMessage } from "../../../../../../../src/lib/slack/blocks";
import { zeroAgents } from "../../../../../../../src/db/schema/zero-agent";
import { zeroAgentSchedules } from "../../../../../../../src/db/schema/zero-agent-schedule";
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
 * The first message is sent to the channel; subsequent results are threaded replies.
 * Only the last message includes the audit link and optional attribution footer.
 */
async function postScheduleResults(
  client: ReturnType<typeof createSlackClient>,
  channel: string,
  outputs: RunOutput[],
  logsUrl: string,
  scheduleDescription?: string,
): Promise<{ messageTs: string | undefined; dmChannelId: string | undefined }> {
  let messageTs: string | undefined;
  let dmChannelId: string | undefined;

  for (let i = 0; i < outputs.length; i++) {
    const output = outputs[i]!;
    const rawOutput = output.result ?? "Task completed successfully.";
    const isFirst = i === 0;
    const isLast = i === outputs.length - 1;

    const triggeredBy =
      isLast && scheduleDescription
        ? `Triggered by schedule "${scheduleDescription}"`
        : undefined;
    const blocks = buildAgentResponseMessage(
      rawOutput,
      isLast ? logsUrl : undefined,
      triggeredBy,
    );

    const threadTs = messageTs;
    const result = await postMessage(
      client,
      dmChannelId ?? channel,
      rawOutput.slice(0, 2000),
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

/** Handle a completed schedule run: post results and save thread session. */
async function handleScheduleCompleted(opts: {
  runId: string;
  client: ReturnType<typeof createSlackClient>;
  notifyChannel: string;
  logsUrl: string;
  scheduleDescription?: string;
  connectionId: string;
  isDm: boolean;
}): Promise<void> {
  const allOutputs = await extractAllRunOutputs(opts.runId);

  const { messageTs, dmChannelId } = await postScheduleResults(
    opts.client,
    opts.notifyChannel,
    allOutputs,
    opts.logsUrl,
    opts.scheduleDescription,
  );

  // Create thread session so user can reply to continue (only for DM)
  if (opts.isDm) {
    const [run] = await globalThis.services.db
      .select({ result: agentRuns.result })
      .from(agentRuns)
      .where(eq(agentRuns.id, opts.runId))
      .limit(1);

    const agentSessionId = extractAgentSessionId(run?.result);

    if (messageTs && dmChannelId && agentSessionId) {
      await saveThreadSession({
        connectionId: opts.connectionId,
        channelId: dmChannelId,
        threadTs: messageTs,
        existingSessionId: undefined,
        newSessionId: agentSessionId,
        messageTs,
        runStatus: "completed",
      });
    }
  }
}

/** Post a failure notification for a scheduled run. */
async function postScheduleFailure(
  client: ReturnType<typeof createSlackClient>,
  channel: string,
  displayName: string,
  errMsg: string,
  logsUrl: string,
  scheduleDescription?: string,
): Promise<void> {
  const failureContent = `:x: **Failed**\n\n${errMsg}`;
  await postMessage(
    client,
    channel,
    `Scheduled run for "${displayName}" failed`,
    {
      blocks: buildAgentResponseMessage(
        failureContent,
        logsUrl,
        scheduleDescription
          ? `Triggered by schedule "${scheduleDescription}"`
          : undefined,
      ),
    },
  );
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

  const { userId, orgId } = payload;
  const targetChannelId = payload.slackChannelId;

  log.debug("Processing Slack org schedule callback", {
    runId,
    status,
    targetChannelId,
  });

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Find connection for this VM0 user scoped to the schedule's org.
  // JOIN installations to filter by orgId — prevents cross-org notifications
  // when a user has Slack connections in multiple orgs.
  const [row] = await globalThis.services.db
    .select({
      connectionId: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
      encryptedBotToken: slackOrgInstallations.encryptedBotToken,
    })
    .from(slackOrgConnections)
    .innerJoin(
      slackOrgInstallations,
      eq(
        slackOrgConnections.slackWorkspaceId,
        slackOrgInstallations.slackWorkspaceId,
      ),
    )
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, userId),
        eq(slackOrgInstallations.orgId, orgId),
      ),
    )
    .limit(1);

  if (!row) {
    log.debug("No Slack org connection found for org, skipping notification", {
      userId,
      orgId,
    });
    return NextResponse.json({ success: true, skipped: true });
  }

  const connection = {
    id: row.connectionId,
    slackUserId: row.slackUserId,
  };

  const botToken = decryptSecretValue(
    row.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const logsUrl = buildLogsUrl(runId);

  // Resolve display name from zeroAgents
  const [agentInfo] = await globalThis.services.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, payload.agentId))
    .limit(1);
  const displayName = agentInfo?.displayName ?? agentInfo?.name ?? "your agent";

  // Resolve schedule description for attribution footer
  const [scheduleRow] = await globalThis.services.db
    .select({ description: zeroAgentSchedules.description })
    .from(zeroAgentSchedules)
    .where(eq(zeroAgentSchedules.id, payload.scheduleId))
    .limit(1);
  const scheduleDescription = scheduleRow?.description ?? undefined;

  // Use configured channel if set, otherwise fall back to user DM
  const notifyChannel = targetChannelId ?? connection.slackUserId;

  if (status === "progress") {
    // Progress heartbeat — no notification needed
    return NextResponse.json({ success: true, skipped: true });
  }

  if (status === "completed") {
    await handleScheduleCompleted({
      runId,
      client,
      notifyChannel,
      logsUrl,
      scheduleDescription,
      connectionId: connection.id,
      isDm: !targetChannelId,
    });
  } else {
    await postScheduleFailure(
      client,
      notifyChannel,
      displayName,
      error ?? "Unknown error",
      logsUrl,
      scheduleDescription,
    );
  }

  log.info("Sent Slack org schedule notification", {
    runId,
    status,
    agentId: payload.agentId,
  });

  return NextResponse.json({ success: true });
}
