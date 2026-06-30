import { createHash } from "node:crypto";
import type { createClerkClient } from "@clerk/backend";
import { command, computed } from "ccstate";
import {
  testSlackStateContract,
  type TestSlackStatePostBody,
} from "@vm0/api-contracts/contracts/test-slack-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { e2eSlackMockCallLog } from "@vm0/db/schema/e2e-slack-mock-call-log";
import { orgCache } from "@vm0/db/schema/org-cache";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { secrets } from "@vm0/db/schema/secret";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { storageVersions, storages } from "@vm0/db/schema/storage";
import { variables } from "@vm0/db/schema/variable";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { encryptPersistentSecretValue } from "../services/crypto.utils";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const DEFAULT_WORKSPACE_NAME = "E2E Test Workspace";
const DEFAULT_AGENT_NAME = "e2e-slack-agent";
const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";
const SLACK_BOT_SCOPES = JSON.stringify([
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
  "im:history",
  "im:write",
  "commands",
  "users:read",
  "users:read.email",
  "reactions:write",
  "files:read",
  "files:write",
]);
const ZERO_AGENT_ID_TEMPLATE = ["$", "{{ vars.ZERO_AGENT_ID }}"].join("");
const ZERO_TOKEN_TEMPLATE = ["$", "{{ secrets.ZERO_TOKEN }}"].join("");
const SLACK_E2E_FIXTURES = {
  botUserId: "U_E2E_BOT",
  botToken: "xoxb-e2e-test-bot-token",
} as const;

type ClerkClient = ReturnType<typeof createClerkClient>;
type StarterGrantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function isoString(value: Date): string {
  return value.toISOString();
}

function contentKeys(value: unknown): string[] {
  if (value && typeof value === "object") {
    return Object.keys(value);
  }
  return [];
}

function resolvedSlackApiUrl(): string | null {
  const slackApiUrl = optionalEnv("SLACK_API_URL");
  if (slackApiUrl) {
    return slackApiUrl;
  }

  const flag = optionalEnv("E2E_SLACK_MOCK_ENABLED");
  const mockEnabled = flag === "1" || flag === "true";
  const vercelUrl = optionalEnv("VERCEL_URL");
  if (mockEnabled && vercelUrl) {
    return `https://${vercelUrl}/api/test/slack-mock/`;
  }

  return null;
}

async function resolveTestUserId(
  clerk: ClerkClient,
  email: string = DEFAULT_TEST_EMAIL,
): Promise<string> {
  const { data: users } = await clerk.users.getUserList({
    emailAddress: [email],
  });
  const userId = users[0]?.id;
  if (!userId) {
    throw new Error(`Test user not found for email: ${email}`);
  }
  return userId;
}

async function resolveTestOrgId(
  clerk: ClerkClient,
  userId: string,
): Promise<string> {
  const memberships = await clerk.users.getOrganizationMembershipList({
    userId,
  });
  const sorted = [...memberships.data].sort((a, b) => {
    return a.createdAt - b.createdAt;
  });
  const orgId = sorted[0]?.organization.id;
  if (!orgId) {
    throw new Error(`Test user ${userId} has no organization membership`);
  }
  return orgId;
}

interface UpsertSlackInstallationInput {
  readonly slackWorkspaceId: string;
  readonly slackWorkspaceName?: string;
  readonly orgId: string | null;
  readonly botUserId: string;
  readonly botToken: string;
  readonly botScopes?: string | null;
  readonly installedByUserId?: string;
}

