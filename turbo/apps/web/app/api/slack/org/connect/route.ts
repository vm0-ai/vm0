import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import {
  adminConnect,
  memberConnect,
} from "../../../../../src/lib/slack-org/connect-service";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  postMessage,
} from "../../../../../src/lib/slack/client";
import { buildSuccessMessage } from "../../../../../src/lib/slack/blocks";
import {
  resolveDefaultComposeId,
  getWorkspaceAgent,
} from "../../../../../src/lib/slack-org/handlers/shared";
import { refreshOrgAppHome } from "../../../../../src/lib/slack-org/handlers/app-home";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { logger } from "../../../../../src/lib/logger";

const log = logger("slack-org:connect");

/**
 * Send a Slack DM confirming successful connection and refresh App Home.
 * Fire-and-forget to avoid delaying the browser redirect.
 */
function notifyConnectSuccess(
  installation: typeof slackOrgInstallations.$inferSelect,
  slackUserId: string,
  channelId: string | null,
  threadTs: string | null,
  orgId: string,
): void {
  void (async () => {
    const { SECRETS_ENCRYPTION_KEY } = env();
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);

    // Resolve agent name for the message
    let agentName: string | undefined;
    const composeId = await resolveDefaultComposeId(orgId);
    if (composeId) {
      const agent = await getWorkspaceAgent(composeId);
      agentName = agent?.displayName ?? agent?.name;
    }

    const agentLine = agentName
      ? `Your workspace agent is *${agentName}*.`
      : `No workspace agent configured yet.`;

    const blocks = buildSuccessMessage(
      `You're connected! :tada:\n\n${agentLine}\nMention \`@Zero\` in any channel or send a DM to start chatting with your agent.`,
    );

    if (channelId) {
      // In a channel: use ephemeral so only this user sees it
      await client.chat.postEphemeral({
        channel: channelId,
        user: slackUserId,
        text: "You're connected!",
        blocks,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } else {
      // No channel context: DM the user (DMs are already private)
      await postMessage(client, slackUserId, "You're connected!", { blocks });
    }

    await refreshOrgAppHome(client, installation, slackUserId).catch((e) =>
      log.warn("Failed to refresh App Home after connect", { error: e }),
    );
  })().catch((e) => log.warn("Failed to notify connect success", { error: e }));
}

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
  const channelId = url.searchParams.get("c");
  const threadTs = url.searchParams.get("t");
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
    const { org, member } = await resolveOrg(userId);

    if (member.role !== "admin") {
      return NextResponse.redirect(
        `${platformUrl}/zero/works?error=${encodeURIComponent("Ask your org admin to connect first.")}`,
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

    notifyConnectSuccess(
      updatedInstallation,
      slackUserId,
      channelId,
      threadTs,
      org.orgId,
    );
    return NextResponse.redirect(`${platformUrl}/zero/works?connected=1`);
  }

  const { org, member } = await resolveOrg(userId, null, installation.orgId);

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

  notifyConnectSuccess(
    installation,
    slackUserId,
    channelId,
    threadTs,
    org.orgId,
  );
  return NextResponse.redirect(`${platformUrl}/zero/works?connected=1`);
}
