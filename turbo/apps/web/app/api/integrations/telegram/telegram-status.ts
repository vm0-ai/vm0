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
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import type { AgentComposeYaml } from "../../../../src/lib/infra/agent-compose/types";
import { listConnectors } from "../../../../src/lib/zero/connector/connector-service";
import { listSecrets } from "../../../../src/lib/zero/secret/secret-service";
import { checkTelegramDomain } from "../../../../src/lib/zero/telegram/check-domain";
import { listVariables } from "../../../../src/lib/zero/variable/variable-service";

export type TelegramInstallation = typeof telegramInstallations.$inferSelect;

type TelegramCompose = {
  id: string;
  name: string;
  headVersionId: string | null;
};

async function getDefaultCompose(
  installation: TelegramInstallation,
): Promise<TelegramCompose | null> {
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  return compose ?? null;
}

export async function getTelegramUserLink(
  telegramBotId: string,
  userId: string,
) {
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

export async function buildTelegramBot(
  installation: TelegramInstallation,
  userId: string,
): Promise<TelegramBot> {
  const [compose, userLink] = await Promise.all([
    getDefaultCompose(installation),
    getTelegramUserLink(installation.telegramBotId, userId),
  ]);

  return {
    id: installation.telegramBotId,
    username: installation.botUsername,
    agent: compose ? { id: compose.id, name: compose.name } : null,
    isOwner: installation.ownerUserId === userId,
    isConnected: !!userLink,
  };
}

export async function buildTelegramBotStatus(
  installation: TelegramInstallation,
  userId: string,
): Promise<TelegramBotStatus> {
  const compose = await getDefaultCompose(installation);
  const [userLink, environment] = await Promise.all([
    getTelegramUserLink(installation.telegramBotId, userId),
    getEnvironmentStatus(compose, installation.orgId, userId),
  ]);

  const { NEXT_PUBLIC_APP_URL } = env();
  const domainConfigured = await checkTelegramDomain(
    installation.telegramBotId,
    NEXT_PUBLIC_APP_URL,
  );

  return {
    id: installation.telegramBotId,
    username: installation.botUsername,
    agent: compose ? { id: compose.id, name: compose.name } : null,
    isOwner: installation.ownerUserId === userId,
    isConnected: !!userLink,
    domainConfigured,
    environment,
  };
}
