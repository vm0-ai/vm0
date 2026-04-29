import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { isTestEndpointAllowed } from "../../../../src/lib/auth/test-endpoint-guard";
import {
  DEFAULT_TEST_EMAIL,
  resolveTestOrgId,
  resolveTestUserId,
} from "../../../../src/lib/auth/test-user";
import { seedDefaultAgent } from "../../../../src/lib/test-endpoints/seed-default-agent";
import { TELEGRAM_E2E_FIXTURES } from "../../../../src/lib/test-endpoints/telegram-mock-fixtures";
import { encryptSecretValue } from "../../../../src/lib/shared/crypto/secrets-encryption";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";

interface SeedBody {
  bot_id: string;
  telegram_user_id: string;
  bot_username?: string;
  webhook_secret?: string;
  email?: string;
  seed_link?: boolean;
}

function resolveTelegramApiUrlForDiagnostics(): string | null {
  const e = env();
  if (e.TELEGRAM_API_URL) return e.TELEGRAM_API_URL;
  const flag = e.E2E_TELEGRAM_MOCK_ENABLED;
  const mockEnabled = flag === "1" || flag === "true";
  if (mockEnabled && e.VERCEL_URL) {
    return `https://${e.VERCEL_URL}/api/test/telegram-mock/bot`;
  }
  return null;
}

async function insertTelegramLinkIfMissing(params: {
  installationId: string;
  telegramUserId: string;
  vm0UserId: string;
}): Promise<string | null> {
  const [existing] = await globalThis.services.db
    .select({ id: telegramUserLinks.id })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, params.installationId),
        eq(telegramUserLinks.telegramUserId, params.telegramUserId),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [row] = await globalThis.services.db
    .insert(telegramUserLinks)
    .values({
      installationId: params.installationId,
      telegramUserId: params.telegramUserId,
      vm0UserId: params.vm0UserId,
    })
    .onConflictDoNothing()
    .returning({ id: telegramUserLinks.id });
  return row?.id ?? null;
}

