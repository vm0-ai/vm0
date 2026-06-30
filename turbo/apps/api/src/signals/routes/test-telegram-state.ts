import { createHash, randomUUID } from "node:crypto";

import { command, computed } from "ccstate";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { testTelegramStateContract } from "@vm0/api-contracts/contracts/test-telegram-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { e2eTelegramMockCallLog } from "@vm0/db/schema/e2e-telegram-mock-call-log";
import { modelProviders } from "@vm0/db/schema/model-provider";
import { orgMembersMetadata } from "@vm0/db/schema/org-members-metadata";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { runnerJobQueue } from "@vm0/db/schema/runner-job-queue";
import { telegramInstallations } from "@vm0/db/schema/telegram-installation";
import { telegramMessages } from "@vm0/db/schema/telegram-message";
import { telegramOfficialUserLinks } from "@vm0/db/schema/telegram-official-user-link";
import { telegramThreadSessions } from "@vm0/db/schema/telegram-thread-session";
import { telegramUserAgentPreferences } from "@vm0/db/schema/telegram-user-agent-preference";
import { telegramUserLinks } from "@vm0/db/schema/telegram-user-link";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import { optionalEnv } from "../../lib/env";
import { clerk$ } from "../external/clerk";
import { request$ } from "../context/hono";
import { bodyResultOf, queryOf } from "../context/request";
import { db$, writeDb$, type Db, type ReadonlyDb } from "../external/db";
import { nowDate } from "../external/time";
import type { RouteEntry } from "../route-entry";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import { settle } from "../utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const testTelegramStateQuery$ = queryOf(testTelegramStateContract.get);
const deleteTestTelegramStateQuery$ = queryOf(testTelegramStateContract.delete);
const actionBody$ = bodyResultOf(testTelegramStateContract.action);
const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const DEFAULT_TEST_AGENT_NAME = "e2e-slack-agent";
const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";
const ZERO_AGENT_ID_TEMPLATE = ["$", "{{ vars.ZERO_AGENT_ID }}"].join("");
const ZERO_TOKEN_TEMPLATE = ["$", "{{ secrets.ZERO_TOKEN }}"].join("");
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
      telegramUsername: telegramUserLinks.telegramUsername,
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

function loadMessages(db: ReadonlyDb, botId: string) {
  return db
    .select({
      id: telegramMessages.id,
      text: telegramMessages.text,
      isBot: telegramMessages.isBot,
      chatId: telegramMessages.chatId,
      messageId: telegramMessages.messageId,
      createdAt: telegramMessages.createdAt,
    })
    .from(telegramMessages)
    .where(eq(telegramMessages.installationId, botId))
    .orderBy(telegramMessages.createdAt);
}

function loadOfficialMessages(db: ReadonlyDb, orgId: string | undefined) {
  if (!orgId) {
    return [];
  }
  return db
    .select({
      id: telegramMessages.id,
      text: telegramMessages.text,
      isBot: telegramMessages.isBot,
      officialOrgId: telegramMessages.officialOrgId,
      officialUserLinkId: telegramMessages.officialUserLinkId,
      createdAt: telegramMessages.createdAt,
    })
    .from(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, orgId))
    .orderBy(telegramMessages.createdAt);
}

function loadThreadSessions(db: ReadonlyDb, botId: string) {
  return db
    .select({
      telegramUserLinkId: telegramThreadSessions.telegramUserLinkId,
      chatId: telegramThreadSessions.chatId,
      rootMessageId: telegramThreadSessions.rootMessageId,
      agentSessionId: telegramThreadSessions.agentSessionId,
    })
    .from(telegramThreadSessions)
    .innerJoin(
      telegramUserLinks,
      eq(telegramUserLinks.id, telegramThreadSessions.telegramUserLinkId),
    )
    .where(eq(telegramUserLinks.installationId, botId));
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

function actionBadRequest(message: string) {
  return { status: 400 as const, body: { error: message } };
}

function actionOk(body: Record<string, unknown> = {}) {
  return { status: 200 as const, body: { ok: true as const, ...body } };
}

function readActionString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  return typeof body[key] === "string" && body[key].length > 0
    ? body[key]
    : null;
}

function readActionOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return typeof body[key] === "string" && body[key].length > 0
    ? body[key]
    : undefined;
}

function readActionNullableString(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (!(key in body)) {
    return undefined;
  }
  return typeof body[key] === "string" ? body[key] : null;
}

