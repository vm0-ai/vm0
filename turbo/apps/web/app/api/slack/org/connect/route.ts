import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import {
  adminConnect,
  memberConnect,
} from "../../../../../src/lib/slack-org/connect-service";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { logger } from "../../../../../src/lib/logger";

const log = logger("slack-org:connect");

/**
 * GET /api/slack/org/connect?w={workspaceId}&u={slackUserId}&c={channelId}
 *
 * Browser-based connect flow triggered from Slack.
 * Uses Clerk session cookie to identify the VM0 user,
 * creates the connection, and redirects to the platform.
 */
export async function GET(request: Request) {
  const { userId } = await auth();

  if (!userId) {
    const signInUrl = new URL("/sign-in", request.url);
    signInUrl.searchParams.set("redirect_url", request.url);
    return NextResponse.redirect(signInUrl.toString());
  }

  initServices();

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("w");
  const slackUserId = url.searchParams.get("u");
  const platformUrl = getPlatformUrl();

  if (!workspaceId || !slackUserId) {
    return NextResponse.redirect(
      `${platformUrl}/zero/works?error=${encodeURIComponent("Invalid connect link.")}`,
    );
  }

  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return NextResponse.redirect(
      `${platformUrl}/zero/works?error=${encodeURIComponent("Workspace not found. Please install the Slack app first.")}`,
    );
  }

  if (!installation.orgId) {
    const { org, member } = await resolveOrg(userId, null, null, null);

    if (member.role !== "admin") {
      return NextResponse.redirect(
        `${platformUrl}/zero/works?error=${encodeURIComponent("Ask your org admin to connect first.")}`,
      );
    }

    await adminConnect({
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

    return NextResponse.redirect(`${platformUrl}/zero/works`);
  }

  const { org, member } = await resolveOrg(
    userId,
    null,
    null,
    installation.orgId,
  );

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

  return NextResponse.redirect(`${platformUrl}/zero/works`);
}
