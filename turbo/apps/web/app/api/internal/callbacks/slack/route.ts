import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/callback";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { slackInstallations } from "../../../../../src/db/schema/slack-installation";
import { slackThreadSessions } from "../../../../../src/db/schema/slack-thread-session";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
  buildAgentResponseMessage,
  buildAskUserQuestionBlocks,
  detectDeepLinks,
} from "../../../../../src/lib/slack";
import {
  getRunResultData,
  formatAskUserDenials,
} from "../../../../../src/lib/slack/handlers/run-agent";
import { buildLogsUrl } from "../../../../../src/lib/slack/handlers/shared";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { slackPendingQuestions } from "../../../../../src/db/schema/slack-pending-question";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/logger";
import type { AskUserQuestion } from "../../../../../src/lib/slack";
import type { WebClient } from "@slack/web-api";
import type { PermissionDenial } from "../../../../../src/lib/slack/handlers/run-agent";

const log = logger("callback:slack");

interface CallbackPayload {
  // Slack-specific context
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId?: string;
}

function parsePayload(payload: unknown): CallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.workspaceId !== "string" ||
    typeof p.channelId !== "string" ||
    typeof p.threadTs !== "string" ||
    typeof p.messageTs !== "string" ||
    typeof p.userLinkId !== "string" ||
    typeof p.agentName !== "string" ||
    typeof p.composeId !== "string"
  ) {
    return null;
  }
  return p as unknown as CallbackPayload;
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function findNewSessionId(
  userId: string,
  composeId: string,
  runCreatedAt: Date,
): Promise<string | undefined> {
  const [newSession] = await globalThis.services.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, composeId),
        gte(agentSessions.updatedAt, runCreatedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return newSession?.id;
}

/**
 * Post an interactive Block Kit card for askUserQuestion denials.
 * Creates a pending question record and sends the card to Slack.
 */
async function postAskUserInteractiveCard(
  client: WebClient,
  resultData: { askUserDenials: PermissionDenial[] },
  payload: CallbackPayload,
  runId: string,
  resolvedSessionId: string | undefined,
): Promise<void> {
  const allQuestions: AskUserQuestion[] = [];
  for (const denial of resultData.askUserDenials) {
    const questions = denial.tool_input?.questions;
    if (questions) {
      allQuestions.push(...questions);
    }
  }

  if (allQuestions.length === 0) {
    return;
  }

  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const [pending] = await globalThis.services.db
    .insert(slackPendingQuestions)
    .values({
      runId,
      slackWorkspaceId: payload.workspaceId,
      slackChannelId: payload.channelId,
      slackThreadTs: payload.threadTs,
      userLinkId: payload.userLinkId,
      composeId: payload.composeId,
      agentName: payload.agentName,
      sessionId: resolvedSessionId,
      questions: allQuestions,
      expiresAt,
    })
    .returning({ id: slackPendingQuestions.id });

  if (!pending) {
    return;
  }

  const fallbackText = formatAskUserDenials(resultData.askUserDenials);
  const cardBlocks = buildAskUserQuestionBlocks(allQuestions, pending.id);

  const cardResult = await postMessage(
    client,
    payload.channelId,
    fallbackText ?? "The agent needs your input.",
    { threadTs: payload.threadTs, blocks: cardBlocks },
  );

  if (cardResult.ts) {
    await globalThis.services.db
      .update(slackPendingQuestions)
      .set({ slackMessageTs: cardResult.ts })
      .where(eq(slackPendingQuestions.id, pending.id));
  }
}

/**
 * Build the text response based on run status and result data.
 */
function buildResponseText(
  status: string,
  error: string | undefined,
  resultData: Awaited<ReturnType<typeof getRunResultData>>,
): string {
  if (status !== "completed") {
    return `Error: ${error ?? "Agent execution failed."}`;
  }
  if (resultData && resultData.askUserDenials.length > 0) {
    return resultData.result ?? "";
  }
  return resultData?.result ?? "Task completed successfully.";
}

