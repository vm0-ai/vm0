import { randomBytes } from "node:crypto";

import { command, type Getter, type Setter } from "ccstate";
import type { Block, KnownBlock } from "@slack/web-api";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import {
  getVm0VisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { RUN_ERROR_GUIDANCE } from "@vm0/api-contracts/contracts/errors";
import { slackOrgCallbackPayloadSchema } from "@vm0/api-contracts/contracts/internal-callbacks-slack-org";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { conversations } from "@vm0/db/schema/conversation";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import { slackUserAgentPreferences } from "@vm0/db/schema/slack-user-agent-preference";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { and, eq } from "drizzle-orm";
import type { z } from "zod";

import { env, optionalEnv } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  getSlackSignatureHeaders,
  verifySlackSignature,
} from "../../lib/slack-request-verification";
import {
  AGENT_PICKER_ACTION_ID,
  AGENT_PICKER_BLOCK_ID,
  AGENT_PICKER_CALLBACK_ID,
  AGENT_PICKER_ORG_DEFAULT_VALUE,
  MODEL_PICKER_ACTION_ID,
  MODEL_PICKER_BLOCK_ID,
  MODEL_PICKER_CALLBACK_ID,
  buildAgentPickerModal,
  buildAgentResponseMessage,
  buildAppHomeView,
  buildErrorMessage,
  buildHelpMessage,
  buildLoginMessage,
  buildLoginPromptMessage,
  buildModelPickerModal,
  buildSuccessMessage,
  buildWelcomeMessage,
} from "../../lib/slack-webhook-blocks";
import {
  enrichMessageContent,
  fetchConversationContexts,
  type SlackFile,
} from "../../lib/slack-webhook-context";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import {
  createSlackClient,
  openView,
  postMessage,
  publishAppHome,
  setThreadStatus,
} from "../external/slack-message-client";
import { now, nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { decryptSecretValue } from "./crypto.utils";
import { zeroComposeList } from "./zero-compose-data.service";
import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./zero-user-data.service";
import { publishSlackAdminSignal$ } from "./zero-slack-connect.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { safeAsync, safeJsonParse } from "../utils";

const L = logger("ZeroSlackWebhooks");
const AGENT_PICKER_MAX_OPTIONS = 100;
const MODEL_PICKER_MAX_OPTIONS = 100;

type ComputedGetter = Getter;
type ComputedSetter = Setter;
type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
type SlackConnection = typeof slackOrgConnections.$inferSelect;
type SlackCallbackPayload = z.infer<typeof slackOrgCallbackPayloadSchema>;

interface SlackCommandPayload {
  readonly team_id: string;
  readonly channel_id: string;
  readonly user_id: string;
  readonly text: string;
  readonly trigger_id: string;
}

interface SlackEventCallback {
  readonly type: "event_callback";
  readonly team_id: string;
  readonly event:
    | SlackAppMentionEvent
    | SlackDirectMessageEvent
    | SlackAppHomeOpenedEvent
    | SlackAppUninstalledEvent
    | SlackTokensRevokedEvent;
}

interface SlackUrlVerificationEvent {
  readonly type: "url_verification";
  readonly challenge: string;
}

interface SlackAppMentionEvent {
  readonly type: "app_mention";
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly channel: string;
  readonly channel_type?: string;
  readonly thread_ts?: string;
  readonly files?: readonly SlackFile[];
}

interface SlackDirectMessageEvent {
  readonly type: "message";
  readonly channel_type: "im";
  readonly user: string;
  readonly text: string;
  readonly ts: string;
  readonly channel: string;
  readonly thread_ts?: string;
  readonly subtype?: string;
  readonly bot_id?: string;
  readonly files?: readonly SlackFile[];
}

interface SlackAppHomeOpenedEvent {
  readonly type: "app_home_opened";
  readonly user: string;
  readonly tab: "home" | "messages";
  readonly channel: string;
}

interface SlackAppUninstalledEvent {
  readonly type: "app_uninstalled";
}

interface SlackTokensRevokedEvent {
  readonly type: "tokens_revoked";
  readonly tokens: {
    readonly bot?: readonly string[];
  };
}

type SlackEvent = SlackUrlVerificationEvent | SlackEventCallback;

interface SlackInteractivePayload {
  readonly type: "view_submission" | "block_actions" | "shortcut";
  readonly user: {
    readonly id: string;
    readonly username: string;
    readonly team_id: string;
  };
  readonly team: {
    readonly id: string;
    readonly domain: string;
  };
  readonly trigger_id?: string;
  readonly actions?: readonly {
    readonly action_id: string;
    readonly block_id: string;
  }[];
  readonly view?: {
    readonly callback_id: string;
    readonly private_metadata?: string;
    readonly state: {
      readonly values: Record<
        string,
        Record<
          string,
          { readonly selected_option?: { readonly value: string } | null }
        >
      >;
    };
  };
}

interface ConnectionContext {
  readonly connection: SlackConnection;
  readonly installation: SlackInstallation;
  readonly orgId: string;
}

interface RunAgentParams {
  readonly agentId: string;
  readonly agentName: string;
  readonly orgId: string;
  readonly sessionId: string | undefined;
  readonly prompt: string;
  readonly threadContext: string;
  readonly userInfoExtras: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
  };
  readonly userId: string;
  readonly botUserId: string;
  readonly channelId: string;
  readonly channelType: "channel" | "dm" | "group_dm";
  readonly threadTs: string;
  readonly callbackContext: SlackCallbackPayload;
  readonly apiStartTime: number;
  readonly selectedModelOverride?: string;
}

type SlackChannelType = "channel" | "dm" | "group_dm";

interface SlackAgentMessageArgs {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: SlackChannelType;
  readonly slackUserId: string;
  readonly messageText: string;
  readonly messageTs: string;
  readonly threadTs?: string;
  readonly files?: readonly SlackFile[];
  readonly apiStartTime: number;
  readonly signal: AbortSignal;
}

