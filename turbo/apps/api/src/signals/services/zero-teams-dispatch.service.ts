import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import {
  getVm0VisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { computerUseHosts } from "@vm0/db/schema/computer-use-host";
import { orgMetadata } from "@vm0/db/schema/org-metadata";
import { teamsOrgConnections } from "@vm0/db/schema/teams-org-connection";
import { teamsOrgInstallations } from "@vm0/db/schema/teams-org-installation";
import { teamsOrgThreadSessions } from "@vm0/db/schema/teams-org-thread-session";
import { teamsUserAgentPreferences } from "@vm0/db/schema/teams-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import type { TeamsInboundActivity } from "@vm0/api-contracts/contracts/zero-teams-bot";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { convert } from "html-to-text";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  fetchTeamsChannelMessage,
  fetchTeamsChannelMessageReplies,
  fetchTeamsChannelMessages,
  sendTeamsReaction,
  sendTeamsTypingActivity,
  type TeamsAdaptiveCard,
  type TeamsGraphMessage,
} from "../external/teams-bot-client";
import { settle } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { canReuseIntegrationSessionForModelRoute } from "./integration-session-model-compatibility.service";
import type { ApiDispatchTimingCollector } from "./api-dispatch-timing.service";
import { userFeatureSwitchOverrides } from "./feature-switches.service";
import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import {
  teamsOrgCallbackPayloadSchema,
  type TeamsOrgCallbackPayload,
} from "./teams-org-callback-payload";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./zero-user-data.service";
import {
  buildTeamsConnectUrlForActivity,
  disconnectTeamsConnection$,
  publishTeamsChanged$,
} from "./zero-teams-connect.service";
import { createZeroRun$ } from "./zero-runs-create.service";

const L = logger("TeamsDispatch");
const TEAMS_LOGIN_PROMPT_FALLBACK_TEXT =
  "Please connect your account to use Zero in this Teams workspace.";
const TEAMS_AGENT_PICKER_MAX_OPTIONS = 100;
const TEAMS_MODEL_PICKER_MAX_OPTIONS = 100;
const TEAMS_CARD_ACTION_KEY = "zeroTeamsAction";
const TEAMS_AGENT_PICKER_ACTION = "switch_agent";
const TEAMS_MODEL_PICKER_ACTION = "switch_model";
const TEAMS_AGENT_PICKER_INPUT_ID = "selectedComposeId";
const TEAMS_MODEL_PICKER_INPUT_ID = "selectedModel";
const TEAMS_AGENT_PICKER_ORG_DEFAULT_VALUE = "__org_default__";
const TEAMS_THINKING_REACTION_TYPE = "1f4ad_thoughtballoon";

type TeamsBotCommand = "help" | "connect" | "disconnect" | "switch" | "model";
type TeamsCardAction = "switch_agent" | "switch_model";

type TeamsInstallation = typeof teamsOrgInstallations.$inferSelect;
type BoundTeamsInstallation = TeamsInstallation & { readonly orgId: string };
type TeamsConnection = typeof teamsOrgConnections.$inferSelect;
type TeamsMessageActivity = Extract<TeamsInboundActivity, { kind: "message" }>;

interface TeamsContextMessage {
  readonly id: string | null;
  readonly createdDateTime: string | null;
  readonly text: string;
  readonly senderId: string;
  readonly senderName: string | null;
  readonly senderPrincipalName: string | null;
}

