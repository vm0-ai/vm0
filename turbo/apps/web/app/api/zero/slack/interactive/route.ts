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
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { decryptSecretValue } from "../../../../../src/lib/shared/crypto/secrets-encryption";
import {
  createSlackClient,
  openView,
} from "../../../../../src/lib/zero/slack/client";
import {
  AGENT_PICKER_ACTION_ID,
  AGENT_PICKER_BLOCK_ID,
  AGENT_PICKER_CALLBACK_ID,
  AGENT_PICKER_ORG_DEFAULT_VALUE,
  MODEL_PICKER_ACTION_ID,
  MODEL_PICKER_BLOCK_ID,
  MODEL_PICKER_CALLBACK_ID,
  buildAgentPickerModal,
} from "../../../../../src/lib/zero/slack/blocks";
import { refreshOrgAppHome } from "../../../../../src/lib/zero/slack-org/handlers/app-home";
import { disconnect } from "../../../../../src/lib/zero/slack-org/connect-service";
import {
  getUserAgentPreference,
  getWorkspaceAgent,
  resolveDefaultComposeId,
  setUserAgentPreference,
} from "../../../../../src/lib/zero/slack-org/handlers/shared";
import { listComposes } from "../../../../../src/lib/zero/zero-compose-service";
import { getSlackModelPickerState } from "../../../../../src/lib/zero/slack/model-picker";
import { updateUserModelPreference } from "../../../../../src/lib/zero/model-policy/user-model-preference-service";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("slack-org:interactive");

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
  channel?: {
    id: string;
  };
  message?: {
    ts: string;
  };
  trigger_id?: string;
  actions?: Array<{
    action_id: string;
    block_id: string;
    value?: string;
    selected_option?: { value: string };
    selected_options?: Array<{ value: string }>;
  }>;
  view?: {
    id: string;
    callback_id: string;
    private_metadata?: string;
    state: {
      values: Record<
        string,
        Record<
          string,
          {
            selected_option?: { value: string } | null;
          }
        >
      >;
    };
  };
}

