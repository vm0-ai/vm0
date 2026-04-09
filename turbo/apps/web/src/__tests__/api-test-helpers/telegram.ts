import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "crypto";
import { initServices } from "../../lib/init-services";
import { telegramInstallations } from "../../db/schema/telegram-installation";
import { telegramMessages } from "../../db/schema/telegram-message";
import { telegramUserLinks } from "../../db/schema/telegram-user-link";
import { telegramThreadSessions } from "../../db/schema/telegram-thread-session";
import { orgCache } from "../../db/schema/org-cache";
import { agentComposes } from "../../db/schema/agent-compose";
import { encryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";
import { signConnectParams } from "../../lib/zero/telegram/connect-token";
import { PENDING_TELEGRAM_USER_ID as PENDING_TG_USER_ID } from "../../lib/zero/telegram/handlers/shared";
import { ensureOrgRow } from "./org";
import { uniqueId } from "../test-helpers";

export { PENDING_TELEGRAM_USER_ID } from "../../lib/zero/telegram/handlers/shared";

/**
 * Create a Telegram installation with all required parent records.
 * Optionally auto-creates a user link for testing integration endpoints.
 * Returns the installation ID for use as a foreign key.
 */
export async function createTestTelegramInstallation(options?: {
  adminUserId?: string;
  vm0UserId?: string;
  telegramBotId?: string;
}): Promise<string> {
  initServices();
  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;

  const suffix = uniqueId("tg");
  const adminUserId = options?.adminUserId ?? uniqueId("test-admin");

  const orgSlug = uniqueId("org");
  const orgId = uniqueId("org");

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
      userId: adminUserId,
      orgId,
      name: uniqueId("compose"),
    })
    .returning();

  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: options?.telegramBotId ?? suffix,
      botUsername: `bot_${options?.telegramBotId ?? suffix}`,
      encryptedBotToken: encryptSecretValue(
        "test-bot-token",
        SECRETS_ENCRYPTION_KEY,
      ),
      webhookSecret: uniqueId("secret"),
      defaultComposeId: compose!.id,
      adminUserId,
    })
    .returning();

  // Auto-create user link if vm0UserId is provided
  if (options?.vm0UserId) {
    await globalThis.services.db
      .insert(telegramUserLinks)
      .values({
        telegramUserId: suffix,
        installationId: installation!.id,
        vm0UserId: options.vm0UserId,
      })
      .onConflictDoNothing();
  }

  return installation!.id;
}

/**
 * Insert test telegram messages with a specific creation date.
 * Used by cleanup cron tests.
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
 * Count telegram messages for a specific installation.
 */
export async function countTestTelegramMessages(
  installationId: string,
): Promise<number> {
  const result = await globalThis.services.db
    .select({ count: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, installationId));
  return result[0]!.count;
}

/**
 * Create a telegram installation for a specific compose with a known bot token.
 * Returns the installation ID.
 */
export async function createTelegramInstallationForCompose(
  composeId: string,
  adminUserId: string,
  botToken: string,
): Promise<string> {
  const encryptionKey = globalThis.services.env.SECRETS_ENCRYPTION_KEY;
  const encryptedBotToken = encryptSecretValue(botToken, encryptionKey);

  const rows = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: `bot-${randomUUID().slice(0, 8)}`,
      encryptedBotToken,
      webhookSecret: `secret-${randomUUID().slice(0, 8)}`,
      defaultComposeId: composeId,
      adminUserId,
    })
    .returning();

  if (!rows[0]) throw new Error("Failed to create telegram installation");
  return rows[0].id;
}

/**
 * Insert a test Telegram installation for a compose.
 */