interface ZeroSlackDispatchProbeInput {
  readonly workspaceId: string;
  readonly channelId: string;
  readonly channelType: SlackChannelType;
  readonly slackUserId: string;
  readonly messageText: string;
  readonly messageTs: string;
  readonly apiStartTime: number;
}

interface ResolvedSlackAgentMessage {
  readonly installation: SlackInstallation & { readonly orgId: string };
  readonly connection: SlackConnection;
  readonly client: ReturnType<typeof createSlackClient>;
  readonly threadTs: string;
  readonly composeId: string;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly displayName: string | null;
  };
}

interface CommandModelResponseArgs {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly payload: SlackCommandPayload;
  readonly installation: SlackInstallation;
  readonly connection: SlackConnection;
  readonly signal: AbortSignal;
}

interface RunAgentResult {
  readonly status: "accepted" | "queued" | "failed";
  readonly response?: string;
  readonly runId?: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function emptyResponse(): Response {
  return new Response("", { status: 200 });
}

function textResponse(text: string): Response {
  return new Response(text, { status: 200 });
}

function ephemeral(blocks: unknown[]): Response {
  return jsonResponse({ response_type: "ephemeral", blocks });
}

function parseCommandPayload(body: string): SlackCommandPayload {
  const params = new URLSearchParams(body);
  return {
    team_id: params.get("team_id") ?? "",
    channel_id: params.get("channel_id") ?? "",
    user_id: params.get("user_id") ?? "",
    text: params.get("text") ?? "",
    trigger_id: params.get("trigger_id") ?? "",
  };
}

async function verifiedSlackBody(
  request: Request,
): Promise<
  | { readonly ok: true; readonly body: string }
  | { readonly ok: false; readonly response: Response }
> {
  const signingSecret = optionalEnv("SLACK_SIGNING_SECRET");
  if (!signingSecret) {
    return {
      ok: false,
      response: jsonResponse(
        { error: "Slack integration is not configured" },
        503,
      ),
    };
  }

  const body = await request.text();
  const headers = getSlackSignatureHeaders(request.headers);
  if (!headers) {
    return {
      ok: false,
      response: jsonResponse({ error: "Missing Slack signature headers" }, 401),
    };
  }

  const valid = verifySlackSignature({
    signingSecret,
    signature: headers.signature,
    timestamp: headers.timestamp,
    body,
  });
  if (!valid) {
    return {
      ok: false,
      response: jsonResponse({ error: "Invalid signature" }, 401),
    };
  }

  return { ok: true, body };
}

function buildOrgConnectUrl(
  workspaceId: string,
  slackUserId: string,
  channelId: string,
  threadTs?: string,
): string {
  const params = new URLSearchParams({ w: workspaceId, u: slackUserId });
  if (channelId) {
    params.set("c", channelId);
  }
  if (threadTs) {
    params.set("t", threadTs);
  }
  return `${env("VM0_WEB_URL")}/settings/slack?${params.toString()}`;
}

function buildNotInstalledMessage(detail?: string): unknown[] {
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
          url: `${env("VM0_WEB_URL")}/works`,
          action_id: "open_platform_setup",
        },
      ],
    },
  ];
}

async function installationForWorkspace(
  db: Db,
  workspaceId: string,
): Promise<SlackInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId))
    .limit(1);
  return installation;
}

async function connectionForSlackUser(
  db: Db,
  workspaceId: string,
  slackUserId: string,
): Promise<SlackConnection | undefined> {
  const [connection] = await db
    .select()
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);
  return connection;
}

async function resolveConnectionContext(
  db: Db,
  slackUserId: string,
  workspaceId: string,
): Promise<ConnectionContext | null> {
  const installation = await installationForWorkspace(db, workspaceId);
  if (!installation?.orgId) {
    return null;
  }
  const connection = await connectionForSlackUser(db, workspaceId, slackUserId);
  if (!connection) {
    return null;
  }
  return { connection, installation, orgId: installation.orgId };
}

async function resolveDefaultComposeId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return row?.defaultAgentId ?? null;
}

async function getUserAgentPreference(
  db: Db,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ selectedComposeId: slackUserAgentPreferences.selectedComposeId })
    .from(slackUserAgentPreferences)
    .where(
      and(
        eq(slackUserAgentPreferences.vm0UserId, vm0UserId),
        eq(slackUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return row?.selectedComposeId ?? null;
}

async function setUserAgentPreference(args: {
  readonly db: Db;
  readonly vm0UserId: string;
  readonly orgId: string;
  readonly composeId: string | null;
}): Promise<void> {
  await args.db
    .insert(slackUserAgentPreferences)
    .values({
      vm0UserId: args.vm0UserId,
      orgId: args.orgId,
      selectedComposeId: args.composeId,
    })
    .onConflictDoUpdate({
      target: [
        slackUserAgentPreferences.vm0UserId,
        slackUserAgentPreferences.orgId,
      ],
      set: {
        selectedComposeId: args.composeId,
        updatedAt: nowDate(),
      },
    });
}

async function getWorkspaceAgent(
  db: Db,
  composeId: string,
  orgId?: string,
): Promise<
  | {
      readonly id: string;
      readonly name: string;
      readonly displayName: string | null;
    }
  | undefined
> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(
      orgId
        ? and(eq(zeroAgents.id, composeId), eq(zeroAgents.orgId, orgId))
        : eq(zeroAgents.id, composeId),
    )
    .limit(1);
  return agent;
}

async function resolveEffectiveComposeId(
  db: Db,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const override = await getUserAgentPreference(db, vm0UserId, orgId);
  if (override) {
    const [row] = await db
      .select({ id: zeroAgents.id })
      .from(zeroAgents)
      .where(and(eq(zeroAgents.id, override), eq(zeroAgents.orgId, orgId)))
      .limit(1);
    if (row?.id) {
      return override;
    }
  }
  return resolveDefaultComposeId(db, orgId);
}

async function disconnect(db: Db, connectionId: string): Promise<void> {
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connectionId));
}

