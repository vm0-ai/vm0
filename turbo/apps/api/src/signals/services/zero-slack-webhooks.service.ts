import { randomBytes } from "node:crypto";

import { command, computed, type Computed } from "ccstate";
import type { Block, KnownBlock } from "@slack/web-api";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@vm0/core/feature-switch";
import {
  getVm0VisibleModels,
  isSupportedRunModel,
  type ModelProviderCredentialScope,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { computerUseHosts } from "@vm0/db/schema/computer-use-host";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { slackOrgConnections } from "@vm0/db/schema/slack-org-connection";
import { slackOrgInstallations } from "@vm0/db/schema/slack-org-installation";
import { slackOrgThreadSessions } from "@vm0/db/schema/slack-org-thread-session";
import type { SlackChatThreadRouteBackend } from "@vm0/db/schema/slack-chat-thread-route";
import { slackUserAgentPreferences } from "@vm0/db/schema/slack-user-agent-preference";
import { userCache } from "@vm0/db/schema/user-cache";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { and, desc, eq, isNull, or } from "drizzle-orm";

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
  type SlackConversationContextObserver,
  type SlackConversationContextPhase,
  type SlackConversationContextTelemetryDimensions,
  type SlackFile,
} from "../../lib/slack-webhook-context";
import { request$ } from "../context/hono";
import { waitUntil } from "../context/wait-until";
import {
  createSlackClient,
  createSlackUserInfoResolver,
  openView,
  postMessage,
  publishAppHome,
  setThreadStatus,
  type SlackUserInfoResolverStats,
} from "../external/slack-message-client";
import { now, nowDate } from "../external/time";
import { writeDb$, type Db } from "../external/db";
import {
  ApiDispatchTimingCollector,
  type ApiDispatchTimingActionType,
  type ApiDispatchTimingDimensions,
  measureApiDispatchTiming,
} from "./api-dispatch-timing.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { decryptPersistentSecretValue } from "./crypto.utils";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { canReuseIntegrationSessionForModelRoute } from "./integration-session-model-compatibility.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./zero-user-data.service";
import { publishSlackAdminSignal$ } from "./zero-slack-connect.service";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import {
  admitCanonicalSlackChatEvent,
  ensureCanonicalSlackChatThreadRoute,
  ensureLegacySlackChatThreadRoute,
  findSlackChatThreadRoute,
} from "./slack-chat-ingress.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import { onRejection, safeJsonParse, tapError } from "../utils";
import type { SlackOrgCallbackPayload } from "./slack-org-callback-payload";

const L = logger("ZeroSlackWebhooks");
const AGENT_PICKER_MAX_OPTIONS = 100;
const MODEL_PICKER_MAX_OPTIONS = 100;

type SlackInstallation = typeof slackOrgInstallations.$inferSelect;
type SlackConnection = typeof slackOrgConnections.$inferSelect;
type SlackCallbackPayload = SlackOrgCallbackPayload;

interface SlackThreadBinding {
  readonly agentSessionId: string | null;
  readonly computerUseHostId: string | null;
}

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
  readonly event_id?: string;
  readonly event:
    | SlackAppMentionEvent
    | SlackDirectMessageEvent
    | SlackChannelMessageEvent
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

interface SlackChannelMessageEvent {
  readonly type: "message";
  readonly channel_type?: "channel" | "group" | "mpim";
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
  readonly modelProviderId?: string;
  readonly modelProviderCredentialScope?: ModelProviderCredentialScope;
  readonly modelProviderType?: string;
  readonly selectedModelOverride?: string;
  readonly computerUseHostId?: string;
  readonly timing: ApiDispatchTimingCollector;
}

interface SlackRunParamInputBundle {
  readonly prompt: string;
  readonly userInfoExtras: RunAgentParams["userInfoExtras"];
  readonly modelRoute: IntegrationModelRoutePin | undefined;
  readonly executionContext: string;
}

interface SlackRunThreadContext {
  readonly existingSessionId: string | undefined;
  readonly computerUseHostId: string | undefined;
}

interface SlackRunParamBundle {
  readonly inputs: SlackRunParamInputBundle;
  readonly threadContext: SlackRunThreadContext;
}

interface SlackEventCallbackArgs {
  readonly db: Db;
  readonly payload: SlackEventCallback;
  readonly apiStartTime: number;
  readonly backgroundScheduledAt: number;
  readonly timing: ApiDispatchTimingCollector;
  readonly signal: AbortSignal;
}

interface SlackAgentRouteAdmission {
  readonly backend: SlackChatThreadRouteBackend;
  readonly routeId?: string;
}

type SlackChannelType = "channel" | "dm" | "group_dm";

interface WorkspaceAgentSummary {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

type EffectiveComposeResolution =
  | {
      readonly status: "resolved";
      readonly composeId: string;
      readonly agent: WorkspaceAgentSummary;
    }
  | {
      readonly status: "not_configured" | "not_found" | "not_accessible";
    };

interface SlackAgentMessageArgs {
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
  readonly backgroundScheduledAt?: number;
  readonly timing: ApiDispatchTimingCollector;
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
  readonly agent: WorkspaceAgentSummary;
}

interface CommandModelResponseArgs {
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
  return `${env("APP_URL")}/settings/slack?${params.toString()}`;
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
          url: `${env("APP_URL")}/works`,
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

function slackPersistentSecretContext(args: {
  readonly orgId: string | null;
  readonly userId: string | undefined;
}): Computed<Promise<FeatureSwitchContext>> {
  return computed(async (get): Promise<FeatureSwitchContext> => {
    if (!args.orgId) {
      return {};
    }
    if (!args.userId) {
      return { orgId: args.orgId };
    }
    return {
      orgId: args.orgId,
      userId: args.userId,
      overrides: await get(userFeatureSwitchOverrides(args.orgId, args.userId)),
    };
  });
}

function decryptSlackBotToken(args: {
  readonly installation: SlackInstallation;
  readonly userId?: string;
}): Computed<Promise<string>> {
  return computed(async (get): Promise<string> => {
    return await decryptPersistentSecretValue(
      args.installation.encryptedBotToken,
      await get(
        slackPersistentSecretContext({
          orgId: args.installation.orgId,
          userId: args.userId,
        }),
      ),
    );
  });
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
): Promise<WorkspaceAgentSummary | undefined> {
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

async function getVisibleWorkspaceAgent(
  db: Db,
  composeId: string,
  orgId: string,
  userId: string,
): Promise<WorkspaceAgentSummary | undefined> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, composeId),
        eq(zeroAgents.orgId, orgId),
        or(eq(zeroAgents.visibility, "public"), eq(zeroAgents.owner, userId)),
      ),
    )
    .limit(1);
  return agent;
}

