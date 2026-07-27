import { randomBytes } from "node:crypto";

import { command, createStore } from "ccstate";
import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
} from "@vm0/api-contracts/contracts/chat-events";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import { modelProviderCredentialScopeSchema } from "@vm0/api-contracts/contracts/model-providers";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatOutputMaterializations } from "@vm0/db/schema/chat-output-materialization";
import {
  chatMessages,
  type ChatMessageGenerationTemplate,
  type ChatMessageRecommendedFollowups,
  type ChatMessageStructuredPrompt,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  lte,
  max,
  not,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import { waitForRunEventWatermarkVisible } from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { getDatasetName, queryAxiomDirect } from "../external/axiom";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import {
  recordSandboxOperation,
  recordSandboxOperations,
} from "../external/sandbox-op-log";
import {
  BEFORE_DISPATCH_CANCELLED_ERROR,
  isQueueFirstRunClaimLost,
  type DispatchFailedRunCallbacks,
} from "./agent-run-create.service";
import type { InternalRunCallbackEnvelope } from "./internal-run-callback";
import {
  feishuDeliveryTargetSchema,
  type FeishuDeliveryTarget,
} from "./feishu-chat-callback-payload";
import { formatRunErrorForRunOwner$ } from "./run-error-format.service";
import {
  deliverSlackChatAdmissionFailure,
  dispatchSlackChatDeliveryOnce,
} from "./internal-slack-chat-run-callback.service";
import {
  clearCanonicalFeishuThinkingReaction,
  dispatchFeishuChatDeliveryOnce,
} from "./internal-feishu-chat-run-callback.service";
import {
  clearCanonicalSlackThreadStatusIfIdle,
  refreshCanonicalSlackThreadStatus,
  type CanonicalSlackThreadStatusTarget,
} from "./canonical-slack-thread-status.service";
import { saveRunSummary, saveRunSummary$ } from "./run-summary.service";
import {
  insertAssistantEventMessages,
  insertAssistantEventMessages$,
  resolveAttachFileMetadataUrls,
  resolveAttachFileUrls,
  runGroupIdForRun,
  touchChatThreadLastMessageAt,
  visibleChatEventCondition,
} from "./zero-chat-message-shared.service";
import { insertChatEvent } from "./zero-chat-event.service";
import { loadWebChatIncompleteContext } from "./zero-chat-incomplete-context.service";
import { chatThreadAdmissionBlocked } from "./zero-chat-active-run.service";
import { projectStructuredUserMessage } from "./zero-chat-structured-message.service";
import { effectiveChatMessageStructuredPrompt } from "./zero-chat-structured-message-storage.service";
import { appendQueuedRunAssistantMarker } from "./zero-chat-queue-marker.service";
import { recommendedFollowupsMessageIdForRun } from "./assistant-message-id";
import { attachCanonicalPublishedAssetsToCompletionEvent } from "./canonical-published-asset-message.service";
import {
  decryptQueuedUserMessageRunParams,
  failQueuedUserMessage,
  loadNextUnclaimedQueuedUserMessage,
  type QueuedUserMessage,
} from "./zero-chat-queued-message.service";
import { sendUserPushNotifications } from "./zero-push-notifications.service";
import {
  type ChatCompletionContextMessage,
  generateAndPersistChatThreadTitleFromCallback,
  generateChatThreadRecommendedFollowupsFromContext,
  generateChatNotificationSummary,
  loadChatThreadRecommendedFollowupContext,
} from "./zero-chat-title.service";
import { createQueueFirstZeroRun$ } from "./zero-runs-create.service";
import { loadActiveGoalForThread } from "./zero-goal.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import { onRejection, settle, tapError, throwIfAbort } from "../utils";
import { resolveThreadGenerationTemplatePrompt } from "../routes/thread-generation-template";
import { resolveChatThreadSession } from "./chat-session-continuity.service";
import { loadComputerUseHostGrantForAutoSend } from "./zero-chat-computer-use-host.service";
import { resolveRunChatThreadModelContext } from "./zero-chat-run-message.service";
import { releaseThreadBrowsersForRun$ } from "./zero-browser.service";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import {
  chatEventTypeIn,
  chatEventTypeSql,
} from "./zero-chat-event-type.service";

const log = logger("callback:chat");
const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const RECENT_CHAT_RUN_LIMIT = 10;
const PRIOR_MESSAGE_CHAR_CAP = 4000;
type ChatCallbackPreCreateTimingSpanKind = "top_level" | "nested";

type ChatCallbackPreCreateTimingActionType =
  | "api_dispatch_pre_create_zero_chat_callback_load_terminal"
  | "api_dispatch_pre_create_zero_chat_callback_prepare_completed"
  | "api_dispatch_pre_create_zero_chat_callback_prepare_failed"
  | "api_dispatch_pre_create_zero_chat_callback_load_db_output_state"
  | "api_dispatch_pre_create_zero_chat_callback_db_output_complete"
  | "api_dispatch_pre_create_zero_chat_callback_db_output_incomplete"
  | "api_dispatch_pre_create_zero_chat_callback_query_output_events"
  | "api_dispatch_pre_create_zero_chat_callback_insert_assistant_items"
  | "api_dispatch_pre_create_zero_chat_callback_lookup_existing_assistant"
  | "api_dispatch_pre_create_zero_chat_callback_insert_lifecycle_marker"
  | "api_dispatch_pre_create_zero_chat_callback_load_followup_context"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_load_thread"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_lookup_queued_message"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_load_agent"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_build_input"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_model_pin"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_load_session_state"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_build_prior_context"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_computer_use_host"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_generation_template"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_build_prompt"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_attachments"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_check_active_run"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_create_run"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_append_marker"
  | "api_dispatch_pre_create_zero_chat_callback_auto_send_publish_signals";

interface ChatCallbackPreCreateTimingRecord {
  readonly actionType: ChatCallbackPreCreateTimingActionType;
  readonly spanKind: ChatCallbackPreCreateTimingSpanKind;
  readonly durationMs: number;
  readonly timestamp: string;
}

export class ChatCallbackPreCreateTimingCollector {
  private readonly records: ChatCallbackPreCreateTimingRecord[] = [];
  private flushed = false;

  recordElapsed(args: {
    readonly actionType: ChatCallbackPreCreateTimingActionType;
    readonly spanKind: ChatCallbackPreCreateTimingSpanKind;
    readonly startedAt: number;
    readonly finishedAt?: number;
  }): void {
    if (this.flushed) {
      return;
    }
    const finishedAt = args.finishedAt ?? now();
    this.records.push({
      actionType: args.actionType,
      spanKind: args.spanKind,
      durationMs: Math.max(0, finishedAt - args.startedAt),
      timestamp: new Date(finishedAt).toISOString(),
    });
  }

  async measure<T>(
    actionType: ChatCallbackPreCreateTimingActionType,
    spanKind: ChatCallbackPreCreateTimingSpanKind,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const startedAt = now();
    const result = await onRejection(
      (async () => {
        return await operation();
      })(),
      () => {
        this.recordElapsed({ actionType, spanKind, startedAt });
      },
    );
    this.recordElapsed({ actionType, spanKind, startedAt });
    return result;
  }

  flush(
    runId: string,
    triggerSource: "web" | "slack" | "feishu" = "web",
  ): void {
    if (this.flushed) {
      return;
    }
    this.flushed = true;
    const records = this.records.splice(0);
    recordSandboxOperations(
      records.map((record) => {
        return {
          sandboxType: "runner",
          actionType: record.actionType,
          durationMs: record.durationMs,
          success: true,
          runId,
          timestamp: record.timestamp,
          dimensions: {
            span_kind: record.spanKind,
            trigger_source: triggerSource,
            zero_run_origin: "zero_run",
            zero_pre_create_source: "chat_callback_auto_send",
          },
        };
      }),
    );
  }
}

function flushChatCallbackTimingOnRejection(args: {
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly getRunId: () => string | null;
  readonly triggerSource: "web" | "slack" | "feishu";
}): (error: unknown) => void {
  return () => {
    const runId = args.getRunId();
    if (runId !== null) {
      args.timing.flush(runId, args.triggerSource);
    }
  };
}

async function measureChatCallbackPreCreateTiming<T>(
  timing: ChatCallbackPreCreateTimingCollector | undefined,
  actionType: ChatCallbackPreCreateTimingActionType,
  spanKind: ChatCallbackPreCreateTimingSpanKind,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!timing) {
    return await operation();
  }
  return await timing.measure(actionType, spanKind, operation);
}

function errorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }
  return typeof value.code === "string" ? value.code : undefined;
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    errorCode(error) === PG_FOREIGN_KEY_VIOLATION ||
    (error instanceof Error &&
      errorCode(error.cause) === PG_FOREIGN_KEY_VIOLATION)
  );
}

const chatCallbackPayloadSchema = z
  .object({
    threadId: z.string(),
    agentId: z.string(),
    slackDelivery: z
      .object({
        channelId: z.string(),
        threadTs: z.string(),
      })
      .optional(),
    feishuDelivery: feishuDeliveryTargetSchema.optional(),
    // Set for goal-triggered runs so terminal push notifications can be gated:
    // an active goal loops on every idle, so interim per-iteration pushes are
    // suppressed and only terminal states (complete/blocked/auto-stopped) notify.
    isGoalRun: z.boolean().optional(),
  })
  .passthrough();

type ChatCallbackPayload = z.infer<typeof chatCallbackPayloadSchema>;

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
}

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
}

interface AxiomChatOutputEvent {
  readonly eventType?: string;
  readonly sequenceNumber?: number;
  readonly eventData?: {
    readonly message?: { readonly content?: readonly ContentBlock[] };
    readonly item?: CodexItem;
    readonly result?: string;
    readonly sequenceNumber?: number;
  };
}

interface AssistantEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

function terminalCallbackErrorMessage(
  callbackError: string | null | undefined,
  runError: string | null | undefined,
): string {
  if (callbackError !== null && callbackError !== undefined) {
    return callbackError;
  }
  if (runError !== null && runError !== undefined) {
    return runError;
  }
  return "Run failed";
}

interface ResultEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

type DbCompletedChatOutputState =
  | {
      readonly kind: "complete";
      readonly latestAssistantContent: string | null;
      readonly hasResultFallbackCandidate: boolean;
    }
  | { readonly kind: "incomplete" };

interface CompletedChatOutputLoad {
  readonly assistantItems: readonly AssistantEventItem[];
  readonly resultFallback: ResultEventItem | null;
  readonly lastResultText: string | null;
  readonly skipExistingAssistantLookup: boolean;
}

interface PriorRunMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly structuredPrompt: ChatMessageStructuredPrompt | null;
  readonly attachFiles: readonly string[] | null;
  readonly generationTemplate: ChatMessageGenerationTemplate | null;
}

interface PriorRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly messages: readonly PriorRunMessage[];
}

interface AgentForAutoSend {
  readonly id: string;
  readonly orgId: string;
}

interface ResolvedAttachFile {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
}

type ResolveAttachFiles = (
  userId: string,
  fileIds: readonly string[],
) => Promise<readonly ResolvedAttachFile[]>;

type CreatedQueuedRun = {
  readonly runId: string;
  readonly status: "queued" | "pending" | "running";
  readonly claimedMessageCreatedAt: Date;
};

type CreateQueuedRun = (
  input: CreateQueuedChatRunInput,
  apiStartTime: number,
  signal: AbortSignal,
) => Promise<CreatedQueuedRun | null>;