async function cleanupWorkspaceInstallation(
  set: ComputedSetter,
  db: Db,
  workspaceId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const installation = await installationForWorkspace(db, workspaceId);
  signal.throwIfAborted();
  if (!installation) {
    return false;
  }
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.slackWorkspaceId, workspaceId));
  signal.throwIfAborted();
  await db
    .delete(slackOrgInstallations)
    .where(eq(slackOrgInstallations.slackWorkspaceId, workspaceId));
  signal.throwIfAborted();
  if (installation.orgId) {
    await set(
      publishSlackAdminSignal$,
      { orgId: installation.orgId, topic: "slack:changed" },
      signal,
    );
  }
  return true;
}

async function slackModelPickerState(
  get: ComputedGetter,
  set: ComputedSetter,
  orgId: string,
  userId: string,
  signal: AbortSignal,
): Promise<{
  readonly enabled: boolean;
  readonly options: readonly {
    readonly model: SupportedRunModel;
    readonly label: string;
    readonly isDefault: boolean;
  }[];
  readonly currentSelectedModel: string | null;
}> {
  const visibleModels = new Set(getVm0VisibleModels());
  const [policies, preference] = await Promise.all([
    set(listOrgModelPolicies$, { orgId, userId }, signal),
    get(userModelPreference({ orgId, userId })),
  ]);
  return {
    enabled: true,
    options: policies.policies.flatMap((policy) => {
      if (
        !isSupportedRunModel(policy.model) ||
        !visibleModels.has(policy.model) ||
        policy.routeStatus !== "valid"
      ) {
        return [];
      }
      return {
        model: policy.model,
        label: policy.modelLabel,
        isDefault: policy.isDefault,
      };
    }),
    currentSelectedModel: preference.selectedModel,
  };
}

async function isModelCommandAvailable(
  get: ComputedGetter,
  set: ComputedSetter,
  installation: SlackInstallation | undefined,
  connection: SlackConnection | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (!installation?.orgId || !connection) {
    return false;
  }
  const picker = await slackModelPickerState(
    get,
    set,
    installation.orgId,
    connection.vm0UserId,
    signal,
  );
  return picker.enabled && picker.options.length > 0;
}

async function refreshOrgAppHome(
  db: Db,
  installation: SlackInstallation,
  slackUserId: string,
): Promise<void> {
  const workspaceId = installation.slackWorkspaceId;
  const botToken = decryptSecretValue(installation.encryptedBotToken);
  const client = createSlackClient(botToken);
  const connection = await connectionForSlackUser(db, workspaceId, slackUserId);
  if (!connection) {
    await publishAppHome(
      client,
      slackUserId,
      buildAppHomeView({
        isLinked: false,
        loginUrl: buildOrgConnectUrl(workspaceId, slackUserId, ""),
      }),
    );
    return;
  }

  let agentName: string | undefined;
  let isOverrideActive = false;
  let canSwitch = false;
  if (installation.orgId) {
    const orgId = installation.orgId;
    const [effectiveComposeId, overrideComposeId, defaultComposeId] =
      await Promise.all([
        resolveEffectiveComposeId(db, connection.vm0UserId, orgId),
        getUserAgentPreference(db, connection.vm0UserId, orgId),
        resolveDefaultComposeId(db, orgId),
      ]);
    if (effectiveComposeId) {
      const agent = await getWorkspaceAgent(db, effectiveComposeId);
      agentName = agent?.displayName ?? agent?.name;
    }
    isOverrideActive = Boolean(
      overrideComposeId && overrideComposeId !== defaultComposeId,
    );
    canSwitch = Boolean(defaultComposeId);
  }

  const [metadata] = await db
    .select({ email: userCache.email })
    .from(userCache)
    .where(eq(userCache.userId, connection.vm0UserId))
    .limit(1);

  await publishAppHome(
    client,
    slackUserId,
    buildAppHomeView({
      isLinked: true,
      vm0UserId: connection.vm0UserId,
      userEmail: metadata?.email ?? undefined,
      agentName,
      isOverrideActive,
      canSwitch,
    }),
  );
}

async function commandSwitchResponse(
  get: ComputedGetter,
  db: Db,
  payload: SlackCommandPayload,
  installation: SlackInstallation,
  connection: SlackConnection,
): Promise<Response> {
  if (!installation.orgId) {
    return ephemeral(
      buildErrorMessage(
        "This workspace is not bound to an org. Please contact your admin.",
      ),
    );
  }
  if (!payload.trigger_id) {
    return ephemeral(
      buildErrorMessage(
        "Couldn't open the agent picker \u2014 please try again.",
      ),
    );
  }
  const { composes } = await get(zeroComposeList(installation.orgId));
  const defaultComposeId = await resolveDefaultComposeId(
    db,
    installation.orgId,
  );
  const options = composes
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
  const orgDefaultName = defaultComposeId
    ? ((await getWorkspaceAgent(db, defaultComposeId))?.displayName ??
      (await getWorkspaceAgent(db, defaultComposeId))?.name ??
      null)
    : null;
  const currentOverride = await getUserAgentPreference(
    db,
    connection.vm0UserId,
    installation.orgId,
  );
  const client = createSlackClient(
    decryptSecretValue(installation.encryptedBotToken),
  );
  const result = await safeAsync(() => {
    return openView(
      client,
      payload.trigger_id,
      buildAgentPickerModal({
        options,
        currentSelectedId: currentOverride,
        orgDefaultName,
        privateMetadata: JSON.stringify({ channelId: payload.channel_id }),
      }),
    );
  });
  if ("error" in result) {
    L.warn("Failed to open agent picker modal", { error: result.error });
    return ephemeral(
      buildErrorMessage(
        "Couldn't open the agent picker \u2014 please try again.",
      ),
    );
  }
  return emptyResponse();
}

