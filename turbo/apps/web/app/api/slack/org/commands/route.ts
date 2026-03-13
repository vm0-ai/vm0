import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../../src/lib/slack/verify";
import { slackOrgInstallations } from "../../../../../src/db/schema/slack-org-installation";
import { slackOrgConnections } from "../../../../../src/db/schema/slack-org-connection";
import { decryptSecretValue } from "../../../../../src/lib/crypto/secrets-encryption";
import { createSlackClient } from "../../../../../src/lib/slack/client";
import {
  buildHelpMessage,
  buildErrorMessage,
  buildSuccessMessage,
  buildLoginMessage,
} from "../../../../../src/lib/slack/blocks";
import { disconnect } from "../../../../../src/lib/slack-org/connect-service";
import { refreshOrgAppHome } from "../../../../../src/lib/slack-org/handlers/app-home";
import {
  resolveDefaultComposeId,
  buildOrgConnectUrl,
  getWorkspaceAgent,
} from "../../../../../src/lib/slack-org/handlers/shared";
import { getPlatformUrl } from "../../../../../src/lib/url";
import { logger } from "../../../../../src/lib/logger";
import { removePermission } from "../../../../../src/lib/agent/permission-service";
import { getUserEmail } from "../../../../../src/lib/auth/get-user-email";

const log = logger("slack-org:commands");

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

function ephemeral(blocks: unknown[]) {
  return NextResponse.json({ response_type: "ephemeral", blocks });
}

/**
 * Handle /vm0 connect command.
 */
async function handleConnect(
  payload: SlackCommandPayload,
  installation: typeof slackOrgInstallations.$inferSelect,
): Promise<NextResponse> {
  // Check if already connected
  const [existingConnection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, payload.user_id),
        eq(slackOrgConnections.slackWorkspaceId, payload.team_id),
      ),
    )
    .limit(1);

  if (existingConnection) {
    let agentName: string | undefined;
    if (installation.orgId) {
      const composeId = await resolveDefaultComposeId(installation.orgId);
      if (composeId) {
        const agent = await getWorkspaceAgent(composeId);
        agentName = agent?.name;
      }
    }

    const agentLine = agentName
      ? `Your workspace agent is *${agentName}*.`
      : `No workspace agent configured yet.`;

    return ephemeral(
      buildSuccessMessage(
        `You are already connected.\n\n${agentLine}\nMention \`@VM0\` in any channel or send a DM to start chatting with your agent.`,
      ),
    );
  }

  const connectUrl = buildOrgConnectUrl(
    payload.team_id,
    payload.user_id,
    payload.channel_id,
  );
  return ephemeral(buildLoginMessage(connectUrl));
}

/**
 * Handle /vm0 disconnect command.
 */
async function handleDisconnect(
  payload: SlackCommandPayload,
  installation: typeof slackOrgInstallations.$inferSelect,
  connection: typeof slackOrgConnections.$inferSelect,
): Promise<NextResponse> {
  // Revoke agent permission
  if (installation.orgId) {
    const composeId = await resolveDefaultComposeId(installation.orgId);
    if (composeId) {
      const email = await getUserEmail(connection.vm0UserId);
      if (email) {
        await removePermission(composeId, "email", email);
      }
    }
  }

  await disconnect({
    connectionId: connection.id,
    userId: connection.vm0UserId,
  });

  // Refresh App Home
  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshOrgAppHome(client, installation, payload.user_id).catch((e) =>
    log.warn("Failed to refresh App Home after disconnect", { error: e }),
  );

  return ephemeral(
    buildSuccessMessage(
      "You have been disconnected and your agent access has been revoked.",
    ),
  );
}

/**
 * POST /api/slack/org/commands
 *
 * Org-aware slash commands handler.
 * Handles /vm0 connect, disconnect, settings, help.
 */
export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  const body = await request.text();
  const headers = getSlackSignatureHeaders(request.headers);
  if (!headers) {
    return NextResponse.json(
      { error: "Missing Slack signature headers" },
      { status: 401 },
    );
  }

  const isValid = verifySlackSignature(
    SLACK_SIGNING_SECRET,
    headers.signature,
    headers.timestamp,
    body,
  );

  if (!isValid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = parseCommandPayload(body);

  initServices();

  const args = payload.text.trim().split(/\s+/);
  const subCommand = args[0]?.toLowerCase() ?? "";

  // Get workspace installation
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, payload.team_id))
    .limit(1);

  // Handle help command (doesn't require installation)
  if (subCommand === "help" || subCommand === "") {
    return ephemeral(buildHelpMessage({ isAdmin: false }));
  }

  // Handle connect command
  if (subCommand === "connect") {
    if (!installation) {
      return ephemeral(
        buildErrorMessage(
          "The VM0 Slack app is not installed in this workspace. Please ask your workspace admin to install it first.",
        ),
      );
    }
    return handleConnect(payload, installation);
  }

  // Other commands require installation
  if (!installation) {
    return ephemeral(
      buildErrorMessage(
        "The VM0 Slack app is not installed in this workspace.",
      ),
    );
  }

  // Check if user is connected
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, payload.user_id),
        eq(slackOrgConnections.slackWorkspaceId, payload.team_id),
      ),
    )
    .limit(1);

  // Handle disconnect command
  if (subCommand === "disconnect") {
    if (!connection) {
      return ephemeral(buildErrorMessage("You are not connected."));
    }
    return handleDisconnect(payload, installation, connection);
  }

  // Check connection for remaining commands
  if (!connection) {
    const connectUrl = buildOrgConnectUrl(
      payload.team_id,
      payload.user_id,
      payload.channel_id,
    );
    return ephemeral(buildLoginMessage(connectUrl));
  }

  // Handle settings command
  if (subCommand === "settings") {
    const platformUrl = getPlatformUrl();
    return ephemeral([
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:gear: *Settings*\nConfigure your workspace agent and settings on the VM0 platform.`,
        },
        accessory: {
          type: "button",
          text: { type: "plain_text", text: "Open Platform" },
          url: `${platformUrl}/settings/slack`,
          action_id: "open_platform_settings",
        },
      },
    ]);
  }

  // Unknown command
  return ephemeral(buildHelpMessage({ isAdmin: false }));
}