interface ChatCallbackDependencies {
  readonly releaseBrowsersForRun: (
    args: { readonly chatThreadId: string },
    signal: AbortSignal,
  ) => Promise<{ readonly released: number }>;
  readonly insertAssistantItems: (
    args: {
      readonly runId: string;
      readonly threadId: string;
      readonly userId: string;
      readonly items: readonly AssistantEventItem[];
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly saveRunSummary: (
    runId: string,
    prompt: string,
    resultText: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly formatRunError: (
    args: {
      readonly chatThreadId: string;
      readonly runId: string;
      readonly errorMessage: string;
    },
    signal: AbortSignal,
  ) => Promise<string>;
  readonly getResolvedAttachFiles: ResolveAttachFiles;
  readonly dispatchSlackDelivery: (
    callbackId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly clearSlackThreadStatusIfIdle: (
    target: CanonicalSlackThreadStatusTarget,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly refreshSlackThreadStatus: (
    target: CanonicalSlackThreadStatusTarget,
    signal: AbortSignal,
  ) => Promise<boolean>;
  readonly formatIntegrationRunError: (
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly code: string;
      readonly message: string;
    },
    signal: AbortSignal,
  ) => Promise<string>;
  readonly deliverSlackAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly channelId: string;
      readonly threadTs: string;
      readonly chatMessageId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchFeishuDelivery: (
    callbackId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly clearFeishuThinkingReaction: (
    target: FeishuDeliveryTarget,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly createQueuedRun?: CreateQueuedRun;
  readonly drainThreadQueue?: (
    chatThreadId: string,
    signal: AbortSignal,
    timing?: ChatCallbackPreCreateTimingCollector,
  ) => Promise<void>;
}

interface ChatThreadForRunRow {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly orgId: string;
}

interface ChatRunInfo {
  readonly prompt: string;
  readonly error: string | null;
  readonly lastEventSequence: number | null;
}

interface CreateQueuedChatRunInput {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly cliAgentType: string | null;
  readonly codexServiceTier: "fast" | undefined;
  readonly computerUseHostGrant: {
    readonly hostId: string;
    readonly displayName: string;
  } | null;
  readonly triggerSource: "web" | "slack" | "feishu";
  readonly realAgentInPreview?: boolean;
  readonly slackDelivery?: {
    readonly channelId: string;
    readonly threadTs: string;
  };
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly apiStartTime?: number;
  readonly userInfoExtras?: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
    readonly feishuDisplayName?: string;
    readonly feishuOpenId?: string;
  };
}

interface SlackQueuedMessageAdmissionFailure {
  readonly kind: "slack_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly slackDelivery: {
    readonly channelId: string;
    readonly threadTs: string;
  };
  readonly error: QueuedMessageModelRouteError;
}

type CompletedChatCallbackResult =
  | {
      readonly inserted: true;
      readonly lastResultText: string | null;
      readonly followupContext: readonly ChatCompletionContextMessage[];
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
    }
  | { readonly inserted: false };

type FailedChatCallbackResult =
  | {
      readonly inserted: true;
      readonly displayErrorMessage: string;
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
    }
  | { readonly inserted: false };

interface TerminalChatCallbackWork {
  readonly shouldDrainThreadQueue: boolean;
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly deferredSideEffects?: () => Promise<void>;
}

type DrainOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: unknown };

function isCreatedQueuedRunStatus(
  status: string,
): status is CreatedQueuedRun["status"] {
  return status === "queued" || status === "pending" || status === "running";
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function buildQueuedCreateZeroRunArgs(
  input: CreateQueuedChatRunInput,
  apiStartTime: number,
  dispatchFailedCallbacks?: DispatchFailedRunCallbacks,
) {
  return {
    auth: {
      tokenType: "session" as const,
      userId: input.userId,
      orgId: input.orgId,
      orgRole: "member" as const,
    },
    apiStartTime,
    chatThreadId: input.threadId,
    computerUseHostId: input.computerUseHostGrant?.hostId,
    modelProviderId: input.modelPin.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      input.modelPin.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: input.modelPin.selectedModel ?? undefined,
    codexServiceTier: input.codexServiceTier,
    callbacks: [
      {
        internalKind: "chat" as const,
        secret: generateCallbackSecret(),
        payload: {
          threadId: input.threadId,
          agentId: input.agentId,
          queuedMessageId: input.queuedMessage.id,
          slackDelivery: input.slackDelivery,
          feishuDelivery: input.feishuDelivery,
        },
      },
      ...(input.feishuDelivery
        ? [
            {
              internalKind: "feishu:org" as const,
              secret: generateCallbackSecret(),
              payload: {
                installationId: input.feishuDelivery.installationId,
                chatId: input.feishuDelivery.chatId,
                messageId: input.feishuDelivery.messageId,
                connectionId: input.feishuDelivery.connectionId,
                sessionKey: input.feishuDelivery.threadId,
                agentId: input.agentId,
                reactionId: input.feishuDelivery.reactionId,
                replyInThread: input.feishuDelivery.replyInThread,
                files: input.feishuDelivery.files,
                canonicalChatDelivery: true,
              },
            },
          ]
        : []),
    ],
    triggerSource: input.triggerSource,
    zeroPreCreateSource: "chat_callback_auto_send" as const,
    appendSystemPrompt: input.appendSystemPrompt,
    userInfoExtras: input.userInfoExtras,
    dispatchFailedCallbacks,
    queueFirstAssociation: {
      kind: "user_message" as const,
      threadId: input.threadId,
      messageId: input.queuedMessage.id,
    },
    zeroRunModelPin: {
      modelProvider: input.effectiveModelProvider ?? null,
      modelProviderId: input.modelPin.modelProviderId,
      modelProviderCredentialScope: input.modelPin.modelProviderCredentialScope,
      selectedModel: input.modelPin.selectedModel,
    },
    threadSessionRoute: {
      selectedModel: input.modelPin.selectedModel,
      modelProvider: input.effectiveModelProvider ?? null,
      cliAgentType: input.cliAgentType,
    },
    body: {
      prompt: input.prompt,
      agentId: input.agentId,
      ...(input.effectiveModelProvider
        ? { modelProvider: input.effectiveModelProvider }
        : {}),
      ...(input.realAgentInPreview ? { realAgentInPreview: true } : {}),
    },
  };
}

function extractAnthropicContent(
  blocks: readonly ContentBlock[],
): string | null {
  const parts = blocks.flatMap((block) => {
    return block.type === "text" &&
      typeof block.text === "string" &&
      block.text.trim().length > 0
      ? [block.text]
      : [];
  });
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function extractCodexAgentMessageContent(item: CodexItem): string | null {
  if (
    item.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.trim().length === 0
  ) {
    return null;
  }
  return item.text;
}

function extractAssistantContent(event: AxiomChatOutputEvent): string | null {
  const content =
    event.eventType === "assistant" ? event.eventData?.message?.content : null;
  if (content) {
    return extractAnthropicContent(content);
  }
  const item =
    event.eventType === "item.completed" ? event.eventData?.item : null;
  if (item) {
    return extractCodexAgentMessageContent(item);
  }
  return null;
}

function extractResultFallback(
  sequenceNumber: number,
  event: AxiomChatOutputEvent,
): ResultEventItem | null {
  if (event.eventType !== "result") {
    return null;
  }

  const result = event.eventData?.result;
  if (typeof result !== "string") {
    return null;
  }
  if (!result.trim()) {
    return null;
  }
  return { sequenceNumber, content: result };
}

async function queryChatOutputEvents(args: {
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<{
  readonly assistantItems: readonly AssistantEventItem[];
  readonly resultFallback: ResultEventItem | null;
}> {
  await waitForRunEventWatermarkVisible(args.runId, args.lastEventSequence);
  args.signal.throwIfAborted();

  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const sequenceCap =
    args.lastEventSequence === null
      ? ""
      : `\n| where sequenceNumber <= ${args.lastEventSequence}`;
  const apl = `['${dataset}']
| where runId == "${escapeAplString(args.runId)}"
| where eventType == "assistant" or eventType == "result" or eventType == "item.completed"
${sequenceCap}
| order by sequenceNumber asc
| limit 200`;

  const events = await queryAxiomDirect<AxiomChatOutputEvent>(apl, {
    noCache: true,
  });
  args.signal.throwIfAborted();

  const assistantItems: AssistantEventItem[] = [];
  let resultFallback: ResultEventItem | null = null;
  for (const event of events) {
    const sequenceNumber =
      event.sequenceNumber ?? event.eventData?.sequenceNumber;
    if (typeof sequenceNumber !== "number") {
      continue;
    }
    if (
      args.lastEventSequence !== null &&
      sequenceNumber > args.lastEventSequence
    ) {
      continue;
    }

    const assistant = extractAssistantContent(event);
    if (assistant !== null) {
      assistantItems.push({ sequenceNumber, content: assistant });
      continue;
    }

    const fallback = extractResultFallback(sequenceNumber, event);
    if (fallback !== null) {
      resultFallback = fallback;
    }
  }

  return { assistantItems, resultFallback };
}

async function latestEventBackedAssistantMessage(
  db: Db,
  runId: string,
  options: { readonly maxSequenceNumber?: number } = {},
): Promise<AssistantEventItem | null> {
  const [message] = await db
    .select({
      content: chatMessages.content,
      sequenceNumber: chatMessages.sequenceNumber,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(chatMessages.sequenceNumber),
        isNotNull(chatMessages.content),
        not(sql`${chatMessages.content} ~ '^[[:space:]]*$'`),
        ...(options.maxSequenceNumber === undefined
          ? []
          : [lte(chatMessages.sequenceNumber, options.maxSequenceNumber)]),
      ),
    )
    .orderBy(desc(chatMessages.sequenceNumber))
    .limit(1);

  if (!message || message.content === null || message.sequenceNumber === null) {
    return null;
  }
  return {
    content: message.content,
    sequenceNumber: message.sequenceNumber,
  };
}

async function loadDbCompletedChatOutputState(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
}): Promise<DbCompletedChatOutputState> {
  if (args.lastEventSequence === null) {
    return { kind: "incomplete" };
  }

  const [state] = await args.db
    .select({
      processedThroughSequence:
        chatOutputMaterializations.processedThroughSequence,
      latestResultSequence: chatOutputMaterializations.latestResultSequence,
    })
    .from(chatOutputMaterializations)
    .where(eq(chatOutputMaterializations.runId, args.runId))
    .limit(1);

  if (!state || state.processedThroughSequence < args.lastEventSequence) {
    return { kind: "incomplete" };
  }

  const latestAssistant = await latestEventBackedAssistantMessage(
    args.db,
    args.runId,
    { maxSequenceNumber: args.lastEventSequence },
  );
  return {
    kind: "complete",
    latestAssistantContent: latestAssistant?.content ?? null,
    hasResultFallbackCandidate:
      state.latestResultSequence !== null &&
      state.latestResultSequence <= args.lastEventSequence,
  };
}

async function recordDbOutputStateTiming(
  timing: ChatCallbackPreCreateTimingCollector,
  state: DbCompletedChatOutputState,
): Promise<void> {
  await measureChatCallbackPreCreateTiming(
    timing,
    state.kind === "complete"
      ? "api_dispatch_pre_create_zero_chat_callback_db_output_complete"
      : "api_dispatch_pre_create_zero_chat_callback_db_output_incomplete",
    "nested",
    () => {},
  );
}

async function loadCompletedChatOutput(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly preferResultFallback: boolean;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
}): Promise<CompletedChatOutputLoad> {
  const dbOutputState = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_load_db_output_state",
    "nested",
    () => {
      return loadDbCompletedChatOutputState({
        db: args.db,
        runId: args.runId,
        lastEventSequence: args.lastEventSequence,
      });
    },
  );
  args.signal.throwIfAborted();

  await recordDbOutputStateTiming(args.timing, dbOutputState);
  args.signal.throwIfAborted();

  if (
    dbOutputState.kind === "complete" &&
    (!dbOutputState.hasResultFallbackCandidate ||
      (dbOutputState.latestAssistantContent !== null &&
        !args.preferResultFallback))
  ) {
    return {
      assistantItems: [],
      resultFallback: null,
      lastResultText: dbOutputState.latestAssistantContent,
      skipExistingAssistantLookup: true,
    };
  }

  const axiomOutput = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_query_output_events",
    "nested",
    () => {
      return queryChatOutputEvents({
        runId: args.runId,
        lastEventSequence: args.lastEventSequence,
        signal: args.signal,
      });
    },
  );

  return {
    assistantItems: axiomOutput.assistantItems,
    resultFallback: axiomOutput.resultFallback,
    lastResultText: null,
    skipExistingAssistantLookup: false,
  };
}

async function recordLastEventToComplete(db: Db, runId: string): Promise<void> {
  const [run] = await db
    .select({ completedAt: agentRuns.completedAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run?.completedAt) {
    return;
  }

  const [message] = await db
    .select({
      lastEventAt: max(chatMessages.createdAt).mapWith(
        nullableDriverValueDecoder(chatMessages.createdAt),
      ),
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(chatMessages.sequenceNumber),
      ),
    );
  if (!message?.lastEventAt) {
    return;
  }

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "last_event_to_complete",
    durationMs: Math.max(
      0,
      run.completedAt.getTime() - message.lastEventAt.getTime(),
    ),
    success: true,
    runId,
  });
}

interface SlackDeliveryTarget {
  readonly channelId: string;
  readonly threadTs: string;
}

async function insertSlackChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: SlackDeliveryTarget;
  readonly chatMessageId: string;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical Slack run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "slack:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        channelId: args.target.channelId,
        threadTs: args.target.threadTs,
        chatMessageId: args.chatMessageId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Slack delivery callback");
  }
  return callback.id;
}