interface TeamsAgent {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface TeamsAgentPickerOption {
  readonly composeId: string;
  readonly name: string;
  readonly displayName: string | null;
}

interface TeamsModelPickerOption {
  readonly model: SupportedRunModel;
  readonly label: string;
  readonly isDefault: boolean;
}

type EffectiveComposeResolution =
  | {
      readonly status: "resolved";
      readonly composeId: string;
      readonly agent: TeamsAgent;
    }
  | {
      readonly status: "not_configured" | "not_found" | "not_accessible";
    };

type ResolvedEffectiveCompose = Extract<
  EffectiveComposeResolution,
  { readonly status: "resolved" }
>;

interface TeamsRunThreadContext {
  readonly existingSessionId: string | undefined;
  readonly computerUseHostId: string | undefined;
}

type TeamsMessageDispatchResult =
  | { readonly kind: "ignored" }
  | {
      readonly kind: "notice";
      readonly replyText: string;
      readonly connectUrl?: string;
      readonly card?: TeamsAdaptiveCard;
    }
  | {
      readonly kind: "accepted" | "queued";
      readonly runId: string;
    }
  | {
      readonly kind: "failed";
      readonly replyText: string;
      readonly runId?: string;
    };

function callbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function optionalLine(
  label: string,
  value: string | null | undefined,
): string[] {
  const normalized = nonEmpty(value);
  return normalized ? [`${label}: ${normalized}`] : [];
}

function isTeamsBotCommand(value: string): value is TeamsBotCommand {
  return (
    value === "help" ||
    value === "connect" ||
    value === "disconnect" ||
    value === "switch" ||
    value === "model"
  );
}

function stringValue(
  value: Readonly<Record<string, unknown>> | null,
  key: string,
): string | undefined {
  const raw = value?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function teamsCardAction(
  value: Readonly<Record<string, unknown>> | null,
): TeamsCardAction | null {
  const action = stringValue(value, TEAMS_CARD_ACTION_KEY);
  if (action === TEAMS_AGENT_PICKER_ACTION) {
    return "switch_agent";
  }
  if (action === TEAMS_MODEL_PICKER_ACTION) {
    return "switch_model";
  }
  return null;
}

function choiceLabel(value: string): string {
  return value.slice(0, 80);
}

function agentLabel(agent: TeamsAgent | TeamsAgentPickerOption): string {
  return agent.displayName ?? agent.name;
}

function modelLabel(option: TeamsModelPickerOption): string {
  if (!option.isDefault) {
    return choiceLabel(option.label);
  }
  const suffix = " (workspace default)";
  if (option.label.length + suffix.length <= 80) {
    return `${option.label}${suffix}`;
  }
  return `${option.label.slice(0, 80 - suffix.length)}${suffix}`;
}

function parseTeamsBotCommand(prompt: string): TeamsBotCommand | null {
  const parts = prompt.trim().split(/\s+/u);
  const first = parts[0]?.toLowerCase() ?? "";
  const prefixed = first === "/zero" || first === "zero";
  const command = prefixed ? (parts[1]?.toLowerCase() ?? "") : first;
  if (!isTeamsBotCommand(command)) {
    return null;
  }
  return prefixed || parts.length === 1 ? command : null;
}

function commandHelpNotice(args: {
  readonly canSwitch: boolean;
  readonly canModel: boolean;
}): TeamsMessageDispatchResult {
  const switchLine = args.canSwitch
    ? "\n- `switch` - Choose which agent responds to your messages"
    : "";
  const modelLine = args.canModel ? "\n- `model` - Choose your model" : "";
  return {
    kind: "notice",
    replyText: [
      "**Zero Teams Bot Help**",
      "",
      "**Commands**",
      `- \`connect\` - Connect to Zero${switchLine}${modelLine}`,
      "- `disconnect` - Disconnect from Zero",
      "",
      "**Usage**",
      "- `@Zero <message>` - Send a message to your agent",
      "- Send a DM to Zero to chat without mentioning the bot",
    ].join("\n"),
  };
}

function connectedNotice(): TeamsMessageDispatchResult {
  return {
    kind: "notice",
    replyText:
      "You're already connected. Mention @Zero in any channel or send a DM to start chatting with your agent.",
  };
}

function notInstalledNotice(): TeamsMessageDispatchResult {
  return {
    kind: "notice",
    replyText:
      "The Zero Teams app hasn't been set up for this workspace yet. An org admin can complete the setup from VM0.",
  };
}

function disconnectedNotice(): TeamsMessageDispatchResult {
  return {
    kind: "notice",
    replyText:
      "You have been disconnected and your agent access has been revoked.",
  };
}

function buildTeamsAgentPickerCard(args: {
  readonly options: readonly TeamsAgentPickerOption[];
  readonly currentSelectedId: string | null;
  readonly includeOrgDefault: boolean;
  readonly orgDefaultName: string | null;
}): TeamsAdaptiveCard {
  const orgDefaultLabel = args.orgDefaultName
    ? `Use org default (${args.orgDefaultName})`
    : "Use org default";
  const choices = [
    ...(args.includeOrgDefault
      ? [
          {
            title: choiceLabel(orgDefaultLabel),
            value: TEAMS_AGENT_PICKER_ORG_DEFAULT_VALUE,
          },
        ]
      : []),
    ...args.options.map((option) => {
      return {
        title: choiceLabel(agentLabel(option)),
        value: option.composeId,
      };
    }),
  ];
  const currentChoice = args.currentSelectedId
    ? choices.find((choice) => {
        return choice.value === args.currentSelectedId;
      })
    : undefined;
  const initialValue = currentChoice?.value ?? choices[0]?.value;

  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Choose which agent should respond to your mentions and DMs. Only affects your own messages.",
        wrap: true,
      },
      {
        type: "Input.ChoiceSet",
        id: TEAMS_AGENT_PICKER_INPUT_ID,
        label: "Agent",
        style: "compact",
        isMultiSelect: false,
        ...(initialValue ? { value: initialValue } : {}),
        choices,
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Switch",
        data: { [TEAMS_CARD_ACTION_KEY]: TEAMS_AGENT_PICKER_ACTION },
      },
    ],
  };
}

function buildTeamsModelPickerCard(args: {
  readonly options: readonly TeamsModelPickerOption[];
  readonly currentSelectedModel: string | null;
}): TeamsAdaptiveCard {
  const choices = args.options.map((option) => {
    return {
      title: modelLabel(option),
      value: option.model,
    };
  });
  const defaultModel = args.options.find((option) => {
    return option.isDefault;
  })?.model;
  const currentChoice = args.currentSelectedModel
    ? choices.find((choice) => {
        return choice.value === args.currentSelectedModel;
      })
    : undefined;
  const defaultChoice = defaultModel
    ? choices.find((choice) => {
        return choice.value === defaultModel;
      })
    : undefined;
  const initialValue =
    currentChoice?.value ?? defaultChoice?.value ?? choices[0]?.value;

  return {
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      {
        type: "TextBlock",
        text: "Choose your model. This only affects your own runs.",
        wrap: true,
      },
      {
        type: "Input.ChoiceSet",
        id: TEAMS_MODEL_PICKER_INPUT_ID,
        label: "Model",
        style: "compact",
        isMultiSelect: false,
        ...(initialValue ? { value: initialValue } : {}),
        choices,
      },
    ],
    actions: [
      {
        type: "Action.Submit",
        title: "Switch",
        data: { [TEAMS_CARD_ACTION_KEY]: TEAMS_MODEL_PICKER_ACTION },
      },
    ],
  };
}

async function installationForTenant(
  db: Db,
  tenantId: string,
): Promise<TeamsInstallation | undefined> {
  const [installation] = await db
    .select()
    .from(teamsOrgInstallations)
    .where(eq(teamsOrgInstallations.teamsTenantId, tenantId))
    .limit(1);
  return installation;
}