async function upsertSlackInstallation(
  db: Db,
  input: UpsertSlackInstallationInput,
): Promise<typeof slackOrgInstallations.$inferSelect> {
  const encryptedBotToken = await encryptPersistentSecretValue(
    input.botToken,
    input.orgId && input.installedByUserId
      ? { orgId: input.orgId, userId: input.installedByUserId }
      : {},
  );
  const [row] = await db
    .insert(slackOrgInstallations)
    .values({
      slackWorkspaceId: input.slackWorkspaceId,
      slackWorkspaceName: input.slackWorkspaceName,
      orgId: input.orgId,
      encryptedBotToken,
      botUserId: input.botUserId,
      botScopes: input.botScopes ?? null,
      installedByUserId: input.installedByUserId,
    })
    .onConflictDoUpdate({
      target: slackOrgInstallations.slackWorkspaceId,
      set: {
        slackWorkspaceName: input.slackWorkspaceName,
        orgId: input.orgId,
        encryptedBotToken,
        botUserId: input.botUserId,
        botScopes: input.botScopes ?? null,
        installedByUserId: input.installedByUserId,
        updatedAt: nowDate(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert Slack installation");
  }
  return row;
}

interface UpsertSlackConnectionInput {
  readonly slackUserId: string;
  readonly slackWorkspaceId: string;
  readonly vm0UserId: string;
}

async function insertSlackConnectionIfMissing(
  db: Db,
  input: UpsertSlackConnectionInput,
): Promise<string | undefined> {
  const [row] = await db
    .insert(slackOrgConnections)
    .values({
      slackUserId: input.slackUserId,
      slackWorkspaceId: input.slackWorkspaceId,
      vm0UserId: input.vm0UserId,
    })
    .onConflictDoNothing()
    .returning({ id: slackOrgConnections.id });
  return row?.id;
}

interface SeedDefaultAgentInput {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
  readonly displayName?: string | null;
}

async function seedDefaultAgent(
  db: Db,
  input: SeedDefaultAgentInput,
): Promise<{ composeId: string; versionId: string; agentId: string }> {
  const compose = await getOrInsertCompose(db, input);
  const composeId = compose.id;
  const versionId = await ensureComposeVersion(
    db,
    composeId,
    input.userId,
    input.name,
    compose.headVersionId,
  );

  await db
    .insert(zeroAgents)
    .values({
      id: composeId,
      orgId: input.orgId,
      owner: input.userId,
      name: input.name,
      displayName: input.displayName ?? null,
    })
    .onConflictDoUpdate({
      target: zeroAgents.id,
      set: {
        orgId: input.orgId,
        owner: input.userId,
        name: input.name,
        displayName: input.displayName ?? null,
        updatedAt: nowDate(),
      },
    });

  await db.transaction(async (tx) => {
    await ensureStarterCreditGrant(tx, input.orgId);
    await tx
      .insert(orgMetadata)
      .values({ orgId: input.orgId, defaultAgentId: composeId })
      .onConflictDoUpdate({
        target: orgMetadata.orgId,
        set: { defaultAgentId: composeId, updatedAt: nowDate() },
      });
  });

  await seedVm0ManagedKeys(db, composeId);

  return { composeId, versionId, agentId: composeId };
}

async function seedVm0ManagedKeys(db: Db, composeId: string): Promise<void> {
  await db.delete(vm0ApiKeys).where(eq(vm0ApiKeys.label, composeId));
  await db.insert(vm0ApiKeys).values(vm0ManagedKeyRows(composeId));
}

function vm0ManagedKeyRows(composeId: string) {
  return [
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
  ];
}

async function deleteVm0ManagedKeysForSeededDefaultAgent(
  db: Db,
  orgId: string,
): Promise<void> {
  const [compose] = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(
      and(
        eq(agentComposes.orgId, orgId),
        eq(agentComposes.name, DEFAULT_AGENT_NAME),
      ),
    )
    .limit(1);

  if (!compose) {
    return;
  }

  const apiKeys = vm0ManagedKeyRows(compose.id).map((row) => {
    return row.apiKey;
  });
  await db
    .delete(vm0ApiKeys)
    .where(
      and(
        eq(vm0ApiKeys.label, compose.id),
        inArray(vm0ApiKeys.apiKey, apiKeys),
      ),
    );
}

async function getOrInsertCompose(
  db: Db,
  input: SeedDefaultAgentInput,
): Promise<{ id: string; headVersionId: string | null }> {
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

  if (!existing) {
    throw new Error("Failed to resolve agent compose after conflict");
  }
  return existing;
}

async function ensureComposeVersion(
  db: Db,
  composeId: string,
  userId: string,
  name: string,
  headVersionId: string | null,
): Promise<string> {
  if (headVersionId) {
    return headVersionId;
  }

  const content = defaultAgentContent(name);
  const versionId = createHash("sha256")
    .update(JSON.stringify(content) + composeId)
    .digest("hex");
  await db
    .insert(agentComposeVersions)
    .values({
      id: versionId,
      composeId,
      content,
      createdBy: userId,
    })
    .onConflictDoNothing();

  const [updated] = await db
    .update(agentComposes)
    .set({ headVersionId: versionId, updatedAt: nowDate() })
    .where(
      and(eq(agentComposes.id, composeId), isNull(agentComposes.headVersionId)),
    )
    .returning({ headVersionId: agentComposes.headVersionId });
  if (updated?.headVersionId) {
    return updated.headVersionId;
  }

  const [compose] = await db
    .select({ headVersionId: agentComposes.headVersionId })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);
  if (compose?.headVersionId) {
    return compose.headVersionId;
  }

  throw new Error("Failed to resolve agent compose head version");
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

async function setComposeHeadVersion(
  db: Db,
  args: {
    readonly composeId: string;
    readonly userId: string;
    readonly content: unknown;
  },
): Promise<string> {
  const versionId = createHash("sha256")
    .update(JSON.stringify(args.content) + args.composeId)
    .digest("hex");
  await db
    .insert(agentComposeVersions)
    .values({
      id: versionId,
      composeId: args.composeId,
      content: args.content,
      createdBy: args.userId,
    })
    .onConflictDoNothing();
  await db
    .update(agentComposes)
    .set({ headVersionId: versionId, updatedAt: nowDate() })
    .where(eq(agentComposes.id, args.composeId));
  return versionId;
}

async function ensureStarterCreditGrant(
  tx: StarterGrantTx,
  orgId: string,
): Promise<void> {
  const [existing] = await tx
    .select({ orgId: orgMetadata.orgId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
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
  if (inserted.length === 0) {
    return;
  }

  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, tier, created_at, updated_at)
        VALUES (${orgId}, ${STARTER_GRANT_AMOUNT}, 'free', now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${STARTER_GRANT_AMOUNT}, tier = 'free', updated_at = now()`,
  );
}

async function slackInstallation(db: ReadonlyDb, teamId: string) {
  return (
    (
      await db
        .select({
          slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
          slackWorkspaceName: slackOrgInstallations.slackWorkspaceName,
          orgId: slackOrgInstallations.orgId,
          botUserId: slackOrgInstallations.botUserId,
          botScopes: slackOrgInstallations.botScopes,
          installedByUserId: slackOrgInstallations.installedByUserId,
          createdAt: slackOrgInstallations.createdAt,
        })
        .from(slackOrgInstallations)
        .where(eq(slackOrgInstallations.slackWorkspaceId, teamId))
        .limit(1)
    )[0] ?? null
  );
}

function slackConnections(db: ReadonlyDb, teamId: string) {
  return db
    .select({
      id: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
      vm0UserId: slackOrgConnections.vm0UserId,
      dmWelcomeSent: slackOrgConnections.dmWelcomeSent,
      createdAt: slackOrgConnections.createdAt,
    })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, teamId));
}

function recentSlackRuns(db: ReadonlyDb, orgId: string | null | undefined) {
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

async function orgMetaFor(db: ReadonlyDb, orgId: string | null | undefined) {
  if (!orgId) {
    return null;
  }

  return (
    (
      await db
        .select({
          orgId: orgMetadata.orgId,
          defaultAgentId: orgMetadata.defaultAgentId,
          credits: orgMetadata.credits,
          tier: orgMetadata.tier,
        })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1)
    )[0] ?? null
  );
}

async function artifactStorageFor(
  db: ReadonlyDb,
  args: {
    readonly orgId: string | null | undefined;
    readonly userId: string | null | undefined;
  },
) {
  if (!args.orgId || !args.userId) {
    return null;
  }

  return (
    (
      await db
        .select({
          id: storages.id,
          headVersionId: storages.headVersionId,
          s3Prefix: storages.s3Prefix,
          versionId: storageVersions.id,
          versionS3Key: storageVersions.s3Key,
        })
        .from(storages)
        .leftJoin(
          storageVersions,
          eq(storages.headVersionId, storageVersions.id),
        )
        .where(
          and(
            eq(storages.orgId, args.orgId),
            eq(storages.userId, args.userId),
            eq(storages.name, "artifact"),
            eq(storages.type, "artifact"),
          ),
        )
        .limit(1)
    )[0] ?? null
  );
}

async function defaultAgentFor(
  db: ReadonlyDb,
  defaultAgentId: string | null | undefined,
) {
  if (!defaultAgentId) {
    return null;
  }

  return (
    (
      await db
        .select({
          id: zeroAgents.id,
          name: zeroAgents.name,
          orgId: zeroAgents.orgId,
        })
        .from(zeroAgents)
        .where(eq(zeroAgents.id, defaultAgentId))
        .limit(1)
    )[0] ?? null
  );
}

async function defaultComposeFor(
  db: ReadonlyDb,
  defaultAgentId: string | null | undefined,
) {
  if (!defaultAgentId) {
    return null;
  }

  return (
    (
      await db
        .select({
          id: agentComposes.id,
          name: agentComposes.name,
          headVersionId: agentComposes.headVersionId,
        })
        .from(agentComposes)
        .where(eq(agentComposes.id, defaultAgentId))
        .limit(1)
    )[0] ?? null
  );
}

async function defaultComposeVersionFor(
  db: ReadonlyDb,
  headVersionId: string | null | undefined,
) {
  if (!headVersionId) {
    return null;
  }

  return (
    (
      await db
        .select({
          id: agentComposeVersions.id,
          content: agentComposeVersions.content,
        })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, headVersionId))
        .limit(1)
    )[0] ?? null
  );
}

async function upsertOrgCacheForTest(
  db: Db,
  args: {
    readonly orgId: string;
    readonly slug?: string;
    readonly name?: string;
    readonly createdBy?: string;
  },
): Promise<void> {
  if (!args.slug && !args.name) {
    return;
  }
  await db
    .insert(orgCache)
    .values({
      orgId: args.orgId,
      slug: args.slug ?? args.orgId,
      name: args.name ?? "Test Org",
      createdBy: args.createdBy,
      cachedAt: nowDate(),
    })
    .onConflictDoUpdate({
      target: orgCache.orgId,
      set: {
        slug: args.slug ?? args.orgId,
        name: args.name ?? "Test Org",
        createdBy: args.createdBy,
        cachedAt: nowDate(),
      },
    });
}

async function seedUserSecretsForTest(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
  },
): Promise<void> {
  for (const name of args.names) {
    await db
      .insert(secrets)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name,
        encryptedValue: `test-secret-${name}`,
        type: "user",
      })
      .onConflictDoNothing();
  }
}

async function seedUserVariablesForTest(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly variables: Readonly<Record<string, string>>;
  },
): Promise<void> {
  for (const [name, value] of Object.entries(args.variables)) {
    await db
      .insert(variables)
      .values({
        orgId: args.orgId,
        userId: args.userId,
        name,
        value,
        type: "user",
      })
      .onConflictDoUpdate({
        target: [
          variables.orgId,
          variables.userId,
          variables.type,
          variables.name,
        ],
        set: { value, updatedAt: nowDate() },
      });
  }
}

function recentMockCalls(db: ReadonlyDb) {
  return db
    .select({
      method: e2eSlackMockCallLog.method,
      teamId: e2eSlackMockCallLog.teamId,
      channelId: e2eSlackMockCallLog.channelId,
      bodyJson: e2eSlackMockCallLog.bodyJson,
      createdAt: e2eSlackMockCallLog.createdAt,
    })
    .from(e2eSlackMockCallLog)
    .orderBy(desc(e2eSlackMockCallLog.createdAt))
    .limit(50);
}

const getSlackState$ = computed(async (get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testSlackStateContract.get));
  if (!query.team_id && !query.org_id) {
    return {
      status: 400 as const,
      body: { error: "team_id or org_id query param is required" },
    };
  }

  const db = get(db$);
  const teamId = query.team_id ?? "";
  const installationRow = query.team_id
    ? await slackInstallation(db, teamId)
    : null;
  const connections = query.team_id ? await slackConnections(db, teamId) : [];
  const stateOrgId = query.org_id ?? installationRow?.orgId;
  const recentRuns = await recentSlackRuns(db, stateOrgId);
  const artifactStorage = await artifactStorageFor(db, {
    orgId: stateOrgId,
    userId: query.user_id,
  });
  const orgMeta = await orgMetaFor(db, stateOrgId);
  const defaultAgent = await defaultAgentFor(db, orgMeta?.defaultAgentId);
  const compose = await defaultComposeFor(db, orgMeta?.defaultAgentId);
  const composeVersion = await defaultComposeVersionFor(
    db,
    compose?.headVersionId,
  );
  const mockCalls = await recentMockCalls(db);

  return {
    status: 200 as const,
    body: {
      installation: installationRow
        ? {
            ...installationRow,
            createdAt: isoString(installationRow.createdAt),
          }
        : null,
      connections: connections.map((connection) => {
        return {
          ...connection,
          createdAt: isoString(connection.createdAt),
        };
      }),
      recent_runs: recentRuns.map((run) => {
        return {
          ...run,
          createdAt: isoString(run.createdAt),
        };
      }),
      artifact_storage: artifactStorage,
      org_metadata: orgMeta,
      default_agent: defaultAgent,
      default_compose: compose,
      default_compose_version: composeVersion
        ? {
            id: composeVersion.id,
            content_keys: contentKeys(composeVersion.content),
          }
        : null,
      resolved_slack_api_url: resolvedSlackApiUrl(),
      mock_calls: mockCalls.map((call) => {
        return {
          ...call,
          createdAt: isoString(call.createdAt),
        };
      }),
    },
  };
});

const postSlackStateBody$ = bodyResultOf(testSlackStateContract.post);

function postSlackStateValidationError(
  body: TestSlackStatePostBody,
): string | null {
  if (!body.team_id && !body.seed_default_agent && !body.org_id) {
    return "team_id is required unless seeding an org-scoped test fixture";
  }
  if (body.seed_connection && (!body.team_id || !body.slack_user_id)) {
    return "team_id and slack_user_id are required to seed a connection";
  }
  return null;
}

async function resolvePostSlackStateActor(
  clerk: ClerkClient | null,
  body: TestSlackStatePostBody,
): Promise<{ readonly orgId: string; readonly userId: string }> {
  if (body.org_id && !body.vm0_user_id && !body.email) {
    return {
      orgId: body.org_id,
      userId: `user_${body.org_id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    };
  }
  const userId =
    body.vm0_user_id ??
    (await resolveTestUserId(clerk!, body.email ?? DEFAULT_TEST_EMAIL));
  const orgId = body.org_id ?? (await resolveTestOrgId(clerk!, userId));
  return { orgId, userId };
}

async function maybeUpsertSlackInstallationForPost(
  db: Db,
  body: TestSlackStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  if (!shouldUpsertSlackInstallationForPost(body)) {
    return;
  }
  if (body.seed_connection && !hasExplicitSlackInstallationFields(body)) {
    const existing = await slackInstallation(db, body.team_id!);
    if (existing) {
      return;
    }
  }
  await upsertSlackInstallation(db, {
    slackWorkspaceId: body.team_id!,
    slackWorkspaceName: body.workspace_name ?? DEFAULT_WORKSPACE_NAME,
    orgId:
      body.installation_org_id === undefined
        ? actor.orgId
        : body.installation_org_id,
    botUserId: body.bot_user_id ?? SLACK_E2E_FIXTURES.botUserId,
    botToken: body.bot_token ?? SLACK_E2E_FIXTURES.botToken,
    botScopes:
      body.bot_scopes === undefined ? SLACK_BOT_SCOPES : body.bot_scopes,
    installedByUserId: actor.userId,
  });
}

function hasExplicitSlackInstallationFields(body: TestSlackStatePostBody) {
  return (
    body.workspace_name !== undefined ||
    body.bot_user_id !== undefined ||
    body.bot_scopes !== undefined ||
    body.bot_token !== undefined ||
    body.installation_org_id !== undefined
  );
}

function shouldUpsertSlackInstallationForPost(
  body: TestSlackStatePostBody,
): boolean {
  if (!body.team_id) {
    return false;
  }

  if (body.seed_connection || !body.delete_connection) {
    return true;
  }

  return hasExplicitSlackInstallationFields(body);
}

async function maybeDeleteSlackConnectionForPost(
  db: Db,
  body: TestSlackStatePostBody,
): Promise<void> {
  if (!body.delete_connection || !body.team_id) {
    return;
  }
  if (body.vm0_user_id) {
    await db
      .delete(slackOrgConnections)
      .where(
        and(
          eq(slackOrgConnections.slackWorkspaceId, body.team_id),
          eq(slackOrgConnections.vm0UserId, body.vm0_user_id),
        ),
      );
    return;
  }
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, body.team_id));
}

async function maybeSeedSlackConnectionForPost(
  db: Db,
  body: TestSlackStatePostBody,
  userId: string,
): Promise<string | undefined> {
  if (!body.seed_connection) {
    return undefined;
  }
  return await insertSlackConnectionIfMissing(db, {
    slackUserId: body.slack_user_id!,
    slackWorkspaceId: body.team_id!,
    vm0UserId: userId,
  });
}

async function maybeSeedDefaultAgentForPost(
  db: Db,
  body: TestSlackStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<{ readonly composeId: string } | undefined> {
  if (!body.seed_default_agent) {
    return undefined;
  }
  const defaultAgent = await seedDefaultAgent(db, {
    orgId: actor.orgId,
    userId: actor.userId,
    name: body.default_agent_name ?? DEFAULT_AGENT_NAME,
    displayName: body.default_agent_display_name,
  });
  if (body.compose_content !== undefined) {
    await setComposeHeadVersion(db, {
      composeId: defaultAgent.composeId,
      userId: actor.userId,
      content: body.compose_content,
    });
  }
  return defaultAgent;
}

async function seedPostSlackUserData(
  db: Db,
  body: TestSlackStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  if (body.seed_secret_names) {
    await seedUserSecretsForTest(db, {
      orgId: actor.orgId,
      userId: actor.userId,
      names: body.seed_secret_names,
    });
  }
  if (body.seed_variables) {
    await seedUserVariablesForTest(db, {
      orgId: actor.orgId,
      userId: actor.userId,
      variables: body.seed_variables,
    });
  }
}

const postSlackState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(postSlackStateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const validationError = postSlackStateValidationError(body);
  if (validationError) {
    return {
      status: 400 as const,
      body: { error: validationError },
    };
  }

  const clerk = body.vm0_user_id && body.org_id ? null : get(clerk$);
  const actor = await resolvePostSlackStateActor(clerk, body);
  signal.throwIfAborted();

  const db = set(writeDb$);
  await upsertOrgCacheForTest(db, {
    orgId: actor.orgId,
    slug: body.org_slug,
    name: body.org_name,
    createdBy: actor.userId,
  });
  signal.throwIfAborted();

  await maybeUpsertSlackInstallationForPost(db, body, actor);
  signal.throwIfAborted();
  await maybeDeleteSlackConnectionForPost(db, body);
  signal.throwIfAborted();
  const connectionId = await maybeSeedSlackConnectionForPost(
    db,
    body,
    actor.userId,
  );
  signal.throwIfAborted();
  const defaultAgent = await maybeSeedDefaultAgentForPost(db, body, actor);
  signal.throwIfAborted();
  await seedPostSlackUserData(db, body, actor);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      team_id: body.team_id ?? "",
      org_id: actor.orgId,
      vm0_user_id: actor.userId,
      connection_id: connectionId ?? null,
      default_agent_id: defaultAgent?.composeId ?? null,
    },
  };
});

