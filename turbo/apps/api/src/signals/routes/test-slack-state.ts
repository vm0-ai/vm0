import { command, computed } from "ccstate";
import { testSlackStateContract } from "@vm0/api-contracts/contracts/test-slack-state";
import {
  agentComposes,
  agentComposeVersions,
} from "@vm0/db/schema/agent-compose";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { e2eSlackMockCallLog } from "@vm0/db/schema/e2e-slack-mock-call-log";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

import { optionalEnv } from "../../lib/env";
import { queryOf } from "../context/request";
import { request$ } from "../context/hono";
import { db$, type ReadonlyDb, writeDb$ } from "../external/db";
import type { RouteEntry } from "../route";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-oauth-provider-helpers";

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
    route: testSlackStateContract.delete,
    handler: deleteSlackState$,
  },
];
