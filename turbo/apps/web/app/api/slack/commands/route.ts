import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../src/lib/slack/verify";
import { slackInstallations } from "../../../../src/db/schema/slack-installation";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  getSlackRedirectBaseUrl,
  refreshAppHome,
} from "../../../../src/lib/slack";
import {
  buildHelpMessage,
  buildErrorMessage,
  buildSuccessMessage,
  buildLoginMessage,
} from "../../../../src/lib/slack/blocks";
import { getPlatformUrl } from "../../../../src/lib/url";
import { logger } from "../../../../src/lib/logger";
import { removePermission } from "../../../../src/lib/agent/permission-service";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";

const log = logger("slack:commands");

/**
 * Slack Slash Commands Endpoint
 *
 * POST /api/slack/commands
 *
 * Handles /vm0 slash commands:
 * - /vm0 connect - Connect account
 * - /vm0 disconnect - Disconnect account
 * - /vm0 settings - Configure secrets/vars on the VM0 platform
 */

interface SlackCommandPayload {
  token: string;
  team_id: string;
  team_domain: string;
  channel_id: string;
  channel_name: string;
  user_id: string;
  user_name: string;
  command: string;
  text: string;
  response_url: string;
  trigger_id: string;
  api_app_id: string;
}

/**
 * Parse URL-encoded form data into SlackCommandPayload
 */
function parseCommandPayload(body: string): SlackCommandPayload {
  const params = new URLSearchParams(body);
  return {
    token: params.get("token") ?? "",
    team_id: params.get("team_id") ?? "",
    team_domain: params.get("team_domain") ?? "",
    channel_id: params.get("channel_id") ?? "",
    channel_name: params.get("channel_name") ?? "",
    user_id: params.get("user_id") ?? "",
    user_name: params.get("user_name") ?? "",
    command: params.get("command") ?? "",
    text: params.get("text") ?? "",
    response_url: params.get("response_url") ?? "",
    trigger_id: params.get("trigger_id") ?? "",
    api_app_id: params.get("api_app_id") ?? "",
  };
}

/**
 * Verify the Slack request signature
 */
function verifyRequest(
  request: Request,
  body: string,
  signingSecret: string,
): NextResponse | null {
  const headers = getSlackSignatureHeaders(request.headers);
  if (!headers) {
    return NextResponse.json(
      { error: "Missing Slack signature headers" },
      { status: 401 },
    );
  }

  const isValid = verifySlackSignature(
    signingSecret,
    headers.signature,
    headers.timestamp,
    body,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  return null;
}

/**
 * Handle /vm0 connect command
 */
async function handleLoginCommand(
  payload: SlackCommandPayload,
  installation: typeof slackInstallations.$inferSelect | undefined,
  userLink: { id: string; vm0UserId: string } | undefined,
  requestUrl: string,
): Promise<NextResponse> {
  // Already connected
  if (userLink && installation) {
    // Look up the workspace agent name
    let agentName: string | undefined;
    if (installation.defaultComposeId) {
      const [compose] = await globalThis.services.db
        .select({ name: agentComposes.name })
        .from(agentComposes)
        .where(eq(agentComposes.id, installation.defaultComposeId))
        .limit(1);
      agentName = compose?.name;
    }

    const agentLine = agentName
      ? `Your workspace agent is *${agentName}*.`
      : `No workspace agent configured yet.`;

    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildSuccessMessage(
        `You are already connected.\n\n${agentLine}\nMention \`@VM0\` in any channel or send a DM to start chatting with your agent.`,
      ),
    });
  }

  if (installation) {
    // Workspace already installed, go directly to link page on platform
    const platformUrl = getPlatformUrl();
    const linkUrl = `${platformUrl}/slack/connect?w=${encodeURIComponent(payload.team_id)}&u=${encodeURIComponent(payload.user_id)}&c=${encodeURIComponent(payload.channel_id)}`;
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildLoginMessage(linkUrl),
    });
  }

  // Workspace not installed, need OAuth flow
  const baseUrl = getSlackRedirectBaseUrl(requestUrl);
  const installUrl = `${baseUrl}/api/slack/oauth/install?w=${encodeURIComponent(payload.team_id)}&u=${encodeURIComponent(payload.user_id)}&c=${encodeURIComponent(payload.channel_id)}`;
  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildLoginMessage(installUrl),
  });
}

