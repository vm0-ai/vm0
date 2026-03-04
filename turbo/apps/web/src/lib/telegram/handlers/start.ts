import { eq } from "drizzle-orm";
import { telegramInstallations } from "../../../db/schema/telegram-installation";
import { telegramUserLinks } from "../../../db/schema/telegram-user-link";
import { decryptCredentialValue } from "../../crypto/secrets-encryption";
import { env } from "../../../env";
import { createTelegramClient, sendMessage } from "../client";
import { ensureScopeAndArtifact } from "./shared";
import { logger } from "../../logger";
import crypto from "crypto";

const log = logger("telegram:start");

/** Token expiry in seconds (10 minutes) */
const TOKEN_EXPIRY_SECONDS = 600;

interface TelegramUpdate {
  message: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; is_bot?: boolean };
    text?: string;
  };
}

interface LinkTokenPayload {
  vm0UserId: string;
  installationId: string;
  exp: number;
}

/**
 * Handle /start command
 *
 * Flow:
 * 1. Parse deep link payload from /start {token}
 * 2. No token → send generic welcome
 * 3. Token present → validate, create user link, send confirmation
 */
export async function handleStartCommand(
  update: TelegramUpdate,
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
    .where(eq(telegramInstallations.id, installationId))
    .limit(1);

  if (!installation) {
    log.error("Installation not found", { installationId });
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createTelegramClient(botToken);

  // Parse /start payload
  const text = message.text ?? "";
  const parts = text.split(" ");
  const token = parts.length > 1 ? parts[1] : undefined;

  if (!token) {
    // No token — generic welcome
    await sendMessage(
      client,
      chatId,
      "Welcome! Visit the platform to connect your account and start chatting with the agent.",
    );
    return;
  }

  // Validate token
  const payload = verifyLinkToken(token, SECRETS_ENCRYPTION_KEY);
  if (!payload) {
    await sendMessage(
      client,
      chatId,
      "This link has expired. Please generate a new one from the platform.",
    );
    return;
  }

  if (payload.installationId !== installationId) {
    await sendMessage(
      client,
      chatId,
      "This link is for a different bot. Please use the correct link.",
    );
    return;
  }

  // Create user link (upsert)
  await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: fromUserId,
      installationId,
      vm0UserId: payload.vm0UserId,
    })
    .onConflictDoNothing();

  // Auto-grant permission
  await ensureScopeAndArtifact(payload.vm0UserId);

  await sendMessage(
    client,
    chatId,
    "Account linked! You can now chat with the agent.",
  );

  log.info("Telegram user linked", {
    telegramUserId: fromUserId,
    vm0UserId: payload.vm0UserId,
    installationId,
  });
}

/**
 * Create a signed link token for account linking.
 * Uses HMAC-SHA256 with a simple JSON payload + expiry.
 */
export function createLinkToken(
  vm0UserId: string,
  installationId: string,
  secretKey: string,
): string {
  const payload: LinkTokenPayload = {
    vm0UserId,
    installationId,
    exp: Math.floor(Date.now() / 1000) + TOKEN_EXPIRY_SECONDS,
  };

  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", secretKey)
    .update(data)
    .digest("base64url");

  return `${data}.${signature}`;
}

/**
 * Verify and decode a link token.
 * Returns null if invalid or expired.
 */
export function verifyLinkToken(
  token: string,
  secretKey: string,
): LinkTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [data, signature] = parts as [string, string];

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
