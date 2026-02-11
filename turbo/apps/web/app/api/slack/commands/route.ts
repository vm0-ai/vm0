import { NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import {
  extractVariableReferences,
  groupVariablesBySource,
  getConnectorProvidedSecretNames,
} from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../src/lib/slack/verify";
import { slackInstallations } from "../../../../src/db/schema/slack-installation";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  getSlackRedirectBaseUrl,
  isSlackInvalidAuthError,
  refreshAppHome,
  resolveDefaultAgentComposeId,
} from "../../../../src/lib/slack";
import { listSecrets } from "../../../../src/lib/secret/secret-service";
import { listVariables } from "../../../../src/lib/variable/variable-service";
import {
  buildAgentManageModal,
  buildAgentComposeModal,
  buildHelpMessage,
  buildErrorMessage,
  buildSuccessMessage,
  buildLoginMessage,
  buildEnvironmentSetupModal,
} from "../../../../src/lib/slack/blocks";
import { logger } from "../../../../src/lib/logger";
import { listModelProviders } from "../../../../src/lib/model-provider/model-provider-service";
import { listConnectors } from "../../../../src/lib/connector/connector-service";
import { removePermission } from "../../../../src/lib/agent/permission-service";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";

const log = logger("slack:commands");

/**
 * Slack Slash Commands Endpoint
 *
 * POST /api/slack/commands
 *
 * Handles /vm0 slash commands:
 * - /vm0 agent manage - Select workspace agent (admin only)
 * - /vm0 agent compose - Compose agent from GitHub URL (admin only)
 * - /vm0 settings - Configure secrets/vars for workspace agent
 * - /vm0 admin transfer @user - Transfer admin role
 * - /vm0 help - Show help message
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
 * Check if a Slack user is the workspace admin
 */
function isAdmin(
  installation: typeof slackInstallations.$inferSelect,
  slackUserId: string,
): boolean {
  return installation.adminSlackUserId === slackUserId;
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
 * Handle agent subcommands
 */
async function handleAgentCommand(
  action: string,
  installation: typeof slackInstallations.$inferSelect,
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  vm0UserId: string,
): Promise<NextResponse> {
  switch (action) {
    case "compose":
      return handleAgentCompose(installation, client, payload);

    case "manage":
      return handleAgentManage(installation, client, payload, vm0UserId);

    // Legacy redirects
    case "link":
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          "The `link` command has been replaced.\n\nUse `/vm0 agent manage` instead (admin only).",
        ),
      });

    case "add":
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          "The `add` command has been replaced.\n\nUse `/vm0 agent manage` instead (admin only).",
        ),
      });

    case "list":
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          "The `list` command has been removed.\n\nThe workspace has a single shared agent.",
        ),
      });

    case "remove":
    case "unlink":
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          "The `unlink` command has been removed.\n\nUse `/vm0 agent manage` to change the workspace agent (admin only).",
        ),
      });

    case "update":
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          "The `update` command has been replaced.\n\nUse `/vm0 settings` instead.",
        ),
      });

    default:
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          `Unknown agent command: \`${action}\`\n\nAvailable commands:\n• \`/vm0 agent manage\` (admin)\n• \`/vm0 agent compose\` (admin)`,
        ),
      });
  }
}

/**
 * Handle settings subcommands
 */
async function handleSettingsCommand(
  action: string,
  installation: typeof slackInstallations.$inferSelect,
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  vm0UserId: string,
): Promise<NextResponse> {
  switch (action) {
    case "setup":
    case "":
      return handleEnvironmentSetup(installation, client, payload, vm0UserId);

    default:
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          `Unknown settings command: \`${action}\`\n\nAvailable commands:\n• \`/vm0 settings\``,
        ),
      });
  }
}

/**
 * Handle admin subcommands
 */
async function handleAdminCommand(
  action: string,
  args: string[],
  installation: typeof slackInstallations.$inferSelect,
  payload: SlackCommandPayload,
): Promise<NextResponse> {
  switch (action) {
    case "transfer":
      return handleAdminTransfer(installation, payload, args.slice(2));

    default:
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          `Unknown admin command: \`${action}\`\n\nAvailable commands:\n• \`/vm0 admin transfer @user\``,
        ),
      });
  }
}

/**
 * Handle /vm0 connect command
 */
