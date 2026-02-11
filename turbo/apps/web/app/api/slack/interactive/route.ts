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
import {
  buildAgentManageModal,
  buildAgentComposeModal,
  buildEnvironmentSetupModal,
} from "../../../../src/lib/slack/blocks";
import { decryptCredentialValue } from "../../../../src/lib/crypto/secrets-encryption";
import {
  createSlackClient,
  isSlackInvalidAuthError,
  refreshAppHome,
  resolveDefaultAgentComposeId,
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
import { listModelProviders } from "../../../../src/lib/model-provider/model-provider-service";
import { listConnectors } from "../../../../src/lib/connector/connector-service";
import {
  addPermission,
  removePermission,
} from "../../../../src/lib/agent/permission-service";
import { getUserEmail } from "../../../../src/lib/auth/get-user-email";

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
 * Fetch workspace agent info for a given user
 */
async function fetchWorkspaceAgentInfo(
  composeId: string,
  vm0UserId: string,
): Promise<{
  id: string;
  name: string;
  requiredSecrets: string[];
  existingSecrets: string[];
  requiredVars: string[];
  existingVars: string[];
} | null> {
  const [compose] = await globalThis.services.db
    .select({
      id: agentComposes.id,
      name: agentComposes.name,
      headVersionId: agentComposes.headVersionId,
    })
    .from(agentComposes)
    .where(eq(agentComposes.id, composeId))
    .limit(1);

  if (!compose) return null;

  // Get compose version
  const versions = compose.headVersionId
    ? await globalThis.services.db
        .select({
          id: agentComposeVersions.id,
          content: agentComposeVersions.content,
        })
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, compose.headVersionId))
        .limit(1)
    : [];

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

  return {
    id: compose.id,
    name: compose.name,
    requiredSecrets,
    existingSecrets: requiredSecrets.filter((name) =>
      existingSecretNames.has(name),
    ),
    requiredVars,
    existingVars: requiredVars.filter((name) => existingVarNames.has(name)),
  };
}

/**
 * Fetch all agents owned by the admin user
 */
async function fetchAdminAgents(vm0UserId: string): Promise<
  Array<{
    id: string;
    name: string;
    requiredSecrets: string[];
    existingSecrets: string[];
    requiredVars: string[];
    existingVars: string[];
  }>
