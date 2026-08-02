import { randomBytes } from "node:crypto";

import { command, createStore } from "ccstate";
import {
  CHAT_EVENT_TYPES,
  chatEventCompatibilityRole,
  type ChatEventType,
} from "@vm0/api-contracts/contracts/chat-events";
import { formatRunErrorForExternalSurface } from "@vm0/api-contracts/contracts/errors";
import type { TriggerSource } from "@vm0/api-contracts/contracts/logs";
import { modelProviderCredentialScopeSchema } from "@vm0/api-contracts/contracts/model-providers";
import { isFeatureEnabled } from "@vm0/core/feature-switch";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { agentRunCallbacks } from "@vm0/db/schema/agent-run-callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { runOutputMaterializations } from "@vm0/db/schema/run-output-materialization";
import {
  chatEventTerminalPredicate,
  chatEvents,
  type ChatEventAttachFileMetadata,
  type ChatEventGenerationTemplate,
  type ChatEventRecommendedFollowups,
  type ChatEventUserMessage,
} from "@vm0/db/schema/chat-event";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { morningBriefDeliveries } from "@vm0/db/schema/morning-brief";
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

import { nullableDriverValueDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { now, nowDate } from "../../lib/time";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  publishChatThreadDetailChangedSafely,
  publishChatThreadMessageCreatedSafely,
  publishThreadListChanged,
  publishThreadListChangedSafely,
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
  deliverAgentPhoneChatAdmissionFailure,
  dispatchAgentPhoneChatDeliveryOnce,
} from "./internal-agentphone-chat-run-callback.service";
import {
  deliverSlackChatAdmissionFailure,
  dispatchSlackChatDeliveryOnce,
} from "./internal-slack-chat-run-callback.service";
import {
  clearCanonicalFeishuThinkingReaction,
  dispatchFeishuChatDeliveryOnce,
} from "./internal-feishu-chat-run-callback.service";
import {
  deliverGitHubChatAdmissionFailure,
  dispatchGitHubChatDeliveryOnce,
} from "./internal-github-chat-run-callback.service";
import {
  deliverTeamsChatAdmissionFailure,
  dispatchTeamsChatDeliveryOnce,
} from "./internal-teams-chat-run-callback.service";
import {
  deliverTelegramChatAdmissionFailure,
  dispatchTelegramChatDeliveryOnce,
} from "./internal-telegram-chat-run-callback.service";
import {
  agentphoneDeliveryTargetSchema,
  type AgentPhoneDeliveryTarget,
} from "./agentphone-chat-callback-payload";
import {
  githubDeliveryTargetSchema,
  type GitHubDeliveryTarget,
} from "./github-chat-callback-payload";
import {
  teamsDeliveryTargetSchema,
  type TeamsDeliveryTarget,
} from "./teams-chat-callback-payload";
import {
  telegramDeliveryTargetSchema,
  type TelegramDeliveryTarget,
} from "./telegram-chat-callback-payload";
import {
  clearCanonicalSlackThreadStatusIfIdle,
  refreshCanonicalSlackThreadStatus,
  type CanonicalSlackThreadStatusTarget,
} from "./canonical-slack-thread-status.service";
import { saveRunSummary, saveRunSummary$ } from "./run-summary.service";
import type { ChatRunFinishedEvent } from "./chat-run-finished-workflow-event.service";
import {
  insertAssistantEvents,
  insertAssistantEvents$,
  runGroupIdForRun,
  touchChatThreadLastMessageAt,
  visibleChatEventCondition,
} from "./zero-chat-event-shared.service";
import { insertChatEvent } from "./zero-chat-event.service";
import { loadWebChatIncompleteContext } from "./zero-chat-incomplete-context.service";
import { chatThreadAdmissionBlocked } from "./zero-chat-active-run.service";
import {
  projectUserMessage,
  requiredUserMessageForEvent,
} from "./zero-chat-user-message.service";
import { appendQueuedRunAssistantMarker } from "./zero-chat-queue-marker.service";
import {
  integrationCompletionFallbackEventIdForRun,
  recommendedFollowupsEventIdForRun,
} from "./assistant-event-id";
import { attachCanonicalPublishedAssetsToCompletionEvent } from "./canonical-published-asset-event.service";
import {
  decryptQueuedUserMessageRunParams,
  discardUnclaimedUserMessageInTransaction,
  failQueuedUserMessage,
  loadNextUnclaimedQueuedUserMessage,
  resolveAttachFileMetadata$,
  type QueuedUserMessage,
} from "./zero-chat-queued-event.service";
import { handleMorningBriefEmailInternalCallback } from "./internal-morning-brief-run-callback.service";
import { sendUserPushNotifications } from "./zero-push-notifications.service";
import {
  type ChatCompletionContextMessage,
  generateChatThreadRecommendedFollowupsFromContext,
  generateChatNotificationSummary,
  loadChatThreadRecommendedFollowupContext,
  scheduleChatThreadTitleGeneration,
} from "./zero-chat-title.service";
import { createQueueFirstZeroRun$ } from "./zero-runs-create.service";
import { loadActiveGoalForThread } from "./zero-goal.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { formatIntegrationRunError$ } from "./integration-run-errors.service";
import { onRejection, settle, tapError, throwIfAbort } from "../utils";
import { resolveThreadGenerationTemplatePrompt } from "../routes/thread-generation-template";
import { resolveChatThreadSession } from "./chat-session-continuity.service";
import { loadComputerUseHostGrantForAutoSend } from "./zero-chat-computer-use-host.service";
import { resolveRunChatThreadModelContext } from "./zero-chat-run-event.service";
import { releaseThreadBrowsersForRun$ } from "./zero-browser.service";
import {
  resolveModelFirstProviderAdmission,
  type ModelFirstPin,
} from "./zero-model-selection.service";
import { chatEventTypeIn } from "./zero-chat-event-type.service";
import {
  loadSlackQueuedLaunchMaterial,
  type SlackQueuedLaunchMaterial,
} from "./slack-queued-launch-context.service";
import {
  loadFeishuQueuedLaunchMaterial,
  type FeishuQueuedLaunchMaterial,
} from "./feishu-queued-launch-context.service";
import {
  loadTeamsQueuedLaunchMaterial,
  type TeamsQueuedLaunchMaterial,
} from "./teams-queued-launch-context.service";
import {
  loadGitHubQueuedLaunchMaterial,
  type GitHubQueuedLaunchMaterial,
} from "./github-queued-launch-context.service";

const log = logger("callback:chat");
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
  | "api_dispatch_pre_create_zero_chat_callback_insert_assistant_items"
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
    triggerSource: QueuedUserMessage["triggerSource"] = "web",
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
  readonly triggerSource: QueuedUserMessage["triggerSource"];
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
        routeThreadTs: z.string().optional(),
      })
      .optional(),
    feishuDelivery: feishuDeliveryTargetSchema.optional(),
    teamsDelivery: teamsDeliveryTargetSchema.optional(),
    telegramDelivery: telegramDeliveryTargetSchema.optional(),
    agentphoneDelivery: agentphoneDeliveryTargetSchema.optional(),
    githubDelivery: githubDeliveryTargetSchema.optional(),
    // Retain while callbacks created by this version can be dispatched by
    // rollback-eligible API versions that still gate pushes by run origin.
    isGoalRun: z.boolean().optional(),
  })
  .passthrough();

type ChatCallbackPayload = z.infer<typeof chatCallbackPayloadSchema>;

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

interface DbCompletedChatOutputState {
  readonly kind: "complete" | "incomplete";
  readonly latestAssistant: AssistantEventItem | null;
  readonly resultFallback: ResultEventItem | null;
}

interface CompletedChatOutputLoad {
  readonly assistantItemsToInsert: readonly AssistantEventItem[];
  readonly latestAssistant: AssistantEventItem | null;
  readonly resultFallback: ResultEventItem | null;
}

interface PriorRunEvent {
  readonly eventType: ChatEventType;
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly userMessage: ChatEventUserMessage | null;
  readonly attachFiles: readonly string[] | null;
  readonly generationTemplate: ChatEventGenerationTemplate | null;
}

interface PriorRun {
  readonly runId: string;
  readonly status: string;
  readonly prompt: string;
  readonly events: readonly PriorRunEvent[];
}

interface AgentForAutoSend {
  readonly id: string;
  readonly orgId: string;
}

type CreatedQueuedRun = {
  readonly runId: string;
  readonly status: "queued" | "pending" | "running";
  readonly claimedEventCreatedAt: Date;
};

