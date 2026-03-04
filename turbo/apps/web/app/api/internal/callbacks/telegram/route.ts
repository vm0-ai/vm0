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
} from "../../../../../src/lib/telegram/client";
import {
  markdownToTelegramHtml,
  splitMessage,
} from "../../../../../src/lib/telegram/format";
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

  // Send typing indicator before posting
  await sendChatAction(client, chatId, "typing");

  // Query Axiom for the agent's output
  const output = status === "completed" ? await getRunOutput(runId) : undefined;

  // Build response text
  const logsUrl = buildLogsUrl(runId);
  const responseText =
    status === "completed"
      ? (output ?? "Task completed successfully.")
      : `Error: ${error ?? "Agent execution failed."}`;

  const footer = `\n\n<a href="${logsUrl}">View logs</a> · ${agentName}`;

  // Convert markdown to Telegram HTML and split if needed
  const htmlOutput = markdownToTelegramHtml(responseText) + footer;
  const chunks = splitMessage(htmlOutput);

  // Send response message(s) as reply to user's original message
  let botReplyMessageId: number | undefined;
  for (const chunk of chunks) {
    const sent = await sendMessage(client, chatId, chunk, {
      replyToMessageId: Number(messageId),
    });
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

    // For new threads, use bot's reply as rootMessageId (thread anchor)
    const rootMessageId = existingSessionId
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
