import { and, eq, sql } from "drizzle-orm";
import { initServices } from "../../lib/init-services";
import { telegramMessages } from "../../db/schema/telegram-message";
import { telegramUserLinks } from "../../db/schema/telegram-user-link";
import { telegramThreadSessions } from "../../db/schema/telegram-thread-session";

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
