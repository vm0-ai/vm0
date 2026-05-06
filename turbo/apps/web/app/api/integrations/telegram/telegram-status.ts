import { and, eq } from "drizzle-orm";
import { getConnectorProvidedSecretNames } from "@vm0/connectors/connector-utils";
import type {
  TelegramBot,
  TelegramBotStatus,
} from "@vm0/api-contracts/contracts/zero-integrations-telegram";
import { extractAndGroupVariables } from "@vm0/core/variable-expander";
import { env } from "../../../../src/env";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import type { AgentComposeYaml } from "../../../../src/lib/infra/agent-compose/types";
import { decryptSecretValue } from "../../../../src/lib/shared/crypto/secrets-encryption";
import { logger } from "../../../../src/lib/shared/logger";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import { listSecrets } from "../../../../src/lib/zero/secret/secret-service";
import { checkTelegramDomain } from "../../../../src/lib/zero/telegram/check-domain";
import { buildTelegramBotAvatarUrl } from "../../../../src/lib/zero/telegram/avatar-url";
import {
  getMe,
  isTelegramApiError,
} from "../../../../src/lib/zero/telegram/client";
import {
  OFFICIAL_TELEGRAM_BOT_ID,
  getOfficialTelegramBotConfig,
} from "../../../../src/lib/zero/telegram/official";
import { getTelegramUserAgentPreference } from "../../../../src/lib/zero/telegram/official-user";
import { resolveDefaultAgentId } from "../../../../src/lib/zero/resolve-default-agent";
import { listVariables } from "../../../../src/lib/zero/variable/variable-service";

export type TelegramInstallation = typeof telegramInstallations.$inferSelect;

type TelegramTokenStatus = TelegramBot["tokenStatus"];

const log = logger("api:telegram:status");

type TelegramCompose = {
  id: string;
  name: string;
  headVersionId: string | null;
};

async function getDefaultCompose(
  installation: TelegramInstallation,
): Promise<TelegramCompose | null> {
  return getCompose(installation.defaultComposeId);
}

async function getCompose(composeId: string): Promise<TelegramCompose | null> {
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  return compose ?? null;
}

async function getOrgCompose(
  composeId: string,
  orgId: string,
): Promise<TelegramCompose | null> {
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(and(eq(agentComposes.id, composeId), eq(agentComposes.orgId, orgId)))
    .limit(1);

  return compose ?? null;
}

async function getTelegramUserLink(telegramBotId: string, userId: string) {
  const [userLink] = await globalThis.services.db
    .select({
      id: telegramUserLinks.id,
      telegramUserId: telegramUserLinks.telegramUserId,
      installationId: telegramUserLinks.installationId,
      vm0UserId: telegramUserLinks.vm0UserId,
    })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, telegramBotId),
        eq(telegramUserLinks.vm0UserId, userId),
      ),
    )
    .limit(1);

  return userLink ?? null;
}

async function getOfficialUserLink(orgId: string, userId: string) {
  const [userLink] = await globalThis.services.db
    .select({
      id: telegramOfficialUserLinks.id,
      telegramUserId: telegramOfficialUserLinks.telegramUserId,
      vm0UserId: telegramOfficialUserLinks.vm0UserId,
      orgId: telegramOfficialUserLinks.orgId,
    })
    .from(telegramOfficialUserLinks)
    .where(
      and(
        eq(telegramOfficialUserLinks.vm0UserId, userId),
        eq(telegramOfficialUserLinks.orgId, orgId),
      ),
    )
    .limit(1);

  return userLink ?? null;
}

async function resolveOfficialCompose(params: {
  orgId: string;
  userId: string;
}): Promise<{
  compose: TelegramCompose | null;
  usesDefaultAgent: boolean;
}> {
  const selectedComposeId = await getTelegramUserAgentPreference(
    params.userId,
    params.orgId,
  );

  if (selectedComposeId) {
    const selectedCompose = await getOrgCompose(
      selectedComposeId,
      params.orgId,
    );
    if (selectedCompose) {
      return { compose: selectedCompose, usesDefaultAgent: false };
    }
  }

  const defaultComposeId = await resolveDefaultAgentId(params.orgId);
  if (!defaultComposeId) {
    return { compose: null, usesDefaultAgent: true };
  }

  return {
    compose: await getOrgCompose(defaultComposeId, params.orgId),
    usesDefaultAgent: true,
  };
}