type CreateQueuedRun = (
  input: CreateQueuedChatRunInput,
  admissionTime: number,
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
  readonly dispatchChatRunFinishedAutomations: (
    event: ChatRunFinishedEvent,
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
      readonly routeThreadTs?: string;
      readonly chatEventId: string;
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
  readonly dispatchTeamsDelivery: (
    callbackId: string,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverTeamsAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: TeamsDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchTelegramDelivery: (
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverTelegramAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: TelegramDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchAgentPhoneDelivery: (
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverAgentPhoneAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: AgentPhoneDeliveryTarget;
      readonly chatEventId: string;
    },
    signal: AbortSignal,
  ) => Promise<void>;
  readonly dispatchGitHubDelivery: (
    callbackId: string,
    status: "completed" | "failed",
    signal: AbortSignal,
  ) => Promise<void>;
  readonly deliverGitHubAdmissionFailure: (
    args: {
      readonly chatThreadId: string;
      readonly userId: string;
      readonly orgId: string;
      readonly agentId: string;
      readonly target: GitHubDeliveryTarget;
      readonly chatEventId: string;
    },
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
  readonly cancellationRecoveryCompleted: boolean | null;
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
  readonly triggerSource: QueuedUserMessage["triggerSource"];
  readonly attachFileMetadata: readonly ChatEventAttachFileMetadata[] | null;
  readonly realAgentInPreview?: boolean;
  readonly slackDelivery?: {
    readonly channelId: string;
    readonly threadTs: string;
    readonly routeThreadTs?: string;
  };
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly morningBriefDelivery?: {
    readonly deliveryId: string;
    readonly internalKind: "morning-brief:email";
    readonly secret: string;
    readonly payload: unknown;
  };
  readonly apiStartTime: number;
  readonly userInfoExtras?: {
    readonly slackDisplayName?: string;
    readonly slackUserId?: string;
    readonly feishuDisplayName?: string;
    readonly feishuOpenId?: string;
    readonly teamsUserDisplayName?: string;
    readonly teamsUserPrincipalName?: string;
    readonly teamsUserId?: string;
    readonly telegramDisplayName?: string;
    readonly telegramUsername?: string;
    readonly telegramUserId?: string;
    readonly telegramLanguage?: string;
    readonly agentphoneHandle?: string;
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
    readonly routeThreadTs?: string;
  };
  readonly error: QueuedMessageModelRouteError;
}

interface TeamsQueuedMessageAdmissionFailure {
  readonly kind: "teams_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly teamsDelivery: TeamsDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface MorningBriefQueuedMessageAdmissionFailure {
  readonly kind: "morning_brief_admission_failure";
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly morningBriefDelivery?: NonNullable<
    CreateQueuedChatRunInput["morningBriefDelivery"]
  >;
  readonly error: QueuedMessageModelRouteError;
}

interface TelegramQueuedMessageAdmissionFailure {
  readonly kind: "telegram_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly telegramDelivery: TelegramDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface AgentPhoneQueuedMessageAdmissionFailure {
  readonly kind: "agentphone_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly agentphoneDelivery: AgentPhoneDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

interface GitHubQueuedMessageAdmissionFailure {
  readonly kind: "github_admission_failure";
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
  readonly githubDelivery: GitHubDeliveryTarget;
  readonly error: QueuedMessageModelRouteError;
}

type QueuedMessageAdmissionFailure =
  | SlackQueuedMessageAdmissionFailure
  | TeamsQueuedMessageAdmissionFailure
  | TelegramQueuedMessageAdmissionFailure
  | AgentPhoneQueuedMessageAdmissionFailure
  | GitHubQueuedMessageAdmissionFailure
  | MorningBriefQueuedMessageAdmissionFailure;

type CompletedChatCallbackResult =
  | {
      readonly inserted: true;
      readonly lastResultText: string | null;
      readonly followupContext: readonly ChatCompletionContextMessage[];
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
      readonly teamsDeliveryCallbackId?: string;
      readonly telegramDeliveryCallbackId?: string;
      readonly agentphoneDeliveryCallbackId?: string;
      readonly githubDeliveryCallbackId?: string;
    }
  | { readonly inserted: false };

type FailedChatCallbackResult =
  | {
      readonly inserted: true;
      readonly displayErrorMessage: string;
      readonly slackDeliveryCallbackId?: string;
      readonly feishuDeliveryCallbackId?: string;
      readonly teamsDeliveryCallbackId?: string;
      readonly telegramDeliveryCallbackId?: string;
      readonly agentphoneDeliveryCallbackId?: string;
      readonly githubDeliveryCallbackId?: string;
    }
  | { readonly inserted: false };

interface TerminalChatCallbackWork {
  readonly shouldDrainThreadQueue: boolean;
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly teamsDeliveryCallbackId?: string;
  readonly telegramDeliveryCallbackId?: string;
  readonly agentphoneDeliveryCallbackId?: string;
  readonly githubDeliveryCallbackId?: string;
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
  admissionTime: number,
  dispatchFailedCallbacks?: DispatchFailedRunCallbacks,
) {
  return {
    auth: {
      tokenType: "session" as const,
      userId: input.userId,
      orgId: input.orgId,
      orgRole: "member" as const,
    },
    apiStartTime: input.apiStartTime,
    chatThreadId: input.threadId,
    computerUseHostId: input.computerUseHostGrant?.hostId,
    modelProviderId: input.modelPin.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      input.modelPin.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: input.modelPin.selectedModel ?? undefined,
    codexServiceTier: input.codexServiceTier,
    callbacks: [
      ...(input.morningBriefDelivery
        ? [
            {
              internalKind: input.morningBriefDelivery.internalKind,
              secret: input.morningBriefDelivery.secret,
              payload: input.morningBriefDelivery.payload,
            },
          ]
        : []),
      {
        internalKind: "chat" as const,
        secret: generateCallbackSecret(),
        payload: {
          threadId: input.threadId,
          agentId: input.agentId,
          queuedMessageId: input.queuedMessage.id,
          slackDelivery: input.slackDelivery,
          feishuDelivery: input.feishuDelivery,
          teamsDelivery: input.teamsDelivery,
          telegramDelivery: input.telegramDelivery,
          agentphoneDelivery: input.agentphoneDelivery,
          githubDelivery: input.githubDelivery,
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
      eventId: input.queuedMessage.id,
      orgId: input.orgId,
      userId: input.userId,
      admissionTime,
      attachFileMetadata: input.attachFileMetadata,
      ...(input.morningBriefDelivery
        ? {
            morningBriefDeliveryId: input.morningBriefDelivery.deliveryId,
          }
        : {}),
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
      modelProviderId: input.modelPin.modelProviderId,
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

async function latestEventBackedAssistantEvent(
  db: Db,
  runId: string,
  options: { readonly maxSequenceNumber?: number } = {},
): Promise<AssistantEventItem | null> {
  const [event] = await db
    .select({
      content: chatEvents.content,
      sequenceNumber: chatEvents.sequenceNumber,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(chatEvents.sequenceNumber),
        isNotNull(chatEvents.content),
        not(sql`${chatEvents.content} ~ '^[[:space:]]*$'`),
        ...(options.maxSequenceNumber === undefined
          ? []
          : [lte(chatEvents.sequenceNumber, options.maxSequenceNumber)]),
      ),
    )
    .orderBy(desc(chatEvents.sequenceNumber))
    .limit(1);

  if (!event || event.content === null || event.sequenceNumber === null) {
    return null;
  }
  return {
    content: event.content,
    sequenceNumber: event.sequenceNumber,
  };
}

async function loadDbCompletedChatOutputState(args: {
  readonly db: Db;
  readonly runId: string;
  readonly lastEventSequence: number | null;
}): Promise<DbCompletedChatOutputState> {
  if (args.lastEventSequence === null) {
    return {
      kind: "complete",
      latestAssistant: null,
      resultFallback: null,
    };
  }

  const [state] = await args.db
    .select({
      processedThroughSequence:
        runOutputMaterializations.processedThroughSequence,
      latestResultSequence: runOutputMaterializations.latestResultSequence,
      latestResultText: runOutputMaterializations.latestResultText,
    })
    .from(runOutputMaterializations)
    .where(eq(runOutputMaterializations.runId, args.runId))
    .limit(1);

  const latestAssistant = await latestEventBackedAssistantEvent(
    args.db,
    args.runId,
    { maxSequenceNumber: args.lastEventSequence },
  );
  const resultFallback =
    state?.latestResultSequence !== null &&
    state?.latestResultSequence !== undefined &&
    state.latestResultSequence <= args.lastEventSequence &&
    state.latestResultText !== null
      ? {
          sequenceNumber: state.latestResultSequence,
          content: state.latestResultText,
        }
      : null;
  return {
    kind:
      state && state.processedThroughSequence >= args.lastEventSequence
        ? "complete"
        : "incomplete",
    latestAssistant,
    resultFallback,
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

  if (dbOutputState.kind === "incomplete") {
    log.warn("Run output projection is incomplete at terminal callback", {
      runId: args.runId,
      lastEventSequence: args.lastEventSequence,
    });
  }

  return {
    assistantItemsToInsert: [],
    latestAssistant: dbOutputState.latestAssistant,
    resultFallback: dbOutputState.resultFallback,
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

  const [event] = await db
    .select({
      lastEventAt: max(chatEvents.createdAt).mapWith(
        nullableDriverValueDecoder(chatEvents.createdAt),
      ),
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(chatEvents.sequenceNumber),
      ),
    );
  if (!event?.lastEventAt) {
    return;
  }

  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "last_event_to_complete",
    durationMs: Math.max(
      0,
      run.completedAt.getTime() - event.lastEventAt.getTime(),
    ),
    success: true,
    runId,
  });
}

interface SlackDeliveryTarget {
  readonly channelId: string;
  readonly threadTs: string;
  readonly routeThreadTs?: string;
}

async function insertSlackChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: SlackDeliveryTarget;
  readonly chatEventId: string;
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
        ...args.target,
        chatEventId: args.chatEventId,
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
  readonly chatEventId: string;
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
        chatEventId: args.chatEventId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Feishu delivery callback");
  }
  return callback.id;
}

async function insertTeamsChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: TeamsDeliveryTarget;
  readonly chatEventId: string;
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
    throw new Error("Canonical Teams run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "teams:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Teams delivery callback");
  }
  return callback.id;
}

async function insertTelegramChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: TelegramDeliveryTarget;
  readonly chatEventId: string;
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
    throw new Error("Canonical Telegram run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "telegram:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical Telegram delivery callback");
  }
  return callback.id;
}

async function insertAgentPhoneChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: AgentPhoneDeliveryTarget;
  readonly chatEventId: string;
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
    throw new Error("Canonical AgentPhone run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "agentphone:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical AgentPhone delivery callback");
  }
  return callback.id;
}

async function insertGitHubChatDeliveryCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly sourceCallbackId?: string;
  readonly target: GitHubDeliveryTarget;
  readonly chatEventId: string;
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
    throw new Error("Canonical GitHub run is missing its chat callback");
  }

  const [callback] = await args.db
    .insert(agentRunCallbacks)
    .values({
      runId: args.runId,
      internalKind: "github:chat",
      encryptedSecret: sourceCallback.encryptedSecret,
      payload: {
        ...args.target,
        chatEventId: args.chatEventId,
      },
    })
    .returning({ id: agentRunCallbacks.id });
  if (!callback) {
    throw new Error("Failed to persist canonical GitHub delivery callback");
  }
  return callback.id;
}

async function insertAssistantErrorEvent(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly lifecycleEvent: "failed" | "cancelled";
  readonly hasCancellationRecoveryState: boolean;
  readonly getFormattedError: () => Promise<string>;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<FailedChatCallbackResult> {
  const displayErrorMessage = await args.getFormattedError();
  const runGroupId = await runGroupIdForRun(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    const event = await insertChatEvent(
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
    if (!event) {
      return null;
    }
    const slackDeliveryCallbackId = args.slackDelivery
      ? await insertSlackChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.slackDelivery,
          chatEventId: event.id,
        })
      : undefined;
    const feishuDeliveryCallbackId = args.feishuDelivery
      ? await insertFeishuChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.feishuDelivery,
          chatEventId: event.id,
        })
      : undefined;
    const teamsDeliveryCallbackId = args.teamsDelivery
      ? await insertTeamsChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.teamsDelivery,
          chatEventId: event.id,
        })
      : undefined;
    const telegramDeliveryCallbackId = args.telegramDelivery
      ? await insertTelegramChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.telegramDelivery,
          chatEventId: event.id,
        })
      : undefined;
    const agentphoneDeliveryCallbackId = args.agentphoneDelivery
      ? await insertAgentPhoneChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.agentphoneDelivery,
          chatEventId: event.id,
        })
      : undefined;
    const githubDeliveryCallbackId = args.githubDelivery
      ? await insertGitHubChatDeliveryCallback({
          db: tx,
          runId: args.runId,
          sourceCallbackId: args.sourceCallbackId,
          target: args.githubDelivery,
          chatEventId: event.id,
        })
      : undefined;
    await touchChatThreadLastMessageAt(tx, args.threadId, event.createdAt);
    return {
      slackDeliveryCallbackId,
      feishuDeliveryCallbackId,
      teamsDeliveryCallbackId,
      telegramDeliveryCallbackId,
      agentphoneDeliveryCallbackId,
      githubDeliveryCallbackId,
    };
  });
  if (!inserted) {
    return { inserted: false };
  }

  await publishChatThreadMessageCreatedSafely(args.userId, args.threadId);
  await publishThreadListChangedSafely(args.userId);
  if (
    args.lifecycleEvent === "cancelled" &&
    args.hasCancellationRecoveryState
  ) {
    await publishChatThreadDetailChangedSafely(args.userId, args.threadId);
  }
  return {
    displayErrorMessage,
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: inserted.githubDeliveryCallbackId,
  };
}

type ChatCallbackTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

interface CanonicalDeliveryEvent {
  readonly id: string;
}

async function teamsRunLifecycleMarkerExists(
  db: ChatCallbackTransaction,
  runId: string,
): Promise<boolean> {
  const [marker] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTerminalPredicate(chatEvents.eventType),
      ),
    )
    .limit(1);
  return marker !== undefined;
}

async function loadCanonicalDeliveryEvent(
  db: ChatCallbackTransaction,
  runId: string,
  enabled: boolean,
): Promise<CanonicalDeliveryEvent | undefined> {
  if (!enabled) {
    return undefined;
  }
  const [event] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["output.message"]),
        isNotNull(chatEvents.content),
        isNotNull(chatEvents.sequenceNumber),
      ),
    )
    .orderBy(desc(chatEvents.sequenceNumber))
    .limit(1);
  return event;
}

async function insertIntegrationCompletionFallback(args: {
  readonly db: ChatCallbackTransaction;
  readonly runId: string;
  readonly threadId: string;
  readonly runGroupId: string | null | undefined;
  readonly createdAt: Date;
}): Promise<CanonicalDeliveryEvent> {
  const eventId = integrationCompletionFallbackEventIdForRun(args.runId);
  const inserted = await insertChatEvent(
    args.db,
    {
      id: eventId,
      chatThreadId: args.threadId,
      eventType: "output.message",
      content: "Task completed successfully.",
      runId: args.runId,
      runGroupId: args.runGroupId,
      createdAt: args.createdAt,
    },
    "id",
  );
  if (inserted) {
    return { id: inserted.id };
  }
  const [existing] = await args.db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(eq(chatEvents.id, eventId))
    .limit(1);
  if (!existing) {
    throw new Error("Failed to persist integration completion fallback");
  }
  return existing;
}

interface RunLifecycleMarkerArgs {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly event: "completed" | "cancelled";
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
}

interface RunLifecycleDeliveryCallbacks {
  readonly slackDeliveryCallbackId?: string;
  readonly feishuDeliveryCallbackId?: string;
  readonly teamsDeliveryCallbackId?: string;
  readonly telegramDeliveryCallbackId?: string;
  readonly agentphoneDeliveryCallbackId?: string;
  readonly githubDeliveryCallbackId?: string;
}

function hasCanonicalIntegrationDelivery(
  args: RunLifecycleMarkerArgs,
): boolean {
  return Boolean(
    args.slackDelivery ||
    args.feishuDelivery ||
    args.teamsDelivery ||
    args.telegramDelivery ||
    args.agentphoneDelivery ||
    args.githubDelivery,
  );
}

function requiresIntegrationCompletionFallback(
  args: RunLifecycleMarkerArgs,
): boolean {
  return (
    args.event === "completed" &&
    Boolean(
      args.teamsDelivery ||
      args.telegramDelivery ||
      args.agentphoneDelivery ||
      args.githubDelivery,
    )
  );
}

async function insertRunLifecycleMarkerTransaction(args: {
  readonly tx: ChatCallbackTransaction;
  readonly input: RunLifecycleMarkerArgs;
  readonly markerCreatedAt: Date;
  readonly runGroupId: string | undefined;
}): Promise<RunLifecycleDeliveryCallbacks | null> {
  const { input } = args;
  if (
    input.teamsDelivery &&
    (await teamsRunLifecycleMarkerExists(args.tx, input.runId))
  ) {
    return null;
  }
  let deliveryEvent = await loadCanonicalDeliveryEvent(
    args.tx,
    input.runId,
    hasCanonicalIntegrationDelivery(input),
  );
  if (!deliveryEvent && requiresIntegrationCompletionFallback(input)) {
    deliveryEvent = await insertIntegrationCompletionFallback({
      db: args.tx,
      runId: input.runId,
      threadId: input.threadId,
      runGroupId: args.runGroupId,
      createdAt: args.markerCreatedAt,
    });
  }
  const marker = await insertChatEvent(
    args.tx,
    {
      chatThreadId: input.threadId,
      eventType:
        input.event === "completed" ? "run.completed" : "run.cancelled",
      content: null,
      runId: input.runId,
      runGroupId: args.runGroupId,
      createdAt: args.markerCreatedAt,
    },
    "run-lifecycle",
  );
  if (!marker) {
    return null;
  }
  if (input.event === "completed") {
    await attachCanonicalPublishedAssetsToCompletionEvent(args.tx, {
      runId: input.runId,
      threadId: input.threadId,
      completedEventId: marker.id,
    });
  }
  const slackDeliveryCallbackId =
    deliveryEvent && input.slackDelivery
      ? await insertSlackChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.slackDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const feishuDeliveryCallbackId =
    deliveryEvent && input.feishuDelivery
      ? await insertFeishuChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.feishuDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const teamsDeliveryCallbackId =
    deliveryEvent && input.teamsDelivery
      ? await insertTeamsChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.teamsDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const telegramDeliveryCallbackId =
    deliveryEvent && input.telegramDelivery
      ? await insertTelegramChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.telegramDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const agentphoneDeliveryCallbackId =
    deliveryEvent && input.agentphoneDelivery
      ? await insertAgentPhoneChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.agentphoneDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  const githubDeliveryCallbackId =
    deliveryEvent && input.githubDelivery
      ? await insertGitHubChatDeliveryCallback({
          db: args.tx,
          runId: input.runId,
          sourceCallbackId: input.sourceCallbackId,
          target: input.githubDelivery,
          chatEventId: deliveryEvent.id,
        })
      : undefined;
  await touchChatThreadLastMessageAt(
    args.tx,
    input.threadId,
    args.markerCreatedAt,
  );
  return {
    slackDeliveryCallbackId,
    feishuDeliveryCallbackId,
    teamsDeliveryCallbackId,
    telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId,
  };
}

async function insertRunLifecycleMarker(
  args: RunLifecycleMarkerArgs,
): Promise<
  | { readonly inserted: false }
  | ({ readonly inserted: true } & RunLifecycleDeliveryCallbacks)
> {
  const markerCreatedAt = nowDate();
  const runGroupId = await runGroupIdForRun(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    return await insertRunLifecycleMarkerTransaction({
      tx,
      input: args,
      markerCreatedAt,
      runGroupId,
    });
  });
  if (!inserted) {
    return { inserted: false };
  }
  await publishChatThreadMessageCreatedSafely(args.userId, args.threadId);
  await publishThreadListChangedSafely(args.userId);
  return {
    inserted: true,
    slackDeliveryCallbackId: inserted.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: inserted.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: inserted.githubDeliveryCallbackId,
  };
}

