import { computed, type Computed } from "ccstate";
import type {
  TelegramBot,
  TelegramBotStatus,
  TelegramLinkStatusResponse,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import type { FeatureSwitchContext } from "@vm0/core/feature-switch";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { and, desc, eq } from "drizzle-orm";

import { env } from "../../lib/env";
import { db$ } from "../external/db";
import { buildTelegramBotAvatarUrl } from "../external/telegram-avatar";
import { checkTelegramDomain } from "../external/telegram-domain";
import { getMe, isTelegramApiError } from "../external/telegram-client";
import {
  getOfficialTelegramBotConfig,
  OFFICIAL_TELEGRAM_BOT_ID,
} from "../external/telegram-official";
import { safeUrlParse, settle } from "../utils";
import { decryptPersistentSecretValue } from "./crypto.utils";
import { userFeatureSwitchContext } from "./feature-switches.service";
import { zeroConnectorList } from "./zero-connector-data.service";
import { userSecrets, userVariables } from "./zero-user-data.service";

type TelegramBotListItem = TelegramBot;
type TelegramInstallationRow = typeof telegramInstallations.$inferSelect;
type TelegramConnectedUser = NonNullable<TelegramBot["connectedUser"]>;

function officialUserLink(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramConnectedUser | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        telegramUserId: telegramOfficialUserLinks.telegramUserId,
        telegramUsername: telegramOfficialUserLinks.telegramUsername,
        telegramDisplayName: telegramOfficialUserLinks.telegramDisplayName,
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
  readonly headVersionId: string | null;
}

function getOrgCompose(args: {
  readonly composeId: string;
  readonly orgId: string;
}): Computed<Promise<TelegramComposeRow | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
      })
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
    return row?.defaultAgentId ?? null;
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
        : null,
      agent: official.compose
        ? { id: official.compose.id, name: official.compose.name }
        : null,
      isOwner: false,
      isConnected: userLink !== null,
      connectedUser: userLink,
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
      installations.map((installation) => {
        return get(customTelegramBot({ installation, userId: args.userId }));
      }),
    );

    const official = await get(buildOfficialTelegramBot(args));
    return [official, ...customBots];
  });
}

