import { and, eq } from "drizzle-orm";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { ensureStorageExists } from "../../../infra/storage/storage-service";
import { escapeHtml } from "../format";
import { publishTelegramUserChangedSafely } from "../realtime";

type TelegramUserNameSource =
  | {
      first_name?: string | null;
      last_name?: string | null;
    }
  | null
  | undefined;

/**
 * Sentinel value for a pending user link that hasn't been claimed yet.
 * Set as telegramUserId at link time, replaced with the real
 * Telegram user ID when the user sends their first message.
 */
export const PENDING_TELEGRAM_USER_ID = "pending";

export type LinkTelegramUserResult =
  | {
      ok: true;
      userLink: typeof telegramUserLinks.$inferSelect;
    }
  | {
      ok: false;
      reason: "telegram-user-linked" | "vm0-user-linked" | "conflict";
      userLink?: typeof telegramUserLinks.$inferSelect;
    };

export type TelegramMessageScope =
  | string
  | { readonly kind: "custom"; readonly installationId: string }
  | { readonly kind: "official"; readonly orgId: string };

async function touchTelegramUserLink(
  userLink: typeof telegramUserLinks.$inferSelect,
  telegramUsername?: string | null,
  telegramDisplayName?: string | null,
): Promise<typeof telegramUserLinks.$inferSelect> {
  const nextTelegramUsername =
    telegramUsername === undefined
      ? userLink.telegramUsername
      : normalizeTelegramUsername(telegramUsername);
  const nextTelegramDisplayName =
    telegramDisplayName === undefined
      ? userLink.telegramDisplayName
      : normalizeTelegramDisplayName(telegramDisplayName);
  const [updated] = await globalThis.services.db
    .update(telegramUserLinks)
    .set({
      telegramUsername: nextTelegramUsername,
      telegramDisplayName: nextTelegramDisplayName,
      updatedAt: new Date(),
    })
    .where(eq(telegramUserLinks.id, userLink.id))
    .returning();
  return updated ?? userLink;
}

function normalizeTelegramUsername(
  telegramUsername: string | null | undefined,
): string | null {
  const value = telegramUsername?.trim().replace(/^@+/, "");
  return value ? value : null;
}

function normalizeTelegramDisplayName(
  telegramDisplayName: string | null | undefined,
): string | null {
  const value = telegramDisplayName?.trim().replace(/\s+/g, " ");
  return value ? value.slice(0, 255) : null;
}

export function formatTelegramUserDisplayName(
  user: TelegramUserNameSource,
): string | null {
  return normalizeTelegramDisplayName(
    [user?.first_name, user?.last_name]
      .map((part) => {
        return part?.trim();
      })
      .filter(Boolean)
      .join(" "),
  );
}

/**
 * Link one Telegram account to one VM0 user for a bot installation.
 *
 * A Telegram user can be linked to different VM0 users across different bots,
 * but within one bot both sides are one-to-one:
 * - (installationId, telegramUserId) is unique
 * - (installationId, vm0UserId) is unique
 */
export async function linkTelegramUserToVm0User(params: {
  installationId: string;
  telegramUserId: string;
  telegramUsername?: string | null;
  telegramDisplayName?: string | null;
  vm0UserId: string;
}): Promise<LinkTelegramUserResult> {
  const [existingTelegramLink] = await globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, params.installationId),
        eq(telegramUserLinks.telegramUserId, params.telegramUserId),
      ),
    )
    .limit(1);

  if (existingTelegramLink) {
    if (existingTelegramLink.vm0UserId === params.vm0UserId) {
      const userLink = await touchTelegramUserLink(
        existingTelegramLink,
        params.telegramUsername,
        params.telegramDisplayName,
      );
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return {
        ok: true,
        userLink,
      };
    }

    return {
      ok: false,
      reason: "telegram-user-linked",
      userLink: existingTelegramLink,
    };
  }

  const [existingVm0Link] = await globalThis.services.db
    .select()
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, params.installationId),
        eq(telegramUserLinks.vm0UserId, params.vm0UserId),
      ),
    )
    .limit(1);

  if (existingVm0Link) {
    if (existingVm0Link.telegramUserId === params.telegramUserId) {
      const userLink = await touchTelegramUserLink(
        existingVm0Link,
        params.telegramUsername,
        params.telegramDisplayName,
      );
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return {
        ok: true,
        userLink,
      };
    }

    if (
      existingVm0Link.telegramUserId === PENDING_TELEGRAM_USER_ID &&
      params.telegramUserId !== PENDING_TELEGRAM_USER_ID
    ) {
      const [updated] = await globalThis.services.db
        .update(telegramUserLinks)
        .set({
          telegramUserId: params.telegramUserId,
          telegramUsername: normalizeTelegramUsername(params.telegramUsername),
          telegramDisplayName: normalizeTelegramDisplayName(
            params.telegramDisplayName,
          ),
          updatedAt: new Date(),
        })
        .where(eq(telegramUserLinks.id, existingVm0Link.id))
        .returning();

      const userLink = updated ?? existingVm0Link;
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return {
        ok: true,
        userLink,
      };
    }

    return {
      ok: false,
      reason: "vm0-user-linked",
      userLink: existingVm0Link,
    };
  }

  const [inserted] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      telegramUserId: params.telegramUserId,
      telegramUsername: normalizeTelegramUsername(params.telegramUsername),
      telegramDisplayName: normalizeTelegramDisplayName(
        params.telegramDisplayName,
      ),
      installationId: params.installationId,
      vm0UserId: params.vm0UserId,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    await publishTelegramUserChangedSafely(params.vm0UserId);
    return { ok: true, userLink: inserted };
  }

  return { ok: false, reason: "conflict" };
}

/**
 * Ensure artifact storage exists for a user within the given org.
 *
 * The caller must resolve and authorize the org before invoking this —
 * we do not re-check membership here.
 */
export async function ensureOrgAndArtifact(
  vm0UserId: string,
  orgId: string,
): Promise<void> {
  await ensureStorageExists(orgId, vm0UserId, "artifact", "artifact");
}

export function formatTelegramCommandSuccess(message: string): string {
  return `✅ ${escapeHtml(message)}`;
}
