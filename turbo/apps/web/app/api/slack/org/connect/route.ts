import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import { resolveOrg } from "../../../../../src/lib/org/resolve-org";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../src/db/schema/slack-org-connection";
import {
  adminConnect,
  memberConnect,
} from "../../../../../src/lib/slack-org/connect-service";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  postMessage,
} from "../../../../../src/lib/slack/client";
import {
  buildSuccessMessage,
  buildWelcomeMessage,
} from "../../../../../src/lib/slack/blocks";
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
      // No channel context: DM the user, then send welcome in the same thread
      const connectMsg = await postMessage(
        client,
        slackUserId,
        "You're connected!",
        { blocks },
      );

      // Send welcome message as a reply in the same thread
      if (connectMsg?.ts) {
        await postMessage(client, slackUserId, "Hi! I'm Zero.", {
          threadTs: connectMsg.ts,
          blocks: buildWelcomeMessage(agentName),
        });
      }

      // Mark welcome as sent so handleOrgMessagesTabOpened doesn't send again
      await globalThis.services.db
        .update(slackOrgConnections)
        .set({ dmWelcomeSent: true })
        .where(
          and(
            eq(slackOrgConnections.slackUserId, slackUserId),
            eq(
              slackOrgConnections.slackWorkspaceId,
              installation.slackWorkspaceId,
            ),
          ),
        );
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
  const { userId, orgId: activeOrgId } = await auth();

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
      `${platformUrl}/zero/slack/connect?error=${encodeURIComponent("Invalid connect link.")}`,
    );
  }

  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return NextResponse.redirect(
      `${platformUrl}/zero/slack/connect?error=${encodeURIComponent("Workspace not found. Please install the Slack app first.")}`,
    );
  }

  if (!installation.orgId) {
    const { org, member } = await resolveOrg(userId);

    if (member.role !== "admin") {
      return NextResponse.redirect(
        `${platformUrl}/zero/slack/connect?error=${encodeURIComponent("Ask your org admin to connect first.")}`,
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
    return NextResponse.redirect(
      `${platformUrl}/zero/slack/connect?status=connected`,
    );
  }

  // Verify the user is a member of the workspace's bound org AND their
  // active org matches. Clerk sessions may differ across subdomains
  // (platform.vm7.ai vs www.vm7.ai), so we also accept an explicit
  // orgId query param from the platform as a trusted source.
  const explicitOrgId = url.searchParams.get("orgId");
  const effectiveOrgId = explicitOrgId ?? activeOrgId;
  log.info("Org check", {
    activeOrgId,
    explicitOrgId,
    installationOrgId: installation.orgId,
    userId,
  });
  if (!effectiveOrgId || effectiveOrgId !== installation.orgId) {
    // Distinguish: is the user a member of the workspace's org at all?
    let isMember = false;
    try {
      await resolveOrg(userId, null, installation.orgId);
      isMember = true;
    } catch {
      // Not a member
    }

    const message = isMember
      ? "Your active organization doesn't match this Slack workspace. Please switch to the correct organization in the platform sidebar before connecting."
      : "You don't have access to the organization this Slack workspace belongs to. Contact the organization admin for an invite.";

    return NextResponse.redirect(
      `${platformUrl}/zero/slack/connect?error=${encodeURIComponent(message)}`,
    );
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
  return NextResponse.redirect(
    `${platformUrl}/zero/slack/connect?status=connected`,
  );
}