function telegramUserLink(args: {
  readonly botId: string;
  readonly userId: string;
}): Computed<Promise<TelegramConnectedUser | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [row] = await db
      .select({
        telegramUserId: telegramUserLinks.telegramUserId,
        telegramUsername: telegramUserLinks.telegramUsername,
        telegramDisplayName: telegramUserLinks.telegramDisplayName,
      })
      .from(telegramUserLinks)
      .where(
        and(
          eq(telegramUserLinks.installationId, args.botId),
          eq(telegramUserLinks.vm0UserId, args.userId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}

function telegramEnvironment(args: {
  readonly compose: TelegramComposeRow | null;
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramBotStatus["environment"]>> {
  return computed(async (get) => {
    let requiredSecrets: string[] = [];
    let requiredVars: string[] = [];

    if (args.compose?.headVersionId) {
      const db = get(db$);
      const [version] = await db
        .select({ content: agentComposeVersions.content })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, args.compose.headVersionId))
        .limit(1);

      if (version) {
        const grouped = extractAndGroupVariables(version.content);
        requiredSecrets = grouped.secrets.map((secret) => {
          return secret.name;
        });
        requiredVars = grouped.vars.map((variable) => {
          return variable.name;
        });
      }
    }

    const [secretList, variableList, connectorList] = await Promise.all([
      get(userSecrets({ orgId: args.orgId, userId: args.userId })),
      get(userVariables({ orgId: args.orgId, userId: args.userId })),
      get(zeroConnectorList({ orgId: args.orgId, userId: args.userId })),
    ]);
    const existingSecretNames = new Set([
      ...secretList.secrets.map((secret) => {
        return secret.name;
      }),
      ...connectorList.connectorProvidedEnvNames,
    ]);
    const existingVarNames = new Set(
      variableList.variables.map((variable) => {
        return variable.name;
      }),
    );

    return {
      requiredSecrets,
      requiredVars,
      missingSecrets: requiredSecrets.filter((name) => {
        return !existingSecretNames.has(name);
      }),
      missingVars: requiredVars.filter((name) => {
        return !existingVarNames.has(name);
      }),
    };
  });
}

function customTelegramBot(args: {
  readonly installation: TelegramInstallationRow;
  readonly userId: string;
}): Computed<Promise<TelegramBot>> {
  return computed(async (get) => {
    const [compose, userLink, tokenStatus] = await Promise.all([
      get(
        getOrgCompose({
          composeId: args.installation.defaultComposeId,
          orgId: args.installation.orgId,
        }),
      ),
      get(
        telegramUserLink({
          botId: args.installation.telegramBotId,
          userId: args.userId,
        }),
      ),
      resolveIntegrationTokenStatus(
        args.installation,
        await get(
          userFeatureSwitchContext(
            args.installation.orgId,
            args.installation.ownerUserId,
          ),
        ),
      ),
    ]);

    return {
      id: args.installation.telegramBotId,
      username: args.installation.botUsername,
      avatarUrl: buildTelegramBotAvatarUrl(args.installation.telegramBotId),
      agent: compose ? { id: compose.id, name: compose.name } : null,
      isOwner: args.installation.ownerUserId === args.userId,
      isConnected: userLink !== null,
      connectedUser: userLink,
      tokenStatus,
    };
  });
}

function customTelegramBotStatus(args: {
  readonly installation: TelegramInstallationRow;
  readonly userId: string;
}): Computed<Promise<TelegramBotStatus>> {
  return computed(async (get) => {
    const compose = await get(
      getOrgCompose({
        composeId: args.installation.defaultComposeId,
        orgId: args.installation.orgId,
      }),
    );
    const [bot, environment, domainConfigured] = await Promise.all([
      get(customTelegramBot(args)),
      get(
        telegramEnvironment({
          compose,
          orgId: args.installation.orgId,
          userId: args.userId,
        }),
      ),
      checkTelegramDomain(args.installation.telegramBotId, env("APP_URL")),
    ]);

    return { ...bot, domainConfigured, environment };
  });
}

function officialTelegramBotStatus(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<TelegramBotStatus>> {
  return computed(async (get) => {
    const config = getOfficialTelegramBotConfig();
    const official = await get(officialCompose(args));
    const [bot, environment, domainConfigured] = await Promise.all([
      get(buildOfficialTelegramBot(args)),
      get(telegramEnvironment({ compose: official.compose, ...args })),
      config.botId
        ? checkTelegramDomain(config.botId, env("APP_URL"))
        : Promise.resolve(false),
    ]);

    return { ...bot, domainConfigured, environment };
  });
}

export function telegramIntegrationBots(args: {
  readonly orgId: string;
  readonly userId: string;
}): Computed<Promise<readonly TelegramBot[]>> {
  return computed(async (get): Promise<readonly TelegramBot[]> => {
    const db = get(db$);
    const installations = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.orgId, args.orgId))
      .orderBy(
        desc(telegramInstallations.createdAt),
        desc(telegramInstallations.telegramBotId),
      );

    const customBots = await Promise.all(
      installations.map((installation) => {
        return get(customTelegramBot({ installation, userId: args.userId }));
      }),
    );
    const official = await get(buildOfficialTelegramBot(args));
    return [official, ...customBots];
  });
}

export function telegramIntegrationBotStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly botId: string;
}): Computed<Promise<TelegramBotStatus | null>> {
  return computed(async (get) => {
    if (args.botId === OFFICIAL_TELEGRAM_BOT_ID) {
      return await get(officialTelegramBotStatus(args));
    }

    const db = get(db$);
    const [installation] = await db
      .select()
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, args.botId))
      .limit(1);

    if (!installation || installation.orgId !== args.orgId) {
      return null;
    }

    return await get(
      customTelegramBotStatus({ installation, userId: args.userId }),
    );
  });
}

type TelegramLinkStatusResult =
  | { readonly status: 200; readonly body: TelegramLinkStatusResponse }
  | {
      readonly status: 403;
      readonly body: {
        readonly error: { readonly message: string; readonly code: string };
      };
    };

function resolveTelegramLoginOrigin(originParam: string | undefined): string {
  if (!originParam) {
    return env("APP_URL");
  }

  const originUrl = safeUrlParse(originParam);
  if (
    originUrl &&
    (originUrl.protocol === "http:" || originUrl.protocol === "https:")
  ) {
    return originUrl.origin;
  }

  return env("APP_URL");
}

function orgMismatchResult(): TelegramLinkStatusResult {
  return {
    status: 403,
    body: {
      error: {
        message:
          "This Telegram bot belongs to a different organization. Switch to the bot's organization to connect.",
        code: "FORBIDDEN",
      },
    },
  };
}

