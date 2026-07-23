import { createHash } from "node:crypto";
import { command, computed } from "ccstate";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  getProviderRuntimeModel,
  getVm0Vendor,
} from "@vm0/api-contracts/contracts/model-providers";
import {
  testTeamsStateContract,
  type TestTeamsStatePostBody,
} from "@vm0/api-contracts/contracts/test-teams-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { e2eTeamsMockCallLog } from "@vm0/db/schema/e2e-teams-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsUserAgentPreferences } from "@vm0/db/schema/teams-user-agent-preference";
import { vm0ApiKeys } from "@vm0/db/schema/vm0-api-key";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { resolveTestOrgId$, testUserId$ } from "../services/cli-auth.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

const DEFAULT_TEST_EMAIL = "dev+clerk_test+serial@vm0-e2e.ai";
const DEFAULT_TENANT_NAME = "E2E Test Tenant";
const DEFAULT_TEAM_NAME = "E2E Test Team";
const DEFAULT_SERVICE_URL = "https://smba.trafficmanager.net/amer/";
const DEFAULT_BOT_ID = "28:e2e-zero-bot";
const DEFAULT_BOT_NAME = "Zero";
const DEFAULT_AGENT_NAME = "e2e-teams-agent";
const STARTER_GRANT_AMOUNT = 10_000;
const STARTER_GRANT_SOURCE = "starter_grant";
const ZERO_AGENT_ID_TEMPLATE = ["$", "{{ vars.ZERO_AGENT_ID }}"].join("");
const ZERO_TOKEN_TEMPLATE = ["$", "{{ secrets.ZERO_TOKEN }}"].join("");

type StarterGrantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function isoString(value: Date): string {
  return value.toISOString();
}

function nullableIsoString(value: Date | null): string | null {
  return value ? isoString(value) : null;
}

function contentKeys(value: unknown): string[] {
  if (value && typeof value === "object") {
    return Object.keys(value);
  }
  return [];
}

function e2eTeamsMockEnabled(): boolean {
  const flag = optionalEnv("E2E_TEAMS_MOCK_ENABLED");
  return flag === "1" || flag === "true";
}

function resolvedTeamsMockBaseUrl(): string | null {
  const baseUrl = optionalEnv("TEAMS_MOCK_BASE_URL");
  if (baseUrl) {
    return baseUrl.replace(/\/+$/u, "");
  }

  const vercelUrl = optionalEnv("VERCEL_URL");
  if (e2eTeamsMockEnabled() && vercelUrl) {
    return `https://${vercelUrl}/api/test/teams-mock`;
  }

  const apiBackendUrl = optionalEnv("VM0_API_BACKEND_URL");
  if (e2eTeamsMockEnabled() && apiBackendUrl) {
    return `${apiBackendUrl.replace(/\/+$/u, "")}/api/test/teams-mock`;
  }

  return null;
}

interface UpsertTeamsInstallationInput {
  readonly tenantId: string;
  readonly tenantName: string | null;
  readonly teamId: string | null;
  readonly teamName: string | null;
  readonly orgId: string | null;
  readonly installedByUserId: string;
  readonly serviceUrl: string;
  readonly botId: string | null;
  readonly botName: string | null;
}

async function upsertTeamsInstallation(
  db: Db,
  input: UpsertTeamsInstallationInput,
): Promise<typeof teamsOrgInstallations.$inferSelect> {
  const [row] = await db
    .insert(teamsOrgInstallations)
    .values({
      teamsTenantId: input.tenantId,
      teamsTenantName: input.tenantName,
      teamsTeamId: input.teamId,
      teamsTeamName: input.teamName,
      orgId: input.orgId,
      installedByUserId: input.installedByUserId,
      serviceUrl: input.serviceUrl,
      botId: input.botId,
      botName: input.botName,
    })
    .onConflictDoUpdate({
      target: teamsOrgInstallations.teamsTenantId,
      set: {
        teamsTenantName: input.tenantName,
        teamsTeamId: input.teamId,
        teamsTeamName: input.teamName,
        orgId: input.orgId,
        installedByUserId: input.installedByUserId,
        serviceUrl: input.serviceUrl,
        botId: input.botId,
        botName: input.botName,
        updatedAt: nowDate(),
      },
    })
    .returning();

  if (!row) {
    throw new Error("Failed to upsert Teams installation");
  }
  return row;
}