async function connectionForTeamsUser(
  db: Db,
  tenantId: string,
  teamsUserId: string | null,
  teamsAadObjectId: string | null,
): Promise<TeamsConnection | undefined> {
  if (teamsAadObjectId) {
    const [connection] = await db
      .select()
      .from(teamsOrgConnections)
      .where(
        and(
          eq(teamsOrgConnections.teamsTenantId, tenantId),
          eq(teamsOrgConnections.teamsAadObjectId, teamsAadObjectId),
        ),
      )
      .limit(1);

    if (connection) {
      if (teamsUserId && connection.teamsUserId !== teamsUserId) {
        await db
          .update(teamsOrgConnections)
          .set({ teamsUserId, updatedAt: nowDate() })
          .where(eq(teamsOrgConnections.id, connection.id));
      }
      return connection;
    }
  }

  if (!teamsUserId) {
    return undefined;
  }

  const [connection] = await db
    .select()
    .from(teamsOrgConnections)
    .where(
      and(
        eq(teamsOrgConnections.teamsTenantId, tenantId),
        eq(teamsOrgConnections.teamsUserId, teamsUserId),
      ),
    )
    .limit(1);
  return connection;
}

async function resolveDefaultComposeId(
  db: Db,
  orgId: string,
): Promise<string | null> {
  const [metadata] = await db
    .select({ defaultAgentId: orgMetadata.defaultAgentId })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return metadata?.defaultAgentId ?? null;
}

function buildTeamsDispatchErrorText(args: {
  readonly errorText: string;
  readonly logsUrl: string | undefined;
  readonly footerText: string | undefined;
}): string {
  return [
    args.errorText,
    args.logsUrl ? `[Audit](${args.logsUrl})` : undefined,
    args.footerText ? `_${args.footerText}_` : undefined,
  ]
    .filter((part): part is string => {
      return Boolean(part);
    })
    .join("\n\n");
}

async function sendTeamsRunStartIndicator(args: {
  readonly activity: TeamsMessageActivity;
  readonly signal: AbortSignal;
}): Promise<void> {
  const activityId = args.activity.activityId;
  let mode: "typing" | "reaction";
  let indicator:
    | ReturnType<typeof sendTeamsTypingActivity>
    | ReturnType<typeof sendTeamsReaction>;
  if (isTeamsDirectMessage(args.activity) || !activityId) {
    mode = "typing";
    indicator = sendTeamsTypingActivity({
      serviceUrl: args.activity.serviceUrl,
      conversationId: args.activity.conversationId,
      tenantId: args.activity.tenantId,
      signal: args.signal,
    });
  } else {
    mode = "reaction";
    indicator = sendTeamsReaction({
      serviceUrl: args.activity.serviceUrl,
      conversationId: args.activity.conversationId,
      activityId,
      tenantId: args.activity.tenantId,
      reactionType: TEAMS_THINKING_REACTION_TYPE,
      signal: args.signal,
    });
  }
  const result = await settle(indicator, args.signal);
  const error = !result.ok
    ? result.error
    : result.value.kind === "teams-error"
      ? result.value.error
      : undefined;
  if (error !== undefined) {
    L.debug("Failed to send Teams run start indicator", {
      tenantId: args.activity.tenantId,
      conversationId: args.activity.conversationId,
      activityId: args.activity.activityId,
      mode,
      error,
    });
  }
}

async function getUserAgentPreference(
  db: Db,
  vm0UserId: string,
  orgId: string,
): Promise<string | null> {
  const [preference] = await db
    .select({ selectedComposeId: teamsUserAgentPreferences.selectedComposeId })
    .from(teamsUserAgentPreferences)
    .where(
      and(
        eq(teamsUserAgentPreferences.vm0UserId, vm0UserId),
        eq(teamsUserAgentPreferences.orgId, orgId),
      ),
    )
    .limit(1);
  return preference?.selectedComposeId ?? null;
}

async function setUserAgentPreference(args: {
  readonly db: Db;
  readonly vm0UserId: string;
  readonly orgId: string;
  readonly composeId: string | null;
}): Promise<void> {
  await args.db
    .insert(teamsUserAgentPreferences)
    .values({
      vm0UserId: args.vm0UserId,
      orgId: args.orgId,
      selectedComposeId: args.composeId,
    })
    .onConflictDoUpdate({
      target: [
        teamsUserAgentPreferences.vm0UserId,
        teamsUserAgentPreferences.orgId,
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
  orgId: string,
): Promise<TeamsAgent | undefined> {
  const [agent] = await db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(and(eq(zeroAgents.id, composeId), eq(zeroAgents.orgId, orgId)))
    .limit(1);
  return agent;
}

async function getVisibleWorkspaceAgent(args: {
  readonly db: Db;
  readonly composeId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<TeamsAgent | undefined> {
  const [agent] = await args.db
    .select({
      id: zeroAgents.id,
      name: zeroAgents.name,
      displayName: zeroAgents.displayName,
    })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, args.composeId),
        eq(zeroAgents.orgId, args.orgId),
        or(
          eq(zeroAgents.visibility, "public"),
          eq(zeroAgents.owner, args.userId),
        ),
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
}): Promise<readonly TeamsAgentPickerOption[]> {
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
    .slice(0, TEAMS_AGENT_PICKER_MAX_OPTIONS);
}

async function resolveEffectiveCompose(args: {
  readonly db: Db;
  readonly vm0UserId: string;
  readonly orgId: string;
}): Promise<EffectiveComposeResolution> {
  const override = await getUserAgentPreference(
    args.db,
    args.vm0UserId,
    args.orgId,
  );
  if (override) {
    const agent = await getVisibleWorkspaceAgent({
      db: args.db,
      composeId: override,
      orgId: args.orgId,
      userId: args.vm0UserId,
    });
    if (agent) {
      return { status: "resolved", composeId: override, agent };
    }
  }

  const defaultComposeId = await resolveDefaultComposeId(args.db, args.orgId);
  if (!defaultComposeId) {
    return { status: "not_configured" };
  }
  const configuredDefaultAgent = await getWorkspaceAgent(
    args.db,
    defaultComposeId,
    args.orgId,
  );
  if (!configuredDefaultAgent) {
    return { status: "not_found" };
  }
  const visibleDefaultAgent = await getVisibleWorkspaceAgent({
    db: args.db,
    composeId: defaultComposeId,
    orgId: args.orgId,
    userId: args.vm0UserId,
  });
  if (!visibleDefaultAgent) {
    return { status: "not_accessible" };
  }
  return {
    status: "resolved",
    composeId: defaultComposeId,
    agent: visibleDefaultAgent,
  };
}

const teamsModelPickerState$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly enabled: boolean;
    readonly options: readonly TeamsModelPickerOption[];
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
      options: policies.policies
        .flatMap((policy) => {
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
        })
        .slice(0, TEAMS_MODEL_PICKER_MAX_OPTIONS),
      currentSelectedModel: preference.selectedModel,
    };
  },
);

