import { eq, and } from "drizzle-orm";
import { initServices } from "../../init-services";
import { telegramInstallations } from "../../../db/schema/telegram-installation";
import { telegramUserLinks } from "../../../db/schema/telegram-user-link";
import { telegramMessages } from "../../../db/schema/telegram-message";
import { telegramThreadSessions } from "../../../db/schema/telegram-thread-session";
import { agentComposes } from "../../../db/schema/agent-compose";
import { scopes } from "../../../db/schema/scope";
import { encryptSecretValue } from "../../crypto/secrets-encryption";
import { PENDING_TELEGRAM_USER_ID } from "../handlers/shared";
import { uniqueId } from "../../../__tests__/test-helpers";

/**
 * Create a telegram installation with all required foreign key dependencies.
 * Returns the installation ID for use in tests.
 */
export async function createTelegramInstallation(): Promise<string> {
  initServices();

  const suffix = uniqueId("tg");

  const [scope] = await globalThis.services.db
    .insert(scopes)
    .values({
      slug: suffix,
      clerkOrgId: uniqueId("org"),
    })
    .returning();

  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: uniqueId("test-user"),
      scopeId: scope!.id,
      clerkOrgId: scope!.clerkOrgId,
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
      telegramUserId: PENDING_TELEGRAM_USER_ID,
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