async function findTeamsConnection(
  db: ReadonlyDb,
  args: {
    readonly tenantId: string;
    readonly teamsUserId: string | null | undefined;
    readonly teamsAadObjectId: string | null | undefined;
  },
): Promise<typeof teamsOrgConnections.$inferSelect | undefined> {
  if (args.teamsAadObjectId) {
    const [row] = await db
      .select()
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, args.tenantId),
          eq(teamsOrgConnections.teamsAadObjectId, args.teamsAadObjectId),
        ),
      )
      .limit(1);
    if (row) {
      return row;
    }
  }

  if (!args.teamsUserId) {
    return undefined;
  }
  const [row] = await db
    .select()
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, args.tenantId),
        eq(teamsOrgConnections.teamsUserId, args.teamsUserId),
      ),
    )
    .limit(1);
  return row;
}

async function upsertTeamsConnection(
  db: Db,
  args: {
    readonly tenantId: string;
    readonly teamsUserId: string | null | undefined;
    readonly teamsAadObjectId: string | null | undefined;
    readonly vm0UserId: string;
    readonly displayName: string | null | undefined;
    readonly principalName: string | null | undefined;
  },
): Promise<string> {
  const [inserted] = await db
    .insert(teamsOrgConnections)
    .values({
      teamsTenantId: args.tenantId,
      teamsUserId: args.teamsUserId ?? null,
      teamsAadObjectId: args.teamsAadObjectId ?? null,
      vm0UserId: args.vm0UserId,
      teamsUserDisplayName: args.displayName ?? null,
      teamsUserPrincipalName: args.principalName ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: teamsOrgConnections.id });
  if (inserted) {
    return inserted.id;
  }

  const existing = await findTeamsConnection(db, args);
  if (!existing) {
    throw new Error("Failed to resolve Teams connection after conflict");
  }

  await db
    .update(teamsOrgConnections)
    .set({
      teamsUserId: args.teamsUserId ?? existing.teamsUserId,
      teamsAadObjectId: args.teamsAadObjectId ?? existing.teamsAadObjectId,
      vm0UserId: args.vm0UserId,
      teamsUserDisplayName: args.displayName ?? existing.teamsUserDisplayName,
      teamsUserPrincipalName:
        args.principalName ?? existing.teamsUserPrincipalName,
      updatedAt: nowDate(),
    })
    .where(eq(teamsOrgConnections.id, existing.id));
  return existing.id;
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
      vendor: getVm0Vendor(DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL),
      model: getProviderRuntimeModel(
        "vm0",
        DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
      ),
      apiKey: `vm0-key-default-${composeId}`,
      label: composeId,
    },
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

  await tx
    .insert(orgMetadata)
    .values({
      orgId,
      credits: STARTER_GRANT_AMOUNT,
      tier: "free",
      createdAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: orgMetadata.orgId,
      set: {
        credits: sql`${orgMetadata.credits} + ${STARTER_GRANT_AMOUNT}`,
        tier: "free",
        updatedAt: sql`now()`,
      },
    });
}

async function teamsInstallation(db: ReadonlyDb, tenantId: string) {
  const [installation] = await db
    .select({
      teamsTenantId: teamsOrgInstallations.teamsTenantId,
      teamsTenantName: teamsOrgInstallations.teamsTenantName,
      teamsTeamId: teamsOrgInstallations.teamsTeamId,
      teamsTeamName: teamsOrgInstallations.teamsTeamName,
      teamsAppId: teamsOrgInstallations.teamsAppId,
      botId: teamsOrgInstallations.botId,
      botName: teamsOrgInstallations.botName,
      serviceUrl: teamsOrgInstallations.serviceUrl,
      orgId: teamsOrgInstallations.orgId,
      installedByUserId: teamsOrgInstallations.installedByUserId,
      createdAt: teamsOrgInstallations.createdAt,
    })
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  return installation ?? null;
}

