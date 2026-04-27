import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  createTelegramClient,
  sendMessage,
  sendChatAction,
  editMessageText,
  deleteMessage,
} from "../../../../../src/lib/zero/telegram/client";
import {
  splitMessage,
  buildTelegramResponse,
  buildTelegramErrorResponse,
} from "../../../../../src/lib/zero/telegram/format";
import { extractRunOutput } from "../../../../../src/lib/infra/run/extract-run-output";
import {
  saveTelegramThreadSession,
  storeTelegramMessage,
  buildLogsUrl,
  getAgentDisplayLabel,
  formatTelegramThinkingMessage,
} from "../../../../../src/lib/zero/telegram/handlers/shared";
import { env } from "../../../../../src/env";
import type { TelegramCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:telegram");

function parsePayload(payload: unknown): TelegramCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.installationId !== "string" ||
    typeof p.chatId !== "string" ||
    typeof p.messageId !== "string" ||
    typeof p.userLinkId !== "string" ||
    typeof p.agentId !== "string"
  ) {
    return null;
  }
  return {
    installationId: p.installationId,
    chatId: p.chatId,
    messageId: p.messageId,
    rootMessageId: typeof p.rootMessageId === "string" ? p.rootMessageId : null,
    userLinkId: p.userLinkId,
    agentId: p.agentId,
    existingSessionId:
      typeof p.existingSessionId === "string" ? p.existingSessionId : null,
    isDM: p.isDM === true,
    thinkingMessageId:
      typeof p.thinkingMessageId === "string" ? p.thinkingMessageId : null,
  };
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

async function findNewSessionId(
  userId: string,
  agentId: string,
  runCreatedAt: Date,
): Promise<string | undefined> {
  const [newSession] = await globalThis.services.db
    .select({ id: agentSessions.id })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.userId, userId),
        eq(agentSessions.agentComposeId, agentId),
        gte(agentSessions.updatedAt, runCreatedAt),
      ),
    )
    .orderBy(desc(agentSessions.updatedAt))
    .limit(1);
  return newSession?.id;
}

/**
 * Build a plain-text output string from the already-fetched RunOutput,
 * avoiding a redundant Axiom query.
 */
function buildOutputText(output: {
  result: string | null;
}): string | undefined {
  return output.result ?? undefined;
}

interface CompletionContext {
  client: ReturnType<typeof createTelegramClient>;
  runId: string;
  status: "completed" | "failed";
  error: string | undefined;
  payload: TelegramCallbackPayload;
}

async function resolveAgentInfo(agentId: string) {
  const [agentRow] = await globalThis.services.db
    .select({ displayName: zeroAgents.displayName, name: zeroAgents.name })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  const label = agentRow ? getAgentDisplayLabel(agentRow) : "zero";
  return {
    label,
    name: agentRow?.name ?? label,
  };
}

async function handleCompletion(ctx: CompletionContext): Promise<void> {
  const { client, runId, status, error, payload } = ctx;
  const {
    installationId,
    chatId,
    messageId,
    rootMessageId: payloadRootMessageId,
    userLinkId,
    agentId,
    existingSessionId,
    isDM,
    thinkingMessageId,
  } = payload;

  const agent = await resolveAgentInfo(agentId);

  // Delete thinking placeholder message
  if (thinkingMessageId) {
    try {
      await deleteMessage(client, chatId, Number(thinkingMessageId));
    } catch (err) {
      log.debug("Failed to delete thinking message", {
        thinkingMessageId,
        error: err,
      });
    }
  }

  // Send typing indicator while building response
  await sendChatAction(client, chatId, "typing");

  // Query Axiom for the agent's output
  if (status === "failed") {
    log.error("Agent run failed", {
      runId,
      agentName: agent.name,
      chatId,
      error,
    });
  }
  const runOutput = await extractRunOutput(runId, error);

  // Build response text
  const logsUrl = buildLogsUrl(runId);
  let htmlOutput: string;
  let responseText: string | undefined;
  if (status === "completed") {
    responseText = buildOutputText(runOutput) ?? "Task completed successfully.";
    htmlOutput = buildTelegramResponse(responseText, logsUrl);
  } else {
    const errorDetail =
      error ?? "The agent encountered an error during execution.";
    htmlOutput = buildTelegramErrorResponse(errorDetail, logsUrl);
  }
  const chunks = splitMessage(htmlOutput);

  // In DMs, don't reply-to (no quote noise); in groups, reply for threading
  const replyOptions = isDM
    ? undefined
    : { replyToMessageId: Number(messageId) };

  // Send response message(s)
  let botReplyMessageId: number | undefined;
  for (const chunk of chunks) {
    const sent = await sendMessage(client, chatId, chunk, replyOptions);
    if (botReplyMessageId === undefined) {
      botReplyMessageId = sent.message_id;
    }
  }

  // Store bot's response in telegram_messages for context
  if (botReplyMessageId !== undefined) {
    await storeTelegramMessage(installationId, chatId, {
      message_id: botReplyMessageId,
      from: { id: 0, is_bot: true },
      text: responseText,
    });
  }

  // Get run to find userId for session lookup
  const [run] = await globalThis.services.db
    .select({ userId: agentRuns.userId, createdAt: agentRuns.createdAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  // Save thread session mapping
  if (run && botReplyMessageId !== undefined) {
    const newSessionId = !existingSessionId
      ? await findNewSessionId(run.userId, agentId, run.createdAt)
      : undefined;

    const newRootMessageId = isDM ? "dm" : String(botReplyMessageId);

    await saveTelegramThreadSession({
      userLinkId,
      chatId,
      rootMessageId: newRootMessageId,
      previousRootMessageId: payloadRootMessageId ?? undefined,
      existingSessionId: existingSessionId ?? undefined,
      newSessionId,
      messageId,
      runStatus: status,
    });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<TelegramCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  log.debug("Processing Telegram callback", {
    runId,
    status,
    chatId: payload.chatId,
  });

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Get Telegram installation for bot token
  const [installation] = await globalThis.services.db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, payload.installationId))
    .limit(1);

  if (!installation) {
    log.warn("Telegram installation not found", {
      installationId: payload.installationId,
    });
    return NextResponse.json({ success: true });
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

  // Handle progress notifications: refresh the typing indicator
  if (status === "progress") {
    try {
      await sendChatAction(client, payload.chatId, "typing");
      if (payload.thinkingMessageId) {
        const agent = await resolveAgentInfo(payload.agentId);
        const thinkingText = formatTelegramThinkingMessage(agent.label);
        await editMessageText(
          client,
          payload.chatId,
          Number(payload.thinkingMessageId),
          thinkingText,
        );
      }
    } catch (err) {
      log.debug("Failed to refresh typing indicator", { runId, error: err });
    }
    return NextResponse.json({ success: true });
  }

  await handleCompletion({ client, runId, status, error, payload });

  log.debug("Telegram callback processed successfully", { runId });
  return NextResponse.json({ success: true });
}
