import { NextResponse } from "next/server";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { isTestEndpointAllowed } from "../../../../src/lib/test-endpoints/guard";
import { slackOrgInstallations } from "../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../src/db/schema/slack-org-connection";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { zeroRuns } from "../../../../src/db/schema/zero-run";
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

  const recentRuns = installation?.orgId
    ? await db
        .select({
          id: agentRuns.id,
          status: agentRuns.status,
          createdAt: agentRuns.createdAt,
          triggerSource: zeroRuns.triggerSource,
          userId: agentRuns.userId,
          // Truncate prompt so BATS assertions can match without pulling
          // large payloads. Tests only need a prefix for attribution.
          promptPreview: sql<string>`substring(${agentRuns.prompt}, 1, 200)`,
        })
        .from(agentRuns)
        .innerJoin(zeroRuns, eq(agentRuns.id, zeroRuns.id))
        .where(eq(agentRuns.orgId, installation.orgId))
        .orderBy(desc(agentRuns.createdAt))
        .limit(10)
    : [];

  return NextResponse.json({
    installation: installation ?? null,
    connections,
    recent_runs: recentRuns,
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

  return NextResponse.json({ ok: true });
}