interface SlackStateDeleteQuery {
  readonly team_id?: string;
  readonly org_id?: string;
}

interface SlackInstallationDeleteRow {
  readonly slackWorkspaceId: string;
  readonly orgId: string | null;
}

async function slackInstallationRowsForDelete(
  db: Db,
  query: SlackStateDeleteQuery,
): Promise<readonly SlackInstallationDeleteRow[]> {
  if (query.team_id) {
    return await db
      .select({
        slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
        orgId: slackOrgInstallations.orgId,
      })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.slackWorkspaceId, query.team_id));
  }
  if (query.org_id) {
    return await db
      .select({
        slackWorkspaceId: slackOrgInstallations.slackWorkspaceId,
        orgId: slackOrgInstallations.orgId,
      })
      .from(slackOrgInstallations)
      .where(eq(slackOrgInstallations.orgId, query.org_id));
  }
  return [];
}

function orgIdsForSlackStateDelete(
  rows: readonly SlackInstallationDeleteRow[],
  orgId: string | undefined,
): Set<string> {
  const orgIds = new Set(
    rows.flatMap((row) => {
      return row.orgId ? [row.orgId] : [];
    }),
  );
  if (orgId) {
    orgIds.add(orgId);
  }
  return orgIds;
}

function teamIdsForSlackStateDelete(
  rows: readonly SlackInstallationDeleteRow[],
  teamId: string | undefined,
): string[] {
  const teamIds = rows.map((row) => {
    return row.slackWorkspaceId;
  });
  if (teamId && !teamIds.includes(teamId)) {
    teamIds.push(teamId);
  }
  return teamIds;
}

