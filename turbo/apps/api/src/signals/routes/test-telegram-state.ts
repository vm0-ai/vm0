import { createHash } from "node:crypto";

import { command, computed } from "ccstate";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { testTelegramStateContract } from "@vm0/api-contracts/contracts/test-telegram-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { optionalEnv } from "../../lib/env";
import { clerk$ } from "../external/clerk";
import { request$ } from "../context/hono";
import { queryOf } from "../context/request";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { settle } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const testTelegramStateQuery$ = queryOf(testTelegramStateContract.get);
const deleteTestTelegramStateQuery$ = queryOf(testTelegramStateContract.delete);
const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const DEFAULT_TEST_AGENT_NAME = "e2e-slack-agent";
const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";
const TELEGRAM_E2E_FIXTURES = {
  botUsername: "vm0_e2e_bot",
  botToken: "123456:e2e-test-bot-token",
  webhookSecret: "e2e-telegram-webhook-secret",
} as const;

type StarterGrantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface SeedDefaultAgentInput {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

interface ComposeVersionInput {
  readonly composeId: string;
  readonly userId: string;
  readonly name: string;
  readonly headVersionId: string | null;
}

interface DefaultAgentSeed {
  readonly composeId: string;
  readonly versionId: string;
  readonly agentId: string;
}

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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isSeedRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function insertTelegramLinkIfMissing(
  db: Db,
  params: {
    readonly installationId: string;
    readonly telegramUserId: string;
    readonly vm0UserId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const [existing] = await db
    .select({ id: telegramUserLinks.id })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, params.installationId),
        eq(telegramUserLinks.telegramUserId, params.telegramUserId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (existing) {
    return existing.id;
  }

  const [row] = await db
    .insert(telegramUserLinks)
    .values({
      installationId: params.installationId,
      telegramUserId: params.telegramUserId,
      vm0UserId: params.vm0UserId,
    })
    .onConflictDoNothing()
    .returning({ id: telegramUserLinks.id });
  signal.throwIfAborted();
  return row?.id ?? null;
}

async function ensureStarterCreditGrant(
  tx: StarterGrantTx,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const [existing] = await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  signal.throwIfAborted();
  if (existing) {
    return;
  }

  const expiresAt = nowDate();
  expiresAt.setMonth(expiresAt.getMonth() + 1);

  const inserted = await tx
    .insert(creditExpiresRecord)
    .values({
      orgId,
      source: STARTER_GRANT_SOURCE,
      stripeInvoiceId: null,
      amount: STARTER_GRANT_AMOUNT,
      remaining: STARTER_GRANT_AMOUNT,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: creditExpiresRecord.id });
  signal.throwIfAborted();

  if (inserted.length === 0) {
    return;
  }

  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${STARTER_GRANT_AMOUNT}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${STARTER_GRANT_AMOUNT}, updated_at = now()`,
  );
  signal.throwIfAborted();
}

function defaultAgentContent(name: string) {
  return {
    version: "1.0",
    agents: {
      [name]: {
        framework: "claude-code",
        environment: {
          ANTHROPIC_API_KEY: "",
        },
      },
    },
  };
}

async function getOrInsertCompose(
  db: Db,
  input: SeedDefaultAgentInput,
  signal: AbortSignal,
): Promise<{ readonly id: string; readonly headVersionId: string | null }> {
  const [inserted] = await db
    .insert(agentComposes)
    .values({
      userId: input.userId,
      orgId: input.orgId,
      name: input.name,
    })
    .onConflictDoNothing({
      target: [agentComposes.orgId, agentComposes.name],
    })
    .returning({
      id: agentComposes.id,
      headVersionId: agentComposes.headVersionId,
    });
  signal.throwIfAborted();

  if (inserted) {
    return inserted;
  }

  const [existing] = await db
    .select({
      id: agentComposes.id,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, input.orgId),
        eq(agentComposes.name, input.name),
      ),
    )
    .limit(1);
  signal.throwIfAborted();

  if (!existing) {
    throw new Error("Failed to resolve agent compose after conflict");
  }
  return existing;
}

async function ensureComposeVersion(
  db: Db,
  input: ComposeVersionInput,
  signal: AbortSignal,
): Promise<string> {
  if (input.headVersionId) {
    return input.headVersionId;
  }

  const content = defaultAgentContent(input.name);
  const versionId = createHash("sha256")
    .update(JSON.stringify(content) + input.composeId)
    .digest("hex");

  await db
    .insert(agentComposeVersions)
    .values({
      id: versionId,
      composeId: input.composeId,
      content,
      createdBy: input.userId,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();

  const [updated] = await db
    .update(agentComposes)
    .set({ headVersionId: versionId, updatedAt: nowDate() })
    .where(
      and(
        eq(agentComposes.id, input.composeId),
        isNull(agentComposes.headVersionId),
      ),
    )
    .returning({ headVersionId: agentComposes.headVersionId });
  signal.throwIfAborted();
  if (updated?.headVersionId) {
    return updated.headVersionId;
  }

  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, input.composeId))
    .limit(1);
  signal.throwIfAborted();
  if (compose?.headVersionId) {
    return compose.headVersionId;
  }

  throw new Error("Failed to resolve agent compose head version");
}

async function seedDefaultAgent(
  db: Db,
  input: SeedDefaultAgentInput,
  signal: AbortSignal,
): Promise<DefaultAgentSeed> {
  const compose = await getOrInsertCompose(db, input, signal);
  signal.throwIfAborted();
  const composeId = compose.id;
  const versionId = await ensureComposeVersion(
    db,
    {
      composeId,
      userId: input.userId,
      name: input.name,
      headVersionId: compose.headVersionId,
    },
    signal,
  );
  signal.throwIfAborted();

  await db
    .insert(zeroAgents)
    .values({
      id: composeId,
      orgId: input.orgId,
      owner: input.userId,
      name: input.name,
    })
    .onConflictDoNothing();
  signal.throwIfAborted();

  await db.transaction(async (tx) => {
    await ensureStarterCreditGrant(tx, input.orgId, signal);
    signal.throwIfAborted();
    await tx
      .insert(orgMetadata)
      .values({ orgId: input.orgId, defaultAgentId: composeId })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: composeId, updatedAt: nowDate() },
      });
    signal.throwIfAborted();
  });
  signal.throwIfAborted();

  return { composeId, versionId, agentId: composeId };
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

const postTestTelegramState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const settled = await settle(request.json());
    signal.throwIfAborted();
    const rawBody: unknown = settled.ok ? settled.value : null;
    const body = isSeedRecord(rawBody) ? rawBody : {};
    const botId = readString(body.bot_id);
    const telegramUserId = readString(body.telegram_user_id);
    if (!botId || !telegramUserId) {
      return {
        status: 400 as const,
        body: { error: "bot_id and telegram_user_id are required" },
      };
    }

    const email = readOptionalString(body.email) ?? DEFAULT_TEST_EMAIL;
    const client = get(clerk$);
    const { data: users } = await client.users.getUserList({
      emailAddress: [email],
    });
    signal.throwIfAborted();
    const userId = users[0]?.id;
    if (!userId) {
      throw new Error(`Test user not found for email: ${email}`);
    }

    const memberships = await client.users.getOrganizationMembershipList({
      userId,
    });
    signal.throwIfAborted();
    const sortedMemberships = [...memberships.data].sort((a, b) => {
      return a.createdAt - b.createdAt;
    });
    const orgId = sortedMemberships[0]?.organization.id;
    if (!orgId) {
      throw new Error(`Test user ${userId} has no organization membership`);
    }

    const db = set(writeDb$);
    const defaultAgent = await seedDefaultAgent(
      db,
      {
        orgId,
        userId,
        name: DEFAULT_TEST_AGENT_NAME,
      },
      signal,
    );
    signal.throwIfAborted();

    const encryptedBotToken = await encryptPersistentSecretValue(
      TELEGRAM_E2E_FIXTURES.botToken,
      { orgId, userId },
    );
    signal.throwIfAborted();
    await db
      .insert(telegramInstallations)
      .values({
        telegramBotId: botId,
        botUsername:
          readOptionalString(body.bot_username) ??
          TELEGRAM_E2E_FIXTURES.botUsername,
        encryptedBotToken,
        webhookSecret:
          readOptionalString(body.webhook_secret) ??
          TELEGRAM_E2E_FIXTURES.webhookSecret,
        defaultComposeId: defaultAgent.composeId,
        ownerUserId: userId,
        orgId,
      })
      .onConflictDoUpdate({
        target: telegramInstallations.telegramBotId,
        set: {
          botUsername:
            readOptionalString(body.bot_username) ??
            TELEGRAM_E2E_FIXTURES.botUsername,
          encryptedBotToken,
          webhookSecret:
            readOptionalString(body.webhook_secret) ??
            TELEGRAM_E2E_FIXTURES.webhookSecret,
          defaultComposeId: defaultAgent.composeId,
          ownerUserId: userId,
          orgId,
          updatedAt: nowDate(),
        },
      });
    signal.throwIfAborted();

    const linkId =
      body.seed_link === false
        ? null
        : await insertTelegramLinkIfMissing(
            db,
            {
              installationId: botId,
              telegramUserId,
              vm0UserId: userId,
            },
            signal,
          );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        ok: true,
        bot_id: botId,
        org_id: orgId,
        vm0_user_id: userId,
        user_link_id: linkId,
        default_agent_id: defaultAgent.composeId,
      },
    };
  },
);

const deleteTestTelegramState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = get(request$);
    if (!isTestEndpointAllowed(request)) {
      return testEndpointNotFoundResponse();
    }

    const query = get(deleteTestTelegramStateQuery$);
    if (!query.bot_id) {
      return {
        status: 400 as const,
        body: { error: "bot_id query param is required" },
      };
    }

    const botId = query.bot_id;
    const db = set(writeDb$);
    const [existing] = await db
      .select({ orgId: telegramInstallations.orgId })
      .from(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId))
      .limit(1);
    signal.throwIfAborted();

    await db
      .delete(telegramMessages)
      .where(eq(telegramMessages.installationId, botId));
    signal.throwIfAborted();

    await db
      .delete(telegramUserLinks)
      .where(eq(telegramUserLinks.installationId, botId));
    signal.throwIfAborted();

    await db
      .delete(telegramInstallations)
      .where(eq(telegramInstallations.telegramBotId, botId));
    signal.throwIfAborted();

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
      signal.throwIfAborted();

      const ids = telegramAgentRuns.map((run) => {
        return run.id;
      });

      if (ids.length > 0) {
        await db.delete(zeroRuns).where(inArray(zeroRuns.id, ids));
        signal.throwIfAborted();

        await db.delete(agentRuns).where(inArray(agentRuns.id, ids));
        signal.throwIfAborted();
      }
    }

    return { status: 200 as const, body: { ok: true as const } };
  },
);

export const testTelegramStateRoutes: readonly RouteEntry[] = [
  {
    route: testTelegramStateContract.get,
    handler: getTestTelegramState$,
  },
  {
    route: testTelegramStateContract.post,
    handler: postTestTelegramState$,
  },
  {
    route: testTelegramStateContract.delete,
    handler: deleteTestTelegramState$,
  },
];