async function insertFeishuChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: FeishuDeliveryTarget;
  readonly chatMessageId: string;
}): Promise<string> {
  const callbackCondition = args.sourceCallbackId
    ? and(
        eq(agentRunCallbacks.id, args.sourceCallbackId),
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      )
    : and(
        eq(agentRunCallbacks.runId, args.runId),
        eq(agentRunCallbacks.internalKind, "chat"),
      );
  const [sourceCallback] = await args.db
    .select({ encryptedSecret: agentRunCallbacks.encryptedSecret })
    .from(agentRunCallbacks)
    .where(callbackCondition)
    .limit(1);
  if (!sourceCallback) {
    throw new Error("Canonical Feishu run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "feishu:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatMessageId: args.chatMessageId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Feishu delivery callback");
  }
  return callback.id;
}

async function insertAssistantErrorMessage(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly lifecycleEvent: "failed" | "cancelled";
  readonly getFormattedError: () => Promise<string>;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<FailedChatCallbackResult> {
  const displayErrorMessage = await args.getFormattedError();
  const runGroupId = await runGroupIdForRun(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    const message = await insertChatEvent(
      tx,
      {
        chatThreadId: args.threadId,
        eventType:
          args.lifecycleEvent === "failed" ? "run.failed" : "run.cancelled",
        content: displayErrorMessage,
        runId: args.runId,
        runGroupId,
        error: displayErrorMessage,
      },
      "run-lifecycle",
    );
    if (!message) {
      return null;
    }
    const slackDeliveryCallbackId = args.slackDelivery
      ? await insertSlackChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.slackDelivery,
          chatMessageId: message.id,
        })
      : undefined;
    const feishuDeliveryCallbackId = args.feishuDelivery
      ? await insertFeishuChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.feishuDelivery,
          chatMessageId: message.id,
        })
      : undefined;
    await touchChatThreadLastMessageAt(tx, args.threadId, message.createdAt);
    return { slackDeliveryCallbackId, feishuDeliveryCallbackId };
  });
  if (!inserted) {
    return { inserted: false };
  }

  await publishUserSignal(
    [args.userId],
    `chatThreadMessageCreated:${args.threadId}`,
  );
  await publishThreadListChanged(args.userId);
  return {
    displayErrorMessage,
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
  };
}

async function insertRunLifecycleMarker(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly event: "completed" | "cancelled";
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<
  | { readonly inserted: false }
  | {
      readonly inserted: true;
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
    }
> {
  const markerCreatedAt = nowDate();
  const runGroupId = await runGroupIdForRun(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    const marker = await insertChatEvent(
      tx,
      {
        chatThreadId: args.threadId,
        eventType:
          args.event === "completed" ? "run.completed" : "run.cancelled",
        content: null,
        runId: args.runId,
        runGroupId,
        createdAt: markerCreatedAt,
      },
      "run-lifecycle",
    );
    if (!marker) {
      return null;
    }
    if (args.event === "completed") {
      await attachCanonicalPublishedAssetsToCompletionEvent(tx, {
        runId: args.runId,
        threadId: args.threadId,
        completedEventId: marker.id,
      });
    }
    const [deliveryMessage] =
      args.slackDelivery || args.feishuDelivery
        ? await tx
            .select({ id: chatMessages.id })
            .from(chatMessages)
            .where(
              and(
                eq(chatMessages.runId, args.runId),
                chatEventTypeIn(["output.message"]),
                isNotNull(chatMessages.content),
                isNotNull(chatMessages.sequenceNumber),
              ),
            )
            .orderBy(desc(chatMessages.sequenceNumber))
            .limit(1)
        : [];
    const slackDeliveryCallbackId =
      deliveryMessage && args.slackDelivery
        ? await insertSlackChatDeliveryCallback({
            db: tx,
            runId: args.runId,
            sourceCallbackId: args.sourceCallbackId,
            target: args.slackDelivery,
            chatMessageId: deliveryMessage.id,
          })
        : undefined;
    const feishuDeliveryCallbackId =
      deliveryMessage && args.feishuDelivery
        ? await insertFeishuChatDeliveryCallback({
            db: tx,
            runId: args.runId,
            sourceCallbackId: args.sourceCallbackId,
            target: args.feishuDelivery,
            chatMessageId: deliveryMessage.id,
          })
        : undefined;
    await touchChatThreadLastMessageAt(tx, args.threadId, markerCreatedAt);
    return { slackDeliveryCallbackId, feishuDeliveryCallbackId };
  });
  if (!inserted) {
    return { inserted: false };
  }
  await publishUserSignal(
    [args.userId],
    `chatThreadMessageCreated:${args.threadId}`,
  );
  await publishThreadListChanged(args.userId);
  return {
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
  };
}

async function insertRecommendedFollowupsMessage(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly recommendedFollowups: ChatMessageRecommendedFollowups;
}): Promise<boolean> {
  const runGroupId = await runGroupIdForRun(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    return await insertChatEvent(
      tx,
      {
        id: recommendedFollowupsMessageIdForRun(args.runId),
        chatThreadId: args.threadId,
        eventType: "output.followups",
        content: null,
        runId: args.runId,
        runGroupId,
        recommendedFollowups: args.recommendedFollowups,
      },
      "id",
    );
  });

  if (!inserted) {
    return false;
  }

  await publishChatThreadMessageCreatedSafely(
    args.userId,
    args.threadId,
    inserted.seqId,
  );
  return true;
}

async function generateRecommendedFollowupsForCompletedRun(args: {
  readonly followupContext: readonly ChatCompletionContextMessage[];
  readonly threadId: string;
  readonly signal: AbortSignal;
}): Promise<ChatMessageRecommendedFollowups | undefined> {
  args.signal.throwIfAborted();
  const suggestions = await generateChatThreadRecommendedFollowupsFromContext({
    messages: args.followupContext,
    threadId: args.threadId,
  });
  args.signal.throwIfAborted();
  return suggestions.length > 0 ? suggestions : undefined;
}

async function loadRecommendedFollowupContextForCompletedRun(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly structuredPromptEnabled: boolean;
  readonly signal: AbortSignal;
}): Promise<readonly ChatCompletionContextMessage[]> {
  return (
    (await tapError(
      loadChatThreadRecommendedFollowupContext({
        db: args.db,
        threadId: args.threadId,
        structuredPromptEnabled: args.structuredPromptEnabled,
      }),
      (err) => {
        log.warn("Recommended follow-up context load failed", {
          threadId: args.threadId,
          err,
        });
      },
    )) ?? []
  );
}

async function materializeCompletedChatResult(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly output: CompletedChatOutputLoad;
  readonly preferResultFallback: boolean;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly insertAssistantItems: (
    items: readonly AssistantEventItem[],
  ) => Promise<void>;
}): Promise<string | null> {
  const { assistantItems, resultFallback } = args.output;
  if (assistantItems.length > 0) {
    await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_zero_chat_callback_insert_assistant_items",
      "nested",
      () => {
        return args.insertAssistantItems(assistantItems);
      },
    );
    args.signal.throwIfAborted();
  }

  let lastResultText =
    args.output.lastResultText ??
    (assistantItems.length > 0
      ? assistantItems[assistantItems.length - 1]!.content
      : null);
  let latestAssistantSequence =
    assistantItems.length > 0
      ? assistantItems[assistantItems.length - 1]!.sequenceNumber
      : null;
  if (lastResultText === null && !args.output.skipExistingAssistantLookup) {
    const existingAssistant = await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_zero_chat_callback_lookup_existing_assistant",
      "nested",
      () => {
        return latestEventBackedAssistantMessage(args.db, args.runId, {
          maxSequenceNumber: args.lastEventSequence ?? undefined,
        });
      },
    );
    args.signal.throwIfAborted();
    if (existingAssistant) {
      lastResultText = existingAssistant.content;
      latestAssistantSequence = existingAssistant.sequenceNumber;
    }
  }

  const shouldInsertResultFallback =
    resultFallback !== null &&
    (lastResultText === null ||
      (args.preferResultFallback &&
        resultFallback.sequenceNumber >
          (latestAssistantSequence ?? Number.NEGATIVE_INFINITY) &&
        resultFallback.content !== lastResultText));
  if (shouldInsertResultFallback) {
    await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_zero_chat_callback_insert_assistant_items",
      "nested",
      () => {
        return args.insertAssistantItems([resultFallback]);
      },
    );
    args.signal.throwIfAborted();
    lastResultText = resultFallback.content;
  }
  return lastResultText;
}

async function handleCompletedChatCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly structuredPromptEnabled: boolean;
  readonly signal: AbortSignal;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly sourceCallbackId?: string;
  readonly insertAssistantItems: (
    items: readonly AssistantEventItem[],
  ) => Promise<void>;
}): Promise<CompletedChatCallbackResult> {
  const output = await loadCompletedChatOutput({
    db: args.db,
    runId: args.runId,
    lastEventSequence: args.run.lastEventSequence,
    preferResultFallback: args.slackDelivery !== undefined,
    timing: args.timing,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const lastResultText = await materializeCompletedChatResult({
    db: args.db,
    runId: args.runId,
    lastEventSequence: args.run.lastEventSequence,
    output,
    preferResultFallback: args.slackDelivery !== undefined,
    timing: args.timing,
    signal: args.signal,
    insertAssistantItems: args.insertAssistantItems,
  });
  args.signal.throwIfAborted();

  waitUntil(
    tapError(recordLastEventToComplete(args.db, args.runId), (error) => {
      log.warn("Failed to record last_event_to_complete", {
        runId: args.runId,
        error,
      });
    }),
  );

  const inserted = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_insert_lifecycle_marker",
    "nested",
    () => {
      return insertRunLifecycleMarker({
        db: args.db,
        runId: args.runId,
        threadId: args.chatThread.chatThreadId,
        userId: args.chatThread.userId,
        event: "completed",
        slackDelivery: args.slackDelivery,
        feishuDelivery: args.feishuDelivery,
        sourceCallbackId: args.sourceCallbackId,
      });
    },
  );
  args.signal.throwIfAborted();
  if (!inserted.inserted) {
    return { inserted: false };
  }

  const followupContext = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_load_followup_context",
    "nested",
    () => {
      return loadRecommendedFollowupContextForCompletedRun({
        db: args.db,
        threadId: args.chatThread.chatThreadId,
        structuredPromptEnabled: args.structuredPromptEnabled,
        signal: args.signal,
      });
    },
  );
  args.signal.throwIfAborted();

  return {
    lastResultText,
    followupContext,
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
  };
}