async function deleteSlackTeamsForState(
  db: Db,
  teamIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (teamIds.length === 0) {
    return;
  }
  await db
    .delete(slackOrgConnections)
    .where(inArray(slackOrgConnections.slackWorkspaceId, teamIds));
  signal.throwIfAborted();

  await db
    .delete(slackOrgInstallations)
    .where(inArray(slackOrgInstallations.slackWorkspaceId, teamIds));
  signal.throwIfAborted();
}

async function deleteSlackRunsForOrg(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const slackAgentRuns = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(eq(agentRuns.orgId, orgId), eq(zeroRuns.triggerSource, "slack")),
    );
  signal.throwIfAborted();

  const runIds = slackAgentRuns.map((run) => {
    return run.id;
  });
  if (runIds.length === 0) {
    return;
  }
  await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
  signal.throwIfAborted();
  await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
  signal.throwIfAborted();
}

async function deleteSlackComposesForOrg(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const composeRows = await db
    .select({ id: agentComposes.id })
    .from(agentComposes)
    .where(eq(agentComposes.orgId, orgId));
  signal.throwIfAborted();
  const composeIds = composeRows.map((row) => {
    return row.id;
  });
  if (composeIds.length === 0) {
    return;
  }
  await db.delete(zeroAgents).where(inArray(zeroAgents.id, composeIds));
  signal.throwIfAborted();
  await db
    .delete(agentComposeVersions)
    .where(inArray(agentComposeVersions.composeId, composeIds));
  signal.throwIfAborted();
  await db.delete(agentComposes).where(inArray(agentComposes.id, composeIds));
  signal.throwIfAborted();
}