/**
 * Save or update the Slack thread → agent session mapping.
 * Returns the resolved session ID (existing or newly discovered).
 */
async function saveThreadSession(
  payload: CallbackPayload,
  runId: string,
  status: string,
): Promise<string | undefined> {
  const {
    channelId,
    threadTs,
    messageTs,
    userLinkId,
    composeId,
    existingSessionId,
  } = payload;

  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return existingSessionId;
  }

  if (!existingSessionId) {
    const newSessionId = await findNewSessionId(
      run.userId,
      composeId,
      run.createdAt,
    );
    if (newSessionId) {
      await globalThis.services.db
        .insert(slackThreadSessions)
        .values({
          slackUserLinkId: userLinkId,
          slackChannelId: channelId,
          slackThreadTs: threadTs,
          agentSessionId: newSessionId,
          lastProcessedMessageTs: messageTs,
        })
        .onConflictDoNothing();
    }
    return newSessionId;
  }

  if (status === "completed") {
    await globalThis.services.db
      .update(slackThreadSessions)
      .set({
        lastProcessedMessageTs: messageTs,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(slackThreadSessions.slackUserLinkId, userLinkId),
          eq(slackThreadSessions.slackChannelId, channelId),
          eq(slackThreadSessions.slackThreadTs, threadTs),
        ),
      );
  }
  return existingSessionId;
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

  log.debug("Processing Slack callback", {
    runId,
    status,
    channelId: payload.channelId,
  });

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Handle progress notifications: refresh the Slack typing indicator
  // to prevent the 2-minute auto-expiry on assistant.threads.setStatus.
  if (status === "progress") {
    const [inst] = await globalThis.services.db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.slackWorkspaceId, payload.workspaceId))
      .limit(1);

    if (inst) {
      const token = decryptSecretValue(
        inst.encryptedBotToken,
        SECRETS_ENCRYPTION_KEY,
      );
      const slackClient = createSlackClient(token);
      try {
        await setThreadStatus(
          slackClient,
          payload.channelId,
          payload.threadTs,
          "is thinking...",
        );
      } catch (err) {
        log.debug("Failed to refresh thread status", { runId, error: err });
      }
    }

    return NextResponse.json({ success: true });
  }

  // Get Slack installation for bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, payload.workspaceId))
    .limit(1);

  if (!installation) {
    log.error("Slack installation not found", {
      workspaceId: payload.workspaceId,
    });
    return errorResponse("Slack installation not found", 404);
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const resultData =
    status === "completed" ? await getRunResultData(runId) : undefined;
  const hasAskUserDenials = resultData && resultData.askUserDenials.length > 0;
  const responseText = buildResponseText(status, error, resultData);

  // Resolve session before posting interactive card so the pending question
  // gets the correct sessionId (on first run, the session doesn't exist yet
  // when the callback payload was constructed).
  const resolvedSessionId = await saveThreadSession(payload, runId, status);

  // Post text response (if any content)
  if (responseText) {
    const logsUrl = buildLogsUrl(runId, payload.agentName);
    const deepLinks = detectDeepLinks(responseText, getPlatformUrl());
    await postMessage(client, payload.channelId, responseText, {
      threadTs: payload.threadTs,
      blocks: buildAgentResponseMessage(responseText, logsUrl, deepLinks),
    });
  }

  // Post interactive card for askUserQuestion denials
  if (hasAskUserDenials) {
    await postAskUserInteractiveCard(
      client,
      resultData,
      payload,
      runId,
      resolvedSessionId,
    );
  }

  // Clear assistant thinking status
  try {
    await setThreadStatus(client, payload.channelId, payload.threadTs, "");
  } catch (err) {
    log.debug("Failed to clear thread status", { runId, error: err });
  }

  log.debug("Slack callback processed successfully", { runId });
  return NextResponse.json({ success: true });
}
