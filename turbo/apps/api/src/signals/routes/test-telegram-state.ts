import { computed } from "ccstate";
import { desc, eq, sql } from "drizzle-orm";
import { testTelegramStateContract } from "@vm0/api-contracts/contracts/test-telegram-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { optionalEnv } from "../../lib/env";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$, type ReadonlyDb } from "../external/db";
import type { RouteEntry } from "../route";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const testTelegramStateQuery$ = queryOf(testTelegramStateContract.get);

function resolveTelegramApiUrlForDiagnostics(): string | null {
  const telegramApiUrl = optionalEnv("TELEGRAM_API_URL");
  if (telegramApiUrl) {
    return telegramApiUrl;
  }

  const mockFlag = optionalEnv("E2E_TELEGRAM_MOCK_ENABLED");
  const mockEnabled = mockFlag === "1" || mockFlag === "true";
  const vercelUrl = optionalEnv("VERCEL_URL");
  if (mockEnabled && vercelUrl) {
    return `https://${vercelUrl}/api/test/telegram-mock/bot`;
  }

  return null;
}

async function loadInstallation(db: ReadonlyDb, botId: string) {
  const [installation] = await db
    .select({
      telegramBotId: telegramInstallations.telegramBotId,
      botUsername: telegramInstallations.botUsername,
      orgId: telegramInstallations.orgId,
      ownerUserId: telegramInstallations.ownerUserId,
      defaultComposeId: telegramInstallations.defaultComposeId,
      createdAt: telegramInstallations.createdAt,
    })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId))
    .limit(1);
  return installation ?? null;
}

function loadLinks(db: ReadonlyDb, botId: string) {
  return db
    .select({
      id: telegramUserLinks.id,
      telegramUserId: telegramUserLinks.telegramUserId,
      vm0UserId: telegramUserLinks.vm0UserId,
      dmWelcomeSent: telegramUserLinks.dmWelcomeSent,
      createdAt: telegramUserLinks.createdAt,
    })
    .from(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, botId));
}

function loadRecentRuns(db: ReadonlyDb, orgId: string | undefined) {
  if (!orgId) {
    return [];
  }
  return db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      createdAt: agentRuns.createdAt,
      triggerSource: zeroRuns.triggerSource,
      userId: agentRuns.userId,
      error: agentRuns.error,
      promptPreview: sql<string>`substring(${agentRuns.prompt}, 1, 200)`,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(agentRuns.orgId, orgId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
}

async function loadOrgMeta(db: ReadonlyDb, orgId: string | undefined) {
  if (!orgId) {
    return null;
  }
  const [row] = await db
    .select({
      orgId: orgMetadata.orgId,
      defaultAgentId: orgMetadata.defaultAgentId,
      credits: orgMetadata.credits,
      tier: orgMetadata.tier,
    })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row ?? null;
}

async function loadDefaultAgent(
  db: ReadonlyDb,
  defaultComposeId: string | undefined,
) {
  if (!defaultComposeId) {
    return null;
  }
  const [row] = await db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      orgId: zeroAgents.orgId,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, defaultComposeId))
    .limit(1);
  return row ?? null;
}

async function loadCompose(
  db: ReadonlyDb,
  defaultComposeId: string | undefined,
) {
  if (!defaultComposeId) {
    return null;
  }
  const [row] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, defaultComposeId))
    .limit(1);
  return row ?? null;
}

async function loadComposeVersion(
  db: ReadonlyDb,
  headVersionId: string | null | undefined,
) {
  if (!headVersionId) {
    return null;
  }
  const [row] = await db
    .select({
      id: agentComposeVersions.id,
      content: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, headVersionId))
    .limit(1);
  return row ?? null;
}

async function countMessages(db: ReadonlyDb, botId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, botId));
  return row?.count ?? 0;
}

function loadMockCalls(db: ReadonlyDb) {
  return db
    .select({
      method: e2eTelegramMockCallLog.method,
      botToken: e2eTelegramMockCallLog.botToken,
      chatId: e2eTelegramMockCallLog.chatId,
      bodyJson: e2eTelegramMockCallLog.bodyJson,
      createdAt: e2eTelegramMockCallLog.createdAt,
    })
    .from(e2eTelegramMockCallLog)
    .orderBy(desc(e2eTelegramMockCallLog.createdAt))
    .limit(50);
}

const getTestTelegramState$ = computed(async (get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(testTelegramStateQuery$);
  if (!query.bot_id) {
    return {
      status: 400 as const,
      body: { error: "bot_id query param is required" },
    };
  }

  const db = get(db$);
  const installation = await loadInstallation(db, query.bot_id);
  const [links, recentRuns, orgMeta, defaultAgent, compose, messageCount] =
    await Promise.all([
      loadLinks(db, query.bot_id),
      loadRecentRuns(db, installation?.orgId),
      loadOrgMeta(db, installation?.orgId),
      loadDefaultAgent(db, installation?.defaultComposeId),
      loadCompose(db, installation?.defaultComposeId),
      countMessages(db, query.bot_id),
    ]);
  const [composeVersion, mockCalls] = await Promise.all([
    loadComposeVersion(db, compose?.headVersionId),
    loadMockCalls(db),
  ]);

  return {
    status: 200 as const,
    body: {
      installation,
      links,
      message_count: messageCount,
      recent_runs: recentRuns,
      org_metadata: orgMeta,
      default_agent: defaultAgent,
      default_compose: compose,
      default_compose_version: composeVersion
        ? {
            id: composeVersion.id,
            content_keys: Object.keys(
              (composeVersion.content ?? {}) as Record<string, unknown>,
            ),
          }
        : null,
      resolved_telegram_api_url: resolveTelegramApiUrlForDiagnostics(),
      mock_calls: mockCalls,
    },
  };
});

export const testTelegramStateRoutes: readonly RouteEntry[] = [
  {
    route: testTelegramStateContract.get,
    handler: getTestTelegramState$,
  },
];
