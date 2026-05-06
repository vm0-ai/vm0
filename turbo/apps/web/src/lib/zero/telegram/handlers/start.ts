import { eq } from "drizzle-orm";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { decryptSecretValue } from "../../../shared/crypto/secrets-encryption";
import { env } from "../../../../env";
import { createTelegramClient, sendMessage } from "../client";
import {
  ensureOrgAndArtifact,
  linkTelegramUserToVm0User,
  resolveUserLink,
  buildConnectUrl,
  buildTelegramConnectReplyMarkup,
  formatTelegramAlreadyConnectedMessage,
  formatTelegramCommandError,
  formatTelegramCommandSuccess,
  formatTelegramConnectPrompt,
  formatTelegramUserDisplayName,
  getWorkspaceAgentDisplayLabel,
} from "./shared";
import { logger } from "../../../shared/logger";
import type { TelegramHandlerUpdate } from "./types";
import crypto from "crypto";

const log = logger("telegram:start");

interface LinkTokenPayload {
  vm0UserId: string;
  installationId: string;
  exp: number;
}

function telegramLinkConflictMessage(
  reason: "telegram-user-linked" | "vm0-user-linked" | "conflict",
): string {
  if (reason === "telegram-user-linked") {
    return "This Telegram account is already connected to another VM0 account for this bot. Disconnect it before connecting a different account.";
  }

  if (reason === "vm0-user-linked") {
    return "This VM0 account is already connected to another Telegram account for this bot. Disconnect it before connecting a different Telegram account.";
  }

  return "This Telegram account link already exists. Disconnect it first and try again.";
}

/**
 * Handle /start command
 *
 * Flow:
 * 1. Parse deep link payload from /start {token}
 * 2. No token or "connect" → check link status and prompt login
 * 3. Token present → validate, create user link, send confirmation
 */
export async function handleStartCommand(
  update: TelegramHandlerUpdate,
  installationId: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const message = update.message;
  const chatId = String(message.chat.id);
  const fromUserId = String(message.from?.id ?? 0);

  // Get installation for bot token
  const [installation] = await globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, installationId))
    .limit(1);

  if (!installation) {
    log.error("Installation not found", { installationId });
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);
  const telegramDisplayName = formatTelegramUserDisplayName(message.from);

  // Parse /start payload
  const text = message.text ?? "";
  const parts = text.split(" ");
  const token = parts.length > 1 ? parts[1] : undefined;

  if (!token || token === "connect") {
    // No token or deep link from group chat (/start connect) → prompt login
    const userLink = await resolveUserLink(
      installationId,
      fromUserId,
      message.from?.username ?? null,
      telegramDisplayName,
    );
    if (userLink) {
      const agentName = await getWorkspaceAgentDisplayLabel(
        installation.defaultComposeId,
      );
      await sendMessage(
        client,
        chatId,
        formatTelegramCommandSuccess(
          formatTelegramAlreadyConnectedMessage(
            installation.botUsername,
            agentName,
          ),
        ),
      );
      return;
    }
    const connectUrl = buildConnectUrl(
      installation.telegramBotId,
      fromUserId,
      botToken,
      message.from?.username ?? null,
      telegramDisplayName,
    );
    const agentName = await getWorkspaceAgentDisplayLabel(
      installation.defaultComposeId,
    );
    await sendMessage(client, chatId, formatTelegramConnectPrompt(agentName), {
      replyMarkup: buildTelegramConnectReplyMarkup(connectUrl),
    });
    return;
  }

  // Validate token
  const payload = verifyLinkToken(token, SECRETS_ENCRYPTION_KEY);
  if (!payload) {
    await sendMessage(
      client,
      chatId,
      formatTelegramCommandError(
        "This link has expired. Please generate a new one from the platform.",
      ),
    );
    return;
  }

  if (payload.installationId !== installationId) {
    await sendMessage(
      client,
      chatId,
      formatTelegramCommandError(
        "This link is for a different bot. Please use the correct link.",
      ),
    );
    return;
  }

  const linkResult = await linkTelegramUserToVm0User({
    telegramUserId: fromUserId,
    telegramUsername: message.from?.username ?? null,
    telegramDisplayName,
    installationId,
    vm0UserId: payload.vm0UserId,
  });

  if (!linkResult.ok) {
    await sendMessage(
      client,
      chatId,
      formatTelegramCommandError(
        telegramLinkConflictMessage(linkResult.reason),
      ),
    );
    return;
  }

  // Auto-grant permission. The installation's orgId was snapshot at
  // registration and is the authoritative org for this bot.
  await ensureOrgAndArtifact(payload.vm0UserId, installation.orgId);
  const agentName = await getWorkspaceAgentDisplayLabel(
    installation.defaultComposeId,
  );

  await sendMessage(
    client,
    chatId,
    formatTelegramCommandSuccess(
      `Account linked.\nSend me a message to start chatting with ${agentName}.`,
    ),
  );

  log.info("Telegram user linked", {
    telegramUserId: fromUserId,
    vm0UserId: payload.vm0UserId,
    installationId,
  });
}

/** HMAC-SHA256 produces 32 bytes = 43 base64url characters (no padding) */
const SIGNATURE_LENGTH = 43;

/**
 * Verify and decode a link token.
 * Returns null if invalid or expired.
 */
function verifyLinkToken(
  token: string,
  secretKey: string,
): LinkTokenPayload | null {
  if (token.length <= SIGNATURE_LENGTH) return null;

  const data = token.slice(0, -SIGNATURE_LENGTH);
  const signature = token.slice(-SIGNATURE_LENGTH);

  const expectedSignature = crypto
    .createHmac("sha256", secretKey)
    .update(data)
    .digest("base64url");

  // Timing-safe comparison
  try {
    if (
      !crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature),
      )
    ) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(data, "base64url").toString(),
    ) as LinkTokenPayload;

    // Check expiry
    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