function readActionStringArray(
  body: Record<string, unknown>,
  key: string,
): string[] {
  const value = body[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => {
        return typeof item === "string" && item.length > 0;
      })
    : [];
}

function readActionBoolean(
  body: Record<string, unknown>,
  key: string,
  defaultValue: boolean,
): boolean {
  return typeof body[key] === "boolean" ? body[key] : defaultValue;
}

function readActionRecord(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requiredActionStrings(
  body: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const key of keys) {
    const value = readActionString(body, key);
    if (!value) {
      return null;
    }
    values[key] = value;
  }
  return values;
}

async function seedTelegramCompose(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly composeId?: string;
    readonly composeName?: string;
    readonly agentName?: string;
  },
): Promise<string> {
  const composeId = args.composeId ?? randomUUID();
  const composeName = args.composeName ?? `agent-${composeId.slice(0, 8)}`;
  const agentName = args.agentName ?? composeName;

  await db.insert(agentComposes).values({
    id: composeId,
    userId: args.userId,
    orgId: args.orgId,
    name: composeName,
  });
  await db.insert(zeroAgents).values({
    id: composeId,
    orgId: args.orgId,
    owner: args.userId,
    name: agentName,
    displayName: agentName,
  });
  return composeId;
}

async function seedTelegramInstallationForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "owner_user_id",
    "telegram_bot_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, owner_user_id, and telegram_bot_id are required",
    );
  }
  const orgId = required.org_id!;
  const ownerUserId = required.owner_user_id!;
  const telegramBotId = required.telegram_bot_id!;
  const skipCompose = body.skip_compose === true;
  const defaultComposeId = readActionOptionalString(body, "default_compose_id");
  if (skipCompose && !defaultComposeId) {
    return actionBadRequest("default_compose_id is required with skip_compose");
  }
  const composeId = skipCompose
    ? defaultComposeId!
    : await seedTelegramCompose(db, {
        orgId,
        userId:
          readActionOptionalString(body, "compose_user_id") ?? ownerUserId,
        composeId: defaultComposeId,
        composeName: readActionOptionalString(body, "compose_name"),
        agentName: readActionOptionalString(body, "agent_name"),
      });
  signal.throwIfAborted();

  const encryptedBotToken = await encryptPersistentSecretValue(
    readActionOptionalString(body, "bot_token") ?? "test-bot-token",
    { orgId, userId: ownerUserId },
  );
  signal.throwIfAborted();

  await db.insert(telegramInstallations).values({
    telegramBotId,
    botUsername:
      readActionNullableString(body, "bot_username") ?? `bot_${telegramBotId}`,
    encryptedBotToken,
    webhookSecret:
      readActionOptionalString(body, "webhook_secret") ?? `whs_${randomUUID()}`,
    defaultComposeId: composeId,
    ownerUserId,
    orgId,
  });
  signal.throwIfAborted();

  return actionOk({ compose_id: composeId, telegram_bot_id: telegramBotId });
}

async function seedOrgDefaultAgentForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["org_id", "user_id"]);
  if (!required) {
    return actionBadRequest("org_id and user_id are required");
  }
  const orgId = required.org_id!;
  const userId = required.user_id!;
  const composeId = await seedTelegramCompose(db, {
    orgId,
    userId,
    composeName: readActionOptionalString(body, "compose_name"),
    agentName: readActionOptionalString(body, "agent_name"),
  });
  signal.throwIfAborted();

  await db
    .insert(orgMetadata)
    .values({
      orgId,
      defaultAgentId: composeId,
      tier: "free",
      credits: 10_000,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: { defaultAgentId: composeId, tier: "free", credits: 10_000 },
    });
  signal.throwIfAborted();

  return actionOk({ compose_id: composeId });
}

async function seedOfficialUserLinkForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "telegram_user_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, user_id, and telegram_user_id are required",
    );
  }
  const [row] = await db
    .insert(telegramOfficialUserLinks)
    .values({
      orgId: required.org_id!,
      vm0UserId: required.user_id!,
      telegramUserId: required.telegram_user_id!,
      telegramUsername: readActionNullableString(body, "telegram_username"),
      telegramDisplayName: readActionNullableString(
        body,
        "telegram_display_name",
      ),
    })
    .returning({ id: telegramOfficialUserLinks.id });
  signal.throwIfAborted();
  return actionOk({ user_link_id: row?.id ?? null });
}