export function telegramIntegrationLinkStatus(args: {
  readonly orgId: string;
  readonly userId: string;
  readonly botId?: string;
  readonly origin?: string;
}): Computed<Promise<TelegramLinkStatusResult>> {
  return computed(async (get): Promise<TelegramLinkStatusResult> => {
    const db = get(db$);
    const telegramLoginOrigin = resolveTelegramLoginOrigin(args.origin);

    if (args.botId === OFFICIAL_TELEGRAM_BOT_ID) {
      const userLink = await get(officialUserLink(args));
      const config = getOfficialTelegramBotConfig();
      if (userLink) {
        return {
          status: 200,
          body: {
            linked: true,
            telegramUserId: userLink.telegramUserId,
            botUsername: config.botUsername ?? "Zero",
          },
        };
      }

      const domainConfigured = config.botId
        ? await checkTelegramDomain(config.botId, telegramLoginOrigin)
        : false;
      return {
        status: 200,
        body: {
          linked: false,
          installation: {
            id: OFFICIAL_TELEGRAM_BOT_ID,
            botUsername: config.botUsername ?? "Zero",
            ...(config.botId ? { loginBotId: config.botId } : {}),
            domainConfigured,
          },
        },
      };
    }

    const [userLink] = await db
      .select({
        telegramUserId: telegramUserLinks.telegramUserId,
        botUsername: telegramInstallations.botUsername,
      })
      .from(telegramUserLinks)
      .innerJoin(
        telegramInstallations,
        eq(
          telegramUserLinks.installationId,
          telegramInstallations.telegramBotId,
        ),
      )
      .where(
        and(
          eq(telegramUserLinks.vm0UserId, args.userId),
          eq(telegramInstallations.orgId, args.orgId),
          args.botId
            ? eq(telegramUserLinks.installationId, args.botId)
            : undefined,
        ),
      )
      .orderBy(desc(telegramUserLinks.createdAt))
      .limit(1);

    if (userLink) {
      return {
        status: 200,
        body: {
          linked: true,
          telegramUserId: userLink.telegramUserId,
          botUsername: userLink.botUsername ?? undefined,
        },
      };
    }

    if (args.botId) {
      const [installation] = await db
        .select({
          telegramBotId: telegramInstallations.telegramBotId,
          botUsername: telegramInstallations.botUsername,
          orgId: telegramInstallations.orgId,
        })
        .from(telegramInstallations)
        .where(eq(telegramInstallations.telegramBotId, args.botId))
        .limit(1);

      if (installation) {
        if (installation.orgId !== args.orgId) {
          return orgMismatchResult();
        }

        const domainConfigured = await checkTelegramDomain(
          installation.telegramBotId,
          telegramLoginOrigin,
        );
        return {
          status: 200,
          body: {
            linked: false,
            installation: {
              id: installation.telegramBotId,
              botUsername: installation.botUsername ?? "Telegram bot",
              loginBotId: installation.telegramBotId,
              domainConfigured,
            },
          },
        };
      }
    }

    return { status: 200, body: { linked: false } };
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
        ownerUserId: telegramInstallations.ownerUserId,
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
      botToken: await decryptPersistentSecretValue(
        row.encryptedBotToken,
        await get(userFeatureSwitchContext(args.orgId, row.ownerUserId)),
      ),
      botUsername: row.botUsername ?? null,
    };
  });
}

export function telegramBotToken(args: {
  readonly botId: string;
  readonly orgId?: string;
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
        ownerUserId: telegramInstallations.ownerUserId,
        orgId: telegramInstallations.orgId,
      })
      .from(telegramInstallations)
      .where(
        and(
          eq(telegramInstallations.telegramBotId, args.botId),
          args.orgId ? eq(telegramInstallations.orgId, args.orgId) : undefined,
        ),
      )
      .limit(1);

    if (!row) {
      return null;
    }

    return {
      botToken: await decryptPersistentSecretValue(
        row.encryptedBotToken,
        await get(userFeatureSwitchContext(row.orgId, row.ownerUserId)),
      ),
      botUsername: row.botUsername ?? null,
    };
  });
}

function isInvalidTelegramTokenError(error: unknown): boolean {
  if (!isTelegramApiError(error)) {
    return false;
  }

  return (
    error.status === 401 ||
    /unauthorized|not found/i.test(error.description ?? "")
  );
}

async function resolveIntegrationTokenStatus(
  installation: TelegramInstallationRow,
  featureSwitchContext: FeatureSwitchContext,
): Promise<TelegramBot["tokenStatus"]> {
  const token = await decryptPersistentSecretValue(
    installation.encryptedBotToken,
    featureSwitchContext,
  );
  const result = await settle(getMe(token));

  if (!result.ok) {
    if (isInvalidTelegramTokenError(result.error)) {
      return "invalid";
    }
    return "unknown";
  }

  if (String(result.value.id) !== installation.telegramBotId) {
    return "invalid";
  }
  return "valid";
}