/**
 * POST /api/zero/slack/interactive
 *
 * Org-aware interactive component handler.
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

  if (
    payload.type === "view_submission" &&
    payload.view?.callback_id === AGENT_PICKER_CALLBACK_ID
  ) {
    return handleAgentPickerSubmit(payload);
  }

  if (
    payload.type === "view_submission" &&
    payload.view?.callback_id === MODEL_PICKER_CALLBACK_ID
  ) {
    return handleModelPickerSubmit(payload);
  }

  if (payload.type === "block_actions") {
    const action = payload.actions?.[0];
    if (!action) {
      return new Response("", { status: 200 });
    }

    if (action.action_id === "home_disconnect") {
      await handleHomeDisconnect(payload);
    } else if (action.action_id === "home_switch_agent") {
      await handleHomeSwitchAgent(payload);
    }
  }

  return new Response("", { status: 200 });
}

const AGENT_PICKER_MAX_OPTIONS = 100;

interface ConnectionContext {
  connection: typeof slackOrgConnections.$inferSelect;
  installation: typeof slackOrgInstallations.$inferSelect;
  orgId: string;
}

async function resolveConnectionContext(
  slackUserId: string,
  workspaceId: string,
): Promise<ConnectionContext | null> {
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);

  if (!installation?.orgId) {
    return null;
  }

  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);

  if (!connection) {
    return null;
  }

  return { connection, installation, orgId: installation.orgId };
}

function postEphemeralMessage(opts: {
  botToken: string;
  channel: string;
  slackUserId: string;
  text: string;
}): Promise<void> {
  const client = createSlackClient(opts.botToken);
  return client.chat
    .postEphemeral({
      channel: opts.channel,
      user: opts.slackUserId,
      text: opts.text,
    })
    .then(() => {
      return;
    })
    .catch((err) => {
      log.warn("Failed to post ephemeral message", { error: err });
    });
}

function parseViewChannelId(
  privateMetadata: string | undefined,
): string | undefined {
  if (!privateMetadata) return undefined;
  try {
    const meta = JSON.parse(privateMetadata) as { channelId?: unknown };
    if (typeof meta.channelId === "string" && meta.channelId.length > 0) {
      return meta.channelId;
    }
  } catch {
    // Ignore malformed private_metadata; fall through without a channel.
  }
  return undefined;
}

async function resolveOrgDefaultName(orgId: string): Promise<string> {
  const defaultComposeId = await resolveDefaultComposeId(orgId);
  if (!defaultComposeId) return "the org default agent";
  const agent = await getWorkspaceAgent(defaultComposeId);
  return agent?.displayName ?? agent?.name ?? "the org default agent";
}

async function applyAgentSelection(opts: {
  ctx: ConnectionContext;
  botToken: string;
  slackUserId: string;
  channelId: string | undefined;
  composeId: string | null;
  switchedTo: string;
}): Promise<void> {
  await setUserAgentPreference({
    vm0UserId: opts.ctx.connection.vm0UserId,
    orgId: opts.ctx.orgId,
    composeId: opts.composeId,
  });

  if (opts.channelId) {
    await postEphemeralMessage({
      botToken: opts.botToken,
      channel: opts.channelId,
      slackUserId: opts.slackUserId,
      text: `Switched to *${opts.switchedTo}*.`,
    });
  }

  void refreshOrgAppHome(
    createSlackClient(opts.botToken),
    opts.ctx.installation,
    opts.slackUserId,
  ).catch((err) => {
    return log.warn("Failed to refresh App Home after switch", { error: err });
  });
}

/**
 * Persist the user's agent selection after they submit the switch modal.
 *
 * Returns `{ response_action: "errors" }` inline in the modal when the chosen
 * agent is not accessible to the user, keeping the modal open for correction.
 * On success, closes the modal and posts a best-effort ephemeral confirmation
 * to the channel where `/zero switch` was invoked.
 */
async function handleAgentPickerSubmit(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const selected =
    payload.view?.state.values[AGENT_PICKER_BLOCK_ID]?.[AGENT_PICKER_ACTION_ID]
      ?.selected_option?.value;

  if (!selected) {
    return NextResponse.json({
      response_action: "errors",
      errors: { [AGENT_PICKER_BLOCK_ID]: "Please choose an agent." },
    });
  }

  const ctx = await resolveConnectionContext(payload.user.id, payload.team.id);
  if (!ctx) {
    return new Response("", { status: 200 });
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    ctx.installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const channelId = parseViewChannelId(payload.view?.private_metadata);

  if (selected === AGENT_PICKER_ORG_DEFAULT_VALUE) {
    const defaultName = await resolveOrgDefaultName(ctx.orgId);
    await applyAgentSelection({
      ctx,
      botToken,
      slackUserId: payload.user.id,
      channelId,
      composeId: null,
      switchedTo: defaultName,
    });
    return new Response("", { status: 200 });
  }

  const [agentRow] = await globalThis.services.db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.id, selected), eq(zeroAgents.orgId, ctx.orgId)))
    .limit(1);

  if (!agentRow) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        [AGENT_PICKER_BLOCK_ID]: "You don't have access to that agent.",
      },
    });
  }

  await applyAgentSelection({
    ctx,
    botToken,
    slackUserId: payload.user.id,
    channelId,
    composeId: agentRow.id,
    switchedTo: agentRow.displayName ?? agentRow.name,
  });

  return new Response("", { status: 200 });
}

async function applyModelSelection(opts: {
  ctx: ConnectionContext;
  botToken: string;
  slackUserId: string;
  channelId: string | undefined;
  selectedModel: string | null;
  switchedTo: string;
}): Promise<void> {
  await updateUserModelPreference(
    opts.ctx.orgId,
    opts.ctx.connection.vm0UserId,
    opts.selectedModel,
  );

  if (opts.channelId) {
    await postEphemeralMessage({
      botToken: opts.botToken,
      channel: opts.channelId,
      slackUserId: opts.slackUserId,
      text: `Switched to *${opts.switchedTo}*.`,
    });
  }
}

