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
import {
  buildAgentAddModal,
  buildAgentUpdateModal,
} from "../../../../src/lib/slack/blocks";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  isSlackInvalidAuthError,
  refreshAppHome,
} from "../../../../src/lib/slack";
import {
  listSecrets,
  setSecret,
} from "../../../../src/lib/secret/secret-service";
import {
  listVariables,
  setVariable,
} from "../../../../src/lib/variable/variable-service";
import { logger } from "../../../../src/lib/logger";
import { slackComposeRequests } from "../../../../src/db/schema/slack-compose-request";
import { generateEphemeralCliToken } from "../../../../src/lib/auth/cli-token-service";
import { triggerComposeJob } from "../../../../src/lib/compose/trigger-compose-job";

const log = logger("slack:interactive");

/**
 * Slack Interactive Components Endpoint
 *
 * POST /api/slack/interactive
 *
 * Handles interactive component callbacks:
 * - view_submission - Modal form submissions
 * - block_actions - Button clicks, select changes
 */

interface SlackInteractivePayload {
  type: "view_submission" | "block_actions" | "shortcut";
  user: {
    id: string;
    username: string;
    team_id: string;
  };
  team: {
    id: string;
    domain: string;
  };
  trigger_id?: string;
  view?: {
    id: string;
    callback_id: string;
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            type: string;
            value?: string;
            selected_option?: { value: string };
            selected_options?: Array<{ value: string }>;
          }
        >
      >;
    };
    private_metadata?: string;
  };
  actions?: Array<{
    action_id: string;
    block_id: string;
    value?: string;
    selected_option?: { value: string };
  }>;
  response_url?: string;
  channel?: {
    id: string;
    name: string;
  };
}

export async function POST(request: Request) {
  const { SLACK_SIGNING_SECRET } = env();

  if (!SLACK_SIGNING_SECRET) {
    return NextResponse.json(
      { error: "Slack integration is not configured" },
      { status: 503 },
    );
  }

  // Get raw body for signature verification
  const body = await request.text();

  // Verify Slack signature
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

  // Parse URL-encoded form data (payload is in 'payload' field)
  const params = new URLSearchParams(body);
  const payloadStr = params.get("payload");

  if (!payloadStr) {
    return NextResponse.json({ error: "Missing payload" }, { status: 400 });
  }

  let payload: SlackInteractivePayload;
  try {
    payload = JSON.parse(payloadStr) as SlackInteractivePayload;
  } catch {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  initServices();

  // Handle different interaction types
  switch (payload.type) {
    case "view_submission":
      return handleViewSubmission(payload);

    case "block_actions":
      return handleBlockActions(payload);

    default:
      return new Response("", { status: 200 });
  }
}

/**
 * Fetch available agents for add modal from database
 */
async function fetchAvailableAgents(
  vm0UserId: string,
  userLinkId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    requiredSecrets: string[];
    existingSecrets: string[];
    requiredVars: string[];
    existingVars: string[];
  }>
> {
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
    return [];
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
    return [];
  }

  // Get compose versions to extract required secrets and vars
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

  // Get user's existing secrets and variables
  const [userSecrets, userVars] = await Promise.all([
    listSecrets(vm0UserId),
    listVariables(vm0UserId),
  ]);
  const existingSecretNames = new Set(userSecrets.map((s) => s.name));
  const existingVarNames = new Set(userVars.map((v) => v.name));

  // Build map of compose ID to required secrets and vars
  const versionMap = new Map(versions.map((v) => [v.id, v.content]));
  return availableComposes.map((c) => {
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
}

/**
 * Fetch bound agents for update modal from database
 */
async function fetchBoundAgents(
  vm0UserId: string,
  userLinkId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    description: string | null;
    requiredSecrets: string[];
    existingSecrets: string[];
    requiredVars: string[];
    existingVars: string[];
  }>
> {
  // Get user's bound agents with their compose IDs
  const bindings = await globalThis.services.db
    .select({
      id: slackBindings.id,
      agentName: slackBindings.agentName,
      description: slackBindings.description,
      composeId: slackBindings.composeId,
    })
    .from(slackBindings)
    .where(eq(slackBindings.slackUserLinkId, userLinkId));

  if (bindings.length === 0) {
    return [];
  }

  // Get compose versions to extract required secrets and vars
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

  // Get user's existing secrets and variables
  const [userSecrets, userVars] = await Promise.all([
    listSecrets(vm0UserId),
    listVariables(vm0UserId),
  ]);
  const existingSecretNames = new Set(userSecrets.map((s) => s.name));
  const existingVarNames = new Set(userVars.map((v) => v.name));

  // Build map of compose ID to required secrets and vars
  const composeToVersion = new Map(
    composes.map((c) => [c.id, c.headVersionId]),
  );
  const versionMap = new Map(versions.map((v) => [v.id, v.content]));

  return bindings.map((b) => {
    const versionId = composeToVersion.get(b.composeId);
    const content = versionId ? versionMap.get(versionId) : null;
    const refs = content ? extractVariableReferences(content) : [];
    const grouped = groupVariablesBySource(refs);
    const requiredSecrets = grouped.secrets.map((s) => s.name);
    const requiredVars = grouped.vars.map((v) => v.name);
    return {
      id: b.id,
      name: b.agentName,
      description: b.description,
      requiredSecrets,
      existingSecrets: requiredSecrets.filter((name) =>
        existingSecretNames.has(name),
      ),
      requiredVars,
      existingVars: requiredVars.filter((name) => existingVarNames.has(name)),
    };
  });
}

/**
 * Update modal view with error handling for invalid auth
 */
async function updateModalView(
  client: ReturnType<typeof createSlackClient>,
  viewId: string,
  view: ReturnType<typeof buildAgentAddModal>,
  workspaceId: string,
): Promise<void> {
  try {
    await client.views.update({
      view_id: viewId,
      view,
    });
  } catch (err) {
    if (isSlackInvalidAuthError(err)) {
      // Clear invalid installation - user will need to re-login
      await globalThis.services.db
        .delete(slackInstallations)
        .where(eq(slackInstallations.slackWorkspaceId, workspaceId));
    }
    throw err;
  }
}

/**
 * Get an authenticated Slack client for a workspace
 */
async function getSlackClientForWorkspace(
  workspaceId: string,
): Promise<ReturnType<typeof createSlackClient> | null> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) return null;

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  return createSlackClient(botToken);
}