async function insertRecommendedFollowupsEvent(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly recommendedFollowups: ChatEventRecommendedFollowups;
}): Promise<boolean> {
  const runGroupId = await runGroupIdForRun(args.db, args.runId);
  const inserted = await args.db.transaction(async (tx) => {
    return await insertChatEvent(
      tx,
      {
        id: recommendedFollowupsEventIdForRun(args.runId),
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
}): Promise<ChatEventRecommendedFollowups | undefined> {
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
  readonly signal: AbortSignal;
}): Promise<readonly ChatCompletionContextMessage[]> {
  return (
    (await tapError(
      loadChatThreadRecommendedFollowupContext({
        db: args.db,
        threadId: args.threadId,
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
  readonly output: CompletedChatOutputLoad;
  readonly preferResultFallback: boolean;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly insertAssistantItems: (
    items: readonly AssistantEventItem[],
  ) => Promise<void>;
}): Promise<string | null> {
  const { assistantItemsToInsert, latestAssistant, resultFallback } =
    args.output;
  if (assistantItemsToInsert.length > 0) {
    await measureChatCallbackPreCreateTiming(
      args.timing,
      "api_dispatch_pre_create_zero_chat_callback_insert_assistant_items",
      "nested",
      () => {
        return args.insertAssistantItems(assistantItemsToInsert);
      },
    );
    args.signal.throwIfAborted();
  }
  let lastResultText = latestAssistant?.content ?? null;
  const latestAssistantSequence = latestAssistant?.sequenceNumber ?? null;

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
  readonly signal: AbortSignal;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
  readonly insertAssistantItems: (
    items: readonly AssistantEventItem[],
  ) => Promise<void>;
}): Promise<CompletedChatCallbackResult> {
  const output = await loadCompletedChatOutput({
    db: args.db,
    runId: args.runId,
    lastEventSequence: args.run.lastEventSequence,
    timing: args.timing,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  const lastResultText = await materializeCompletedChatResult({
    output,
    preferResultFallback:
      args.slackDelivery !== undefined ||
      args.teamsDelivery !== undefined ||
      args.telegramDelivery !== undefined ||
      args.agentphoneDelivery !== undefined ||
      args.githubDelivery !== undefined,
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
        teamsDelivery: args.teamsDelivery,
        telegramDelivery: args.telegramDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        githubDelivery: args.githubDelivery,
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
    teamsDeliveryCallbackId: inserted.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: inserted.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: inserted.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: inserted.githubDeliveryCallbackId,
  };
}

async function runCompletedChatCallbackSideEffects(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly suppressWebPushForActiveGoal: boolean;
  readonly lastResultText: string | null;
  readonly followupContext: readonly ChatCompletionContextMessage[];
  readonly signal: AbortSignal;
  readonly saveRunSummary: (resultText: string) => Promise<void>;
  readonly dispatchChatRunFinishedAutomations: ChatCallbackDependencies["dispatchChatRunFinishedAutomations"];
}): Promise<void> {
  // The post-processing steps are mutually independent. Run them after queued
  // auto-send so LLM/push latency does not delay the next run.
  const saveSummaryStep = args.saveRunSummary(args.lastResultText ?? "");

  const chatRunFinishedStep = args.dispatchChatRunFinishedAutomations(
    {
      chatThreadId: args.chatThread.chatThreadId,
      runId: args.runId,
      runStatus: "completed",
      lastResultText: args.lastResultText,
    },
    args.signal,
  );

  const followupsStep = (async () => {
    const recommendedFollowups =
      await generateRecommendedFollowupsForCompletedRun({
        followupContext: args.followupContext,
        threadId: args.chatThread.chatThreadId,
        signal: args.signal,
      });
    if (recommendedFollowups) {
      await insertRecommendedFollowupsEvent({
        db: args.db,
        runId: args.runId,
        threadId: args.chatThread.chatThreadId,
        userId: args.chatThread.userId,
        recommendedFollowups,
      });
    }
  })();

  const pushStep = (async () => {
    if (args.suppressWebPushForActiveGoal) {
      return;
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
    chatRunFinishedStep,
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
  readonly hasCancellationRecoveryState: boolean;
  readonly getFormattedError: () => Promise<string>;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<FailedChatCallbackResult> {
  const lifecycleEvent =
    args.errorMessage.trim().toLowerCase() === "run cancelled"
      ? "cancelled"
      : "failed";
  return await insertAssistantErrorEvent({
    db: args.db,
    runId: args.runId,
    threadId: args.chatThread.chatThreadId,
    userId: args.chatThread.userId,
    lifecycleEvent,
    hasCancellationRecoveryState: args.hasCancellationRecoveryState,
    getFormattedError: args.getFormattedError,
    slackDelivery: args.slackDelivery,
    feishuDelivery: args.feishuDelivery,
    teamsDelivery: args.teamsDelivery,
    telegramDelivery: args.telegramDelivery,
    agentphoneDelivery: args.agentphoneDelivery,
    githubDelivery: args.githubDelivery,
    sourceCallbackId: args.sourceCallbackId,
  });
}

async function runFailedChatCallbackSideEffects(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly suppressWebPushForActiveGoal: boolean;
  readonly displayErrorMessage: string;
  readonly runStatus: "failed" | "cancelled";
  readonly signal: AbortSignal;
  readonly dispatchChatRunFinishedAutomations: ChatCallbackDependencies["dispatchChatRunFinishedAutomations"];
}): Promise<void> {
  const chatRunFinishedStep = args.dispatchChatRunFinishedAutomations(
    {
      chatThreadId: args.chatThread.chatThreadId,
      runId: args.runId,
      runStatus: args.runStatus,
      // Failed runs surface their error separately; patterns only ever match
      // assistant output, so terminal errors dispatch with no matchable text.
      lastResultText: null,
    },
    args.signal,
  );

  await chatRunFinishedStep;
  if (args.suppressWebPushForActiveGoal) {
    return;
  }

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

function formatPriorRunEvent(
  event: PriorRunEvent,
  inlineTemplatesEnabled: boolean,
): string {
  const roleLabel = event.role === "user" ? "User" : "Assistant";
  const userMessage = requiredUserMessageForEvent(
    event.eventType,
    event.userMessage,
  );
  if (userMessage) {
    const prompt = projectUserMessage(userMessage, {
      inlineTemplates: inlineTemplatesEnabled,
    }).agentPrompt;
    return `${roleLabel}: ${truncatePrior(prompt) || "[empty message]"}`;
  }
  const body = `${roleLabel}: ${
    event.content === null
      ? "[empty message]"
      : truncatePrior(event.content) || "[empty message]"
  }`;
  const attach = formatAttachFileIds(event.attachFiles);
  return attach ? `${body}\n${attach}` : body;
}

function priorRunsContextLabel(
  triggerSource: QueuedUserMessage["triggerSource"],
): string {
  switch (triggerSource) {
    case "slack": {
      return "Slack";
    }
    case "feishu": {
      return "Feishu";
    }
    case "teams": {
      return "Microsoft Teams";
    }
    case "telegram": {
      return "Telegram";
    }
    case "github": {
      return "GitHub";
    }
    case "workflow-schedule": {
      return "Workflow Automation";
    }
    default: {
      return "Web Chat";
    }
  }
}

function buildChatPriorRunsContext(
  runs: readonly PriorRun[],
  triggerSource: QueuedUserMessage["triggerSource"],
  inlineTemplatesEnabled: boolean,
): string {
  if (runs.length === 0) {
    return "";
  }
  const sections = runs.map((run, index) => {
    const renderedEvents = run.events.map((event) => {
      return formatPriorRunEvent(event, inlineTemplatesEnabled);
    });
    const transcript =
      renderedEvents.length > 0
        ? renderedEvents.join("\n\n")
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
    `# ${priorRunsContextLabel(triggerSource)} Run Context`,
    "The current CLI session is fresh, so recent visible chat rounds are provided here for continuity.",
    "- Treat the newest run below as the most recent prior round.",
    "- Use the LOG_COMMAND for a run if you need more detailed agent log context.",
    "",
    ...sections,
  ].join("\n");
}

async function getLatestRunsByThreadId(
  db: Db,
  threadId: string,
  triggerSource: QueuedUserMessage["triggerSource"],
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

  const eventRows = await db
    .select({
      runId: chatEvents.runId,
      eventType: chatEvents.eventType,
      content: chatEvents.content,
      userMessage: chatEvents.userMessage,
      attachFiles: chatEvents.attachFiles,
      createdAt: chatEvents.createdAt,
      sequenceNumber: chatEvents.sequenceNumber,
      generationTemplate: chatEvents.generationTemplate,
    })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.chatThreadId, threadId),
        or(
          and(
            chatEventTypeIn(["input.prompt", "input.rejected"]),
            isNotNull(chatEvents.userMessage),
          ),
          and(
            not(chatEventTypeIn(["input.prompt", "input.rejected"])),
            isNotNull(chatEvents.content),
          ),
        ),
        inArray(chatEvents.runId, runIds),
        chatEventTypeIn(CHAT_EVENT_TYPES),
        visibleChatEventCondition(db),
      ),
    )
    .orderBy(asc(chatEvents.seqId));

  const eventsByRunId = new Map<string, PriorRunEvent[]>();
  for (const row of eventRows) {
    if (row.runId === null) {
      continue;
    }
    const existing = eventsByRunId.get(row.runId) ?? [];
    existing.push({
      eventType: row.eventType,
      role: chatEventCompatibilityRole(row.eventType),
      content: row.content,
      userMessage: row.userMessage,
      attachFiles: row.attachFiles,
      generationTemplate: row.generationTemplate,
    });
    eventsByRunId.set(row.runId, existing);
  }

  return orderedRuns.map((run) => {
    return {
      runId: run.runId,
      status: run.status,
      prompt: run.prompt,
      events: eventsByRunId.get(run.runId) ?? [],
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

async function runHasActiveGoal(db: Db, runId: string): Promise<boolean> {
  const chatThread = await chatThreadForRunFromDb(db, runId);
  if (!chatThread) {
    return false;
  }
  const goal = await loadActiveGoalForThread(db, {
    orgId: chatThread.orgId,
    threadId: chatThread.chatThreadId,
  });
  return goal !== null;
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

async function buildQueuedPriorContext(args: {
  readonly db: Db;
  readonly threadId: string;
  readonly startNewSession: boolean;
  readonly incompleteContext: string;
  readonly triggerSource: QueuedUserMessage["triggerSource"];
  readonly inlineTemplatesEnabled: boolean;
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
    args.inlineTemplatesEnabled,
  );
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
    .from(chatEvents)
    .innerJoin(zeroRuns, eq(zeroRuns.id, chatEvents.runId))
    .where(
      and(
        eq(chatEvents.chatThreadId, args.threadId),
        chatEventTypeIn(["input.prompt"]),
        isNotNull(chatEvents.runId),
        eq(zeroRuns.triggerSource, "slack"),
      ),
    )
    .orderBy(asc(chatEvents.seqId))
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
  readonly threadId: string;
  readonly userId: string;
  readonly agent: AgentForAutoSend;
  readonly queuedMessage: QueuedUserMessage;
  readonly timing?: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly resolveAttachFileMetadata: (
    userId: string,
    attachFiles: readonly string[] | null,
    signal: AbortSignal,
  ) => Promise<ChatEventAttachFileMetadata[] | null>;
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
            modelProviderId: modelRoute.modelPin.modelProviderId,
            cliAgentType: modelRoute.cliAgentType,
          },
        }),
        loadUserFeatureSwitchContext(args.db, args.agent.orgId, args.userId),
      ]);
      const incompleteContext =
        args.queuedMessage.triggerSource === "web"
          ? await loadWebChatIncompleteContext(args.db, args.threadId)
          : "";
      return [
        sessionResolution.action === "rotated",
        incompleteContext,
        featureSwitchContext,
      ] as const;
    },
  );
}

type QueuedSourceParams = Awaited<
  ReturnType<typeof decryptQueuedUserMessageRunParams>
>;

type QueuedIntegrationDeliveries = Pick<
  CreateQueuedChatRunInput,
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
  | "githubDelivery"
  | "morningBriefDelivery"
>;

interface QueuedLaunchMaterial {
  readonly prompt: string;
  readonly appendSystemPrompt: string;
  readonly delivery: QueuedIntegrationDeliveries;
  readonly userInfoExtras?: CreateQueuedChatRunInput["userInfoExtras"];
}

interface QueuedLaunchLoaderArgs {
  readonly eventId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
}

type LaunchLoader = (
  db: Db,
  args: QueuedLaunchLoaderArgs,
) => Promise<QueuedLaunchMaterial | null>;

type NativeQueuedLaunchMaterial =
  | SlackQueuedLaunchMaterial
  | FeishuQueuedLaunchMaterial
  | TeamsQueuedLaunchMaterial
  | (GitHubQueuedLaunchMaterial & { readonly userInfoExtras?: undefined });

function launchLoader<Material extends NativeQueuedLaunchMaterial>(
  load: (db: Db, args: QueuedLaunchLoaderArgs) => Promise<Material | null>,
  delivery: (material: Material) => QueuedIntegrationDeliveries,
): LaunchLoader {
  return async (db, args) => {
    const material = await load(db, args);
    if (!material) {
      return null;
    }
    return {
      prompt: material.prompt,
      appendSystemPrompt: material.appendSystemPrompt,
      delivery: delivery(material),
      ...(material.userInfoExtras
        ? { userInfoExtras: material.userInfoExtras }
        : {}),
    };
  };
}

async function resolveQueuedLaunchMaterial(
  args: CreateQueuedChatRunInputArgs,
  sourceParams: QueuedSourceParams,
): Promise<QueuedLaunchMaterial | null> {
  const launchLoaders: Partial<Record<TriggerSource, LaunchLoader>> = {
    slack: launchLoader(loadSlackQueuedLaunchMaterial, (material) => {
      return { slackDelivery: material.slackDelivery };
    }),
    feishu: launchLoader(loadFeishuQueuedLaunchMaterial, (material) => {
      return { feishuDelivery: material.feishuDelivery };
    }),
    teams: launchLoader(loadTeamsQueuedLaunchMaterial, (material) => {
      return { teamsDelivery: material.teamsDelivery };
    }),
    github: launchLoader(loadGitHubQueuedLaunchMaterial, (material) => {
      return { githubDelivery: material.githubDelivery };
    }),
  };
  const load = launchLoaders[args.queuedMessage.triggerSource];
  if (!load) {
    return null;
  }
  const material = await load(args.db, {
    eventId: args.queuedMessage.id,
    chatThreadId: args.threadId,
    orgId: args.agent.orgId,
    userId: args.userId,
  });
  if (material) {
    return material;
  }
  if (
    args.queuedMessage.triggerSource === "github" &&
    sourceParams?.prompt !== undefined &&
    sourceParams.appendSystemPrompt !== undefined &&
    sourceParams.githubDelivery
  ) {
    return null;
  }
  throw new Error(
    `${args.queuedMessage.triggerSource} queue item is missing launch material`,
  );
}

type SourceParamDeliveryLoader = (
  sourceParams: QueuedSourceParams,
) => QueuedIntegrationDeliveries;

function queuedIntegrationDeliveries(
  triggerSource: QueuedUserMessage["triggerSource"],
  sourceParams: QueuedSourceParams,
  launchMaterial: QueuedLaunchMaterial | null,
): QueuedIntegrationDeliveries {
  const sourceParamDeliveryLoaders: Partial<
    Record<TriggerSource, SourceParamDeliveryLoader>
  > = {
    telegram: (params) => {
      return { telegramDelivery: params?.telegramDelivery };
    },
    agentphone: (params) => {
      return { agentphoneDelivery: params?.agentphoneDelivery };
    },
    github: (params) => {
      return { githubDelivery: params?.githubDelivery };
    },
    "workflow-schedule": (params) => {
      return { morningBriefDelivery: params?.morningBriefDelivery };
    },
  };
  return (
    launchMaterial?.delivery ??
    sourceParamDeliveryLoaders[triggerSource]?.(sourceParams) ??
    {}
  );
}

interface QueuedAdmissionFailureResolverArgs {
  readonly args: CreateQueuedChatRunInputArgs;
  readonly sourceParams: QueuedSourceParams;
  readonly launchMaterial: QueuedLaunchMaterial | null;
  readonly error: QueuedMessageModelRouteError;
}

type QueuedAdmissionFailureResolver = (
  args: QueuedAdmissionFailureResolverArgs,
) => QueuedMessageAdmissionFailure | null;

function slackQueuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  slackDelivery: CreateQueuedChatRunInput["slackDelivery"],
  error: QueuedMessageModelRouteError,
): SlackQueuedMessageAdmissionFailure | null {
  if (args.queuedMessage.triggerSource !== "slack" || !slackDelivery) {
    return null;
  }
  return {
    kind: "slack_admission_failure",
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    slackDelivery,
    error,
  };
}

function teamsQueuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  teamsDelivery: CreateQueuedChatRunInput["teamsDelivery"],
  error: QueuedMessageModelRouteError,
): TeamsQueuedMessageAdmissionFailure | null {
  if (args.queuedMessage.triggerSource !== "teams" || !teamsDelivery) {
    return null;
  }
  return {
    kind: "teams_admission_failure",
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    teamsDelivery,
    error,
  };
}

function morningBriefQueuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  sourceParams: Awaited<ReturnType<typeof decryptQueuedUserMessageRunParams>>,
  error: QueuedMessageModelRouteError,
): MorningBriefQueuedMessageAdmissionFailure | null {
  if (args.queuedMessage.triggerSource !== "workflow-schedule") {
    return null;
  }
  return {
    kind: "morning_brief_admission_failure",
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    morningBriefDelivery: sourceParams?.morningBriefDelivery,
    error,
  };
}

function telegramQueuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  sourceParams: Awaited<ReturnType<typeof decryptQueuedUserMessageRunParams>>,
  error: QueuedMessageModelRouteError,
): TelegramQueuedMessageAdmissionFailure | null {
  if (
    args.queuedMessage.triggerSource !== "telegram" ||
    !sourceParams?.telegramDelivery
  ) {
    return null;
  }
  return {
    kind: "telegram_admission_failure",
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    telegramDelivery: sourceParams.telegramDelivery,
    error,
  };
}

function agentPhoneQueuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  sourceParams: Awaited<ReturnType<typeof decryptQueuedUserMessageRunParams>>,
  error: QueuedMessageModelRouteError,
): AgentPhoneQueuedMessageAdmissionFailure | null {
  if (
    args.queuedMessage.triggerSource !== "agentphone" ||
    !sourceParams?.agentphoneDelivery
  ) {
    return null;
  }
  return {
    kind: "agentphone_admission_failure",
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    agentphoneDelivery: sourceParams.agentphoneDelivery,
    error,
  };
}

function githubQueuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  githubDelivery: CreateQueuedChatRunInput["githubDelivery"],
  error: QueuedMessageModelRouteError,
): GitHubQueuedMessageAdmissionFailure | null {
  if (args.queuedMessage.triggerSource !== "github" || !githubDelivery) {
    return null;
  }
  return {
    kind: "github_admission_failure",
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    threadId: args.threadId,
    queuedMessage: args.queuedMessage,
    githubDelivery,
    error,
  };
}

function queuedMessageAdmissionFailure(
  args: CreateQueuedChatRunInputArgs,
  sourceParams: QueuedSourceParams,
  launchMaterial: QueuedLaunchMaterial | null,
  error: QueuedMessageModelRouteError,
): QueuedMessageAdmissionFailure | null {
  const admissionFailureResolvers: Partial<
    Record<TriggerSource, QueuedAdmissionFailureResolver>
  > = {
    slack: (resolverArgs) => {
      return slackQueuedMessageAdmissionFailure(
        resolverArgs.args,
        resolverArgs.launchMaterial?.delivery.slackDelivery,
        resolverArgs.error,
      );
    },
    teams: (resolverArgs) => {
      return teamsQueuedMessageAdmissionFailure(
        resolverArgs.args,
        resolverArgs.launchMaterial?.delivery.teamsDelivery,
        resolverArgs.error,
      );
    },
    telegram: (resolverArgs) => {
      return telegramQueuedMessageAdmissionFailure(
        resolverArgs.args,
        resolverArgs.sourceParams,
        resolverArgs.error,
      );
    },
    agentphone: (resolverArgs) => {
      return agentPhoneQueuedMessageAdmissionFailure(
        resolverArgs.args,
        resolverArgs.sourceParams,
        resolverArgs.error,
      );
    },
    github: (resolverArgs) => {
      return githubQueuedMessageAdmissionFailure(
        resolverArgs.args,
        resolverArgs.launchMaterial?.delivery.githubDelivery ??
          resolverArgs.sourceParams?.githubDelivery,
        resolverArgs.error,
      );
    },
    "workflow-schedule": (resolverArgs) => {
      return morningBriefQueuedMessageAdmissionFailure(
        resolverArgs.args,
        resolverArgs.sourceParams,
        resolverArgs.error,
      );
    },
  };
  const resolve = admissionFailureResolvers[args.queuedMessage.triggerSource];
  return resolve?.({ args, sourceParams, launchMaterial, error }) ?? null;
}

function queuedMessagePrompt(args: {
  readonly triggerSource: QueuedUserMessage["triggerSource"];
  readonly launchMaterial: QueuedLaunchMaterial | null;
  readonly sourceParams: QueuedSourceParams;
  readonly projectedPrompt: string;
}): string {
  if (args.launchMaterial) {
    return args.launchMaterial.prompt;
  }
  if (args.triggerSource === "github") {
    return args.sourceParams?.prompt ?? "";
  }
  if (args.triggerSource === "workflow-schedule") {
    return args.sourceParams?.prompt ?? args.projectedPrompt;
  }
  return args.projectedPrompt;
}

function queuedIntegrationPrompt(args: {
  readonly launchMaterial: QueuedLaunchMaterial | null;
  readonly sourceParams: QueuedSourceParams;
}): string {
  return (
    args.launchMaterial?.appendSystemPrompt ??
    args.sourceParams?.appendSystemPrompt ??
    buildWebChatPrompt()
  );
}

function resolveQueuedMessageGenerationTemplatePrompt(args: {
  readonly input: CreateQueuedChatRunInputArgs;
  readonly userMessageProjection:
    | ReturnType<typeof projectUserMessage>
    | undefined;
  readonly inlineTemplatesEnabled: boolean;
}) {
  return measureChatCallbackPreCreateTiming(
    args.input.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_resolve_generation_template",
    "nested",
    () => {
      return resolveThreadGenerationTemplatePrompt({
        explicit:
          args.userMessageProjection?.generationTemplate ??
          args.input.queuedMessage.generationTemplate,
        explicitTemplates: args.inlineTemplatesEnabled
          ? args.userMessageProjection?.generationTemplates
          : undefined,
      });
    },
  );
}

async function loadQueuedRunMaterial(args: CreateQueuedChatRunInputArgs) {
  const sourceParams = await decryptQueuedUserMessageRunParams(
    args.queuedMessage.encryptedParams,
    { orgId: args.agent.orgId, userId: args.userId },
  );
  if (args.queuedMessage.triggerSource !== "web" && !sourceParams) {
    throw new Error("Canonical integration queue item is missing run params");
  }
  const launchMaterial = await resolveQueuedLaunchMaterial(args, sourceParams);
  return {
    sourceParams,
    launchMaterial,
  };
}

function queuedUserMessageProjection(
  message: QueuedUserMessage["userMessage"],
  inlineTemplatesEnabled: boolean,
) {
  const queuedUserMessage = requiredUserMessageForEvent(
    "input.prompt",
    message,
  );
  if (!queuedUserMessage) {
    throw new Error("Queued input event is missing userMessage");
  }
  return projectUserMessage(queuedUserMessage, {
    inlineTemplates: inlineTemplatesEnabled,
  });
}

function queuedIntegrationLaunchFields(
  triggerSource: QueuedUserMessage["triggerSource"],
  sourceParams: QueuedSourceParams,
  launchMaterial: QueuedLaunchMaterial | null,
) {
  return {
    ...queuedIntegrationDeliveries(triggerSource, sourceParams, launchMaterial),
    userInfoExtras:
      launchMaterial?.userInfoExtras ?? sourceParams?.userInfoExtras,
  };
}

async function buildCreateQueuedChatRunInput(
  args: CreateQueuedChatRunInputArgs,
): Promise<CreateQueuedChatRunInput | QueuedMessageAdmissionFailure | null> {
  const { sourceParams, launchMaterial } = await loadQueuedRunMaterial(args);
  const modelRouteResolution = await resolveQueuedMessageModelRoute({
    db: args.db,
    threadId: args.threadId,
    userId: args.userId,
    orgId: args.agent.orgId,
    triggerSource: args.queuedMessage.triggerSource,
    timing: args.timing,
  });
  if ("error" in modelRouteResolution) {
    return queuedMessageAdmissionFailure(
      args,
      sourceParams,
      launchMaterial,
      modelRouteResolution.error,
    );
  }
  const modelRoute = modelRouteResolution.route;

  const [startNewSession, loadedIncompleteContext, featureSwitchContext] =
    await loadQueuedMessageSessionState(args, modelRoute);
  const attachFileMetadata = await args.resolveAttachFileMetadata(
    args.userId,
    args.queuedMessage.attachFiles,
    args.signal,
  );
  args.signal.throwIfAborted();
  const inlineTemplatesEnabled = isFeatureEnabled(
    FeatureSwitchKey.StructuredPromptInlineTemplates,
    featureSwitchContext,
  );
  const userMessageProjection = queuedUserMessageProjection(
    args.queuedMessage.userMessage,
    inlineTemplatesEnabled,
  );
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
        inlineTemplatesEnabled,
      });
    },
  );
  const generationTemplatePrompt =
    await resolveQueuedMessageGenerationTemplatePrompt({
      input: args,
      userMessageProjection,
      inlineTemplatesEnabled,
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
  const prompt = queuedMessagePrompt({
    triggerSource: args.queuedMessage.triggerSource,
    launchMaterial,
    sourceParams,
    projectedPrompt: userMessageProjection.agentPrompt,
  });

  return {
    orgId: args.agent.orgId,
    userId: args.userId,
    agentId: args.agent.id,
    prompt,
    appendSystemPrompt: buildAppendSystemPrompt(
      queuedIntegrationPrompt({
        launchMaterial,
        sourceParams,
      }),
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
    attachFileMetadata,
    realAgentInPreview: isFeatureEnabled(
      FeatureSwitchKey.RealAgentInPreview,
      featureSwitchContext,
    ),
    ...queuedIntegrationLaunchFields(
      args.queuedMessage.triggerSource,
      sourceParams,
      launchMaterial,
    ),
    apiStartTime: args.queuedMessage.createdAt.getTime(),
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
        createdAfter: args.run.claimedEventCreatedAt,
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
    eventId: args.failure.queuedMessage.id,
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
        ...(args.failure.slackDelivery.routeThreadTs
          ? { routeThreadTs: args.failure.slackDelivery.routeThreadTs }
          : {}),
        chatEventId: failed.assistantEventId,
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

async function handleTeamsQueuedMessageAdmissionFailure(args: {
  readonly db: Db;
  readonly failure: TeamsQueuedMessageAdmissionFailure;
  readonly signal: AbortSignal;
  readonly formatError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliver: ChatCallbackDependencies["deliverTeamsAdmissionFailure"];
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
    eventId: args.failure.queuedMessage.id,
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
        target: args.failure.teamsDelivery,
        chatEventId: failed.assistantEventId,
      },
      args.signal,
    ),
    (error) => {
      log.warn("Failed to deliver canonical Teams admission error", {
        threadId: args.failure.threadId,
        error,
      });
    },
  );
}

async function handleTelegramQueuedMessageAdmissionFailure(args: {
  readonly db: Db;
  readonly failure: TelegramQueuedMessageAdmissionFailure;
  readonly signal: AbortSignal;
  readonly formatError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliver: ChatCallbackDependencies["deliverTelegramAdmissionFailure"];
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
    eventId: args.failure.queuedMessage.id,
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
        target: args.failure.telegramDelivery,
        chatEventId: failed.assistantEventId,
      },
      args.signal,
    ),
    (error) => {
      log.warn("Failed to deliver canonical Telegram admission error", {
        threadId: args.failure.threadId,
        error,
      });
    },
  );
}

