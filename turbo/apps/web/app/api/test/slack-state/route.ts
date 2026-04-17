import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { isTestEndpointAllowed } from "../../../../src/lib/test-endpoints/guard";
import { slackOrgInstallations } from "../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../src/db/schema/slack-org-connection";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { zeroRuns } from "../../../../src/db/schema/zero-run";

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
