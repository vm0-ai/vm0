import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import { isTestEndpointAllowed } from "../../../../src/lib/auth/test-endpoint-guard";
import { slackOrgInstallations } from "../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../src/db/schema/slack-org-connection";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { zeroRuns } from "../../../../src/db/schema/zero-run";
import { orgMetadata } from "../../../../src/db/schema/org-metadata";
import { zeroAgents } from "../../../../src/db/schema/zero-agent";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import {
  DEFAULT_TEST_EMAIL,
  resolveTestOrgId,
  resolveTestUserId,
} from "../../../../src/lib/auth/test-user";
import { SLACK_E2E_FIXTURES } from "../../../../src/lib/test-endpoints/slack-mock-fixtures";
import {
  insertSlackConnectionIfMissing,
  upsertSlackInstallation,
} from "../../../../src/lib/zero/slack/seed-install";
import { seedDefaultAgent } from "../../../../src/lib/test-endpoints/seed-default-agent";
import { e2eSlackMockCallLog } from "../../../../src/db/schema/e2e-slack-mock-call-log";

/**
 * GET /api/test/slack-state?team_id=...
 *
 * Returns the Slack-related DB rows scoped to a Slack workspace ID so
 * BATS e2e assertions can verify the effect of webhook calls.
 */
export async function GET(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const teamId = url.searchParams.get("team_id");
  if (!teamId) {
    return NextResponse.json(
      { error: "team_id query param is required" },
      { status: 400 },
    );
  }

  initServices();
  const db = globalThis.services.db;

  const [installation] = await db
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
    .limit(1);

  const connections = await db
    .select({
      id: slackOrgConnections.id,
      slackUserId: slackOrgConnections.slackUserId,
      vm0UserId: slackOrgConnections.vm0UserId,
      dmWelcomeSent: slackOrgConnections.dmWelcomeSent,
      createdAt: slackOrgConnections.createdAt,
    })
    .from(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, teamId));

  // LEFT JOIN so we also surface agent_runs inserted without a matching
  // zero_runs row (which can happen if dispatch fails between the two
  // inserts). Makes BATS diagnostics far more informative.
  //
  // Limit is 50 so parallel tests in the same runner shard (which share
  // the preview and DB) can't push the slack run out of the window
  // before the BATS assertion reads it.
  const recentRuns = installation?.orgId
    ? await db
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
        .where(eq(agentRuns.orgId, installation.orgId))
        .orderBy(desc(agentRuns.createdAt))
        .limit(50)
    : [];

  const orgMeta = installation?.orgId
    ? ((
        await db
          .select({
            orgId: orgMetadata.orgId,
            defaultAgentId: orgMetadata.defaultAgentId,
            credits: orgMetadata.credits,
            tier: orgMetadata.tier,
          })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, installation.orgId))
          .limit(1)
      )[0] ?? null)
    : null;

  const defaultAgent = orgMeta?.defaultAgentId
    ? ((
        await db
          .select({
            id: zeroAgents.id,
            name: zeroAgents.name,
            orgId: zeroAgents.orgId,
          })
          .from(zeroAgents)
          .where(eq(zeroAgents.id, orgMeta.defaultAgentId))
          .limit(1)
      )[0] ?? null)
    : null;

  const compose = orgMeta?.defaultAgentId
    ? ((
        await db
          .select({
            id: agentComposes.id,
            name: agentComposes.name,
            headVersionId: agentComposes.headVersionId,
          })
          .from(agentComposes)
          .where(eq(agentComposes.id, orgMeta.defaultAgentId))
          .limit(1)
      )[0] ?? null)
    : null;

  const composeVersion = compose?.headVersionId
    ? ((
        await db
          .select({
            id: agentComposeVersions.id,
            content: agentComposeVersions.content,
          })
          .from(agentComposeVersions)
          .where(eq(agentComposeVersions.id, compose.headVersionId))
          .limit(1)
      )[0] ?? null)
    : null;

  // Surface the slack-api URL that outbound traffic from this deployment
  // would actually use. Lets BATS diagnose whether E2E_SLACK_MOCK_ENABLED
  // was propagated to the serverless runtime. Re-implements the logic in
  // src/lib/zero/slack/client.ts's resolveSlackApiUrl() so we don't have
  // to import it (that module imports WebClient which is heavy).
  const resolvedSlackApiUrl = (() => {
    const e = env();
    if (e.SLACK_API_URL) return e.SLACK_API_URL;
    const flag = e.E2E_SLACK_MOCK_ENABLED;
    const mockEnabled = flag === "1" || flag === "true";
    if (mockEnabled && e.VERCEL_URL) {
      return `https://${e.VERCEL_URL}/api/test/slack-mock/`;
    }
    return null;
  })();

  // Recent mock-endpoint calls so BATS can assert that the Slack callback
  // actually posted a reply after the run completed. Each CI run gets its
  // own Neon branch, so we surface deployment-wide entries — many Slack
  // API methods (chat.postMessage) don't carry a team_id in the request,
  // and filtering would silently drop them.
  const mockCalls = await db
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

  return NextResponse.json({
    installation: installation ?? null,
    connections,
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
    resolved_slack_api_url: resolvedSlackApiUrl,
    mock_calls: mockCalls,
  });
}