> {
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

  if (composes.length === 0) return [];

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

  const versionMap = new Map(versions.map((v) => [v.id, v.content]));
  return composes.map((c) => {
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
 * Get the Slack installation for a workspace
 */
async function getInstallation(workspaceId: string) {
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return installation ?? null;
}

/**
 * Update modal view with error handling for invalid auth
 */
async function updateModalView(
  client: ReturnType<typeof createSlackClient>,
  viewId: string,
  view: ReturnType<typeof buildAgentManageModal>,
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
 * Handle agent selection in manage modal
 */
async function handleAgentManageSelection(
  payload: SlackInteractivePayload,
  selectedAgentId: string,
): Promise<void> {
  const privateMetadata = payload.view?.private_metadata;
  const { channelId, hasModelProvider } = privateMetadata
    ? (JSON.parse(privateMetadata) as {
        channelId?: string;
        hasModelProvider?: boolean;
      })
    : { channelId: undefined, hasModelProvider: true };

  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const agents = await fetchAdminAgents(userLink.vm0UserId);
  const updatedModal = buildAgentManageModal(
    agents,
    selectedAgentId,
    channelId,
    hasModelProvider ?? true,
  );

  if (!payload.view) return;
  await updateModalView(client, payload.view.id, updatedModal, payload.team.id);
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
 * Dispatch modal-related block actions (agent select)
 */
async function dispatchModalAction(
  payload: SlackInteractivePayload,
  actionId: string,
  value: string,
): Promise<void> {
  switch (actionId) {
    case "agent_select_action":
      await handleAgentManageSelection(payload, value);
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
    case "agent_select_action":
      if (payload.view && action.selected_option?.value) {
        await dispatchModalAction(
          payload,
          action.action_id,
          action.selected_option.value,
        );
      }
      break;
    case "home_environment_setup":
      if (payload.trigger_id) {
        await handleHomeEnvironmentSetup(payload, payload.trigger_id);
      }
      break;
    case "home_agent_manage":
      if (payload.trigger_id) {
        await handleHomeAgentManage(payload, payload.trigger_id);
      }
      break;
    case "model_provider_refresh":
      if (payload.view) {
        await handleModelProviderRefresh(payload);
      }
      break;
    case "home_agent_compose":
      if (payload.trigger_id) {
        await handleHomeAgentCompose(payload, payload.trigger_id);
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
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) return;

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshAppHome(client, installation, slackUserId);
}

/**
 * Handle settings button from App Home
 *
 * Opens the settings modal for the workspace agent.
 */
async function handleHomeEnvironmentSetup(
  payload: SlackInteractivePayload,
  triggerId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const installation = await getInstallation(payload.team.id);
  if (!installation) return;

  const agent = await fetchWorkspaceAgentInfo(
    installation.defaultComposeId,
    userLink.vm0UserId,
  );
  if (!agent) return;

  const modal = buildEnvironmentSetupModal(agent);
  await client.views.open({ trigger_id: triggerId, view: modal });
}

/**
 * Handle agent manage button from App Home
 *
 * Admin only - opens the agent manage modal.
 */
async function handleHomeAgentManage(
  payload: SlackInteractivePayload,
  triggerId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const installation = await getInstallation(payload.team.id);
  if (!installation) return;

  // Only admin can manage workspace agent
  if (installation.adminSlackUserId !== payload.user.id) return;

  // Check model provider status
  const providers = await listModelProviders(userLink.vm0UserId);
  const hasModelProvider = providers.length > 0;

  const agents = await fetchAdminAgents(userLink.vm0UserId);
  const currentAgentId = agents.find(
    (a) => a.id === installation.defaultComposeId,
  )?.id;
  const modal = buildAgentManageModal(
    agents,
    currentAgentId,
    undefined,
    hasModelProvider,
  );

  await client.views.open({ trigger_id: triggerId, view: modal });
}

/**
 * Handle compose button on App Home
 */
async function handleHomeAgentCompose(
  payload: SlackInteractivePayload,
  triggerId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) {
    return;
  }

  const modal = buildAgentComposeModal();

  await client.views.open({
    trigger_id: triggerId,
    view: modal,
  });
}

/**
 * Handle model provider refresh button in the agent manage modal
 *
 * Re-checks model provider status and updates the modal view.
 */
async function handleModelProviderRefresh(
  payload: SlackInteractivePayload,
): Promise<void> {
  const client = await getSlackClientForWorkspace(payload.team.id);
  if (!client) return;

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  const providers = await listModelProviders(userLink.vm0UserId);
  const hasModelProvider = providers.length > 0;

  const privateMetadata = payload.view?.private_metadata;
  const { channelId } = privateMetadata
    ? (JSON.parse(privateMetadata) as { channelId?: string })
    : { channelId: undefined };

  const selectedAgentId =
    payload.view?.state?.values?.agent_select?.agent_select_action
      ?.selected_option?.value;

  const agents = await fetchAdminAgents(userLink.vm0UserId);
  const updatedModal = buildAgentManageModal(
    agents,
    selectedAgentId,
    channelId,
    hasModelProvider,
  );

  if (!payload.view) return;
  await updateModalView(client, payload.view.id, updatedModal, payload.team.id);
}

/**
 * Handle disconnect button click from App Home
 */
async function handleHomeDisconnect(
  payload: SlackInteractivePayload,
): Promise<void> {
  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) return;

  // Delete user link
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

  if (callbackId === "agent_compose_modal") {
    return handleAgentComposeSubmission(payload);
  }

  if (callbackId === "agent_manage_modal") {
    return handleAgentManageSubmission(payload);
  }

  if (callbackId === "environment_setup_modal") {
    return handleEnvironmentSetupSubmission(payload);
  }

  // Unknown callback - just acknowledge
  return new Response("", { status: 200 });
}

interface AgentAddFormValues {
  composeId: string | undefined;
  secrets: Record<string, string>;
  vars: Record<string, string>;
}

/** Validated form values with required fields guaranteed */
interface ValidatedAgentAddForm {
  composeId: string;
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

  return {
    composeId: values.agent_select?.agent_select_action?.selected_option?.value,
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

  let messageText = `:white_check_mark: *Workspace agent changed to \`${agentName}\`*`;

  if (savedVarNames.length > 0) {
    const varsList = savedVarNames.map((n) => `\`${n}\``).join(", ");
    messageText += `\n\nVariables saved to your account: ${varsList}`;
  }

  if (savedSecretNames.length > 0) {
    const secretsList = savedSecretNames.map((n) => `\`${n}\``).join(", ");
    messageText += `\n\nSecrets saved to your account: ${secretsList}`;
  }

  messageText += `\n\nAll workspace members can now use it by mentioning \`@VM0\`.`;

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Workspace agent changed to "${agentName}"`,
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
 * Handle agent compose modal submission
 */
async function handleAgentComposeSubmission(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const githubUrl =
    payload.view?.state?.values?.github_url_input?.github_url_value?.value?.trim();

  if (!githubUrl) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        github_url_input: "Please enter a GitHub URL",
      },
    });
  }

  return handleGithubUrlSubmission(payload, githubUrl);
}

/**
 * Handle GitHub URL submission from the agent compose modal
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
 * Handle agent manage modal submission
 *
 * Admin changes the workspace agent.
 */
async function handleAgentManageSubmission(
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
  const rawFormValues = extractFormValues(values);
  const validationResult = validateAgentAddForm(rawFormValues);
  if (validationResult instanceof Response) return validationResult;
  const formValues = validationResult;

  // Get installation
  const installation = await getInstallation(payload.team.id);
  if (!installation) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Workspace not found" },
    });
  }

  // Verify admin
  if (installation.adminSlackUserId !== payload.user.id) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Only the workspace admin can change the agent" },
    });
  }

  // Get the compose name
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

  const oldComposeId = installation.defaultComposeId;
  const newComposeId = formValues.composeId;

  // Update installation's default agent
  await globalThis.services.db
    .update(slackInstallations)
    .set({ defaultComposeId: newComposeId, updatedAt: new Date() })
    .where(eq(slackInstallations.id, installation.id));

  // Re-authorize all linked users if agent changed
  if (oldComposeId !== newComposeId) {
    const allLinks = await globalThis.services.db
      .select({ vm0UserId: slackUserLinks.vm0UserId })
      .from(slackUserLinks)
      .where(eq(slackUserLinks.slackWorkspaceId, payload.team.id));

    for (const link of allLinks) {
      const email = await getUserEmail(link.vm0UserId);
      if (email) {
        // Revoke old
        await removePermission(oldComposeId, "email", email).catch((e) =>
          log.warn("Failed to revoke old permission", { error: e }),
        );
        // Grant new
        await addPermission(
          newComposeId,
          "email",
          installation.adminSlackUserId,
          email,
        ).catch((e) =>
          log.warn("Failed to grant new permission", { error: e }),
        );
      }
    }
  }

  // Save admin's secrets and vars if provided
  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (userLink) {
    const agentName = compose.name.toLowerCase();
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

    if (channelId) {
      await sendConfirmationMessage(
        payload.team.id,
        compose.name,
        savedSecretNames,
        savedVarNames,
        channelId,
        payload.user.id,
      ).catch((error) => {
        log.warn("Failed to send confirmation message (non-critical)", {
          error,
        });
      });
    }
  }

  await refreshAppHomeForUser(payload.team.id, payload.user.id);
  return new Response("", { status: 200 });
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
 * Handle settings modal submission
 *
 * User saves secrets/vars for the workspace agent.
 */
async function handleEnvironmentSetupSubmission(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const values = payload.view?.state?.values;
  if (!values) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_info: "Missing form values" },
    });
  }

  const channelId = extractChannelIdFromMetadata(
    payload.view?.private_metadata,
  );

  // Get installation to find workspace agent
  const installation = await getInstallation(payload.team.id);
  if (!installation) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_info: "Workspace not found" },
    });
  }

  // Get the workspace agent
  const [compose] = await globalThis.services.db
    .select({ name: agentComposes.name })
    .from(agentComposes)
    .where(eq(agentComposes.id, installation.defaultComposeId))
    .limit(1);

  if (!compose) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_info: "Workspace agent not found" },
    });
  }

  const userLink = await getUserLink(payload.user.id, payload.team.id);
  if (!userLink) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_info: "Your account is not connected." },
    });
  }

  const newVars = extractVarsFromFormValues(values);
  const newSecrets = extractSecretsFromFormValues(values);
  const hasVars = Object.keys(newVars).length > 0;
  const hasSecrets = Object.keys(newSecrets).length > 0;

  if (!hasVars && !hasSecrets) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_info: "No changes to save" },
    });
  }

  const { savedVarNames, savedSecretNames } = await saveVarsAndSecrets(
    userLink.vm0UserId,
    compose.name.toLowerCase(),
    newVars,
    newSecrets,
  );

  if (channelId) {
    await sendUpdateConfirmationMessage(
      payload.team.id,
      compose.name,
      savedVarNames,
      savedSecretNames,
      channelId,
      payload.user.id,
    ).catch((error) => {
      log.warn("Failed to send update confirmation message (non-critical)", {
        error,
      });
    });
  }

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
  channelId: string,
  slackUserId: string,
): Promise<void> {
  const client = await getSlackClientForWorkspace(workspaceId);
  if (!client) return;

  // Build update summary
  const updates: string[] = [];
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