export async function insertTestTelegramInstallation(params: {
  composeId: string;
  adminUserId: string;
  botUsername?: string;
}): Promise<{ id: string }> {
  const botId = `tg-bot-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const [row] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      defaultComposeId: params.composeId,
      telegramBotId: botId,
      encryptedBotToken: `encrypted-test-token-${botId}`,
      webhookSecret: `webhook-secret-${botId}`,
      botUsername: params.botUsername ?? `test_bot_${Date.now()}`,
      adminUserId: params.adminUserId,
    })
    .returning({ id: telegramInstallations.id });
  return row!;
}

/**
 * Insert a test Telegram user link.
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
 * Count rows in telegram_user_links where vm0_user_id matches.
 */
export async function countTelegramUserLinkRows(
  vm0UserId: string,
): Promise<number> {
  const rows = await globalThis.services.db.execute(
    sql`SELECT COUNT(*)::int AS count FROM telegram_user_links WHERE vm0_user_id = ${vm0UserId}`,
  );
  return (rows.rows[0] as { count: number }).count;
}

export async function findTestTelegramUserLinksByVm0UserId(vm0UserId: string) {
  return globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.vm0UserId, vm0UserId));
}

// ============================================================================
// Absorbed from lib/zero/telegram/__tests__/helpers.ts
// ============================================================================

/**
 * Create a telegram installation with all required foreign key dependencies.
 * Returns the installation ID for use in tests.
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
      adminUserId: uniqueId("admin"),
    })
    .returning();

  return installation!.id;
}

interface InsertMessageOptions {
  installationId: string;
  chatId: string;
  messageId: string;
  fromUserId: string;
  fromUsername?: string;
  text?: string;
  isBot?: boolean;
  createdAt?: Date;
}

/**
 * Insert a telegram message into the database for testing.
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
 */
export async function createTelegramPendingLinkInstallation(
  composeId: string,
  vm0UserId: string,
  botToken: string,
): Promise<PendingLinkInstallationResult> {
  initServices();

  const { SECRETS_ENCRYPTION_KEY } = globalThis.services.env;
  const PTUID = PENDING_TG_USER_ID;
  const encryptedBotToken = encryptSecretValue(
    botToken,
    SECRETS_ENCRYPTION_KEY,
  );

  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: uniqueId("bot"),
      botUsername: "test_bot",
      encryptedBotToken,
      webhookSecret: "webhook-secret",
      defaultComposeId: composeId,
      adminUserId: vm0UserId,
    })
    .returning();

  const [userLink] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: PTUID,
      installationId: installation!.id,
      vm0UserId,
    })
    .returning();

  return {
    installationId: installation!.id,
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

  const [installation] = await globalThis.services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: uniqueId("bot"),
      botUsername: "test_bot",
      encryptedBotToken,
      webhookSecret: "webhook-secret",
      defaultComposeId: composeId,
      adminUserId: userId,
    })
    .returning();

  const [userLink] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: options?.telegramUserId ?? uniqueId("tg"),
      installationId: installation!.id,
      vm0UserId: userId,
    })
    .returning();

  return {
    installationId: installation!.id,
    userLinkId: userLink!.id,
  };
}

/**
 * Check whether a user link exists for a given installation and telegram user ID.
 * Returns true if the link exists, false otherwise.
 */
export async function telegramUserLinkExists(
  installationId: string,
  telegramUserId: string,
): Promise<boolean> {
  initServices();

  const [row] = await globalThis.services.db
    .select({ id: telegramUserLinks.id })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, installationId),
        eq(telegramUserLinks.telegramUserId, telegramUserId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Create a telegram thread session for testing.
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
 * Check whether a telegram thread session exists for the given parameters.
 */
export async function telegramThreadSessionExists(params: {
  telegramUserLinkId: string;
  chatId: string;
  rootMessageId: string;
}): Promise<boolean> {
  initServices();

  const [row] = await globalThis.services.db
    .select({ id: telegramThreadSessions.id })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(
          telegramThreadSessions.telegramUserLinkId,
          params.telegramUserLinkId,
        ),
        eq(telegramThreadSessions.chatId, params.chatId),
        eq(telegramThreadSessions.rootMessageId, params.rootMessageId),
      ),
    )
    .limit(1);
  return row !== undefined;
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