async function getEnvironmentStatus(
  compose: TelegramCompose | null,
  orgId: string,
  userId: string,
): Promise<TelegramBotStatus["environment"]> {
  let requiredSecrets: string[] = [];
  let requiredVars: string[] = [];

  if (compose?.headVersionId) {
    const [version] = await globalThis.services.db
      .select({ content: agentComposeVersions.content })
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, compose.headVersionId))
      .limit(1);

    if (version) {
      const content = version.content as AgentComposeYaml;
      const grouped = extractAndGroupVariables(content);
      requiredSecrets = grouped.secrets.map((secret) => {
        return secret.name;
      });
      requiredVars = grouped.vars.map((variable) => {
        return variable.name;
      });
    }
  }

  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(orgId, userId),
    listVariables(orgId, userId),
    listConnectors(orgId, userId),
  ]);

  const connectorProvided = getConnectorProvidedSecretNames(
    userConnectors.map((connector) => {
      return connector.type;
    }),
  );
  const existingSecretNames = new Set([
    ...userSecrets.map((secret) => {
      return secret.name;
    }),
    ...connectorProvided,
  ]);
  const existingVarNames = new Set(
    userVars.map((variable) => {
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
}

function isInvalidTelegramTokenError(error: unknown): boolean {
  if (isTelegramApiError(error)) {
    return (
      error.status === 401 ||
      /unauthorized|not found/i.test(error.description ?? "")
    );
  }

  return false;
}

async function checkTelegramTokenStatus(
  installation: TelegramInstallation,
): Promise<TelegramTokenStatus> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );

  try {
    const botInfo = await getMe(botToken);
    if (String(botInfo.id) !== installation.telegramBotId) {
      return "invalid";
    }
    return "valid";
  } catch (error) {
    if (isInvalidTelegramTokenError(error)) {
      return "invalid";
    }

    log.warn("Unable to verify Telegram bot token", {
      telegramBotId: installation.telegramBotId,
      error,
    });
    return "unknown";
  }
}

export async function buildTelegramBot(
  installation: TelegramInstallation,
  userId: string,
  tokenStatusOverride?: TelegramTokenStatus,
): Promise<TelegramBot> {
  const [compose, userLink, tokenStatus] = await Promise.all([
    getDefaultCompose(installation),
    getTelegramUserLink(installation.telegramBotId, userId),
    tokenStatusOverride ?? checkTelegramTokenStatus(installation),
  ]);

  return {
    id: installation.telegramBotId,
    username: installation.botUsername,
    avatarUrl: buildTelegramBotAvatarUrl(installation.telegramBotId),
    agent: compose ? { id: compose.id, name: compose.name } : null,
    isOwner: installation.ownerUserId === userId,
    isConnected: !!userLink,
    tokenStatus,
  };
}

export async function buildOfficialTelegramBot(params: {
  orgId: string;
  userId: string;
}): Promise<TelegramBot> {
  const config = getOfficialTelegramBotConfig();
  const [officialCompose, userLink] = await Promise.all([
    resolveOfficialCompose(params),
    getOfficialUserLink(params.orgId, params.userId),
  ]);

  return {
    id: OFFICIAL_TELEGRAM_BOT_ID,
    kind: "official",
    username: config.botUsername,
    avatarUrl:
      config.botToken && config.botId
        ? buildTelegramBotAvatarUrl(OFFICIAL_TELEGRAM_BOT_ID)
        : null,
    agent: officialCompose.compose
      ? { id: officialCompose.compose.id, name: officialCompose.compose.name }
      : null,
    isOwner: false,
    isConnected: !!userLink,
    tokenStatus: config.botToken ? "valid" : "unknown",
    official: {
      configured: config.configured,
      usesDefaultAgent: officialCompose.usesDefaultAgent,
      linkedTelegramUserId: userLink?.telegramUserId ?? null,
    },
  };
}

export async function buildTelegramBotStatus(
  installation: TelegramInstallation,
  userId: string,
  tokenStatusOverride?: TelegramTokenStatus,
): Promise<TelegramBotStatus> {
  const compose = await getDefaultCompose(installation);
  const [userLink, environment, tokenStatus] = await Promise.all([
    getTelegramUserLink(installation.telegramBotId, userId),
    getEnvironmentStatus(compose, installation.orgId, userId),
    tokenStatusOverride ?? checkTelegramTokenStatus(installation),
  ]);

  const { NEXT_PUBLIC_APP_URL } = env();
  const domainConfigured = await checkTelegramDomain(
    installation.telegramBotId,
    NEXT_PUBLIC_APP_URL,
  );

  return {
    id: installation.telegramBotId,
    username: installation.botUsername,
    avatarUrl: buildTelegramBotAvatarUrl(installation.telegramBotId),
    agent: compose ? { id: compose.id, name: compose.name } : null,
    isOwner: installation.ownerUserId === userId,
    isConnected: !!userLink,
    tokenStatus,
    domainConfigured,
    environment,
  };
}