/**
 * Handle /vm0 disconnect command
 */
async function handleDisconnect(
  userLink: { id: string; vm0UserId: string } | undefined,
  installation: typeof slackInstallations.$inferSelect,
  client: ReturnType<typeof createSlackClient>,
  slackUserId: string,
): Promise<NextResponse> {
  if (!userLink) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage("You are not connected."),
    });
  }

  // Revoke agent permission
  const email = await getUserEmail(userLink.vm0UserId);
  if (email) {
    await removePermission(installation.defaultComposeId, "email", email);
  }

  // Delete user link
  await globalThis.services.db
    .delete(slackUserLinks)
    .where(eq(slackUserLinks.id, userLink.id));

  // Refresh App Home tab to reflect disconnected state
  await refreshAppHome(client, installation, slackUserId).catch((e) =>
    log.warn("Failed to refresh App Home after disconnect", { error: e }),
  );

  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildSuccessMessage(
      "You have been disconnected and your agent access has been revoked.",
    ),
  });
}

/**
 * Build login URL for unauthenticated users
 */
function buildLoginUrl(
  payload: SlackCommandPayload,
  requestUrl: string,
): string {
  const baseUrl = getSlackRedirectBaseUrl(requestUrl);
  return `${baseUrl}/api/slack/oauth/install?w=${encodeURIComponent(payload.team_id)}&u=${encodeURIComponent(payload.user_id)}&c=${encodeURIComponent(payload.channel_id)}`;
}

export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET, SECRETS_ENCRYPTION_KEY } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();

  const verifyError = verifyRequest(request, body, SLACK_SIGNING_SECRET);
  if (verifyError) {
    return verifyError;
  }

  const payload = parseCommandPayload(body);

  initServices();

  // Parse command text
  const args = payload.text.trim().split(/\s+/);
  const subCommand = args[0]?.toLowerCase() ?? "";

  // Get workspace installation
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, payload.team_id))
    .limit(1);

  const isAdmin = installation?.adminSlackUserId === payload.user_id;

  // Handle help command (doesn't require installation or linking)
  if (subCommand === "help" || subCommand === "") {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildHelpMessage({ isAdmin }),
    });
  }

  // Check if user is already linked
  const [userLink] = installation
    ? await globalThis.services.db
        .select()
        .from(slackUserLinks)
        .where(
          and(
            eq(slackUserLinks.slackUserId, payload.user_id),
            eq(slackUserLinks.slackWorkspaceId, payload.team_id),
          ),
        )
        .limit(1)
    : [];

  // Handle connect command
  if (subCommand === "connect") {
    return await handleLoginCommand(
      payload,
      installation,
      userLink,
      request.url,
    );
  }

  // Check installation for other commands
  if (!installation) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildLoginMessage(buildLoginUrl(payload, request.url)),
    });
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // Handle disconnect command
  if (subCommand === "disconnect") {
    return handleDisconnect(userLink, installation, client, payload.user_id);
  }

  // Check if user needs to link account
  if (!userLink) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildLoginMessage(buildLoginUrl(payload, request.url)),
    });
  }

  // Handle settings command
  if (subCommand === "settings") {
    return handleEnvironmentSetup(isAdmin);
  }

  // Unknown command
  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildHelpMessage({ isAdmin }),
  });
}

/**
 * Handle /vm0 settings - Return link to Platform settings page
 */
function handleEnvironmentSetup(isAdmin: boolean): NextResponse {
  const platformUrl = getPlatformUrl();
  const desc = isAdmin
    ? "Configure secrets, variables, and select the workspace agent on the VM0 platform."
    : "Configure your environment variables and secrets on the VM0 platform.";

  return NextResponse.json({
    response_type: "ephemeral",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:gear: *Settings*\n${desc}`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Open Platform" },
          url: `${platformUrl}/settings/slack`,
          action_id: "open_platform_settings",
        },
      },
    ],
  });
}