async function seedUserLinkForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "installation_id",
    "telegram_user_id",
    "vm0_user_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "installation_id, telegram_user_id, and vm0_user_id are required",
    );
  }
  const [row] = await db
    .insert(telegramUserLinks)
    .values({
      installationId: required.installation_id!,
      telegramUserId: required.telegram_user_id!,
      vm0UserId: required.vm0_user_id!,
      telegramUsername: readActionNullableString(body, "telegram_username"),
      telegramDisplayName: readActionNullableString(
        body,
        "telegram_display_name",
      ),
    })
    .returning({ id: telegramUserLinks.id });
  signal.throwIfAborted();
  return actionOk({ user_link_id: row?.id ?? null });
}

async function seedUserAgentPreferenceForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "compose_id",
  ]);
  if (!required) {
    return actionBadRequest("org_id, user_id, and compose_id are required");
  }
  await db
    .insert(telegramUserAgentPreferences)
    .values({
      orgId: required.org_id!,
      vm0UserId: required.user_id!,
      selectedComposeId: required.compose_id!,
    })
    .onConflictDoUpdate({
      target: [
        telegramUserAgentPreferences.vm0UserId,
        telegramUserAgentPreferences.orgId,
      ],
      set: { selectedComposeId: required.compose_id! },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function seedAgentRunCallbackForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const encryptedSecret = await encryptPersistentSecretValue(
    readActionOptionalString(body, "secret") ?? "test-callback-secret",
    {},
  );
  signal.throwIfAborted();
  const [row] = await db
    .insert(agentRunCallbacks)
    .values({
      runId,
      url: readActionNullableString(body, "url") ?? null,
      internalKind: readActionNullableString(body, "internal_kind") ?? null,
      encryptedSecret,
      payload: readActionRecord(body, "payload"),
      status:
        readActionOptionalString(body, "status") === "delivered" ||
        readActionOptionalString(body, "status") === "failed"
          ? readActionOptionalString(body, "status")
          : "pending",
    })
    .returning({ id: agentRunCallbacks.id });
  signal.throwIfAborted();
  return actionOk({ callback_id: row?.id ?? null });
}

async function updateRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  await db
    .update(zeroRuns)
    .set({ selectedModel: readActionNullableString(body, "selected_model") })
    .where(eq(zeroRuns.id, runId));
  signal.throwIfAborted();
  return actionOk();
}

async function getRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const [run] = await db
    .select({
      sessionId: agentRuns.sessionId,
      selectedModel: zeroRuns.selectedModel,
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    run: run
      ? { session_id: run.sessionId, selected_model: run.selectedModel }
      : null,
  });
}

async function seedThreadSessionForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const chatId = readActionString(body, "chat_id");
  const rootMessageId = readActionString(body, "root_message_id");
  const userLinkId = readActionOptionalString(body, "user_link_id");
  const officialUserLinkId = readActionOptionalString(
    body,
    "official_user_link_id",
  );
  if (!chatId || !rootMessageId || (!userLinkId && !officialUserLinkId)) {
    return actionBadRequest(
      "chat_id, root_message_id, and one link id are required",
    );
  }

  let agentSessionId = readActionOptionalString(body, "agent_session_id");
  if (!agentSessionId) {
    const required = requiredActionStrings(body, [
      "org_id",
      "user_id",
      "compose_id",
    ]);
    if (!required) {
      return actionBadRequest(
        "org_id, user_id, and compose_id are required when agent_session_id is omitted",
      );
    }
    const sessionId = await insertAgentSessionForAction(
      db,
      {
        orgId: required.org_id!,
        userId: required.user_id!,
        composeId: required.compose_id!,
      },
      signal,
    );
    if (!sessionId) {
      return actionBadRequest("failed to create agent session");
    }
    agentSessionId = sessionId;
  }

  await db.insert(telegramThreadSessions).values({
    telegramUserLinkId: userLinkId,
    telegramOfficialUserLinkId: officialUserLinkId,
    chatId,
    rootMessageId,
    agentSessionId,
  });
  signal.throwIfAborted();
  return actionOk({ agent_session_id: agentSessionId });
}

async function findThreadSessionForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "user_link_id",
    "chat_id",
    "root_message_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "user_link_id, chat_id, and root_message_id are required",
    );
  }
  const [row] = await db
    .select({ agentSessionId: telegramThreadSessions.agentSessionId })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramUserLinkId, required.user_link_id!),
        eq(telegramThreadSessions.chatId, required.chat_id!),
        eq(telegramThreadSessions.rootMessageId, required.root_message_id!),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({
    thread_session: row ? { agent_session_id: row.agentSessionId } : null,
  });
}