async function commandModelResponse(
  args: CommandModelResponseArgs,
): Promise<Response> {
  if (!args.installation.orgId) {
    return ephemeral(
      buildErrorMessage(
        "This workspace is not bound to an org. Please contact your admin.",
      ),
    );
  }
  if (!args.payload.trigger_id) {
    return ephemeral(
      buildErrorMessage(
        "Couldn't open the model picker \u2014 please try again.",
      ),
    );
  }
  const picker = await slackModelPickerState(
    args.get,
    args.set,
    args.installation.orgId,
    args.connection.vm0UserId,
    args.signal,
  );
  if (!picker.enabled) {
    return ephemeral(
      buildErrorMessage("Model switching is not available for this workspace."),
    );
  }
  if (picker.options.length === 0) {
    return ephemeral(
      buildErrorMessage("No models are configured for this workspace."),
    );
  }
  const client = createSlackClient(
    decryptSecretValue(args.installation.encryptedBotToken),
  );
  const result = await safeAsync(() => {
    return openView(
      client,
      args.payload.trigger_id,
      buildModelPickerModal({
        options: picker.options.slice(0, MODEL_PICKER_MAX_OPTIONS),
        currentSelectedModel: picker.currentSelectedModel,
        privateMetadata: JSON.stringify({ channelId: args.payload.channel_id }),
      }),
    );
  });
  if ("error" in result) {
    L.warn("Failed to open model picker modal", { error: result.error });
    return ephemeral(
      buildErrorMessage(
        "Couldn't open the model picker \u2014 please try again.",
      ),
    );
  }
  return emptyResponse();
}

export const handleZeroSlackCommands$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const verified = await verifiedSlackBody(request.raw);
    signal.throwIfAborted();
    if (!verified.ok) {
      return verified.response;
    }

    const payload = parseCommandPayload(verified.body);
    const db = set(writeDb$);
    const args = payload.text.trim().split(/\s+/);
    const subCommand = args[0]?.toLowerCase() ?? "";
    const installation = await installationForWorkspace(db, payload.team_id);
    signal.throwIfAborted();
    const connection = installation
      ? await connectionForSlackUser(db, payload.team_id, payload.user_id)
      : undefined;
    signal.throwIfAborted();
    const canSwitchAgents = Boolean(installation?.orgId);
    const canModel = () => {
      return isModelCommandAvailable(
        get,
        set,
        installation,
        connection,
        signal,
      );
    };

    if (subCommand === "help" || subCommand === "") {
      return ephemeral(
        buildHelpMessage({
          canSwitch: canSwitchAgents,
          canModel: await canModel(),
        }),
      );
    }

    if (subCommand === "connect") {
      if (!installation) {
        return ephemeral(
          buildNotInstalledMessage(
            "The Zero Slack app hasn't been set up for this workspace yet. An org admin can complete the setup from the platform.",
          ),
        );
      }
      if (connection) {
        return ephemeral(
          buildSuccessMessage(
            "You are already connected.\nMention `@Zero` in any channel or send a DM to start chatting with your agent.",
          ),
        );
      }
      return ephemeral(
        buildLoginMessage(
          buildOrgConnectUrl(
            payload.team_id,
            payload.user_id,
            payload.channel_id,
          ),
        ),
      );
    }

    if (!installation) {
      return ephemeral(buildNotInstalledMessage());
    }

    if (subCommand === "disconnect") {
      if (!connection) {
        return ephemeral(buildErrorMessage("You are not connected."));
      }
      await disconnect(db, connection.id);
      signal.throwIfAborted();
      waitUntil(
        refreshOrgAppHome(db, installation, payload.user_id).catch((error) => {
          L.warn("Failed to refresh App Home after disconnect", { error });
        }),
      );
      return ephemeral(
        buildSuccessMessage(
          "You have been disconnected and your agent access has been revoked.",
        ),
      );
    }

    if (!connection) {
      return ephemeral(
        buildLoginMessage(
          buildOrgConnectUrl(
            payload.team_id,
            payload.user_id,
            payload.channel_id,
          ),
        ),
      );
    }

    if (subCommand === "switch") {
      return commandSwitchResponse(get, db, payload, installation, connection);
    }

    if (subCommand === "model") {
      return commandModelResponse({
        get,
        set,
        payload,
        installation,
        connection,
        signal,
      });
    }

    return ephemeral(
      buildHelpMessage({
        canSwitch: canSwitchAgents,
        canModel: await canModel(),
      }),
    );
  },
);