function handleLoginCommand(
  payload: SlackCommandPayload,
  installation: { encryptedBotToken: string } | undefined,
  userLink: { id: string; vm0UserId: string } | undefined,
  requestUrl: string,
): NextResponse {
  // Already connected
  if (userLink) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildSuccessMessage(
        "You are already connected.\n\nUse `/vm0 settings` to configure your agent or `/vm0 help` for more commands.",
      ),
    });
  }

  const baseUrl = getSlackRedirectBaseUrl(requestUrl);

  if (installation) {
    // Workspace already installed, go directly to link page
    const linkUrl = `${baseUrl}/slack/link?w=${encodeURIComponent(payload.team_id)}&u=${encodeURIComponent(payload.user_id)}&c=${encodeURIComponent(payload.channel_id)}`;
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildLoginMessage(linkUrl),
    });
  }

  // Workspace not installed, need OAuth flow
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

  // Parse command text first (before checking installation)
  const args = payload.text.trim().split(/\s+/);
  const subCommand = args[0]?.toLowerCase() ?? "";
  const action = args[1]?.toLowerCase() ?? "";

  // Handle help command (doesn't require installation or linking)
  if (subCommand === "help" || subCommand === "") {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildHelpMessage(),
    });
  }

  // Get workspace installation
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, payload.team_id))
    .limit(1);

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

  // Handle login command
  if (subCommand === "connect") {
    return handleLoginCommand(payload, installation, userLink, request.url);
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

  // Handle logout command
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

  // Wrap commands that use Slack API in try/catch for invalid auth handling
  try {
    // Handle agent commands
    if (subCommand === "agent") {
      return await handleAgentCommand(
        action,
        installation,
        client,
        payload,
        userLink.vm0UserId,
      );
    }

    // Handle settings commands
    if (subCommand === "settings") {
      return await handleSettingsCommand(
        action,
        installation,
        client,
        payload,
        userLink.vm0UserId,
      );
    }

    // Handle admin commands
    if (subCommand === "admin") {
      return await handleAdminCommand(action, args, installation, payload);
    }
  } catch (err) {
    // If bot token is invalid, clear installation and prompt re-login
    if (isSlackInvalidAuthError(err)) {
      await globalThis.services.db
        .delete(slackInstallations)
        .where(eq(slackInstallations.slackWorkspaceId, payload.team_id));

      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          "Your Slack app authorization has expired.\n\nPlease use `/vm0 connect` to reconnect.",
        ),
      });
    }
    throw err;
  }

  // Unknown command
  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildHelpMessage(),
  });
}

/**
 * Handle /vm0 agent compose - Open modal to compose agent from GitHub URL (admin only)
 */
async function handleAgentCompose(
  installation: typeof slackInstallations.$inferSelect,
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
): Promise<NextResponse> {
  if (!isAdmin(installation, payload.user_id)) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage("Only the workspace admin can compose agents."),
    });
  }

  const modal = buildAgentComposeModal(payload.channel_id);

  await client.views.open({
    trigger_id: payload.trigger_id,
    view: modal,
  });

  return new NextResponse(null, { status: 200 });
}

/**
 * Handle /vm0 agent manage - Open modal to select workspace agent (admin only)
 */
async function handleAgentManage(
  installation: typeof slackInstallations.$inferSelect,
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  vm0UserId: string,
): Promise<NextResponse> {
  if (!isAdmin(installation, payload.user_id)) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "Only the workspace admin can manage the workspace agent.",
      ),
    });
  }

  // Fetch admin's available agents with their head version
  const composes = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.userId, vm0UserId));

  // Include the platform default agent (from SLACK_DEFAULT_AGENT env var)
  // so admin can always switch back to it
  const platformDefaultComposeId = await resolveDefaultAgentComposeId();
  if (
    platformDefaultComposeId &&
    !composes.some((c) => c.id === platformDefaultComposeId)
  ) {
    const [defaultCompose] = await globalThis.services.db
      .select({
        id: agentComposes.id,
        name: agentComposes.name,
        headVersionId: agentComposes.headVersionId,
      })
      .from(agentComposes)
      .where(eq(agentComposes.id, platformDefaultComposeId))
      .limit(1);
    if (defaultCompose) {
      composes.unshift(defaultCompose);
    }
  }

  if (composes.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "You don't have any agents yet.\n\nUse `/vm0 agent compose` to create one from a GitHub URL first.",
      ),
    });
  }

  // Get compose versions to extract required secrets
  const versionIds = composes
    .map((c) => c.headVersionId)
    .filter((id): id is string => id !== null);

  const versions =
    versionIds.length > 0
      ? await globalThis.services.db
          .select({
            id: agentComposeVersions.id,
            content: agentComposeVersions.content,
          })
          .from(agentComposeVersions)
          .where(inArray(agentComposeVersions.id, versionIds))
      : [];

  // Get user's existing secrets, variables, and connectors
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(vm0UserId),
    listVariables(vm0UserId),
    listConnectors(vm0UserId),
  ]);
  const connectorProvided = getConnectorProvidedSecretNames(
    userConnectors.map((c) => c.type),
  );
  const existingSecretNames = new Set([
    ...userSecrets.map((s) => s.name),
    ...connectorProvided,
  ]);
  const existingVarNames = new Set(userVars.map((v) => v.name));

  // Build map of compose ID to required secrets and vars
  const versionMap = new Map(versions.map((v) => [v.id, v.content]));
  const agentsWithSecrets = composes.map((c) => {
    const content = c.headVersionId ? versionMap.get(c.headVersionId) : null;
    const refs = content ? extractVariableReferences(content) : [];
    const grouped = groupVariablesBySource(refs);
    const requiredSecrets = grouped.secrets.map((s) => s.name);
    const requiredVars = grouped.vars.map((v) => v.name);
    return {
      id: c.id,
      name: c.name,
      requiredSecrets,
      existingSecrets: requiredSecrets.filter((name) =>
        existingSecretNames.has(name),
      ),
      requiredVars,
      existingVars: requiredVars.filter((name) => existingVarNames.has(name)),
    };
  });

  // Check model provider status
  const providers = await listModelProviders(vm0UserId);
  const hasModelProvider = providers.length > 0;

  // Pre-select current workspace agent if it's in the list
  const currentAgentId = composes.find(
    (c) => c.id === installation.defaultComposeId,
  )?.id;

  // Open modal with channel_id for confirmation message
  const modal = buildAgentManageModal(
    agentsWithSecrets,
    currentAgentId,
    payload.channel_id,
    hasModelProvider,
  );

  await client.views.open({
    trigger_id: payload.trigger_id,
    view: modal,
  });

  // Return empty response (Slack expects this when opening modal)
  return new NextResponse(null, { status: 200 });
}

