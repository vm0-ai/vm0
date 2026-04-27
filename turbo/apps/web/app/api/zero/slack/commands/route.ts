import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { env } from "../../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../../src/lib/zero/slack/verify";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import {
  createSlackClient,
  openView,
} from "../../../../../src/lib/zero/slack/client";
import {
  buildHelpMessage,
  buildErrorMessage,
  buildSuccessMessage,
  buildLoginMessage,
  buildAgentPickerModal,
} from "../../../../../src/lib/zero/slack/blocks";
import { disconnect } from "../../../../../src/lib/zero/slack-org/connect-service";
import { refreshOrgAppHome } from "../../../../../src/lib/zero/slack-org/handlers/app-home";
import {
  buildOrgConnectUrl,
  getUserAgentPreference,
  getWorkspaceAgent,
  resolveDefaultComposeId,
} from "../../../../../src/lib/zero/slack-org/handlers/shared";
import { listComposes } from "../../../../../src/lib/zero/zero-compose-service";
import { getAppUrl } from "../../../../../src/lib/zero/url";
import { logger } from "../../../../../src/lib/shared/logger";

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
  _installation: typeof slackOrgInstallations.$inferSelect,
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
    return ephemeral(
      buildSuccessMessage(
        `You are already connected.\nMention \`@Zero\` in any channel or send a DM to start chatting with your agent.`,
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
  // Disconnect first (critical path)
  await disconnect({
    connectionId: connection.id,
    userId: connection.vm0UserId,
  });

  // Best-effort: refresh App Home (non-blocking to avoid Slack timeout)
  void (async () => {
    const { SECRETS_ENCRYPTION_KEY } = env();
    const botToken = decryptSecretValue(
      installation.encryptedBotToken,
      SECRETS_ENCRYPTION_KEY,
    );
    const client = createSlackClient(botToken);
    await refreshOrgAppHome(client, installation, payload.user_id).catch(
      (e) => {
        return log.warn("Failed to refresh App Home after disconnect", {
          error: e,
        });
      },
    );
  })().catch((e) => {
    return log.warn("Post-disconnect cleanup failed", { error: e });
  });

  return ephemeral(
    buildSuccessMessage(
      "You have been disconnected and your agent access has been revoked.",
    ),
  );
}

const AGENT_PICKER_MAX_OPTIONS = 100;

/**
 * Handle /zero switch command — opens the per-user agent picker modal.
 */
async function handleSwitch(
  payload: SlackCommandPayload,
  installation: typeof slackOrgInstallations.$inferSelect,
  connection: typeof slackOrgConnections.$inferSelect,
): Promise<NextResponse> {
  if (!installation.orgId) {
    return ephemeral(
      buildErrorMessage(
        "This workspace is not bound to an org. Please contact your admin.",
      ),
    );
  }

  if (!payload.trigger_id) {
    return ephemeral(
      buildErrorMessage("Couldn't open the agent picker — please try again."),
    );
  }

  const orgId = installation.orgId;
  const { composes } = await listComposes(orgId);
  const defaultComposeId = await resolveDefaultComposeId(orgId);

  const pickerOptions = composes
    .filter((compose) => {
      return compose.id !== defaultComposeId;
    })
    .slice(0, AGENT_PICKER_MAX_OPTIONS)
    .map((compose) => {
      return {
        composeId: compose.id,
        name: compose.name,
        displayName: compose.displayName,
      };
    });

  let orgDefaultName: string | null = null;
  if (defaultComposeId) {
    const agent = await getWorkspaceAgent(defaultComposeId);
    orgDefaultName = agent?.displayName ?? agent?.name ?? null;
  }

  const currentOverride = await getUserAgentPreference(
    connection.vm0UserId,
    orgId,
  );

  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const modal = buildAgentPickerModal({
    options: pickerOptions,
    currentSelectedId: currentOverride,
    orgDefaultName,
    privateMetadata: JSON.stringify({ channelId: payload.channel_id }),
  });

  try {
    await openView(client, payload.trigger_id, modal);
  } catch (err) {
    log.warn("Failed to open agent picker modal", { error: err });
    return ephemeral(
      buildErrorMessage("Couldn't open the agent picker — please try again."),
    );
  }

  return new NextResponse("", { status: 200 });
}

function buildNotInstalledMessage(detail?: string): unknown[] {
  const appUrl = getAppUrl();
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          detail ??
          "The Zero Slack app hasn't been set up for this workspace yet.",
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Set up on Platform" },
          url: `${appUrl}/works`,
          action_id: "open_platform_setup",
        },
      ],
    },
  ];
}

/**
 * POST /api/zero/slack/commands
 *
 * Org-aware slash commands handler.
 * Handles /vm0 connect, disconnect, help.
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

  const canSwitchAgents = Boolean(installation?.orgId);

  // Handle help command (doesn't require installation)
  if (subCommand === "help" || subCommand === "") {
    return ephemeral(buildHelpMessage({ canSwitch: canSwitchAgents }));
  }

  // Handle connect command
  if (subCommand === "connect") {
    if (!installation) {
      return ephemeral(
        buildNotInstalledMessage(
          "The Zero Slack app hasn't been set up for this workspace yet. An org admin can complete the setup from the platform.",
        ),
      );
    }
    return handleConnect(payload, installation);
  }

  // Other commands require installation
  if (!installation) {
    return ephemeral(buildNotInstalledMessage());
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

  // Handle switch command
  if (subCommand === "switch") {
    return handleSwitch(payload, installation, connection);
  }

  // Unknown command
  return ephemeral(buildHelpMessage({ canSwitch: canSwitchAgents }));
}