async function runCompletedChatCallbackSideEffects(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly isGoalRun: boolean;
  readonly lastResultText: string | null;
  readonly followupContext: readonly ChatCompletionContextMessage[];
  readonly structuredPromptEnabled: boolean;
  readonly signal: AbortSignal;
  readonly saveRunSummary: (resultText: string) => Promise<void>;
}): Promise<void> {
  // The post-processing steps are mutually independent. Run them after queued
  // auto-send so LLM/push latency does not delay the next run.
  const saveSummaryStep = args.saveRunSummary(args.lastResultText ?? "");

  const titleStep = generateAndPersistChatThreadTitleFromCallback({
    db: args.db,
    threadId: args.chatThread.chatThreadId,
    userId: args.chatThread.userId,
    orgId: args.chatThread.orgId,
    runId: args.runId,
    prompt: args.run.prompt,
    currentAssistantReply: args.lastResultText ?? undefined,
    structuredPromptEnabled: args.structuredPromptEnabled,
  });

  const followupsStep = (async () => {
    const recommendedFollowups =
      await generateRecommendedFollowupsForCompletedRun({
        followupContext: args.followupContext,
        threadId: args.chatThread.chatThreadId,
        signal: args.signal,
      });
    if (recommendedFollowups) {
      await insertRecommendedFollowupsMessage({
        db: args.db,
        runId: args.runId,
        threadId: args.chatThread.chatThreadId,
        userId: args.chatThread.userId,
        recommendedFollowups,
      });
    }
  })();

  const pushStep = (async () => {
    // A goal-triggered run that completes while the goal is still active is just
    // one iteration of a self-continuing loop, so suppress its push. If the run
    // completed or blocked the goal, it no longer loads as active and falls
    // through to notify.
    if (args.isGoalRun) {
      const goal = await loadActiveGoalForThread(args.db, {
        orgId: args.chatThread.orgId,
        threadId: args.chatThread.chatThreadId,
      });
      if (goal !== null) {
        return;
      }
    }

    let summary: string | null = null;
    if (args.lastResultText) {
      summary =
        (await tapError(
          generateChatNotificationSummary(args.run.prompt, args.lastResultText),
          (error) => {
            log.warn("Failed to generate notification summary", {
              runId: args.runId,
              error,
            });
          },
        )) ?? null;
    }

    await sendUserPushNotifications({
      db: args.db,
      userId: args.chatThread.userId,
      notification: {
        title: args.run.prompt.slice(0, 60),
        body: summary ?? "Your task is complete",
        url: `/chats/${args.chatThread.chatThreadId}`,
      },
    });
  })();

  const results = await Promise.allSettled([
    saveSummaryStep,
    titleStep,
    followupsStep,
    pushStep,
  ]);
  const errors = results.flatMap((result) => {
    if (result.status === "fulfilled") {
      return [];
    }
    throwIfAbort(result.reason);
    return [result.reason];
  });
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Completed chat callback side effects failed",
    );
  }
}

async function handleFailedChatCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly chatThread: ChatThreadForRunRow;
  readonly errorMessage: string;
  readonly getFormattedError: () => Promise<string>;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<FailedChatCallbackResult> {
  const lifecycleEvent =
    args.errorMessage.trim().toLowerCase() === "run cancelled"
      ? "cancelled"
      : "failed";
  return await insertAssistantErrorMessage({
    db: args.db,
    runId: args.runId,
    threadId: args.chatThread.chatThreadId,
    userId: args.chatThread.userId,
    lifecycleEvent,
    getFormattedError: args.getFormattedError,
    slackDelivery: args.slackDelivery,
    feishuDelivery: args.feishuDelivery,
    sourceCallbackId: args.sourceCallbackId,
  });
}

async function runFailedChatCallbackSideEffects(args: {
  readonly db: Db;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly displayErrorMessage: string;
}): Promise<void> {
  await sendUserPushNotifications({
    db: args.db,
    userId: args.chatThread.userId,
    notification: {
      title: args.run.prompt.slice(0, 60),
      body: `Task failed: ${args.displayErrorMessage.slice(0, 80)}`,
      url: `/chats/${args.chatThread.chatThreadId}`,
    },
  });
}

async function runTerminalChatCallbackSideEffects(args: {
  readonly runId: string;
  readonly status: "completed" | "failed";
  readonly run: () => Promise<void>;
}): Promise<void> {
  await tapError(args.run(), (error) => {
    log.warn("Failed to process terminal chat callback side effects", {
      runId: args.runId,
      status: args.status,
      error,
    });
  });
}

function buildWebChatPrompt(): string {
  return [
    "# Current Integration\nYou are currently running inside: Web",
    "You are communicating with the user through the web chat UI.",
  ].join("\n\n");
}

function buildWebAttachFilesPrompt(
  files: readonly {
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
  }[],
): string {
  return files
    .map((file) => {
      return `[Web file] ${file.filename} (${file.contentType})\n   [ID] ${file.id}`;
    })
    .join("\n");
}

function buildAppendSystemPrompt(
  integrationPrompt: string,
  incompleteContext: string,
  priorContext: string,
  generationTemplatePrompt: string,
  computerUseHostDisplayName: string | null,
): string {
  return [
    integrationPrompt,
    priorContext,
    incompleteContext,
    generationTemplatePrompt,
    computerUseHostDisplayName
      ? buildComputerUseSystemPrompt(computerUseHostDisplayName)
      : "",
  ]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

function buildComputerUseSystemPrompt(displayName: string): string {
  return [
    "# Computer Use",
    `Computer Use is enabled for this run on ${displayName}.`,
    "Use Zero CLI computer-use commands to inspect apps, read app state, and perform desktop actions.",
    "The computer may go offline while this run is active. If a command reports that the computer is unavailable or offline, ask the user to reconnect Zero Computer Use on that computer, then retry.",
  ].join("\n");
}

function formatAttachFileIds(
  ids: readonly string[] | null | undefined,
): string {
  if (!ids || ids.length === 0) {
    return "";
  }
  return ids
    .map((id) => {
      return `[Web file]\n   [ID] ${id}`;
    })
    .join("\n");
}

function truncatePrior(value: string): string {
  if (value.length <= PRIOR_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, PRIOR_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function formatPriorRunMessage(
  message: PriorRunMessage,
  structuredPromptEnabled: boolean,
): string {
  const roleLabel = message.role === "user" ? "User" : "Assistant";
  if (
    structuredPromptEnabled &&
    message.role === "user" &&
    message.structuredPrompt
  ) {
    const prompt = projectStructuredUserMessage(
      message.structuredPrompt,
    ).agentPrompt;
    return `${roleLabel}: ${truncatePrior(prompt) || "[empty message]"}`;
  }
  const body = `${roleLabel}: ${truncatePrior(message.content) || "[empty message]"}`;
  const attach = formatAttachFileIds(message.attachFiles);
  return attach ? `${body}\n${attach}` : body;
}

function buildChatPriorRunsContext(
  runs: readonly PriorRun[],
  triggerSource: "web" | "slack" | "feishu",
  structuredPromptEnabled: boolean,
): string {
  if (runs.length === 0) {
    return "";
  }
  const sections = runs.map((run, index) => {
    const renderedMessages = run.messages.map((message) => {
      return formatPriorRunMessage(message, structuredPromptEnabled);
    });
    const transcript =
      renderedMessages.length > 0
        ? renderedMessages.join("\n\n")
        : [
            `User: ${truncatePrior(run.prompt) || "[empty message]"}`,
            "Assistant: [no visible assistant message recorded]",
          ].join("\n\n");
    return [
      `## Recent Run ${index + 1}`,
      `- RUN_ID: ${run.runId}`,
      `- RUN_STATUS: ${run.status}`,
      `- LOG_COMMAND: zero logs ${run.runId} --all`,
      "",
      transcript,
    ].join("\n");
  });
  return [
    `# ${
      triggerSource === "slack"
        ? "Slack"
        : triggerSource === "feishu"
          ? "Feishu"
          : "Web Chat"
    } Run Context`,
    "The current CLI session is fresh, so recent visible chat rounds are provided here for continuity.",
    "Use these messages as context for the user's current request.",
    "- Treat the newest run below as the most recent prior round.",
    "- Use the LOG_COMMAND for a run if you need more detailed agent log context.",
    "",
    ...sections,
  ].join("\n");
}

async function getLatestRunsByThreadId(
  db: Db,
  threadId: string,
  triggerSource: "web" | "slack" | "feishu",
  limit: number,
): Promise<PriorRun[]> {
  const runRows = await db
    .select({
      runId: zeroRuns.id,
      status: agentRuns.status,
      prompt: agentRuns.prompt,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .where(
      and(
        eq(zeroRuns.chatThreadId, threadId),
        eq(zeroRuns.triggerSource, triggerSource),
        or(
          sql`${agentRuns.status} IS DISTINCT FROM ${"cancelled"}`,
          sql`${agentRuns.error} IS DISTINCT FROM ${BEFORE_DISPATCH_CANCELLED_ERROR}`,
        ),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(limit);

  const orderedRuns = runRows.reverse();
  const runIds = orderedRuns.map((run) => {
    return run.runId;
  });
  if (runIds.length === 0) {
    return [];
  }

  const messageRows = await db
    .select({
      runId: chatMessages.runId,
      eventType: chatEventTypeSql().as("event_type"),
      content: chatMessages.content,
      structuredPrompt: effectiveChatMessageStructuredPrompt(),
      attachFiles: chatMessages.attachFiles,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
      generationTemplate: chatMessages.generationTemplate,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        isNotNull(chatMessages.content),
        inArray(chatMessages.runId, runIds),
        chatEventTypeIn(CHAT_EVENT_TYPES),
        visibleChatEventCondition(db),
      ),
    )
    .orderBy(asc(chatMessages.seqId));

  const messagesByRunId = new Map<string, PriorRunMessage[]>();
  for (const row of messageRows) {
    if (row.runId === null || row.content === null) {
      continue;
    }
    const existing = messagesByRunId.get(row.runId) ?? [];
    existing.push({
      role: chatEventCompatibilityRole(row.eventType),
      content: row.content,
      structuredPrompt: row.structuredPrompt,
      attachFiles: row.attachFiles,
      generationTemplate: row.generationTemplate,
    });
    messagesByRunId.set(row.runId, existing);
  }

  return orderedRuns.map((run) => {
    return {
      runId: run.runId,
      status: run.status,
      prompt: run.prompt,
      messages: messagesByRunId.get(run.runId) ?? [],
    };
  });
}

async function chatThreadForRunFromDb(
  db: Db,
  runId: string,
): Promise<ChatThreadForRunRow | null> {
  const [row] = await db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      userId: chatThreads.userId,
      orgId: agentRuns.orgId,
    })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(agentRuns.id, zeroRuns.id))
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);

  if (!row?.chatThreadId) {
    return null;
  }
  return {
    chatThreadId: row.chatThreadId,
    userId: row.userId,
    orgId: row.orgId,
  };
}

async function loadAgentForAutoSend(
  db: Db,
  agentId: string,
): Promise<AgentForAutoSend | null> {
  const [agent] = await db
    .select({ id: zeroAgents.id, orgId: zeroAgents.orgId })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  return agent ?? null;
}

async function chatThreadExists(db: Db, threadId: string): Promise<boolean> {
  const [thread] = await db
    .select({ id: chatThreads.id })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);
  return thread !== undefined;
}

function fallbackAttachFiles(
  ids: readonly string[] | null,
): readonly ResolvedAttachFile[] {
  return (ids ?? []).map((id) => {
    return {
      id,
      filename: id,
      contentType: "application/octet-stream",
      size: 0,
      url: "",
    };
  });
}

async function buildQueuedPriorContext(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly startNewSession: boolean;
  readonly incompleteContext: string;
  readonly triggerSource: "web" | "slack" | "feishu";
  readonly structuredPromptEnabled: boolean;
}): Promise<string> {
  if (!args.startNewSession || args.incompleteContext.length > 0) {
    return "";
  }
  return buildChatPriorRunsContext(
    await getLatestRunsByThreadId(
      args.db,
      args.threadId,
      args.triggerSource,
      RECENT_CHAT_RUN_LIMIT,
    ),
    args.triggerSource,
    args.structuredPromptEnabled,
  );
}

function resolveQueuedAttachFiles(args: {
  readonly getResolvedAttachFiles: ResolveAttachFiles;
  readonly queuedMessage: QueuedUserMessage;
  readonly userId: string;
}): Promise<readonly ResolvedAttachFile[]> {
  if (
    args.queuedMessage.attachFileMetadata &&
    args.queuedMessage.attachFileMetadata.length > 0
  ) {
    return Promise.resolve(
      resolveAttachFileMetadataUrls(args.queuedMessage.attachFileMetadata),
    );
  }
  if (
    args.queuedMessage.attachFiles &&
    args.queuedMessage.attachFiles.length > 0
  ) {
    return args.getResolvedAttachFiles(
      args.userId,
      args.queuedMessage.attachFiles,
    );
  }
  return Promise.resolve([]);
}

async function buildQueuedFullPrompt(args: {
  readonly getResolvedAttachFiles: ResolveAttachFiles;
  readonly queuedMessage: QueuedUserMessage;
  readonly userId: string;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}): Promise<string> {
  const resolvedAttachFiles = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_attachments",
    "nested",
    () => {
      return resolveQueuedAttachFiles(args);
    },
  );
  const attachFiles =
    resolvedAttachFiles.length > 0
      ? resolvedAttachFiles
      : fallbackAttachFiles(args.queuedMessage.attachFiles);
  const content = args.queuedMessage.content ?? "";
  if (attachFiles.length === 0) {
    return content;
  }
  return `${content}\n\n${buildWebAttachFilesPrompt(attachFiles)}`;
}

