import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { orgCache } from "@vm0/db/schema/org-cache";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { signConnectParams } from "../../lib/zero/telegram/connect-token";
import { PENDING_TELEGRAM_USER_ID } from "../../lib/zero/telegram/handlers/shared";
import { ensureOrgRow, uniqueId } from "../test-helpers";

/**
 * Create a Telegram installation with all required parent records.
 * Optionally auto-creates a user link for testing integration endpoints.
 * Returns the telegramBotId (primary key) for use as a foreign key.
 * @why-db-direct Creates full installation chain (org cache + compose + installation + optional user link); register API calls real Telegram API
 */
export async function createTestTelegramInstallation(options?: {
  ownerUserId?: string;
  vm0UserId?: string;
  telegramBotId?: string;
  orgId?: string;
}): Promise<string> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;

  const suffix = uniqueId("tg");
  const ownerUserId = options?.ownerUserId ?? uniqueId("test-owner");

  const orgSlug = uniqueId("org");
  const orgId = options?.orgId ?? uniqueId("org");

  // Pre-populate org cache for getOrgNameAndSlug()
  await globalThis.services.db
    .insert(orgCache)
    .values({
      orgId,
      slug: orgSlug,
      cachedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: { slug: orgSlug, cachedAt: new Date() },
    });

  // Ensure org row exists
  await ensureOrgRow(orgId);

  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: ownerUserId,
      orgId,
      name: uniqueId("compose"),
    })
    .returning();

  const telegramBotId = options?.telegramBotId ?? suffix;
  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId,
      botUsername: `bot_${telegramBotId}`,
      encryptedBotToken: encryptSecretValue(
        "test-bot-token",
        SECRETS_ENCRYPTION_KEY,
      ),
      webhookSecret: uniqueId("secret"),
      defaultComposeId: compose!.id,
      ownerUserId,
      orgId,
    })
    .returning();

  // Auto-create user link if vm0UserId is provided
  if (options?.vm0UserId) {
    await globalThis.services.db
      .insert(telegramUserLinks)
      .values({
        telegramUserId: suffix,
        installationId: installation!.telegramBotId,
        vm0UserId: options.vm0UserId,
      })
      .onConflictDoNothing();
  }

  return installation!.telegramBotId;
}

/**
 * Insert test telegram messages with a specific creation date.
 * Used by cleanup cron tests.
 * @why-db-direct Bulk inserts message records with specific timestamps for cleanup cron testing
 */
export async function insertTestTelegramMessages(
  installationId: string,
  count: number,
  createdAt: Date,
): Promise<void> {
  const values = Array.from({ length: count }, (_, i) => {
    return {
      installationId,
      chatId: "chat-1",
      messageId: `${createdAt.getTime()}-${i}`,
      fromUserId: "user-1",
      text: `message ${i}`,
      isBot: false,
      createdAt,
    };
  });

  await globalThis.services.db.insert(telegramMessages).values(values);
}

/**
 * Create a telegram installation for a specific compose with a known bot token.
 * Returns the telegramBotId.
 * @why-db-direct Creates installation for specific compose with known bot token; no API route for this
 */
export async function createTelegramInstallationForCompose(
  composeId: string,
  ownerUserId: string,
  botToken: string,
): Promise<string> {
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedBotToken = encryptSecretValue(botToken, encryptionKey);

  const [composeRow] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!composeRow) throw new Error("Compose not found");

  const rows = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: `bot-${randomUUID().slice(0, 8)}`,
      encryptedBotToken,
      webhookSecret: `secret-${randomUUID().slice(0, 8)}`,
      defaultComposeId: composeId,
      ownerUserId,
      orgId: composeRow.orgId,
    })
    .returning();

  if (!rows[0]) throw new Error("Failed to create telegram installation");
  return rows[0].telegramBotId;
}

/**
 * Insert a test Telegram installation for a compose.
 * @why-db-direct Lightweight installation insert for FK dependency setup; no test API exists
 */