async function deleteTelegramFixtureForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readActionString(body, "org_id");
  const composeIds = readActionStringArray(body, "compose_ids");
  const telegramBotIds = readActionStringArray(body, "telegram_bot_ids");

  if (telegramBotIds.length > 0) {
    const linkRows = await db
      .select({ id: telegramUserLinks.id })
      .from(telegramUserLinks)
      .where(inArray(telegramUserLinks.installationId, telegramBotIds));
    signal.throwIfAborted();
    const linkIds = linkRows.map((row) => {
      return row.id;
    });
    if (linkIds.length > 0) {
      await db
        .delete(telegramThreadSessions)
        .where(inArray(telegramThreadSessions.telegramUserLinkId, linkIds));
      signal.throwIfAborted();
    }
    await db
      .delete(telegramMessages)
      .where(inArray(telegramMessages.installationId, telegramBotIds));
    signal.throwIfAborted();
    await db
      .delete(telegramUserLinks)
      .where(inArray(telegramUserLinks.installationId, telegramBotIds));
    signal.throwIfAborted();
    await db
      .delete(telegramInstallations)
      .where(inArray(telegramInstallations.telegramBotId, telegramBotIds));
    signal.throwIfAborted();
  }

  if (orgId) {
    await db
      .delete(telegramMessages)
      .where(eq(telegramMessages.officialOrgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(telegramOfficialUserLinks)
      .where(eq(telegramOfficialUserLinks.orgId, orgId));
    signal.throwIfAborted();
    await db
      .delete(telegramUserAgentPreferences)
      .where(eq(telegramUserAgentPreferences.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(modelProviders).where(eq(modelProviders.orgId, orgId));
    signal.throwIfAborted();
    await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
    signal.throwIfAborted();
  }

  if (composeIds.length > 0) {
    await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
    signal.throwIfAborted();
    await db.delete(agentComposes).where(inArray(agentComposes.id, composeIds));
    signal.throwIfAborted();
  }

  return actionOk();
}

async function seedTelegramPostFixtureForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId =
    readActionOptionalString(body, "org_id") ??
    `org_${randomUUID().slice(0, 8)}`;
  const userId =
    readActionOptionalString(body, "user_id") ??
    `user_${randomUUID().slice(0, 8)}`;
  const composeId = randomUUID();
  const versionId = randomUUID();
  const telegramBotId =
    readActionOptionalString(body, "telegram_bot_id") ??
    String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000);
  const webhookSecret = `whs_${randomUUID()}`;
  const name = `telegram-agent-${composeId.slice(0, 8)}`;

  await db.insert(agentComposes).values({
    id: composeId,
    userId,
    orgId,
    name,
  });
  signal.throwIfAborted();
  await db.insert(agentComposeVersions).values({
    id: versionId,
    composeId,
    content: {
      version: "1.0",
      agents: {
        telegram: {
          framework: "claude-code",
          environment: { ANTHROPIC_API_KEY: "test-key" },
        },
      },
    },
    createdBy: userId,
  });
  signal.throwIfAborted();
  await db
    .update(agentComposes)
    .set({ headVersionId: versionId })
    .where(eq(agentComposes.id, composeId));
  signal.throwIfAborted();
  await db.insert(zeroAgents).values({
    id: composeId,
    orgId,
    owner: userId,
    name,
    displayName: "Telegram Agent",
    visibility: "public",
  });
  signal.throwIfAborted();

  if (readActionBoolean(body, "seed_default_agent", true)) {
    await db
      .insert(orgMetadata)
      .values({
        orgId,
        defaultAgentId: composeId,
        tier: "free",
        credits: 100_000,
      })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: composeId, tier: "free", credits: 100_000 },
      });
    signal.throwIfAborted();
  }

  await db.insert(vm0ApiKeys).values([
    {
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: `vm0-key-anthropic-${composeId}`,
      label: composeId,
    },
    {
      vendor: "deepseek",
      model: "deepseek-v4-pro",
      apiKey: `vm0-key-deepseek-${composeId}`,
      label: composeId,
    },
    {
      vendor: "moonshot",
      model: "kimi-k2.7-code",
      apiKey: `vm0-key-moonshot-${composeId}`,
      label: composeId,
    },
  ]);
  signal.throwIfAborted();

  if (readActionBoolean(body, "install_bot", true)) {
    const encryptedBotToken = await encryptPersistentSecretValue(
      readActionOptionalString(body, "bot_token") ?? "123456:test-bot-token",
      { orgId, userId },
    );
    signal.throwIfAborted();
    await db.insert(telegramInstallations).values({
      telegramBotId,
      botUsername: `bot_${telegramBotId}`,
      encryptedBotToken,
      webhookSecret,
      defaultComposeId: composeId,
      ownerUserId: userId,
      orgId,
    });
    signal.throwIfAborted();
  }

  const telegramUserId = readActionBoolean(body, "link_telegram_user", false)
    ? "99001"
    : undefined;
  if (telegramUserId) {
    await db.insert(telegramUserLinks).values({
      installationId: telegramBotId,
      telegramUserId,
      telegramUsername: "alice",
      telegramDisplayName: "Alice",
      vm0UserId: userId,
    });
    signal.throwIfAborted();
  }

  if (readActionBoolean(body, "seed_official_link", false)) {
    await db.insert(telegramOfficialUserLinks).values({
      orgId,
      vm0UserId: userId,
      telegramUserId: "99002",
      telegramUsername: "bob",
      telegramDisplayName: "Bob",
    });
    signal.throwIfAborted();
  }

  return actionOk({
    fixture: {
      org_id: orgId,
      user_id: userId,
      compose_id: composeId,
      version_id: versionId,
      telegram_bot_id: telegramBotId,
      webhook_secret: webhookSecret,
      telegram_user_id: telegramUserId,
    },
  });
}

async function deleteTelegramPostFixtureForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "compose_id",
    "telegram_bot_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, user_id, compose_id, and telegram_bot_id are required",
    );
  }
  const orgId = required.org_id!;
  const userId = required.user_id!;
  const composeId = required.compose_id!;
  const telegramBotId = required.telegram_bot_id!;

  const runRows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.orgId, orgId), eq(agentRuns.userId, userId)));
  signal.throwIfAborted();
  const runIds = runRows.map((row) => {
    return row.id;
  });
  if (runIds.length > 0) {
    await db
      .delete(runnerJobQueue)
      .where(inArray(runnerJobQueue.runId, runIds));
    signal.throwIfAborted();
    await db
      .delete(agentRunCallbacks)
      .where(inArray(agentRunCallbacks.runId, runIds));
    signal.throwIfAborted();
    await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
    signal.throwIfAborted();
    await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
    signal.throwIfAborted();
  }

  await db
    .delete(agentSessions)
    .where(
      and(eq(agentSessions.orgId, orgId), eq(agentSessions.userId, userId)),
    );
  signal.throwIfAborted();
  await db.delete(orgModelPolicies).where(eq(orgModelPolicies.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, orgId),
        eq(orgMembersMetadata.userId, userId),
      ),
    );
  signal.throwIfAborted();
  await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, composeId));
  signal.throwIfAborted();
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.installationId, telegramBotId));
  signal.throwIfAborted();
  await db
    .delete(telegramMessages)
    .where(eq(telegramMessages.officialOrgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(telegramOfficialUserLinks)
    .where(eq(telegramOfficialUserLinks.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(telegramUserLinks)
    .where(eq(telegramUserLinks.installationId, telegramBotId));
  signal.throwIfAborted();
  await db
    .delete(telegramInstallations)
    .where(eq(telegramInstallations.telegramBotId, telegramBotId));
  signal.throwIfAborted();
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
  await db
    .delete(agentComposeVersions)
    .where(eq(agentComposeVersions.composeId, composeId));
  signal.throwIfAborted();
  await db.delete(zeroAgents).where(eq(zeroAgents.id, composeId));
  signal.throwIfAborted();
  await db.delete(agentComposes).where(eq(agentComposes.id, composeId));
  signal.throwIfAborted();
  return actionOk();
}

async function getTelegramPostRunStateForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["org_id", "user_id"]);
  if (!required) {
    return actionBadRequest("org_id and user_id are required");
  }
  const prompt = readActionOptionalString(body, "prompt");
  const conditions = [
    eq(agentRuns.orgId, required.org_id!),
    eq(agentRuns.userId, required.user_id!),
  ];
  if (prompt) {
    conditions.push(eq(agentRuns.prompt, prompt));
  }
  const [run] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      error: agentRuns.error,
      prompt: agentRuns.prompt,
      appendSystemPrompt: agentRuns.appendSystemPrompt,
      continuedFromSessionId: agentRuns.continuedFromSessionId,
      sessionId: agentRuns.sessionId,
      createdAt: agentRuns.createdAt,
    })
    .from(agentRuns)
    .where(and(...conditions))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  signal.throwIfAborted();

  if (!run) {
    return actionOk({
      run: null,
      zero_run: null,
      callbacks: [],
      job_exists: false,
    });
  }

  const [[zeroRun], callbacks, [job]] = await Promise.all([
    db
      .select({
        id: zeroRuns.id,
        triggerSource: zeroRuns.triggerSource,
        modelProvider: zeroRuns.modelProvider,
        selectedModel: zeroRuns.selectedModel,
      })
      .from(zeroRuns)
      .where(eq(zeroRuns.id, run.id))
      .limit(1),
    db
      .select({
        id: agentRunCallbacks.id,
        url: agentRunCallbacks.url,
        internalKind: agentRunCallbacks.internalKind,
        payload: agentRunCallbacks.payload,
        status: agentRunCallbacks.status,
      })
      .from(agentRunCallbacks)
      .where(eq(agentRunCallbacks.runId, run.id)),
    db
      .select({ runId: runnerJobQueue.runId })
      .from(runnerJobQueue)
      .where(eq(runnerJobQueue.runId, run.id))
      .limit(1),
  ]);
  signal.throwIfAborted();

  return actionOk({
    run,
    zero_run: zeroRun ?? null,
    callbacks,
    job_exists: job !== undefined,
  });
}