/**
 * Get a user link by Slack user ID and workspace ID
 */
async function getUserLink(slackUserId: string, workspaceId: string) {
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, slackUserId),
        eq(slackUserLinks.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);
  return userLink ?? null;
}

/**
 * Handle agent selection in add modal
 */
async function handleAgentAddSelection(
  payload: SlackInteractivePayload,
  selectedAgentId: string,
): Promise<void> {
  const privateMetadata = payload.view?.private_metadata;
  const { channelId } = privateMetadata
    ? (JSON.parse(privateMetadata) as { channelId?: string })
    : { channelId: undefined };

  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const agents = await fetchAvailableAgents(userLink.vm0UserId, userLink.id);
  const updatedModal = buildAgentAddModal(agents, selectedAgentId, channelId);

  await updateModalView(
    client,
    payload.view!.id,
    updatedModal,
    payload.team.id,
  );
}

/**
 * Handle agent selection in update modal
 */
async function handleAgentUpdateSelection(
  payload: SlackInteractivePayload,
  selectedAgentId: string,
): Promise<void> {
  const privateMetadata = payload.view?.private_metadata;
  const { channelId } = privateMetadata
    ? (JSON.parse(privateMetadata) as { channelId?: string })
    : { channelId: undefined };

  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const agents = await fetchBoundAgents(userLink.vm0UserId, userLink.id);
  const updatedModal = buildAgentUpdateModal(
    agents,
    selectedAgentId,
    channelId,
  );

  await updateModalView(
    client,
    payload.view!.id,
    updatedModal,
    payload.team.id,
  );
}

/**
 * Handle mode switching in add agent modal (existing agent vs GitHub URL)
 */
