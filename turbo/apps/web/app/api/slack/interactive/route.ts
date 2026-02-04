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
} from "../../../../src/lib/slack";

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
  const { SLACK_SIGNING_SECRET, SECRETS_ENCRYPTION_KEY } = env();

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
      return handleViewSubmission(payload, SECRETS_ENCRYPTION_KEY);

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
): Promise<Array<{ id: string; name: string; requiredSecrets: string[] }>> {
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
  return availableComposes.map((c) => {
    const content = c.headVersionId ? versionMap.get(c.headVersionId) : null;
    const refs = content ? extractVariableReferences(content) : [];
    const grouped = groupVariablesBySource(refs);
    return {
      id: c.id,
      name: c.name,
      requiredSecrets: grouped.secrets.map((s) => s.name),
    };
  });
}

/**
 * Fetch bound agents for update modal from database
 */
async function fetchBoundAgents(
  vm0UserId: string,
  userLinkId: string,
): Promise<Array<{ id: string; name: string; requiredSecrets: string[] }>> {
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
    return [];
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

  return bindings.map((b) => {
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
 * Handle agent selection in add modal
 */
async function handleAgentAddSelection(
  payload: SlackInteractivePayload,
  selectedAgentId: string,
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

  if (!userLink) return;

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
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

  if (!userLink) return;

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
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
 * Handle block actions (e.g., agent selection change)
 */
async function handleBlockActions(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const action = payload.actions?.[0];

  // Handle agent selection in add modal
  if (action?.action_id === "agent_select_action" && payload.view) {
    const selectedAgentId = action.selected_option?.value;
    if (selectedAgentId) {
      await handleAgentAddSelection(payload, selectedAgentId);
    }
  }

  // Handle agent selection in update modal
  if (action?.action_id === "agent_update_select_action" && payload.view) {
    const selectedAgentId = action.selected_option?.value;
    if (selectedAgentId) {
      await handleAgentUpdateSelection(payload, selectedAgentId);
    }
  }

  return new Response("", { status: 200 });
}

/**
 * Handle modal submission
 */
async function handleViewSubmission(
  payload: SlackInteractivePayload,
  encryptionKey: string,
): Promise<Response> {
  const callbackId = payload.view?.callback_id;

  if (callbackId === "agent_add_modal") {
    return handleAgentAddSubmission(payload, encryptionKey);
  }

  if (callbackId === "agent_remove_modal") {
    return handleAgentRemoveSubmission(payload, encryptionKey);
  }

  if (callbackId === "agent_update_modal") {
    return handleAgentUpdateSubmission(payload, encryptionKey);
  }

  // Unknown callback - just acknowledge
  return new Response("", { status: 200 });
}

interface AgentAddFormValues {
  composeId: string | undefined;
  secrets: Record<string, string>;
}

/** Validated form values with required fields guaranteed */
interface ValidatedAgentAddForm {
  composeId: string;
  secrets: Record<string, string>;
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
  for (const [blockId, block] of Object.entries(values)) {
    if (blockId.startsWith("secret_")) {
      const secretName = blockId.replace("secret_", "");
      const value = block?.value?.value?.trim();
      if (value) {
        secrets[secretName] = value;
      }
    }
  }

  return {
    composeId: values.agent_select?.agent_select_action?.selected_option?.value,
    secrets,
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
  channelId: string,
  slackUserId: string,
  encryptionKey: string,
): Promise<void> {
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    encryptionKey,
  );
  const client = createSlackClient(botToken);

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Agent "${agentName}" has been added successfully!`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Agent \`${agentName}\` has been added successfully!*\n\nYou can now use it by mentioning \`@VM0 use ${agentName} <message>\``,
        },
      },
    ],
  });
}

/**
 * Handle agent add modal submission
 */
async function handleAgentAddSubmission(
  payload: SlackInteractivePayload,
  encryptionKey: string,
): Promise<Response> {
  const values = payload.view?.state?.values;

  if (!values) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Missing form values" },
    });
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

  // Create binding
  // Note: encryptedSecrets column has been removed; secrets are no longer stored per-binding
  await globalThis.services.db.insert(slackBindings).values({
    slackUserLinkId: userLink.id,
    vm0UserId: userLink.vm0UserId,
    slackWorkspaceId: payload.team.id,
    composeId: formValues.composeId,
    agentName,
    enabled: true,
  });

  // Await message to prevent serverless function from terminating before it's sent
  if (channelId) {
    await sendConfirmationMessage(
      payload.team.id,
      agentName,
      channelId,
      payload.user.id,
      encryptionKey,
    ).catch((error) => {
      console.error("Error sending confirmation message:", error);
    });
  }

  // Close modal
  return new Response("", { status: 200 });
}

/**
 * Handle agent remove modal submission
 */
async function handleAgentRemoveSubmission(
  payload: SlackInteractivePayload,
  encryptionKey: string,
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
      encryptionKey,
    ).catch((error) => {
      console.error("Error sending removal confirmation message:", error);
    });
  }

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
  encryptionKey: string,
): Promise<void> {
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    encryptionKey,
  );
  const client = createSlackClient(botToken);

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
 * Handle agent update modal submission
 */
async function handleAgentUpdateSubmission(
  payload: SlackInteractivePayload,
  encryptionKey: string,
): Promise<Response> {
  const values = payload.view?.state?.values;

  if (!values) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Missing form values" },
    });
  }

  // Extract channelId from private_metadata
  const channelId = extractChannelIdFromMetadata(
    payload.view?.private_metadata,
  );

  // Get selected binding ID
  const bindingId =
    values.agent_select?.agent_update_select_action?.selected_option?.value;

  if (!bindingId) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Please select an agent" },
    });
  }

  // Get the binding to verify it exists
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

  // Extract new secrets from form (only non-empty values)
  const newSecrets = extractSecretsFromFormValues(values);

  // If no new secrets provided, nothing to update
  // Note: encryptedSecrets column has been removed; secrets are no longer stored per-binding
  if (Object.keys(newSecrets).length === 0) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "No secrets provided to update" },
    });
  }

  // Await message to prevent serverless function from terminating before it's sent
  if (channelId) {
    await sendUpdateConfirmationMessage(
      payload.team.id,
      binding.agentName,
      Object.keys(newSecrets),
      channelId,
      payload.user.id,
      encryptionKey,
    ).catch((error) => {
      console.error("Error sending update confirmation message:", error);
    });
  }

  // Close modal
  return new Response("", { status: 200 });
}

/**
 * Send confirmation message to channel after agent secrets are updated (ephemeral - only visible to the user)
 */
async function sendUpdateConfirmationMessage(
  workspaceId: string,
  agentName: string,
  updatedSecretNames: string[],
  channelId: string,
  slackUserId: string,
  encryptionKey: string,
): Promise<void> {
  const [installation] = await globalThis.services.db
    .select()
    .from(slackInstallations)
    .where(eq(slackInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptCredentialValue(
    installation.encryptedBotToken,
    encryptionKey,
  );
  const client = createSlackClient(botToken);

  const secretList = updatedSecretNames.map((n) => `\`${n}\``).join(", ");
  const plural = updatedSecretNames.length > 1 ? "s" : "";

  await client.chat.postEphemeral({
    channel: channelId,
    user: slackUserId,
    text: `Agent "${agentName}" secret${plural} updated: ${secretList}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:white_check_mark: *Agent \`${agentName}\` secret${plural} updated:* ${secretList}`,
        },
      },
    ],
  });
}
