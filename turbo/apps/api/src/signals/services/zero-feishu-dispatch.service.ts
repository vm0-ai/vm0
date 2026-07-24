import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import { and, desc, eq, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  getVm0VisibleModels,
  isSupportedRunModel,
  type SupportedRunModel,
} from "@vm0/api-contracts/contracts/model-providers";
import { agentSessions } from "@vm0/db/schema/agent-session";
import { feishuOrgConnections } from "@vm0/db/schema/feishu-org-connection";
import { feishuOrgInstallations } from "@vm0/db/schema/feishu-org-installation";
import { feishuOrgThreadSessions } from "@vm0/db/schema/feishu-org-thread-session";
import { feishuUserAgentPreferences } from "@vm0/db/schema/feishu-user-agent-preference";
import { zeroAgents } from "@vm0/db/schema/zero-agent";

import {
  buildFeishuHelpMessage,
  buildFeishuLoginMessage,
  buildFeishuNoticeMessage,
} from "../../lib/feishu-message-card";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import {
  addFeishuMessageReaction,
  listFeishuChatMessages,
  removeFeishuMessageReaction,
  replyWithFeishuMessage,
  sendFeishuMessage,
  type FeishuHistoryMessage,
  type FeishuOutboundMessage,
} from "../external/feishu-client";
import { writeDb$, type Db } from "../external/db";
import { now, nowDate } from "../external/time";
import { onRejection, safeJsonParse, tapError } from "../utils";
import { dispatchFailedRunCallbacks } from "./agent-run-callback.service";
import { buildFeishuConnectUrl } from "./feishu-connect-token";
import { feishuOrgCallbackPayloadSchema } from "./feishu-org-callback-payload";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import {
  resolveIntegrationModelRouteForUser$,
  type IntegrationModelRoutePin,
} from "./integration-model-route.service";
import { canReuseIntegrationSessionForModelRoute } from "./integration-session-model-compatibility.service";
import { publishFeishuOrgChanged } from "./zero-feishu-realtime.service";
import { listOrgModelPolicies$ } from "./zero-model-policy.service";
import { createZeroRun$ } from "./zero-runs-create.service";
import {
  updateUserModelPreference$,
  userModelPreference,
} from "./zero-user-data.service";

const L = logger("ZeroFeishuDispatch");
const FEISHU_THINKING_EMOJI = "Typing";
const FEISHU_AGENT_PICKER_MAX_OPTIONS = 100;
const FEISHU_MODEL_PICKER_MAX_OPTIONS = 100;
const textContentSchema = z.object({ text: z.string() });
const resourceContentSchema = z.object({
  file_key: z.string().optional(),
  image_key: z.string().optional(),
  file_name: z.string().optional(),
});

export interface FeishuPromptFile {
  readonly fileId: string;
  readonly messageId: string;
  readonly fileKey: string;
  readonly type: "file" | "image";
  readonly filename: string;
}

interface FeishuPromptContext {
  readonly text: string;
  readonly files: readonly FeishuPromptFile[];
}

export interface FeishuInboundMessage {
  readonly installationId: string;
  readonly eventId: string;
  readonly tenantKey: string;
  readonly appId: string;
  readonly messageId: string;
  readonly chatId: string;
  readonly chatType: "group" | "p2p" | "topic_group";
  readonly rootId: string | null;
  readonly parentId: string | null;
  readonly threadId: string | null;
  readonly openId: string;
  readonly text: string;
  readonly file: FeishuPromptFile | null;
}

interface FeishuAgent {
  readonly id: string;
  readonly name: string;
  readonly displayName: string | null;
}

export interface FeishuDispatchInstallation {
  readonly orgId: string;
  readonly ownerUserId: string | null;
  readonly defaultAgentId: string;
  readonly messageReceivedAt: Date | null;
}

export interface FeishuDispatchConnection {
  readonly id: string;
  readonly vm0UserId: string;
}

interface FeishuModelOption {
  readonly model: SupportedRunModel;
  readonly label: string;
  readonly isDefault: boolean;
}

interface FeishuCommand {
  readonly name: string;
  readonly argument: string;
}

interface ConnectedCommandArgs {
  readonly db: Db;
  readonly installation: FeishuDispatchInstallation;
  readonly connection: FeishuDispatchConnection;
  readonly message: FeishuInboundMessage;
  readonly command: FeishuCommand;
}

type ConnectedDispatchArgs = Omit<ConnectedCommandArgs, "command">;