async function handleLinkModeSwitch(
  payload: SlackInteractivePayload,
  selectedMode: string,
): Promise<void> {
  const { SECRETS_ENCRYPTION_KEY } = env();
  const privateMetadata = payload.view?.private_metadata;
  const { channelId } = privateMetadata
    ? (JSON.parse(privateMetadata) as { channelId?: string })
    : { channelId: undefined };

  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, payload.team.id))
    .limit(1);

  if (!installation) return;

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const mode = selectedMode === "github" ? "github" : "existing";

  // Fetch agents for "existing" mode
  const agents =
    mode === "existing" ? await fetchAgentsForModeSwitch(payload) : [];

  const updatedModal = buildAgentAddModal(agents, undefined, channelId, mode);

  await updateModalView(
    client,
    payload.view!.id,
    updatedModal,
    payload.team.id,
  );
}

/**
 * Fetch available agents for mode switch (helper to avoid full re-fetch when switching to github mode)
 */
async function fetchAgentsForModeSwitch(
  payload: SlackInteractivePayload,
): ReturnType<typeof fetchAvailableAgents> {
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, payload.user.id),
        eq(slackUserLinks.slackWorkspaceId, payload.team.id),
      ),
    )
    .limit(1);

  if (!userLink) return [];

  return fetchAvailableAgents(userLink.vm0UserId, userLink.id);
}

/**
 * Handle block actions (e.g., agent selection change)
 */
async function handleBlockActions(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const action = payload.actions?.[0];

  if (action) {
    await dispatchBlockAction(payload, action);
  }

  return new Response("", { status: 200 });
}

/**
 * Dispatch modal-related block actions (link mode, agent select, agent update select)
 */
async function dispatchModalAction(
  payload: SlackInteractivePayload,
  actionId: string,
  value: string,
): Promise<void> {
  switch (actionId) {
    case "link_mode_action":
      await handleLinkModeSwitch(payload, value);
      break;
    case "agent_select_action":
      await handleAgentAddSelection(payload, value);
      break;
    case "agent_update_select_action":
      await handleAgentUpdateSelection(payload, value);
      break;
  }
}

/**
 * Dispatch a single block action to the appropriate handler
 */
async function dispatchBlockAction(
  payload: SlackInteractivePayload,
  action: NonNullable<SlackInteractivePayload["actions"]>[0],
): Promise<void> {
  switch (action.action_id) {
    case "link_mode_action":
    case "agent_select_action":
    case "agent_update_select_action":
      if (payload.view && action.selected_option?.value) {
        await dispatchModalAction(
          payload,
          action.action_id,
          action.selected_option.value,
        );
      }
      break;
    case "home_agent_update":
      if (action.value && payload.trigger_id) {
        await handleHomeAgentConfigure(
          payload,
          action.value,
          payload.trigger_id,
        );
      }
      break;
    case "home_agent_unlink":
      if (action.value) {
        await handleHomeAgentUnlink(payload, action.value);
      }
      break;
    case "home_agent_link":
      if (payload.trigger_id) {
        await handleHomeAgentLink(payload, payload.trigger_id);
      }
      break;
    case "home_disconnect":
      await handleHomeDisconnect(payload);
      break;
  }
}

/**
 * Refresh App Home for a user given workspace ID
 */
async function refreshAppHomeForUser(
  workspaceId: string,
  slackUserId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(workspaceId);
  if (!client) return;
  await refreshAppHome(client, workspaceId, slackUserId);
}

/**
 * Handle agent configure select from App Home
 *
 * Opens the agent update modal pre-selected with the chosen agent.
 */
async function handleHomeAgentConfigure(
  payload: SlackInteractivePayload,
  bindingId: string,
  triggerId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const agents = await fetchBoundAgents(userLink.vm0UserId, userLink.id);
  const modal = buildAgentUpdateModal(agents, bindingId);

  await client.views.open({
    trigger_id: triggerId,
    view: modal,
  });
}

/**
 * Handle agent unlink button from App Home
 *
 * Deletes the binding and refreshes the Home tab.
 */
async function handleHomeAgentUnlink(
  payload: SlackInteractivePayload,
  bindingId: string,
): Promise<void> {
  await globalThis.services.db
    .delete(slackBindings)
    .where(eq(slackBindings.id, bindingId));

  await refreshAppHomeForUser(payload.team.id, payload.user.id);
}

/**
 * Handle agent link button from App Home
 *
 * Opens the agent add modal.
 */
async function handleHomeAgentLink(
  payload: SlackInteractivePayload,
  triggerId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const agents = await fetchAvailableAgents(userLink.vm0UserId, userLink.id);
  const channelId = payload.channel?.id;
  const modal = buildAgentAddModal(agents, undefined, channelId);

  await client.views.open({
    trigger_id: triggerId,
    view: modal,
  });
}