function buildSlackPrompt(args: {
  readonly botUserId: string;
  readonly channelId: string;
  readonly channelType: "channel" | "dm" | "group_dm";
  readonly threadTs: string;
  readonly threadContext: string;
}): string {
  const typeLabel =
    args.channelType === "dm"
      ? "Direct message"
      : args.channelType === "group_dm"
        ? "Group direct message"
        : "Channel";
  return [
    "# Current Integration",
    "You are currently running inside: Slack",
    `Your bot user ID: ${args.botUserId}`,
    `Channel ID: ${args.channelId}`,
    `Channel type: ${typeLabel}`,
    `Thread ID: ${args.threadTs}`,
    args.threadContext,
  ]
    .filter(Boolean)
    .join("\n");
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

async function runAgentForSlackOrg(
  set: ComputedSetter,
  params: RunAgentParams,
  signal: AbortSignal,
): Promise<RunAgentResult> {
  const result = await set(
    createZeroRun$,
    {
      auth: {
        tokenType: "session",
        userId: params.userId,
        orgId: params.orgId,
        orgRole: "member",
      },
      body: {
        prompt: params.prompt,
        agentId: params.agentId,
        sessionId: params.sessionId,
      },
      apiStartTime: params.apiStartTime,
      triggerSource: "slack",
      appendSystemPrompt: buildSlackPrompt(params),
      userInfoExtras: params.userInfoExtras,
      selectedModelOverride: params.selectedModelOverride,
      callbacks: [
        {
          url: `${env("VM0_API_URL")}/api/internal/callbacks/slack/org`,
          secret: generateCallbackSecret(),
          payload: params.callbackContext,
        },
      ],
    },
    signal,
  );
  if (result.status === 201) {
    return {
      status: result.body.status === "queued" ? "queued" : "accepted",
      runId: result.body.runId,
    };
  }

  const guidance = RUN_ERROR_GUIDANCE[result.body.error.code];
  return {
    status: "failed",
    response: guidance
      ? `${guidance.title}: ${guidance.guidance}`
      : result.body.error.message,
  };
}

async function resolveCompatibleThreadSession(args: {
  readonly db: Db;
  readonly channelId: string;
  readonly threadTs: string;
  readonly connectionId: string;
  readonly userId: string;
  readonly agentComposeId: string;
  readonly selectedModelOverride?: string;
}): Promise<string | undefined> {
  const [session] = await args.db
    .select({
      agentSessionId: slackOrgThreadSessions.agentSessionId,
    })
    .from(slackOrgThreadSessions)
    .where(
      and(
        eq(slackOrgThreadSessions.connectionId, args.connectionId),
        eq(slackOrgThreadSessions.slackChannelId, args.channelId),
        eq(slackOrgThreadSessions.slackThreadTs, args.threadTs),
      ),
    )
    .limit(1);
  if (!session?.agentSessionId) {
    return undefined;
  }
  const [agentSession] = await args.db
    .select({
      agentComposeId: agentSessions.agentComposeId,
      conversationId: agentSessions.conversationId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, session.agentSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (agentSession?.agentComposeId !== args.agentComposeId) {
    return undefined;
  }

  if (args.selectedModelOverride && agentSession.conversationId) {
    const [previousRun] = await args.db
      .select({ selectedModel: zeroRuns.selectedModel })
      .from(conversations)
      .innerJoin(zeroRuns, eq(zeroRuns.id, conversations.runId))
      .where(eq(conversations.id, agentSession.conversationId))
      .limit(1);
    if (
      previousRun?.selectedModel &&
      previousRun.selectedModel !== args.selectedModelOverride
    ) {
      return undefined;
    }
  }

  return session.agentSessionId;
}

async function postPreDispatchErrorReply(args: {
  readonly get: ComputedGetter;
  readonly db: Db;
  readonly client: ReturnType<typeof createSlackClient>;
  readonly channelId: string;
  readonly threadTs: string;
  readonly errorText: string;
  readonly orgId: string;
  readonly vm0UserId: string;
  readonly composeId: string;
  readonly agentLabel: string;
}): Promise<void> {
  const overrides = await args.get(
    userFeatureSwitchOverrides(args.orgId, args.vm0UserId),
  );
  const logsUrl = isFeatureEnabled(FeatureSwitchKey.AuditLink, {
    userId: args.vm0UserId,
    orgId: args.orgId,
    overrides,
  })
    ? `${env("VM0_WEB_URL")}/activities`
    : undefined;
  const orgDefaultComposeId = await resolveDefaultComposeId(
    args.db,
    args.orgId,
  );
  const triggeredBy =
    args.composeId !== orgDefaultComposeId
      ? `Sent via ${args.agentLabel}`
      : undefined;
  await args.client.chat.postMessage({
    channel: args.channelId,
    thread_ts: args.threadTs,
    text: args.errorText,
    blocks: buildAgentResponseMessage(args.errorText, logsUrl, triggeredBy),
  });
}

async function postSlackUserNotice(args: {
  readonly client: ReturnType<typeof createSlackClient>;
  readonly channelId: string;
  readonly channelType: SlackChannelType;
  readonly slackUserId: string;
  readonly threadTs: string;
  readonly ephemeralThreadTs?: string;
  readonly text: string;
  readonly blocks?: (Block | KnownBlock)[];
}): Promise<void> {
  if (args.channelType === "dm") {
    await postMessage(args.client, args.channelId, args.text, {
      threadTs: args.threadTs,
      blocks: args.blocks,
    });
    return;
  }

  await args.client.chat.postEphemeral({
    channel: args.channelId,
    user: args.slackUserId,
    ...(args.ephemeralThreadTs && { thread_ts: args.ephemeralThreadTs }),
    text: args.text,
    ...(args.blocks && { blocks: args.blocks }),
  });
}

async function resolveSlackAgentMessage(
  args: SlackAgentMessageArgs,
): Promise<ResolvedSlackAgentMessage | null> {
  const installation = await installationForWorkspace(
    args.db,
    args.workspaceId,
  );
  const orgId = installation?.orgId;
  if (!installation || !orgId) {
    return null;
  }
  const boundInstallation = { ...installation, orgId };
  const botToken = decryptSecretValue(installation.encryptedBotToken);
  const client = createSlackClient(botToken);
  const threadTs = args.threadTs ?? args.messageTs;
  const connection = await connectionForSlackUser(
    args.db,
    args.workspaceId,
    args.slackUserId,
  );

  if (!connection) {
    const connectUrl = buildOrgConnectUrl(
      args.workspaceId,
      args.slackUserId,
      args.channelId,
      args.channelType === "dm" ? threadTs : undefined,
    );
    await postSlackUserNotice({
      client,
      channelId: args.channelId,
      channelType: args.channelType,
      slackUserId: args.slackUserId,
      threadTs,
      text: "Please connect your account first",
      blocks: buildLoginPromptMessage(connectUrl),
    });
    return null;
  }

  const composeId = await resolveEffectiveComposeId(
    args.db,
    connection.vm0UserId,
    boundInstallation.orgId,
  );
  if (!composeId) {
    await postSlackUserNotice({
      client,
      channelId: args.channelId,
      channelType: args.channelType,
      slackUserId: args.slackUserId,
      threadTs,
      ephemeralThreadTs: args.threadTs ? threadTs : undefined,
      text: "No agent is configured for this org. Please ask your org admin to set a default agent.",
    });
    return null;
  }

  const agent = await getWorkspaceAgent(
    args.db,
    composeId,
    boundInstallation.orgId,
  );
  if (!agent) {
    await postSlackUserNotice({
      client,
      channelId: args.channelId,
      channelType: args.channelType,
      slackUserId: args.slackUserId,
      threadTs,
      ephemeralThreadTs: args.threadTs ? threadTs : undefined,
      text: "The configured agent could not be found. Please contact your org admin.",
    });
    return null;
  }

  return {
    installation: boundInstallation,
    connection,
    client,
    threadTs,
    composeId,
    agent,
  };
}

async function buildRunAgentParams(
  args: SlackAgentMessageArgs,
  resolved: ResolvedSlackAgentMessage,
): Promise<RunAgentParams> {
  const { prompt, userInfoExtras } = await enrichMessageContent({
    messageContent: args.messageText,
    files: args.files,
    client: resolved.client,
    userId: args.slackUserId,
  });
  const selectedModelOverride = (
    await args.get(
      userModelPreference({
        orgId: resolved.installation.orgId,
        userId: resolved.connection.vm0UserId,
      }),
    )
  ).selectedModel;
  const existingSessionId = await resolveCompatibleThreadSession({
    db: args.db,
    channelId: args.channelId,
    threadTs: resolved.threadTs,
    connectionId: resolved.connection.id,
    userId: resolved.connection.vm0UserId,
    agentComposeId: resolved.composeId,
    selectedModelOverride: selectedModelOverride ?? undefined,
  });
  const { executionContext } = await fetchConversationContexts(
    resolved.client,
    args.channelId,
    args.threadTs,
    args.messageTs,
  );
  const callbackContext: SlackCallbackPayload = {
    workspaceId: args.workspaceId,
    channelId: args.channelId,
    threadTs: resolved.threadTs,
    messageTs: args.messageTs,
    connectionId: resolved.connection.id,
    agentId: resolved.composeId,
    existingSessionId,
  };

  return {
    agentId: resolved.composeId,
    agentName: resolved.agent.name,
    orgId: resolved.installation.orgId,
    sessionId: existingSessionId,
    prompt,
    threadContext: executionContext,
    userInfoExtras,
    userId: resolved.connection.vm0UserId,
    botUserId: resolved.installation.botUserId,
    channelId: args.channelId,
    channelType: args.channelType,
    threadTs: resolved.threadTs,
    callbackContext,
    apiStartTime: args.apiStartTime,
    selectedModelOverride: selectedModelOverride ?? undefined,
  };
}

async function handleSlackRunResult(args: {
  readonly message: SlackAgentMessageArgs;
  readonly resolved: ResolvedSlackAgentMessage;
  readonly result: RunAgentResult;
}): Promise<void> {
  const { message, resolved, result } = args;
  if (result.status === "queued") {
    const queueUrl = `${env("VM0_WEB_URL")}/?queue=1`;
    await resolved.client.chat.postEphemeral({
      channel: message.channelId,
      user: message.slackUserId,
      ...(message.channelType === "dm" || message.threadTs
        ? { thread_ts: resolved.threadTs }
        : {}),
      text: `\u26a0 Run queued -- concurrency limit reached. Will start automatically when a slot is available. <${queueUrl}|View queue>`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: ":warning: *Run queued*\n\nConcurrency limit reached. Will start automatically when a slot is available.",
          },
        },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `<${queueUrl}|View queue>` }],
        },
      ],
    });
  } else if (result.status === "failed") {
    if (!result.runId) {
      await postPreDispatchErrorReply({
        get: message.get,
        db: message.db,
        client: resolved.client,
        channelId: message.channelId,
        threadTs: resolved.threadTs,
        errorText:
          result.response ?? "Sorry, an error occurred. Please try again.",
        orgId: resolved.installation.orgId,
        vm0UserId: resolved.connection.vm0UserId,
        composeId: resolved.composeId,
        agentLabel: resolved.agent.displayName ?? resolved.agent.name,
      });
    }
    await setThreadStatus(
      resolved.client,
      message.channelId,
      resolved.threadTs,
      "",
    ).catch((error) => {
      L.warn("Failed to clear thread status", { error });
    });
  }
}

