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
import {
  decryptCredentialValue,
  encryptCredentialValue,
} from "../../../../src/lib/crypto/secrets-encryption";
import { createSlackClient, postMessage } from "../../../../src/lib/slack";

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
      // Block actions typically don't need a response
      return new Response("", { status: 200 });

    default:
      return new Response("", { status: 200 });
  }
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

  // Unknown callback - just acknowledge
  return new Response("", { status: 200 });
}

interface AgentAddFormValues {
  composeId: string | undefined;
  agentName: string | undefined;
  description: string | null;
  secretsText: string | null;
}

type ModalStateValues = NonNullable<
  SlackInteractivePayload["view"]
>["state"]["values"];

/**
 * Extract form values from the modal submission
 */
function extractFormValues(values: ModalStateValues): AgentAddFormValues {
  return {
    composeId: values.agent_select?.agent?.selected_option?.value,
    agentName: values.agent_name?.name?.value?.trim().toLowerCase(),
    description: values.description?.description?.value?.trim() || null,
    secretsText: values.secrets?.secrets?.value?.trim() || null,
  };
}

/**
 * Validate the agent add form values
 */
function validateAgentAddForm(formValues: AgentAddFormValues): Response | null {
  if (!formValues.composeId) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_select: "Please select an agent" },
    });
  }

  if (!formValues.agentName) {
    return NextResponse.json({
      response_action: "errors",
      errors: { agent_name: "Please enter a name" },
    });
  }

  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/.test(formValues.agentName)) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        agent_name:
          "Name must be lowercase letters, numbers, and hyphens. Must start and end with letter or number.",
      },
    });
  }

  return null;
}

/**
 * Send confirmation DM to user after agent is added
 */
async function sendConfirmationDM(
  workspaceId: string,
  userId: string,
  agentName: string,
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

  const dmResult = await client.conversations.open({ users: userId });

  if (dmResult.ok && dmResult.channel?.id) {
    await postMessage(
      client,
      dmResult.channel.id,
      `Agent "${agentName}" has been added successfully!\n\nYou can now use it by mentioning me: \`@VM0 use ${agentName} <message>\``,
    );
  }
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

  const formValues = extractFormValues(values);

  const validationError = validateAgentAddForm(formValues);
  if (validationError) {
    return validationError;
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
        agent_select:
          "Your account is not linked. Please link your account first.",
      },
    });
  }

  // Check if agent name already exists for this user
  const [existingBinding] = await globalThis.services.db
    .select()
    .from(slackBindings)
    .where(
      and(
        eq(slackBindings.slackUserLinkId, userLink.id),
        eq(slackBindings.agentName, formValues.agentName!),
      ),
    )
    .limit(1);

  if (existingBinding) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        agent_name: `An agent named "${formValues.agentName}" already exists. Use a different name or remove the existing one first.`,
      },
    });
  }

  // Encrypt secrets if provided
  let encryptedSecrets: string | null = null;
  if (formValues.secretsText) {
    encryptedSecrets = encryptCredentialValue(
      formValues.secretsText,
      encryptionKey,
    );
  }

  // Create binding
  await globalThis.services.db.insert(slackBindings).values({
    slackUserLinkId: userLink.id,
    composeId: formValues.composeId!,
    agentName: formValues.agentName!,
    description: formValues.description,
    encryptedSecrets,
    enabled: true,
  });

  // Send confirmation message via DM (fire-and-forget)
  sendConfirmationDM(
    payload.team.id,
    payload.user.id,
    formValues.agentName!,
    encryptionKey,
  ).catch((error) => {
    console.error("Error sending confirmation DM:", error);
  });

  // Close modal
  return new Response("", { status: 200 });
}