async function deleteSlackStoragesForOrg(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const storageRows = await db
    .select({ id: storages.id })
    .from(storages)
    .where(eq(storages.orgId, orgId));
  signal.throwIfAborted();
  const storageIds = storageRows.map((storage) => {
    return storage.id;
  });
  if (storageIds.length === 0) {
    return;
  }
  await db
    .update(storages)
    .set({ headVersionId: null })
    .where(inArray(storages.id, storageIds));
  signal.throwIfAborted();
  await db
    .delete(storageVersions)
    .where(inArray(storageVersions.storageId, storageIds));
  signal.throwIfAborted();
  await db.delete(storages).where(inArray(storages.id, storageIds));
  signal.throwIfAborted();
}

async function deleteSlackOrgState(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(secrets).where(eq(secrets.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(variables).where(eq(variables.orgId, orgId));
  signal.throwIfAborted();
  await db.delete(orgCache).where(eq(orgCache.orgId, orgId));
  signal.throwIfAborted();
  await deleteSlackComposesForOrg(db, orgId, signal);
  await deleteSlackStoragesForOrg(db, orgId, signal);
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
}

const deleteSlackState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testSlackStateContract.delete));
  if (!query.team_id && !query.org_id) {
    return {
      status: 400 as const,
      body: { error: "team_id or org_id query param is required" },
    };
  }

  const db = set(writeDb$);
  const teamId = query.team_id;
  const orgId = query.org_id;
  const installationRows = await slackInstallationRowsForDelete(db, query);
  signal.throwIfAborted();
  const orgIds = orgIdsForSlackStateDelete(installationRows, orgId);
  for (const seededOrgId of orgIds) {
    await deleteVm0ManagedKeysForSeededDefaultAgent(db, seededOrgId);
    signal.throwIfAborted();
  }

  await deleteSlackTeamsForState(
    db,
    teamIdsForSlackStateDelete(installationRows, teamId),
    signal,
  );

  for (const seededOrgId of orgIds) {
    await deleteSlackRunsForOrg(db, seededOrgId, signal);
  }

  if (orgId) {
    await deleteSlackOrgState(db, orgId, signal);
  }

  return {
    status: 200 as const,
    body: { ok: true as const },
  };
});

export const testSlackStateRoutes: readonly RouteEntry[] = [
  {
    route: testSlackStateContract.get,
    handler: getSlackState$,
  },
  {
    route: testSlackStateContract.post,
    handler: postSlackState$,
  },
  {
    route: testSlackStateContract.delete,
    handler: deleteSlackState$,
  },
];