async function resolveCompatibleTeamsThreadSession(args: {
  readonly db: Db;
  readonly connectionId: string;
  readonly conversationId: string;
  readonly threadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly modelRoute: IntegrationModelRoutePin | undefined;
}): Promise<TeamsRunThreadContext> {
  const [threadSession] = await args.db
    .select({
      agentSessionId: teamsOrgThreadSessions.agentSessionId,
      computerUseHostId: teamsOrgThreadSessions.computerUseHostId,
    })
    .from(teamsOrgThreadSessions)
    .where(
      and(
        eq(teamsOrgThreadSessions.connectionId, args.connectionId),
        eq(teamsOrgThreadSessions.teamsConversationId, args.conversationId),
        eq(teamsOrgThreadSessions.teamsThreadId, args.threadId),
      ),
    )
    .limit(1);
  const computerUseHostId = await resolveComputerUseHostForTeamsThread({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    hostId: threadSession?.computerUseHostId ?? null,
  });

  if (!threadSession?.agentSessionId) {
    return { existingSessionId: undefined, computerUseHostId };
  }

  const existingSessionId = await resolveCompatibleTeamsAgentSession({
    db: args.db,
    sessionId: threadSession.agentSessionId,
    userId: args.userId,
    composeId: args.composeId,
    modelRoute: args.modelRoute,
  });

  return { existingSessionId, computerUseHostId };
}

async function resolveCompatibleTeamsAgentSession(args: {
  readonly db: Db;
  readonly sessionId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly modelRoute: IntegrationModelRoutePin | undefined;
}): Promise<string | undefined> {
  const [agentSession] = await args.db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, args.sessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (agentSession?.agentComposeId !== args.composeId) {
    return undefined;
  }

  if (args.modelRoute) {
    const canReuseSession = await canReuseIntegrationSessionForModelRoute({
      db: args.db,
      sessionId: args.sessionId,
      modelRoute: args.modelRoute,
    });
    if (!canReuseSession) {
      return undefined;
    }
  }

  return args.sessionId;
}

async function resolveComputerUseHostForTeamsThread(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly hostId: string | null;
}): Promise<string | undefined> {
  if (!args.hostId || !args.orgId) {
    return undefined;
  }

  const [host] = await args.db
    .select({ id: computerUseHosts.id })
    .from(computerUseHosts)
    .where(
      and(
        eq(computerUseHosts.id, args.hostId),
        eq(computerUseHosts.orgId, args.orgId),
        eq(computerUseHosts.userId, args.userId),
        isNull(computerUseHosts.revokedAt),
      ),
    )
    .limit(1);

  return host?.id;
}