/**
 * Handle disconnect button click from App Home
 */
async function handleHomeDisconnect(
  payload: SlackInteractivePayload,
): Promise<void> {
  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  // Delete user link (cascades to bindings)
  await globalThis.services.db
    .delete(slackUserLinks)
    .where(eq(slackUserLinks.id, userLink.id));

  // Refresh App Home to show disconnected state
  await refreshAppHomeForUser(payload.team.id, payload.user.id);
}

/**
 * Handle modal submission
 */
async function handleViewSubmission(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const callbackId = payload.view?.callback_id;

  if (callbackId === "agent_add_modal") {
    return handleAgentAddSubmission(payload);
  }

  if (callbackId === "agent_remove_modal") {
    return handleAgentRemoveSubmission(payload);
  }

  if (callbackId === "agent_update_modal") {
    return handleAgentUpdateSubmission(payload);
  }

  // Unknown callback - just acknowledge
  return new Response("", { status: 200 });
}

interface AgentAddFormValues {
  composeId: string | undefined;
  description: string | undefined;
  secrets: Record<string, string>;
  vars: Record<string, string>;
}

/** Validated form values with required fields guaranteed */
interface ValidatedAgentAddForm {
  composeId: string;
  description: string | undefined;
  secrets: Record<string, string>;
  vars: Record<string, string>;
}

type ModalStateValues = NonNullable<
  SlackInteractivePayload["view"]
>["state"]["values"];

/**
 * Extract form values from the modal submission
 */
function extractFormValues(values: ModalStateValues): AgentAddFormValues {
  // Extract secrets from individual secret_* blocks
  const secrets: Record<string, string> = {};
  // Extract vars from individual var_* blocks
  const vars: Record<string, string> = {};

  for (const [blockId, block] of Object.entries(values)) {
    if (blockId.startsWith("secret_")) {
      const secretName = blockId.replace("secret_", "");
      const value = block?.value?.value?.trim();
      if (value) {
        secrets[secretName] = value;
      }
    } else if (blockId.startsWith("var_")) {
      const varName = blockId.replace("var_", "");
      const value = block?.value?.value?.trim();
      if (value) {
        vars[varName] = value;
      }
    }
  }

  // Extract description
  const description =
    values.agent_description?.description_input?.value?.trim() || undefined;

  return {
    composeId: values.agent_select?.agent_select_action?.selected_option?.value,
    description,
    secrets,
    vars,
  };
}

/**
 * Validate the agent add form values.
 * Returns validated form with narrowed types on success, or error Response on failure.
 */
function validateAgentAddForm(
  formValues: AgentAddFormValues,
): ValidatedAgentAddForm | Response {
  if (!formValues.composeId) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Please select an agent" },
    });
  }

  // Return validated form with narrowed types
  return {
    composeId: formValues.composeId,
    description: formValues.description,
    secrets: formValues.secrets,
    vars: formValues.vars,
  };
}

/**
 * Extract channelId from modal private_metadata
 */
function extractChannelIdFromMetadata(
  privateMetadata: string | undefined,
): string | undefined {
  if (!privateMetadata) {
    return undefined;
  }
  try {
    const metadata = JSON.parse(privateMetadata) as { channelId?: string };
    return metadata.channelId;
  } catch {
    return undefined;
  }
}

/**
 * Send confirmation message to channel after agent is added (ephemeral - only visible to the user)
 */