async function handleSlackAgentMessage(
  args: SlackAgentMessageArgs,
): Promise<void> {
  const resolved = await resolveSlackAgentMessage(args);
  if (!resolved) {
    return;
  }

  await setThreadStatus(
    resolved.client,
    args.channelId,
    resolved.threadTs,
    "is thinking...",
  );
  const runParams = await buildRunAgentParams(args, resolved);
  const result = await runAgentForSlackOrg(args.set, runParams, args.signal);
  await handleSlackRunResult({ message: args, resolved, result });
}

export const dispatchZeroSlackProbe$ = command(
  async (
    { get, set },
    input: ZeroSlackDispatchProbeInput,
    signal: AbortSignal,
  ): Promise<void> => {
    await handleSlackAgentMessage({
      get,
      set,
      db: set(writeDb$),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      channelType: input.channelType,
      slackUserId: input.slackUserId,
      messageText: input.messageText,
      messageTs: input.messageTs,
      apiStartTime: input.apiStartTime,
      signal,
    });
  },
);

async function handleAppHomeOpened(
  db: Db,
  workspaceId: string,
  slackUserId: string,
): Promise<void> {
  const installation = await installationForWorkspace(db, workspaceId);
  if (!installation) {
    return;
  }
  await refreshOrgAppHome(db, installation, slackUserId);
}

async function handleMessagesTabOpened(
  db: Db,
  workspaceId: string,
  slackUserId: string,
  channelId: string,
): Promise<void> {
  const installation = await installationForWorkspace(db, workspaceId);
  if (!installation) {
    return;
  }
  const [connection] = await db
    .select({ id: slackOrgConnections.id })
    .from(slackOrgConnections)
    .where(
      and(
        eq(slackOrgConnections.slackUserId, slackUserId),
        eq(slackOrgConnections.slackWorkspaceId, workspaceId),
      ),
    )
    .limit(1);
  if (!connection) {
    return;
  }
  const updated = await db
    .update(slackOrgConnections)
    .set({ dmWelcomeSent: true })
    .where(
      and(
        eq(slackOrgConnections.id, connection.id),
        eq(slackOrgConnections.dmWelcomeSent, false),
      ),
    );
  if (updated.rowCount === 0) {
    return;
  }
  const agentName = installation.orgId
    ? await resolveDefaultComposeId(db, installation.orgId).then(
        async (composeId) => {
          const agent = composeId
            ? await getWorkspaceAgent(db, composeId)
            : undefined;
          return agent?.displayName ?? agent?.name;
        },
      )
    : undefined;
  await postMessage(
    createSlackClient(decryptSecretValue(installation.encryptedBotToken)),
    channelId,
    "Hi! I'm Zero. I can connect you to AI agents to help with your tasks.",
    { blocks: buildWelcomeMessage(agentName) },
  );
}