async function handleAgentPhoneQueuedMessageAdmissionFailure(args: {
  readonly db: Db;
  readonly failure: AgentPhoneQueuedMessageAdmissionFailure;
  readonly signal: AbortSignal;
  readonly formatError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliver: ChatCallbackDependencies["deliverAgentPhoneAdmissionFailure"];
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
    eventId: args.failure.queuedMessage.id,
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
        target: args.failure.agentphoneDelivery,
        chatEventId: failed.assistantEventId,
      },
      args.signal,
    ),
    (error) => {
      log.warn("Failed to deliver canonical AgentPhone admission error", {
        threadId: args.failure.threadId,
        error,
      });
    },
  );
}

async function handleGitHubQueuedMessageAdmissionFailure(args: {
  readonly db: Db;
  readonly failure: GitHubQueuedMessageAdmissionFailure;
  readonly signal: AbortSignal;
  readonly formatError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliver: ChatCallbackDependencies["deliverGitHubAdmissionFailure"];
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
    eventId: args.failure.queuedMessage.id,
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
        target: args.failure.githubDelivery,
        chatEventId: failed.assistantEventId,
      },
      args.signal,
    ),
    (error) => {
      log.warn("Failed to deliver canonical GitHub admission error", {
        threadId: args.failure.threadId,
        error,
      });
    },
  );
}