async function resolveQueuedRuntimePrompt(args: {
  readonly getResolvedAttachFiles: ResolveAttachFiles;
  readonly queuedMessage: QueuedUserMessage;
  readonly sourcePrompt: string | undefined;
  readonly structuredProjection:
    | ReturnType<typeof projectStructuredUserMessage>
    | undefined;
  readonly userId: string;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}): Promise<string> {
  if (args.structuredProjection) {
    return args.structuredProjection.agentPrompt;
  }
  const canonicalPrompt = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_build_prompt",
    "nested",
    () => {
      return buildQueuedFullPrompt({
        getResolvedAttachFiles: args.getResolvedAttachFiles,
        queuedMessage: args.queuedMessage,
        userId: args.userId,
        timing: args.timing,
      });
    },
  );
  return args.sourcePrompt ?? canonicalPrompt;
}

interface QueuedMessageModelRoute {
  readonly modelPin: ModelFirstPin;
  readonly effectiveModelProvider: string | null | undefined;
  readonly cliAgentType: string | null;
  readonly codexServiceTier: "fast" | undefined;
}

interface QueuedMessageModelRouteError {
  readonly code: string;
  readonly message: string;
}

type QueuedMessageModelRouteResolution =
  | { readonly route: QueuedMessageModelRoute }
  | { readonly error: QueuedMessageModelRouteError };

function persistedModelProviderCredentialScope(
  value: string | null,
): ModelFirstPin["modelProviderCredentialScope"] {
  if (value === null) {
    return null;
  }
  const parsed = modelProviderCredentialScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function resolveUnpinnedSlackQueuedMessageModelRoute(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
}): Promise<QueuedMessageModelRouteResolution | null> {
  const [thread] = await args.db
    .select({ selectedModel: chatThreads.selectedModel })
    .from(chatThreads)
    .where(eq(chatThreads.id, args.threadId))
    .limit(1);
  if (!thread || thread.selectedModel !== null) {
    return null;
  }

  const [firstRun] = await args.db
    .select({
      modelProviderId: zeroRuns.modelProviderId,
      modelProviderType: zeroRuns.modelProvider,
      modelProviderCredentialScope: zeroRuns.modelProviderCredentialScope,
      selectedModel: zeroRuns.selectedModel,
    })
    .from(chatMessages)
    .innerJoin(zeroRuns, eq(zeroRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, args.threadId),
        chatEventTypeIn(["input.prompt"]),
        isNotNull(chatMessages.runId),
        eq(zeroRuns.triggerSource, "slack"),
      ),
    )
    .orderBy(asc(chatMessages.seqId))
    .limit(1);
  const modelPin: ModelFirstPin = firstRun
    ? {
        modelProviderId: firstRun.modelProviderId,
        modelProviderType: firstRun.modelProviderType,
        modelProviderCredentialScope: persistedModelProviderCredentialScope(
          firstRun.modelProviderCredentialScope,
        ),
        selectedModel: firstRun.selectedModel,
      }
    : {
        modelProviderId: null,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: null,
      };
  const providerAdmission = await resolveModelFirstProviderAdmission({
    db: args.db,
    orgId: args.orgId,
    userId: args.userId,
    modelPin,
    requestedModelProvider: undefined,
  });
  if (providerAdmission.error) {
    return { error: providerAdmission.error.body.error };
  }
  return {
    route: {
      modelPin,
      effectiveModelProvider: providerAdmission.effectiveModelProvider,
      cliAgentType: providerAdmission.cliAgentType,
      codexServiceTier: undefined,
    },
  };
}

async function resolveQueuedMessageModelRoute(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly triggerSource: QueuedUserMessage["triggerSource"];
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}): Promise<QueuedMessageModelRouteResolution> {
  const modelContext = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_model_pin",
    "nested",
    () => {
      return resolveRunChatThreadModelContext({
        db: args.db,
        orgId: args.orgId,
        userId: args.userId,
        threadId: args.threadId,
      });
    },
  );
  if ("status" in modelContext) {
    if (args.triggerSource === "slack") {
      const unpinnedRoute =
        await resolveUnpinnedSlackQueuedMessageModelRoute(args);
      if (unpinnedRoute) {
        return unpinnedRoute;
      }
    }
    log.warn("Auto-send aborted: current model route is unavailable", {
      threadId: args.threadId,
      error: modelContext.body.error.message,
    });
    return { error: modelContext.body.error };
  }
  if (modelContext.providerAdmission.error) {
    log.warn("Auto-send aborted: current model route was not admitted", {
      threadId: args.threadId,
      error: modelContext.providerAdmission.error.body.error.message,
    });
    return { error: modelContext.providerAdmission.error.body.error };
  }
  return {
    route: {
      modelPin: modelContext.pin,
      effectiveModelProvider:
        modelContext.providerAdmission.effectiveModelProvider,
      cliAgentType: modelContext.providerAdmission.cliAgentType,
      codexServiceTier: modelContext.runCodexServiceTier,
    },
  };
}

interface CreateQueuedChatRunInputArgs {
  readonly db: Db;
  readonly getResolvedAttachFiles: ResolveAttachFiles;
  readonly threadId: string;
  readonly userId: string;
  readonly agent: AgentForAutoSend;
  readonly queuedMessage: QueuedUserMessage;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
}

function loadQueuedMessageSessionState(
  args: CreateQueuedChatRunInputArgs,
  modelRoute: QueuedMessageModelRoute,
) {
  return measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_load_session_state",
    "nested",
    async () => {
      const [sessionResolution, featureSwitchContext] = await Promise.all([
        resolveChatThreadSession({
          db: args.db,
          threadId: args.threadId,
          userId: args.userId,
          orgId: args.agent.orgId,
          agentComposeId: args.agent.id,
          route: {
            selectedModel: modelRoute.modelPin.selectedModel,
            modelProvider: modelRoute.effectiveModelProvider ?? null,
            cliAgentType: modelRoute.cliAgentType,
          },
        }),
        loadUserFeatureSwitchContext(args.db, args.agent.orgId, args.userId),
      ]);
      const structuredPromptEnabled = isFeatureEnabled(
        FeatureSwitchKey.StructuredPrompt,
        featureSwitchContext,
      );
      const incompleteContext =
        args.queuedMessage.triggerSource === "web"
          ? await loadWebChatIncompleteContext(
              args.db,
              args.threadId,
              structuredPromptEnabled,
            )
          : "";
      return [
        sessionResolution.action === "rotated",
        incompleteContext,
        featureSwitchContext,
      ] as const;
    },
  );
}

function slackQueuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  sourceParams: Awaited<ReturnType<typeof decryptQueuedUserMessageRunParams>>,
  error: QueuedMessageModelRouteError,
): SlackQueuedMessageAdmissionFailure | null {
  if (
    args.queuedMessage.triggerSource !== "slack" ||
    !sourceParams?.slackDelivery
  ) {
    return null;
  }
  return {
    kind: "slack_admission_failure",
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    slackDelivery: sourceParams.slackDelivery,
    error,
  };
}

function resolveQueuedMessageGenerationTemplatePrompt(args: {
  readonly input: CreateQueuedChatRunInputArgs;
  readonly structuredProjection:
    | ReturnType<typeof projectStructuredUserMessage>
    | undefined;
  readonly websiteTemplateV2Enabled: boolean;
  readonly imageStyleR2Enabled: boolean;
}) {
  return measureChatCallbackPreCreateTiming(
    args.input.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_generation_template",
    "nested",
    () => {
      return resolveThreadGenerationTemplatePrompt({
        explicit: args.structuredProjection
          ? args.structuredProjection.generationTemplate
          : args.input.queuedMessage.generationTemplate,
        websiteTemplateV2Enabled: args.websiteTemplateV2Enabled,
        imageStyleR2Enabled: args.imageStyleR2Enabled,
      });
    },
  );
}

async function buildCreateQueuedChatRunInput(
  args: CreateQueuedChatRunInputArgs,
): Promise<
  CreateQueuedChatRunInput | SlackQueuedMessageAdmissionFailure | null
> {
  const sourceParams = await decryptQueuedUserMessageRunParams(
    args.queuedMessage.encryptedParams,
    { orgId: args.agent.orgId, userId: args.userId },
  );
  if (args.queuedMessage.triggerSource !== "web" && !sourceParams) {
    throw new Error("Canonical integration queue item is missing run params");
  }
  const modelRouteResolution = await resolveQueuedMessageModelRoute({
    db: args.db,
    threadId: args.threadId,
    userId: args.userId,
    orgId: args.agent.orgId,
    triggerSource: args.queuedMessage.triggerSource,
    timing: args.timing,
  });
  if ("error" in modelRouteResolution) {
    return slackQueuedMessageAdmissionFailure(
      args,
      sourceParams,
      modelRouteResolution.error,
    );
  }
  const modelRoute = modelRouteResolution.route;

  const [startNewSession, loadedIncompleteContext, featureSwitchContext] =
    await loadQueuedMessageSessionState(args, modelRoute);
  const structuredPromptEnabled = isFeatureEnabled(
    FeatureSwitchKey.StructuredPrompt,
    featureSwitchContext,
  );
  const structuredProjection =
    structuredPromptEnabled && args.queuedMessage.structuredPrompt
      ? projectStructuredUserMessage(args.queuedMessage.structuredPrompt)
      : undefined;
  const incompleteContext = startNewSession ? "" : loadedIncompleteContext;
  const priorContext = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_build_prior_context",
    "nested",
    () => {
      return buildQueuedPriorContext({
        db: args.db,
        threadId: args.threadId,
        startNewSession,
        incompleteContext,
        triggerSource: args.queuedMessage.triggerSource,
        structuredPromptEnabled,
      });
    },
  );
  const generationTemplatePrompt =
    await resolveQueuedMessageGenerationTemplatePrompt({
      input: args,
      structuredProjection,
      websiteTemplateV2Enabled: isFeatureEnabled(
        FeatureSwitchKey.WebsiteTemplateV2,
        featureSwitchContext,
      ),
      imageStyleR2Enabled: isFeatureEnabled(
        FeatureSwitchKey.ImageStyleR2,
        featureSwitchContext,
      ),
    });
  const computerUseHostGrant = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_computer_use_host",
    "nested",
    () => {
      return loadComputerUseHostGrantForAutoSend({
        db: args.db,
        threadId: args.threadId,
        orgId: args.agent.orgId,
        userId: args.userId,
      });
    },
  );
  const prompt = await resolveQueuedRuntimePrompt({
    getResolvedAttachFiles: args.getResolvedAttachFiles,
    queuedMessage: args.queuedMessage,
    sourcePrompt: sourceParams?.prompt,
    structuredProjection,
    userId: args.userId,
    timing: args.timing,
  });

  return {
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    prompt,
    appendSystemPrompt: buildAppendSystemPrompt(
      sourceParams?.appendSystemPrompt ?? buildWebChatPrompt(),
      incompleteContext,
      priorContext,
      generationTemplatePrompt,
      computerUseHostGrant?.displayName ?? null,
    ),
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    modelPin: modelRoute.modelPin,
    effectiveModelProvider: modelRoute.effectiveModelProvider,
    cliAgentType: modelRoute.cliAgentType,
    codexServiceTier: modelRoute.codexServiceTier,
    computerUseHostGrant,
    triggerSource: args.queuedMessage.triggerSource,
    realAgentInPreview: sourceParams?.realAgentInPreview,
    slackDelivery: sourceParams?.slackDelivery,
    feishuDelivery: sourceParams?.feishuDelivery,
    apiStartTime: sourceParams?.apiStartTime,
    userInfoExtras: sourceParams?.userInfoExtras,
  };
}

