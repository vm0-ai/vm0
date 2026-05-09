import { computed, type Computed } from "ccstate";
import { OFFICIAL_TELEGRAM_BOT_ID } from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { agentComposes } from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { buildTelegramBotAvatarUrl } from "../external/telegram-avatar";
import { getMe } from "../external/telegram-client";
import { decryptSecretValue } from "./crypto.utils";

interface TelegramBotListItem {
  readonly id: string;
  readonly kind?: "custom" | "official";
  readonly username: string | null;
  readonly avatarUrl: string;
  readonly agent: { readonly id: string; readonly name: string } | null;
  readonly isOwner: boolean;
  readonly isConnected: boolean;
  readonly tokenStatus: "valid" | "invalid" | "unknown";
  readonly official?: {
    readonly configured: boolean;
    readonly usesDefaultAgent: boolean;
    readonly linkedTelegramUserId: string | null;
  };
}

interface OfficialTelegramBotConfig {
  readonly botId: string | null;
  readonly botToken: string | null;
  readonly botUsername: string | null;
  readonly webhookSecret: string | null;
  readonly configured: boolean;
}

function normalizeBotUsername(username: string | undefined): string | null {
  const normalized = username?.trim().replace(/^@+/, "");
  return normalized && normalized.length > 0 ? normalized : null;
}

function parseTelegramBotId(botToken: string | undefined): string | null {
  const id = botToken?.split(":", 1)[0]?.trim();
  return id && /^\d+$/.test(id) ? id : null;
}

function getOfficialTelegramBotConfig(): OfficialTelegramBotConfig {
  const botToken = env("TELEGRAM_OFFICIAL_BOT_TOKEN") ?? null;
  const webhookSecret = env("TELEGRAM_OFFICIAL_WEBHOOK_SECRET") ?? null;
  const botId = parseTelegramBotId(botToken ?? undefined);
  const botUsername = normalizeBotUsername(
    env("TELEGRAM_OFFICIAL_BOT_USERNAME"),
  );
  return {
    botId,
    botToken,
    botUsername,
    webhookSecret,
    configured: Boolean(botToken && botId && webhookSecret),
  };
}

function officialUserLink(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<{ readonly telegramUserId: string } | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        telegramUserId: telegramOfficialUserLinks.telegramUserId,
      })
      .from(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.vm0UserId, args.userId),
          eq(telegramOfficialUserLinks.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

interface TelegramComposeRow {
  readonly id: string;
  readonly name: string;
}

function getOrgCompose(args: {
  readonly composeId: string;
  readonly orgId: string;
}): Computed<Promise<TelegramComposeRow | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({ id: agentComposes.id, name: agentComposes.name })
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.id, args.composeId),
          eq(agentComposes.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

function userAgentPreference(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<string | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        selectedComposeId: telegramUserAgentPreferences.selectedComposeId,
      })
      .from(telegramUserAgentPreferences)
      .where(
        and(
          eq(telegramUserAgentPreferences.vm0UserId, args.userId),
          eq(telegramUserAgentPreferences.orgId, args.orgId),
        ),
      )
      .limit(1);
    return row?.selectedComposeId ?? null;
  });
}

function defaultAgentId(args: {
  readonly orgId: string;
}): Computed<Promise<string | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({ defaultAgentId: orgMetadata.defaultAgentId })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, args.orgId))
      .limit(1);
    return row?.defaultAgentId ?? env("VM0_DEFAULT_AGENT") ?? null;
  });
}

