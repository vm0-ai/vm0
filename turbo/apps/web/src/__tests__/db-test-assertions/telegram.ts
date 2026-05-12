import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { decryptSecretValue } from "../../lib/shared/crypto/secrets-encryption";

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

export async function findTestOfficialTelegramUserLinksByVm0UserId(
  vm0UserId: string,
) {
  return globalThis.services.db
    .select()
    .from(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.vm0UserId, vm0UserId));
}

export async function findTestOfficialTelegramUserLink(params: {
  telegramUserId: string;
  orgId: string;
}) {
  const [row] = await globalThis.services.db
    .select()
    .from(telegramOfficialUserLinks)
    .where(
      and(
        eq(telegramOfficialUserLinks.telegramUserId, params.telegramUserId),
        eq(telegramOfficialUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  return row;
}

export async function findTestTelegramUserAgentPreference(params: {
  vm0UserId: string;
  orgId: string;
}) {
  const [row] = await globalThis.services.db
    .select()
    .from(telegramUserAgentPreferences)
    .where(
      and(
        eq(telegramUserAgentPreferences.vm0UserId, params.vm0UserId),
        eq(telegramUserAgentPreferences.orgId, params.orgId),
      ),
    )
    .limit(1);

  return row;
}

/**
 * Find telegram installations owned by a specific user.
 */
export async function findTestTelegramInstallationsByOwner(
  ownerUserId: string,
) {
  return globalThis.services.db
    .select()
    .from(telegramInstallations)
    .where(eq(telegramInstallations.ownerUserId, ownerUserId));
}

/**
 * Read and decrypt a Telegram bot token for assertions.
 */
export async function getTestTelegramBotToken(
  telegramBotId: string,
): Promise<string | null> {
  initServices();

  const [installation] = await globalThis.services.db
    .select({ encryptedBotToken: telegramInstallations.encryptedBotToken })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId))
    .limit(1);

  if (!installation) {
    return null;
  }

  return decryptSecretValue(
    installation.encryptedBotToken,
    globalThis.services.env.SECRETS_ENCRYPTION_KEY,
  );
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
 * Find the agent session mapped to a Telegram thread.
 */
export async function findTelegramThreadAgentSessionId(params: {
  telegramUserLinkId: string;
  chatId: string;
  rootMessageId: string;
}): Promise<string | undefined> {
  initServices();

  const [row] = await globalThis.services.db
    .select({ agentSessionId: telegramThreadSessions.agentSessionId })
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
  return row?.agentSessionId;
}
