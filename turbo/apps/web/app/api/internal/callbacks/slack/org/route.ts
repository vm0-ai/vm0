import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../../src/lib/callback";
import { decryptSecretValue } from "../../../../../../src/lib/crypto/secrets-encryption";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import { slackOrgPendingQuestions } from "../../../../../../src/db/schema/slack-org-pending-question";
import { agentSessions } from "../../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import {
  createSlackClient,
  postMessage,
  setThreadStatus,
} from "../../../../../../src/lib/slack/client";
import {
  buildAgentResponseMessage,
  buildAskUserQuestionBlocks,
} from "../../../../../../src/lib/slack/blocks";
import type { AskUserQuestion } from "../../../../../../src/lib/slack/blocks";
import {
  extractAllRunOutputs,
  formatAskUserDenials,
  buildDeepLinksFromFlags,
} from "../../../../../../src/lib/run/extract-run-output";
import {
  saveThreadSession,
  buildLogsUrl,
} from "../../../../../../src/lib/slack-org/handlers/shared";
import { getAppUrl } from "../../../../../../src/lib/url";
import { env } from "../../../../../../src/env";
import { logger } from "../../../../../../src/lib/logger";
import type { WebClient } from "@slack/web-api";
import type {
  PermissionDenial,
  RunOutput,
} from "../../../../../../src/lib/run/extract-run-output";

const log = logger("callback:slack-org");

interface CallbackPayload {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  connectionId: string;
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
    typeof p.connectionId !== "string" ||
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
    .insert(slackOrgPendingQuestions)
    .values({
      runId,
      slackWorkspaceId: payload.workspaceId,
      slackChannelId: payload.channelId,
      slackThreadTs: payload.threadTs,
      connectionId: payload.connectionId,
      composeId: payload.composeId,
      agentName: payload.agentName,
      sessionId: resolvedSessionId,
      questions: allQuestions,
      expiresAt,
    })
    .returning({ id: slackOrgPendingQuestions.id });

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
      .update(slackOrgPendingQuestions)
      .set({ slackMessageTs: cardResult.ts })
      .where(eq(slackOrgPendingQuestions.id, pending.id));
  }
}

function buildResponseText(
  status: string,
  error: string | undefined,
  resultData: RunOutput,
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
 * Save or update the org-aware thread session mapping.
 * Returns the resolved session ID.
 */
async function saveOrgThreadSession(
  payload: CallbackPayload,
  runId: string,
  status: string,
): Promise<string | undefined> {
  const {
    connectionId,
    channelId,
    threadTs,
    messageTs,
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

  const newSessionId = !existingSessionId
    ? await findNewSessionId(run.userId, composeId, run.createdAt)
    : undefined;

  await saveThreadSession({
    connectionId,
    channelId,
    threadTs,
    existingSessionId,
    newSessionId,
    messageTs,
    runStatus: status,
  });

  return newSessionId ?? existingSessionId;
}

/**
 * POST /api/internal/callbacks/slack/org
 *
 * Org-aware Slack callback handler for agent run completion.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<CallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  log.debug("Processing org Slack callback", {
    runId,
    status,
    channelId: payload.channelId,
  });

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Handle progress notifications
  if (status === "progress") {
    const [inst] = await globalThis.services.db
      .select()
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, payload.workspaceId))
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

  // Get installation for bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, payload.workspaceId))
    .limit(1);

  if (!installation) {
    log.error("Slack org installation not found", {
      workspaceId: payload.workspaceId,
    });
    return errorResponse("Slack installation not found", 404);
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const allOutputs = await extractAllRunOutputs(runId, error);
  const lastOutput = allOutputs[allOutputs.length - 1]!;
  const hasAskUserDenials = lastOutput.askUserDenials.length > 0;

  // Resolve session before posting interactive card
  const resolvedSessionId = await saveOrgThreadSession(payload, runId, status);

  // Post each result as a separate Slack reply (in order)
  for (let i = 0; i < allOutputs.length; i++) {
    const output = allOutputs[i]!;
    const responseText = buildResponseText(status, error, output);
    if (!responseText) continue;

    const isLast = i === allOutputs.length - 1;
    const logsUrl = isLast ? buildLogsUrl(runId) : undefined;
    const deepLinks = isLast
      ? buildDeepLinksFromFlags(output, getAppUrl(), payload.agentName)
      : [];

    await postMessage(client, payload.channelId, responseText, {
      threadTs: payload.threadTs,
      blocks: buildAgentResponseMessage(responseText, logsUrl, deepLinks),
    });
  }

  // Post interactive card for askUserQuestion denials
  if (hasAskUserDenials) {
    await postAskUserInteractiveCard(
      client,
      lastOutput,
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

  log.debug("Slack org callback processed successfully", { runId });
  return NextResponse.json({ success: true });
}