function officialCompose(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<
  Promise<{
    readonly compose: TelegramComposeRow | null;
    readonly usesDefaultAgent: boolean;
  }>
> {
  return computed(async (get) => {
    const selectedId = await get(userAgentPreference(args));
    if (selectedId) {
      const selected = await get(
        getOrgCompose({ composeId: selectedId, orgId: args.orgId }),
      );
      if (selected) {
        return { compose: selected, usesDefaultAgent: false };
      }
    }
    const defaultId = await get(defaultAgentId({ orgId: args.orgId }));
    if (!defaultId) {
      return { compose: null, usesDefaultAgent: true };
    }
    return {
      compose: await get(
        getOrgCompose({ composeId: defaultId, orgId: args.orgId }),
      ),
      usesDefaultAgent: true,
    };
  });
}

function buildOfficialTelegramBot(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramBotListItem>> {
  return computed(async (get): Promise<TelegramBotListItem> => {
    const config = getOfficialTelegramBotConfig();
    const [official, userLink] = await Promise.all([
      get(officialCompose(args)),
      get(officialUserLink(args)),
    ]);
    const hasAvatar = config.botToken !== null && config.botId !== null;
    return {
      id: OFFICIAL_TELEGRAM_BOT_ID,
      kind: "official",
      username: config.botUsername,
      avatarUrl: hasAvatar
        ? buildTelegramBotAvatarUrl(OFFICIAL_TELEGRAM_BOT_ID)
        : "",
      agent: official.compose
        ? { id: official.compose.id, name: official.compose.name }
        : null,
      isOwner: false,
      isConnected: userLink !== null,
      tokenStatus: config.botToken ? "valid" : "unknown",
      official: {
        configured: config.configured,
        usesDefaultAgent: official.usesDefaultAgent,
        linkedTelegramUserId: userLink?.telegramUserId ?? null,
      },
    };
  });
}

export function zeroTelegramBots(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly TelegramBotListItem[]>> {
  return computed(async (get): Promise<readonly TelegramBotListItem[]> => {
    const db = get(db$);

    const installations = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.orgId, args.orgId))
      .orderBy(
        desc(telegramInstallations.createdAt),
        desc(telegramInstallations.telegramBotId),
      );

    const customBots: TelegramBotListItem[] = await Promise.all(
      installations.map(async (installation) => {
        const tokenStatus = await resolveTokenStatus(
          installation.encryptedBotToken,
        );

        let agent: { id: string; name: string } | null = null;
        const [agentRow] = await db
          .select({ id: zeroAgents.id, name: zeroAgents.name })
          .from(agentComposes)
          .innerJoin(zeroAgents, eq(agentComposes.id, zeroAgents.id))
          .where(eq(agentComposes.id, installation.defaultComposeId))
          .limit(1);
        if (agentRow) {
          agent = { id: agentRow.id, name: agentRow.name };
        }

        return {
          id: installation.telegramBotId,
          username: installation.botUsername ?? null,
          avatarUrl: buildTelegramBotAvatarUrl(installation.telegramBotId),
          agent,
          isOwner: installation.ownerUserId === args.userId,
          isConnected: tokenStatus === "valid",
          tokenStatus,
        };
      }),
    );

    const official = await get(buildOfficialTelegramBot(args));
    return [official, ...customBots];
  });
}

export function zeroTelegramInstallation(args: {
  readonly orgId: string;
  readonly botId: string;
}): Computed<
  Promise<{
    readonly botToken: string;
    readonly botUsername: string | null;
  } | null>
> {
  return computed(async (get) => {
    const db = get(db$);

    const [row] = await db
      .select({
        encryptedBotToken: telegramInstallations.encryptedBotToken,
        botUsername: telegramInstallations.botUsername,
      })
      .from(telegramInstallations)
      .where(
        and(
          eq(telegramInstallations.telegramBotId, args.botId),
          eq(telegramInstallations.orgId, args.orgId),
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      botToken: decryptSecretValue(row.encryptedBotToken),
      botUsername: row.botUsername ?? null,
    };
  });
}

function resolveTokenStatus(
  encryptedBotToken: string,
): Promise<"valid" | "invalid" | "unknown"> {
  const token = decryptSecretValue(encryptedBotToken);
  return getMe(token)
    .then(() => {
      return "valid" as const;
    })
    .catch(() => {
      return "unknown" as const;
    });
}