function teamsConnections(db: ReadonlyDb, tenantId: string) {
  return db
    .select({
      id: teamsOrgConnections.id,
      teamsUserId: teamsOrgConnections.teamsUserId,
      teamsAadObjectId: teamsOrgConnections.teamsAadObjectId,
      vm0UserId: teamsOrgConnections.vm0UserId,
      teamsUserDisplayName: teamsOrgConnections.teamsUserDisplayName,
      teamsUserPrincipalName: teamsOrgConnections.teamsUserPrincipalName,
      dmWelcomeSent: teamsOrgConnections.dmWelcomeSent,
      createdAt: teamsOrgConnections.createdAt,
    })
    .from(teamsOrgConnections)
    .where(eq(teamsOrgConnections.teamsTenantId, tenantId));
}

function recentTeamsRuns(db: ReadonlyDb, orgId: string | null | undefined) {
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
      promptPreview: sql`substring(${agentRuns.prompt}, 1, 200)`.mapWith(
        pgTextDecoder,
      ),
    })
    .from(agentRuns)
    .leftJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(eq(agentRuns.orgId, orgId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
}

function recentTeamsCallbacks(
  db: ReadonlyDb,
  orgId: string | null | undefined,
) {
  if (!orgId) {
    return [];
  }
  return db
    .select({
      id: agentRunCallbacks.id,
      runId: agentRunCallbacks.runId,
      status: agentRunCallbacks.status,
      internalKind: agentRunCallbacks.internalKind,
      attempts: agentRunCallbacks.attempts,
      lastError: agentRunCallbacks.lastError,
      createdAt: agentRunCallbacks.createdAt,
      lastAttemptAt: agentRunCallbacks.lastAttemptAt,
      deliveredAt: agentRunCallbacks.deliveredAt,
      payload: agentRunCallbacks.payload,
    })
    .from(agentRunCallbacks)
    .innerJoin(agentRuns, eq(agentRuns.id, agentRunCallbacks.runId))
    .where(
      and(
        eq(agentRuns.orgId, orgId),
        eq(agentRunCallbacks.internalKind, "teams:org"),
      ),
    )
    .orderBy(desc(agentRunCallbacks.createdAt))
    .limit(50);
}

async function orgMetaFor(db: ReadonlyDb, orgId: string | null | undefined) {
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

async function defaultAgentFor(
  db: ReadonlyDb,
  defaultAgentId: string | null | undefined,
) {
  if (!defaultAgentId) {
    return null;
  }
  const [row] = await db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      orgId: zeroAgents.orgId,
    })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, defaultAgentId))
    .limit(1);
  return row ?? null;
}

async function defaultComposeFor(
  db: ReadonlyDb,
  defaultAgentId: string | null | undefined,
) {
  if (!defaultAgentId) {
    return null;
  }
  const [row] = await db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, defaultAgentId))
    .limit(1);
  return row ?? null;
}