type EffectiveAgentResolution =
  | { readonly status: "resolved"; readonly agent: FeishuAgent }
  | {
      readonly status: "not_accessible" | "not_found";
    };

function agentLabel(agent: FeishuAgent): string {
  return agent.displayName ?? agent.name;
}

function parseFeishuCommand(text: string): FeishuCommand | null {
  const match = /^\/(\S+)(?:\s+(.+))?$/u.exec(text.trim());
  if (!match) {
    return null;
  }
  return {
    name: match[1]?.toLowerCase() ?? "",
    argument: match[2]?.trim() ?? "",
  };
}

async function reply(args: {
  readonly db: Db;
  readonly message: FeishuInboundMessage;
  readonly outbound: FeishuOutboundMessage;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.message.chatType === "p2p") {
    await sendFeishuMessage({
      db: args.db,
      installationId: args.message.installationId,
      receiveIdType: "chat_id",
      receiveId: args.message.chatId,
      message: args.outbound,
      signal: args.signal,
    });
    return;
  }
  await replyWithFeishuMessage({
    db: args.db,
    installationId: args.message.installationId,
    messageId: args.message.messageId,
    message: args.outbound,
    replyInThread: true,
    signal: args.signal,
  });
}

async function replyNotice(args: {
  readonly db: Db;
  readonly message: FeishuInboundMessage;
  readonly title: string;
  readonly text: string;
  readonly kind?: "error" | "info" | "success" | "warning";
  readonly signal: AbortSignal;
}): Promise<void> {
  await reply({
    db: args.db,
    message: args.message,
    outbound: buildFeishuNoticeMessage({
      title: args.title,
      text: args.text,
      kind: args.kind,
    }),
    signal: args.signal,
  });
}

