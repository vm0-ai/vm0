import { NextResponse } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import {
  adminConnect,
  memberConnect,
  notifyConnectSuccess,
} from "../../../../../../src/lib/zero/slack-org/connect-service";
import {
  resolveDefaultComposeId,
  getWorkspaceAgent,
} from "../../../../../../src/lib/zero/slack-org/handlers/shared";
import { logger } from "../../../../../../src/lib/shared/logger";

const log = logger("api:zero:slack:connect");

const connectBodySchema = z.object({
  workspaceId: z.string().min(1),
  slackUserId: z.string().min(1),
  channelId: z.string().optional(),
  threadTs: z.string().optional(),
});

/**
 * GET /api/zero/integrations/slack/connect
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
  const { org, member } = await resolveOrg(authCtx);

  // Find installation for this org, then find user's connection via workspace
  const [orgInstallation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.orgId, org.orgId))
    .limit(1);

  const [connection] = orgInstallation
    ? await globalThis.services.db
        .select()
        .from(slackOrgConnections)
        .where(
          and(
            eq(slackOrgConnections.vm0UserId, userId),
            eq(
              slackOrgConnections.slackWorkspaceId,
              orgInstallation.slackWorkspaceId,
            ),
          ),
        )
        .limit(1)
    : [];

  if (!connection) {
    return NextResponse.json({
      isConnected: false,
      isAdmin: member.role === "admin",
    });
  }

  // Get default agent name
  let defaultAgentName: string | null = null;
  const composeId = await resolveDefaultComposeId(org.orgId);
  if (composeId) {
    const agent = await getWorkspaceAgent(composeId);
    defaultAgentName = agent?.name ?? null;
  }

  return NextResponse.json({
    isConnected: true,
    workspaceName: orgInstallation?.slackWorkspaceName ?? null,
    isAdmin: member.role === "admin",
    defaultAgentName,
  });
}

/**
 * POST /api/zero/integrations/slack/connect
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
    await request.json().catch(() => {
      return undefined;
    }),
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

  const { workspaceId, slackUserId, channelId, threadTs } = parseResult.data;

  // Resolve org and check membership
  const { org, member } = await resolveOrg(authCtx);

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

    void notifyConnectSuccess({
      installation,
      slackUserId,
      orgId: org.orgId,
      channelId,
      threadTs,
    }).catch((err) => {
      return log.warn("Failed to notify connect success", { error: err });
    });

    return NextResponse.json({
      success: true,
      connectionId: result.connection.id,
      role: "admin",
    });
  }

  // Already bound — verify org match
  if (installation.orgId !== org.orgId) {
    return NextResponse.json(
      {
        error: {
          message:
            "Your active organization doesn't match this Slack workspace. Please switch to the correct organization in the platform sidebar before connecting.",
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

  void notifyConnectSuccess({
    installation,
    slackUserId,
    orgId: org.orgId,
    channelId,
    threadTs,
  }).catch((err) => {
    return log.warn("Failed to notify connect success", { error: err });
  });

  return NextResponse.json({
    success: true,
    connectionId: result.connection.id,
    role: member.role,
  });
}