export async function insertTestTelegramInstallation(params: {
  composeId: string;
  ownerUserId: string;
  botUsername?: string;
}): Promise<{ telegramBotId: string }> {
  const botId = `tg-bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const [composeRow] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, params.composeId))
    .limit(1);

  if (!composeRow) throw new Error("Compose not found");

  const [row] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      defaultComposeId: params.composeId,
      telegramBotId: botId,
      encryptedBotToken: `encrypted-test-token-${botId}`,
      webhookSecret: `webhook-secret-${botId}`,
      botUsername: params.botUsername ?? `test_bot_${Date.now()}`,
      ownerUserId: params.ownerUserId,
      orgId: composeRow.orgId,
    })
    .returning({ telegramBotId: telegramInstallations.telegramBotId });
  return row!;
}

/**
 * Insert a test Telegram user link.
 * @why-db-direct Creates user link record; no API route to create links directly
 */
export async function insertTestTelegramUserLink(params: {
  installationId: string;
  telegramUserId: string;
  vm0UserId: string;
}): Promise<{ id: string }> {
  const [row] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      installationId: params.installationId,
      telegramUserId: params.telegramUserId,
      vm0UserId: params.vm0UserId,
    })
    .returning({ id: telegramUserLinks.id });
  return row!;
}

/**
 * Create a telegram installation with all required foreign key dependencies.
 * Returns the telegramBotId for use in tests.
 * @why-db-direct Creates minimal installation with compose for telegram handler tests
 */
export async function createTelegramInstallation(): Promise<string> {
  initServices();

  const orgId = uniqueId("org");

  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: uniqueId("test-user"),
      orgId,
      name: uniqueId("test-compose"),
    })
    .returning();

  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: uniqueId("bot"),
      botUsername: "test_bot",
      encryptedBotToken: "encrypted-token",
      webhookSecret: "webhook-secret",
      defaultComposeId: compose!.id,
      ownerUserId: uniqueId("owner"),
      orgId,
    })
    .returning();

  return installation!.telegramBotId;
}

interface InsertMessageOptions {
  installationId: string;
  chatId: string;
  messageId: string;
  fromUserId: string;
  fromUsername?: string;
  text?: string;
  fileId?: string;
  isBot?: boolean;
  createdAt?: Date;
}

/**
 * Insert a telegram message into the database for testing.
 * @why-db-direct Inserts individual message record for context testing
 */
export async function insertTelegramMessage(
  options: InsertMessageOptions,
): Promise<void> {
  initServices();

  await globalThis.services.db.insert(telegramMessages).values({
    installationId: options.installationId,
    chatId: options.chatId,
    messageId: options.messageId,
    fromUserId: options.fromUserId,
    fromUsername: options.fromUsername ?? null,
    text: options.text ?? null,
    fileId: options.fileId ?? null,
    isBot: options.isBot ?? false,
    createdAt: options.createdAt ?? new Date(),
  });
}

interface PendingLinkInstallationResult {
  installationId: string;
  userLinkId: string;
  vm0UserId: string;
}

/**
 * Create a Telegram installation with a properly encrypted bot token
 * and a pending user link (telegramUserId='pending').
 * Use this for testing the auto-complete pending link flow.
 * @why-db-direct Creates installation with pending user link for auto-complete flow testing
 */
export async function createTelegramPendingLinkInstallation(
  composeId: string,
  vm0UserId: string,
  botToken: string,
): Promise<PendingLinkInstallationResult> {
  initServices();

  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const PTUID = PENDING_TELEGRAM_USER_ID;
  const encryptedBotToken = encryptSecretValue(
    botToken,
    SECRETS_ENCRYPTION_KEY,
  );

  const [composeRow] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!composeRow) throw new Error("Compose not found");

  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: uniqueId("bot"),
      botUsername: "test_bot",
      encryptedBotToken,
      webhookSecret: "webhook-secret",
      defaultComposeId: composeId,
      ownerUserId: vm0UserId,
      orgId: composeRow.orgId,
    })
    .returning();

  const [userLink] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: PTUID,
      installationId: installation!.telegramBotId,
      vm0UserId,
    })
    .returning();

  return {
    installationId: installation!.telegramBotId,
    userLinkId: userLink!.id,
    vm0UserId,
  };
}

interface CallbackInstallationResult {
  installationId: string;
  userLinkId: string;
}

/**
 * Create a Telegram installation with properly encrypted bot token and a user link.
 * Use this for callback endpoint tests that need to decrypt the bot token.
 * @why-db-direct Creates installation with encrypted bot token for callback decryption testing
 */
export async function createTelegramCallbackInstallation(
  composeId: string,
  userId: string,
  botToken: string,
  options?: { telegramUserId?: string },
): Promise<CallbackInstallationResult> {
  initServices();

  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const encryptedBotToken = encryptSecretValue(
    botToken,
    SECRETS_ENCRYPTION_KEY,
  );

  const [composeRow] = await globalThis.services.db
    .select({ orgId: agentComposes.orgId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!composeRow) throw new Error("Compose not found");

  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: uniqueId("bot"),
      botUsername: "test_bot",
      encryptedBotToken,
      webhookSecret: "webhook-secret",
      defaultComposeId: composeId,
      ownerUserId: userId,
      orgId: composeRow.orgId,
    })
    .returning();

  const [userLink] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: options?.telegramUserId ?? uniqueId("tg"),
      installationId: installation!.telegramBotId,
      vm0UserId: userId,
    })
    .returning();

  return {
    installationId: installation!.telegramBotId,
    userLinkId: userLink!.id,
  };
}

/**
 * Create a telegram thread session for testing.
 * @why-db-direct Creates thread session for session tracking tests
 */
export async function createTelegramThreadSession(params: {
  telegramUserLinkId: string;
  chatId: string;
  rootMessageId: string;
  agentSessionId: string;
}): Promise<void> {
  initServices();

  await globalThis.services.db.insert(telegramThreadSessions).values({
    telegramUserLinkId: params.telegramUserLinkId,
    chatId: params.chatId,
    rootMessageId: params.rootMessageId,
    agentSessionId: params.agentSessionId,
  });
}

/**
 * Sign connect params for testing telegram connect flow.
 */
export function signTestConnectParams(
  installationId: string,
  telegramUserId: string,
  botToken: string,
): { sig: string; ts: number } {
  const ts = Math.floor(Date.now() / 1000);
  const sig = signConnectParams(installationId, telegramUserId, ts, botToken);
  return { sig, ts };
}