async function sendConfirmationMessage(
  workspaceId: string,
  agentName: string,
  savedSecretNames: string[],
  savedVarNames: string[],
  channelId: string,
  slackUserId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(workspaceId);
  if (!client) return;

  let messageText = `:white_check_mark: *Agent \`${agentName}\` has been added successfully!*`;

  if (savedVarNames.length > 0) {
    const varsList = savedVarNames.map((n) => `\`${n}\``).join(", ");
    messageText += `\n\nVariables saved to your account: ${varsList}`;
  }

  if (savedSecretNames.length > 0) {
    const secretsList = savedSecretNames.map((n) => `\`${n}\``).join(", ");
    messageText += `\n\nSecrets saved to your account: ${secretsList}`;
  }

  messageText += `\n\nYou can now use it by mentioning \`@VM0 use ${agentName} <message>\``;

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Agent "${agentName}" has been added successfully!`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: messageText,
        },
      },
    ],
  });
}

/**
 * Handle GitHub URL submission from the agent add modal
 */
async function handleGithubUrlSubmission(
  payload: SlackInteractivePayload,
  githubUrl: string,
): Promise<Response> {
  // Validate URL format
  if (!githubUrl.startsWith("https://github.com/")) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        github_url_input:
          "Please enter a valid GitHub URL (https://github.com/...)",
      },
    });
  }

  // Get user link
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, payload.user.id),
        eq(slackUserLinks.slackWorkspaceId, payload.team.id),
      ),
    )
    .limit(1);

  if (!userLink) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        github_url_input:
          "Your account is not linked. Please run /vm0 connect first.",
      },
    });
  }

  // Generate ephemeral CLI token
  const userToken = await generateEphemeralCliToken(userLink.vm0UserId);

  // Trigger compose job
  const result = await triggerComposeJob({
    userId: userLink.vm0UserId,
    githubUrl,
    userToken,
  });

  // Insert slack_compose_requests record
  const channelId = extractChannelIdFromMetadata(
    payload.view?.private_metadata,
  );

  await globalThis.services.db.insert(slackComposeRequests).values({
    composeJobId: result.jobId,
    slackWorkspaceId: payload.team.id,
    slackUserId: payload.user.id,
    slackChannelId: channelId ?? payload.user.id,
  });

  // Send "composing..." ephemeral message
  if (channelId) {
    const client = await getSlackClientForWorkspace(payload.team.id);

    if (client) {
      await client.chat
        .postEphemeral({
          channel: channelId,
          user: payload.user.id,
          text: `Composing agent from ${githubUrl}...`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `:hourglass_flowing_sand: *Composing agent from* \`${githubUrl}\`...\n\nThis may take a few minutes. You'll be notified when it's ready.`,
              },
            },
          ],
        })
        .catch((error) => {
          log.warn("Failed to send composing message (non-critical)", {
            error,
          });
        });
    }
  }

  // Close modal
  return new Response("", { status: 200 });
}

/**
 * Handle agent add modal submission
 */
async function handleAgentAddSubmission(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const values = payload.view?.state?.values;

  if (!values) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Missing form values" },
    });
  }

  // Check if this is a GitHub URL submission
  const githubUrl = values.github_url_input?.github_url_value?.value?.trim();
  if (githubUrl) {
    return handleGithubUrlSubmission(payload, githubUrl);
  }

  // Extract channelId from private_metadata
  const channelId = extractChannelIdFromMetadata(
    payload.view?.private_metadata,
  );

  const rawFormValues = extractFormValues(values);

  const validationResult = validateAgentAddForm(rawFormValues);
  // If validation returns a Response, it's an error
  if (validationResult instanceof Response) {
    return validationResult;
  }
  // Otherwise, we have validated form values with narrowed types
  const formValues = validationResult;

  // Get the compose to use its name
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, formValues.composeId))
    .limit(1);

  if (!compose) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Selected agent not found" },
    });
  }

  const agentName = compose.name.toLowerCase();

  // Get user link
  const [userLink] = await globalThis.services.db
    .select()
    .from(slackUserLinks)
    .where(
      and(
        eq(slackUserLinks.slackUserId, payload.user.id),
        eq(slackUserLinks.slackWorkspaceId, payload.team.id),
      ),
    )
    .limit(1);

  if (!userLink) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        agent_select:
          "Your account is not linked. Please link your account first.",
      },
    });
  }

  // Check if agent already exists for this user
  const [existingBinding] = await globalThis.services.db
    .select()
    .from(slackBindings)
    .where(
      and(
        eq(slackBindings.slackUserLinkId, userLink.id),
        eq(slackBindings.agentName, agentName),
      ),
    )
    .limit(1);

  if (existingBinding) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        agent_select: `Agent "${agentName}" is already added. Remove it first if you want to reconfigure.`,
      },
    });
  }

  // Save variables to user's scope
  const savedVarNames: string[] = [];
  for (const [name, value] of Object.entries(formValues.vars)) {
    if (value.trim()) {
      await setVariable(
        userLink.vm0UserId,
        name,
        value,
        `Configured via Slack for ${agentName}`,
      );
      savedVarNames.push(name);
    }
  }

  // Save secrets to user's scope
  const savedSecretNames: string[] = [];
  for (const [name, value] of Object.entries(formValues.secrets)) {
    if (value.trim()) {
      await setSecret(
        userLink.vm0UserId,
        name,
        value,
        `Configured via Slack for ${agentName}`,
      );
      savedSecretNames.push(name);
    }
  }

  // Create binding
  await globalThis.services.db.insert(slackBindings).values({
    slackUserLinkId: userLink.id,
    vm0UserId: userLink.vm0UserId,
    slackWorkspaceId: payload.team.id,
    composeId: formValues.composeId,
    agentName,
    description: formValues.description ?? null,
    enabled: true,
  });

  // Await message to prevent serverless function from terminating before it's sent
  if (channelId) {
    await sendConfirmationMessage(
      payload.team.id,
      agentName,
      savedSecretNames,
      savedVarNames,
      channelId,
      payload.user.id,
    ).catch((error) => {
      log.warn("Failed to send confirmation message (non-critical)", { error });
    });
  }

  // Refresh App Home to show newly linked agent
  await refreshAppHomeForUser(payload.team.id, payload.user.id);

  // Close modal
  return new Response("", { status: 200 });
}