interface SeedBody {
  team_id: string;
  slack_user_id: string;
  workspace_name?: string;
  bot_user_id?: string;
  email?: string;
  /** When true, also inserts a slack_org_connections row for the user. */
  seed_connection?: boolean;
  /**
   * When true, also seeds a minimal agent compose with a head version and
   * sets it as the org's default agent. Required for mention / DM
   * dispatch to actually create a run row.
   */
  seed_default_agent?: boolean;
}

/**
 * POST /api/test/slack-state
 *
 * Seeds a Slack installation (and optionally a connection) for the test
 * user. The underlying upsert is shared with the Vitest seeders via
 * `src/lib/zero/slack/seed-install.ts`, so schema changes live in one
 * place. This route just exposes the seed over HTTP so BATS tests can
 * drive a live Vercel preview.
 */
export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const raw = (await request.json().catch(() => {
    return null;
  })) as SeedBody | null;
  if (!raw?.team_id || !raw.slack_user_id) {
    return NextResponse.json(
      { error: "team_id and slack_user_id are required" },
      { status: 400 },
    );
  }

  initServices();
  const services = globalThis.services;

  const userId = await resolveTestUserId(raw.email ?? DEFAULT_TEST_EMAIL);
  const orgId = await resolveTestOrgId(userId);

  await upsertSlackInstallation(services, {
    slackWorkspaceId: raw.team_id,
    slackWorkspaceName: raw.workspace_name ?? "E2E Test Workspace",
    orgId,
    botUserId: raw.bot_user_id ?? SLACK_E2E_FIXTURES.botUserId,
    botToken: SLACK_E2E_FIXTURES.botToken,
    botScopes: "chat:write,im:write,users:read",
    installedByUserId: userId,
  });

  let connectionId: string | undefined;
  if (raw.seed_connection) {
    const result = await insertSlackConnectionIfMissing(services, {
      slackUserId: raw.slack_user_id,
      slackWorkspaceId: raw.team_id,
      vm0UserId: userId,
    });
    connectionId = result.connectionId;
  }

  let defaultAgent: { composeId: string; versionId: string } | undefined;
  if (raw.seed_default_agent) {
    defaultAgent = await seedDefaultAgent(services, {
      orgId,
      userId,
      name: "e2e-slack-agent",
    });
  }

  return NextResponse.json({
    ok: true,
    team_id: raw.team_id,
    org_id: orgId,
    vm0_user_id: userId,
    connection_id: connectionId ?? null,
    default_agent_id: defaultAgent?.composeId ?? null,
  });
}

/**
 * DELETE /api/test/slack-state?team_id=...
 *
 * Clears all Slack rows and recent runs for a workspace so BATS tests
 * can start from a known empty state.
 */
export async function DELETE(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const url = new URL(request.url);
  const teamId = url.searchParams.get("team_id");
  if (!teamId) {
    return NextResponse.json(
      { error: "team_id query param is required" },
      { status: 400 },
    );
  }

  initServices();
  const db = globalThis.services.db;

  const [existing] = await db
    .select({ orgId: slackOrgInstallations.orgId })
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, teamId))
    .limit(1);

  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, teamId));

  await db
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, teamId));

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
    const ids = slackAgentRuns.map((r) => {
      return r.id;
    });
    if (ids.length > 0) {
      await db.delete(zeroRuns).where(inArray(zeroRuns.id, ids));
      await db.delete(agentRuns).where(inArray(agentRuns.id, ids));
    }
  }

  // Do NOT truncate e2e_slack_mock_call_log — BATS assertions already
  // scope to the test's channel id, and concurrent tests on the same
  // Neon branch (e.g. ser-t07-slack in cli-e2e-01-serial racing t40 in
  // cli-e2e-03-runner) would otherwise wipe each other's postMessage
  // rows between insert and poll. If noise accumulation is ever a
  // problem, use an age-based filter here rather than blanket DELETE.

  return NextResponse.json({ ok: true });
}