async function appendAutoSentQueuedRunMarker(args: {
  readonly db: Db;
  readonly createdAfter: Date;
  readonly runId: string;
  readonly threadId: string;
}): Promise<boolean> {
  const marker = await settle(
    args.db.transaction(async (tx) => {
      await appendQueuedRunAssistantMarker(tx, {
        chatThreadId: args.threadId,
        runId: args.runId,
        createdAfter: args.createdAfter,
      });
    }),
  );
  if (marker.ok) {
    return true;
  }
  // The atomic launch can commit immediately before thread deletion. Keep the
  // normal marker path query-free and classify only that expected FK race.
  if (
    isForeignKeyViolation(marker.error) &&
    !(await chatThreadExists(args.db, args.threadId))
  ) {
    return false;
  }
  throw marker.error;
}

async function createAutoSentQueuedRun(args: {
  readonly createRun: (
    input: CreateQueuedChatRunInput,
  ) => Promise<CreatedQueuedRun | null>;
  readonly runInput: CreateQueuedChatRunInput;
  readonly timing: ChatCallbackPreCreateTimingCollector;
}): Promise<CreatedQueuedRun | null> {
  return await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_create_run",
    "top_level",
    () => {
      return args.createRun(args.runInput);
    },
  );
}

async function appendAutoSentQueuedRunMarkerIfQueued(args: {
  readonly db: Db;
  readonly run: CreatedQueuedRun;
  readonly threadId: string;
  readonly timing: ChatCallbackPreCreateTimingCollector;
}): Promise<boolean> {
  if (args.run.status !== "queued") {
    return true;
  }
  return await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_append_marker",
    "nested",
    () => {
      return appendAutoSentQueuedRunMarker({
        db: args.db,
        createdAfter: args.run.claimedMessageCreatedAt,
        runId: args.run.runId,
        threadId: args.threadId,
      });
    },
  );
}

async function publishAutoSentQueuedRunSignals(args: {
  readonly threadId: string;
  readonly userId: string;
  readonly timing: ChatCallbackPreCreateTimingCollector;
}): Promise<void> {
  await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_publish_signals",
    "nested",
    async () => {
      await publishUserSignal(
        [args.userId],
        `chatThreadMessageCreated:${args.threadId}`,
      );
      await publishUserSignal(
        [args.userId],
        `chatThreadRunCreated:${args.threadId}`,
      );
      await publishThreadListChanged(args.userId);
    },
  );
}

async function handleSlackQueuedMessageAdmissionFailure(args: {
  readonly db: Db;
  readonly failure: SlackQueuedMessageAdmissionFailure;
  readonly signal: AbortSignal;
  readonly formatError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliver: ChatCallbackDependencies["deliverSlackAdmissionFailure"];
}): Promise<void> {
  const displayError = await args.formatError(
    {
      orgId: args.failure.orgId,
      userId: args.failure.userId,
      code: args.failure.error.code,
      message: args.failure.error.message,
    },
    args.signal,
  );
  args.signal.throwIfAborted();
  const failed = await failQueuedUserMessage(args.db, {
    threadId: args.failure.threadId,
    messageId: args.failure.queuedMessage.id,
    assistantContent: displayError,
    errorMarker: args.failure.error.code.toLowerCase(),
    currentTime: nowDate(),
  });
  args.signal.throwIfAborted();
  if (!failed) {
    return;
  }

  await publishUserSignal(
    [args.failure.userId],
    `chatThreadMessageCreated:${args.failure.threadId}`,
  );
  await publishThreadListChanged(args.failure.userId);
  args.signal.throwIfAborted();
  await tapError(
    args.deliver(
      {
        chatThreadId: args.failure.threadId,
        userId: args.failure.userId,
        orgId: args.failure.orgId,
        agentId: args.failure.agentId,
        channelId: args.failure.slackDelivery.channelId,
        threadTs: args.failure.slackDelivery.threadTs,
        chatMessageId: failed.assistantMessageId,
      },
      args.signal,
    ),
    (error) => {
      log.warn("Failed to deliver canonical Slack admission error", {
        threadId: args.failure.threadId,
        error,
      });
    },
  );
}

/**
 * User-message half of the per-thread scheduler: when the thread has no
 * in-flight run, dispatch the oldest queued user message — whoever sent it.
 * The shared thread scheduler calls this before attempting the workflow-event
 * half, preserving user-message priority.
 */
async function autoSendQueuedMessageForThread(args: {
  readonly getResolvedAttachFiles: ResolveAttachFiles;
  readonly createRun: (
    input: CreateQueuedChatRunInput,
  ) => Promise<CreatedQueuedRun | null>;
  readonly db: Db;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly queueItemCreatedBefore?: Date;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly formatIntegrationRunError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliverSlackAdmissionFailure: ChatCallbackDependencies["deliverSlackAdmissionFailure"];
}): Promise<void> {
  const { chatThreadId: threadId, userId } = args;

  const queuedMessage = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_lookup_queued_message",
    "nested",
    () => {
      return loadNextUnclaimedQueuedUserMessage(
        args.db,
        threadId,
        args.queueItemCreatedBefore,
      );
    },
  );
  if (!queuedMessage) {
    return;
  }

  const agent = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_load_agent",
    "nested",
    () => {
      return loadAgentForAutoSend(args.db, args.agentId);
    },
  );
  if (!agent) {
    log.warn("Auto-send aborted: agent not found", {
      threadId,
      agentId: args.agentId,
    });
    return;
  }

  const runInput = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_build_input",
    "top_level",
    () => {
      return buildCreateQueuedChatRunInput({
        db: args.db,
        getResolvedAttachFiles: args.getResolvedAttachFiles,
        threadId,
        userId,
        agent,
        queuedMessage,
        timing: args.timing,
      });
    },
  );
  if (!runInput) {
    return;
  }
  const activeRunExists = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_check_active_run",
    "nested",
    () => {
      return chatThreadAdmissionBlocked(args.db, { threadId });
    },
  );
  if (activeRunExists) {
    return;
  }
  if ("kind" in runInput) {
    await handleSlackQueuedMessageAdmissionFailure({
      db: args.db,
      failure: runInput,
      signal: args.signal,
      formatError: args.formatIntegrationRunError,
      deliver: args.deliverSlackAdmissionFailure,
    });
    return;
  }

  let createdRunId: string | null = null;
  const run = await onRejection(
    (async () => {
      const createdRun = await createAutoSentQueuedRun({
        createRun: args.createRun,
        runInput,
        timing: args.timing,
      });
      if (!createdRun) {
        return null;
      }
      createdRunId = createdRun.runId;
      const shouldPublishSignals = await appendAutoSentQueuedRunMarkerIfQueued({
        db: args.db,
        run: createdRun,
        threadId,
        timing: args.timing,
      });
      if (!shouldPublishSignals) {
        return createdRun;
      }
      await publishAutoSentQueuedRunSignals({
        threadId,
        userId,
        timing: args.timing,
      });
      return createdRun;
    })(),
    flushChatCallbackTimingOnRejection({
      timing: args.timing,
      triggerSource: runInput.triggerSource,
      getRunId: () => {
        return createdRunId;
      },
    }),
  );
  if (run) {
    args.timing.flush(run.runId, runInput.triggerSource);
  }
}

async function createQueuedChatRun(args: {
  readonly input: CreateQueuedChatRunInput;
  readonly signal: AbortSignal;
  readonly createRun: (
    input: CreateQueuedChatRunInput,
  ) => Promise<CreatedQueuedRun | null>;
}): Promise<CreatedQueuedRun | null> {
  const created = await args.createRun(args.input);
  args.signal.throwIfAborted();
  if (!created) {
    return null;
  }
  return created;
}