/**
 * Handle agent remove modal submission
 */
async function handleAgentRemoveSubmission(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const values = payload.view?.state?.values;

  if (!values) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agents_select: "Missing form values" },
    });
  }

  // Extract selected agent IDs
  const selectedAgentIds =
    values.agents_select?.agents_select_action?.selected_options?.map(
      (opt: { value: string }) => opt.value,
    ) ?? [];

  if (selectedAgentIds.length === 0) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agents_select: "Please select at least one agent to remove" },
    });
  }

  // Extract channelId from private_metadata
  const channelId = extractChannelIdFromMetadata(
    payload.view?.private_metadata,
  );

  // Get agent names before deleting (for confirmation message)
  const agentsToRemove = await globalThis.services.db
    .select({ id: slackBindings.id, agentName: slackBindings.agentName })
    .from(slackBindings)
    .where(inArray(slackBindings.id, selectedAgentIds));

  const agentNames = agentsToRemove.map((a) => a.agentName);

  // Delete selected bindings
  await globalThis.services.db
    .delete(slackBindings)
    .where(inArray(slackBindings.id, selectedAgentIds));

  // Await message to prevent serverless function from terminating before it's sent
  if (channelId && agentNames.length > 0) {
    await sendRemovalConfirmationMessage(
      payload.team.id,
      agentNames,
      channelId,
      payload.user.id,
    ).catch((error) => {
      log.warn("Failed to send removal confirmation message (non-critical)", {
        error,
      });
    });
  }

  // Refresh App Home to reflect removed agents
  await refreshAppHomeForUser(payload.team.id, payload.user.id);

  // Close modal
  return new Response("", { status: 200 });
}

/**
 * Send confirmation message to channel after agents are removed (ephemeral - only visible to the user)
 */
async function sendRemovalConfirmationMessage(
  workspaceId: string,
  agentNames: string[],
  channelId: string,
  slackUserId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(workspaceId);
  if (!client) return;

  const agentList = agentNames.map((n) => `\`${n}\``).join(", ");
  const plural = agentNames.length > 1 ? "s" : "";
  const verb = agentNames.length > 1 ? "have" : "has";

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Agent${plural} ${agentList} ${verb} been removed.`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Agent${plural} ${agentList} ${verb} been removed.*`,
        },
      },
    ],
  });
}

/**
 * Extract secrets from form values (only non-empty values)
 */
function extractSecretsFromFormValues(
  values: ModalStateValues,
): Record<string, string> {
  const secrets: Record<string, string> = {};
  for (const [blockId, block] of Object.entries(values)) {
    if (blockId.startsWith("secret_")) {
      const secretName = blockId.replace("secret_", "");
      const value = block?.value?.value?.trim();
      if (value) {
        secrets[secretName] = value;
      }
    }
  }
  return secrets;
}

/**
 * Extract vars from form values (only non-empty values)
 */