async function getTelegramLinkIdForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const kind = readActionString(body, "kind");
  if (kind === "official") {
    const required = requiredActionStrings(body, ["org_id", "user_id"]);
    if (!required) {
      return actionBadRequest("org_id and user_id are required");
    }
    const [link] = await db
      .select({ id: telegramOfficialUserLinks.id })
      .from(telegramOfficialUserLinks)
      .where(
        and(
          eq(telegramOfficialUserLinks.orgId, required.org_id!),
          eq(telegramOfficialUserLinks.vm0UserId, required.user_id!),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return actionOk({ link_id: link?.id ?? null });
  }

  const required = requiredActionStrings(body, ["installation_id", "user_id"]);
  if (!required) {
    return actionBadRequest("installation_id and user_id are required");
  }
  const [link] = await db
    .select({ id: telegramUserLinks.id })
    .from(telegramUserLinks)
    .where(
      and(
        eq(telegramUserLinks.installationId, required.installation_id!),
        eq(telegramUserLinks.vm0UserId, required.user_id!),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ link_id: link?.id ?? null });
}

async function seedAgentSessionForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "compose_id",
  ]);
  if (!required) {
    return actionBadRequest("org_id, user_id, and compose_id are required");
  }
  const sessionId = await insertAgentSessionForAction(
    db,
    {
      orgId: required.org_id!,
      userId: required.user_id!,
      composeId: required.compose_id!,
    },
    signal,
  );
  return actionOk({ agent_session_id: sessionId });
}

async function insertAgentSessionForAction(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly composeId: string;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const [session] = await db
    .insert(agentSessions)
    .values({
      orgId: args.orgId,
      userId: args.userId,
      agentComposeId: args.composeId,
    })
    .returning({ id: agentSessions.id });
  signal.throwIfAborted();
  return session?.id ?? null;
}

async function hasThreadSessionForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "user_link_id",
    "chat_id",
    "root_message_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "user_link_id, chat_id, and root_message_id are required",
    );
  }
  const [thread] = await db
    .select({ id: telegramThreadSessions.id })
    .from(telegramThreadSessions)
    .where(
      and(
        eq(telegramThreadSessions.telegramUserLinkId, required.user_link_id!),
        eq(telegramThreadSessions.chatId, required.chat_id!),
        eq(telegramThreadSessions.rootMessageId, required.root_message_id!),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ exists: thread !== undefined });
}

async function seedRunningRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "version_id",
    "compose_id",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, user_id, version_id, and compose_id are required",
    );
  }
  const sessionId = await insertAgentSessionForAction(
    db,
    {
      orgId: required.org_id!,
      userId: required.user_id!,
      composeId: required.compose_id!,
    },
    signal,
  );
  if (!sessionId) {
    return actionBadRequest("failed to seed agent session");
  }
  const startedAt = nowDate();
  await db.insert(agentRuns).values({
    userId: required.user_id!,
    orgId: required.org_id!,
    agentComposeVersionId: required.version_id!,
    sessionId,
    status: "running",
    prompt: "existing running telegram run",
    startedAt,
    lastHeartbeatAt: startedAt,
  });
  signal.throwIfAborted();
  return actionOk({ agent_session_id: sessionId });
}