async function defaultComposeVersionFor(
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

function recentMockCalls(db: ReadonlyDb, tenantId: string | undefined) {
  const query = db
    .select({
      method: e2eTeamsMockCallLog.method,
      tenantId: e2eTeamsMockCallLog.tenantId,
      conversationId: e2eTeamsMockCallLog.conversationId,
      activityId: e2eTeamsMockCallLog.activityId,
      bodyJson: e2eTeamsMockCallLog.bodyJson,
      createdAt: e2eTeamsMockCallLog.createdAt,
    })
    .from(e2eTeamsMockCallLog)
    .orderBy(desc(e2eTeamsMockCallLog.createdAt))
    .limit(50);
  if (!tenantId) {
    return query;
  }
  return db
    .select({
      method: e2eTeamsMockCallLog.method,
      tenantId: e2eTeamsMockCallLog.tenantId,
      conversationId: e2eTeamsMockCallLog.conversationId,
      activityId: e2eTeamsMockCallLog.activityId,
      bodyJson: e2eTeamsMockCallLog.bodyJson,
      createdAt: e2eTeamsMockCallLog.createdAt,
    })
    .from(e2eTeamsMockCallLog)
    .where(eq(e2eTeamsMockCallLog.tenantId, tenantId))
    .orderBy(desc(e2eTeamsMockCallLog.createdAt))
    .limit(50);
}

const getTeamsState$ = computed(async (get) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testTeamsStateContract.get));
  if (!query.tenant_id && !query.org_id) {
    return {
      status: 400 as const,
      body: { error: "tenant_id or org_id query param is required" },
    };
  }

  const db = get(db$);
  const installationRow = query.tenant_id
    ? await teamsInstallation(db, query.tenant_id)
    : null;
  const connections = query.tenant_id
    ? await teamsConnections(db, query.tenant_id)
    : [];
  const stateOrgId = query.org_id ?? installationRow?.orgId;
  const recentRuns = await recentTeamsRuns(db, stateOrgId);
  const orgMeta = await orgMetaFor(db, stateOrgId);
  const defaultAgent = await defaultAgentFor(db, orgMeta?.defaultAgentId);
  const compose = await defaultComposeFor(db, orgMeta?.defaultAgentId);
  const composeVersion = await defaultComposeVersionFor(
    db,
    compose?.headVersionId,
  );
  const mockCalls = await recentMockCalls(db, query.tenant_id);
  const callbacks = await recentTeamsCallbacks(db, stateOrgId);

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
        return { ...connection, createdAt: isoString(connection.createdAt) };
      }),
      recent_runs: recentRuns.map((run) => {
        return { ...run, createdAt: isoString(run.createdAt) };
      }),
      recent_callbacks: callbacks.map((callback) => {
        return {
          ...callback,
          createdAt: isoString(callback.createdAt),
          lastAttemptAt: nullableIsoString(callback.lastAttemptAt),
          deliveredAt: nullableIsoString(callback.deliveredAt),
        };
      }),
      org_metadata: orgMeta,
      default_agent: defaultAgent,
      default_compose: compose,
      default_compose_version: composeVersion
        ? {
            id: composeVersion.id,
            content_keys: contentKeys(composeVersion.content),
          }
        : null,
      resolved_teams_mock_base_url: resolvedTeamsMockBaseUrl(),
      mock_calls: mockCalls.map((call) => {
        return { ...call, createdAt: isoString(call.createdAt) };
      }),
    },
  };
});

const postTeamsStateBody$ = bodyResultOf(testTeamsStateContract.post);

function postTeamsStateValidationError(
  body: TestTeamsStatePostBody,
): string | null {
  if (!body.tenant_id && !body.seed_default_agent && !body.org_id) {
    return "tenant_id is required unless seeding an org-scoped test fixture";
  }
  if (
    body.seed_connection &&
    (!body.tenant_id || (!body.teams_user_id && !body.teams_aad_object_id))
  ) {
    return "tenant_id and teams_user_id or teams_aad_object_id are required to seed a connection";
  }
  return null;
}