/**
 * Handle /vm0 settings - Open modal to configure secrets/vars for workspace agent
 */
async function handleEnvironmentSetup(
  installation: typeof slackInstallations.$inferSelect,
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  vm0UserId: string,
): Promise<NextResponse> {
  // Load the workspace agent compose
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  if (!compose) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "The workspace agent could not be found. Please contact the workspace admin.",
      ),
    });
  }

  // Get compose version to extract required secrets/vars
  const versions = compose.headVersionId
    ? await globalThis.services.db
        .select({
          id: agentComposeVersions.id,
          composeId: agentComposeVersions.composeId,
          content: agentComposeVersions.content,
        })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, compose.headVersionId))
        .limit(1)
    : [];

  // Get user's existing secrets, variables, and connectors
  const [userSecrets, userVars, userConnectors] = await Promise.all([
    listSecrets(vm0UserId),
    listVariables(vm0UserId),
    listConnectors(vm0UserId),
  ]);
  const connectorProvided = getConnectorProvidedSecretNames(
    userConnectors.map((c) => c.type),
  );
  const existingSecretNames = new Set([
    ...userSecrets.map((s) => s.name),
    ...connectorProvided,
  ]);
  const existingVarNames = new Set(userVars.map((v) => v.name));

  const version = versions[0];
  const content = version ? version.content : null;
  const refs = content ? extractVariableReferences(content) : [];
  const grouped = groupVariablesBySource(refs);
  const requiredSecrets = grouped.secrets.map((s) => s.name);
  const requiredVars = grouped.vars.map((v) => v.name);

  const agentWithSecrets = {
    id: compose.id,
    name: compose.name,
    requiredSecrets,
    existingSecrets: requiredSecrets.filter((name) =>
      existingSecretNames.has(name),
    ),
    requiredVars,
    existingVars: requiredVars.filter((name) => existingVarNames.has(name)),
  };

  // Open modal pre-selected to the workspace agent
  const modal = buildEnvironmentSetupModal(
    agentWithSecrets,
    payload.channel_id,
  );

  await client.views.open({
    trigger_id: payload.trigger_id,
    view: modal,
  });

  // Return empty response (Slack expects this when opening modal)
  return new NextResponse(null, { status: 200 });
}

/**
 * Handle /vm0 admin transfer @user - Transfer admin role to another user
 */
async function handleAdminTransfer(
  installation: typeof slackInstallations.$inferSelect,
  payload: SlackCommandPayload,
  transferArgs: string[],
): Promise<NextResponse> {
  if (!isAdmin(installation, payload.user_id)) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "Only the workspace admin can transfer the admin role.",
      ),
    });
  }

  // Parse @user mention from command text (Slack format: <@U12345> or <@U12345|username>)
  const mentionText = transferArgs[0] ?? "";
  const mentionMatch = mentionText.match(/^<@(U[A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (!mentionMatch) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "Please mention the user to transfer admin to.\n\nUsage: `/vm0 admin transfer @user`",
      ),
    });
  }

  const targetSlackUserId = mentionMatch[1]!;

  // Cannot transfer to self
  if (targetSlackUserId === payload.user_id) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage("You are already the workspace admin."),
    });
  }

  // Verify target user is connected
  const [targetLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, targetSlackUserId),
        eq(slackUserLinks.slackWorkspaceId, payload.team_id),
      ),
    )
    .limit(1);

  if (!targetLink) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "The target user is not connected to VM0.\n\nThey must use `/vm0 connect` first.",
      ),
    });
  }

  // Update admin
  await globalThis.services.db
    .update(slackInstallations)
    .set({
      adminSlackUserId: targetSlackUserId,
      updatedAt: new Date(),
    })
    .where(eq(slackInstallations.id, installation.id));

  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildSuccessMessage(
      `Admin role has been transferred to <@${targetSlackUserId}>.`,
    ),
  });
}
