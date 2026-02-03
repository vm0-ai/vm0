import { NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { extractVariableReferences, groupVariablesBySource } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { env } from "../../../../src/env";
import {
  verifySlackSignature,
  getSlackSignatureHeaders,
} from "../../../../src/lib/slack/verify";
import { slackInstallations } from "../../../../src/db/schema/slack-installation";
import { slackUserLinks } from "../../../../src/db/schema/slack-user-link";
import { slackBindings } from "../../../../src/db/schema/slack-binding";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  getSlackRedirectBaseUrl,
} from "../../../../src/lib/slack";
import {
  buildAgentAddModal,
  buildAgentListMessage,
  buildHelpMessage,
  buildErrorMessage,
  buildSuccessMessage,
  buildLoginMessage,
  buildAgentRemoveModal,
  buildAgentUpdateModal,
} from "../../../../src/lib/slack/blocks";

/**
 * Slack Slash Commands Endpoint
 *
 * POST /api/slack/commands
 *
 * Handles /vm0 slash commands:
 * - /vm0 agent add - Open add agent modal
 * - /vm0 agent list - List bound agents
 * - /vm0 agent remove <name> - Remove agent binding
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
  args: string[],
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  userLinkId: string,
  vm0UserId: string,
): Promise<NextResponse> {
  switch (action) {
    case "add":
      return handleAgentAdd(client, payload, vm0UserId, userLinkId);

    case "list":
      return handleAgentList(userLinkId);

    case "remove":
      return handleAgentRemove(client, payload, userLinkId);

    case "update":
      return handleAgentUpdate(client, payload, vm0UserId, userLinkId);

    default:
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          `Unknown agent command: \`${action}\`\n\nAvailable commands:\n• \`/vm0 agent add\`\n• \`/vm0 agent list\`\n• \`/vm0 agent update\`\n• \`/vm0 agent remove\``,
        ),
      });
  }
}

/**
 * Handle /vm0 login command
 */
function handleLoginCommand(
  payload: SlackCommandPayload,
  installation: { encryptedBotToken: string } | undefined,
  userLink: { id: string; vm0UserId: string } | undefined,
  requestUrl: string,
): NextResponse {
  // Already logged in
  if (userLink) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildSuccessMessage(
        "You are already logged in.\n\nUse `/vm0 agent add` to add an agent or `/vm0 help` for more commands.",
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
 * Handle /vm0 logout command
 */
async function handleLogoutCommand(
  userLink: { id: string } | undefined,
): Promise<NextResponse> {
  if (!userLink) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage("You are not logged in."),
    });
  }
  // Delete user link and associated bindings
  await globalThis.services.db
    .delete(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLink.id));
  await globalThis.services.db
    .delete(slackUserLinks)
    .where(eq(slackUserLinks.id, userLink.id));
  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildSuccessMessage("You have been logged out successfully."),
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
  return `${baseUrl}/api/slack/oauth/install?w=${encodeURIComponent(payload.team_id)}&u=${encodeURIComponent(payload.user_id)}`;
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
  if (subCommand === "login") {
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
  if (subCommand === "logout") {
    return handleLogoutCommand(userLink);
  }

  // Check if user needs to link account
  if (!userLink) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildLoginMessage(buildLoginUrl(payload, request.url)),
    });
  }

  // Handle agent commands
  if (subCommand === "agent") {
    return handleAgentCommand(
      action,
      args,
      client,
      payload,
      userLink.id,
      userLink.vm0UserId,
    );
  }

  // Unknown command
  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildHelpMessage(),
  });
}

/**
 * Handle /vm0 agent add - Open modal to add agent
 */