async function getVisibleAgentPickerOptions(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly defaultComposeId: string | null;
}): Promise<
  readonly {
    readonly composeId: string;
    readonly name: string;
    readonly displayName: string | null;
  }[]
> {
  const rows = await args.db
    .select({
      composeId: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.orgId, args.orgId),
        or(
          eq(zeroAgents.visibility, "public"),
          eq(zeroAgents.owner, args.userId),
        ),
      ),
    )
    .orderBy(desc(zeroAgents.updatedAt));

  return rows
    .filter((agent) => {
      return agent.composeId !== args.defaultComposeId;
    })
    .slice(0, AGENT_PICKER_MAX_OPTIONS);
}

async function resolveEffectiveCompose(
  db: Db,
  vm0UserId: string,
  orgId: string,
): Promise<EffectiveComposeResolution> {
  const override = await getUserAgentPreference(db, vm0UserId, orgId);
  if (override) {
    const agent = await getVisibleWorkspaceAgent(
      db,
      override,
      orgId,
      vm0UserId,
    );
    if (agent) {
      return { status: "resolved", composeId: override, agent };
    }
  }
  const defaultComposeId = await resolveDefaultComposeId(db, orgId);
  if (!defaultComposeId) {
    return { status: "not_configured" };
  }
  const configuredDefaultAgent = await getWorkspaceAgent(
    db,
    defaultComposeId,
    orgId,
  );
  if (!configuredDefaultAgent) {
    return { status: "not_found" };
  }
  const visibleDefaultAgent = await getVisibleWorkspaceAgent(
    db,
    defaultComposeId,
    orgId,
    vm0UserId,
  );
  if (!visibleDefaultAgent) {
    return { status: "not_accessible" };
  }
  return {
    status: "resolved",
    composeId: defaultComposeId,
    agent: visibleDefaultAgent,
  };
}

const resolveSlackAgentRouteAdmission$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly workspaceId: string;
      readonly channelId: string;
      readonly slackUserId: string;
      readonly threadTs: string;
    },
  ): Promise<SlackAgentRouteAdmission> => {
    const installation = await installationForWorkspace(
      args.db,
      args.workspaceId,
    );
    if (!installation?.orgId) {
      return { backend: "legacy" };
    }
    const connection = await connectionForSlackUser(
      args.db,
      args.workspaceId,
      args.slackUserId,
    );
    if (!connection) {
      return { backend: "legacy" };
    }

    const routeKey = {
      connectionId: connection.id,
      channelId: args.channelId,
      threadTs: args.threadTs,
      userId: connection.vm0UserId,
    };
    const existingRoute = await findSlackChatThreadRoute(args.db, routeKey);
    if (existingRoute) {
      return { backend: existingRoute.backend, routeId: existingRoute.id };
    }

    const overrides = await get(
      userFeatureSwitchOverrides(installation.orgId, connection.vm0UserId),
    );
    const canonicalEnabled = isFeatureEnabled(
      FeatureSwitchKey.CanonicalSlackIngress,
      {
        orgId: installation.orgId,
        userId: connection.vm0UserId,
        overrides,
      },
    );
    const currentTime = nowDate();
    if (!canonicalEnabled) {
      const route = await ensureLegacySlackChatThreadRoute(args.db, {
        ...routeKey,
        currentTime,
      });
      return { backend: route.backend, routeId: route.id };
    }

    const effectiveCompose = await resolveEffectiveCompose(
      args.db,
      connection.vm0UserId,
      installation.orgId,
    );
    if (effectiveCompose.status !== "resolved") {
      return { backend: "legacy" };
    }

    const route = await ensureCanonicalSlackChatThreadRoute(args.db, {
      ...routeKey,
      orgId: installation.orgId,
      agentComposeId: effectiveCompose.composeId,
      currentTime,
    });
    return { backend: route.backend, routeId: route.id };
  },
);

async function disconnect(db: Db, connectionId: string): Promise<void> {
  await db
    .delete(slackOrgConnections)
    .where(eq(slackOrgConnections.id, connectionId));
}

const cleanupWorkspaceInstallation$ = command(
  async (
    { set },
    db: Db,
    workspaceId: string,
    signal: AbortSignal,
  ): Promise<boolean> => {
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
  },
);

const slackModelPickerState$ = command(
  async (
    { get, set },
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
  }> => {
    const visibleModels = new Set(getVm0VisibleModels());
    const [policies, preference] = await Promise.all([
      set(listOrgModelPolicies$, { orgId, userId }, signal),
      get(userModelPreference({ orgId, userId })),
    ]);
    signal.throwIfAborted();
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
  },
);

const isModelCommandAvailable$ = command(
  async (
    { set },
    installation: SlackInstallation | undefined,
    connection: SlackConnection | undefined,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!installation?.orgId || !connection) {
      return false;
    }
    const picker = await set(
      slackModelPickerState$,
      installation.orgId,
      connection.vm0UserId,
      signal,
    );
    return picker.enabled && picker.options.length > 0;
  },
);

const refreshOrgAppHome$ = command(
  async (
    { get },
    db: Db,
    installation: SlackInstallation,
    slackUserId: string,
  ): Promise<void> => {
    const workspaceId = installation.slackWorkspaceId;
    const connection = await connectionForSlackUser(
      db,
      workspaceId,
      slackUserId,
    );
    const botToken = await get(
      decryptSlackBotToken({
        installation,
        userId: connection?.vm0UserId,
      }),
    );
    const client = createSlackClient(botToken);
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
      const [effectiveCompose, overrideComposeId, defaultComposeId] =
        await Promise.all([
          resolveEffectiveCompose(db, connection.vm0UserId, orgId),
          getUserAgentPreference(db, connection.vm0UserId, orgId),
          resolveDefaultComposeId(db, orgId),
        ]);
      const visibleOverrideAgent = overrideComposeId
        ? await getVisibleWorkspaceAgent(
            db,
            overrideComposeId,
            orgId,
            connection.vm0UserId,
          )
        : undefined;
      const visibleDefaultAgent = defaultComposeId
        ? await getVisibleWorkspaceAgent(
            db,
            defaultComposeId,
            orgId,
            connection.vm0UserId,
          )
        : undefined;
      const visibleOptions = await getVisibleAgentPickerOptions({
        db,
        orgId,
        userId: connection.vm0UserId,
        defaultComposeId,
      });
      if (effectiveCompose.status === "resolved") {
        agentName =
          effectiveCompose.agent.displayName ?? effectiveCompose.agent.name;
      }
      isOverrideActive = Boolean(
        visibleOverrideAgent && overrideComposeId !== defaultComposeId,
      );
      canSwitch = Boolean(visibleDefaultAgent || visibleOptions.length > 0);
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
  },
);