async function maybeUpsertTeamsInstallationForPost(
  db: Db,
  body: TestTeamsStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<void> {
  if (!body.tenant_id) {
    return;
  }
  await upsertTeamsInstallation(db, {
    tenantId: body.tenant_id,
    tenantName: body.tenant_name ?? DEFAULT_TENANT_NAME,
    teamId: body.team_id ?? null,
    teamName: body.team_name ?? DEFAULT_TEAM_NAME,
    orgId:
      body.installation_org_id === undefined
        ? actor.orgId
        : body.installation_org_id,
    installedByUserId: actor.userId,
    serviceUrl: body.service_url ?? DEFAULT_SERVICE_URL,
    botId: body.bot_id ?? DEFAULT_BOT_ID,
    botName: body.bot_name ?? DEFAULT_BOT_NAME,
  });
}

async function maybeDeleteTeamsConnectionForPost(
  db: Db,
  body: TestTeamsStatePostBody,
): Promise<void> {
  if (!body.delete_connection || !body.tenant_id) {
    return;
  }
  if (body.vm0_user_id) {
    await db
      .delete(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, body.tenant_id),
          eq(teamsOrgConnections.vm0UserId, body.vm0_user_id),
        ),
      );
    return;
  }
  await db
    .delete(teamsOrgConnections)
    .where(eq(teamsOrgConnections.teamsTenantId, body.tenant_id));
}

async function maybeSeedTeamsConnectionForPost(
  db: Db,
  body: TestTeamsStatePostBody,
  userId: string,
): Promise<string | undefined> {
  if (!body.seed_connection) {
    return undefined;
  }
  return await upsertTeamsConnection(db, {
    tenantId: body.tenant_id!,
    teamsUserId: body.teams_user_id,
    teamsAadObjectId: body.teams_aad_object_id,
    vm0UserId: userId,
    displayName: body.teams_user_display_name,
    principalName: body.teams_user_principal_name,
  });
}

async function maybeSeedDefaultAgentForPost(
  db: Db,
  body: TestTeamsStatePostBody,
  actor: { readonly orgId: string; readonly userId: string },
): Promise<{ readonly composeId: string } | undefined> {
  if (!body.seed_default_agent) {
    return undefined;
  }
  return await seedDefaultAgent(db, {
    orgId: actor.orgId,
    userId: actor.userId,
    name: body.default_agent_name ?? DEFAULT_AGENT_NAME,
    displayName: body.default_agent_display_name,
  });
}

const postTeamsState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const bodyResult = await get(postTeamsStateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const body = bodyResult.data;
  const validationError = postTeamsStateValidationError(body);
  if (validationError) {
    return {
      status: 400 as const,
      body: { error: validationError },
    };
  }

  let actor: { readonly orgId: string; readonly userId: string };
  if (body.org_id && !body.vm0_user_id && !body.email) {
    actor = {
      orgId: body.org_id,
      userId: `user_${body.org_id.replace(/[^a-zA-Z0-9_]/g, "_")}`,
    };
  } else {
    const userId =
      body.vm0_user_id ??
      (await set(
        testUserId$,
        { email: body.email ?? DEFAULT_TEST_EMAIL, refresh: false },
        signal,
      ));
    signal.throwIfAborted();
    const orgId = body.org_id ?? (await set(resolveTestOrgId$, userId, signal));
    actor = { orgId, userId };
  }
  signal.throwIfAborted();

  const db = set(writeDb$);
  await maybeUpsertTeamsInstallationForPost(db, body, actor);
  signal.throwIfAborted();
  await maybeDeleteTeamsConnectionForPost(db, body);
  signal.throwIfAborted();
  const connectionId = await maybeSeedTeamsConnectionForPost(
    db,
    body,
    actor.userId,
  );
  signal.throwIfAborted();
  const defaultAgent = await maybeSeedDefaultAgentForPost(db, body, actor);
  signal.throwIfAborted();

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      tenant_id: body.tenant_id ?? "",
      org_id: actor.orgId,
      vm0_user_id: actor.userId,
      connection_id: connectionId ?? null,
      default_agent_id: defaultAgent?.composeId ?? null,
    },
  };
});

interface TeamsStateDeleteQuery {
  readonly tenant_id?: string;
  readonly org_id?: string;
}

interface TeamsInstallationDeleteRow {
  readonly teamsTenantId: string;
  readonly orgId: string | null;
}