async function getVisibleAgent(args: {
  readonly db: Db;
  readonly composeId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<FeishuAgent | undefined> {
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

async function getVisibleAgents(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
}): Promise<readonly FeishuAgent[]> {
  return await args.db
    .select({
      id: zeroAgents.id,
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
    .orderBy(desc(zeroAgents.updatedAt))
    .limit(FEISHU_AGENT_PICKER_MAX_OPTIONS);
}

async function getUserAgentPreference(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
}): Promise<string | null> {
  const [preference] = await args.db
    .select({
      selectedComposeId: feishuUserAgentPreferences.selectedComposeId,
    })
    .from(feishuUserAgentPreferences)
    .where(
      and(
        eq(feishuUserAgentPreferences.vm0UserId, args.userId),
        eq(feishuUserAgentPreferences.orgId, args.orgId),
      ),
    )
    .limit(1);
  return preference?.selectedComposeId ?? null;
}

async function setUserAgentPreference(args: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string | null;
}): Promise<void> {
  await args.db
    .insert(feishuUserAgentPreferences)
    .values({
      vm0UserId: args.userId,
      orgId: args.orgId,
      selectedComposeId: args.composeId,
    })
    .onConflictDoUpdate({
      target: [
        feishuUserAgentPreferences.vm0UserId,
        feishuUserAgentPreferences.orgId,
      ],
      set: {
        selectedComposeId: args.composeId,
        updatedAt: nowDate(),
      },
    });
}

export async function resolveEffectiveFeishuAgent(args: {
  readonly db: Db;
  readonly installation: FeishuDispatchInstallation;
  readonly connection: FeishuDispatchConnection;
}): Promise<EffectiveAgentResolution> {
  const preference = await getUserAgentPreference({
    db: args.db,
    orgId: args.installation.orgId,
    userId: args.connection.vm0UserId,
  });
  if (preference) {
    const preferredAgent = await getVisibleAgent({
      db: args.db,
      composeId: preference,
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
    });
    if (preferredAgent) {
      return { status: "resolved", agent: preferredAgent };
    }
  }
  const composeId = args.installation.defaultAgentId;
  const agent = await getVisibleAgent({
    db: args.db,
    composeId,
    orgId: args.installation.orgId,
    userId: args.connection.vm0UserId,
  });
  if (agent) {
    return { status: "resolved", agent };
  }
  const [existing] = await args.db
    .select({ id: zeroAgents.id })
    .from(zeroAgents)
    .where(
      and(
        eq(zeroAgents.id, composeId),
        eq(zeroAgents.orgId, args.installation.orgId),
      ),
    )
    .limit(1);
  return { status: existing ? "not_accessible" : "not_found" };
}

function sessionKey(message: FeishuInboundMessage): string {
  if (message.chatType === "p2p") {
    return message.chatId;
  }
  const threadKey =
    message.rootId ?? message.threadId ?? message.parentId ?? message.messageId;
  return `${message.chatId}:${threadKey}`;
}

async function resolveSession(args: {
  readonly db: Db;
  readonly connectionId: string;
  readonly sessionKey: string;
  readonly userId: string;
  readonly agentId: string;
  readonly modelRoute: IntegrationModelRoutePin | undefined;
}): Promise<string | undefined> {
  const [thread] = await args.db
    .select({ agentSessionId: feishuOrgThreadSessions.agentSessionId })
    .from(feishuOrgThreadSessions)
    .where(
      and(
        eq(feishuOrgThreadSessions.connectionId, args.connectionId),
        eq(feishuOrgThreadSessions.feishuChatId, args.sessionKey),
      ),
    )
    .limit(1);
  if (!thread?.agentSessionId) {
    return undefined;
  }
  const [session] = await args.db
    .select({ agentComposeId: agentSessions.agentComposeId })
    .from(agentSessions)
    .where(
      and(
        eq(agentSessions.id, thread.agentSessionId),
        eq(agentSessions.userId, args.userId),
      ),
    )
    .limit(1);
  if (session?.agentComposeId !== args.agentId) {
    return undefined;
  }
  if (
    args.modelRoute &&
    !(await canReuseIntegrationSessionForModelRoute({
      db: args.db,
      sessionId: thread.agentSessionId,
      modelRoute: args.modelRoute,
    }))
  ) {
    return undefined;
  }
  return thread.agentSessionId;
}

export function feishuPromptFile(args: {
  readonly messageId: string;
  readonly messageType: string;
  readonly content: string;
}): FeishuPromptFile | null {
  if (!["audio", "file", "image", "media"].includes(args.messageType)) {
    return null;
  }
  const parsed = resourceContentSchema.safeParse(safeJsonParse(args.content));
  if (!parsed.success) {
    return null;
  }
  const resourceType = args.messageType === "image" ? "image" : "file";
  const fileKey =
    resourceType === "image" ? parsed.data.image_key : parsed.data.file_key;
  if (!fileKey) {
    return null;
  }
  const fallbackName =
    args.messageType === "image"
      ? "image"
      : args.messageType === "audio"
        ? "audio"
        : args.messageType === "media"
          ? "video"
          : "file";
  const filename =
    parsed.data.file_name?.replace(/\s+/gu, " ").trim() || fallbackName;
  return {
    fileId: `feishu_file_${randomBytes(16).toString("base64url")}`,
    messageId: args.messageId,
    fileKey,
    type: resourceType,
    filename,
  };
}

export function formatFeishuFileContext(file: FeishuPromptFile): string {
  return [
    `[Feishu file] ${file.filename}`,
    `   [MESSAGE_ID] ${file.messageId}`,
    `   [FILE_KEY] ${file.fileId}`,
    `   [TYPE] ${file.type}`,
  ].join("\n");
}

function historyMessageContext(
  message: FeishuHistoryMessage,
): FeishuPromptContext {
  const file = message.body?.content
    ? feishuPromptFile({
        messageId: message.message_id,
        messageType: message.msg_type,
        content: message.body.content,
      })
    : null;
  if (file) {
    return { text: formatFeishuFileContext(file), files: [file] };
  }
  if (message.msg_type !== "text" || !message.body?.content) {
    return { text: `[${message.msg_type} message]`, files: [] };
  }
  const parsed = textContentSchema.safeParse(
    safeJsonParse(message.body.content),
  );
  if (!parsed.success) {
    return { text: "[text message]", files: [] };
  }
  const text = (message.mentions ?? []).reduce((currentText, mention) => {
    if (!mention.key) {
      return currentText;
    }
    const label = mention.name ? `@${mention.name}` : "@user";
    return currentText.replaceAll(
      mention.key,
      mention.id ? `${label} (${mention.id})` : label,
    );
  }, parsed.data.text);
  return { text, files: [] };
}

function formatFeishuSenderBlock(message: FeishuHistoryMessage): string {
  const parts = [
    `id: ${message.sender?.id ?? message.sender?.sender_type ?? "unknown"}`,
  ];
  if (message.sender?.sender_name) {
    parts.push(`name: ${message.sender.sender_name}`);
  }
  return `- SENDER: {${parts.join(", ")}}`;
}

function formatFeishuContextMessage(
  message: FeishuHistoryMessage,
  relativeIndex: number,
): FeishuPromptContext {
  const context = historyMessageContext(message);
  return {
    text: [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      formatFeishuSenderBlock(message),
      "",
      context.text,
    ].join("\n"),
    files: context.files,
  };
}

const FEISHU_CONTEXT_PREAMBLE = [
  "The messages below are from a Feishu conversation. When responding:",
  "- Messages closer to RELATIVE_INDEX 0 are more recent — prioritize them.",
  "- Match the tone of the conversation — casual messages deserve casual replies.",
  "- Only provide technical analysis when explicitly asked a technical question.",
  "- Keep responses proportional to the message length and complexity.",
].join("\n");

function formatFeishuContext(
  header: string,
  messages: readonly FeishuHistoryMessage[],
): FeishuPromptContext {
  if (messages.length === 0) {
    return { text: "", files: [] };
  }
  const totalMessages = messages.length;
  const formattedMessages = messages.map((message, index) => {
    return formatFeishuContextMessage(message, index - totalMessages);
  });
  return {
    text: `${header}\n\n${FEISHU_CONTEXT_PREAMBLE}\n\n${formattedMessages
      .map((context) => {
        return context.text;
      })
      .join("\n\n")}\n\n---`,
    files: formattedMessages.flatMap((context) => {
      return context.files;
    }),
  };
}

function formatConversationHistory(
  history: readonly FeishuHistoryMessage[],
  current: FeishuInboundMessage,
): FeishuPromptContext {
  const messages = [...history]
    .filter((message) => {
      return !message.deleted && message.message_id !== current.messageId;
    })
    .sort((left, right) => {
      return Number(left.create_time ?? 0) - Number(right.create_time ?? 0);
    });
  if (messages.length === 0) {
    return { text: "", files: [] };
  }
  if (current.chatType === "p2p") {
    return formatFeishuContext("# Feishu Thread Context", messages.slice(-30));
  }

  const threadKeys = new Set(
    [
      current.rootId,
      current.threadId,
      current.parentId,
      current.messageId,
    ].filter((value): value is string => {
      return Boolean(value);
    }),
  );
  const threadMessages = messages.filter((message) => {
    return [
      message.thread_id,
      message.root_id,
      message.parent_id,
      message.message_id,
    ]
      .filter((value): value is string => {
        return Boolean(value);
      })
      .some((value) => {
        return threadKeys.has(value);
      });
  });
  const threadIds = new Set(
    threadMessages.map((message) => {
      return message.message_id;
    }),
  );
  const recentChat = messages
    .filter((message) => {
      return !threadIds.has(message.message_id);
    })
    .slice(-10);
  const recentContext = formatFeishuContext(
    "# Recent Channel Messages",
    recentChat,
  );
  const threadContext = formatFeishuContext(
    "# Feishu Thread Context",
    threadMessages,
  );
  return {
    text: [recentContext.text, threadContext.text].filter(Boolean).join("\n\n"),
    files: [...recentContext.files, ...threadContext.files],
  };
}

export async function loadFeishuConversationHistory(args: {
  readonly db: Db;
  readonly message: FeishuInboundMessage;
  readonly signal: AbortSignal;
}): Promise<FeishuPromptContext> {
  const history = await tapError(
    listFeishuChatMessages({
      db: args.db,
      installationId: args.message.installationId,
      chatId: args.message.chatId,
      signal: args.signal,
    }),
    (error) => {
      L.warn("Failed to load Feishu conversation history", {
        error,
        installationId: args.message.installationId,
        chatId: args.message.chatId,
      });
    },
  );
  args.signal.throwIfAborted();
  return history
    ? formatConversationHistory(history, args.message)
    : { text: "", files: [] };
}

export function buildFeishuSystemPrompt(args: {
  readonly message: FeishuInboundMessage;
  readonly history: string;
}): string {
  const typeLabel =
    args.message.chatType === "p2p" ? "Direct message" : "Group mention";
  return [
    "# Current Integration",
    "You are currently running inside: Feishu",
    `Scope: ${typeLabel}`,
    `Installation ID: ${args.message.installationId}`,
    `Tenant key: ${args.message.tenantKey}`,
    `Chat ID: ${args.message.chatId}`,
    `Thread ID: ${
      args.message.threadId ??
      args.message.rootId ??
      args.message.parentId ??
      args.message.messageId
    }`,
    `Message ID: ${args.message.messageId}`,
    `Sender open ID: ${args.message.openId}`,
    args.history,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function markFeishuMessageReceived(args: {
  readonly db: Db;
  readonly installation: FeishuDispatchInstallation;
  readonly message: FeishuInboundMessage;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.installation.messageReceivedAt) {
    return;
  }
  const [markedAsReceived] = await args.db
    .update(feishuOrgInstallations)
    .set({
      feishuTenantKey: args.message.tenantKey,
      messageReceivedAt: nowDate(),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(feishuOrgInstallations.id, args.message.installationId),
        isNull(feishuOrgInstallations.messageReceivedAt),
      ),
    )
    .returning({ id: feishuOrgInstallations.id });
  args.signal.throwIfAborted();
  if (markedAsReceived) {
    await publishFeishuOrgChanged(
      args.db,
      args.installation.orgId,
      args.installation.ownerUserId,
    );
  }
}

const feishuModelPickerState$ = command(
  async (
    { get, set },
    orgId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly options: readonly FeishuModelOption[];
    readonly currentSelectedModel: string | null;
  }> => {
    const visibleModels = new Set(getVm0VisibleModels());
    const [policies, preference] = await Promise.all([
      set(listOrgModelPolicies$, { orgId, userId }, signal),
      get(userModelPreference({ orgId, userId })),
    ]);
    signal.throwIfAborted();
    return {
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
        .slice(0, FEISHU_MODEL_PICKER_MAX_OPTIONS),
      currentSelectedModel: preference.selectedModel,
    };
  },
);

function commandOptionsText(args: {
  readonly intro: string;
  readonly options: readonly {
    readonly commandValue: string;
    readonly label: string;
    readonly current: boolean;
  }[];
  readonly command: "model" | "switch";
}): string {
  return [
    args.intro,
    "",
    ...args.options.map((option) => {
      return `• \`/${args.command} ${option.commandValue}\` — ${option.label}${option.current ? " (current)" : ""}`;
    }),
  ].join("\n");
}

async function handleDisconnectCommand(
  args: ConnectedCommandArgs,
  signal: AbortSignal,
): Promise<void> {
  await args.db
    .delete(feishuOrgConnections)
    .where(eq(feishuOrgConnections.id, args.connection.id));
  signal.throwIfAborted();
  await publishFeishuOrgChanged(
    args.db,
    args.installation.orgId,
    args.installation.ownerUserId,
    [args.connection.vm0UserId],
  );
  await replyNotice({
    db: args.db,
    message: args.message,
    title: "Disconnected",
    text: "Your Feishu account has been disconnected and its agent access has been revoked.",
    kind: "success",
    signal,
  });
}

async function replyAgentPicker(args: {
  readonly commandArgs: ConnectedCommandArgs;
  readonly agents: readonly FeishuAgent[];
  readonly defaultAgent: FeishuAgent | undefined;
  readonly currentPreference: string | null;
  readonly signal: AbortSignal;
}): Promise<void> {
  await replyNotice({
    db: args.commandArgs.db,
    message: args.commandArgs.message,
    title: "Choose an agent",
    text: commandOptionsText({
      intro:
        "Send one of these commands to choose which agent responds to your Feishu messages.",
      command: "switch",
      options: [
        ...(args.defaultAgent
          ? [
              {
                commandValue: "default",
                label: `${agentLabel(args.defaultAgent)} (installation default)`,
                current: args.currentPreference === null,
              },
            ]
          : []),
        ...args.agents
          .filter((agent) => {
            return agent.id !== args.commandArgs.installation.defaultAgentId;
          })
          .map((agent) => {
            return {
              commandValue: agent.id,
              label: agentLabel(agent),
              current: args.currentPreference === agent.id,
            };
          }),
      ],
    }),
    signal: args.signal,
  });
}

async function handleSwitchCommand(
  args: ConnectedCommandArgs,
  signal: AbortSignal,
): Promise<void> {
  const [agents, defaultAgent, currentPreference] = await Promise.all([
    getVisibleAgents({
      db: args.db,
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
    }),
    getVisibleAgent({
      db: args.db,
      composeId: args.installation.defaultAgentId,
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
    }),
    getUserAgentPreference({
      db: args.db,
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
    }),
  ]);
  signal.throwIfAborted();
  if (!args.command.argument) {
    await replyAgentPicker({
      commandArgs: args,
      agents,
      defaultAgent,
      currentPreference,
      signal,
    });
    return;
  }
  if (args.command.argument.toLowerCase() === "default") {
    if (!defaultAgent) {
      await replyNotice({
        db: args.db,
        message: args.message,
        title: "Agent unavailable",
        text: "You don't have access to the installation default agent.",
        kind: "error",
        signal,
      });
      return;
    }
    await setUserAgentPreference({
      db: args.db,
      orgId: args.installation.orgId,
      userId: args.connection.vm0UserId,
      composeId: null,
    });
    signal.throwIfAborted();
    await replyNotice({
      db: args.db,
      message: args.message,
      title: "Agent switched",
      text: `Switched to **${agentLabel(defaultAgent)}**.`,
      kind: "success",
      signal,
    });
    return;
  }
  const normalized = args.command.argument.toLowerCase();
  const selected = agents.find((agent) => {
    return (
      agent.id === args.command.argument ||
      agent.name.toLowerCase() === normalized ||
      agent.displayName?.toLowerCase() === normalized
    );
  });
  if (!selected) {
    await replyNotice({
      db: args.db,
      message: args.message,
      title: "Agent unavailable",
      text: "You don't have access to that agent. Use `/switch` to list available agents.",
      kind: "error",
      signal,
    });
    return;
  }
  await setUserAgentPreference({
    db: args.db,
    orgId: args.installation.orgId,
    userId: args.connection.vm0UserId,
    composeId:
      selected.id === args.installation.defaultAgentId ? null : selected.id,
  });
  signal.throwIfAborted();
  await replyNotice({
    db: args.db,
    message: args.message,
    title: "Agent switched",
    text: `Switched to **${agentLabel(selected)}**.`,
    kind: "success",
    signal,
  });
}

const handleModelCommand$ = command(
  async (
    { set },
    args: ConnectedCommandArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const picker = await set(
      feishuModelPickerState$,
      args.installation.orgId,
      args.connection.vm0UserId,
      signal,
    );
    signal.throwIfAborted();
    if (picker.options.length === 0) {
      await replyNotice({
        db: args.db,
        message: args.message,
        title: "No models available",
        text: "No models are configured for this workspace.",
        kind: "error",
        signal,
      });
      return;
    }
    if (!args.command.argument) {
      await replyNotice({
        db: args.db,
        message: args.message,
        title: "Choose a model",
        text: commandOptionsText({
          intro:
            "Send one of these commands to choose the model for your own Feishu runs.",
          command: "model",
          options: picker.options.map((option) => {
            return {
              commandValue: option.model,
              label: `${option.label}${option.isDefault ? " (workspace default)" : ""}`,
              current:
                picker.currentSelectedModel === option.model ||
                (!picker.currentSelectedModel && option.isDefault),
            };
          }),
        }),
        signal,
      });
      return;
    }
    const normalized = args.command.argument.toLowerCase();
    const selected = picker.options.find((option) => {
      return (
        option.model.toLowerCase() === normalized ||
        option.label.toLowerCase() === normalized
      );
    });
    if (!selected) {
      await replyNotice({
        db: args.db,
        message: args.message,
        title: "Model unavailable",
        text: "You don't have access to that model. Use `/model` to list available models.",
        kind: "error",
        signal,
      });
      return;
    }
    await set(
      updateUserModelPreference$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.vm0UserId,
        preference: { selectedModel: selected.model },
      },
      signal,
    );
    signal.throwIfAborted();
    await replyNotice({
      db: args.db,
      message: args.message,
      title: "Model switched",
      text: `Switched to **${selected.label}**.`,
      kind: "success",
      signal,
    });
  },
);

const handleConnectedCommand$ = command(
  async (
    { set },
    args: ConnectedCommandArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    switch (args.command.name) {
      case "help": {
        await reply({
          db: args.db,
          message: args.message,
          outbound: buildFeishuHelpMessage(),
          signal,
        });
        return;
      }
      case "connect": {
        await replyNotice({
          db: args.db,
          message: args.message,
          title: "Already connected",
          text: "Your Feishu account is already connected to VM0. Send a task to start working with your agent.",
          kind: "success",
          signal,
        });
        return;
      }
      case "disconnect": {
        await handleDisconnectCommand(args, signal);
        return;
      }
      case "switch": {
        await handleSwitchCommand(args, signal);
        return;
      }
      case "model": {
        await set(handleModelCommand$, args, signal);
        return;
      }
      default: {
        await reply({
          db: args.db,
          message: args.message,
          outbound: buildFeishuHelpMessage(),
          signal,
        });
      }
    }
  },
);

const runFeishuAgent$ = command(
  async (
    { set },
    args: {
      readonly installation: FeishuDispatchInstallation;
      readonly connection: FeishuDispatchConnection;
      readonly message: FeishuInboundMessage;
      readonly agent: FeishuAgent;
      readonly sessionId: string | undefined;
      readonly sessionKey: string;
      readonly history: FeishuPromptContext;
      readonly modelRoute: IntegrationModelRoutePin | undefined;
      readonly reactionId: string | undefined;
    },
    signal: AbortSignal,
  ) => {
    return await set(
      createZeroRun$,
      {
        auth: {
          tokenType: "session",
          userId: args.connection.vm0UserId,
          orgId: args.installation.orgId,
          orgRole: "member",
        },
        body: {
          prompt: args.message.text,
          agentId: args.agent.id,
          sessionId: args.sessionId,
          ...(args.modelRoute
            ? { modelProvider: args.modelRoute.modelProviderType }
            : {}),
        },
        apiStartTime: now(),
        triggerSource: "feishu",
        appendSystemPrompt: buildFeishuSystemPrompt({
          message: args.message,
          history: args.history.text,
        }),
        modelProviderId: args.modelRoute?.modelProviderId ?? undefined,
        modelProviderCredentialScope:
          args.modelRoute?.modelProviderCredentialScope ?? undefined,
        selectedModelOverride: args.modelRoute?.selectedModel ?? undefined,
        dispatchFailedCallbacks: dispatchFailedRunCallbacks,
        callbacks: [
          {
            internalKind: "feishu:org",
            secret: randomBytes(32).toString("hex"),
            payload: feishuOrgCallbackPayloadSchema.parse({
              installationId: args.message.installationId,
              chatId: args.message.chatId,
              messageId: args.message.messageId,
              connectionId: args.connection.id,
              sessionKey: args.sessionKey,
              agentId: args.agent.id,
              existingSessionId: args.sessionId,
              reactionId: args.reactionId,
              replyInThread: args.message.chatType !== "p2p",
              files: [
                ...(args.message.file ? [args.message.file] : []),
                ...args.history.files,
              ].map((file) => {
                return {
                  fileId: file.fileId,
                  messageId: file.messageId,
                  fileKey: file.fileKey,
                  type: file.type,
                };
              }),
            }),
          },
        ],
      },
      signal,
    );
  },
);

async function clearThinkingReaction(args: {
  readonly db: Db;
  readonly message: FeishuInboundMessage;
  readonly reactionId: string | undefined;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.reactionId) {
    return;
  }
  await tapError(
    removeFeishuMessageReaction({
      db: args.db,
      installationId: args.message.installationId,
      messageId: args.message.messageId,
      reactionId: args.reactionId,
      signal: args.signal,
    }),
    (error) => {
      L.warn("Failed to clear Feishu thinking indicator", {
        error,
        messageId: args.message.messageId,
      });
    },
  );
}

export async function addFeishuThinkingReaction(args: {
  readonly db: Db;
  readonly message: FeishuInboundMessage;
  readonly signal: AbortSignal;
}): Promise<string | undefined> {
  const reactionId = await tapError(
    addFeishuMessageReaction({
      db: args.db,
      installationId: args.message.installationId,
      messageId: args.message.messageId,
      emojiType: FEISHU_THINKING_EMOJI,
      signal: args.signal,
    }),
    (error) => {
      L.warn("Failed to set Feishu thinking indicator", {
        error,
        messageId: args.message.messageId,
      });
    },
  );
  args.signal.throwIfAborted();
  return reactionId;
}

const prepareFeishuRun$ = command(
  async (
    { set },
    args: {
      readonly db: Db;
      readonly installation: FeishuDispatchInstallation;
      readonly connection: FeishuDispatchConnection;
      readonly message: FeishuInboundMessage;
      readonly agentId: string;
    },
    signal: AbortSignal,
  ) => {
    const modelRoute = await set(
      resolveIntegrationModelRouteForUser$,
      {
        orgId: args.installation.orgId,
        userId: args.connection.vm0UserId,
      },
      signal,
    );
    const key = sessionKey(args.message);
    const [history, sessionId] = await Promise.all([
      loadFeishuConversationHistory({
        db: args.db,
        message: args.message,
        signal,
      }),
      resolveSession({
        db: args.db,
        connectionId: args.connection.id,
        sessionKey: key,
        userId: args.connection.vm0UserId,
        agentId: args.agentId,
        modelRoute,
      }),
    ]);
    signal.throwIfAborted();
    return { modelRoute, key, history, sessionId };
  },
);

const dispatchConnectedFeishuMessage$ = command(
  async (
    { set },
    args: ConnectedDispatchArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const commandInput = parseFeishuCommand(args.message.text);
    if (commandInput) {
      await set(
        handleConnectedCommand$,
        {
          db: args.db,
          installation: args.installation,
          connection: args.connection,
          message: args.message,
          command: commandInput,
        },
        signal,
      );
      return;
    }

    const effectiveAgent = await resolveEffectiveFeishuAgent({
      db: args.db,
      installation: args.installation,
      connection: args.connection,
    });
    signal.throwIfAborted();
    if (effectiveAgent.status !== "resolved") {
      const text =
        effectiveAgent.status === "not_accessible"
          ? "The configured agent is not available to your Feishu account. Use `/switch` to choose an accessible agent."
          : "The configured Feishu agent could not be found. Ask an admin to select another agent.";
      await replyNotice({
        db: args.db,
        message: args.message,
        title: "Agent unavailable",
        text,
        kind: "error",
        signal,
      });
      return;
    }

    const reactionId = await addFeishuThinkingReaction({
      db: args.db,
      message: args.message,
      signal,
    });
    const clearReaction = async () => {
      await clearThinkingReaction({
        db: args.db,
        message: args.message,
        reactionId,
        signal,
      });
    };
    const prepared = await onRejection(
      set(
        prepareFeishuRun$,
        {
          db: args.db,
          installation: args.installation,
          connection: args.connection,
          message: args.message,
          agentId: effectiveAgent.agent.id,
        },
        signal,
      ),
      clearReaction,
    );
    signal.throwIfAborted();
    const result = await onRejection(
      set(
        runFeishuAgent$,
        {
          installation: args.installation,
          connection: args.connection,
          message: args.message,
          agent: effectiveAgent.agent,
          sessionId: prepared.sessionId,
          sessionKey: prepared.key,
          history: prepared.history,
          modelRoute: prepared.modelRoute,
          reactionId,
        },
        signal,
      ),
      clearReaction,
    );
    signal.throwIfAborted();
    if (result.status !== 201) {
      await clearThinkingReaction({
        db: args.db,
        message: args.message,
        reactionId,
        signal,
      });
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
      await replyNotice({
        db: args.db,
        message: args.message,
        title: "Run failed",
        text: errorText,
        kind: "error",
        signal,
      });
      return;
    }
    if (result.body.status === "queued") {
      const queueUrl = `${env("APP_URL")}/?queue=1`;
      await replyNotice({
        db: args.db,
        message: args.message,
        title: "Run queued",
        text: `Concurrency limit reached. Will start automatically when a slot is available.\n\n[View queue](${queueUrl})`,
        kind: "warning",
        signal,
      });
    }
  },
);

export const dispatchFeishuMessage$ = command(
  async (
    { set },
    message: FeishuInboundMessage,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [installation] = await db
      .select({
        orgId: feishuOrgInstallations.orgId,
        ownerUserId: feishuOrgInstallations.ownerUserId,
        defaultAgentId: feishuOrgInstallations.defaultComposeId,
        messageReceivedAt: feishuOrgInstallations.messageReceivedAt,
      })
      .from(feishuOrgInstallations)
      .where(
        and(
          eq(feishuOrgInstallations.id, message.installationId),
          eq(feishuOrgInstallations.appId, message.appId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!installation) {
      throw new Error("Feishu installation not found");
    }
    await markFeishuMessageReceived({
      db,
      installation,
      message,
      signal,
    });
    const [connection] = await db
      .select({
        id: feishuOrgConnections.id,
        vm0UserId: feishuOrgConnections.vm0UserId,
      })
      .from(feishuOrgConnections)
      .where(
        and(
          eq(feishuOrgConnections.installationId, message.installationId),
          eq(feishuOrgConnections.feishuOpenId, message.openId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();

    if (!connection) {
      const commandInput = parseFeishuCommand(message.text);
      if (commandInput?.name === "help") {
        await reply({
          db,
          message,
          outbound: buildFeishuHelpMessage(),
          signal,
        });
        return;
      }
      if (commandInput?.name === "disconnect") {
        await reply({
          db,
          message,
          outbound: buildFeishuNoticeMessage({
            title: "Not connected",
            text: "You are not connected.",
            kind: "error",
          }),
          signal,
        });
        return;
      }
      const connectUrl = buildFeishuConnectUrl({
        installationId: message.installationId,
        openId: message.openId,
        chatId: message.chatId,
      });
      await reply({
        db,
        message,
        outbound: buildFeishuLoginMessage(connectUrl),
        signal,
      });
      return;
    }

    await set(
      dispatchConnectedFeishuMessage$,
      { db, installation, connection, message },
      signal,
    );
  },
);