const commandSwitchResponse$ = command(
  async (
    { get },
    db: Db,
    payload: SlackCommandPayload,
    installation: SlackInstallation,
    connection: SlackConnection,
  ): Promise<Response> => {
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
    const defaultComposeId = await resolveDefaultComposeId(
      db,
      installation.orgId,
    );
    const options = await getVisibleAgentPickerOptions({
      db,
      orgId: installation.orgId,
      userId: connection.vm0UserId,
      defaultComposeId,
    });
    const visibleDefaultAgent = defaultComposeId
      ? await getVisibleWorkspaceAgent(
          db,
          defaultComposeId,
          installation.orgId,
          connection.vm0UserId,
        )
      : undefined;
    if (!visibleDefaultAgent && options.length === 0) {
      return ephemeral(
        buildErrorMessage("No agents are available to your Slack account."),
      );
    }
    const orgDefaultName = visibleDefaultAgent
      ? (visibleDefaultAgent.displayName ?? visibleDefaultAgent.name)
      : null;
    const currentOverride = await getUserAgentPreference(
      db,
      connection.vm0UserId,
      installation.orgId,
    );
    const client = createSlackClient(
      await get(
        decryptSlackBotToken({
          installation,
          userId: connection.vm0UserId,
        }),
      ),
    );
    const result = await tapError(
      openView(
        client,
        payload.trigger_id,
        buildAgentPickerModal({
          options,
          currentSelectedId: currentOverride,
          includeOrgDefault: Boolean(visibleDefaultAgent),
          orgDefaultName,
          privateMetadata: JSON.stringify({ channelId: payload.channel_id }),
        }),
      ),
      (error) => {
        L.warn("Failed to open agent picker modal", { error });
      },
    );
    if (!result) {
      return ephemeral(
        buildErrorMessage(
          "Couldn't open the agent picker \u2014 please try again.",
        ),
      );
    }
    return emptyResponse();
  },
);

const commandModelResponse$ = command(
  async ({ get, set }, args: CommandModelResponseArgs): Promise<Response> => {
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
    const picker = await set(
      slackModelPickerState$,
      args.installation.orgId,
      args.connection.vm0UserId,
      args.signal,
    );
    if (!picker.enabled) {
      return ephemeral(
        buildErrorMessage(
          "Model switching is not available for this workspace.",
        ),
      );
    }
    if (picker.options.length === 0) {
      return ephemeral(
        buildErrorMessage("No models are configured for this workspace."),
      );
    }
    const client = createSlackClient(
      await get(
        decryptSlackBotToken({
          installation: args.installation,
          userId: args.connection.vm0UserId,
        }),
      ),
    );
    const result = await tapError(
      openView(
        client,
        args.payload.trigger_id,
        buildModelPickerModal({
          options: picker.options.slice(0, MODEL_PICKER_MAX_OPTIONS),
          currentSelectedModel: picker.currentSelectedModel,
          privateMetadata: JSON.stringify({
            channelId: args.payload.channel_id,
          }),
        }),
      ),
      (error) => {
        L.warn("Failed to open model picker modal", { error });
      },
    );
    if (!result) {
      return ephemeral(
        buildErrorMessage(
          "Couldn't open the model picker \u2014 please try again.",
        ),
      );
    }
    return emptyResponse();
  },
);

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
      return set(isModelCommandAvailable$, installation, connection, signal);
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
        tapError(
          set(refreshOrgAppHome$, db, installation, payload.user_id),
          (error) => {
            L.warn("Failed to refresh App Home after disconnect", { error });
          },
        ),
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
      return set(commandSwitchResponse$, db, payload, installation, connection);
    }

    if (subCommand === "model") {
      return set(commandModelResponse$, {
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

const runAgentForSlackOrg$ = command(
  async (
    { set },
    params: RunAgentParams,
    signal: AbortSignal,
  ): Promise<RunAgentResult> => {
    params.timing.recordElapsed(
      "api_dispatch_pre_create_zero_slack_create_run",
      "nested",
      now(),
    );
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
          ...(params.modelProviderType
            ? { modelProvider: params.modelProviderType }
            : {}),
        },
        apiStartTime: params.apiStartTime,
        triggerSource: "slack",
        appendSystemPrompt: buildSlackPrompt(params),
        userInfoExtras: params.userInfoExtras,
        modelProviderId: params.modelProviderId,
        modelProviderCredentialScope: params.modelProviderCredentialScope,
        selectedModelOverride: params.selectedModelOverride,
        computerUseHostId: params.computerUseHostId,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        callbacks: [
          {
            internalKind: "slack:org",
            secret: generateCallbackSecret(),
            payload: params.callbackContext,
          },
        ],
        timing: params.timing,
      },
      signal,
    );
    if (result.status === 201) {
      return {
        status: result.body.status === "queued" ? "queued" : "accepted",
        runId: result.body.runId,
      };
    }

    return {
      status: "failed",
      response: await set(
        formatIntegrationRunError$,
        {
          orgId: params.orgId,
          userId: params.userId,
          code: result.body.error.code,
          message: result.body.error.message,
        },
        signal,
      ),
    };
  },
);

async function resolveCompatibleThreadSession(args: {
  readonly db: Db;
  readonly binding: SlackThreadBinding | undefined;
  readonly userId: string;
  readonly agentComposeId: string;
  readonly modelRoute: IntegrationModelRoutePin | undefined;
}): Promise<string | undefined> {
  if (!args.binding?.agentSessionId) {
    return undefined;
  }
  const [agentSession] = await args.db
    .select({
      agentComposeId: agentSessions.agentComposeId,
    })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.binding.agentSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (agentSession?.agentComposeId !== args.agentComposeId) {
    return undefined;
  }

  if (args.modelRoute) {
    const canReuseSession = await canReuseIntegrationSessionForModelRoute({
      db: args.db,
      sessionId: args.binding.agentSessionId,
      modelRoute: args.modelRoute,
    });
    if (!canReuseSession) {
      return undefined;
    }
  }

  return args.binding.agentSessionId;
}