async function teamsInstallationRowsForDelete(
  db: Db,
  query: TeamsStateDeleteQuery,
): Promise<readonly TeamsInstallationDeleteRow[]> {
  if (query.tenant_id) {
    return await db
      .select({
        teamsTenantId: teamsOrgInstallations.teamsTenantId,
        orgId: teamsOrgInstallations.orgId,
      })
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.teamsTenantId, query.tenant_id));
  }
  if (query.org_id) {
    return await db
      .select({
        teamsTenantId: teamsOrgInstallations.teamsTenantId,
        orgId: teamsOrgInstallations.orgId,
      })
      .from(teamsOrgInstallations)
      .where(eq(teamsOrgInstallations.orgId, query.org_id));
  }
  return [];
}

function orgIdsForTeamsStateDelete(
  rows: readonly TeamsInstallationDeleteRow[],
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

function tenantIdsForTeamsStateDelete(
  rows: readonly TeamsInstallationDeleteRow[],
  tenantId: string | undefined,
): string[] {
  const tenantIds = rows.map((row) => {
    return row.teamsTenantId;
  });
  if (tenantId && !tenantIds.includes(tenantId)) {
    tenantIds.push(tenantId);
  }
  return tenantIds;
}

async function deleteTeamsTenantsForState(
  db: Db,
  tenantIds: readonly string[],
  signal: AbortSignal,
): Promise<void> {
  if (tenantIds.length === 0) {
    return;
  }
  await db
    .delete(teamsOrgConnections)
    .where(inArray(teamsOrgConnections.teamsTenantId, tenantIds));
  signal.throwIfAborted();
  await db
    .delete(teamsOrgInstallations)
    .where(inArray(teamsOrgInstallations.teamsTenantId, tenantIds));
  signal.throwIfAborted();
  await db
    .delete(e2eTeamsMockCallLog)
    .where(inArray(e2eTeamsMockCallLog.tenantId, tenantIds));
  signal.throwIfAborted();
}

async function deleteTeamsRunsForOrg(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  const teamsAgentRuns = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(eq(agentRuns.orgId, orgId), eq(zeroRuns.triggerSource, "teams")),
    );
  signal.throwIfAborted();

  const runIds = teamsAgentRuns.map((run) => {
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

async function deleteTeamsComposesForOrg(
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

async function deleteTeamsOrgState(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(teamsUserAgentPreferences)
    .where(eq(teamsUserAgentPreferences.orgId, orgId));
  signal.throwIfAborted();
  await deleteTeamsComposesForOrg(db, orgId, signal);
  await db.delete(orgMetadata).where(eq(orgMetadata.orgId, orgId));
  signal.throwIfAborted();
}

const deleteTeamsState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testTeamsStateContract.delete));
  if (!query.tenant_id && !query.org_id) {
    return {
      status: 400 as const,
      body: { error: "tenant_id or org_id query param is required" },
    };
  }

  const db = set(writeDb$);
  const installationRows = await teamsInstallationRowsForDelete(db, query);
  signal.throwIfAborted();
  const orgIds = orgIdsForTeamsStateDelete(installationRows, query.org_id);
  for (const orgId of orgIds) {
    await deleteVm0ManagedKeysForSeededDefaultAgent(db, orgId);
    signal.throwIfAborted();
  }

  await deleteTeamsTenantsForState(
    db,
    tenantIdsForTeamsStateDelete(installationRows, query.tenant_id),
    signal,
  );

  for (const orgId of orgIds) {
    await deleteTeamsRunsForOrg(db, orgId, signal);
  }

  if (query.org_id) {
    await deleteTeamsOrgState(db, query.org_id, signal);
  }

  return {
    status: 200 as const,
    body: { ok: true as const },
  };
});

export const testTeamsStateRoutes: readonly RouteEntry[] = [
  {
    route: testTeamsStateContract.get,
    handler: getTeamsState$,
  },
  {
    route: testTeamsStateContract.post,
    handler: postTeamsState$,
  },
  {
    route: testTeamsStateContract.delete,
    handler: deleteTeamsState$,
  },
];
