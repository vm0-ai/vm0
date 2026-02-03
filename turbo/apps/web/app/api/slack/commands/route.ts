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
import { slackBindings } from "../../../../src/db/schema/slack-binding";
import { agentComposes } from "../../../../src/db/schema/agent-compose";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import { createSlackClient } from "../../../../src/lib/slack";
import {
  buildAgentAddModal,
  buildAgentListMessage,
  buildHelpMessage,
  buildErrorMessage,
  buildSuccessMessage,
  buildLinkAccountMessage,
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
      return handleAgentAdd(client, payload, vm0UserId);

    case "list":
      return handleAgentList(userLinkId);

    case "remove": {
      const agentName = args[2];
      if (!agentName) {
        return NextResponse.json({
          response_type: "ephemeral",
          blocks: buildErrorMessage(
            "Please specify an agent name: `/vm0 agent remove <name>`",
          ),
        });
      }
      return handleAgentRemove(userLinkId, agentName);
    }

    default:
      return NextResponse.json({
        response_type: "ephemeral",
        blocks: buildErrorMessage(
          `Unknown agent command: \`${action}\`\n\nAvailable commands:\n• \`/vm0 agent add\`\n• \`/vm0 agent list\`\n• \`/vm0 agent remove <name>\``,
        ),
      });
  }
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

  // Get workspace installation
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, payload.team_id))
    .limit(1);

  if (!installation) {
    return NextResponse.json({
      response_type: "ephemeral",
      text: "VM0 is not installed in this workspace.",
    });
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  // Check if user is linked
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, payload.user_id),
        eq(slackUserLinks.slackWorkspaceId, payload.team_id),
      ),
    )
    .limit(1);

  // Parse command text
  const args = payload.text.trim().split(/\s+/);
  const subCommand = args[0]?.toLowerCase() ?? "";
  const action = args[1]?.toLowerCase() ?? "";

  // Handle help command (doesn't require linking)
  if (subCommand === "help" || subCommand === "") {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildHelpMessage(),
    });
  }

  // Check if user needs to link account
  if (!userLink) {
    const { SLACK_REDIRECT_BASE_URL } = env();
    const baseUrl = SLACK_REDIRECT_BASE_URL ?? "https://www.vm0.ai";
    const linkUrl = `${baseUrl}/slack/link?w=${payload.team_id}&u=${payload.user_id}`;

    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildLinkAccountMessage(linkUrl),
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
): Promise<NextResponse> {
  // Fetch user's available agents
  const composes = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
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

  // Open modal
  const modal = buildAgentAddModal(
    composes.map((c) => ({ id: c.id, name: c.name })),
  );

  await client.views.open({
    trigger_id: payload.trigger_id,
    view: modal,
  });

  // Return empty response (Slack expects this when opening modal)
  return NextResponse.json({});
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
 * Handle /vm0 agent remove - Remove agent binding
 */
async function handleAgentRemove(
  userLinkId: string,
  agentName: string,
): Promise<NextResponse> {
  // Find binding
  const [binding] = await globalThis.services.db
    .select()
    .from(slackBindings)
    .where(
      and(
        eq(slackBindings.slackUserLinkId, userLinkId),
        eq(slackBindings.agentName, agentName.toLowerCase()),
      ),
    )
    .limit(1);

  if (!binding) {
    return NextResponse.json({
      response_type: "ephemeral",
      blocks: buildErrorMessage(
        `Agent "${agentName}" not found.\n\nUse \`/vm0 agent list\` to see your agents.`,
      ),
    });
  }

  // Delete binding
  await globalThis.services.db
    .delete(slackBindings)
    .where(eq(slackBindings.id, binding.id));

  return NextResponse.json({
    response_type: "ephemeral",
    blocks: buildSuccessMessage(`Agent "${agentName}" has been removed.`),
  });
}