async function resolveComputerUseHostForSlackThread(args: {
  readonly db: Db;
  readonly binding: SlackThreadBinding | undefined;
  readonly orgId: string;
  readonly userId: string;
}): Promise<string | undefined> {
  if (!args.binding?.computerUseHostId) {
    return undefined;
  }

  const [host] = await args.db
    .select({ id: computerUseHosts.id })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, args.binding.computerUseHostId),
        eq(computerUseHosts.orgId, args.orgId),
        eq(computerUseHosts.userId, args.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);

  return host?.id;
}

async function loadSlackThreadBinding(args: {
  readonly db: Db;
  readonly channelId: string;
  readonly threadTs: string;
  readonly connectionId: string;
}): Promise<SlackThreadBinding | undefined> {
  const [binding] = await args.db
    .select({
      agentSessionId: slackOrgThreadSessions.agentSessionId,
      computerUseHostId: slackOrgThreadSessions.computerUseHostId,
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

  return binding;
}

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === "rejected") {
    throw result.reason;
  }

  return result.value;
}

async function clearSlackThreadStatusBestEffort(args: {
  readonly client: ReturnType<typeof createSlackClient>;
  readonly channelId: string;
  readonly threadTs: string;
  readonly failureMessage: string;
}): Promise<void> {
  const [result] = await Promise.allSettled([
    setThreadStatus(args.client, args.channelId, args.threadTs, ""),
  ]);
  if (result.status === "rejected") {
    L.warn(args.failureMessage, { error: result.reason });
  }
}

const SLACK_CONVERSATION_CONTEXT_PHASE_ACTION_TYPES = {
  replies:
    "api_dispatch_pre_create_zero_slack_build_run_params_fetch_conversation_context_replies",
  history:
    "api_dispatch_pre_create_zero_slack_build_run_params_fetch_conversation_context_history",
  user_info:
    "api_dispatch_pre_create_zero_slack_build_run_params_fetch_conversation_context_user_info",
  format:
    "api_dispatch_pre_create_zero_slack_build_run_params_fetch_conversation_context_format",
} as const satisfies Record<
  SlackConversationContextPhase,
  ApiDispatchTimingActionType
>;

function slackUserInfoResolverCountBucket(count: number): string {
  if (count <= 0) {
    return "0";
  }
  if (count === 1) {
    return "1";
  }
  if (count <= 4) {
    return "2_4";
  }
  if (count <= 8) {
    return "5_8";
  }
  if (count <= 16) {
    return "9_16";
  }
  return "17_plus";
}

function slackUserInfoResolverDimensions(
  stats: SlackUserInfoResolverStats,
): ApiDispatchTimingDimensions {
  return {
    slack_user_info_resolver_requested_count_bucket:
      slackUserInfoResolverCountBucket(stats.requestedCount),
    slack_user_info_resolver_cache_hit_count_bucket:
      slackUserInfoResolverCountBucket(stats.cacheHitCount),
    slack_user_info_resolver_miss_count_bucket:
      slackUserInfoResolverCountBucket(stats.missCount),
    slack_user_info_resolver_in_flight_hit_count_bucket:
      slackUserInfoResolverCountBucket(stats.inFlightHitCount),
  };
}

function createSlackConversationContextObserver(
  timing: ApiDispatchTimingCollector,
): {
  readonly observer: SlackConversationContextObserver;
  readonly dimensions: () => ApiDispatchTimingDimensions | undefined;
} {
  let dimensions: SlackConversationContextTelemetryDimensions | undefined;
  const currentDimensions = (): ApiDispatchTimingDimensions | undefined => {
    if (!dimensions) {
      return undefined;
    }
    return { ...dimensions };
  };

  return {
    observer: {
      async measure(phase, operation) {
        return await measureApiDispatchTiming(
          timing,
          SLACK_CONVERSATION_CONTEXT_PHASE_ACTION_TYPES[phase],
          "nested",
          operation,
          currentDimensions,
        );
      },
      dimensions(nextDimensions) {
        dimensions = nextDimensions;
      },
    },
    dimensions: currentDimensions,
  };
}

async function loadSlackRunParamBundle(args: {
  readonly timing: ApiDispatchTimingCollector;
  readonly db: Db;
  readonly userId: string;
  readonly orgId: string;
  readonly agentComposeId: string;
  readonly enrichMessage: () => Promise<
    Pick<RunAgentParams, "prompt" | "userInfoExtras">
  >;
  readonly resolveModelRoute: () => Promise<
    IntegrationModelRoutePin | undefined
  >;
  readonly loadThreadBinding: () => Promise<SlackThreadBinding | undefined>;
  readonly fetchConversationContext: () => Promise<{
    readonly executionContext: string;
  }>;
  readonly fetchConversationContextDimensions: () =>
    | ApiDispatchTimingDimensions
    | undefined;
}): Promise<SlackRunParamBundle> {
  const enrichPromise = measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_slack_build_run_params_enrich_message",
    "nested",
    args.enrichMessage,
  );
  const modelRoutePromise = measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_slack_build_run_params_resolve_model_route",
    "nested",
    args.resolveModelRoute,
  );
  const bindingPromise = measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_slack_build_run_params_load_thread_binding",
    "nested",
    args.loadThreadBinding,
  );
  const contextPromise = measureApiDispatchTiming(
    args.timing,
    "api_dispatch_pre_create_zero_slack_build_run_params_fetch_conversation_context",
    "nested",
    args.fetchConversationContext,
    args.fetchConversationContextDimensions,
  );

  const initialResultsPromise = Promise.allSettled([
    enrichPromise,
    modelRoutePromise,
    bindingPromise,
    contextPromise,
  ]);
  const [modelRouteResult, bindingResult] = await Promise.allSettled([
    modelRoutePromise,
    bindingPromise,
  ]);
  if (
    modelRouteResult.status === "rejected" ||
    bindingResult.status === "rejected"
  ) {
    const initialResults = await initialResultsPromise;
    settledValue(initialResults[0]);
    settledValue(modelRouteResult);
    settledValue(bindingResult);
    settledValue(initialResults[3]);
  }

  const modelRoute = settledValue(modelRouteResult);
  const threadBinding = settledValue(bindingResult);
  const threadContextPromise = resolveSlackRunThreadContext({
    timing: args.timing,
    db: args.db,
    binding: threadBinding,
    userId: args.userId,
    orgId: args.orgId,
    agentComposeId: args.agentComposeId,
    modelRoute,
  });
  const threadContextResultPromise = Promise.allSettled([threadContextPromise]);
  const [initialResults, threadContextResults] = await Promise.all([
    initialResultsPromise,
    threadContextResultPromise,
  ]);
  const [threadContextResult] = threadContextResults;
  const { prompt, userInfoExtras } = settledValue(initialResults[0]);
  const threadContext = settledValue(threadContextResult);
  const { executionContext } = settledValue(initialResults[3]);

  return {
    inputs: {
      prompt,
      userInfoExtras,
      modelRoute,
      executionContext,
    },
    threadContext,
  };
}

