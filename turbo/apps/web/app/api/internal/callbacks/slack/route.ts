import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { slackInstallations } from "../../../../../src/db/schema/slack-installation";
import { slackThreadSessions } from "../../../../../src/db/schema/slack-thread-session";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentRunCallbacks } from "../../../../../src/db/schema/agent-run-callback";
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
  formatAskUserQuestions,
} from "../../../../../src/lib/slack/handlers/run-agent";
import { buildLogsUrl } from "../../../../../src/lib/slack/handlers/shared";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { slackPendingQuestions } from "../../../../../src/db/schema/slack-pending-question";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/logger";
import type { AskUserQuestion } from "../../../../../src/lib/slack";
import type { WebClient } from "@slack/web-api";
import type { RunResultData } from "../../../../../src/lib/slack/handlers/run-agent";

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
  return p;
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
 * Post an interactive Block Kit card for ask-user questions.
 * Creates a pending question record and sends the card to Slack.
 */
async function postAskUserInteractiveCard(
  client: WebClient,
  questions: AskUserQuestion[],
  payload: CallbackPayload,
  runId: string,
): Promise<void> {
  if (questions.length === 0) {
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
      sessionId: payload.existingSessionId ?? undefined,
      questions,
      expiresAt,
    })
    .returning({ id: slackPendingQuestions.id });

  if (!pending) {
    return;
  }

  const fallbackText = formatAskUserQuestions(questions);
  const cardBlocks = buildAskUserQuestionBlocks(questions, pending.id);

  const cardResult = await postMessage(
    client,
    payload.channelId,
    fallbackText,
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
 * Uses cleanResult (with ask_user block stripped) when questions are present.
 */
function buildResponseText(
  status: string,
  error: string | undefined,
  resultData: RunResultData | undefined,
): string {
  if (status !== "completed") {
    return `Error: ${error ?? "Agent execution failed."}`;
  }
  if (resultData && resultData.askUserQuestions.length > 0) {
    return resultData.cleanResult ?? "";
  }
  return resultData?.cleanResult ?? "Task completed successfully.";
}

/**
 * Save or update the Slack thread → agent session mapping.
 */
async function saveThreadSession(
  payload: CallbackPayload,
  runId: string,
  status: string,
): Promise<void> {
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
    return;
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
  } else if (status === "completed") {
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
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = env();

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

  log.debug("Processing Slack callback", {
    runId,
    status,
    channelId: payload.channelId,
  });

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

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const resultData =
    status === "completed" ? await getRunResultData(runId) : undefined;
  const hasAskUserQuestions =
    resultData && resultData.askUserQuestions.length > 0;
  const responseText = buildResponseText(status, error, resultData);

  // Post text response (if any content)
  if (responseText) {
    const logsUrl = buildLogsUrl(runId);
    const deepLinks = detectDeepLinks(responseText, getPlatformUrl());
    await postMessage(client, payload.channelId, responseText, {
      threadTs: payload.threadTs,
      blocks: buildAgentResponseMessage(
        responseText,
        payload.agentName,
        logsUrl,
        deepLinks,
      ),
    });
  }

  // Post interactive card for ask-user questions
  if (hasAskUserQuestions) {
    await postAskUserInteractiveCard(
      client,
      resultData.askUserQuestions,
      payload,
      runId,
    );
  }

  await saveThreadSession(payload, runId, status);

  // Clear assistant thinking status
  try {
    await setThreadStatus(client, payload.channelId, payload.threadTs, "");
  } catch (err) {
    log.debug("Failed to clear thread status", { runId, error: err });
  }

  log.debug("Slack callback processed successfully", { runId });
  return NextResponse.json({ success: true });
}
