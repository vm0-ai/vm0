import { and, eq } from "drizzle-orm";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { ensureStorageExists } from "../../infra/storage/storage-service";
import { resolveDefaultAgentId } from "../resolve-default-agent";
import { publishTelegramUserChangedSafely } from "./realtime";

export type OfficialTelegramUserLink =
  typeof telegramOfficialUserLinks.$inferSelect;

export type LinkOfficialTelegramUserResult =
  | {
      ok: true;
      userLink: OfficialTelegramUserLink;
    }
  | {
      ok: false;
      reason: "telegram-user-linked" | "vm0-org-linked" | "conflict";
      userLink?: OfficialTelegramUserLink;
    };

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

async function touchOfficialTelegramUserLink(
  userLink: OfficialTelegramUserLink,
  telegramUsername?: string | null,
  telegramDisplayName?: string | null,
): Promise<OfficialTelegramUserLink> {
  const nextTelegramUsername =
    telegramUsername === undefined
      ? userLink.telegramUsername
      : normalizeTelegramUsername(telegramUsername);
  const nextTelegramDisplayName =
    telegramDisplayName === undefined
      ? userLink.telegramDisplayName
      : normalizeTelegramDisplayName(telegramDisplayName);

  if (
    nextTelegramUsername === userLink.telegramUsername &&
    nextTelegramDisplayName === userLink.telegramDisplayName
  ) {
    return userLink;
  }

  const [updated] = await globalThis.services.db
    .update(telegramOfficialUserLinks)
    .set({
      telegramUsername: nextTelegramUsername,
      telegramDisplayName: nextTelegramDisplayName,
      updatedAt: new Date(),
    })
    .where(eq(telegramOfficialUserLinks.id, userLink.id))
    .returning();

  return updated ?? userLink;
}

export async function linkOfficialTelegramUserToVm0User(params: {
  telegramUserId: string;
  telegramUsername?: string | null;
  telegramDisplayName?: string | null;
  vm0UserId: string;
  orgId: string;
}): Promise<LinkOfficialTelegramUserResult> {
  const [existingTelegramLink] = await globalThis.services.db
    .select()
    .from(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.telegramUserId, params.telegramUserId))
    .limit(1);

  if (existingTelegramLink) {
    if (
      existingTelegramLink.vm0UserId === params.vm0UserId &&
      existingTelegramLink.orgId === params.orgId
    ) {
      const userLink = await touchOfficialTelegramUserLink(
        existingTelegramLink,
        params.telegramUsername,
        params.telegramDisplayName,
      );
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return { ok: true, userLink };
    }

    return {
      ok: false,
      reason: "telegram-user-linked",
      userLink: existingTelegramLink,
    };
  }

  const [existingVm0OrgLink] = await globalThis.services.db
    .select()
    .from(telegramOfficialUserLinks)
    .where(
      and(
        eq(telegramOfficialUserLinks.vm0UserId, params.vm0UserId),
        eq(telegramOfficialUserLinks.orgId, params.orgId),
      ),
    )
    .limit(1);

  if (existingVm0OrgLink) {
    if (existingVm0OrgLink.telegramUserId === params.telegramUserId) {
      const userLink = await touchOfficialTelegramUserLink(
        existingVm0OrgLink,
        params.telegramUsername,
        params.telegramDisplayName,
      );
      await publishTelegramUserChangedSafely(params.vm0UserId);
      return { ok: true, userLink };
    }

    return {
      ok: false,
      reason: "vm0-org-linked",
      userLink: existingVm0OrgLink,
    };
  }

  const [inserted] = await globalThis.services.db
    .insert(telegramOfficialUserLinks)
    .values({
      telegramUserId: params.telegramUserId,
      telegramUsername: normalizeTelegramUsername(params.telegramUsername),
      telegramDisplayName: normalizeTelegramDisplayName(
        params.telegramDisplayName,
      ),
      vm0UserId: params.vm0UserId,
      orgId: params.orgId,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted) {
    await publishTelegramUserChangedSafely(params.vm0UserId);
    return { ok: true, userLink: inserted };
  }

  return { ok: false, reason: "conflict" };
}

export async function ensureOfficialOrgAndArtifact(
  vm0UserId: string,
  orgId: string,
): Promise<void> {
  await ensureStorageExists(orgId, vm0UserId, "artifact", "artifact");
}

export async function getTelegramUserAgentPreference(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await globalThis.services.db
    .select({
      selectedComposeId: telegramUserAgentPreferences.selectedComposeId,
    })
    .from(telegramUserAgentPreferences)
    .where(
      and(
        eq(telegramUserAgentPreferences.vm0UserId, vm0UserId),
        eq(telegramUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);

  return row?.selectedComposeId ?? null;
}

export async function setTelegramUserAgentPreference(opts: {
  vm0UserId: string;
  orgId: string;
  composeId: string | null;
}): Promise<void> {
  await globalThis.services.db
    .insert(telegramUserAgentPreferences)
    .values({
      vm0UserId: opts.vm0UserId,
      orgId: opts.orgId,
      selectedComposeId: opts.composeId,
    })
    .onConflictDoUpdate({
      target: [
        telegramUserAgentPreferences.vm0UserId,
        telegramUserAgentPreferences.orgId,
      ],
      set: {
        selectedComposeId: opts.composeId,
        updatedAt: new Date(),
      },
    });
}

export async function resolveEffectiveTelegramComposeId(
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const preference = await getTelegramUserAgentPreference(vm0UserId, orgId);
  if (preference) {
    const [compose] = await globalThis.services.db
      .select({ id: agentComposes.id })
      .from(agentComposes)
      .where(
        and(eq(agentComposes.id, preference), eq(agentComposes.orgId, orgId)),
      )
      .limit(1);

    if (compose?.id) return preference;
  }

  return resolveDefaultAgentId(orgId);
}
