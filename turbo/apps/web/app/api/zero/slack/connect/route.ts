import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { getAuthContext } from "../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../src/lib/zero/org/resolve-org";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import {
  adminConnect,
  memberConnect,
  notifyConnectSuccess,
} from "../../../../../src/lib/zero/slack-org/connect-service";
import { getAppUrl } from "../../../../../src/lib/zero/url";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("slack-org:connect");

/**
 * GET /api/zero/slack/connect?w={workspaceId}&u={slackUserId}&c={channelId}
 *
 * Browser-based connect flow triggered from Slack.
 * Uses Clerk session cookie to identify the VM0 user,
 * creates the connection, and redirects to the platform.
 */
export async function GET(request: Request) {
  // This route uses Clerk session cookies (no Bearer token) for browser-based flow
  const authCtx = await getAuthContext();
  if (!authCtx) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect_url", request.url);
    return NextResponse.redirect(signInUrl.toString());
  }
  const { userId } = authCtx;

  initServices();

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("w");
  const slackUserId = url.searchParams.get("u");
  const channelId = url.searchParams.get("c");
  const threadTs = url.searchParams.get("t");
  const appUrl = getAppUrl();

  if (!workspaceId || !slackUserId) {
    return NextResponse.redirect(
      `${appUrl}/slack/connect?error=${encodeURIComponent("Invalid connect link.")}`,
    );
  }

  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return NextResponse.redirect(
      `${appUrl}/slack/connect?error=${encodeURIComponent("Workspace not found. Please install the Slack app first.")}`,
    );
  }

  if (!installation.orgId) {
    const { org, member } = await resolveOrg(authCtx);

    if (member.role !== "admin") {
      return NextResponse.redirect(
        `${appUrl}/slack/connect?error=${encodeURIComponent("Ask your org admin to connect first.")}`,
      );
    }

    const { installation: updatedInstallation } = await adminConnect({
      userId,
      orgId: org.orgId,
      workspaceId,
      slackUserId,
    });

    log.info("Admin connected workspace from Slack", {
      userId,
      orgId: org.orgId,
      workspaceId,
    });

    void notifyConnectSuccess({
      installation: updatedInstallation,
      slackUserId,
      orgId: org.orgId,
      channelId,
      threadTs,
    }).catch((e) => {
      return log.warn("Failed to notify connect success", { error: e });
    });
    return NextResponse.redirect(`${appUrl}/slack/connect?status=connected`);
  }

  // Verify the user is a member of the workspace's bound org AND their
  // active org matches. Clerk sessions may differ across subdomains
  // (app.vm7.ai vs www.vm7.ai), so we also accept an explicit
  // orgId query param from the app as a trusted source.
  const explicitOrgId = url.searchParams.get("orgId");
  const effectiveOrgId = explicitOrgId ?? authCtx.orgId;
  log.info("Org check", {
    activeOrgId: authCtx.orgId,
    explicitOrgId,
    installationOrgId: installation.orgId,
    userId,
  });
  if (!effectiveOrgId || effectiveOrgId !== installation.orgId) {
    return NextResponse.redirect(
      `${appUrl}/slack/connect?error=${encodeURIComponent("Your active organization doesn't match this Slack workspace. Please switch to the correct organization in the platform sidebar before connecting.")}`,
    );
  }

  const { org, member } = await resolveOrg(authCtx);

  if (member.role === "admin") {
    await adminConnect({
      userId,
      orgId: org.orgId,
      workspaceId,
      slackUserId,
    });
  } else {
    await memberConnect({
      userId,
      orgId: org.orgId,
      workspaceId,
      slackUserId,
    });
  }

  log.info("User connected from Slack", {
    userId,
    orgId: org.orgId,
    workspaceId,
    role: member.role,
  });

  void notifyConnectSuccess({
    installation,
    slackUserId,
    orgId: org.orgId,
    channelId,
    threadTs,
  }).catch((e) => {
    return log.warn("Failed to notify connect success", { error: e });
  });
  return NextResponse.redirect(`${appUrl}/slack/connect?status=connected`);
}