async function handleQueuedMessageAdmissionFailure(args: {
  readonly db: Db;
  readonly failure: QueuedMessageAdmissionFailure;
  readonly signal: AbortSignal;
  readonly formatError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliverSlack: ChatCallbackDependencies["deliverSlackAdmissionFailure"];
  readonly deliverTeams: ChatCallbackDependencies["deliverTeamsAdmissionFailure"];
  readonly deliverTelegram: ChatCallbackDependencies["deliverTelegramAdmissionFailure"];
  readonly deliverAgentPhone: ChatCallbackDependencies["deliverAgentPhoneAdmissionFailure"];
  readonly deliverGitHub: ChatCallbackDependencies["deliverGitHubAdmissionFailure"];
  readonly continueDrain: () => Promise<void>;
}): Promise<void> {
  if (args.failure.kind === "slack_admission_failure") {
    await handleSlackQueuedMessageAdmissionFailure({
      db: args.db,
      failure: args.failure,
      signal: args.signal,
      formatError: args.formatError,
      deliver: args.deliverSlack,
    });
    return;
  }
  if (args.failure.kind === "telegram_admission_failure") {
    await handleTelegramQueuedMessageAdmissionFailure({
      db: args.db,
      failure: args.failure,
      signal: args.signal,
      formatError: args.formatError,
      deliver: args.deliverTelegram,
    });
    return;
  }
  if (args.failure.kind === "github_admission_failure") {
    await handleGitHubQueuedMessageAdmissionFailure({
      db: args.db,
      failure: args.failure,
      signal: args.signal,
      formatError: args.formatError,
      deliver: args.deliverGitHub,
    });
    return;
  }
  if (args.failure.kind === "teams_admission_failure") {
    await handleTeamsQueuedMessageAdmissionFailure({
      db: args.db,
      failure: args.failure,
      signal: args.signal,
      formatError: args.formatError,
      deliver: args.deliverTeams,
    });
    return;
  }
  if (args.failure.kind === "agentphone_admission_failure") {
    await handleAgentPhoneQueuedMessageAdmissionFailure({
      db: args.db,
      failure: args.failure,
      signal: args.signal,
      formatError: args.formatError,
      deliver: args.deliverAgentPhone,
    });
    return;
  }
  const failure = args.failure;
  await args.db.transaction(async (tx) => {
    const discarded = await discardUnclaimedUserMessageInTransaction(tx, {
      threadId: failure.threadId,
      eventId: failure.queuedMessage.id,
    });
    if (!discarded || !failure.morningBriefDelivery) {
      return;
    }
    const [delivery] = await tx
      .update(morningBriefDeliveries)
      .set({
        status: "failed",
        error: failure.error.message,
        updatedAt: nowDate(),
      })
      .where(
        eq(morningBriefDeliveries.id, failure.morningBriefDelivery.deliveryId),
      )
      .returning({ id: morningBriefDeliveries.id });
    if (!delivery) {
      throw new Error("Failed to record Morning Brief admission failure");
    }
  });
  args.signal.throwIfAborted();
  await args.continueDrain();
}

interface AutoSendQueuedMessageArgs {
  readonly admissionTime: number;
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
  readonly resolveAttachFileMetadata: CreateQueuedChatRunInputArgs["resolveAttachFileMetadata"];
  readonly formatIntegrationRunError: ChatCallbackDependencies["formatIntegrationRunError"];
  readonly deliverSlackAdmissionFailure: ChatCallbackDependencies["deliverSlackAdmissionFailure"];
  readonly deliverTeamsAdmissionFailure: ChatCallbackDependencies["deliverTeamsAdmissionFailure"];
  readonly deliverTelegramAdmissionFailure: ChatCallbackDependencies["deliverTelegramAdmissionFailure"];
  readonly deliverAgentPhoneAdmissionFailure: ChatCallbackDependencies["deliverAgentPhoneAdmissionFailure"];
  readonly deliverGitHubAdmissionFailure: ChatCallbackDependencies["deliverGitHubAdmissionFailure"];
}

