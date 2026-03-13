import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../../../src/lib/org/resolve-org";
import { slackOrgInstallations } from "../../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../../src/db/schema/slack-org-connection";
import {
  adminConnect,
  memberConnect,
} from "../../../../../../src/lib/slack-org/connect-service";
import {
  resolveDefaultComposeId,
  getWorkspaceAgent,
} from "../../../../../../src/lib/slack-org/handlers/shared";

const connectBodySchema = z.object({
  workspaceId: z.string().min(1),
  slackUserId: z.string().min(1),
});

/**
 * GET /api/integrations/slack/org/connect
 *
 * Check connection status for the authenticated user.
 */
export async function GET(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { userId } = authCtx;
  const { org, member } = await resolveOrg(userId);

  // Find user's connection in any workspace bound to this org
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.vm0UserId, userId),
        eq(slackOrgConnections.orgId, org.orgId),
      ),
    )
    .limit(1);

  if (!connection) {
    return NextResponse.json({
      isConnected: false,
      isAdmin: member.role === "admin",
    });
  }

  // Get workspace info
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(
      eq(slackOrgInstallations.slackWorkspaceId, connection.slackWorkspaceId),
    )
    .limit(1);

  // Get default agent name
  let defaultAgentName: string | null = null;
  const composeId = await resolveDefaultComposeId(org.orgId);
  if (composeId) {
    const agent = await getWorkspaceAgent(composeId);
    defaultAgentName = agent?.name ?? null;
  }

  return NextResponse.json({
    isConnected: true,
    workspaceName: installation?.slackWorkspaceName ?? null,
    isAdmin: member.role === "admin",
    defaultAgentName,
  });
}

/**
 * POST /api/integrations/slack/org/connect
 *
 * Connect user to Slack workspace (admin or member flow).
 */
export async function POST(request: Request) {
  initServices();

  const authHeader = request.headers.get("authorization");
  const authCtx = await getAuthContext(authHeader ?? undefined);
  if (!authCtx) {
    return NextResponse.json(
      { error: { message: "Not authenticated", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const { userId } = authCtx;

  const parseResult = connectBodySchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parseResult.success) {
    return NextResponse.json(
      {
        error: {
          message: "Missing workspaceId or slackUserId",
          code: "BAD_REQUEST",
        },
      },
      { status: 400 },
    );
  }

  const { workspaceId, slackUserId } = parseResult.data;

  // Resolve org and check membership
  const { org, member } = await resolveOrg(userId);

  // Check installation exists
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return NextResponse.json(
      {
        error: {
          message: "Workspace not found. Please install the Slack app first.",
          code: "NOT_FOUND",
        },
      },
      { status: 404 },
    );
  }

  if (!installation.orgId) {
    // Unbound workspace — requires admin
    if (member.role !== "admin") {
      return NextResponse.json(
        {
          error: {
            message:
              "Only org admins can connect an unconfigured workspace. Ask your org admin to connect first.",
            code: "FORBIDDEN",
          },
        },
        { status: 403 },
      );
    }

    const result = await adminConnect({
      userId,
      orgId: org.orgId,
      workspaceId,
      slackUserId,
    });

    return NextResponse.json({
      success: true,
      connectionId: result.connection.id,
      role: "admin",
    });
  }

  // Already bound — member connect
  if (installation.orgId !== org.orgId) {
    return NextResponse.json(
      {
        error: {
          message: "This workspace is connected to a different org",
          code: "FORBIDDEN",
        },
      },
      { status: 403 },
    );
  }

  const result = await memberConnect({
    userId,
    orgId: org.orgId,
    workspaceId,
    slackUserId,
  });

  return NextResponse.json({
    success: true,
    connectionId: result.connection.id,
    role: member.role,
  });
}