/**
 * Persist the user's model selection after they submit the model modal.
 *
 * The option list is reloaded on submit so stale modals cannot write a model
 * that is no longer configured or visible for the caller.
 */
async function handleModelPickerSubmit(
  payload: SlackInteractivePayload,
): Promise<Response> {
  const selected =
    payload.view?.state.values[MODEL_PICKER_BLOCK_ID]?.[MODEL_PICKER_ACTION_ID]
      ?.selected_option?.value;

  if (!selected) {
    return NextResponse.json({
      response_action: "errors",
      errors: { [MODEL_PICKER_BLOCK_ID]: "Please choose a model." },
    });
  }

  const ctx = await resolveConnectionContext(payload.user.id, payload.team.id);
  if (!ctx) {
    return new Response("", { status: 200 });
  }

  const picker = await getSlackModelPickerState({
    orgId: ctx.orgId,
    userId: ctx.connection.vm0UserId,
  });
  if (!picker.enabled) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        [MODEL_PICKER_BLOCK_ID]:
          "Model switching is not available for this workspace.",
      },
    });
  }

  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    ctx.installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const channelId = parseViewChannelId(payload.view?.private_metadata);

  const option = picker.options.find((candidate) => {
    return candidate.model === selected;
  });
  if (!option) {
    return NextResponse.json({
      response_action: "errors",
      errors: {
        [MODEL_PICKER_BLOCK_ID]: "You don't have access to that model.",
      },
    });
  }

  await applyModelSelection({
    ctx,
    botToken,
    slackUserId: payload.user.id,
    channelId,
    selectedModel: option.isDefault ? null : option.model,
    switchedTo: option.isDefault
      ? `workspace default (${option.label})`
      : option.label,
  });

  return new Response("", { status: 200 });
}

/**
 * Open the switch modal from the App Home "Switch" button.
 */
async function handleHomeSwitchAgent(
  payload: SlackInteractivePayload,
): Promise<void> {
  if (!payload.trigger_id) {
    return;
  }

  const ctx = await resolveConnectionContext(payload.user.id, payload.team.id);
  if (!ctx) {
    return;
  }

  const { composes } = await listComposes(ctx.orgId);
  const defaultComposeId = await resolveDefaultComposeId(ctx.orgId);

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
    ctx.connection.vm0UserId,
    ctx.orgId,
  );

  const { SECRETS_ENCRYPTION_KEY } = env();
  const botToken = decryptSecretValue(
    ctx.installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);

  const modal = buildAgentPickerModal({
    options: pickerOptions,
    currentSelectedId: currentOverride,
    orgDefaultName,
  });

  await openView(client, payload.trigger_id, modal).catch((err) => {
    return log.warn("Failed to open switch modal from App Home", {
      error: err,
    });
  });
}

/**
 * Handle disconnect button click from App Home.
 */
async function handleHomeDisconnect(
  payload: SlackInteractivePayload,
): Promise<void> {
  const [connection] = await globalThis.services.db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, payload.user.id),
        eq(slackOrgConnections.slackWorkspaceId, payload.team.id),
      ),
    )
    .limit(1);

  if (!connection) {
    return;
  }

  await disconnect({
    connectionId: connection.id,
    userId: connection.vm0UserId,
  });

  // Refresh App Home to show disconnected state
  const { SECRETS_ENCRYPTION_KEY } = env();
  const [installation] = await globalThis.services.db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, payload.team.id))
    .limit(1);

  if (!installation) {
    return;
  }

  const botToken = decryptSecretValue(
    installation.encryptedBotToken,
    SECRETS_ENCRYPTION_KEY,
  );
  const client = createSlackClient(botToken);
  await refreshOrgAppHome(client, installation, payload.user.id);
}