async function resolveSlackRunThreadContext(args: {
  readonly timing: ApiDispatchTimingCollector;
  readonly db: Db;
  readonly binding: SlackThreadBinding | undefined;
  readonly userId: string;
  readonly orgId: string;
  readonly agentComposeId: string;
  readonly modelRoute: IntegrationModelRoutePin | undefined;
}): Promise<SlackRunThreadContext> {
  const [sessionResult, hostResult] = await Promise.allSettled([
    measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_slack_build_run_params_resolve_session",
      "nested",
      async () => {
        return await resolveCompatibleThreadSession({
          db: args.db,
          binding: args.binding,
          userId: args.userId,
          agentComposeId: args.agentComposeId,
          modelRoute: args.modelRoute,
        });
      },
    ),
    measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_slack_build_run_params_resolve_computer_use_host",
      "nested",
      async () => {
        return await resolveComputerUseHostForSlackThread({
          db: args.db,
          binding: args.binding,
          orgId: args.orgId,
          userId: args.userId,
        });
      },
    ),
  ]);

  return {
    existingSessionId: settledValue(sessionResult),
    computerUseHostId: settledValue(hostResult),
  };
}

function assembleSlackRunAgentParams(args: {
  readonly message: SlackAgentMessageArgs;
  readonly resolved: ResolvedSlackAgentMessage;
  readonly inputs: SlackRunParamInputBundle;
  readonly threadContext: SlackRunThreadContext;
}): RunAgentParams {
  const { message, resolved, inputs, threadContext } = args;
  const callbackContext: SlackCallbackPayload = {
    workspaceId: message.workspaceId,
    channelId: message.channelId,
    threadTs: resolved.threadTs,
    messageTs: message.messageTs,
    connectionId: resolved.connection.id,
    agentId: resolved.composeId,
    existingSessionId: threadContext.existingSessionId,
  };

  return {
    agentId: resolved.composeId,
    agentName: resolved.agent.name,
    orgId: resolved.installation.orgId,
    sessionId: threadContext.existingSessionId,
    prompt: inputs.prompt,
    threadContext: inputs.executionContext,
    userInfoExtras: inputs.userInfoExtras,
    userId: resolved.connection.vm0UserId,
    botUserId: resolved.installation.botUserId,
    channelId: message.channelId,
    channelType: message.channelType,
    threadTs: resolved.threadTs,
    callbackContext,
    apiStartTime: message.apiStartTime,
    modelProviderId: inputs.modelRoute?.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      inputs.modelRoute?.modelProviderCredentialScope ?? undefined,
    modelProviderType: inputs.modelRoute?.modelProviderType ?? undefined,
    selectedModelOverride: inputs.modelRoute?.selectedModel ?? undefined,
    computerUseHostId: threadContext.computerUseHostId,
    timing: message.timing,
  };
}

const postPreDispatchErrorReply$ = command(
  async (
    { get },
    args: {
      readonly db: Db;
      readonly client: ReturnType<typeof createSlackClient>;
      readonly channelId: string;
      readonly threadTs: string;
      readonly errorText: string;
      readonly orgId: string;
      readonly vm0UserId: string;
      readonly composeId: string;
      readonly agentLabel: string;
    },
  ): Promise<void> => {
    const overrides = await get(
      userFeatureSwitchOverrides(args.orgId, args.vm0UserId),
    );
    const logsUrl = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, {
      userId: args.vm0UserId,
      orgId: args.orgId,
      overrides,
    })
      ? `${env("APP_URL")}/activities`
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
  },
);

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