async function seedCompletedRunForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "version_id",
    "compose_id",
    "selected_model",
  ]);
  if (!required) {
    return actionBadRequest(
      "org_id, user_id, version_id, compose_id, and selected_model are required",
    );
  }
  const sessionId = await insertAgentSessionForAction(
    db,
    {
      orgId: required.org_id!,
      userId: required.user_id!,
      composeId: required.compose_id!,
    },
    signal,
  );
  if (!sessionId) {
    return actionBadRequest("failed to seed agent session");
  }
  const [run] = await db
    .insert(agentRuns)
    .values({
      userId: required.user_id!,
      orgId: required.org_id!,
      agentComposeVersionId: required.version_id!,
      sessionId,
      status: "completed",
      prompt: "previous telegram session",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      completedAt: new Date("2026-01-01T00:01:00.000Z"),
    })
    .returning({ id: agentRuns.id });
  signal.throwIfAborted();
  if (!run) {
    return actionBadRequest("failed to seed completed run");
  }
  await db.insert(zeroRuns).values({
    id: run.id,
    triggerSource: "telegram",
    modelProvider: readActionNullableString(body, "model_provider") ?? null,
    selectedModel: required.selected_model!,
  });
  signal.throwIfAborted();
  return actionOk({ agent_session_id: sessionId, run_id: run.id });
}

async function seedModelPoliciesForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, [
    "org_id",
    "user_id",
    "compose_id",
  ]);
  if (!required) {
    return actionBadRequest("org_id, user_id, and compose_id are required");
  }
  await db.insert(orgModelPolicies).values([
    {
      orgId: required.org_id!,
      model: "claude-sonnet-4-6",
      isDefault: true,
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: required.user_id!,
      updatedByUserId: required.user_id!,
    },
    {
      orgId: required.org_id!,
      model: "claude-opus-4-7",
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: required.user_id!,
      updatedByUserId: required.user_id!,
    },
    {
      orgId: required.org_id!,
      model: "deepseek-v4-pro",
      defaultProviderType: "vm0",
      credentialScope: "org",
      createdByUserId: required.user_id!,
      updatedByUserId: required.user_id!,
    },
  ]);
  signal.throwIfAborted();
  await db.insert(vm0ApiKeys).values([
    {
      vendor: "anthropic",
      model: "claude-sonnet-4-6",
      apiKey: "vm0-key-claude-sonnet-4-6",
      label: required.compose_id!,
    },
    {
      vendor: "anthropic",
      model: "claude-opus-4-7",
      apiKey: "vm0-key-claude-opus-4-7",
      label: required.compose_id!,
    },
  ]);
  signal.throwIfAborted();
  await db
    .insert(orgMembersMetadata)
    .values({
      orgId: required.org_id!,
      userId: required.user_id!,
      selectedModel: readActionNullableString(body, "selected_model") ?? null,
    })
    .onConflictDoUpdate({
      target: [orgMembersMetadata.orgId, orgMembersMetadata.userId],
      set: {
        selectedModel: readActionNullableString(body, "selected_model") ?? null,
      },
    });
  signal.throwIfAborted();
  return actionOk();
}

async function seedOrgCreditsForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const orgId = readActionString(body, "org_id");
  const credits = typeof body.credits === "number" ? body.credits : null;
  if (!orgId || credits === null) {
    return actionBadRequest("org_id and credits are required");
  }
  await db
    .update(orgMetadata)
    .set({ credits })
    .where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
  return actionOk();
}

async function getSelectedModelForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["org_id", "user_id"]);
  if (!required) {
    return actionBadRequest("org_id and user_id are required");
  }
  const [row] = await db
    .select({ selectedModel: orgMembersMetadata.selectedModel })
    .from(orgMembersMetadata)
    .where(
      and(
        eq(orgMembersMetadata.orgId, required.org_id!),
        eq(orgMembersMetadata.userId, required.user_id!),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return actionOk({ selected_model: row?.selectedModel ?? null });
}

async function seedPendingUserLinkForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const required = requiredActionStrings(body, ["installation_id", "user_id"]);
  if (!required) {
    return actionBadRequest("installation_id and user_id are required");
  }
  await db.insert(telegramUserLinks).values({
    installationId: required.installation_id!,
    telegramUserId: "pending",
    telegramUsername: null,
    telegramDisplayName: null,
    vm0UserId: required.user_id!,
  });
  signal.throwIfAborted();
  return actionOk();
}