function formatTeamsSenderBlock(message: TeamsContextMessage): string {
  const parts = [`id: ${message.senderId}`];
  if (message.senderName) {
    parts.push(`name: ${message.senderName}`);
  }
  if (message.senderPrincipalName) {
    parts.push(`email: ${message.senderPrincipalName}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

function formatTeamsContextMessage(
  message: TeamsContextMessage,
  relativeIndex: number,
): string {
  return [
    "---",
    "",
    `- RELATIVE_INDEX: ${relativeIndex}`,
    formatTeamsSenderBlock(message),
    "",
    message.text,
  ].join("\n");
}

const TEAMS_CONTEXT_PREAMBLE = [
  "The messages below are from a Microsoft Teams conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent; prioritize them.",
  "- Match the tone of the conversation; casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
].join("\n");

function formatTeamsThreadContext(
  messages: readonly TeamsContextMessage[],
): string {
  return formatTeamsContext("# Microsoft Teams Thread Context", messages);
}

function formatRecentTeamsChannelContext(
  messages: readonly TeamsContextMessage[],
): string {
  return formatTeamsContext("# Recent Channel Messages", messages);
}

function formatTeamsContext(
  header: string,
  messages: readonly TeamsContextMessage[],
): string {
  if (messages.length === 0) {
    return "";
  }

  const totalMessages = messages.length;
  const formattedMessages = messages.map((message, index) => {
    return formatTeamsContextMessage(message, index - totalMessages);
  });
  return `${header}\n\n${TEAMS_CONTEXT_PREAMBLE}\n\n${formattedMessages.join(
    "\n\n",
  )}\n\n---`;
}

function teamsGraphMessageText(message: TeamsGraphMessage): string {
  const content = message.body?.content?.trim() ?? "";
  if (message.body?.contentType === "html") {
    return convert(content, { wordwrap: false }).trim();
  }
  return content;
}

function teamsGraphMessageSender(
  message: TeamsGraphMessage,
): Pick<
  TeamsContextMessage,
  "senderId" | "senderName" | "senderPrincipalName"
> {
  const sender =
    message.from?.user ?? message.from?.application ?? message.from?.device;
  return {
    senderId: sender?.id ?? "unknown",
    senderName: sender?.displayName ?? null,
    senderPrincipalName: null,
  };
}

function teamsGraphContextMessage(
  message: TeamsGraphMessage,
): TeamsContextMessage | null {
  if (message.messageType && message.messageType !== "message") {
    return null;
  }

  const text = teamsGraphMessageText(message);
  if (!text) {
    return null;
  }

  return {
    id: message.id ?? null,
    createdDateTime: message.createdDateTime ?? null,
    text,
    ...teamsGraphMessageSender(message),
  };
}

function sortTeamsContextMessages(
  messages: readonly TeamsContextMessage[],
): TeamsContextMessage[] {
  return [...messages].sort((left, right) => {
    const leftTime = left.createdDateTime ?? "";
    const rightTime = right.createdDateTime ?? "";
    const byTime = leftTime.localeCompare(rightTime);
    if (byTime !== 0) {
      return byTime;
    }
    return (left.id ?? "").localeCompare(right.id ?? "");
  });
}

function teamsContextMessages(
  messages: readonly TeamsGraphMessage[],
  excludedIds: ReadonlySet<string>,
): TeamsContextMessage[] {
  return sortTeamsContextMessages(
    messages.flatMap((message) => {
      if (message.id && excludedIds.has(message.id)) {
        return [];
      }
      const contextMessage = teamsGraphContextMessage(message);
      return contextMessage ? [contextMessage] : [];
    }),
  );
}

function isTeamsThreadReply(activity: TeamsMessageActivity): boolean {
  return Boolean(
    activity.activityId && activity.threadId !== activity.activityId,
  );
}

function currentTeamsActivityIds(
  activity: TeamsMessageActivity,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (activity.activityId) {
    ids.add(activity.activityId);
  }
  return ids;
}

function recentChannelContextExcludedIds(
  activity: TeamsMessageActivity,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (activity.activityId) {
    ids.add(activity.activityId);
  }
  if (activity.threadId) {
    ids.add(activity.threadId);
  }
  return ids;
}

async function fetchTeamsThreadRootMessage(args: {
  readonly activity: TeamsMessageActivity;
  readonly signal: AbortSignal;
}): Promise<TeamsGraphMessage | null> {
  const { activity } = args;
  if (
    !isTeamsThreadReply(activity) ||
    !activity.teamId ||
    !activity.channelId
  ) {
    return null;
  }

  const rootResult = await fetchTeamsChannelMessage({
    tenantId: activity.tenantId,
    teamId: activity.teamId,
    channelId: activity.channelId,
    messageId: activity.threadId,
    signal: args.signal,
  });
  if (rootResult.kind === "teams-error") {
    L.warn("Teams thread root context fetch failed", {
      tenantId: activity.tenantId,
      teamId: activity.teamId,
      channelId: activity.channelId,
      threadId: activity.threadId,
      status: rootResult.status,
      error: rootResult.error,
    });
    return null;
  }

  return rootResult.message;
}

async function fetchTeamsThreadContext(args: {
  readonly activity: TeamsMessageActivity;
  readonly rootMessage: TeamsGraphMessage | null;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { activity } = args;
  if (!args.rootMessage || !activity.teamId || !activity.channelId) {
    return "";
  }

  const repliesResult = await fetchTeamsChannelMessageReplies({
    tenantId: activity.tenantId,
    teamId: activity.teamId,
    channelId: activity.channelId,
    messageId: activity.threadId,
    limit: 100,
    signal: args.signal,
  });
  if (repliesResult.kind === "teams-error") {
    L.warn("Teams thread replies context fetch failed", {
      tenantId: activity.tenantId,
      teamId: activity.teamId,
      channelId: activity.channelId,
      threadId: activity.threadId,
      status: repliesResult.status,
      error: repliesResult.error,
    });
    return "";
  }

  return formatTeamsThreadContext(
    teamsContextMessages(
      [args.rootMessage, ...repliesResult.messages],
      currentTeamsActivityIds(activity),
    ),
  );
}

function teamsMessagesBeforeReference(
  messages: readonly TeamsGraphMessage[],
  reference: TeamsGraphMessage | null,
): readonly TeamsGraphMessage[] {
  const referenceTime = reference?.createdDateTime;
  if (!referenceTime) {
    return messages;
  }

  return messages.filter((message) => {
    return !message.createdDateTime || message.createdDateTime < referenceTime;
  });
}

async function fetchRecentTeamsChannelContext(args: {
  readonly activity: TeamsMessageActivity;
  readonly beforeMessage: TeamsGraphMessage | null;
  readonly signal: AbortSignal;
}): Promise<string> {
  const { activity } = args;
  const teamId = activity.teamId;
  const channelId = activity.channelId;
  if (!teamId || !channelId) {
    return "";
  }

  const result = await fetchTeamsChannelMessages({
    tenantId: activity.tenantId,
    teamId,
    channelId,
    limit: 10,
    signal: args.signal,
  });
  if (result.kind === "teams-error") {
    L.warn("Teams channel context fetch failed", {
      tenantId: activity.tenantId,
      teamId: activity.teamId,
      channelId: activity.channelId,
      status: result.status,
      error: result.error,
    });
    return "";
  }

  return formatRecentTeamsChannelContext(
    teamsContextMessages(
      teamsMessagesBeforeReference(result.messages, args.beforeMessage),
      recentChannelContextExcludedIds(activity),
    ),
  );
}

function isTeamsDirectMessage(activity: TeamsMessageActivity): boolean {
  return activity.conversationType === "personal";
}

function shouldDispatchTeamsMessage(activity: TeamsMessageActivity): boolean {
  return isTeamsDirectMessage(activity) || activity.mentionsRecipient;
}

async function fetchTeamsPromptContext(args: {
  readonly activity: TeamsMessageActivity;
  readonly signal: AbortSignal;
}): Promise<string> {
  const threadRootMessage = await fetchTeamsThreadRootMessage({
    activity: args.activity,
    signal: args.signal,
  });
  const recentChannelContext = isTeamsDirectMessage(args.activity)
    ? ""
    : await fetchRecentTeamsChannelContext({
        activity: args.activity,
        beforeMessage: threadRootMessage,
        signal: args.signal,
      });
  const threadContext = await fetchTeamsThreadContext({
    activity: args.activity,
    rootMessage: threadRootMessage,
    signal: args.signal,
  });
  return [recentChannelContext, threadContext]
    .filter((context) => {
      return context.length > 0;
    })
    .join("\n\n");
}

function buildTeamsPrompt(args: {
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation;
  readonly threadContext: string;
}): string {
  const recipient = args.activity.recipient;
  return [
    "# Current Integration",
    "You are currently running inside: Microsoft Teams",
    `Tenant ID: ${args.activity.tenantId}`,
    ...optionalLine("Tenant name", args.activity.tenantName),
    ...optionalLine("Team ID", args.activity.teamId),
    ...optionalLine("Team name", args.activity.teamName),
    ...optionalLine("Channel ID", args.activity.channelId),
    `Conversation ID: ${args.activity.conversationId}`,
    ...optionalLine("Conversation type", args.activity.conversationType),
    `Thread ID: ${args.activity.threadId}`,
    ...optionalLine("Activity ID", args.activity.activityId),
    ...optionalLine("Teams app ID", args.activity.teamsAppId),
    ...optionalLine("Bot ID", recipient?.id ?? args.installation.botId),
    ...optionalLine("Bot name", recipient?.name ?? args.installation.botName),
    args.threadContext,
  ]
    .filter((line): line is string => {
      return line.length > 0;
    })
    .join("\n");
}

function callbackPayload(args: {
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation;
  readonly connection: TeamsConnection;
  readonly composeId: string;
  readonly existingSessionId: string | undefined;
}): TeamsOrgCallbackPayload {
  return teamsOrgCallbackPayloadSchema.parse({
    tenantId: args.activity.tenantId,
    tenantName: args.activity.tenantName,
    teamId: args.activity.teamId,
    teamName: args.activity.teamName,
    channelId: args.activity.channelId,
    conversationId: args.activity.conversationId,
    conversationType: args.activity.conversationType,
    threadId: args.activity.threadId,
    activityId: args.activity.activityId,
    serviceUrl: args.activity.serviceUrl,
    connectionId: args.connection.id,
    teamsUserId: args.activity.sender.id,
    teamsUserDisplayName: args.activity.sender.name,
    teamsUserPrincipalName: args.activity.sender.userPrincipalName,
    botId: args.activity.recipient?.id ?? args.installation.botId,
    botName: args.activity.recipient?.name ?? args.installation.botName,
    agentId: args.composeId,
    existingSessionId: args.existingSessionId ?? null,
  });
}

const runAgentForTeams$ = command(
  async (
    { get, set },
    args: {
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
      readonly composeId: string;
      readonly agentLabel: string;
      readonly sessionId: string | undefined;
      readonly computerUseHostId: string | undefined;
      readonly threadContext: string;
      readonly apiStartTime: number;
      readonly modelRoute: IntegrationModelRoutePin | undefined;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    args.timing.recordElapsed(
      "api_dispatch_pre_create_zero_teams_create_run",
      "nested",
      nowDate().getTime(),
    );
    const result = await set(
      createZeroRun$,
      {
        auth: {
          tokenType: "session",
          userId: args.connection.vm0UserId,
          orgId: args.installation.orgId,
          orgRole: "member",
        },
        body: {
          prompt: args.activity.text,
          agentId: args.composeId,
          sessionId: args.sessionId,
          ...(args.modelRoute?.modelProviderType
            ? { modelProvider: args.modelRoute.modelProviderType }
            : {}),
        },
        apiStartTime: args.apiStartTime,
        triggerSource: "teams",
        appendSystemPrompt: buildTeamsPrompt({
          activity: args.activity,
          installation: args.installation,
          threadContext: args.threadContext,
        }),
        userInfoExtras: {
          teamsUserDisplayName: args.activity.sender.name ?? undefined,
          teamsUserPrincipalName:
            args.activity.sender.userPrincipalName ?? undefined,
          teamsUserId: args.activity.sender.id,
        },
        modelProviderId: args.modelRoute?.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          args.modelRoute?.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: args.modelRoute?.selectedModel ?? undefined,
        computerUseHostId: args.computerUseHostId,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        timing: args.timing,
        callbacks: [
          {
            internalKind: "teams:org",
            secret: callbackSecret(),
            payload: callbackPayload({
              activity: args.activity,
              installation: args.installation,
              connection: args.connection,
              composeId: args.composeId,
              existingSessionId: args.sessionId,
            }),
          },
        ],
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.status === 201) {
      return {
        kind: result.body.status === "queued" ? "queued" : "accepted",
        runId: result.body.runId,
      };
    }

    const errorText = await set(
      formatIntegrationRunError$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.vm0UserId,
        code: result.body.error.code,
        message: result.body.error.message,
      },
      signal,
    );
    signal.throwIfAborted();

    const overrides = await get(
      userFeatureSwitchOverrides(
        args.installation.orgId,
        args.connection.vm0UserId,
      ),
    );
    signal.throwIfAborted();
    const logsUrl = isFeatureEnabled(FeatureSwitchKey.ZeroDebug, {
      userId: args.connection.vm0UserId,
      orgId: args.installation.orgId,
      overrides,
    })
      ? `${env("APP_URL")}/activities`
      : undefined;
    const db = set(writeDb$);
    const defaultComposeId = await resolveDefaultComposeId(
      db,
      args.installation.orgId,
    );
    signal.throwIfAborted();
    const footerText =
      args.composeId !== defaultComposeId
        ? `Sent via ${args.agentLabel}`
        : undefined;

    return {
      kind: "failed",
      replyText: buildTeamsDispatchErrorText({
        errorText,
        logsUrl,
        footerText,
      }),
    };
  },
);

function connectNotice(
  activity: TeamsMessageActivity,
  installation: TeamsInstallation | null,
): TeamsMessageDispatchResult {
  const connectUrl = buildTeamsConnectUrlForActivity({
    activity,
    installation,
  });
  return {
    kind: "notice",
    replyText: TEAMS_LOGIN_PROMPT_FALLBACK_TEXT,
    ...(connectUrl ? { connectUrl } : {}),
  };
}

function composeResolutionNotice(
  status: Exclude<EffectiveComposeResolution["status"], "resolved">,
): TeamsMessageDispatchResult {
  switch (status) {
    case "not_configured": {
      return {
        kind: "notice",
        replyText:
          "No agent is configured for this org. Please ask your org admin to set a default agent.",
      };
    }
    case "not_found": {
      return {
        kind: "notice",
        replyText:
          "The configured agent could not be found. Please contact your org admin.",
      };
    }
    case "not_accessible": {
      return {
        kind: "notice",
        replyText:
          "The configured agent is not available to your Teams account.",
      };
    }
  }
}

function unboundInstallationNotice(args: {
  readonly command: TeamsBotCommand | null;
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation | null;
}): TeamsMessageDispatchResult {
  if (args.command === "help") {
    return commandHelpNotice({ canSwitch: false, canModel: false });
  }
  if (args.command === "connect" && !args.installation) {
    return notInstalledNotice();
  }
  return connectNotice(args.activity, args.installation);
}

function missingConnectionNotice(args: {
  readonly command: TeamsBotCommand | null;
  readonly activity: TeamsMessageActivity;
  readonly installation: TeamsInstallation;
}): TeamsMessageDispatchResult {
  if (args.command === "help") {
    return commandHelpNotice({ canSwitch: true, canModel: false });
  }
  return connectNotice(args.activity, args.installation);
}

const connectedCommandBeforeCompose$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly command: TeamsBotCommand | null;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult | null> => {
    switch (args.command) {
      case "help": {
        return commandHelpNotice({ canSwitch: true, canModel: true });
      }
      case "connect": {
        return connectedNotice();
      }
      case "disconnect": {
        const result = await set(
          disconnectTeamsConnection$,
          {
            orgId: args.installation.orgId,
            userId: args.connection.vm0UserId,
          },
          signal,
        );
        signal.throwIfAborted();
        if (result.kind === "not_found") {
          return {
            kind: "notice",
            replyText: "You are not connected.",
          };
        }
        await set(
          publishTeamsChanged$,
          { orgId: result.orgId, userIds: [result.userId] },
          signal,
        );
        signal.throwIfAborted();
        return disconnectedNotice();
      }
      case "switch": {
        const defaultComposeId = await resolveDefaultComposeId(
          args.db,
          args.installation.orgId,
        );
        signal.throwIfAborted();
        const options = await getVisibleAgentPickerOptions({
          db: args.db,
          orgId: args.installation.orgId,
          userId: args.connection.vm0UserId,
          defaultComposeId,
        });
        signal.throwIfAborted();
        const visibleDefaultAgent = defaultComposeId
          ? await getVisibleWorkspaceAgent({
              db: args.db,
              composeId: defaultComposeId,
              orgId: args.installation.orgId,
              userId: args.connection.vm0UserId,
            })
          : undefined;
        signal.throwIfAborted();
        if (!visibleDefaultAgent && options.length === 0) {
          return {
            kind: "notice",
            replyText: "No agents are available to your Teams account.",
          };
        }
        const currentOverride = await getUserAgentPreference(
          args.db,
          args.connection.vm0UserId,
          args.installation.orgId,
        );
        signal.throwIfAborted();
        return {
          kind: "notice",
          replyText:
            "Choose which agent should respond to your Teams messages.",
          card: buildTeamsAgentPickerCard({
            options,
            currentSelectedId: currentOverride,
            includeOrgDefault: Boolean(visibleDefaultAgent),
            orgDefaultName: visibleDefaultAgent
              ? agentLabel(visibleDefaultAgent)
              : null,
          }),
        };
      }
      case "model": {
        const picker = await set(
          teamsModelPickerState$,
          args.installation.orgId,
          args.connection.vm0UserId,
          signal,
        );
        signal.throwIfAborted();
        if (!picker.enabled) {
          return {
            kind: "notice",
            replyText: "Model switching is not available for this workspace.",
          };
        }
        if (picker.options.length === 0) {
          return {
            kind: "notice",
            replyText: "No models are configured for this workspace.",
          };
        }
        return {
          kind: "notice",
          replyText: "Choose the model for your Teams agent.",
          card: buildTeamsModelPickerCard({
            options: picker.options,
            currentSelectedModel: picker.currentSelectedModel,
          }),
        };
      }
      case null: {
        return null;
      }
    }
  },
);

const connectedTeamsCardAction$ = command(
  async (
    { set },
    args: {
      readonly action: TeamsCardAction;
      readonly db: Db;
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    if (args.action === "switch_agent") {
      const selected = stringValue(
        args.activity.value,
        TEAMS_AGENT_PICKER_INPUT_ID,
      );
      if (!selected) {
        return {
          kind: "notice",
          replyText: "Please choose an agent.",
        };
      }

      if (selected === TEAMS_AGENT_PICKER_ORG_DEFAULT_VALUE) {
        const defaultComposeId = await resolveDefaultComposeId(
          args.db,
          args.installation.orgId,
        );
        signal.throwIfAborted();
        const visibleDefaultAgent = defaultComposeId
          ? await getVisibleWorkspaceAgent({
              db: args.db,
              composeId: defaultComposeId,
              orgId: args.installation.orgId,
              userId: args.connection.vm0UserId,
            })
          : undefined;
        signal.throwIfAborted();
        if (!visibleDefaultAgent) {
          return {
            kind: "notice",
            replyText: "You don't have access to that agent.",
          };
        }
        await setUserAgentPreference({
          db: args.db,
          vm0UserId: args.connection.vm0UserId,
          orgId: args.installation.orgId,
          composeId: null,
        });
        signal.throwIfAborted();
        return {
          kind: "notice",
          replyText: `Switched to **${agentLabel(visibleDefaultAgent)}**.`,
        };
      }

      const agent = await getVisibleWorkspaceAgent({
        db: args.db,
        composeId: selected,
        orgId: args.installation.orgId,
        userId: args.connection.vm0UserId,
      });
      signal.throwIfAborted();
      if (!agent || agent.id !== selected) {
        return {
          kind: "notice",
          replyText: "You don't have access to that agent.",
        };
      }
      await setUserAgentPreference({
        db: args.db,
        vm0UserId: args.connection.vm0UserId,
        orgId: args.installation.orgId,
        composeId: agent.id,
      });
      signal.throwIfAborted();
      return {
        kind: "notice",
        replyText: `Switched to **${agentLabel(agent)}**.`,
      };
    }

    const selected = stringValue(
      args.activity.value,
      TEAMS_MODEL_PICKER_INPUT_ID,
    );
    if (!selected) {
      return {
        kind: "notice",
        replyText: "Please choose a model.",
      };
    }

    const picker = await set(
      teamsModelPickerState$,
      args.installation.orgId,
      args.connection.vm0UserId,
      signal,
    );
    signal.throwIfAborted();
    const option = picker.options.find((candidate) => {
      return candidate.model === selected;
    });
    if (!option) {
      return {
        kind: "notice",
        replyText: "You don't have access to that model.",
      };
    }
    await set(
      updateUserModelPreference$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.vm0UserId,
        preference: { selectedModel: option.model },
      },
      signal,
    );
    signal.throwIfAborted();
    return {
      kind: "notice",
      replyText: `Switched to **${option.label}**.`,
    };
  },
);

const runResolvedTeamsAgentForActivity$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly prompt: string;
      readonly activity: TeamsMessageActivity;
      readonly installation: BoundTeamsInstallation;
      readonly connection: TeamsConnection;
      readonly effectiveCompose: ResolvedEffectiveCompose;
      readonly apiStartTime: number;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    await sendTeamsRunStartIndicator({
      activity: args.activity,
      signal,
    });
    signal.throwIfAborted();

    const modelRoute = await set(
      resolveIntegrationModelRouteForUser$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.vm0UserId,
      },
      signal,
    );
    signal.throwIfAborted();

    const runThreadContext = await resolveCompatibleTeamsThreadSession({
      db: args.db,
      connectionId: args.connection.id,
      conversationId: args.activity.conversationId,
      threadId: args.activity.threadId,
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
      composeId: args.effectiveCompose.composeId,
      modelRoute,
    });
    signal.throwIfAborted();

    const threadContext = await fetchTeamsPromptContext({
      activity: args.activity,
      signal,
    });
    signal.throwIfAborted();

    const result = await set(
      runAgentForTeams$,
      {
        activity: { ...args.activity, text: args.prompt },
        installation: args.installation,
        connection: args.connection,
        composeId: args.effectiveCompose.composeId,
        agentLabel: agentLabel(args.effectiveCompose.agent),
        sessionId: runThreadContext.existingSessionId,
        computerUseHostId: runThreadContext.computerUseHostId,
        threadContext,
        apiStartTime: args.apiStartTime,
        modelRoute,
        timing: args.timing,
      },
      signal,
    );
    signal.throwIfAborted();

    if (result.kind === "failed") {
      L.warn("Teams agent dispatch failed", {
        tenantId: args.activity.tenantId,
        conversationId: args.activity.conversationId,
        threadId: args.activity.threadId,
        userId: args.connection.vm0UserId,
        runId: result.runId,
      });
    }

    return result;
  },
);

export const dispatchTeamsMessageToAgent$ = command(
  async (
    { set },
    args: {
      readonly activity: TeamsInboundActivity;
      readonly installation?: TeamsInstallation | null;
      readonly apiStartTime: number;
      readonly timing: ApiDispatchTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<TeamsMessageDispatchResult> => {
    const { activity } = args;
    if (activity.kind !== "message") {
      return { kind: "ignored" };
    }

    const cardAction = teamsCardAction(activity.value);
    if (!shouldDispatchTeamsMessage(activity) && !cardAction) {
      return { kind: "ignored" };
    }

    const prompt = activity.text.trim();
    if (!prompt && !cardAction) {
      return {
        kind: "notice",
        replyText: "Please include a message for Zero.",
      };
    }
    const command = cardAction ? null : parseTeamsBotCommand(prompt);

    const db = set(writeDb$);
    const installation =
      args.installation ??
      (await installationForTenant(db, activity.tenantId)) ??
      null;
    signal.throwIfAborted();

    if (!installation?.orgId) {
      return unboundInstallationNotice({ command, activity, installation });
    }
    const boundInstallation: BoundTeamsInstallation = {
      ...installation,
      orgId: installation.orgId,
    };

    const connection = await connectionForTeamsUser(
      db,
      activity.tenantId,
      activity.sender.id,
      activity.sender.aadObjectId,
    );
    signal.throwIfAborted();

    if (!connection) {
      return missingConnectionNotice({ command, activity, installation });
    }

    if (cardAction) {
      return set(
        connectedTeamsCardAction$,
        {
          action: cardAction,
          db,
          activity,
          installation: boundInstallation,
          connection,
        },
        signal,
      );
    }

    const commandResult = await set(
      connectedCommandBeforeCompose$,
      { db, command, installation: boundInstallation, connection },
      signal,
    );
    signal.throwIfAborted();
    if (commandResult) {
      return commandResult;
    }

    const effectiveCompose = await resolveEffectiveCompose({
      db,
      vm0UserId: connection.vm0UserId,
      orgId: boundInstallation.orgId,
    });
    signal.throwIfAborted();

    if (effectiveCompose.status !== "resolved") {
      return composeResolutionNotice(effectiveCompose.status);
    }

    return set(
      runResolvedTeamsAgentForActivity$,
      {
        db,
        prompt,
        activity,
        installation: boundInstallation,
        connection,
        effectiveCompose,
        apiStartTime: args.apiStartTime,
        timing: args.timing,
      },
      signal,
    );
  },
);