async function loadInstallation(botId: string) {
  const db = globalThis.services.db;
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

async function loadLinks(botId: string) {
  return globalThis.services.db
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

async function loadRecentRuns(orgId: string | undefined) {
  if (!orgId) return [];
  return globalThis.services.db
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

async function loadOrgMeta(orgId: string | undefined) {
  if (!orgId) return null;
  const [row] = await globalThis.services.db
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

async function loadDefaultAgent(defaultComposeId: string | undefined) {
  if (!defaultComposeId) return null;
  const [row] = await globalThis.services.db
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

async function loadCompose(defaultComposeId: string | undefined) {
  if (!defaultComposeId) return null;
  const [row] = await globalThis.services.db
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

async function loadComposeVersion(headVersionId: string | null | undefined) {
  if (!headVersionId) return null;
  const [row] = await globalThis.services.db
    .select({
      id: agentComposeVersions.id,
      content: agentComposeVersions.content,
    })
    .from(agentComposeVersions)
    .where(eq(agentComposeVersions.id, headVersionId))
    .limit(1);
  return row ?? null;
}

async function countMessages(botId: string): Promise<number> {
  const [row] = await globalThis.services.db
    .select({ count: sql<number>`count(*)::int` })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, botId));
  return row?.count ?? 0;
}

async function loadMockCalls() {
  return globalThis.services.db
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

export async function GET(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const botId = url.searchParams.get("bot_id");
  if (!botId) {
    return NextResponse.json(
      { error: "bot_id query param is required" },
      { status: 400 },
    );
  }

  initServices();
  const installation = await loadInstallation(botId);
  const [links, recentRuns, orgMeta, defaultAgent, compose, messageCount] =
    await Promise.all([
      loadLinks(botId),
      loadRecentRuns(installation?.orgId),
      loadOrgMeta(installation?.orgId),
      loadDefaultAgent(installation?.defaultComposeId),
      loadCompose(installation?.defaultComposeId),
      countMessages(botId),
    ]);
  const [composeVersion, mockCalls] = await Promise.all([
    loadComposeVersion(compose?.headVersionId),
    loadMockCalls(),
  ]);

  return NextResponse.json({
    installation,
    links,
    message_count: messageCount,
    recent_runs: recentRuns,
    org_metadata: orgMeta,
    default_agent: defaultAgent,
    default_compose: compose,
    default_compose_version: composeVersion && {
      id: composeVersion.id,
      content_keys: Object.keys(
        (composeVersion.content ?? {}) as Record<string, unknown>,
      ),
    },
    resolved_telegram_api_url: resolveTelegramApiUrlForDiagnostics(),
    mock_calls: mockCalls,
  });
}

export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const raw = (await request.json().catch(() => {
    return null;
  })) as SeedBody | null;
  if (!raw?.bot_id || !raw.telegram_user_id) {
    return NextResponse.json(
      { error: "bot_id and telegram_user_id are required" },
      { status: 400 },
    );
  }

  initServices();
  const services = globalThis.services;
  const userId = await resolveTestUserId(raw.email ?? DEFAULT_TEST_EMAIL);
  const orgId = await resolveTestOrgId(userId);
  const defaultAgent = await seedDefaultAgent(services, {
    orgId,
    userId,
    name: "e2e-slack-agent",
  });

  const encryptedBotToken = encryptSecretValue(
    TELEGRAM_E2E_FIXTURES.botToken,
    services.env.SECRETS_ENCRYPTION_KEY,
  );

  await services.db
    .insert(telegramInstallations)
    .values({
      telegramBotId: raw.bot_id,
      botUsername: raw.bot_username ?? TELEGRAM_E2E_FIXTURES.botUsername,
      encryptedBotToken,
      webhookSecret: raw.webhook_secret ?? TELEGRAM_E2E_FIXTURES.webhookSecret,
      defaultComposeId: defaultAgent.composeId,
      ownerUserId: userId,
      orgId,
    })
    .onConflictDoUpdate({
      target: telegramInstallations.telegramBotId,
      set: {
        botUsername: raw.bot_username ?? TELEGRAM_E2E_FIXTURES.botUsername,
        encryptedBotToken,
        webhookSecret:
          raw.webhook_secret ?? TELEGRAM_E2E_FIXTURES.webhookSecret,
        defaultComposeId: defaultAgent.composeId,
        ownerUserId: userId,
        orgId,
        updatedAt: new Date(),
      },
    });

  let linkId: string | null = null;
  if (raw.seed_link !== false) {
    linkId = await insertTelegramLinkIfMissing({
      installationId: raw.bot_id,
      telegramUserId: raw.telegram_user_id,
      vm0UserId: userId,
    });
  }

  return NextResponse.json({
    ok: true,
    bot_id: raw.bot_id,
    org_id: orgId,
    vm0_user_id: userId,
    user_link_id: linkId,
    default_agent_id: defaultAgent.composeId,
  });
}

export async function DELETE(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const botId = url.searchParams.get("bot_id");
  if (!botId) {
    return NextResponse.json(
      { error: "bot_id query param is required" },
      { status: 400 },
    );
  }

  initServices();
  const db = globalThis.services.db;
  const [existing] = await db
    .select({ orgId: telegramInstallations.orgId })
    .from(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId))
    .limit(1);

  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, botId));
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, botId));
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, botId));

  if (existing?.orgId) {
    const telegramAgentRuns = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .where(
        and(
          eq(agentRuns.orgId, existing.orgId),
          eq(zeroRuns.triggerSource, "telegram"),
        ),
      );
    const ids = telegramAgentRuns.map((run) => {
      return run.id;
    });
    if (ids.length > 0) {
      await db.delete(zeroRuns).where(inArray(zeroRuns.id, ids));
      await db.delete(agentRuns).where(inArray(agentRuns.id, ids));
    }
  }

  return NextResponse.json({ ok: true });
}
