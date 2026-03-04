import { NextRequest, NextResponse } from "next/server";
import { eq, and, gte, desc } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallbackRequest } from "../../../../../src/lib/callback";
import { decryptCredentialValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { telegramInstallations } from "../../../../../src/db/schema/telegram-installation";
import { agentSessions } from "../../../../../src/db/schema/agent-session";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentRunCallbacks } from "../../../../../src/db/schema/agent-run-callback";
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
    typeof p.installationId !== "string" ||
    typeof p.chatId !== "string" ||
    typeof p.messageId !== "string" ||
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = env();

  // Read raw body for signature verification
  const rawBody = await request.text();

  // Parse body first to get runId for callback lookup
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

  // Decrypt the per-callback secret
  const callbackSecret = decryptCredentialValue(
    callback.encryptedSecret,
    SECRETS_ENCRYPTION_KEY,
  );

  // Verify signature using the per-callback secret
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
