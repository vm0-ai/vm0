import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  createTelegramClient,
  sendMessage,
  sendChatAction,
  deleteMessage,
} from "../../../../../src/lib/telegram/client";
import {
  splitMessage,
  buildTelegramResponse,
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

  const result = await verifyCallback<CallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;

  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return errorResponse("Invalid or missing payload", 400);
  }

  const {
    installationId,
    chatId,
    messageId,
    userLinkId,
    agentName,
    composeId,
    existingSessionId,
    isDM,
    thinkingMessageId,
  } = payload;

  log.debug("Processing Telegram callback", { runId, status, chatId });

  const { SECRETS_ENCRYPTION_KEY } = env();

  // Get Telegram installation for bot token
  const [installation] = await globalThis.services.db
    .select({
      id: telegramInstallations.id,
      encryptedBotToken: telegramInstallations.encryptedBotToken,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.id, installationId))
    .limit(1);

  if (!installation) {
    log.warn("Telegram installation not found", { installationId });
    return NextResponse.json({ success: true });
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

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
  const output = status === "completed" ? await getRunOutput(runId) : undefined;

  // Build response text
  const logsUrl = buildLogsUrl(runId, agentName);
  const responseText =
    status === "completed"
      ? (output ?? "Task completed successfully.")
      : `Error: ${error ?? "Agent execution failed."}`;

  // Detect deep links for configuration hints
  const deepLinks = detectDeepLinks(responseText, getPlatformUrl(), agentName);

  // Build structured response with bot header and footer
  const htmlOutput = buildTelegramResponse(
    responseText,
    agentName,
    logsUrl,
    deepLinks,
  );
  const chunks = splitMessage(htmlOutput);

  // In DMs, don't reply-to (no quote noise); in groups, reply for threading
  const replyOptions = isDM
    ? undefined
    : { replyToMessageId: Number(messageId) };

  // Send response message(s)
  let botReplyMessageId: number | undefined;
  for (const chunk of chunks) {
    const sent = await sendMessage(client, chatId, chunk, replyOptions);
    // Capture first reply message_id as thread anchor
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

    // For DMs, always use "dm" sentinel; for groups, use message-based anchors
    const rootMessageId = isDM
      ? "dm"
      : existingSessionId
        ? messageId // Existing thread — use original anchor
        : String(botReplyMessageId); // New thread — bot's reply is the anchor

    await saveTelegramThreadSession({
      userLinkId,
      chatId,
      rootMessageId,
      existingSessionId: existingSessionId ?? undefined,
      newSessionId,
      messageId,
      runStatus: status,
    });
  }

  log.debug("Telegram callback processed successfully", { runId });

  return NextResponse.json({ success: true });
}
