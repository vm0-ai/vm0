import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/callback";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  createTelegramClient,
  sendMessage,
  sendChatAction,
  editMessageText,
  deleteMessage,
} from "../../../../../src/lib/telegram/client";
import {
  escapeHtml,
  splitMessage,
  buildTelegramResponse,
  buildTelegramErrorResponse,
} from "../../../../../src/lib/telegram/format";
import { detectDeepLinks } from "../../../../../src/lib/deep-links";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { getRunOutput } from "../../../../../src/lib/slack/handlers/run-agent";
import {
  saveTelegramThreadSession,
  storeTelegramMessage,
  buildLogsUrl,
} from "../../../../../src/lib/telegram/handlers/shared";
import { env } from "../../../../../src/env";
import { logger } from "../../../../../src/lib/logger";

const log = logger("callback:telegram");

interface CallbackPayload {
  installationId: string;
  chatId: string;
  messageId: string;
  rootMessageId: string | null;
  userLinkId: string;
  agentName: string;
  composeId: string;
  existingSessionId: string | null;
  isDM: boolean;
  thinkingMessageId: string | null;
}

function parsePayload(payload: unknown): CallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.installationId !== "string" ||
    typeof p.chatId !== "string" ||
    typeof p.messageId !== "string" ||
    typeof p.userLinkId !== "string" ||
    typeof p.agentName !== "string" ||
    typeof p.composeId !== "string"
  ) {
    return null;
  }
  return {
    installationId: p.installationId,
    chatId: p.chatId,
    messageId: p.messageId,
    rootMessageId: typeof p.rootMessageId === "string" ? p.rootMessageId : null,
    userLinkId: p.userLinkId,
    agentName: p.agentName,
    composeId: p.composeId,
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

interface CompletionContext {
  client: ReturnType<typeof createTelegramClient>;
  runId: string;
  status: "completed" | "failed";
  error: string | undefined;
  payload: CallbackPayload;
}

async function handleCompletion(ctx: CompletionContext): Promise<void> {
  const { client, runId, status, error, payload } = ctx;
  const {
    installationId,
    chatId,
    messageId,
    rootMessageId: payloadRootMessageId,
    userLinkId,
    agentName,
    composeId,
    existingSessionId,
    isDM,
    thinkingMessageId,
  } = payload;

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
      agentName,
      chatId,
      error,
    });
  }
  const output = status === "completed" ? await getRunOutput(runId) : undefined;

  // Build response text
  const logsUrl = buildLogsUrl(runId, agentName);
  let htmlOutput: string;
  let responseText: string | undefined;
  if (status === "completed") {
    responseText = output ?? "Task completed successfully.";
    const deepLinks = detectDeepLinks(responseText, getPlatformUrl());
    htmlOutput = buildTelegramResponse(
      responseText,
      agentName,
      logsUrl,
      deepLinks,
    );
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
      ? await findNewSessionId(run.userId, composeId, run.createdAt)
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

  const result = await verifyCallback<CallbackPayload>(request, log);
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
      id: telegramInstallations.id,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.id, payload.installationId))
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
        const thinkingText = `<i>🤖 ${escapeHtml(payload.agentName)} is thinking...</i>`;
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