function extractVarsFromFormValues(
  values: ModalStateValues,
): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [blockId, block] of Object.entries(values)) {
    if (blockId.startsWith("var_")) {
      const varName = blockId.replace("var_", "");
      const value = block?.value?.value?.trim();
      if (value) {
        vars[varName] = value;
      }
    }
  }
  return vars;
}

/**
 * Save variables and secrets from form submission
 */
async function saveVarsAndSecrets(
  userId: string,
  agentName: string,
  vars: Record<string, string>,
  secrets: Record<string, string>,
): Promise<{ savedVarNames: string[]; savedSecretNames: string[] }> {
  const savedVarNames: string[] = [];
  const savedSecretNames: string[] = [];

  for (const [name, value] of Object.entries(vars)) {
    await setVariable(
      userId,
      name,
      value,
      `Updated via Slack for ${agentName}`,
    );
    savedVarNames.push(name);
  }

  for (const [name, value] of Object.entries(secrets)) {
    await setSecret(userId, name, value, `Updated via Slack for ${agentName}`);
    savedSecretNames.push(name);
  }

  return { savedVarNames, savedSecretNames };
}

/**
 * Handle agent update modal submission
 */
async function handleAgentUpdateSubmission(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const values = payload.view?.state?.values;
  if (!values) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Missing form values" },
    });
  }

  const channelId = extractChannelIdFromMetadata(
    payload.view?.private_metadata,
  );
  const bindingId =
    values.agent_select?.agent_update_select_action?.selected_option?.value;

  if (!bindingId) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Please select an agent" },
    });
  }

  const [binding] = await globalThis.services.db
    .select()
    .from(slackBindings)
    .where(eq(slackBindings.id, bindingId))
    .limit(1);

  if (!binding) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Agent binding not found" },
    });
  }

  const newVars = extractVarsFromFormValues(values);
  const newSecrets = extractSecretsFromFormValues(values);
  const newDescription =
    values.agent_description?.description_input?.value?.trim() || null;
  const descriptionChanged = newDescription !== binding.description;
  const hasVars = Object.keys(newVars).length > 0;
  const hasSecrets = Object.keys(newSecrets).length > 0;

  if (!hasVars && !hasSecrets && !descriptionChanged) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "No changes to save" },
    });
  }

  if (descriptionChanged) {
    await globalThis.services.db
      .update(slackBindings)
      .set({ description: newDescription })
      .where(eq(slackBindings.id, bindingId));
  }

  const { savedVarNames, savedSecretNames } = await saveVarsAndSecrets(
    binding.vm0UserId,
    binding.agentName,
    newVars,
    newSecrets,
  );

  if (channelId) {
    await sendUpdateConfirmationMessage(
      payload.team.id,
      binding.agentName,
      savedVarNames,
      savedSecretNames,
      descriptionChanged,
      channelId,
      payload.user.id,
    ).catch((error) => {
      log.warn("Failed to send update confirmation message (non-critical)", {
        error,
      });
    });
  }

  // Refresh App Home to reflect updated agent
  await refreshAppHomeForUser(payload.team.id, payload.user.id);

  return new Response("", { status: 200 });
}

/**
 * Send confirmation message to channel after agent is updated (ephemeral - only visible to the user)
 */
async function sendUpdateConfirmationMessage(
  workspaceId: string,
  agentName: string,
  updatedVarNames: string[],
  updatedSecretNames: string[],
  descriptionUpdated: boolean,
  channelId: string,
  slackUserId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(workspaceId);
  if (!client) return;

  // Build update summary
  const updates: string[] = [];
  if (descriptionUpdated) {
    updates.push("description");
  }
  if (updatedVarNames.length > 0) {
    const varList = updatedVarNames.map((n) => `\`${n}\``).join(", ");
    updates.push(
      `variable${updatedVarNames.length > 1 ? "s" : ""}: ${varList}`,
    );
  }
  if (updatedSecretNames.length > 0) {
    const secretList = updatedSecretNames.map((n) => `\`${n}\``).join(", ");
    updates.push(
      `secret${updatedSecretNames.length > 1 ? "s" : ""}: ${secretList}`,
    );
  }

  const updateSummary = updates.join(", ");

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Agent "${agentName}" updated: ${updateSummary}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Agent \`${agentName}\` updated:* ${updateSummary}`,
        },
      },
    ],
  });
}