async function handleAgentAdd(
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  vm0UserId: string,
  userLinkId: string,
): Promise<NextResponse> {
  // Fetch user's available agents with their head version
  const composes = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.userId, vm0UserId));

  if (composes.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "You don't have any agents in VM0 yet.\n\nCreate one first with the VM0 CLI: `vm0 build`",
      ),
    });
  }

  // Get already bound agent names
  const existingBindings = await globalThis.services.db
    .select({ agentName: slackBindings.agentName })
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLinkId));

  const boundNames = new Set(existingBindings.map((b) => b.agentName));

  // Filter out already bound agents
  const availableComposes = composes.filter(
    (c) => !boundNames.has(c.name.toLowerCase()),
  );

  if (availableComposes.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "All your agents are already added.\n\nUse `/vm0 agent list` to see them or `/vm0 agent remove <name>` to remove one.",
      ),
    });
  }

  // Get compose versions to extract required secrets
  const versionIds = availableComposes
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

  // Build map of compose ID to required secrets
  const versionMap = new Map(versions.map((v) => [v.id, v.content]));
  const agentsWithSecrets = availableComposes.map((c) => {
    const content = c.headVersionId ? versionMap.get(c.headVersionId) : null;
    const refs = content ? extractVariableReferences(content) : [];
    const grouped = groupVariablesBySource(refs);
    return {
      id: c.id,
      name: c.name,
      requiredSecrets: grouped.secrets.map((s) => s.name),
    };
  });

  // Open modal with channel_id for confirmation message
  const modal = buildAgentAddModal(
    agentsWithSecrets,
    undefined,
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
 * Handle /vm0 agent list - List bound agents
 */
async function handleAgentList(userLinkId: string): Promise<NextResponse> {
  const bindings = await globalThis.services.db
    .select({
      agentName: slackBindings.agentName,
      description: slackBindings.description,
      enabled: slackBindings.enabled,
    })
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLinkId));

  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildAgentListMessage(bindings),
  });
}

/**
 * Handle /vm0 agent remove - Open modal to select agents to remove
 */
async function handleAgentRemove(
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  userLinkId: string,
): Promise<NextResponse> {
  // Get user's bound agents
  const bindings = await globalThis.services.db
    .select({
      id: slackBindings.id,
      agentName: slackBindings.agentName,
    })
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLinkId));

  if (bindings.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "You don't have any agents to remove.\n\nUse `/vm0 agent add` to add one first.",
      ),
    });
  }

  // Open modal with multi-select
  const modal = buildAgentRemoveModal(bindings, payload.channel_id);

  await client.views.open({
    trigger_id: payload.trigger_id,
    view: modal,
  });

  // Return empty response (Slack expects this when opening modal)
  return new NextResponse(null, { status: 200 });
}

/**
 * Handle /vm0 agent update - Open modal to update agent secrets
 */
async function handleAgentUpdate(
  client: ReturnType<typeof createSlackClient>,
  payload: SlackCommandPayload,
  vm0UserId: string,
  userLinkId: string,
): Promise<NextResponse> {
  // Get user's bound agents with their compose IDs
  const bindings = await globalThis.services.db
    .select({
      id: slackBindings.id,
      agentName: slackBindings.agentName,
      composeId: slackBindings.composeId,
    })
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLinkId));

  if (bindings.length === 0) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        "You don't have any agents to update.\n\nUse `/vm0 agent add` to add one first.",
      ),
    });
  }

  // Get compose versions to extract required secrets
  const composeIds = bindings.map((b) => b.composeId);
  const composes = await globalThis.services.db
    .select({
      id: agentComposes.id,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(inArray(agentComposes.id, composeIds));

  const versionIds = composes
    .map((c) => c.headVersionId)
    .filter((id): id is string => id !== null);

  const versions =
    versionIds.length > 0
      ? await globalThis.services.db
          .select({
            id: agentComposeVersions.id,
            composeId: agentComposeVersions.composeId,
            content: agentComposeVersions.content,
          })
          .from(agentComposeVersions)
          .where(inArray(agentComposeVersions.id, versionIds))
      : [];

  // Build map of compose ID to required secrets
  const composeToVersion = new Map(
    composes.map((c) => [c.id, c.headVersionId]),
  );
  const versionMap = new Map(versions.map((v) => [v.id, v.content]));

  const agentsWithSecrets = bindings.map((b) => {
    const versionId = composeToVersion.get(b.composeId);
    const content = versionId ? versionMap.get(versionId) : null;
    const refs = content ? extractVariableReferences(content) : [];
    const grouped = groupVariablesBySource(refs);
    return {
      id: b.id,
      name: b.agentName,
      requiredSecrets: grouped.secrets.map((s) => s.name),
    };
  });

  // Open modal
  const modal = buildAgentUpdateModal(
    agentsWithSecrets,
    undefined,
    payload.channel_id,
  );

  await client.views.open({
    trigger_id: payload.trigger_id,
    view: modal,
  });

  // Return empty response (Slack expects this when opening modal)
  return new NextResponse(null, { status: 200 });
}