async function updateRunCallbackForAction(
  db: Db,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const runId = readActionString(body, "run_id");
  if (!runId) {
    return actionBadRequest("run_id is required");
  }
  const encryptedSecret = await encryptPersistentSecretValue(
    readActionOptionalString(body, "secret") ?? "test-callback-secret",
    {},
  );
  signal.throwIfAborted();
  const [callback] = await db
    .update(agentRunCallbacks)
    .set({
      url: readActionNullableString(body, "url") ?? null,
      internalKind: readActionNullableString(body, "internal_kind") ?? null,
      payload: readActionRecord(body, "payload"),
      encryptedSecret,
    })
    .where(eq(agentRunCallbacks.runId, runId))
    .returning({ callbackId: agentRunCallbacks.id });
  signal.throwIfAborted();
  return actionOk({ callback_id: callback?.callbackId ?? null });
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
    sql`INSERT INTO org_metadata (org_id, credits, tier, created_at, updated_at)
        VALUES (${orgId}, ${STARTER_GRANT_AMOUNT}, 'free', now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${STARTER_GRANT_AMOUNT}, tier = 'free', updated_at = now()`,
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
          ZERO_AGENT_ID: ZERO_AGENT_ID_TEMPLATE,
          ZERO_TOKEN: ZERO_TOKEN_TEMPLATE,
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
  const [
    links,
    recentRuns,
    orgMeta,
    defaultAgent,
    compose,
    messageCount,
    messages,
    officialMessages,
    threadSessions,
  ] = await Promise.all([
    loadLinks(db, query.bot_id),
    loadRecentRuns(db, installation?.orgId),
    loadOrgMeta(db, installation?.orgId),
    loadDefaultAgent(db, installation?.defaultComposeId),
    loadCompose(db, installation?.defaultComposeId),
    countMessages(db, query.bot_id),
    loadMessages(db, query.bot_id),
    loadOfficialMessages(db, installation?.orgId),
    loadThreadSessions(db, query.bot_id),
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
      messages,
      official_messages: officialMessages,
      thread_sessions: threadSessions,
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

const mutateTestTelegramState$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }

    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data as Record<string, unknown>;
    const db = set(writeDb$);

    switch (bodyResult.data.action) {
      case "seed-installation": {
        return await seedTelegramInstallationForAction(db, body, signal);
      }
      case "seed-org-default-agent": {
        return await seedOrgDefaultAgentForAction(db, body, signal);
      }
      case "seed-official-user-link": {
        return await seedOfficialUserLinkForAction(db, body, signal);
      }
      case "seed-user-link": {
        return await seedUserLinkForAction(db, body, signal);
      }
      case "seed-user-agent-preference": {
        return await seedUserAgentPreferenceForAction(db, body, signal);
      }
      case "seed-agent-run-callback": {
        return await seedAgentRunCallbackForAction(db, body, signal);
      }
      case "seed-post-fixture": {
        return await seedTelegramPostFixtureForAction(db, body, signal);
      }
      case "delete-post-fixture": {
        return await deleteTelegramPostFixtureForAction(db, body, signal);
      }
      case "get-post-run-state": {
        return await getTelegramPostRunStateForAction(db, body, signal);
      }
      case "get-telegram-link-id": {
        return await getTelegramLinkIdForAction(db, body, signal);
      }
      case "seed-agent-session": {
        return await seedAgentSessionForAction(db, body, signal);
      }
      case "seed-thread-session": {
        return await seedThreadSessionForAction(db, body, signal);
      }
      case "has-thread-session": {
        return await hasThreadSessionForAction(db, body, signal);
      }
      case "seed-running-run": {
        return await seedRunningRunForAction(db, body, signal);
      }
      case "seed-completed-run": {
        return await seedCompletedRunForAction(db, body, signal);
      }
      case "seed-model-policies": {
        return await seedModelPoliciesForAction(db, body, signal);
      }
      case "seed-org-credits": {
        return await seedOrgCreditsForAction(db, body, signal);
      }
      case "get-selected-model": {
        return await getSelectedModelForAction(db, body, signal);
      }
      case "seed-pending-user-link": {
        return await seedPendingUserLinkForAction(db, body, signal);
      }
      case "update-run-callback": {
        return await updateRunCallbackForAction(db, body, signal);
      }
      case "update-run": {
        return await updateRunForAction(db, body, signal);
      }
      case "get-run": {
        return await getRunForAction(db, body, signal);
      }
      case "find-thread-session": {
        return await findThreadSessionForAction(db, body, signal);
      }
      case "delete-fixture": {
        return await deleteTelegramFixtureForAction(db, body, signal);
      }
    }
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
  {
    route: testTelegramStateContract.action,
    handler: mutateTestTelegramState$,
  },
];