async function loadTerminalChatCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly callbackStatus: "completed" | "failed";
  readonly payloadThreadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
} | null> {
  const [run] = await args.db
    .select({
      prompt: agentRuns.prompt,
      error: agentRuns.error,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!run) {
    return null;
  }

  const chatThread = await chatThreadForRunFromDb(args.db, args.runId);
  args.signal.throwIfAborted();
  if (!chatThread) {
    log.debug("Skipping terminal chat callback for missing chat thread", {
      runId: args.runId,
      status: args.callbackStatus,
      payloadThreadId: args.payloadThreadId,
    });
    return null;
  }

  if (chatThread.chatThreadId !== args.payloadThreadId) {
    log.warn("Chat callback payload thread does not match run mapping", {
      runId: args.runId,
      payloadThreadId: args.payloadThreadId,
      chatThreadId: chatThread.chatThreadId,
    });
  }

  return { run, chatThread };
}

async function prepareCompletedTerminalChatCallbackWork(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly isGoalRun: boolean;
  readonly dependencies: ChatCallbackDependencies;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<TerminalChatCallbackWork> {
  const prepared = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_prepare_completed",
    "top_level",
    async () => {
      const featureSwitchContext = await loadUserFeatureSwitchContext(
        args.db,
        args.chatThread.orgId,
        args.chatThread.userId,
      );
      args.signal.throwIfAborted();
      const structuredPromptEnabled = isFeatureEnabled(
        FeatureSwitchKey.StructuredPrompt,
        featureSwitchContext,
      );
      const completed = await handleCompletedChatCallback({
        db: args.db,
        runId: args.runId,
        run: args.run,
        chatThread: args.chatThread,
        timing: args.timing,
        structuredPromptEnabled,
        signal: args.signal,
        slackDelivery: args.slackDelivery,
        feishuDelivery: args.feishuDelivery,
        sourceCallbackId: args.sourceCallbackId,
        insertAssistantItems: async (items) => {
          await args.dependencies.insertAssistantItems(
            {
              runId: args.runId,
              threadId: args.chatThread.chatThreadId,
              userId: args.chatThread.userId,
              items,
            },
            args.signal,
          );
        },
      });
      return { completed, structuredPromptEnabled };
    },
  );
  const { completed, structuredPromptEnabled } = prepared;
  if (!completed.inserted) {
    return { shouldDrainThreadQueue: false };
  }

  return {
    shouldDrainThreadQueue: true,
    slackDeliveryCallbackId: completed.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: completed.feishuDeliveryCallbackId,
    deferredSideEffects: () => {
      return runCompletedChatCallbackSideEffects({
        db: args.db,
        runId: args.runId,
        run: args.run,
        chatThread: args.chatThread,
        isGoalRun: args.isGoalRun,
        lastResultText: completed.lastResultText,
        followupContext: completed.followupContext,
        structuredPromptEnabled,
        signal: args.signal,
        saveRunSummary: (resultText) => {
          return args.dependencies.saveRunSummary(
            args.runId,
            args.run.prompt,
            resultText,
            args.signal,
          );
        },
      });
    },
  };
}

async function prepareFailedTerminalChatCallbackWork(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly errorMessage: string;
  readonly dependencies: ChatCallbackDependencies;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<TerminalChatCallbackWork> {
  const failed = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_prepare_failed",
    "top_level",
    () => {
      return handleFailedChatCallback({
        db: args.db,
        runId: args.runId,
        chatThread: args.chatThread,
        errorMessage: args.errorMessage,
        getFormattedError: () => {
          return args.dependencies.formatRunError(
            {
              chatThreadId: args.chatThread.chatThreadId,
              runId: args.runId,
              errorMessage: args.errorMessage,
            },
            args.signal,
          );
        },
        slackDelivery: args.slackDelivery,
        feishuDelivery: args.feishuDelivery,
        sourceCallbackId: args.sourceCallbackId,
      });
    },
  );
  if (!failed.inserted) {
    return { shouldDrainThreadQueue: false };
  }

  return {
    shouldDrainThreadQueue: true,
    slackDeliveryCallbackId: failed.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: failed.feishuDeliveryCallbackId,
    deferredSideEffects: () => {
      return runFailedChatCallbackSideEffects({
        db: args.db,
        run: args.run,
        chatThread: args.chatThread,
        displayErrorMessage: failed.displayErrorMessage,
      });
    },
  };
}

async function maybeDrainThreadQueueForTerminalCallback(args: {
  readonly enabled: boolean;
  readonly chatThreadId: string;
  readonly dependencies: ChatCallbackDependencies;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
}): Promise<DrainOutcome> {
  if (!args.enabled || !args.dependencies.drainThreadQueue) {
    return { ok: true };
  }

  const result = await settle(
    args.dependencies.drainThreadQueue(
      args.chatThreadId,
      args.signal,
      args.timing,
    ),
    args.signal,
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function clearSlackThreadStatusAfterTerminalCallback(args: {
  readonly chatThreadId: string;
  readonly slackDelivery: SlackDeliveryTarget | undefined;
  readonly dependencies: ChatCallbackDependencies;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.slackDelivery) {
    return;
  }
  await tapError(
    args.dependencies.clearSlackThreadStatusIfIdle(
      {
        chatThreadId: args.chatThreadId,
        channelId: args.slackDelivery.channelId,
        threadTs: args.slackDelivery.threadTs,
      },
      args.signal,
    ),
    (error) => {
      log.warn("Failed to clear canonical Slack thread status", {
        chatThreadId: args.chatThreadId,
        error,
      });
    },
  );
  args.signal.throwIfAborted();
}

async function clearFeishuThinkingAfterTerminalCallback(args: {
  readonly feishuDelivery: FeishuDeliveryTarget | undefined;
  readonly dependencies: ChatCallbackDependencies;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (!args.feishuDelivery) {
    return;
  }
  await tapError(
    args.dependencies.clearFeishuThinkingReaction(
      args.feishuDelivery,
      args.signal,
    ),
    (error) => {
      log.warn("Failed to clear canonical Feishu thinking reaction", {
        messageId: args.feishuDelivery?.messageId,
        error,
      });
    },
  );
  args.signal.throwIfAborted();
}

async function handleTerminalChatCallbackPreparationFailure(args: {
  readonly runId: string;
  readonly error: unknown;
  readonly chatThreadId: string;
  readonly slackDelivery: SlackDeliveryTarget | undefined;
  readonly feishuDelivery: FeishuDeliveryTarget | undefined;
  readonly dependencies: ChatCallbackDependencies;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
}): Promise<never> {
  const fallbackDrain = await maybeDrainThreadQueueForTerminalCallback({
    enabled: true,
    chatThreadId: args.chatThreadId,
    dependencies: args.dependencies,
    timing: args.timing,
    signal: args.signal,
  });
  if (!fallbackDrain.ok) {
    log.error("Failed to drain thread queue after terminal callback error", {
      runId: args.runId,
      error: fallbackDrain.error,
    });
  }
  await clearSlackThreadStatusAfterTerminalCallback({
    chatThreadId: args.chatThreadId,
    slackDelivery: args.slackDelivery,
    dependencies: args.dependencies,
    signal: args.signal,
  });
  await clearFeishuThinkingAfterTerminalCallback({
    feishuDelivery: args.feishuDelivery,
    dependencies: args.dependencies,
    signal: args.signal,
  });
  throw args.error;
}

async function dispatchCanonicalDeliveryCallbacks(args: {
  readonly runId: string;
  readonly slackDeliveryCallbackId: string | undefined;
  readonly feishuDeliveryCallbackId: string | undefined;
  readonly dependencies: ChatCallbackDependencies;
  readonly signal: AbortSignal;
}): Promise<void> {
  if (args.slackDeliveryCallbackId) {
    const delivery = await settle(
      args.dependencies.dispatchSlackDelivery(
        args.slackDeliveryCallbackId,
        args.signal,
      ),
      args.signal,
    );
    if (!delivery.ok) {
      log.error("Failed to finalize canonical Slack delivery callback", {
        runId: args.runId,
        callbackId: args.slackDeliveryCallbackId,
        error: delivery.error,
      });
    }
  }
  if (args.feishuDeliveryCallbackId) {
    const delivery = await settle(
      args.dependencies.dispatchFeishuDelivery(
        args.feishuDeliveryCallbackId,
        args.signal,
      ),
      args.signal,
    );
    if (!delivery.ok) {
      log.error("Failed to finalize canonical Feishu delivery callback", {
        runId: args.runId,
        callbackId: args.feishuDeliveryCallbackId,
        error: delivery.error,
      });
    }
  }
}

interface TerminalChatCallbackArgs {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly payload: ChatCallbackPayload;
  readonly dependencies: ChatCallbackDependencies;
  readonly signal: AbortSignal;
}

async function releaseManagedBrowsersForTerminalCallback(
  args: TerminalChatCallbackArgs,
): Promise<void> {
  // The window stays live after the run so the user can keep using it; this only
  // restarts its idle lease. Browser resources outlive thread deletion, so use
  // the callback payload rather than loading the thread first.
  const released = await settle(
    args.dependencies.releaseBrowsersForRun(
      { chatThreadId: args.payload.threadId },
      args.signal,
    ),
    args.signal,
  );
  if (!released.ok) {
    log.error("Failed to extend managed browser leases for terminal run", {
      runId: args.callback.runId,
      chatThreadId: args.payload.threadId,
      error: released.error,
    });
  }
}

async function processTerminalChatCallback(
  args: TerminalChatCallbackArgs,
): Promise<void> {
  const runId = args.callback.runId;
  const callbackStatus = args.callback.status;
  if (callbackStatus === "progress") {
    return;
  }
  const timing = new ChatCallbackPreCreateTimingCollector();

  await releaseManagedBrowsersForTerminalCallback(args);

  const loaded = await measureChatCallbackPreCreateTiming(
    timing,
    "api_dispatch_pre_create_zero_chat_callback_load_terminal",
    "top_level",
    () => {
      return loadTerminalChatCallback({
        db: args.db,
        runId,
        callbackStatus,
        payloadThreadId: args.payload.threadId,
        signal: args.signal,
      });
    },
  );
  if (!loaded) {
    await clearSlackThreadStatusAfterTerminalCallback({
      chatThreadId: args.payload.threadId,
      slackDelivery: args.payload.slackDelivery,
      dependencies: args.dependencies,
      signal: args.signal,
    });
    await clearFeishuThinkingAfterTerminalCallback({
      feishuDelivery: args.payload.feishuDelivery,
      dependencies: args.dependencies,
      signal: args.signal,
    });
    return;
  }
  const { run, chatThread } = loaded;
  const isGoalRun = args.payload.isGoalRun ?? false;

  const prepared = await settle(
    callbackStatus === "completed"
      ? prepareCompletedTerminalChatCallbackWork({
          db: args.db,
          runId,
          run,
          chatThread,
          isGoalRun,
          dependencies: args.dependencies,
          timing,
          signal: args.signal,
          slackDelivery: args.payload.slackDelivery,
          feishuDelivery: args.payload.feishuDelivery,
          sourceCallbackId: args.callback.callbackId,
        })
      : prepareFailedTerminalChatCallbackWork({
          db: args.db,
          runId,
          run,
          chatThread,
          errorMessage: terminalCallbackErrorMessage(
            args.callback.error,
            run.error,
          ),
          dependencies: args.dependencies,
          timing,
          signal: args.signal,
          slackDelivery: args.payload.slackDelivery,
          feishuDelivery: args.payload.feishuDelivery,
          sourceCallbackId: args.callback.callbackId,
        }),
    args.signal,
  );

  if (!prepared.ok) {
    return await handleTerminalChatCallbackPreparationFailure({
      runId,
      error: prepared.error,
      chatThreadId: chatThread.chatThreadId,
      slackDelivery: args.payload.slackDelivery,
      feishuDelivery: args.payload.feishuDelivery,
      dependencies: args.dependencies,
      timing,
      signal: args.signal,
    });
  }
  const work = prepared.value;

  await dispatchCanonicalDeliveryCallbacks({
    runId,
    slackDeliveryCallbackId: work.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: work.feishuDeliveryCallbackId,
    dependencies: args.dependencies,
    signal: args.signal,
  });

  const drainResult = await maybeDrainThreadQueueForTerminalCallback({
    enabled: work.shouldDrainThreadQueue,
    chatThreadId: chatThread.chatThreadId,
    dependencies: args.dependencies,
    timing,
    signal: args.signal,
  });
  await clearSlackThreadStatusAfterTerminalCallback({
    chatThreadId: chatThread.chatThreadId,
    slackDelivery: args.payload.slackDelivery,
    dependencies: args.dependencies,
    signal: args.signal,
  });
  await clearFeishuThinkingAfterTerminalCallback({
    feishuDelivery: args.payload.feishuDelivery,
    dependencies: args.dependencies,
    signal: args.signal,
  });

  if (work.deferredSideEffects) {
    await runTerminalChatCallbackSideEffects({
      runId,
      status: callbackStatus,
      run: work.deferredSideEffects,
    });
  }

  if (!drainResult.ok) {
    throw drainResult.error;
  }
}

function withoutQueuedRunDependency(
  dependencies: ChatCallbackDependencies,
): ChatCallbackDependencies {
  return {
    releaseBrowsersForRun: dependencies.releaseBrowsersForRun,
    insertAssistantItems: dependencies.insertAssistantItems,
    saveRunSummary: dependencies.saveRunSummary,
    formatRunError: dependencies.formatRunError,
    getResolvedAttachFiles: dependencies.getResolvedAttachFiles,
    dispatchSlackDelivery: dependencies.dispatchSlackDelivery,
    clearSlackThreadStatusIfIdle: dependencies.clearSlackThreadStatusIfIdle,
    refreshSlackThreadStatus: dependencies.refreshSlackThreadStatus,
    formatIntegrationRunError: dependencies.formatIntegrationRunError,
    deliverSlackAdmissionFailure: dependencies.deliverSlackAdmissionFailure,
    dispatchFeishuDelivery: dependencies.dispatchFeishuDelivery,
    clearFeishuThinkingReaction: dependencies.clearFeishuThinkingReaction,
    drainThreadQueue: dependencies.drainThreadQueue,
  };
}

async function claimedUserMessageExistsForRun(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [message] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        chatEventTypeIn(["input.prompt"]),
        isNotNull(chatMessages.revokesEventId),
      ),
    )
    .limit(1);
  return message !== undefined;
}

function buildQueuedChatDispatchFailedCallbacks(args: {
  readonly dependencies: ChatCallbackDependencies;
  readonly runInput: CreateQueuedChatRunInput;
  readonly signal: AbortSignal;
}): DispatchFailedRunCallbacks {
  return async (db, runId, error) => {
    if (!(await claimedUserMessageExistsForRun(db, runId))) {
      return;
    }
    const payload = {
      threadId: args.runInput.threadId,
      agentId: args.runInput.agentId,
      slackDelivery: args.runInput.slackDelivery,
      feishuDelivery: args.runInput.feishuDelivery,
    };
    await processTerminalChatCallback({
      db,
      callback: {
        runId,
        status: "failed",
        error,
        payload,
      },
      payload,
      dependencies: withoutQueuedRunDependency(args.dependencies),
      signal: args.signal,
    });
  };
}

function handleChatInternalCallback(args: {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly dependencies: ChatCallbackDependencies;
  readonly signal: AbortSignal;
}):
  | { readonly success: true }
  | { readonly success: false; readonly error: string } {
  const payload = chatCallbackPayloadSchema.safeParse(args.callback.payload);
  if (!payload.success) {
    return {
      success: false,
      error: "Invalid or missing payload",
    };
  }

  if (args.callback.status === "progress") {
    if (payload.data.slackDelivery) {
      const backgroundSignal = new AbortController().signal;
      waitUntil(
        tapError(
          args.dependencies.refreshSlackThreadStatus(
            {
              chatThreadId: payload.data.threadId,
              channelId: payload.data.slackDelivery.channelId,
              threadTs: payload.data.slackDelivery.threadTs,
            },
            backgroundSignal,
          ),
          (error) => {
            log.warn("Failed to refresh canonical Slack thread status", {
              runId: args.callback.runId,
              error,
            });
          },
        ),
      );
    }
    return { success: true };
  }

  // The webhook sender (dispatchRunCallbacks) awaits this response only to
  // record delivery; it does not retry and nothing downstream reads the body.
  // The frontend learns about new messages through Ably realtime signals, not
  // this HTTP response. So acknowledge immediately and run the heavy terminal
  // processing (Axiom watermark wait, message persistence, LLM generation,
  // push delivery) in the background, mirroring webhooks-agent-complete. Use a
  // detached signal so request cancellation cannot interrupt the idempotency
  // marker -> queued auto-send sequence after the callback is acknowledged.
  const backgroundSignal = new AbortController().signal;
  waitUntil(
    tapError(
      processTerminalChatCallback({
        db: args.db,
        callback: args.callback,
        payload: payload.data,
        dependencies: args.dependencies,
        signal: backgroundSignal,
      }),
      (error) => {
        log.error("Failed to process terminal chat callback", {
          runId: args.callback.runId,
          status: args.callback.status,
          error,
        });
      },
    ),
  );

  return { success: true };
}

export async function handleChatInternalCallbackWithoutCcstate(
  db: Db,
  callback: InternalRunCallbackEnvelope,
  signal = new AbortController().signal,
): Promise<
  | { readonly success: true }
  | { readonly success: false; readonly error: string }
> {
  return await handleChatInternalCallback({
    db,
    callback,
    signal,
    dependencies: {
      releaseBrowsersForRun: (args, inputSignal) => {
        return createStore().set(
          releaseThreadBrowsersForRun$,
          args,
          inputSignal,
        );
      },
      insertAssistantItems: async (args, inputSignal) => {
        await insertAssistantEventMessages(db, args, inputSignal);
      },
      saveRunSummary: (runId, prompt, resultText, inputSignal) => {
        return saveRunSummary(
          db,
          { runId, triggerSource: "chat", prompt, resultText },
          inputSignal,
        );
      },
      formatRunError: (params) => {
        return Promise.resolve(
          formatRunErrorForExternalSurface({
            code: "INTERNAL_SERVER_ERROR",
            message: params.errorMessage,
          }),
        );
      },
      getResolvedAttachFiles: (_userId, fileIds) => {
        return Promise.resolve(fallbackAttachFiles(fileIds));
      },
      dispatchSlackDelivery: (callbackId, inputSignal) => {
        return dispatchSlackChatDeliveryOnce(db, callbackId, inputSignal);
      },
      clearSlackThreadStatusIfIdle: (target, inputSignal) => {
        return clearCanonicalSlackThreadStatusIfIdle(db, target, inputSignal);
      },
      refreshSlackThreadStatus: (target, inputSignal) => {
        return refreshCanonicalSlackThreadStatus(db, target, inputSignal);
      },
      formatIntegrationRunError: (params) => {
        return Promise.resolve(
          formatRunErrorForExternalSurface({
            code: params.code,
            message: params.message,
          }),
        );
      },
      deliverSlackAdmissionFailure: (params, inputSignal) => {
        return deliverSlackChatAdmissionFailure({
          db,
          ...params,
          signal: inputSignal,
        });
      },
      dispatchFeishuDelivery: (callbackId, inputSignal) => {
        return dispatchFeishuChatDeliveryOnce(db, callbackId, inputSignal);
      },
      clearFeishuThinkingReaction: (target, inputSignal) => {
        return clearCanonicalFeishuThinkingReaction(db, target, inputSignal);
      },
    },
  });
}

const buildChatCallbackDependencies$ = command(
  (
    { get, set },
    input: {
      readonly db: Db;
      readonly drainThreadQueue?: ChatCallbackDependencies["drainThreadQueue"];
    },
  ): ChatCallbackDependencies => {
    const { db } = input;
    const baseDependencies: ChatCallbackDependencies = {
      releaseBrowsersForRun: (args, inputSignal) => {
        return set(releaseThreadBrowsersForRun$, args, inputSignal);
      },
      insertAssistantItems: async (args, inputSignal) => {
        await set(insertAssistantEventMessages$, args, inputSignal);
      },
      saveRunSummary: (runId, prompt, resultText, inputSignal) => {
        return set(
          saveRunSummary$,
          {
            runId,
            triggerSource: "chat",
            prompt,
            resultText,
          },
          inputSignal,
        );
      },
      formatRunError: (params, inputSignal) => {
        return set(formatRunErrorForRunOwner$, params, inputSignal);
      },
      getResolvedAttachFiles: (userId, fileIds) => {
        return get(resolveAttachFileUrls(userId, fileIds));
      },
      dispatchSlackDelivery: (callbackId, inputSignal) => {
        return dispatchSlackChatDeliveryOnce(db, callbackId, inputSignal);
      },
      clearSlackThreadStatusIfIdle: (target, inputSignal) => {
        return clearCanonicalSlackThreadStatusIfIdle(db, target, inputSignal);
      },
      refreshSlackThreadStatus: (target, inputSignal) => {
        return refreshCanonicalSlackThreadStatus(db, target, inputSignal);
      },
      formatIntegrationRunError: (params, inputSignal) => {
        return set(formatIntegrationRunError$, params, inputSignal);
      },
      deliverSlackAdmissionFailure: (params, inputSignal) => {
        return deliverSlackChatAdmissionFailure({
          db,
          ...params,
          signal: inputSignal,
        });
      },
      dispatchFeishuDelivery: (callbackId, inputSignal) => {
        return dispatchFeishuChatDeliveryOnce(db, callbackId, inputSignal);
      },
      clearFeishuThinkingReaction: (target, inputSignal) => {
        return clearCanonicalFeishuThinkingReaction(db, target, inputSignal);
      },
      drainThreadQueue: input.drainThreadQueue,
    };
    const dependencies: ChatCallbackDependencies = {
      ...baseDependencies,
      createQueuedRun: async (runInput, apiStartTime, inputSignal) => {
        const createArgs = buildQueuedCreateZeroRunArgs(
          runInput,
          apiStartTime,
          buildQueuedChatDispatchFailedCallbacks({
            dependencies: baseDependencies,
            runInput,
            signal: inputSignal,
          }),
        );
        const settledRunResult = await settle(
          set(createQueueFirstZeroRun$, createArgs, inputSignal),
          inputSignal,
        );
        inputSignal.throwIfAborted();
        if (!settledRunResult.ok) {
          if (
            isForeignKeyViolation(settledRunResult.error) &&
            !(await chatThreadExists(db, runInput.threadId))
          ) {
            return null;
          }
          throw settledRunResult.error;
        }
        const runResult = settledRunResult.value;
        if (isQueueFirstRunClaimLost(runResult)) {
          log.warn("Auto-send lost the queued-message launch claim", {
            threadId: runInput.threadId,
            userMessageId: runInput.queuedMessage.id,
          });
          return null;
        }
        if (
          runResult.status !== 201 ||
          runResult.body.status === "failed" ||
          runResult.body.status === "cancelled"
        ) {
          log.warn("Auto-send failed to create run", {
            threadId: runInput.threadId,
            status: runResult.status,
          });
          return null;
        }
        if (!isCreatedQueuedRunStatus(runResult.body.status)) {
          log.warn("Auto-send created run with unexpected status", {
            threadId: runInput.threadId,
            runId: runResult.body.runId,
            status: runResult.body.status,
          });
          return null;
        }
        return {
          runId: runResult.body.runId,
          status: runResult.body.status,
          claimedMessageCreatedAt: runResult.queueFirstClaim.createdAt,
        };
      },
    };
    return dependencies;
  },
);

/**
 * User-message drain used by the shared per-thread scheduler. Compatibility
 * reads remain here until the follow-up cleanup removes the old queue paths.
 */
export const drainQueuedUserMessagesForThread$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly queueItemCreatedBefore?: Date;
      readonly timing?: ChatCallbackPreCreateTimingCollector;
    },
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const [thread] = await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_zero_chat_callback_auto_send_load_thread",
      "nested",
      () => {
        return db
          .select({
            userId: chatThreads.userId,
            agentId: chatThreads.agentComposeId,
          })
          .from(chatThreads)
          .where(eq(chatThreads.id, args.chatThreadId))
          .limit(1);
      },
    );
    signal.throwIfAborted();
    if (!thread) {
      return;
    }
    const dependencies = set(buildChatCallbackDependencies$, { db });
    const createQueuedRun = dependencies.createQueuedRun;
    if (!createQueuedRun) {
      return;
    }
    const apiStartTime = now();
    await autoSendQueuedMessageForThread({
      db,
      chatThreadId: args.chatThreadId,
      userId: thread.userId,
      agentId: thread.agentId,
      queueItemCreatedBefore: args.queueItemCreatedBefore,
      timing: args.timing ?? new ChatCallbackPreCreateTimingCollector(),
      getResolvedAttachFiles: dependencies.getResolvedAttachFiles,
      signal,
      formatIntegrationRunError: dependencies.formatIntegrationRunError,
      deliverSlackAdmissionFailure: dependencies.deliverSlackAdmissionFailure,
      createRun: (input) => {
        return createQueuedChatRun({
          input,
          signal,
          createRun: (runInput) => {
            return createQueuedRun(
              runInput,
              runInput.apiStartTime ?? apiStartTime,
              signal,
            );
          },
        });
      },
    });
    signal.throwIfAborted();
  },
);

export const handleChatInternalCallback$ = command(
  async (
    { set },
    input: {
      readonly callback: InternalRunCallbackEnvelope;
      readonly drainThreadQueue?: ChatCallbackDependencies["drainThreadQueue"];
    },
    signal: AbortSignal,
  ): Promise<
    | { readonly success: true }
    | { readonly success: false; readonly error: string }
  > => {
    const db = set(writeDb$);
    const dependencies = set(buildChatCallbackDependencies$, {
      db,
      drainThreadQueue: input.drainThreadQueue,
    });
    return await handleChatInternalCallback({
      db,
      callback: input.callback,
      signal,
      dependencies,
    });
  },
);