const resolveSlackAgentMessage$ = command(
  async (
    { get },
    args: SlackAgentMessageArgs,
  ): Promise<ResolvedSlackAgentMessage | null> => {
    const installation = await installationForWorkspace(
      args.db,
      args.workspaceId,
    );
    const orgId = installation?.orgId;
    if (!installation || !orgId) {
      return null;
    }
    const boundInstallation = { ...installation, orgId };
    const threadTs = args.threadTs ?? args.messageTs;
    const connection = await connectionForSlackUser(
      args.db,
      args.workspaceId,
      args.slackUserId,
    );
    const botToken = await get(
      decryptSlackBotToken({
        installation,
        userId: connection?.vm0UserId,
      }),
    );
    const client = createSlackClient(botToken);

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

    const effectiveCompose = await resolveEffectiveCompose(
      args.db,
      connection.vm0UserId,
      boundInstallation.orgId,
    );
    if (effectiveCompose.status !== "resolved") {
      switch (effectiveCompose.status) {
        case "not_configured": {
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
        case "not_found": {
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
        case "not_accessible": {
          await postSlackUserNotice({
            client,
            channelId: args.channelId,
            channelType: args.channelType,
            slackUserId: args.slackUserId,
            threadTs,
            ephemeralThreadTs: args.threadTs ? threadTs : undefined,
            text: "The configured agent is not available to your Slack account. Use `/zero switch` to choose an accessible agent.",
          });
          return null;
        }
      }
    }

    return {
      installation: boundInstallation,
      connection,
      client,
      threadTs,
      composeId: effectiveCompose.composeId,
      agent: effectiveCompose.agent,
    };
  },
);

const buildRunAgentParams$ = command(
  async (
    { set },
    args: SlackAgentMessageArgs,
    resolved: ResolvedSlackAgentMessage,
  ): Promise<RunAgentParams> => {
    const conversationContextObserver = createSlackConversationContextObserver(
      args.timing,
    );
    const userInfoResolver = createSlackUserInfoResolver(resolved.client);
    const { inputs, threadContext } = await loadSlackRunParamBundle({
      timing: args.timing,
      db: args.db,
      userId: resolved.connection.vm0UserId,
      orgId: resolved.installation.orgId,
      agentComposeId: resolved.composeId,
      enrichMessage: async () => {
        return await enrichMessageContent({
          messageContent: args.messageText,
          files: args.files,
          client: resolved.client,
          userId: args.slackUserId,
          userInfoResolver,
        });
      },
      resolveModelRoute: async () => {
        return await set(
          resolveIntegrationModelRouteForUser$,
          {
            orgId: resolved.installation.orgId,
            userId: resolved.connection.vm0UserId,
          },
          args.signal,
        );
      },
      loadThreadBinding: async () => {
        return await loadSlackThreadBinding({
          db: args.db,
          channelId: args.channelId,
          threadTs: resolved.threadTs,
          connectionId: resolved.connection.id,
        });
      },
      fetchConversationContext: async () => {
        return await fetchConversationContexts(
          resolved.client,
          args.channelId,
          args.threadTs,
          args.messageTs,
          {
            observer: conversationContextObserver.observer,
            userInfoResolver,
          },
        );
      },
      fetchConversationContextDimensions:
        conversationContextObserver.dimensions,
    });
    const userInfoResolverStatsRecordedAt = now();
    args.timing.recordElapsed(
      "api_dispatch_pre_create_zero_slack_build_run_params_user_info_resolver",
      "nested",
      userInfoResolverStatsRecordedAt,
      userInfoResolverStatsRecordedAt,
      slackUserInfoResolverDimensions(userInfoResolver.stats()),
    );

    return await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_slack_build_run_params_assemble",
      "nested",
      () => {
        return assembleSlackRunAgentParams({
          message: args,
          resolved,
          inputs,
          threadContext,
        });
      },
    );
  },
);

const handleSlackRunResult$ = command(
  async (
    { set },
    args: {
      readonly message: SlackAgentMessageArgs;
      readonly resolved: ResolvedSlackAgentMessage;
      readonly result: RunAgentResult;
    },
  ): Promise<void> => {
    const { message, resolved, result } = args;
    if (result.status === "queued") {
      const queueUrl = `${env("APP_URL")}/?queue=1`;
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
      const errorReplyResultPromise = result.runId
        ? undefined
        : Promise.allSettled([
            (async () => {
              await set(postPreDispatchErrorReply$, {
                db: message.db,
                client: resolved.client,
                channelId: message.channelId,
                threadTs: resolved.threadTs,
                errorText:
                  result.response ??
                  "Sorry, an error occurred. Please try again.",
                orgId: resolved.installation.orgId,
                vm0UserId: resolved.connection.vm0UserId,
                composeId: resolved.composeId,
                agentLabel: resolved.agent.displayName ?? resolved.agent.name,
              });
            })(),
          ]);
      await clearSlackThreadStatusBestEffort({
        client: resolved.client,
        channelId: message.channelId,
        threadTs: resolved.threadTs,
        failureMessage: "Failed to clear thread status",
      });
      const [errorReplyResult] = errorReplyResultPromise
        ? await errorReplyResultPromise
        : [];
      if (errorReplyResult?.status === "rejected") {
        throw errorReplyResult.reason;
      }
    }
  },
);

const handleSlackAgentMessage$ = command(
  async ({ set }, args: SlackAgentMessageArgs): Promise<void> => {
    if (args.backgroundScheduledAt !== undefined) {
      args.timing.recordElapsed(
        "api_dispatch_pre_create_zero_slack_background_start_gap",
        "nested",
        args.backgroundScheduledAt,
      );
    }
    const resolved = await measureApiDispatchTiming(
      args.timing,
      "api_dispatch_pre_create_zero_slack_resolve_message",
      "nested",
      async () => {
        return await set(resolveSlackAgentMessage$, args);
      },
    );
    if (!resolved) {
      return;
    }

    const [statusResult, runParamsResult] = await Promise.allSettled([
      measureApiDispatchTiming(
        args.timing,
        "api_dispatch_pre_create_zero_slack_set_thread_status",
        "nested",
        async () => {
          await setThreadStatus(
            resolved.client,
            args.channelId,
            resolved.threadTs,
            "is thinking...",
          );
        },
      ),
      measureApiDispatchTiming(
        args.timing,
        "api_dispatch_pre_create_zero_slack_build_run_params",
        "nested",
        async () => {
          return await set(buildRunAgentParams$, args, resolved);
        },
      ),
    ]);
    settledValue(statusResult);
    const [runResult] = await Promise.allSettled([
      (async () => {
        const runParams = settledValue(runParamsResult);
        return await set(runAgentForSlackOrg$, runParams, args.signal);
      })(),
    ]);
    if (runResult.status === "rejected") {
      await clearSlackThreadStatusBestEffort({
        client: resolved.client,
        channelId: args.channelId,
        threadTs: resolved.threadTs,
        failureMessage: "Failed to clear pre-run thread status",
      });
      throw runResult.reason;
    }
    await set(handleSlackRunResult$, {
      message: args,
      resolved,
      result: runResult.value,
    });
  },
);

export const dispatchZeroSlackProbe$ = command(
  async (
    { set },
    input: ZeroSlackDispatchProbeInput,
    signal: AbortSignal,
  ): Promise<void> => {
    const timing = new ApiDispatchTimingCollector();
    timing.recordElapsed(
      "api_dispatch_pre_create_zero_slack_entrypoint_gap",
      "nested",
      input.apiStartTime,
    );
    await set(handleSlackAgentMessage$, {
      db: set(writeDb$),
      workspaceId: input.workspaceId,
      channelId: input.channelId,
      channelType: input.channelType,
      slackUserId: input.slackUserId,
      messageText: input.messageText,
      messageTs: input.messageTs,
      apiStartTime: input.apiStartTime,
      timing,
      signal,
    });
  },
);

const handleAppHomeOpened$ = command(
  async (
    { set },
    db: Db,
    workspaceId: string,
    slackUserId: string,
  ): Promise<void> => {
    const installation = await installationForWorkspace(db, workspaceId);
    if (!installation) {
      return;
    }
    await set(refreshOrgAppHome$, db, installation, slackUserId);
  },
);

const handleMessagesTabOpened$ = command(
  async (
    { get },
    db: Db,
    workspaceId: string,
    slackUserId: string,
    channelId: string,
  ): Promise<void> => {
    const installation = await installationForWorkspace(db, workspaceId);
    if (!installation) {
      return;
    }
    const [connection] = await db
      .select({
        id: slackOrgConnections.id,
        vm0UserId: slackOrgConnections.vm0UserId,
      })
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
    let agentName: string | undefined;
    if (installation.orgId) {
      const composeId = await resolveDefaultComposeId(db, installation.orgId);
      const agent = composeId
        ? await getWorkspaceAgent(db, composeId)
        : undefined;
      agentName = agent?.displayName ?? agent?.name;
    }
    await postMessage(
      createSlackClient(
        await get(
          decryptSlackBotToken({
            installation,
            userId: connection.vm0UserId,
          }),
        ),
      ),
      channelId,
      "Hi! I'm Zero. I can connect you to AI agents to help with your tasks.",
      { blocks: buildWelcomeMessage(agentName) },
    );
  },
);

function isSlackUserMessageEvent(
  event: SlackDirectMessageEvent | SlackChannelMessageEvent,
): boolean {
  return (!event.subtype || event.subtype === "file_share") && !event.bot_id;
}

function isSlackDirectAgentMessageEvent(
  event: SlackEventCallback["event"],
): event is SlackDirectMessageEvent {
  return (
    event.type === "message" &&
    event.channel_type === "im" &&
    isSlackUserMessageEvent(event)
  );
}

function slackAgentMessageEvent(
  event: SlackEventCallback["event"],
): SlackAppMentionEvent | SlackDirectMessageEvent | undefined {
  if (event.type === "app_mention") {
    return event;
  }
  if (isSlackDirectAgentMessageEvent(event)) {
    return event;
  }
  return undefined;
}

function slackAppMentionChannelType(
  event: SlackAppMentionEvent,
): SlackChannelType {
  if (event.channel_type === "im") {
    return "dm";
  }
  if (event.channel_type === "mpim") {
    return "group_dm";
  }
  return "channel";
}

const scheduleSlackAgentMessageEvent$ = command(
  (
    { set },
    args: {
      readonly callback: SlackEventCallbackArgs;
      readonly event: SlackAppMentionEvent | SlackDirectMessageEvent;
      readonly channelType: SlackChannelType;
      readonly errorMessage: string;
    },
  ): void => {
    waitUntil(
      tapError(
        set(handleSlackAgentMessage$, {
          db: args.callback.db,
          apiStartTime: args.callback.apiStartTime,
          backgroundScheduledAt: args.callback.backgroundScheduledAt,
          timing: args.callback.timing,
          signal: args.callback.signal,
          workspaceId: args.callback.payload.team_id,
          channelId: args.event.channel,
          channelType: args.channelType,
          slackUserId: args.event.user,
          messageText: args.event.text,
          messageTs: args.event.ts,
          threadTs: args.event.thread_ts,
          files: args.event.files,
        }),
        (error) => {
          L.error(args.errorMessage, { error });
        },
      ),
    );
  },
);

const scheduleSlackAppHomeEvent$ = command(
  (
    { set },
    args: {
      readonly callback: SlackEventCallbackArgs;
      readonly event: SlackAppHomeOpenedEvent;
    },
  ): void => {
    if (args.event.tab === "home") {
      waitUntil(
        tapError(
          set(
            handleAppHomeOpened$,
            args.callback.db,
            args.callback.payload.team_id,
            args.event.user,
          ),
          (error) => {
            L.error("Error handling org app_home_opened", { error });
          },
        ),
      );
    }

    if (args.event.tab === "messages") {
      waitUntil(
        tapError(
          set(
            handleMessagesTabOpened$,
            args.callback.db,
            args.callback.payload.team_id,
            args.event.user,
            args.event.channel,
          ),
          (error) => {
            L.error("Error handling org messages_tab_opened", { error });
          },
        ),
      );
    }
  },
);

const scheduleSlackInstallationCleanup$ = command(
  (
    { set },
    args: {
      readonly callback: SlackEventCallbackArgs;
      readonly errorMessage: string;
    },
  ): void => {
    waitUntil(
      tapError(
        set(
          cleanupWorkspaceInstallation$,
          args.callback.db,
          args.callback.payload.team_id,
          args.callback.signal,
        ),
        (error) => {
          L.error(args.errorMessage, { error });
        },
      ),
    );
  },
);

const handleEventCallback$ = command(
  ({ set }, args: SlackEventCallbackArgs): void => {
    const event = args.payload.event;
    if (event.type === "app_mention") {
      set(scheduleSlackAgentMessageEvent$, {
        callback: args,
        event,
        channelType: slackAppMentionChannelType(event),
        errorMessage: "Error handling org app_mention",
      });
    }

    if (isSlackDirectAgentMessageEvent(event)) {
      set(scheduleSlackAgentMessageEvent$, {
        callback: args,
        event,
        channelType: "dm",
        errorMessage: "Error handling org direct_message",
      });
    }

    if (event.type === "app_home_opened") {
      set(scheduleSlackAppHomeEvent$, {
        callback: args,
        event,
      });
    }

    if (event.type === "app_uninstalled") {
      set(scheduleSlackInstallationCleanup$, {
        callback: args,
        errorMessage: "Error handling app_uninstalled",
      });
    }

    if (event.type === "tokens_revoked" && event.tokens.bot?.length) {
      set(scheduleSlackInstallationCleanup$, {
        callback: args,
        errorMessage: "Error handling tokens_revoked",
      });
    }
  },
);

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
      const retryNum = request.header("x-slack-retry-num");
      const agentEvent = slackAgentMessageEvent(payload.event);
      if (agentEvent) {
        const db = set(writeDb$);
        const route = await set(resolveSlackAgentRouteAdmission$, {
          db,
          workspaceId: payload.team_id,
          channelId: agentEvent.channel,
          slackUserId: agentEvent.user,
          threadTs: agentEvent.thread_ts ?? agentEvent.ts,
        });
        signal.throwIfAborted();
        if (route.backend === "canonical") {
          if (!route.routeId || !payload.event_id) {
            L.error("Canonical Slack ingress is missing required identity", {
              type: "canonical_slack_ingress_admission",
              success: false,
              hasRouteId: Boolean(route.routeId),
              hasEventId: Boolean(payload.event_id),
              isRetry: Boolean(retryNum),
            });
            return jsonResponse(
              { error: "Canonical Slack event identity is missing" },
              400,
            );
          }

          const ingress = await onRejection(
            admitCanonicalSlackChatEvent(db, {
              routeId: route.routeId,
              eventId: payload.event_id,
              payload: verified.body,
              isRetry: Boolean(retryNum),
              currentTime: nowDate(),
            }),
            (error) => {
              L.error("Canonical Slack ingress admission failed", {
                type: "canonical_slack_ingress_admission",
                success: false,
                isRetry: Boolean(retryNum),
                retryNum: retryNum ?? null,
                error,
              });
            },
          );
          signal.throwIfAborted();
          L.debug("Canonical Slack ingress admitted", {
            type: "canonical_slack_ingress_admission",
            success: true,
            isRetry: Boolean(retryNum),
            retryNum: retryNum ?? null,
            outcome: ingress.inserted ? "accepted" : "deduplicated",
            status: ingress.status,
          });
          return textResponse("OK");
        }
      }

      if (retryNum) {
        return textResponse("OK");
      }
      const timing = new ApiDispatchTimingCollector();
      timing.recordElapsed(
        "api_dispatch_pre_create_zero_slack_entrypoint_gap",
        "nested",
        apiStartTime,
      );
      set(handleEventCallback$, {
        db: set(writeDb$),
        payload,
        apiStartTime,
        backgroundScheduledAt: now(),
        timing,
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
  await tapError(
    createSlackClient(args.botToken).chat.postEphemeral({
      channel: args.channel,
      user: args.slackUserId,
      text: args.text,
    }),
    (error) => {
      L.warn("Failed to post ephemeral message", { error });
    },
  );
}

const handleAgentPickerSubmit$ = command(
  async (
    { get, set },
    db: Db,
    payload: SlackInteractivePayload,
  ): Promise<Response> => {
    const selected =
      payload.view?.state.values[AGENT_PICKER_BLOCK_ID]?.[
        AGENT_PICKER_ACTION_ID
      ]?.selected_option?.value;
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
    const botToken = await get(
      decryptSlackBotToken({
        installation: ctx.installation,
        userId: ctx.connection.vm0UserId,
      }),
    );
    const channelId = parseViewChannelId(payload.view?.private_metadata);
    if (selected === AGENT_PICKER_ORG_DEFAULT_VALUE) {
      const defaultComposeId = await resolveDefaultComposeId(db, ctx.orgId);
      const visibleDefaultAgent = defaultComposeId
        ? await getVisibleWorkspaceAgent(
            db,
            defaultComposeId,
            ctx.orgId,
            ctx.connection.vm0UserId,
          )
        : undefined;
      if (!visibleDefaultAgent) {
        return jsonResponse({
          response_action: "errors",
          errors: {
            [AGENT_PICKER_BLOCK_ID]: "You don't have access to that agent.",
          },
        });
      }
      const defaultName =
        visibleDefaultAgent.displayName ?? visibleDefaultAgent.name;
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
      waitUntil(set(refreshOrgAppHome$, db, ctx.installation, payload.user.id));
      return emptyResponse();
    }

    const agent = await getVisibleWorkspaceAgent(
      db,
      selected,
      ctx.orgId,
      ctx.connection.vm0UserId,
    );
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
    waitUntil(set(refreshOrgAppHome$, db, ctx.installation, payload.user.id));
    return emptyResponse();
  },
);

const handleModelPickerSubmit$ = command(
  async (
    { get, set },
    db: Db,
    payload: SlackInteractivePayload,
    signal: AbortSignal,
  ): Promise<Response> => {
    const selected =
      payload.view?.state.values[MODEL_PICKER_BLOCK_ID]?.[
        MODEL_PICKER_ACTION_ID
      ]?.selected_option?.value;
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
    signal.throwIfAborted();
    if (!ctx) {
      return emptyResponse();
    }
    const picker = await set(
      slackModelPickerState$,
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
        botToken: await get(
          decryptSlackBotToken({
            installation: ctx.installation,
            userId: ctx.connection.vm0UserId,
          }),
        ),
        channel: channelId,
        slackUserId: payload.user.id,
        text: `Switched to *${option.label}*.`,
      });
    }
    return emptyResponse();
  },
);