function handleEventCallback(args: {
  readonly get: ComputedGetter;
  readonly set: ComputedSetter;
  readonly db: Db;
  readonly payload: SlackEventCallback;
  readonly apiStartTime: number;
  readonly signal: AbortSignal;
}): void {
  const event = args.payload.event;
  if (event.type === "app_mention") {
    waitUntil(
      handleSlackAgentMessage({
        ...args,
        workspaceId: args.payload.team_id,
        channelId: event.channel,
        channelType:
          event.channel_type === "im"
            ? "dm"
            : event.channel_type === "mpim"
              ? "group_dm"
              : "channel",
        slackUserId: event.user,
        messageText: event.text,
        messageTs: event.ts,
        threadTs: event.thread_ts,
        files: event.files,
      }).catch((error) => {
        L.error("Error handling org app_mention", { error });
      }),
    );
  }

  if (
    event.type === "message" &&
    event.channel_type === "im" &&
    (!event.subtype || event.subtype === "file_share") &&
    !event.bot_id
  ) {
    waitUntil(
      handleSlackAgentMessage({
        ...args,
        workspaceId: args.payload.team_id,
        channelId: event.channel,
        channelType: "dm",
        slackUserId: event.user,
        messageText: event.text,
        messageTs: event.ts,
        threadTs: event.thread_ts,
        files: event.files,
      }).catch((error) => {
        L.error("Error handling org direct_message", { error });
      }),
    );
  }

  if (event.type === "app_home_opened" && event.tab === "home") {
    waitUntil(
      handleAppHomeOpened(args.db, args.payload.team_id, event.user).catch(
        (error) => {
          L.error("Error handling org app_home_opened", { error });
        },
      ),
    );
  }

  if (event.type === "app_home_opened" && event.tab === "messages") {
    waitUntil(
      handleMessagesTabOpened(
        args.db,
        args.payload.team_id,
        event.user,
        event.channel,
      ).catch((error) => {
        L.error("Error handling org messages_tab_opened", { error });
      }),
    );
  }

  if (event.type === "app_uninstalled") {
    waitUntil(
      cleanupWorkspaceInstallation(
        args.set,
        args.db,
        args.payload.team_id,
        args.signal,
      ).catch((error) => {
        L.error("Error handling app_uninstalled", { error });
      }),
    );
  }

  if (event.type === "tokens_revoked" && event.tokens.bot?.length) {
    waitUntil(
      cleanupWorkspaceInstallation(
        args.set,
        args.db,
        args.payload.team_id,
        args.signal,
      ).catch((error) => {
        L.error("Error handling tokens_revoked", { error });
      }),
    );
  }
}

export const handleZeroSlackEvents$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const apiStartTime = now();
    const verified = await verifiedSlackBody(request.raw);
    signal.throwIfAborted();
    if (!verified.ok) {
      return verified.response;
    }

    const parsedPayload = safeJsonParse(verified.body);
    if (parsedPayload === undefined) {
      return jsonResponse({ error: "Invalid JSON payload" }, 400);
    }
    const payload = parsedPayload as SlackEvent;

    if (payload.type === "url_verification") {
      return jsonResponse({ challenge: payload.challenge });
    }

    if (payload.type === "event_callback") {
      if (request.header("x-slack-retry-num")) {
        return textResponse("OK");
      }
      handleEventCallback({
        get,
        set,
        db: set(writeDb$),
        payload,
        apiStartTime,
        signal,
      });
      return textResponse("OK");
    }

    return textResponse("OK");
  },
);

function parseViewChannelId(
  privateMetadata: string | undefined,
): string | undefined {
  if (!privateMetadata) {
    return undefined;
  }
  const metadata = safeJsonParse(privateMetadata);
  const channelId =
    typeof metadata === "object" && metadata !== null && "channelId" in metadata
      ? metadata.channelId
      : undefined;
  return typeof channelId === "string" && channelId.length > 0
    ? channelId
    : undefined;
}

async function postEphemeralMessage(args: {
  readonly botToken: string;
  readonly channel: string;
  readonly slackUserId: string;
  readonly text: string;
}): Promise<void> {
  await createSlackClient(args.botToken).chat.postEphemeral({
    channel: args.channel,
    user: args.slackUserId,
    text: args.text,
  });
}

async function resolveOrgDefaultName(db: Db, orgId: string): Promise<string> {
  const defaultComposeId = await resolveDefaultComposeId(db, orgId);
  if (!defaultComposeId) {
    return "the org default agent";
  }
  const agent = await getWorkspaceAgent(db, defaultComposeId);
  return agent?.displayName ?? agent?.name ?? "the org default agent";
}