function chatThreadAdmissionBlockedForAutoSend(
  args: AutoSendQueuedMessageArgs,
  threadId: string,
): Promise<boolean> {
  return chatThreadAdmissionBlocked(args.db, {
    threadId,
    apiStartTime: args.admissionTime,
  });
}

function autoSendAdmissionBlocked(
  args: AutoSendQueuedMessageArgs,
  threadId: string,
): Promise<boolean> {
  return measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_auto_send_check_active_run",
    "nested",
    () => {
      return chatThreadAdmissionBlockedForAutoSend(args, threadId);
    },
  );
}

/**
 * User-message half of the per-thread scheduler: when the thread has no
 * in-flight run, dispatch the oldest queued user message — whoever sent it.
 * The shared thread scheduler calls this before attempting the workflow-event
 * half, preserving user-message priority.
 */
async function autoSendQueuedMessageForThread(
  args: AutoSendQueuedMessageArgs,
): Promise<void> {
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
        threadId,
        userId,
        agent,
        queuedMessage,
        timing: args.timing,
        signal: args.signal,
        resolveAttachFileMetadata: args.resolveAttachFileMetadata,
      });
    },
  );
  if (!runInput) {
    return;
  }
  const activeRunExists = await autoSendAdmissionBlocked(args, threadId);
  if (activeRunExists) {
    return;
  }
  if ("kind" in runInput) {
    await handleQueuedMessageAdmissionFailure({
      db: args.db,
      failure: runInput,
      signal: args.signal,
      formatError: args.formatIntegrationRunError,
      deliverSlack: args.deliverSlackAdmissionFailure,
      deliverTeams: args.deliverTeamsAdmissionFailure,
      deliverTelegram: args.deliverTelegramAdmissionFailure,
      deliverAgentPhone: args.deliverAgentPhoneAdmissionFailure,
      deliverGitHub: args.deliverGitHubAdmissionFailure,
      continueDrain: async () => {
        await autoSendQueuedMessageForThread(args);
      },
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
    // Ingress channels never touch the web send route, so this is where their
    // threads get an eager title instead of waiting for the run to finish.
    scheduleChatThreadTitleGeneration({
      db: args.db,
      threadId,
      userId,
      orgId: runInput.orgId,
      prompt: runInput.prompt,
      includePriorRounds: true,
    });
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
      cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
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
  readonly suppressWebPushForActiveGoal: boolean;
  readonly dependencies: ChatCallbackDependencies;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
  readonly sourceCallbackId?: string;
}): Promise<TerminalChatCallbackWork> {
  const prepared = await measureChatCallbackPreCreateTiming(
    args.timing,
    "api_dispatch_pre_create_zero_chat_callback_prepare_completed",
    "top_level",
    async () => {
      const completed = await handleCompletedChatCallback({
        db: args.db,
        runId: args.runId,
        run: args.run,
        chatThread: args.chatThread,
        timing: args.timing,
        signal: args.signal,
        slackDelivery: args.slackDelivery,
        feishuDelivery: args.feishuDelivery,
        teamsDelivery: args.teamsDelivery,
        telegramDelivery: args.telegramDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        githubDelivery: args.githubDelivery,
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
      return completed;
    },
  );
  const completed = prepared;
  if (!completed.inserted) {
    return { shouldDrainThreadQueue: false };
  }

  return {
    shouldDrainThreadQueue: true,
    slackDeliveryCallbackId: completed.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: completed.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: completed.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: completed.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: completed.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: completed.githubDeliveryCallbackId,
    deferredSideEffects: () => {
      return runCompletedChatCallbackSideEffects({
        db: args.db,
        runId: args.runId,
        run: args.run,
        chatThread: args.chatThread,
        suppressWebPushForActiveGoal: args.suppressWebPushForActiveGoal,
        lastResultText: completed.lastResultText,
        followupContext: completed.followupContext,
        signal: args.signal,
        saveRunSummary: (resultText) => {
          return args.dependencies.saveRunSummary(
            args.runId,
            args.run.prompt,
            resultText,
            args.signal,
          );
        },
        dispatchChatRunFinishedAutomations:
          args.dependencies.dispatchChatRunFinishedAutomations,
      });
    },
  };
}

async function prepareFailedTerminalChatCallbackWork(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly suppressWebPushForActiveGoal: boolean;
  readonly errorMessage: string;
  readonly dependencies: ChatCallbackDependencies;
  readonly timing: ChatCallbackPreCreateTimingCollector;
  readonly signal: AbortSignal;
  readonly slackDelivery?: SlackDeliveryTarget;
  readonly feishuDelivery?: FeishuDeliveryTarget;
  readonly teamsDelivery?: TeamsDeliveryTarget;
  readonly telegramDelivery?: TelegramDeliveryTarget;
  readonly agentphoneDelivery?: AgentPhoneDeliveryTarget;
  readonly githubDelivery?: GitHubDeliveryTarget;
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
        hasCancellationRecoveryState:
          args.run.cancellationRecoveryCompleted !== null,
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
        teamsDelivery: args.teamsDelivery,
        telegramDelivery: args.telegramDelivery,
        agentphoneDelivery: args.agentphoneDelivery,
        githubDelivery: args.githubDelivery,
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
    teamsDeliveryCallbackId: failed.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: failed.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: failed.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: failed.githubDeliveryCallbackId,
    deferredSideEffects: () => {
      return runFailedChatCallbackSideEffects({
        db: args.db,
        runId: args.runId,
        run: args.run,
        chatThread: args.chatThread,
        suppressWebPushForActiveGoal: args.suppressWebPushForActiveGoal,
        displayErrorMessage: failed.displayErrorMessage,
        runStatus:
          args.errorMessage.trim().toLowerCase() === "run cancelled"
            ? "cancelled"
            : "failed",
        signal: args.signal,
        dispatchChatRunFinishedAutomations:
          args.dependencies.dispatchChatRunFinishedAutomations,
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
        ...(args.slackDelivery.routeThreadTs
          ? { routeThreadTs: args.slackDelivery.routeThreadTs }
          : {}),
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
  readonly status: "completed" | "failed";
  readonly slackDeliveryCallbackId: string | undefined;
  readonly feishuDeliveryCallbackId: string | undefined;
  readonly teamsDeliveryCallbackId: string | undefined;
  readonly telegramDeliveryCallbackId: string | undefined;
  readonly agentphoneDeliveryCallbackId: string | undefined;
  readonly githubDeliveryCallbackId: string | undefined;
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
  if (args.teamsDeliveryCallbackId) {
    const delivery = await settle(
      args.dependencies.dispatchTeamsDelivery(
        args.teamsDeliveryCallbackId,
        args.signal,
      ),
      args.signal,
    );
    if (!delivery.ok) {
      log.error("Failed to finalize canonical Teams delivery callback", {
        runId: args.runId,
        callbackId: args.teamsDeliveryCallbackId,
        error: delivery.error,
      });
    }
  }
  if (args.telegramDeliveryCallbackId) {
    const delivery = await settle(
      args.dependencies.dispatchTelegramDelivery(
        args.telegramDeliveryCallbackId,
        args.status,
        args.signal,
      ),
      args.signal,
    );
    if (!delivery.ok) {
      log.error("Failed to finalize canonical Telegram delivery callback", {
        runId: args.runId,
        callbackId: args.telegramDeliveryCallbackId,
        error: delivery.error,
      });
    }
  }
  if (args.agentphoneDeliveryCallbackId) {
    const delivery = await settle(
      args.dependencies.dispatchAgentPhoneDelivery(
        args.agentphoneDeliveryCallbackId,
        args.status,
        args.signal,
      ),
      args.signal,
    );
    if (!delivery.ok) {
      log.error("Failed to finalize canonical AgentPhone delivery callback", {
        runId: args.runId,
        callbackId: args.agentphoneDeliveryCallbackId,
        error: delivery.error,
      });
    }
  }
  if (args.githubDeliveryCallbackId) {
    const delivery = await settle(
      args.dependencies.dispatchGitHubDelivery(
        args.githubDeliveryCallbackId,
        args.status,
        args.signal,
      ),
      args.signal,
    );
    if (!delivery.ok) {
      log.error("Failed to finalize canonical GitHub delivery callback", {
        runId: args.runId,
        callbackId: args.githubDeliveryCallbackId,
        error: delivery.error,
      });
    }
  }
}

interface TerminalChatCallbackArgs {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly payload: ChatCallbackPayload;
  readonly suppressWebPushForActiveGoal: boolean;
  readonly dependencies: ChatCallbackDependencies;
  readonly signal: AbortSignal;
}

function terminalIntegrationDeliveries(
  payload: ChatCallbackPayload,
): Pick<
  ChatCallbackPayload,
  | "slackDelivery"
  | "feishuDelivery"
  | "teamsDelivery"
  | "telegramDelivery"
  | "agentphoneDelivery"
  | "githubDelivery"
> {
  return {
    slackDelivery: payload.slackDelivery,
    feishuDelivery: payload.feishuDelivery,
    teamsDelivery: payload.teamsDelivery,
    telegramDelivery: payload.telegramDelivery,
    agentphoneDelivery: payload.agentphoneDelivery,
    githubDelivery: payload.githubDelivery,
  };
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

  const prepared = await settle(
    callbackStatus === "completed"
      ? prepareCompletedTerminalChatCallbackWork({
          db: args.db,
          runId,
          run,
          chatThread,
          suppressWebPushForActiveGoal: args.suppressWebPushForActiveGoal,
          dependencies: args.dependencies,
          timing,
          signal: args.signal,
          ...terminalIntegrationDeliveries(args.payload),
          sourceCallbackId: args.callback.callbackId,
        })
      : prepareFailedTerminalChatCallbackWork({
          db: args.db,
          runId,
          run,
          chatThread,
          suppressWebPushForActiveGoal: args.suppressWebPushForActiveGoal,
          errorMessage: terminalCallbackErrorMessage(
            args.callback.error,
            run.error,
          ),
          dependencies: args.dependencies,
          timing,
          signal: args.signal,
          ...terminalIntegrationDeliveries(args.payload),
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
    status: callbackStatus,
    slackDeliveryCallbackId: work.slackDeliveryCallbackId,
    feishuDeliveryCallbackId: work.feishuDeliveryCallbackId,
    teamsDeliveryCallbackId: work.teamsDeliveryCallbackId,
    telegramDeliveryCallbackId: work.telegramDeliveryCallbackId,
    agentphoneDeliveryCallbackId: work.agentphoneDeliveryCallbackId,
    githubDeliveryCallbackId: work.githubDeliveryCallbackId,
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
    dispatchChatRunFinishedAutomations:
      dependencies.dispatchChatRunFinishedAutomations,
    formatRunError: dependencies.formatRunError,
    dispatchSlackDelivery: dependencies.dispatchSlackDelivery,
    clearSlackThreadStatusIfIdle: dependencies.clearSlackThreadStatusIfIdle,
    refreshSlackThreadStatus: dependencies.refreshSlackThreadStatus,
    formatIntegrationRunError: dependencies.formatIntegrationRunError,
    deliverSlackAdmissionFailure: dependencies.deliverSlackAdmissionFailure,
    deliverTeamsAdmissionFailure: dependencies.deliverTeamsAdmissionFailure,
    deliverTelegramAdmissionFailure:
      dependencies.deliverTelegramAdmissionFailure,
    deliverAgentPhoneAdmissionFailure:
      dependencies.deliverAgentPhoneAdmissionFailure,
    dispatchFeishuDelivery: dependencies.dispatchFeishuDelivery,
    dispatchTeamsDelivery: dependencies.dispatchTeamsDelivery,
    dispatchTelegramDelivery: dependencies.dispatchTelegramDelivery,
    dispatchAgentPhoneDelivery: dependencies.dispatchAgentPhoneDelivery,
    deliverGitHubAdmissionFailure: dependencies.deliverGitHubAdmissionFailure,
    dispatchGitHubDelivery: dependencies.dispatchGitHubDelivery,
    clearFeishuThinkingReaction: dependencies.clearFeishuThinkingReaction,
    drainThreadQueue: dependencies.drainThreadQueue,
  };
}

async function claimedUserMessageExistsForRun(
  db: Db,
  runId: string,
): Promise<boolean> {
  const [event] = await db
    .select({ id: chatEvents.id })
    .from(chatEvents)
    .where(
      and(
        eq(chatEvents.runId, runId),
        chatEventTypeIn(["input.prompt"]),
        isNotNull(chatEvents.revokesEventId),
      ),
    )
    .limit(1);
  return event !== undefined;
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
      teamsDelivery: args.runInput.teamsDelivery,
      telegramDelivery: args.runInput.telegramDelivery,
      agentphoneDelivery: args.runInput.agentphoneDelivery,
      githubDelivery: args.runInput.githubDelivery,
      morningBriefDelivery: args.runInput.morningBriefDelivery,
    };
    const suppressWebPushForActiveGoal = await runHasActiveGoal(db, runId);
    args.signal.throwIfAborted();
    await processTerminalChatCallback({
      db,
      callback: {
        runId,
        status: "failed",
        error,
        payload,
      },
      payload,
      suppressWebPushForActiveGoal,
      dependencies: withoutQueuedRunDependency(args.dependencies),
      signal: args.signal,
    });
    if (payload.morningBriefDelivery) {
      const deliveryResult = await handleMorningBriefEmailInternalCallback(db, {
        runId,
        status: "failed",
        error,
        payload: payload.morningBriefDelivery.payload,
      });
      if (!deliveryResult.success) {
        log.error("Failed to process Morning Brief dispatch-failed callback", {
          runId,
          error: deliveryResult.error,
        });
      }
    }
  };
}

async function handleChatInternalCallback(args: {
  readonly db: Db;
  readonly callback: InternalRunCallbackEnvelope;
  readonly dependencies: ChatCallbackDependencies;
  readonly signal: AbortSignal;
}): Promise<
  | { readonly success: true }
  | { readonly success: false; readonly error: string }
> {
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
              ...(payload.data.slackDelivery.routeThreadTs
                ? {
                    routeThreadTs: payload.data.slackDelivery.routeThreadTs,
                  }
                : {}),
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

  // Goal continuation runs after this callback is acknowledged and may pause a
  // failed goal before the background notification step starts. Snapshot the
  // goal state here so the Push decision reflects the moment the run ended.
  const suppressWebPushForActiveGoal = await runHasActiveGoal(
    args.db,
    args.callback.runId,
  );
  args.signal.throwIfAborted();

  // The webhook sender (dispatchRunCallbacks) awaits this response only to
  // record delivery; it does not retry and nothing downstream reads the body.
  // The frontend learns about new messages through Ably realtime signals, not
  // this HTTP response. So acknowledge immediately and run the heavy terminal
  // processing (message persistence, LLM generation, and push delivery) in the
  // background, mirroring webhooks-agent-complete. Use a
  // detached signal so request cancellation cannot interrupt the idempotency
  // marker -> queued auto-send sequence after the callback is acknowledged.
  const backgroundSignal = new AbortController().signal;
  waitUntil(
    tapError(
      processTerminalChatCallback({
        db: args.db,
        callback: args.callback,
        payload: payload.data,
        suppressWebPushForActiveGoal,
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

function teamsChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverTeamsAdmissionFailure" | "dispatchTeamsDelivery"
> {
  return {
    deliverTeamsAdmissionFailure: (params, signal) => {
      return deliverTeamsChatAdmissionFailure({ db, ...params, signal });
    },
    dispatchTeamsDelivery: (callbackId, signal) => {
      return dispatchTeamsChatDeliveryOnce(db, callbackId, signal);
    },
  };
}

function telegramChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverTelegramAdmissionFailure" | "dispatchTelegramDelivery"
> {
  return {
    deliverTelegramAdmissionFailure: (params, signal) => {
      return deliverTelegramChatAdmissionFailure({
        db,
        ...params,
        signal,
      });
    },
    dispatchTelegramDelivery: (callbackId, status, signal) => {
      return dispatchTelegramChatDeliveryOnce(db, callbackId, status, signal);
    },
  };
}

function agentPhoneChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverAgentPhoneAdmissionFailure" | "dispatchAgentPhoneDelivery"
> {
  return {
    deliverAgentPhoneAdmissionFailure: (params, signal) => {
      return deliverAgentPhoneChatAdmissionFailure({
        db,
        ...params,
        signal,
      });
    },
    dispatchAgentPhoneDelivery: (callbackId, status, signal) => {
      return dispatchAgentPhoneChatDeliveryOnce(db, callbackId, status, signal);
    },
  };
}

function githubChatDeliveryDependencies(
  db: Db,
): Pick<
  ChatCallbackDependencies,
  "deliverGitHubAdmissionFailure" | "dispatchGitHubDelivery"
> {
  return {
    deliverGitHubAdmissionFailure: (params, signal) => {
      return deliverGitHubChatAdmissionFailure({
        db,
        ...params,
        signal,
      });
    },
    dispatchGitHubDelivery: (callbackId, status, signal) => {
      return dispatchGitHubChatDeliveryOnce(db, callbackId, status, signal);
    },
  };
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
        await insertAssistantEvents(db, args, inputSignal);
      },
      saveRunSummary: (runId, prompt, resultText, inputSignal) => {
        return saveRunSummary(
          db,
          { runId, triggerSource: "chat", prompt, resultText },
          inputSignal,
        );
      },
      dispatchChatRunFinishedAutomations: async (event, inputSignal) => {
        const { dispatchChatRunFinishedWorkflowEvents$ } =
          await import("./chat-run-finished-workflow-event.service");
        return createStore().set(
          dispatchChatRunFinishedWorkflowEvents$,
          event,
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
      ...teamsChatDeliveryDependencies(db),
      ...telegramChatDeliveryDependencies(db),
      ...agentPhoneChatDeliveryDependencies(db),
      ...githubChatDeliveryDependencies(db),
      clearFeishuThinkingReaction: (target, inputSignal) => {
        return clearCanonicalFeishuThinkingReaction(db, target, inputSignal);
      },
    },
  });
}

const buildChatCallbackDependencies$ = command(
  (
    { set },
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
        await set(insertAssistantEvents$, args, inputSignal);
      },
      dispatchChatRunFinishedAutomations: async (event, inputSignal) => {
        // Imported lazily: the dispatcher reaches runWorkflowAutomationNow$,
        // whose queue-drain path imports this module back.
        const { dispatchChatRunFinishedWorkflowEvents$ } =
          await import("./chat-run-finished-workflow-event.service");
        return set(dispatchChatRunFinishedWorkflowEvents$, event, inputSignal);
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
      ...teamsChatDeliveryDependencies(db),
      ...telegramChatDeliveryDependencies(db),
      ...agentPhoneChatDeliveryDependencies(db),
      ...githubChatDeliveryDependencies(db),
      clearFeishuThinkingReaction: (target, inputSignal) => {
        return clearCanonicalFeishuThinkingReaction(db, target, inputSignal);
      },
      drainThreadQueue: input.drainThreadQueue,
    };
    const dependencies: ChatCallbackDependencies = {
      ...baseDependencies,
      createQueuedRun: async (runInput, admissionTime, inputSignal) => {
        const createArgs = buildQueuedCreateZeroRunArgs(
          runInput,
          admissionTime,
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
          claimedEventCreatedAt: runResult.queueFirstClaim.createdAt,
        };
      },
    };
    return dependencies;
  },
);

/** User-message drain used by the shared event-backed thread scheduler. */
export const drainQueuedUserMessagesForThread$ = command(
  async (
    { set },
    args: {
      readonly chatThreadId: string;
      readonly apiStartTime?: number;
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
    const admissionTime = args.apiStartTime ?? now();
    await autoSendQueuedMessageForThread({
      db,
      chatThreadId: args.chatThreadId,
      admissionTime,
      userId: thread.userId,
      agentId: thread.agentId,
      queueItemCreatedBefore: args.queueItemCreatedBefore,
      timing: args.timing ?? new ChatCallbackPreCreateTimingCollector(),
      signal,
      resolveAttachFileMetadata: (userId, attachFiles, inputSignal) => {
        return set(
          resolveAttachFileMetadata$,
          { userId, attachFiles },
          inputSignal,
        );
      },
      formatIntegrationRunError: dependencies.formatIntegrationRunError,
      deliverSlackAdmissionFailure: dependencies.deliverSlackAdmissionFailure,
      deliverTeamsAdmissionFailure: dependencies.deliverTeamsAdmissionFailure,
      deliverTelegramAdmissionFailure:
        dependencies.deliverTelegramAdmissionFailure,
      deliverAgentPhoneAdmissionFailure:
        dependencies.deliverAgentPhoneAdmissionFailure,
      deliverGitHubAdmissionFailure: dependencies.deliverGitHubAdmissionFailure,
      createRun: (input) => {
        return createQueuedChatRun({
          input,
          signal,
          createRun: (runInput) => {
            return createQueuedRun(runInput, admissionTime, signal);
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
