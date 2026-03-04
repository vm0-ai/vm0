import { initServices } from "../../init-services";
import { telegramInstallations } from "../../../db/schema/telegram-installation";
import { telegramMessages } from "../../../db/schema/telegram-message";
import { agentComposes } from "../../../db/schema/agent-compose";
import { scopes } from "../../../db/schema/scope";
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
      type: "personal",
      ownerId: uniqueId("test-admin"),
    })
    .returning();

  const [compose] = await globalThis.services.db
    .insert(agentComposes)
    .values({
      userId: uniqueId("test-user"),
      scopeId: scope!.id,
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