async function handleAgentPickerSubmit(
  db: Db,
  payload: SlackInteractivePayload,
): Promise<Response> {
  const selected =
    payload.view?.state.values[AGENT_PICKER_BLOCK_ID]?.[AGENT_PICKER_ACTION_ID]
      ?.selected_option?.value;
  if (!selected) {
    return jsonResponse({
      response_action: "errors",
      errors: { [AGENT_PICKER_BLOCK_ID]: "Please choose an agent." },
    });
  }
  const ctx = await resolveConnectionContext(
    db,
    payload.user.id,
    payload.team.id,
  );
  if (!ctx) {
    return emptyResponse();
  }
  const botToken = decryptSecretValue(ctx.installation.encryptedBotToken);
  const channelId = parseViewChannelId(payload.view?.private_metadata);
  if (selected === AGENT_PICKER_ORG_DEFAULT_VALUE) {
    const defaultName = await resolveOrgDefaultName(db, ctx.orgId);
    await setUserAgentPreference({
      db,
      vm0UserId: ctx.connection.vm0UserId,
      orgId: ctx.orgId,
      composeId: null,
    });
    if (channelId) {
      await postEphemeralMessage({
        botToken,
        channel: channelId,
        slackUserId: payload.user.id,
        text: `Switched to *${defaultName}*.`,
      });
    }
    waitUntil(refreshOrgAppHome(db, ctx.installation, payload.user.id));
    return emptyResponse();
  }

  const agent = await getWorkspaceAgent(db, selected, ctx.orgId);
  if (!agent || agent.id !== selected) {
    return jsonResponse({
      response_action: "errors",
      errors: {
        [AGENT_PICKER_BLOCK_ID]: "You don't have access to that agent.",
      },
    });
  }
  await setUserAgentPreference({
    db,
    vm0UserId: ctx.connection.vm0UserId,
    orgId: ctx.orgId,
    composeId: agent.id,
  });
  if (channelId) {
    await postEphemeralMessage({
      botToken,
      channel: channelId,
      slackUserId: payload.user.id,
      text: `Switched to *${agent.displayName ?? agent.name}*.`,
    });
  }
  waitUntil(refreshOrgAppHome(db, ctx.installation, payload.user.id));
  return emptyResponse();
}

async function handleModelPickerSubmit(
  get: ComputedGetter,
  set: ComputedSetter,
  db: Db,
  payload: SlackInteractivePayload,
  signal: AbortSignal,
): Promise<Response> {
  const selected =
    payload.view?.state.values[MODEL_PICKER_BLOCK_ID]?.[MODEL_PICKER_ACTION_ID]
      ?.selected_option?.value;
  if (!selected) {
    return jsonResponse({
      response_action: "errors",
      errors: { [MODEL_PICKER_BLOCK_ID]: "Please choose a model." },
    });
  }
  const ctx = await resolveConnectionContext(
    db,
    payload.user.id,
    payload.team.id,
  );
  if (!ctx) {
    return emptyResponse();
  }
  const picker = await slackModelPickerState(
    get,
    set,
    ctx.orgId,
    ctx.connection.vm0UserId,
    signal,
  );
  const option = picker.options.find((candidate) => {
    return candidate.model === selected;
  });
  if (!option) {
    return jsonResponse({
      response_action: "errors",
      errors: {
        [MODEL_PICKER_BLOCK_ID]: "You don't have access to that model.",
      },
    });
  }
  await set(
    updateUserModelPreference$,
    {
      orgId: ctx.orgId,
      userId: ctx.connection.vm0UserId,
      preference: { selectedModel: option.model },
    },
    signal,
  );
  const channelId = parseViewChannelId(payload.view?.private_metadata);
  if (channelId) {
    await postEphemeralMessage({
      botToken: decryptSecretValue(ctx.installation.encryptedBotToken),
      channel: channelId,
      slackUserId: payload.user.id,
      text: `Switched to *${option.label}*.`,
    });
  }
  return emptyResponse();
}

async function handleHomeSwitchAgent(
  get: ComputedGetter,
  db: Db,
  payload: SlackInteractivePayload,
): Promise<void> {
  if (!payload.trigger_id) {
    return;
  }
  const triggerId = payload.trigger_id;
  const ctx = await resolveConnectionContext(
    db,
    payload.user.id,
    payload.team.id,
  );
  if (!ctx) {
    return;
  }
  const { composes } = await get(zeroComposeList(ctx.orgId));
  const defaultComposeId = await resolveDefaultComposeId(db, ctx.orgId);
  const options = composes
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
  const orgDefaultName = defaultComposeId
    ? ((await getWorkspaceAgent(db, defaultComposeId))?.displayName ??
      (await getWorkspaceAgent(db, defaultComposeId))?.name ??
      null)
    : null;
  const currentOverride = await getUserAgentPreference(
    db,
    ctx.connection.vm0UserId,
    ctx.orgId,
  );
  const result = await safeAsync(() => {
    return openView(
      createSlackClient(decryptSecretValue(ctx.installation.encryptedBotToken)),
      triggerId,
      buildAgentPickerModal({
        options,
        currentSelectedId: currentOverride,
        orgDefaultName,
      }),
    );
  });
  if ("error" in result) {
    L.warn("Failed to open switch modal from App Home", {
      error: result.error,
    });
  }
}

async function handleHomeDisconnect(
  db: Db,
  payload: SlackInteractivePayload,
): Promise<void> {
  const connection = await connectionForSlackUser(
    db,
    payload.team.id,
    payload.user.id,
  );
  if (!connection) {
    return;
  }
  await disconnect(db, connection.id);
  const installation = await installationForWorkspace(db, payload.team.id);
  if (!installation) {
    return;
  }
  await refreshOrgAppHome(db, installation, payload.user.id);
}

export const handleZeroSlackInteractive$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<Response> => {
    const request = get(request$);
    const verified = await verifiedSlackBody(request.raw);
    signal.throwIfAborted();
    if (!verified.ok) {
      return verified.response;
    }

    const payloadString = new URLSearchParams(verified.body).get("payload");
    if (!payloadString) {
      return jsonResponse({ error: "Missing payload" }, 400);
    }

    const parsedPayload = safeJsonParse(payloadString);
    if (parsedPayload === undefined) {
      return jsonResponse({ error: "Invalid payload" }, 400);
    }
    const payload = parsedPayload as SlackInteractivePayload;

    const db = set(writeDb$);
    if (
      payload.type === "view_submission" &&
      payload.view?.callback_id === AGENT_PICKER_CALLBACK_ID
    ) {
      return handleAgentPickerSubmit(db, payload);
    }
    if (
      payload.type === "view_submission" &&
      payload.view?.callback_id === MODEL_PICKER_CALLBACK_ID
    ) {
      return handleModelPickerSubmit(get, set, db, payload, signal);
    }
    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      if (!action) {
        return emptyResponse();
      }
      if (action.action_id === "home_disconnect") {
        await handleHomeDisconnect(db, payload);
      } else if (action.action_id === "home_switch_agent") {
        await handleHomeSwitchAgent(get, db, payload);
      }
    }
    return emptyResponse();
  },
);