const handleHomeSwitchAgent$ = command(
  async ({ get }, db: Db, payload: SlackInteractivePayload): Promise<void> => {
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
    const defaultComposeId = await resolveDefaultComposeId(db, ctx.orgId);
    const options = await getVisibleAgentPickerOptions({
      db,
      orgId: ctx.orgId,
      userId: ctx.connection.vm0UserId,
      defaultComposeId,
    });
    const visibleDefaultAgent = defaultComposeId
      ? await getVisibleWorkspaceAgent(
          db,
          defaultComposeId,
          ctx.orgId,
          ctx.connection.vm0UserId,
        )
      : undefined;
    if (!visibleDefaultAgent && options.length === 0) {
      return;
    }
    const orgDefaultName = visibleDefaultAgent
      ? (visibleDefaultAgent.displayName ?? visibleDefaultAgent.name)
      : null;
    const currentOverride = await getUserAgentPreference(
      db,
      ctx.connection.vm0UserId,
      ctx.orgId,
    );
    await tapError(
      openView(
        createSlackClient(
          await get(
            decryptSlackBotToken({
              installation: ctx.installation,
              userId: ctx.connection.vm0UserId,
            }),
          ),
        ),
        triggerId,
        buildAgentPickerModal({
          options,
          currentSelectedId: currentOverride,
          includeOrgDefault: Boolean(visibleDefaultAgent),
          orgDefaultName,
        }),
      ),
      (error) => {
        L.warn("Failed to open switch modal from App Home", { error });
      },
    );
  },
);

const handleHomeDisconnect$ = command(
  async ({ set }, db: Db, payload: SlackInteractivePayload): Promise<void> => {
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
    await set(refreshOrgAppHome$, db, installation, payload.user.id);
  },
);

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
      return set(handleAgentPickerSubmit$, db, payload);
    }
    if (
      payload.type === "view_submission" &&
      payload.view?.callback_id === MODEL_PICKER_CALLBACK_ID
    ) {
      return set(handleModelPickerSubmit$, db, payload, signal);
    }
    if (payload.type === "block_actions") {
      const action = payload.actions?.[0];
      if (!action) {
        return emptyResponse();
      }
      if (action.action_id === "home_disconnect") {
        await set(handleHomeDisconnect$, db, payload);
      } else if (action.action_id === "home_switch_agent") {
        await set(handleHomeSwitchAgent$, db, payload);
      }
    }
    return emptyResponse();
  },
);
