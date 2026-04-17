import { NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/nextjs/server";
import { initServices } from "../../../../src/lib/init-services";
import { isTestEndpointAllowed } from "../../../../src/lib/test-endpoints/guard";
import { slackOrgInstallations } from "../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../src/db/schema/slack-org-connection";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { zeroRuns } from "../../../../src/db/schema/zero-run";
import { encryptSecretValue } from "../../../../src/lib/shared/crypto/secrets-encryption";
import {
  DEFAULT_TEST_EMAIL,
  resolveTestUserId,
} from "../../../../src/lib/auth/test-user";
import { env } from "../../../../src/env";

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

interface SeedBody {
  team_id: string;
  slack_user_id: string;
  workspace_name?: string;
  bot_user_id?: string;
  email?: string;
  /** When true, also inserts a slack_org_connections row for the user. */
  seed_connection?: boolean;
}

async function resolveTestOrgId(userId: string): Promise<string> {
  const clerk = await clerkClient();
  const memberships = await clerk.users.getOrganizationMembershipList({
    userId,
  });
  const orgId = memberships.data[0]?.organization.id;
  if (!orgId) {
    throw new Error(`Test user ${userId} has no organization membership`);
  }
  return orgId;
}

/**
 * POST /api/test/slack-state
 *
 * Seeds a Slack installation (and optionally a connection) for the test
 * user. Mirrors the Vitest seeders at
 * `src/__tests__/db-test-seeders/slack.ts` but exposed via HTTP so BATS
 * tests can set up state on a live Vercel preview deployment.
 */
export async function POST(request: Request) {
  if (!isTestEndpointAllowed(request)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const raw = (await request.json().catch(() => null)) as SeedBody | null;
  if (!raw?.team_id || !raw.slack_user_id) {
    return NextResponse.json(
      { error: "team_id and slack_user_id are required" },
      { status: 400 },
    );
  }

  initServices();
  const db = globalThis.services.db;

  const userId = await resolveTestUserId(raw.email ?? DEFAULT_TEST_EMAIL);
  const orgId = await resolveTestOrgId(userId);

  const { SECRETS_ENCRYPTION_KEY } = env();
  const encryptedBotToken = encryptSecretValue(
    "xoxb-e2e-test-bot-token",
    SECRETS_ENCRYPTION_KEY,
  );

  await db
    .insert(slackOrgInstallations)
    .values({
      slackWorkspaceId: raw.team_id,
      slackWorkspaceName: raw.workspace_name ?? "E2E Test Workspace",
      orgId,
      encryptedBotToken,
      botUserId: raw.bot_user_id ?? "U_E2E_BOT",
      installedByUserId: userId,
      botScopes: "chat:write,im:write,users:read",
    })
    .onConflictDoUpdate({
      target: slackOrgInstallations.slackWorkspaceId,
      set: {
        orgId,
        encryptedBotToken,
        botUserId: raw.bot_user_id ?? "U_E2E_BOT",
      },
    });

  let connectionId: string | undefined;
  if (raw.seed_connection) {
    const [row] = await db
      .insert(slackOrgConnections)
      .values({
        slackUserId: raw.slack_user_id,
        slackWorkspaceId: raw.team_id,
        vm0UserId: userId,
      })
      .onConflictDoNothing()
      .returning({ id: slackOrgConnections.id });
    connectionId = row?.id;
  }

  return NextResponse.json({
    ok: true,
    team_id: raw.team_id,
    org_id: orgId,
    vm0_user_id: userId,
    connection_id: connectionId ?? null,
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
