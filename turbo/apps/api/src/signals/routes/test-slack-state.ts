import { createHash } from "node:crypto";
import type { createClerkClient } from "@clerk/backend";
import { command, computed } from "ccstate";
import { testSlackStateContract } from "@vm0/api-contracts/contracts/test-slack-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { creditExpiresRecord } from "@vm0/db/schema/credit-expires-record";
import { e2eSlackMockCallLog } from "@vm0/db/schema/e2e-slack-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { bodyResultOf, queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { clerk$ } from "../external/clerk";
import { db$, type Db, type ReadonlyDb, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";
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
const SLACK_BOT_SCOPES = "chat:write,im:write,users:read";
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
        orgId: input.orgId,
        encryptedBotToken,
        botUserId: input.botUserId,
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
    })
    .onConflictDoNothing();

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

  return { composeId, versionId, agentId: composeId };
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
          ANTHROPIC_API_KEY: "fake-e2e-anthropic-key",
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

  await tx.execute(
    sql`INSERT INTO org_metadata (org_id, credits, created_at, updated_at)
        VALUES (${orgId}, ${STARTER_GRANT_AMOUNT}, now(), now())
        ON CONFLICT (org_id)
        DO UPDATE SET credits = org_metadata.credits + ${STARTER_GRANT_AMOUNT}, updated_at = now()`,
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
  if (!query.team_id) {
    return {
      status: 400 as const,
      body: { error: "team_id query param is required" },
    };
  }

  const db = get(db$);
  const teamId = query.team_id;
  const installationRow = await slackInstallation(db, teamId);
  const connections = await slackConnections(db, teamId);
  const recentRuns = await recentSlackRuns(db, installationRow?.orgId);
  const orgMeta = await orgMetaFor(db, installationRow?.orgId);
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
  if (!body.team_id || !body.slack_user_id) {
    return {
      status: 400 as const,
      body: { error: "team_id and slack_user_id are required" },
    };
  }

  const clerk = get(clerk$);
  const userId = await resolveTestUserId(
    clerk,
    body.email ?? DEFAULT_TEST_EMAIL,
  );
  signal.throwIfAborted();

  const orgId = await resolveTestOrgId(clerk, userId);
  signal.throwIfAborted();

  const db = set(writeDb$);
  await upsertSlackInstallation(db, {
    slackWorkspaceId: body.team_id,
    slackWorkspaceName: body.workspace_name ?? DEFAULT_WORKSPACE_NAME,
    orgId,
    botUserId: body.bot_user_id ?? SLACK_E2E_FIXTURES.botUserId,
    botToken: SLACK_E2E_FIXTURES.botToken,
    botScopes: SLACK_BOT_SCOPES,
    installedByUserId: userId,
  });
  signal.throwIfAborted();

  let connectionId: string | undefined;
  if (body.seed_connection) {
    connectionId = await insertSlackConnectionIfMissing(db, {
      slackUserId: body.slack_user_id,
      slackWorkspaceId: body.team_id,
      vm0UserId: userId,
    });
    signal.throwIfAborted();
  }

  let defaultAgent: { composeId: string; versionId: string } | undefined;
  if (body.seed_default_agent) {
    defaultAgent = await seedDefaultAgent(db, {
      orgId,
      userId,
      name: DEFAULT_AGENT_NAME,
    });
    signal.throwIfAborted();
  }

  return {
    status: 200 as const,
    body: {
      ok: true as const,
      team_id: body.team_id,
      org_id: orgId,
      vm0_user_id: userId,
      connection_id: connectionId ?? null,
      default_agent_id: defaultAgent?.composeId ?? null,
    },
  };
});

const deleteSlackState$ = command(async ({ get, set }, signal: AbortSignal) => {
  const request = get(request$);
  if (!isTestEndpointAllowed(request)) {
    return testEndpointNotFoundResponse();
  }

  const query = get(queryOf(testSlackStateContract.delete));
  if (!query.team_id) {
    return {
      status: 400 as const,
      body: { error: "team_id query param is required" },
    };
  }

  const db = set(writeDb$);
  const teamId = query.team_id;
  const [existing] = await db
    .select({ orgId: slackOrgInstallations.orgId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, teamId))
    .limit(1);
  signal.throwIfAborted();

  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, teamId));
  signal.throwIfAborted();

  await db
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, teamId));
  signal.throwIfAborted();

  if (existing?.orgId) {
    const slackAgentRuns = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
      .where(
        and(
          eq(agentRuns.orgId, existing.orgId),
          eq(zeroRuns.triggerSource, "slack"),
        ),
      );
    signal.throwIfAborted();

    const runIds = slackAgentRuns.map((run) => {
      return run.id;
    });
    if (runIds.length > 0) {
      await db.delete(zeroRuns).where(inArray(zeroRuns.id, runIds));
      signal.throwIfAborted();
      await db.delete(agentRuns).where(inArray(agentRuns.id, runIds));
      signal.throwIfAborted();
    }
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
