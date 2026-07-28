import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { animationFrame, delay } from "signal-timers";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { IN_VITEST } from "../../env.ts";
import {
  onRef,
  onRejection,
  resetSignal,
  setLoop,
  withCleanup,
} from "../utils.ts";
import { createHeaderAutomationSignals } from "./header-automation-menu.ts";
import { createThreadSidebarSignals } from "./thread-sidebar.ts";
import { createThreadSidebarAutoOpenCandidate } from "./thread-sidebar-auto-open.ts";
import { createWorkflowQueueSignals } from "./workflow-queue.ts";
import {
  createScrollSignals,
  type PrependScrollCompensationToken,
} from "../auto-scroll.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
} from "../zero-page/chat-draft.ts";
import { buildDraftPersistencePayload } from "../zero-page/draft-persistence.ts";
import {
  collectSuccessfulAttachmentInfos,
  prepareUserMessageFromDraft$,
  shouldExcludeVisualAttachmentsForModel,
} from "./resolve-draft-attachments.ts";
import {
  appendOptimisticChatMessage$,
  createOptimisticChatMessageEntry,
  createOptimisticChatMessagesForThread,
  reconcileOptimisticChatMessages$,
  type OptimisticChatMessageEntry,
  type OptimisticChatMessageInput,
} from "./optimistic-chat-messages.ts";
import type { ChatMessage } from "./chat-message-types.ts";
import {
  chatThreadArtifactsContract,
  type AttachFile,
  type GenerationTemplateRequest,
  type ChatThreadArtifactRun,
  type ChatEvent,
  type ChatPromptEvent,
  type ChatUserMessageEvent,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldActiveChatGoalObjective,
  foldLatestChatUsageByRunId,
  isChatRunTerminalEventType,
  revokedChatEventIds,
  terminatedChatRunIds,
} from "@vm0/api-contracts/contracts/chat-events";

import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { runOptionsFromModelProviderSelection } from "./model-selection-request.ts";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { captureTaskCompletedSuccessfully } from "../../lib/posthog.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import {
  codexFastModeEnabled$,
  featureSwitch$,
} from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import {
  writeChatMessageToClipboard,
  type ChatClipboardPayload,
} from "../zero-page/clipboard.ts";
import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
} from "./chat-message.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import { logger } from "../log.ts";
import {
  CHAT_MESSAGES_PAGE_LIMIT,
  createRemoteChatThreadDataSource,
} from "./remote-chat-thread-data-source.ts";
import {
  loadIndexedDbChatEvents$,
  writeIndexedDbChatEvents$,
} from "./chat-event-indexed-db.ts";
import { sendChatEvent } from "./chat-event-api.ts";
import {
  classifyChatAttachment,
  type BodyRenderBlock,
  type ParsedBodyBlock,
} from "./parse-body-blocks.ts";
import { parseMessageBodyBlocks } from "./chat-message-body-blocks.ts";
import {
  createArtifactCardSignalsRegistry,
  type ArtifactCardSignalsRegistry,
  type ArtifactSignals,
} from "./artifact-card-signals.ts";
import {
  createConnectorCardSignalsRegistry,
  createCustomConnectorCardSignalsRegistry,
  type ConnectorCardSignalsRegistry,
  type CustomConnectorCardSignalsRegistry,
} from "./connector-action-block.ts";
import {
  createPermissionCardSignalsRegistry,
  type PermissionCardSignalsRegistry,
} from "./permission-card-signals.ts";
import {
  createComputerUseAuthorizationCardSignalsRegistry,
  type ComputerUseAuthorizationCardSignalsRegistry,
} from "./computer-use-authorization-block.ts";
import {
  createPlanUpgradeCardSignalsRegistry,
  type PlanUpgradeCardSignalsRegistry,
} from "./plan-upgrade-block.ts";
import { getChatThreadTitleParts } from "./chat-thread-title.ts";
import {
  optimisticChatThreadCreateUnsettled,
  threadMeta,
  touchOptimisticChatThreadSort$,
  type ThreadMeta,
} from "./chat-thread-event-sourcing.ts";
import {
  previousRunGroupVisualWindowStartIndex,
  runGroupVisualWindowStartIndex,
} from "./run-group-folding.ts";
import { reloadBillingStatus$ } from "../zero-page/billing.ts";
import { subscribeComputerUseHostsChanged$ } from "../zero-page/computer-use-hosts.ts";
import { isCodexFastModeAvailableForSelection } from "../zero-page/model-default-selection.ts";
import { personalModelProvider$ } from "../zero-page/model-first-personal-oauth.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "../zero-page/settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "../zero-page/settings/codex-device-auth.ts";
import type {
  ChatThreadSignals,
  ComposerSendButtonStatus,
  MessageImageGroupProjection,
  QueueMessageOptions,
  QueuedChatMessageItem,
  RecommendedFollowupSource,
  SendMessageOptions,
  ThinkingIndicatorMode,
} from "./chat-thread-signals.ts";
import { createWorkflowComposerSignals } from "../zero-page/tiptap-workflow-composer.ts";
import {
  createMailDraftCardSignalsRegistry,
  type MailDraftCardSignalsRegistry,
  type MailDraftSignals,
} from "./mail-draft.ts";
import {
  createBrowserSessionCardSignalsRegistry,
  type BrowserSessionCardSignalsRegistry,
  type BrowserSessionSignals,
} from "./browser-session-block.ts";
import { createChatThreadContainerSignals } from "./chat-thread-container.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorAuthorizationSignals,
} from "../zero-page/zero-connectors.ts";
import {
  messageDocumentToDisplayText,
  messageDocumentToPrompt,
  shouldUseUserMessage,
  textToMessageDocument,
} from "../zero-page/user-message-document-codec.ts";

type ChatThreadRemote = ReturnType<typeof createRemoteChatThreadDataSource>;

export type { DraftSignals } from "../zero-page/chat-draft.ts";

const L = logger("ChatThread");

function createChatThreadScrollSignals(threadId: string) {
  return createScrollSignals(threadId, {
    observeViewportResizeOnMobile: true,
  });
}

type RecallControlEvent = Extract<
  ChatMessage,
  { eventType: "control.revoke" | "run.dequeued" }
>;

function isRecallControlMessage(msg: ChatMessage): msg is RecallControlEvent {
  return msg.eventType === "control.revoke" || msg.eventType === "run.dequeued";
}

function isQueueMarkerMessage(
  msg: ChatMessage,
): msg is Extract<ChatMessage, { eventType: "run.queued" }> {
  return msg.eventType === "run.queued";
}

function isGoalMarkerMessage(
  msg: ChatMessage,
): msg is Extract<ChatMessage, { eventType: "goal.changed" }> {
  return msg.eventType === "goal.changed";
}

function isUsageMessage(
  msg: ChatMessage,
): msg is Extract<ChatMessage, { eventType: "usage.recorded" }> {
  return msg.eventType === "usage.recorded";
}

function isAutomationQueueStateMessage(msg: ChatMessage): msg is Extract<
  ChatMessage,
  {
    eventType: "queue.automation_paused" | "queue.automation_resumed";
  }
> {
  return (
    msg.eventType === "queue.automation_paused" ||
    msg.eventType === "queue.automation_resumed"
  );
}

function isInterruptControlMessage(
  msg: ChatMessage,
): msg is Extract<ChatMessage, { eventType: "control.interrupt" }> {
  return msg.eventType === "control.interrupt";
}

function isInputChatEvent(
  msg: ChatMessage,
): msg is Extract<
  ChatMessage,
  { eventType: ChatUserMessageEvent["eventType"] }
> {
  return msg.eventType === "input.prompt" || msg.eventType === "input.rejected";
}

function chatEventAttachFiles(
  message: ChatMessage,
): ChatPromptEvent["attachFiles"] {
  return isInputChatEvent(message) ? message.attachFiles : undefined;
}

function createInterruptedAssistantProjection(
  message: Extract<ChatMessage, { eventType: "control.interrupt" }>,
  runId: string,
): ChatMessage {
  const { interruptsRunId, ...event } = message;
  void interruptsRunId;
  return {
    ...event,
    eventType: "run.cancelled" as const,
    content: "Run cancelled",
    runId,
    error: "Run cancelled",
    runLifecycleEvent: "cancelled",
  };
}

function completedRunIdsFromMessages(
  messages: readonly ChatMessage[],
): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.eventType === "run.completed" && message.runId !== undefined) {
      ids.add(message.runId);
    }
  }
  return Array.from(ids);
}

function isInterruptedAssistantCancellation(
  message: ChatMessage,
  interruptedRunIds: Set<string>,
): boolean {
  const runId = message.runId;
  return (
    runId !== undefined &&
    isCancelledRunEvent(message) &&
    interruptedRunIds.has(runId)
  );
}

// ---------------------------------------------------------------------------
// Thinking-indicator constants and helpers
// ---------------------------------------------------------------------------

const BLOCK_COLORS = [
  "#e8a0b4",
  "#c4705a",
  "#f5b88a",
  "#a8b560",
  "#6bb5a0",
  "#7baed4",
  "#b09eda",
  "#d4a87b",
  "#e07878",
  "#82c4c2",
] as const;

function shuffleBlockColors(): [string, string, string] {
  const shuffled = [...BLOCK_COLORS].sort(() => {
    return Math.random() - 0.5;
  });
  return [shuffled[0]!, shuffled[1]!, shuffled[2]!];
}

const THINKING_PHRASES = [
  "Brewing...",
  "Piecing together...",
  "Spinning up...",
  "On it...",
  "Assembling...",
  "Sketching out...",
  "Mapping it...",
  "Wiring up...",
  "Shaping...",
  "Tuning in...",
] as const;

const DONE_PHRASES = [
  (t: string) => {
    return `Wrapped up at ${t}`;
  },
  (t: string) => {
    return `All done — ${t}`;
  },
  (t: string) => {
    return `Delivered at ${t}`;
  },
  (t: string) => {
    return `Finished at ${t}, at your service`;
  },
  (t: string) => {
    return `That was a wrap — ${t}`;
  },
  (t: string) => {
    return `Mission complete, ${t}`;
  },
  (t: string) => {
    return `Signed off at ${t}`;
  },
  (t: string) => {
    return `Done and dusted — ${t}`;
  },
] as const;

function formatDonePhrase(lastMsg: ChatMessage | undefined): string {
  const time = lastMsg
    ? new Date(lastMsg.createdAt).toLocaleString("en-US", {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : "just now";
  const phraseIndex = lastMsg?.id
    ? lastMsg.id.charCodeAt(lastMsg.id.length - 1) % DONE_PHRASES.length
    : 0;
  const pick = DONE_PHRASES[phraseIndex]!;
  return pick(time);
}

function revokedMessageIdsFromRawMessages(
  raw: readonly ChatMessageProjectionEntry[],
): Set<string> {
  return revokedChatEventIds(
    raw.map((entry) => {
      return entry.message;
    }),
  );
}

function isRawOptimisticRunMessage(entry: ChatMessageProjectionEntry): boolean {
  const { message } = entry;
  return (
    message.eventType === "input.prompt" &&
    message.runId === undefined &&
    entry.optimisticUserMessageAssociation === "run"
  );
}

function terminatedRunIdsFromRawMessages(
  raw: readonly ChatMessageProjectionEntry[],
): Set<string> {
  return terminatedChatRunIds(
    raw.map((entry) => {
      return entry.message;
    }),
  );
}

type RunIndicatorState = "running" | "queued" | null;

function runActivityIndicatorState(
  terminatedRunIds: ReadonlySet<string>,
  runId: string,
): RunIndicatorState | undefined {
  if (terminatedRunIds.has(runId)) {
    return undefined;
  }
  return "running";
}

function assistantRunIndicatorState(
  terminatedRunIds: ReadonlySet<string>,
  message: ChatMessage,
): RunIndicatorState | undefined {
  const runId = message.runId;
  if (isQueueMarkerMessage(message)) {
    if (runId !== undefined && terminatedRunIds.has(runId)) {
      return undefined;
    }
    return "queued";
  }
  if (runId !== undefined && isChatRunTerminalEventType(message.eventType)) {
    return null;
  }
  if (runId === undefined) {
    return undefined;
  }
  return runActivityIndicatorState(terminatedRunIds, runId);
}

function nonAssistantRunIndicatorState(
  terminatedRunIds: ReadonlySet<string>,
  entry: ChatMessageProjectionEntry,
): RunIndicatorState | undefined {
  if (isRawOptimisticRunMessage(entry)) {
    return "running";
  }
  const { runId } = entry.message;
  return runId === undefined
    ? undefined
    : runActivityIndicatorState(terminatedRunIds, runId);
}

function visibleRunStartIndexByRunId(
  raw: readonly ChatMessageProjectionEntry[],
  revokedMessageIds: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  // Only a user message proves that a run started inside the loaded window;
  // the first visible assistant message may be mid-run after pagination.
  const runStartIndexByRunId = new Map<string, number>();
  for (let index = 0; index < raw.length; index++) {
    const message = raw[index]!.message;
    const runId = message.runId;
    if (
      (message.eventType !== "input.prompt" &&
        message.eventType !== "input.rejected") ||
      runId === undefined ||
      runStartIndexByRunId.has(runId) ||
      revokedMessageIds.has(message.id)
    ) {
      continue;
    }
    runStartIndexByRunId.set(runId, index);
  }
  return runStartIndexByRunId;
}

function laterStartedRunIndicatorState(
  raw: readonly ChatMessageProjectionEntry[],
  terminatedRunId: string,
  terminatedRunIds: ReadonlySet<string>,
  revokedMessageIds: ReadonlySet<string>,
  runStartIndexByRunId: ReadonlyMap<string, number>,
): RunIndicatorState | undefined {
  const terminatedRunStartIndex = runStartIndexByRunId.get(terminatedRunId);
  if (terminatedRunStartIndex === undefined) {
    return undefined;
  }

  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    const { message } = entry;
    const runId = message.runId;
    if (
      runId === undefined ||
      (runStartIndexByRunId.get(runId) ?? -1) <= terminatedRunStartIndex ||
      revokedMessageIds.has(message.id) ||
      isUsageMessage(message) ||
      isGoalMarkerMessage(message)
    ) {
      continue;
    }
    const state =
      chatEventCompatibilityRole(message.eventType) === "assistant"
        ? assistantRunIndicatorState(terminatedRunIds, message)
        : nonAssistantRunIndicatorState(terminatedRunIds, entry);
    if (state === "running" || state === "queued") {
      return state;
    }
  }
  return undefined;
}

function deriveRunIndicatorStateFromRawMessages(
  raw: readonly ChatMessageProjectionEntry[],
): RunIndicatorState {
  const revokedMessageIds = revokedMessageIdsFromRawMessages(raw);
  const terminatedRunIds = terminatedRunIdsFromRawMessages(raw);
  const runStartIndexByRunId = visibleRunStartIndexByRunId(
    raw,
    revokedMessageIds,
  );

  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    const { message } = entry;
    if (revokedMessageIds.has(message.id)) {
      continue;
    }
    if (isUsageMessage(message) || isGoalMarkerMessage(message)) {
      continue;
    }
    if (chatEventCompatibilityRole(message.eventType) === "assistant") {
      const state = assistantRunIndicatorState(terminatedRunIds, message);
      if (state === null && message.runId !== undefined) {
        const laterRunState = laterStartedRunIndicatorState(
          raw,
          message.runId,
          terminatedRunIds,
          revokedMessageIds,
          runStartIndexByRunId,
        );
        if (laterRunState !== undefined) {
          return laterRunState;
        }
      }
      if (state !== undefined) {
        return state;
      }
      continue;
    }
    const state = nonAssistantRunIndicatorState(terminatedRunIds, entry);
    if (state !== undefined) {
      return state;
    }
  }
  return null;
}

function liveRunIdsFromRawMessages(
  raw: readonly ChatMessageProjectionEntry[],
): string[] {
  const terminatedRunIds = terminatedRunIdsFromRawMessages(raw);
  const revokedMessageIds = revokedMessageIdsFromRawMessages(raw);
  const liveRunIds: string[] = [];
  const seenRunIds = new Set<string>();
  for (const { message } of raw) {
    const runId = message.runId;
    if (
      runId !== undefined &&
      !revokedMessageIds.has(message.id) &&
      !terminatedRunIds.has(runId) &&
      !isQueueMarkerMessage(message) &&
      !isUsageMessage(message) &&
      !isGoalMarkerMessage(message) &&
      !seenRunIds.has(runId)
    ) {
      liveRunIds.push(runId);
      seenRunIds.add(runId);
    }
  }
  return liveRunIds;
}

function cancellableRunIdsFromRawMessages(
  raw: readonly ChatMessageProjectionEntry[],
): string[] {
  return liveRunIdsFromRawMessages(raw);
}

// ---------------------------------------------------------------------------
// Sub-factory: remote thread draft fetching
// ---------------------------------------------------------------------------

function createRemoteThreadDraft(dataSource: ChatThreadRemote) {
  return dataSource.threadDraft$;
}

function createThreadMeta(threadId: string) {
  return threadMeta(threadId);
}

function createThreadTitleParts(threadMeta$: Computed<ThreadMeta | null>) {
  const threadTitle$ = computed((get): string | null => {
    return get(threadMeta$)?.title ?? null;
  });
  const threadTitleParts$ = computed((get) => {
    return getChatThreadTitleParts(get(threadTitle$));
  });
  const threadTitleEmoji$ = computed((get) => {
    return get(threadTitleParts$).emoji;
  });
  const threadTitleText$ = computed((get) => {
    return get(threadTitleParts$).text;
  });
  return { threadTitle$, threadTitleEmoji$, threadTitleText$ };
}

function createThreadSettledInServer(threadId: string) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return computed((get): boolean => {
    return !get(optimisticCreateUnsettled$);
  });
}

// ---------------------------------------------------------------------------
// Sub-factory: composer model override
// ---------------------------------------------------------------------------

function createModelSelection(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
  dataSource: ChatThreadRemote,
) {
  const selectedModel$ = computed((get): string | null => {
    const threadMeta = get(threadMeta$);
    return threadMeta?.selectedModel ?? null;
  });

  const setModelSelection$ = command(
    async (
      { set },
      value: ModelProviderSelection | null,
      signal: AbortSignal,
    ) => {
      await set(
        dataSource.patchModelSelection$,
        { threadId, modelSelection: value },
        signal,
      );
      signal.throwIfAborted();
    },
  );

  const codexFastModeActive$ = computed(async (get): Promise<boolean> => {
    if (!get(codexFastModeEnabled$)) {
      return false;
    }
    const selectedModel = await get(selectedModel$);
    const policies = await get(orgModelPolicies$);
    if (
      !isCodexFastModeAvailableForSelection({
        policies,
        selectedModel,
        codexFastModeEnabled: true,
      })
    ) {
      return false;
    }
    return get(threadMeta$)?.serviceTier === "priority";
  });

  const selectedModelOauthAvailable$ = computed(
    async (get): Promise<boolean> => {
      const selectedModel = await get(selectedModel$);
      if (selectedModel === null) {
        return true;
      }
      const status = (await get(personalModelProvider$))[selectedModel];
      return status === undefined || status.status === "connected";
    },
  );

  const configureSelectedModel$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const selectedModel = await get(selectedModel$);
      signal.throwIfAborted();
      if (selectedModel === null) {
        return;
      }
      const status = (await get(personalModelProvider$))[selectedModel];
      signal.throwIfAborted();
      if (status === undefined || status.status === "connected") {
        return;
      }
      const mode =
        status.status === "needs_reconnect" ? "reconnect" : "connect";
      if (status.providerType === "claude-code-oauth-token") {
        await set(openClaudeCodeDeviceAuthDialogPersonal$, mode, signal);
        return;
      }
      await set(openCodexDeviceAuthDialogPersonal$, mode, signal);
    },
  );

  return {
    selectedModel$,
    codexFastModeActive$,
    selectedModelOauthAvailable$,
    configureSelectedModel$,
    setModelSelection$,
  };
}

function createModelSelectionForSend({
  selectedModel$,
  codexFastModeActive$,
}: {
  selectedModel$: Computed<string | null>;
  codexFastModeActive$: Computed<Promise<boolean>>;
}) {
  return command(
    async (
      { get },
      signal: AbortSignal,
    ): Promise<ModelProviderSelection | null> => {
      const selectedModel = await get(selectedModel$);
      signal.throwIfAborted();
      if (!selectedModel) {
        return null;
      }
      const codexFastModeActive = await get(codexFastModeActive$);
      signal.throwIfAborted();
      return codexFastModeActive
        ? { selectedModel, codexServiceTier: "fast" }
        : { selectedModel };
    },
  );
}

// ---------------------------------------------------------------------------
// Sub-factory: composer Computer Use host selection
// ---------------------------------------------------------------------------

function createComputerUseHostSelection(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
  dataSource: ChatThreadRemote,
) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  const internalUserOverride$ = state<
    | { kind: "unset" }
    | {
        kind: "set";
        computerUseHostId: string | null;
        cloudBrowserEnabled: boolean;
        dirty: boolean;
      }
  >({ kind: "unset" });

  const computerUseHostId$ = computed((get): string | null => {
    const user = get(internalUserOverride$);
    if (user.kind === "set") {
      return user.computerUseHostId;
    }
    return get(threadMeta$)?.computerUseHostId ?? null;
  });

  const cloudBrowserEnabled$ = computed((get): boolean => {
    const user = get(internalUserOverride$);
    if (user.kind === "set") {
      return user.cloudBrowserEnabled;
    }
    return get(threadMeta$)?.cloudBrowserEnabled ?? false;
  });

  const computerUseHostIdExplicit$ = computed((get): boolean => {
    const user = get(internalUserOverride$);
    return user.kind === "set" && user.dirty;
  });

  const setComputerAccess$ = command(
    async (
      { get, set },
      selection: {
        readonly computerUseHostId: string | null;
        readonly cloudBrowserEnabled: boolean;
      },
      signal: AbortSignal,
    ) => {
      set(internalUserOverride$, {
        kind: "set",
        ...selection,
        dirty: true,
      });
      if (get(optimisticCreateUnsettled$)) {
        L.debug(
          "setComputerUseHostId$ optimistic thread create unsettled, skip",
          { threadId },
        );
        return;
      }

      await onRejection(
        set(
          dataSource.patchComputerUseHost$,
          { threadId, ...selection },
          signal,
        ),
        () => {
          if (!signal.aborted) {
            set(internalUserOverride$, {
              kind: "set",
              ...selection,
              dirty: false,
            });
          }
        },
      );
      signal.throwIfAborted();
      set(internalUserOverride$, {
        kind: "unset",
      });
    },
  );

  const setComputerUseHostId$ = command(
    async (
      { get, set },
      computerUseHostId: string | null,
      signal: AbortSignal,
    ) => {
      await set(
        setComputerAccess$,
        {
          computerUseHostId,
          cloudBrowserEnabled: computerUseHostId
            ? false
            : get(cloudBrowserEnabled$),
        },
        signal,
      );
    },
  );

  const setCloudBrowserEnabled$ = command(
    async ({ get, set }, cloudBrowserEnabled: boolean, signal: AbortSignal) => {
      await set(
        setComputerAccess$,
        {
          computerUseHostId: cloudBrowserEnabled
            ? null
            : get(computerUseHostId$),
          cloudBrowserEnabled,
        },
        signal,
      );
    },
  );

  const clearComputerUseHostIdOverride$ = command(({ get, set }) => {
    const user = get(internalUserOverride$);
    if (user.kind === "set" && user.dirty) {
      set(internalUserOverride$, { kind: "unset" });
    }
  });

  return {
    computerUseHostId$,
    cloudBrowserEnabled$,
    computerUseHostIdExplicit$,
    setComputerUseHostId$,
    setCloudBrowserEnabled$,
    clearComputerUseHostIdOverride$,
  };
}

// ---------------------------------------------------------------------------
// Sub-factory: composer file input
// ---------------------------------------------------------------------------

function createComposerFileInput() {
  const internal$ = state<HTMLElement | null>(null);
  const composerFileInput$ = computed((get) => {
    return get(internal$);
  });
  const setComposerFileInput$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internal$, null);
      });
      set(internal$, el);
    }),
  );
  return { composerFileInput$, setComposerFileInput$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: agent info
// ---------------------------------------------------------------------------

function createAgentInfoSignals(threadMeta$: Computed<ThreadMeta | null>) {
  // agentId$ is read by avatar and pinned UI on first paint.
  // Resolving it via threadMeta$ avoids blocking the avatar render on the
  // chat-threads/:id round-trip, even though the agentId rarely changes
  // for a given thread.
  const agentId$ = computed((get): string | null => {
    return get(threadMeta$)?.agentId ?? null;
  });

  const agentDisplayName$ = computed(async (get): Promise<string | null> => {
    const agentId = await get(agentId$);
    if (!agentId) {
      return null;
    }
    const agent = await get(agentById(agentId));
    return agent?.displayName ?? null;
  });

  const agentPinned$ = computed(async (get): Promise<boolean | null> => {
    const agentId = await get(agentId$);
    if (!agentId) {
      return null;
    }
    const ids = await get(pinnedAgentIds$);
    return ids.includes(agentId);
  });

  return { agentId$, agentDisplayName$, agentPinned$ };
}

function createThreadOwnedSignals(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  return {
    ...createAgentInfoSignals(threadMeta$),
    headerAutomations: createHeaderAutomationSignals(threadId),
    workflowQueue: createWorkflowQueueSignals(threadId),
    sidebar: createThreadSidebarSignals(threadId),
    ...createThreadUIState(),
  };
}

// ---------------------------------------------------------------------------
// Sub-factory: per-thread UI state (timeline expansion, copy)
// ---------------------------------------------------------------------------

function createThreadUIState() {
  // Timeline expansion
  const internalExpandedIds$ = state(new Set<string>());

  const timelineExpandedIds$ = computed((get) => {
    return get(internalExpandedIds$);
  });

  const toggleTimelineExpanded$ = command(({ get, set }, messageId: string) => {
    const current = get(internalExpandedIds$);
    const next = new Set(current);
    if (next.has(messageId)) {
      next.delete(messageId);
    } else {
      next.add(messageId);
    }
    set(internalExpandedIds$, next);
  });

  // Copy state with 2s auto-clear
  const internalCopiedId$ = state<string | null>(null);
  const internalCopiedTimerId$ = state<number | null>(null);

  const copiedMessageId$ = computed((get) => {
    return get(internalCopiedId$);
  });

  const copyMessage$ = command(
    async (
      { get, set },
      messageId: string,
      payload: ChatClipboardPayload,
      signal: AbortSignal,
    ) => {
      const ok = await writeChatMessageToClipboard(payload);
      signal.throwIfAborted();
      if (!ok) {
        return;
      }
      const existingTimerId = get(internalCopiedTimerId$);
      if (existingTimerId !== null) {
        window.clearTimeout(existingTimerId);
      }
      set(internalCopiedId$, messageId);
      const timerId = window.setTimeout(() => {
        set(internalCopiedId$, null);
        set(internalCopiedTimerId$, null);
      }, 2000);
      set(internalCopiedTimerId$, timerId);
    },
  );

  return {
    timelineExpandedIds$,
    toggleTimelineExpanded$,
    copiedMessageId$,
    copyMessage$,
  };
}

// ---------------------------------------------------------------------------
// Sub-factory: draft server sync (debounced PATCH)
// ---------------------------------------------------------------------------

/** Milliseconds to wait before persisting a draft change to the server. */
const DRAFT_SYNC_DEBOUNCE_MS = 500;

function createDraftSync(
  threadId: string,
  draft: DraftSignals,
  dataSource: ChatThreadRemote,
) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  // A reset signal is used to abort any in-flight debounced sync when a new
  // change comes in or when the draft is cleared on send.
  const draftSyncReset$ = resetSignal();

  const debouncedSyncDraft$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      await delay(DRAFT_SYNC_DEBOUNCE_MS, { signal });
      signal.throwIfAborted();
      if (get(optimisticCreateUnsettled$)) {
        L.debug("draft sync skipped for unsettled optimistic thread create", {
          threadId,
        });
        return;
      }

      const attachments = get(draft.attachments$);

      const infos = await Promise.allSettled(
        attachments.map((a) => {
          return get(a.fileInfo$);
        }),
      );
      signal.throwIfAborted();
      const persisted = collectSuccessfulAttachmentInfos(
        attachments,
        infos,
      ).map((r) => {
        return {
          id: r.info.id,
          url: r.info.url,
          filename: r.attachment.filename,
          contentType: r.attachment.contentType,
          size: r.attachment.size,
        };
      });
      const payload = buildDraftPersistencePayload({
        input: get(draft.input$),
        editorDocument: set(draft.readEditorDocument$),
        generationTemplate: get(draft.generationTemplate$),
        attachments: persisted,
      });

      await set(
        dataSource.patchDraft$,
        {
          threadId,
          ...payload,
        },
        signal,
      );
    },
  );

  const queueDraftSync$ = command(async ({ set }, signal: AbortSignal) => {
    const debouncedSignal = set(draftSyncReset$, signal);
    await set(debouncedSyncDraft$, debouncedSignal);
  });

  const cancelDraftSync$ = command(({ set }) => {
    set(draftSyncReset$);
  });

  const flushDraftClear$ = command(
    async ({ get, set }, signal: AbortSignal) => {
      set(draftSyncReset$);
      if (get(optimisticCreateUnsettled$)) {
        L.debug(
          "draft clear sync skipped for unsettled optimistic thread create",
          { threadId },
        );
        return;
      }
      await set(
        dataSource.patchDraft$,
        {
          threadId,
          content: null,
          userMessage: null,
          attachments: null,
        },
        signal,
      );
    },
  );

  return { queueDraftSync$, cancelDraftSync$, flushDraftClear$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: paginated chat messages
// ---------------------------------------------------------------------------

/**
 * Merge new messages into existing groups.
 *
 * Upsert semantics by `id`: if an incoming message's id already exists in
 * the groups, its fields are replaced in place — this lets an optimistic
 * user row reconcile with the server-pushed row without React unmounting
 * and remounting the message (the React key stays the same).
 */
function mergeIntoGroups(
  groups: GroupedChatMessageGroup[],
  messages: EnrichedChatMessage[],
): GroupedChatMessageGroup[] {
  const result = groups.map((g) => {
    return { ...g, messages: [...g.messages] };
  });

  const positionById = new Map<string, { groupIdx: number; msgIdx: number }>();
  for (let gi = 0; gi < result.length; gi++) {
    const group = result[gi]!;
    for (let mi = 0; mi < group.messages.length; mi++) {
      positionById.set(group.messages[mi]!.id, { groupIdx: gi, msgIdx: mi });
    }
  }

  for (const msg of messages) {
    const existing = positionById.get(msg.id);
    if (existing) {
      result[existing.groupIdx]!.messages[existing.msgIdx] = msg;
      continue;
    }

    const last = result[result.length - 1];
    if (last && shouldMergeIntoGroup(last, msg)) {
      last.messages.push(msg);
      positionById.set(msg.id, {
        groupIdx: result.length - 1,
        msgIdx: last.messages.length - 1,
      });
    } else {
      const role = chatEventCompatibilityRole(msg.eventType);
      result.push({
        beginMessageId: msg.id,
        role,
        messages: [msg],
      });
      positionById.set(msg.id, { groupIdx: result.length - 1, msgIdx: 0 });
    }
  }
  return result;
}

function firstRunIdForGroup(
  group: GroupedChatMessageGroup,
): string | undefined {
  return group.messages.find((message) => {
    return message.runId !== undefined;
  })?.runId;
}

function shouldMergeIntoGroup(
  group: GroupedChatMessageGroup,
  msg: EnrichedChatMessage,
): boolean {
  if (group.role !== chatEventCompatibilityRole(msg.eventType)) {
    return false;
  }
  if (group.role !== "assistant") {
    return true;
  }

  const groupRunId = firstRunIdForGroup(group);
  if (groupRunId === undefined || msg.runId === undefined) {
    return true;
  }
  return groupRunId === msg.runId;
}

function orderMessagesByRunTurn(
  messages: readonly EnrichedChatMessage[],
): EnrichedChatMessage[] {
  const items: {
    order: number;
    messages: EnrichedChatMessage[];
  }[] = [];
  const itemByRunId = new Map<string, (typeof items)[number]>();

  for (const message of messages) {
    const runId = message.runId;
    if (runId === undefined) {
      items.push({ order: items.length, messages: [message] });
      continue;
    }

    const existing = itemByRunId.get(runId);
    if (existing) {
      existing.messages.push(message);
      continue;
    }

    const item = { order: items.length, messages: [message] };
    itemByRunId.set(runId, item);
    items.push(item);
  }

  return items
    .sort((a, b) => {
      return a.order - b.order;
    })
    .flatMap((item) => {
      return item.messages;
    });
}

function groupMessagesForDisplay(
  messages: EnrichedChatMessage[],
): GroupedChatMessageGroup[] {
  const activeMessages: EnrichedChatMessage[] = [];
  const queuedMessages: EnrichedChatMessage[] = [];
  const usageByRunId = foldLatestChatUsageByRunId(messages);
  for (const msg of messages) {
    if (isUsageMessage(msg)) {
      continue;
    }
    if (chatEventCompatibilityRole(msg.eventType) === "user" && msg.isQueued) {
      queuedMessages.push(msg);
      continue;
    }
    activeMessages.push(msg);
  }

  const groups = [
    ...mergeIntoGroups([], orderMessagesByRunTurn(activeMessages)),
    ...mergeIntoGroups([], queuedMessages),
  ];
  return groups.map((group) => {
    if (group.role !== "assistant") {
      return group;
    }
    const runId = firstRunIdForGroup(group);
    const usage = runId === undefined ? undefined : usageByRunId.get(runId);
    return usage === undefined ? group : { ...group, usage };
  });
}

function createRenderedChatGroups(
  semanticMessages$: Computed<SemanticChatMessage[]>,
) {
  const transcriptMessages$ =
    createTranscriptMessagesComputed(semanticMessages$);

  const allRenderedChatGroups$ = computed(
    async (get): Promise<GroupedChatMessageGroup[]> => {
      const messages = await get(transcriptMessages$);
      return groupMessagesForDisplay(messages);
    },
  );
  const sidebarAutoOpenCandidate$ = createThreadSidebarAutoOpenCandidate(
    allRenderedChatGroups$,
  );

  const messageImageGroups$ = computed(
    async (get): Promise<MessageImageGroupProjection[]> => {
      return (await get(allRenderedChatGroups$)).map((group) => {
        return {
          messages: group.messages.map((message) => {
            return {
              attachFiles: chatEventAttachFiles(message),
              blocks: message.blocks,
            };
          }),
        };
      });
    },
  );

  return {
    allRenderedChatGroups$,
    sidebarAutoOpenCandidate$,
    messageImageGroups$,
  };
}

interface RegisteredChatMessage {
  readonly message: ChatEvent;
  readonly blocks: BodyRenderBlock[];
}

type PersistentChatMessages$ = State<RegisteredChatMessage[]>;

type BodyBlocksRenderer = (
  blocks: readonly ParsedBodyBlock[],
) => BodyRenderBlock[];

function compareCursorString(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareCreatedAt(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isNaN(leftTime) || Number.isNaN(rightTime)) {
    return compareCursorString(left, right);
  }
  return leftTime - rightTime;
}

function mergeRegisteredMessages(
  messageSets: readonly (readonly RegisteredChatMessage[])[],
): RegisteredChatMessage[] {
  const byId = new Map<string, RegisteredChatMessage>();
  for (const entries of messageSets) {
    for (const entry of entries) {
      byId.set(entry.message.id, entry);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    return left.message.seqId - right.message.seqId;
  });
}

function skipsMessageBodyRendering(message: ChatEvent): boolean {
  return (
    isInterruptControlMessage(message) ||
    isRecallControlMessage(message) ||
    isQueueMarkerMessage(message) ||
    isGoalMarkerMessage(message) ||
    isAutomationQueueStateMessage(message)
  );
}

function registerMessageAttachments(
  message: ChatMessage,
  artifactCardSignals: ArtifactCardSignalsRegistry,
): void {
  for (const attachment of chatEventAttachFiles(message) ?? []) {
    artifactCardSignals.register({
      filename: attachment.filename,
      url: attachment.url,
      kind: classifyChatAttachment(attachment),
    });
  }
}

function registerChatMessage(
  message: ChatEvent,
  registerBodyBlocks: BodyBlocksRenderer,
  artifactCardSignals: ArtifactCardSignalsRegistry,
): RegisteredChatMessage {
  registerMessageAttachments(message, artifactCardSignals);
  const blocks = skipsMessageBodyRendering(message)
    ? []
    : registerBodyBlocks(parseMessageBodyBlocks(message));
  return { message, blocks };
}

function createMergePersistentMessages(
  threadId: string,
  persistentMessages$: PersistentChatMessages$,
  registerBodyBlocks: BodyBlocksRenderer,
  artifactCardSignals: ArtifactCardSignalsRegistry,
) {
  return command(({ get, set }, msgs: ChatEvent[]): void => {
    if (msgs.length === 0) {
      return;
    }
    const reportedCompletedRunIds = new Set(
      completedRunIdsFromMessages(
        get(persistentMessages$).map((entry) => {
          return entry.message;
        }),
      ),
    );
    const newlyCompletedRunIds = completedRunIdsFromMessages(msgs).filter(
      (runId) => {
        return !reportedCompletedRunIds.has(runId);
      },
    );
    for (const _ of newlyCompletedRunIds) {
      captureTaskCompletedSuccessfully();
    }
    const registeredMessages = msgs.map((message) => {
      return registerChatMessage(
        message,
        registerBodyBlocks,
        artifactCardSignals,
      );
    });
    set(persistentMessages$, (prev) => {
      return mergeRegisteredMessages([prev, registeredMessages]);
    });
    set(reconcileOptimisticChatMessages$, { threadId, messages: msgs });
  });
}

interface ServerChatMessageProjectionEntry {
  message: ChatEvent;
  source: "server";
  blocks: BodyRenderBlock[];
  optimisticUserMessageAssociation?: never;
}

interface OptimisticChatMessageProjectionEntry {
  message: OptimisticChatMessageEntry["message"];
  source: "optimistic";
  blocks: BodyRenderBlock[];
  optimisticUserMessageAssociation?: OptimisticChatMessageEntry["optimisticUserMessageAssociation"];
}

type ChatMessageProjectionEntry =
  | ServerChatMessageProjectionEntry
  | OptimisticChatMessageProjectionEntry;

function projectRawMessages({
  persistentMessages,
  optimisticEntries,
  resolveBodyBlocks,
}: {
  persistentMessages: readonly RegisteredChatMessage[];
  optimisticEntries: readonly OptimisticChatMessageEntry[];
  resolveBodyBlocks: BodyBlocksRenderer;
}): ChatMessageProjectionEntry[] {
  const serverIds = new Set(
    persistentMessages.map((entry) => {
      return entry.message.id;
    }),
  );
  const optimistic = optimisticEntries.filter((entry) => {
    return !serverIds.has(entry.message.id);
  });
  // Optimistic messages do not have a server sequence yet. Keep their array
  // order and append them after every persistent message.
  return [
    ...persistentMessages.map((entry) => {
      return { ...entry, source: "server" as const };
    }),
    ...optimistic.map((entry) => {
      return {
        message: entry.message,
        blocks: resolveBodyBlocks(entry.parsedBodyBlocks),
        source: "optimistic" as const,
        optimisticUserMessageAssociation:
          entry.optimisticUserMessageAssociation,
      };
    }),
  ];
}

function createRawMessagesComputed({
  persistentMessages$,
  optimisticMessages$,
  resolveBodyBlocks,
}: {
  persistentMessages$: PersistentChatMessages$;
  optimisticMessages$: Computed<OptimisticChatMessageEntry[]>;
  resolveBodyBlocks: BodyBlocksRenderer;
}): Computed<ChatMessageProjectionEntry[]> {
  return computed((get): ChatMessageProjectionEntry[] => {
    return projectRawMessages({
      persistentMessages: get(persistentMessages$),
      optimisticEntries: get(optimisticMessages$),
      resolveBodyBlocks,
    });
  });
}

function createTranscriptMessagesComputed(
  semanticMessages$: Computed<SemanticChatMessage[]>,
): Computed<Promise<EnrichedChatMessage[]>> {
  return computed((get): Promise<EnrichedChatMessage[]> => {
    return Promise.resolve(
      get(semanticMessages$).map((entry) => {
        const { message, isQueued, isOptimisticRun } = entry;
        const role = chatEventCompatibilityRole(message.eventType);
        if (role !== "assistant") {
          return {
            ...message,
            blocks: entry.blocks,
            isQueued,
            isOptimisticRun,
          };
        }
        return {
          ...message,
          blocks: entry.blocks,
          isQueued,
          isOptimisticRun: false,
        };
      }),
    );
  });
}

interface SemanticChatMessage {
  readonly message: ChatMessage;
  readonly blocks: BodyRenderBlock[];
  readonly isQueued: boolean;
  readonly isOptimisticRun: boolean;
}

interface SemanticChatMessageGroup {
  readonly role: "user" | "assistant";
  readonly messages: SemanticChatMessage[];
}

interface SemanticChatGroups {
  readonly activeGroups: SemanticChatMessageGroup[];
  readonly allGroups: SemanticChatMessageGroup[];
}

function semanticTranscriptMessagesFromRaw(
  raw: readonly ChatMessageProjectionEntry[],
): SemanticChatMessage[] {
  const interruptedRunIds = new Set(
    raw.flatMap((entry) => {
      const { message } = entry;
      return isInterruptControlMessage(message) && message.interruptsRunId
        ? [message.interruptsRunId]
        : [];
    }),
  );
  const recalledIds = new Set(
    raw.flatMap((entry) => {
      const { message } = entry;
      return isRecallControlMessage(message) && message.revokesEventId
        ? [message.revokesEventId]
        : [];
    }),
  );
  const replacedIds = new Set(
    raw.flatMap((entry) => {
      const { message } = entry;
      return !isRecallControlMessage(message) && message.revokesEventId
        ? [message.revokesEventId]
        : [];
    }),
  );

  return raw.flatMap((entry): SemanticChatMessage[] => {
    const { message } = entry;
    if (
      isRecallControlMessage(message) ||
      isQueueMarkerMessage(message) ||
      isGoalMarkerMessage(message) ||
      isAutomationQueueStateMessage(message) ||
      isInterruptedAssistantCancellation(message, interruptedRunIds) ||
      recalledIds.has(message.id) ||
      replacedIds.has(message.id)
    ) {
      return [];
    }
    if (isInterruptControlMessage(message) && message.interruptsRunId) {
      return [
        {
          message: createInterruptedAssistantProjection(
            message,
            message.interruptsRunId,
          ),
          blocks: [],
          isQueued: false,
          isOptimisticRun: false,
        },
      ];
    }

    const isUnassociatedUser =
      chatEventCompatibilityRole(message.eventType) === "user" &&
      message.runId === undefined;
    const optimisticAssociation = entry.optimisticUserMessageAssociation;
    const isOptimisticRun =
      isUnassociatedUser && optimisticAssociation === "run";
    const isQueued =
      isUnassociatedUser &&
      optimisticAssociation !== "run" &&
      (message.eventType === "input.prompt" ||
        message.eventType === "input.automation");
    return [{ message, blocks: entry.blocks, isQueued, isOptimisticRun }];
  });
}

function orderSemanticMessagesByRunTurn(
  messages: readonly SemanticChatMessage[],
): SemanticChatMessage[] {
  const items: {
    order: number;
    messages: SemanticChatMessage[];
  }[] = [];
  const itemByRunId = new Map<string, (typeof items)[number]>();

  for (const semanticMessage of messages) {
    const runId = semanticMessage.message.runId;
    if (runId === undefined) {
      items.push({ order: items.length, messages: [semanticMessage] });
      continue;
    }
    const existing = itemByRunId.get(runId);
    if (existing) {
      existing.messages.push(semanticMessage);
      continue;
    }
    const item = { order: items.length, messages: [semanticMessage] };
    itemByRunId.set(runId, item);
    items.push(item);
  }

  return items
    .sort((left, right) => {
      return left.order - right.order;
    })
    .flatMap((item) => {
      return item.messages;
    });
}

function shouldMergeSemanticMessage(
  group: SemanticChatMessageGroup,
  semanticMessage: SemanticChatMessage,
): boolean {
  if (
    group.role !== chatEventCompatibilityRole(semanticMessage.message.eventType)
  ) {
    return false;
  }
  if (group.role !== "assistant") {
    return true;
  }
  const groupRunId = group.messages.find((entry) => {
    return entry.message.runId !== undefined;
  })?.message.runId;
  const messageRunId = semanticMessage.message.runId;
  return (
    groupRunId === undefined ||
    messageRunId === undefined ||
    groupRunId === messageRunId
  );
}

function groupSemanticMessages(
  messages: readonly SemanticChatMessage[],
): SemanticChatMessageGroup[] {
  const groups: SemanticChatMessageGroup[] = [];
  for (const semanticMessage of messages) {
    const lastGroup = groups.at(-1);
    if (lastGroup && shouldMergeSemanticMessage(lastGroup, semanticMessage)) {
      lastGroup.messages.push(semanticMessage);
      continue;
    }
    groups.push({
      role: chatEventCompatibilityRole(semanticMessage.message.eventType),
      messages: [semanticMessage],
    });
  }
  return groups;
}

function groupSemanticChatMessages(
  semanticMessages: readonly SemanticChatMessage[],
): SemanticChatGroups {
  const activeMessages: SemanticChatMessage[] = [];
  const queuedMessages: SemanticChatMessage[] = [];
  for (const semanticMessage of semanticMessages) {
    if (isUsageMessage(semanticMessage.message)) {
      continue;
    }
    if (
      chatEventCompatibilityRole(semanticMessage.message.eventType) ===
        "user" &&
      semanticMessage.isQueued
    ) {
      queuedMessages.push(semanticMessage);
      continue;
    }
    activeMessages.push(semanticMessage);
  }
  const activeGroups = groupSemanticMessages(
    orderSemanticMessagesByRunTurn(activeMessages),
  );
  return {
    activeGroups,
    allGroups: [...activeGroups, ...groupSemanticMessages(queuedMessages)],
  };
}

function queuedMessagesFromSemanticMessages(
  semanticMessages: readonly SemanticChatMessage[],
): ChatMessage[] {
  return semanticMessages.flatMap((entry) => {
    const { message } = entry;
    return chatEventCompatibilityRole(message.eventType) === "user" &&
      entry.isQueued
      ? [message]
      : [];
  });
}

function queuedMessagesFromRaw(
  raw: readonly ChatMessageProjectionEntry[],
): ChatMessage[] {
  return queuedMessagesFromSemanticMessages(
    semanticTranscriptMessagesFromRaw(raw),
  );
}

function lastAssistantCancelledFromGroups(groups: SemanticChatGroups): boolean {
  const lastGroup = groups.allGroups.at(-1);
  const lastMessage = lastGroup?.messages.at(-1)?.message;
  return lastMessage ? isCancelledRunEvent(lastMessage) : false;
}

function isRenderableAssistantSemanticMessage(
  entry: SemanticChatMessage,
): boolean {
  const { message } = entry;
  return (
    chatEventCompatibilityRole(message.eventType) === "assistant" &&
    (Boolean(message.content) || ("error" in message && Boolean(message.error)))
  );
}

function isThinkingMarkerSemanticMessage(entry: SemanticChatMessage): boolean {
  const { message } = entry;
  return (
    message.eventType === "output.thinking" &&
    message.content === null &&
    message.thinking.trim().length > 0 &&
    message.runId !== undefined
  );
}

function lastRunThinkingMessage(
  groups: readonly SemanticChatMessageGroup[],
): SemanticChatMessage | undefined {
  const messages = groups.flatMap((group) => {
    return group.messages;
  });
  const lastMessage = messages.at(-1);
  if (!lastMessage || !isThinkingMarkerSemanticMessage(lastMessage)) {
    return undefined;
  }
  const runId = lastMessage.message.runId;
  const runHasAssistantText = messages.some((entry) => {
    return (
      entry.message.runId === runId &&
      isRenderableAssistantSemanticMessage(entry)
    );
  });
  return runHasAssistantText ? undefined : lastMessage;
}

interface ThinkingIndicatorProjection {
  readonly mode: ThinkingIndicatorMode;
  readonly thinkingMessageId: string | null;
  readonly thinkingText: string | null;
}

function assistantGroupOnlyHasThinking(
  group: SemanticChatMessageGroup,
  thinkingMessage: SemanticChatMessage | undefined,
): boolean {
  if (group.role !== "assistant" || thinkingMessage === undefined) {
    return false;
  }
  return !group.messages.some((entry) => {
    return isRenderableAssistantSemanticMessage(entry);
  });
}

function shouldHideThinkingIndicator({
  lastIsAssistant,
  lastAssistantCancelled,
  lastAssistantOnlyThinking,
  running,
}: {
  lastIsAssistant: boolean;
  lastAssistantCancelled: boolean;
  lastAssistantOnlyThinking: boolean;
  running: boolean;
}): boolean {
  if (running) {
    return false;
  }
  return (
    lastAssistantCancelled || lastAssistantOnlyThinking || !lastIsAssistant
  );
}

function resolveThinkingIndicatorMode({
  lastIsAssistant,
  lastAssistantOnlyThinking,
  queued,
  running,
}: {
  lastIsAssistant: boolean;
  lastAssistantOnlyThinking: boolean;
  queued: boolean;
  running: boolean;
}): ThinkingIndicatorMode {
  if (!running) {
    return "finished";
  }
  if (lastIsAssistant && !lastAssistantOnlyThinking) {
    return queued ? "running-queued" : "running";
  }
  return queued ? "waiting-queued" : "waiting";
}

function thinkingIndicatorProjectionFromGroups(
  groups: SemanticChatGroups,
  runState: RunIndicatorState,
): ThinkingIndicatorProjection {
  const { activeGroups } = groups;
  const lastGroup = activeGroups.at(-1);
  if (!lastGroup) {
    return { mode: null, thinkingMessageId: null, thinkingText: null };
  }
  const lastIsAssistant = lastGroup.role === "assistant";
  const lastAssistantMessage = lastIsAssistant
    ? lastGroup.messages.at(-1)?.message
    : undefined;
  const rawThinkingMessage = lastRunThinkingMessage(activeGroups);
  const lastAssistantOnlyThinking = assistantGroupOnlyHasThinking(
    lastGroup,
    rawThinkingMessage,
  );
  const lastAssistantCancelled = lastAssistantMessage
    ? isCancelledRunEvent(lastAssistantMessage)
    : false;
  const queued = runState === "queued";
  const running = runState !== null && !lastAssistantCancelled;

  if (
    shouldHideThinkingIndicator({
      lastIsAssistant,
      lastAssistantCancelled,
      lastAssistantOnlyThinking,
      running,
    })
  ) {
    return { mode: null, thinkingMessageId: null, thinkingText: null };
  }

  const mode = resolveThinkingIndicatorMode({
    lastIsAssistant,
    lastAssistantOnlyThinking,
    queued,
    running,
  });
  const thinkingText =
    !queued &&
    running &&
    rawThinkingMessage?.message.eventType === "output.thinking"
      ? rawThinkingMessage.message.thinking?.trim() || null
      : null;
  return {
    mode,
    thinkingMessageId: thinkingText
      ? (rawThinkingMessage?.message.id ?? null)
      : null,
    thinkingText,
  };
}

function latestRecommendedFollowupsFromGroups(
  groups: SemanticChatGroups,
): RecommendedFollowupSource | null {
  const { activeGroups } = groups;
  for (
    let groupIndex = activeGroups.length - 1;
    groupIndex >= 0;
    groupIndex--
  ) {
    const group = activeGroups[groupIndex];
    if (!group) {
      continue;
    }
    if (group.role !== "assistant") {
      return null;
    }
    for (
      let messageIndex = group.messages.length - 1;
      messageIndex >= 0;
      messageIndex--
    ) {
      const message = group.messages[messageIndex]?.message;
      if (
        !message ||
        chatEventCompatibilityRole(message.eventType) !== "assistant"
      ) {
        continue;
      }
      if (message.content?.trim()) {
        return null;
      }
      if (message.eventType !== "output.followups") {
        continue;
      }
      const followups = message.recommendedFollowups;
      if (followups.length > 0) {
        return { messageId: message.id, followups };
      }
    }
  }
  return null;
}

function createMessageSemanticSignals(
  semanticMessages$: Computed<SemanticChatMessage[]>,
  messageRunIndicatorState$: Computed<Promise<RunIndicatorState>>,
) {
  const semanticGroups$ = computed((get): SemanticChatGroups => {
    return groupSemanticChatMessages(get(semanticMessages$));
  });
  const queuedMessages$ = computed((get): ChatMessage[] => {
    return queuedMessagesFromSemanticMessages(get(semanticMessages$));
  });
  const thinkingIndicatorProjection$ = computed(
    async (get): Promise<ThinkingIndicatorProjection> => {
      const runState = await get(messageRunIndicatorState$);
      return thinkingIndicatorProjectionFromGroups(
        get(semanticGroups$),
        runState,
      );
    },
  );
  const hasMessages$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      get(semanticMessages$).some((entry) => {
        return !isUsageMessage(entry.message);
      }),
    );
  });
  const hasQueuedMessages$ = computed((get): Promise<boolean> => {
    return Promise.resolve(get(queuedMessages$).length > 0);
  });
  const queuedMessageItems$ = computed(
    (get): Promise<readonly QueuedChatMessageItem[]> => {
      return Promise.resolve(
        get(queuedMessages$).map((message) => {
          const userMessage =
            message.eventType === "input.prompt" &&
            shouldUseUserMessage(message.userMessage)
              ? message.userMessage
              : undefined;
          const text =
            message.eventType === "input.automation"
              ? message.triggerBrief
              : userMessage
                ? messageDocumentToDisplayText(userMessage)
                : message.content;
          return { id: message.id, text: (text ?? "").trim() };
        }),
      );
    },
  );
  const emptyQueuedMessageItems = Promise.resolve(
    [] as readonly QueuedChatMessageItem[],
  );
  const emptyQueuedMessageItems$ = computed(() => {
    return emptyQueuedMessageItems;
  });
  const lastAssistantCancelled$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      lastAssistantCancelledFromGroups(get(semanticGroups$)),
    );
  });
  const allFinished$ = computed(async (get): Promise<boolean> => {
    return (await get(messageRunIndicatorState$)) === null;
  });
  const thinkingIndicatorMode$ = computed(
    async (get): Promise<ThinkingIndicatorMode> => {
      return (await get(thinkingIndicatorProjection$)).mode;
    },
  );
  const thinkingText$ = computed(async (get): Promise<string | null> => {
    return (await get(thinkingIndicatorProjection$)).thinkingText;
  });
  const thinkingMessageId$ = computed(async (get): Promise<string | null> => {
    return (await get(thinkingIndicatorProjection$)).thinkingMessageId;
  });
  const recommendedFollowupSource$ = computed(
    (get): Promise<RecommendedFollowupSource | null> => {
      return Promise.resolve(
        latestRecommendedFollowupsFromGroups(get(semanticGroups$)),
      );
    },
  );
  const donePhrase$ = computed((get): Promise<string> => {
    const lastMessage = get(semanticGroups$)
      .allGroups.at(-1)
      ?.messages.at(-1)?.message;
    return Promise.resolve(formatDonePhrase(lastMessage));
  });

  return {
    hasMessages$,
    hasQueuedMessages$,
    queuedMessageItems$,
    emptyQueuedMessageItems$,
    lastAssistantCancelled$,
    allFinished$,
    thinkingIndicatorMode$,
    thinkingMessageId$,
    thinkingText$,
    recommendedFollowupSource$,
    donePhrase$,
  };
}

function createMessageSyncSignals(hasMessages$: Computed<Promise<boolean>>) {
  const initialSyncStarted = Promise.withResolvers<void>();
  const internalMessageSyncPromise$ = state<Promise<void> | null>(null);
  const hasNewMessages$ = computed(async (get): Promise<boolean> => {
    await initialSyncStarted.promise;
    await get(internalMessageSyncPromise$);
    return await get(hasMessages$);
  });
  const trackMessageSync$ = command(({ set }, promise: Promise<void>): void => {
    set(internalMessageSyncPromise$, promise);
    initialSyncStarted.resolve(undefined);
  });
  const settleMessageSync$ = command(({ set }): Promise<void> => {
    const promise = Promise.resolve();
    set(trackMessageSync$, promise);
    return promise;
  });
  return { hasNewMessages$, trackMessageSync$, settleMessageSync$ };
}

function createTrackedMessageSyncCommand(
  runSyncRemoteMessages$: Command<Promise<void>, [AbortSignal]>,
  trackMessageSync$: Command<void, [Promise<void>]>,
): Command<Promise<void>, [AbortSignal]> {
  return command(({ set }, signal: AbortSignal): Promise<void> => {
    const promise = set(runSyncRemoteMessages$, signal);
    set(trackMessageSync$, promise);
    return promise;
  });
}

function isServerProjectionEntry(entry: ChatMessageProjectionEntry): boolean {
  return entry.source === "server";
}

function latestRunFinishCreatedAtFromRaw(
  raw: readonly ChatMessageProjectionEntry[],
): string | undefined {
  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    if (!isServerProjectionEntry(entry)) {
      continue;
    }
    const { message } = entry;
    if (isChatRunTerminalEventType(message.eventType)) {
      return message.createdAt;
    }
  }
  return undefined;
}

function latestAssistantTextCreatedAtFromRaw(
  raw: readonly ChatMessageProjectionEntry[],
): string | undefined {
  const revokedMessageIds = revokedMessageIdsFromRawMessages(raw);
  const interruptedRunIds = new Set(
    raw.flatMap((entry) => {
      const { message } = entry;
      return isInterruptControlMessage(message) && message.interruptsRunId
        ? [message.interruptsRunId]
        : [];
    }),
  );
  for (let index = raw.length - 1; index >= 0; index--) {
    const message = raw[index]!.message;
    if (revokedMessageIds.has(message.id)) {
      continue;
    }
    if (isInterruptControlMessage(message)) {
      return message.createdAt;
    }
    if (
      chatEventCompatibilityRole(message.eventType) === "assistant" &&
      !isUsageMessage(message) &&
      !isQueueMarkerMessage(message) &&
      !isGoalMarkerMessage(message) &&
      !isInterruptedAssistantCancellation(message, interruptedRunIds) &&
      (message.content?.trim().length ?? 0) > 0
    ) {
      return message.createdAt;
    }
  }
  return undefined;
}

function createLatestMessageSignals(
  rawMessages$: Computed<ChatMessageProjectionEntry[]>,
) {
  const latestRunFinishCreatedAt$ = computed(
    (get): Promise<string | undefined> => {
      return Promise.resolve(
        latestRunFinishCreatedAtFromRaw(get(rawMessages$)),
      );
    },
  );
  const latestAssistantTextCreatedAt$ = computed(
    (get): Promise<string | undefined> => {
      return Promise.resolve(
        latestAssistantTextCreatedAtFromRaw(get(rawMessages$)),
      );
    },
  );
  return {
    latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$,
  };
}

const HISTORY_BACKFILL_MERGE_BATCH_SIZE = 300;

function createSyncRemoteMessagesCommand({
  threadId,
  persistentMessages$,
  hasReachedOldestMessage$,
  hasServerConfirmedOldestMessage$,
  mergePersistentMessages$,
  dataSource,
}: {
  threadId: string;
  persistentMessages$: PersistentChatMessages$;
  hasReachedOldestMessage$: Computed<boolean>;
  hasServerConfirmedOldestMessage$: State<boolean>;
  mergePersistentMessages$: Command<void, [ChatEvent[]]>;
  dataSource: ChatThreadRemote;
}): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const persistentMessages = get(persistentMessages$);
    const accumulatedMessages: ChatEvent[] = [];
    let mergedMessageCount = 0;
    const latestPersistentMessage = persistentMessages.at(-1);
    let sinceSeqId = latestPersistentMessage?.message.seqId;
    const startedWithoutCursor = latestPersistentMessage === undefined;
    let initialPageOldestMessage: ChatEvent | undefined;
    let initialHasHistoryBefore: boolean | undefined;

    async function syncMessagesAfter(): Promise<void> {
      const requestedSinceSeqId = sinceSeqId;
      const isInitialPage = requestedSinceSeqId === undefined;
      const result = await set(
        dataSource.listEventsAfter$,
        { threadId, sinceSeqId: requestedSinceSeqId },
        signal,
      );
      signal.throwIfAborted();
      L.debug("syncRemoteMessages$ listEventsAfter result", {
        threadId,
        sinceSeqId: requestedSinceSeqId ?? null,
        gotCount: result.events.length,
      });

      if (isInitialPage) {
        initialHasHistoryBefore = result.hasHistoryBefore;
      }

      if (result.events.length === 0) {
        return;
      }

      await set(writeIndexedDbChatEvents$, threadId, result.events, signal);
      signal.throwIfAborted();
      if (isInitialPage) {
        initialPageOldestMessage = result.events[0]!;
        set(mergePersistentMessages$, result.events);
      } else {
        accumulatedMessages.push(...result.events);
      }
      sinceSeqId = result.events.at(-1)!.seqId;

      if (
        requestedSinceSeqId !== undefined &&
        result.events.length < CHAT_MESSAGES_PAGE_LIMIT
      ) {
        return;
      }
      return syncMessagesAfter();
    }
    await syncMessagesAfter();
    signal.throwIfAborted();

    if (!get(hasReachedOldestMessage$)) {
      const oldestMessage =
        persistentMessages[0]?.message ??
        initialPageOldestMessage ??
        accumulatedMessages[0];
      if (
        (startedWithoutCursor && initialHasHistoryBefore === false) ||
        oldestMessage === undefined
      ) {
        if (initialHasHistoryBefore === false) {
          set(hasServerConfirmedOldestMessage$, true);
        }
      } else {
        let beforeSeqId = oldestMessage.seqId;
        async function syncMessagesBefore(): Promise<void> {
          const result = await set(
            dataSource.listEventsBefore$,
            { threadId, beforeSeqId },
            signal,
          );
          signal.throwIfAborted();
          L.debug("syncRemoteMessages$ listEventsBefore result", {
            threadId,
            beforeSeqId,
            gotCount: result.events.length,
            hasHistoryBefore: result.hasHistoryBefore,
          });

          if (result.events.length > 0) {
            accumulatedMessages.push(...result.events);
            await set(
              writeIndexedDbChatEvents$,
              threadId,
              result.events,
              signal,
            );
            signal.throwIfAborted();
            // Flush periodically so long backfills surface incrementally
            // (e.g. the history backfill progress bar) instead of appearing
            // only after every page has been fetched.
            if (
              accumulatedMessages.length - mergedMessageCount >=
              HISTORY_BACKFILL_MERGE_BATCH_SIZE
            ) {
              set(
                mergePersistentMessages$,
                accumulatedMessages.slice(mergedMessageCount),
              );
              mergedMessageCount = accumulatedMessages.length;
            }
          }

          if (!result.hasHistoryBefore) {
            set(hasServerConfirmedOldestMessage$, true);
            return;
          }

          beforeSeqId = result.events[0]!.seqId;

          return syncMessagesBefore();
        }
        await syncMessagesBefore();
      }
    }
    signal.throwIfAborted();
    set(
      mergePersistentMessages$,
      accumulatedMessages.slice(mergedMessageCount),
    );
  });
}

function createActiveGoalObjectiveComputed(
  rawMessages$: Computed<ChatMessageProjectionEntry[]>,
): Computed<Promise<string | null>> {
  return computed((get): Promise<string | null> => {
    const raw = get(rawMessages$);
    return Promise.resolve(
      foldActiveChatGoalObjective(
        raw.map((entry) => {
          return entry.message;
        }),
      ),
    );
  });
}

interface BodyBlockRegistries {
  readonly artifactCardSignals: ArtifactCardSignalsRegistry;
  readonly connectorCardSignals: ConnectorCardSignalsRegistry;
  readonly customConnectorCardSignals: CustomConnectorCardSignalsRegistry;
  readonly permissionCardSignals: PermissionCardSignalsRegistry;
  readonly computerUseAuthorizationCardSignals: ComputerUseAuthorizationCardSignalsRegistry;
  readonly planUpgradeCardSignals: PlanUpgradeCardSignalsRegistry;
  readonly mailDraftCardSignals: ReturnType<
    typeof createMailDraftCardSignalsRegistry
  >;
  readonly browserSessionCardSignals: BrowserSessionCardSignalsRegistry;
}

function createBodyBlocksRenderer({
  artifactCardSignals,
  connectorCardSignals,
  customConnectorCardSignals,
  permissionCardSignals,
  computerUseAuthorizationCardSignals,
  planUpgradeCardSignals,
  mailDraftCardSignals,
  browserSessionCardSignals,
}: BodyBlockRegistries): (
  resolution: "register" | "resolve",
) => BodyBlocksRenderer {
  return (resolution) => {
    return (blocks) => {
      return blocks.map((block): BodyRenderBlock => {
        switch (block.type) {
          case "markdown": {
            return block;
          }
          case "artifact": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? artifactCardSignals.register(block.descriptor)
                  : artifactCardSignals.resolve(block.resourceKey),
            };
          }
          case "connector-action": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? connectorCardSignals.register(block.descriptor)
                  : connectorCardSignals.resolve(block.resourceKey),
            };
          }
          case "custom-connector-action": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? customConnectorCardSignals.register(block.descriptor)
                  : customConnectorCardSignals.resolve(block.resourceKey),
            };
          }
          case "permission-action": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? permissionCardSignals.register(block.descriptor)
                  : permissionCardSignals.resolve(block.resourceKey),
            };
          }
          case "computer-use-authorization": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? computerUseAuthorizationCardSignals.register(
                      block.descriptor,
                    )
                  : computerUseAuthorizationCardSignals.resolve(
                      block.resourceKey,
                    ),
            };
          }
          case "plan-upgrade": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? planUpgradeCardSignals.register(block.descriptor)
                  : planUpgradeCardSignals.resolve(block.resourceKey),
            };
          }
          case "mail-draft": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? mailDraftCardSignals.register(block.descriptor)
                  : mailDraftCardSignals.resolve(block.resourceKey),
            };
          }
          case "browser-session": {
            return {
              type: block.type,
              resourceKey: block.resourceKey,
              signals:
                resolution === "register"
                  ? browserSessionCardSignals.register(block.descriptor)
                  : browserSessionCardSignals.resolve(block.resourceKey),
            };
          }
        }
        const exhaustive: never = block;
        return exhaustive;
      });
    };
  };
}

function createInitializeIndexedDbMessages({
  artifactCardSignals,
  threadId,
  persistentMessages$,
  registerBodyBlocks,
}: {
  artifactCardSignals: ArtifactCardSignalsRegistry;
  threadId: string;
  persistentMessages$: PersistentChatMessages$;
  registerBodyBlocks: BodyBlocksRenderer;
}) {
  const mergeIndexedDbMessages$ = command(
    ({ set }, messages: ChatEvent[]): void => {
      const registeredMessages = messages.map((message) => {
        return registerChatMessage(
          message,
          registerBodyBlocks,
          artifactCardSignals,
        );
      });
      set(persistentMessages$, (previous) => {
        return mergeRegisteredMessages([previous, registeredMessages]);
      });
    },
  );

  return command(async ({ set }, signal: AbortSignal): Promise<void> => {
    const indexedDbMessages = await set(
      loadIndexedDbChatEvents$,
      threadId,
      signal,
    );
    signal.throwIfAborted();
    set(mergeIndexedDbMessages$, indexedDbMessages);
  });
}

function createMailDraftCardSignalsById(
  rawMessages$: Computed<ChatMessageProjectionEntry[]>,
  mailDraftCardSignals: MailDraftCardSignalsRegistry,
): Computed<ReadonlyMap<string, MailDraftSignals>> {
  return computed((get) => {
    get(rawMessages$);
    return new Map(mailDraftCardSignals.entries());
  });
}

function createBrowserSessionCardSignalsById(
  rawMessages$: Computed<ChatMessageProjectionEntry[]>,
  browserSessionCardSignals: BrowserSessionCardSignalsRegistry,
): Computed<ReadonlyMap<string, BrowserSessionSignals>> {
  return computed((get) => {
    get(rawMessages$);
    return new Map(browserSessionCardSignals.entries());
  });
}

function createHistoryBackfillProgress(
  hasReachedOldestMessage$: Computed<boolean>,
  persistentMessages$: PersistentChatMessages$,
): Computed<Promise<number | null>> {
  // Approximate backfill progress from the loaded seqId range. The thread's
  // true max seqId is not exposed to the client, so the newest loaded message
  // stands in for it. The reached-oldest computed hides progress once the
  // first persistent seqId is 1. Null hides the loading skeleton.
  return computed((get): Promise<number | null> => {
    if (get(hasReachedOldestMessage$)) {
      return Promise.resolve(null);
    }
    const messages = get(persistentMessages$);
    const first = messages[0];
    const last = messages.at(-1);
    if (first === undefined || last === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      (last.message.seqId - first.message.seqId) / last.message.seqId,
    );
  });
}

function createPagedMessages(
  threadId: string,
  dataSource: ChatThreadRemote,
  initialOptimisticEntries: readonly OptimisticChatMessageEntry[],
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
) {
  const mailDraftCardSignals = createMailDraftCardSignalsRegistry(threadId);
  const browserSessionCardSignals =
    createBrowserSessionCardSignalsRegistry(threadId);
  const artifactCardSignals = createArtifactCardSignalsRegistry(
    previewImageUrlsByUrl$,
  );
  const connectorCardSignals = createConnectorCardSignalsRegistry();
  const customConnectorCardSignals = createCustomConnectorCardSignalsRegistry();
  const permissionCardSignals = createPermissionCardSignalsRegistry();
  const computerUseAuthorizationCardSignals =
    createComputerUseAuthorizationCardSignalsRegistry();
  const planUpgradeCardSignals = createPlanUpgradeCardSignalsRegistry();
  const bodyBlocksRenderer = createBodyBlocksRenderer({
    artifactCardSignals,
    connectorCardSignals,
    customConnectorCardSignals,
    permissionCardSignals,
    computerUseAuthorizationCardSignals,
    planUpgradeCardSignals,
    mailDraftCardSignals,
    browserSessionCardSignals,
  });
  const registerBodyBlocks = bodyBlocksRenderer("register");
  const resolveBodyBlocks = bodyBlocksRenderer("resolve");

  for (const entry of initialOptimisticEntries) {
    registerBodyBlocks(entry.parsedBodyBlocks);
    registerMessageAttachments(entry.message, artifactCardSignals);
  }
  const persistentChatMessages$ = state<RegisteredChatMessage[]>([]);
  const hasServerConfirmedOldestMessage$ = state(false);
  const hasReachedOldestMessage$ = computed((get): boolean => {
    return (
      get(hasServerConfirmedOldestMessage$) ||
      get(persistentChatMessages$)[0]?.message.seqId === 1
    );
  });
  const optimisticMessages$ = createOptimisticChatMessagesForThread(threadId);
  const appendOptimisticMessage$ = command(
    ({ set }, input: OptimisticChatMessageInput): void => {
      const entry = createOptimisticChatMessageEntry(input);
      registerBodyBlocks(entry.parsedBodyBlocks);
      registerMessageAttachments(entry.message, artifactCardSignals);
      set(appendOptimisticChatMessage$, entry);
    },
  );

  const rawMessages$ = createRawMessagesComputed({
    persistentMessages$: persistentChatMessages$,
    optimisticMessages$,
    resolveBodyBlocks,
  });
  const historyBackfillProgress$ = createHistoryBackfillProgress(
    hasReachedOldestMessage$,
    persistentChatMessages$,
  );
  const semanticMessages$ = computed((get): SemanticChatMessage[] => {
    return semanticTranscriptMessagesFromRaw(get(rawMessages$));
  });
  const messageRunIndicatorState$ =
    createMessageRunIndicatorState(rawMessages$);
  const semanticSignals = createMessageSemanticSignals(
    semanticMessages$,
    messageRunIndicatorState$,
  );
  const messageSync = createMessageSyncSignals(semanticSignals.hasMessages$);

  // The thread's active goal, folded from the (goal-marker) message stream so
  // the composer reads it without polling a separate resource. Reads rawMessages$
  // because goal markers are control rows, not transcript rows.
  const activeGoalObjective$ = createActiveGoalObjectiveComputed(rawMessages$);

  const renderedMessages = createRenderedChatGroups(semanticMessages$);

  const mailDraftCardSignalsById$ = createMailDraftCardSignalsById(
    rawMessages$,
    mailDraftCardSignals,
  );
  const browserSessionCardSignalsById$ = createBrowserSessionCardSignalsById(
    rawMessages$,
    browserSessionCardSignals,
  );

  const mergePersistentMessages$ = createMergePersistentMessages(
    threadId,
    persistentChatMessages$,
    registerBodyBlocks,
    artifactCardSignals,
  );
  const initializeIndexedDbMessages$ = createInitializeIndexedDbMessages({
    artifactCardSignals,
    threadId,
    persistentMessages$: persistentChatMessages$,
    registerBodyBlocks,
  });

  const latestMessageSignals = createLatestMessageSignals(rawMessages$);

  const runSyncRemoteMessages$ = createSyncRemoteMessagesCommand({
    threadId,
    persistentMessages$: persistentChatMessages$,
    hasReachedOldestMessage$,
    hasServerConfirmedOldestMessage$,
    mergePersistentMessages$,
    dataSource,
  });
  const syncRemoteMessages$ = createTrackedMessageSyncCommand(
    runSyncRemoteMessages$,
    messageSync.trackMessageSync$,
  );

  return {
    initializeIndexedDbMessages$,
    mergePersistentMessages$,
    ...latestMessageSignals,
    appendOptimisticMessage$,
    ...semanticSignals,
    ...messageSync,
    ...renderedMessages,
    rawMessages$,
    historyBackfillProgress$,
    messageRunIndicatorState$,
    activeGoalObjective$,
    mailDraftCardSignalsById$,
    reloadMailDrafts$: mailDraftCardSignals.reload$,
    browserSessionCardSignalsById$,
    artifactSignalsForUrl: (url: string): ArtifactSignals | undefined => {
      return artifactCardSignals.find(url);
    },
    syncRemoteMessages$,
  };
}

function createChatThreadMessagePipeline({
  threadId,
  dataSource,
  initialOptimisticEntries,
  recordScrollHeightForPrepend$,
  clearScrollHeightForPrepend$,
  awayFromBottom$,
  previewImageUrlsByUrl$,
}: {
  threadId: string;
  dataSource: ChatThreadRemote;
  initialOptimisticEntries: readonly OptimisticChatMessageEntry[];
  recordScrollHeightForPrepend$: Command<
    PrependScrollCompensationToken | null,
    []
  >;
  clearScrollHeightForPrepend$: Command<
    void,
    [PrependScrollCompensationToken | null | undefined]
  >;
  awayFromBottom$: Computed<boolean>;
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>;
}) {
  const pagedMessages = createPagedMessages(
    threadId,
    dataSource,
    initialOptimisticEntries,
    previewImageUrlsByUrl$,
  );
  const renderWindow = createChatRenderWindow({
    threadId,
    allRenderedChatGroups$: pagedMessages.allRenderedChatGroups$,
    awayFromBottom$,
  });

  const loadMoreRenderedChatGroups$ =
    createLoadMoreRenderedChatGroupsWithPrependScroll(
      recordScrollHeightForPrepend$,
      clearScrollHeightForPrepend$,
      renderWindow.loadMoreRenderedChatGroups$,
    );
  return {
    ...pagedMessages,
    ...renderWindow,
    loadMoreRenderedChatGroups$,
  };
}

function createArtifacts(threadId: string) {
  const internalArtifactsReload$ = state(0);
  const artifacts$ = computed(async (get): Promise<ChatThreadArtifactRun[]> => {
    get(internalArtifactsReload$);
    const client = get(zeroClient$)(chatThreadArtifactsContract);
    const result = await accept(client.list({ params: { threadId } }), [200]);
    return result.body.runs;
  });

  const reloadArtifacts$ = command(({ set }) => {
    set(internalArtifactsReload$, (version) => {
      return version + 1;
    });
  });

  return { artifacts$, reloadArtifacts$ };
}

function createArtifactPreviewImageUrls(
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>,
): Computed<Promise<ReadonlyMap<string, string>>> {
  return computed(async (get) => {
    const runs = await get(artifacts$);
    const previewImageUrlsByUrl = new Map<string, string>();
    for (const run of runs) {
      for (const file of run.files) {
        if (!file.previewImageUrl) {
          continue;
        }
        previewImageUrlsByUrl.set(file.url, file.previewImageUrl);
        if (file.aliasUrl) {
          previewImageUrlsByUrl.set(file.aliasUrl, file.previewImageUrl);
        }
      }
    }
    return previewImageUrlsByUrl;
  });
}

// ---------------------------------------------------------------------------
// Draft cache
// ---------------------------------------------------------------------------

const draftCache$ = state(new Map<string, DraftSignals>());

export const ensureDraft$ = command(
  ({ get, set }, threadId: string): { draft: DraftSignals; isNew: boolean } => {
    const cache = get(draftCache$);
    const existing = cache.get(threadId);
    if (existing) {
      return { draft: existing, isNew: false };
    }
    const draft = createDraftSignals();
    const next = new Map(cache);
    next.set(threadId, draft);
    set(draftCache$, next);
    return { draft, isNew: true };
  },
);

function createMessageRunIndicatorState(
  rawMessages$: Computed<ChatMessageProjectionEntry[]>,
) {
  return computed((get): Promise<RunIndicatorState> => {
    const raw = get(rawMessages$);
    return Promise.resolve(deriveRunIndicatorStateFromRawMessages(raw));
  });
}

function createLoadMoreRenderedChatGroupsWithPrependScroll(
  recordScrollHeightForPrepend$: Command<
    PrependScrollCompensationToken | null,
    []
  >,
  clearScrollHeightForPrepend$: Command<
    void,
    [PrependScrollCompensationToken | null | undefined]
  >,
  loadMoreRenderedChatGroups$: Command<Promise<boolean>, [AbortSignal]>,
) {
  return command(async ({ set }, signal: AbortSignal) => {
    const compensationToken = set(recordScrollHeightForPrepend$);
    const didPrepend = await set(loadMoreRenderedChatGroups$, signal);
    if (!didPrepend) {
      set(clearScrollHeightForPrepend$, compensationToken);
    }
    return didPrepend;
  });
}

// ---------------------------------------------------------------------------
// Factory: createRunTracking
// ---------------------------------------------------------------------------

interface RunTrackingDeps {
  threadId: string;
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  initializeIndexedDbMessages$: Command<Promise<void>, [AbortSignal]>;
  mergePersistentMessages$: Command<void, [ChatEvent[]]>;
  syncRemoteMessages$: Command<Promise<void>, [AbortSignal]>;
  settleMessageSync$: Command<Promise<void>, []>;
  reloadArtifacts$: Command<void, []>;
  reloadMailDrafts$: Command<void, []>;
  reloadComposerWorkflows$: Command<Promise<void>, [AbortSignal]>;
  autoScroll$: Command<void, []>;
  automationSignals: Pick<
    ChatThreadSignals,
    "headerAutomations" | "workflowQueue"
  >;
  dataSource: ChatThreadRemote;
}

interface MarkThreadReadDeps {
  threadId: string;
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  locallyMarkedReadAt$: State<string | undefined>;
  dataSource: ChatThreadRemote;
}

interface ChatRenderWindowState {
  cursorGroupId: string | null;
}

const INITIAL_RENDER_GROUP_COUNT = 10;
const RENDER_GROUP_LOAD_INCREMENT = 10;

const renderWindowStateByThreadId$ = state(
  new Map<string, ChatRenderWindowState>(),
);

function renderWindowStartIndex(
  groups: readonly GroupedChatMessageGroup[],
  cursorGroupId: string | null,
): number {
  return runGroupVisualWindowStartIndex(
    groups,
    cursorGroupId,
    INITIAL_RENDER_GROUP_COUNT,
  );
}

function previousRenderWindowStartIndex(
  groups: readonly GroupedChatMessageGroup[],
  currentStartGroupIndex: number,
): number {
  return previousRunGroupVisualWindowStartIndex(
    groups,
    currentStartGroupIndex,
    RENDER_GROUP_LOAD_INCREMENT,
  );
}

function renderWindowStateForThread(
  stateByThreadId: ReadonlyMap<string, ChatRenderWindowState>,
  threadId: string,
): ChatRenderWindowState {
  return stateByThreadId.get(threadId) ?? { cursorGroupId: null };
}

function setThreadRenderWindowState(
  stateByThreadId: ReadonlyMap<string, ChatRenderWindowState>,
  threadId: string,
  nextState: ChatRenderWindowState,
): Map<string, ChatRenderWindowState> {
  const next = new Map(stateByThreadId);
  next.set(threadId, nextState);
  return next;
}

function createChatRenderWindow({
  threadId,
  allRenderedChatGroups$,
  awayFromBottom$,
}: {
  threadId: string;
  allRenderedChatGroups$: Computed<Promise<GroupedChatMessageGroup[]>>;
  awayFromBottom$: Computed<boolean>;
}) {
  const visibleRenderedChatGroups$ = computed(
    async (get): Promise<GroupedChatMessageGroup[]> => {
      const groups = await get(allRenderedChatGroups$);
      const { cursorGroupId } = renderWindowStateForThread(
        get(renderWindowStateByThreadId$),
        threadId,
      );
      return groups.slice(renderWindowStartIndex(groups, cursorGroupId));
    },
  );
  const visibleRenderedChatGroupsReady$ = computed(
    async (get): Promise<boolean> => {
      await get(visibleRenderedChatGroups$);
      return true;
    },
  );

  const loadMoreRenderedChatGroups$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<boolean> => {
      const current = renderWindowStateForThread(
        get(renderWindowStateByThreadId$),
        threadId,
      );
      const groups = await get(allRenderedChatGroups$);
      signal.throwIfAborted();
      const startIndex = renderWindowStartIndex(groups, current.cursorGroupId);
      const nextStartIndex = previousRenderWindowStartIndex(groups, startIndex);
      if (nextStartIndex === startIndex) {
        return false;
      }
      set(renderWindowStateByThreadId$, (prev) => {
        return setThreadRenderWindowState(prev, threadId, {
          cursorGroupId: groups[nextStartIndex]?.beginMessageId ?? null,
        });
      });
      return true;
    },
  );

  const resetRenderedChatGroupsIfAtBottom$ = command(({ get, set }) => {
    if (get(awayFromBottom$)) {
      return;
    }
    const current = renderWindowStateForThread(
      get(renderWindowStateByThreadId$),
      threadId,
    );
    if (current.cursorGroupId === null) {
      return;
    }
    set(renderWindowStateByThreadId$, (prev) => {
      return setThreadRenderWindowState(prev, threadId, {
        ...current,
        cursorGroupId: null,
      });
    });
  });

  return {
    visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$,
    loadMoreRenderedChatGroups$,
    resetRenderedChatGroupsIfAtBottom$,
  };
}

function createMarkThreadReadIfNeeded({
  threadId,
  latestRunFinishCreatedAt$,
  locallyMarkedReadAt$,
  dataSource,
}: MarkThreadReadDeps) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return command(async ({ get, set }, sig: AbortSignal) => {
    const latestRunFinishCreatedAt = await get(latestRunFinishCreatedAt$);
    sig.throwIfAborted();
    if (!latestRunFinishCreatedAt) {
      return;
    }
    if (get(optimisticCreateUnsettled$)) {
      L.debug("markRead$ optimistic thread create unsettled, skip", {
        threadId,
        latestRunFinishCreatedAt,
      });
      return;
    }

    const lastReadAt = get(locallyMarkedReadAt$);
    if (
      lastReadAt !== undefined &&
      compareCreatedAt(lastReadAt, latestRunFinishCreatedAt) >= 0
    ) {
      return;
    }

    const newLastReadAt = await set(dataSource.markRead$, { threadId }, sig);
    sig.throwIfAborted();
    if (newLastReadAt !== null) {
      set(locallyMarkedReadAt$, newLastReadAt);
    }
    // No sidebar reload needed: markRead$ records an optimistic read mark
    // and applies the response's unread snapshot, so the unread dot clears
    // without refetching the thread list.
  });
}

function createOnSubscribedCommand({
  threadId,
  syncRemoteMessages$,
  settleMessageSync$,
  reloadArtifacts$,
  reloadMailDrafts$,
  reloadComposerWorkflows$,
  markThreadReadIfNeeded$,
}: Pick<
  RunTrackingDeps,
  | "threadId"
  | "syncRemoteMessages$"
  | "settleMessageSync$"
  | "reloadArtifacts$"
  | "reloadMailDrafts$"
  | "reloadComposerWorkflows$"
> & {
  markThreadReadIfNeeded$: Command<Promise<void>, [AbortSignal]>;
}): Command<Promise<void>, [AbortSignal]> {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  const hasSubscribed$ = state(false);
  return command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ catchup start", { threadId });
    set(reloadArtifacts$);
    if (get(hasSubscribed$)) {
      set(reloadMailDrafts$);
    } else {
      set(hasSubscribed$, true);
    }
    await Promise.all([
      set(reloadComposerWorkflows$, signal),
      get(optimisticCreateUnsettled$)
        ? set(settleMessageSync$)
        : set(syncRemoteMessages$, signal),
    ]);
    signal.throwIfAborted();
    await set(markThreadReadIfNeeded$, signal);
    signal.throwIfAborted();
    L.debug("subscribeChatThread$ catchup done", { threadId });
  });
}

function createReceiveSyncedEventsCommand({
  threadId,
  mergePersistentMessages$,
  markThreadReadIfNeeded$,
  autoScroll$,
}: Pick<
  RunTrackingDeps,
  "threadId" | "mergePersistentMessages$" | "autoScroll$"
> & {
  markThreadReadIfNeeded$: Command<Promise<void>, [AbortSignal]>;
}): Command<Promise<void>, [ChatEvent[], AbortSignal]> {
  return command(
    async (
      { set },
      events: ChatEvent[],
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      L.debug("receiveSyncedEvents$ fired", {
        threadId,
        count: events.length,
      });
      set(mergePersistentMessages$, events);
      await set(markThreadReadIfNeeded$, signal);
      signal.throwIfAborted();
      animationFrame(
        () => {
          set(autoScroll$);
        },
        { signal },
      );
    },
  );
}

function createRunTracking({
  threadId,
  latestRunFinishCreatedAt$,
  initializeIndexedDbMessages$,
  mergePersistentMessages$,
  syncRemoteMessages$,
  settleMessageSync$,
  reloadArtifacts$,
  reloadMailDrafts$,
  reloadComposerWorkflows$,
  autoScroll$,
  automationSignals,
  dataSource,
}: RunTrackingDeps) {
  const locallyMarkedReadAt$ = state<string | undefined>(undefined);

  const markThreadReadIfNeeded$ = createMarkThreadReadIfNeeded({
    threadId,
    latestRunFinishCreatedAt$,
    locallyMarkedReadAt$,
    dataSource,
  });

  const receiveSyncedEvents$ = createReceiveSyncedEventsCommand({
    threadId,
    mergePersistentMessages$,
    markThreadReadIfNeeded$,
    autoScroll$,
  });

  const onSubscribed$ = createOnSubscribedCommand({
    threadId,
    syncRemoteMessages$,
    settleMessageSync$,
    reloadArtifacts$,
    reloadMailDrafts$,
    reloadComposerWorkflows$,
    markThreadReadIfNeeded$,
  });

  const subscribeChatThread$ = command(async ({ set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ start", { threadId });
    await set(initializeIndexedDbMessages$, signal);
    signal.throwIfAborted();

    const onAutomationsChanged$ = command(({ set }) => {
      set(automationSignals.headerAutomations.reload$);
      set(reloadMailDrafts$);
      return false;
    });

    const onArtifactsChanged$ = command(({ set }) => {
      L.debug("onArtifactsChanged$ fired", { threadId });
      set(reloadArtifacts$);
      return false;
    });

    const onWorkflowsChanged$ = command(
      async ({ set }, signal: AbortSignal): Promise<boolean> => {
        L.debug("onWorkflowsChanged$ fired", { threadId });
        await set(reloadComposerWorkflows$, signal);
        return false;
      },
    );

    await Promise.all([
      set(markThreadReadIfNeeded$, signal),
      set(subscribeComputerUseHostsChanged$, signal),
      set(
        dataSource.subscribeRealtime$,
        {
          threadId,
          handlers: {
            onAutomationsChanged$,
            onArtifactsChanged$,
            onWorkflowsChanged$,
            onWorkflowQueueChanged$:
              automationSignals.workflowQueue.handleChanged$,
            onSubscribed$,
          },
        },
        signal,
      ),
    ]);
  });

  return { receiveSyncedEvents$, subscribeChatThread$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: sendMessage command
// ---------------------------------------------------------------------------

interface PreparedSendMessageResult {
  prompt: string;
  attachFiles: AttachFile[] | undefined;
  attachments: ChatPromptEvent["attachFiles"];
  hasTextContent: boolean;
}

function prepareTextOnlyUserMessage(
  prompt: string,
): PreparedSendMessageResult | null {
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) {
    return null;
  }
  return {
    prompt: trimmedPrompt,
    attachFiles: undefined,
    attachments: undefined,
    hasTextContent: true,
  };
}

function userMessageForSend({
  prompt,
  editorDocument,
  generationTemplate,
  attachments,
}: {
  readonly prompt: string;
  readonly editorDocument: SendMessageOptions["editorDocument"];
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly attachments: ChatPromptEvent["attachFiles"];
}): UserMessageDocument {
  const userMessage = editorDocument
    ? editorDocument.toMessageDocument({
        generationTemplate,
        attachments,
      })
    : textToMessageDocument(prompt, undefined, attachments);
  if (!userMessage) {
    throw new Error("Failed to serialize user message");
  }
  return userMessage;
}

function queueUserMessage(
  options: QueueMessageOptions,
  result: PreparedSendMessageResult,
): UserMessageDocument {
  return userMessageForSend({
    prompt: result.prompt,
    editorDocument: options.editorDocument,
    generationTemplate: options.generationTemplate,
    attachments: result.attachments,
  });
}

function queueRuntimeOptions(
  features: Partial<Record<FeatureSwitchKey, boolean>>,
  modelSelection: ModelProviderSelection | null,
) {
  return {
    runOptions: runOptionsFromModelProviderSelection(
      modelSelection,
      features[FeatureSwitchKey.CodexFastMode] ?? false,
    ),
    realAgentInPreviewEnabled:
      features[FeatureSwitchKey.RealAgentInPreview] ?? false,
  };
}

function createSendOptimisticMessageEntry({
  threadId,
  clientEventId,
  createdAt,
  result,
  generationTemplate,
  userMessage,
  options,
}: {
  threadId: string;
  clientEventId: string;
  createdAt: string;
  result: PreparedSendMessageResult;
  generationTemplate: GenerationTemplateRequest | undefined;
  userMessage: UserMessageDocument;
  options: SendMessageOptions | undefined;
}): OptimisticChatMessageInput {
  return {
    threadId,
    optimisticUserMessageAssociation: "run",
    message: {
      id: clientEventId,
      threadId,
      eventType: "input.prompt",
      content: result.prompt,
      attachFiles: result.attachments,
      generationTemplate,
      userMessage,
      ...sendMessageRevocationPatch(options),
      createdAt,
    },
  };
}

function sendMessageRevocationPatch(options: SendMessageOptions | undefined): {
  readonly revokesEventId?: string;
} {
  return options?.revokesEventId
    ? { revokesEventId: options.revokesEventId }
    : {};
}

function sendMessageRequestBody(params: {
  readonly agentId: string;
  readonly threadId: string;
  readonly clientEventId: string;
  readonly chatThreadSortEventId: string;
  readonly result: PreparedSendMessageResult;
  readonly modelSelection: ModelProviderSelection | null;
  readonly codexFastModeEnabled: boolean;
  readonly realAgentInPreviewEnabled: boolean;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly userMessage: UserMessageDocument;
  readonly options: SendMessageOptions | undefined;
}) {
  const runOptions = runOptionsFromModelProviderSelection(
    params.modelSelection,
    params.codexFastModeEnabled,
  );
  return {
    agentId: params.agentId,
    prompt: params.result.prompt,
    threadId: params.threadId,
    hasTextContent: params.result.hasTextContent,
    clientEventId: params.clientEventId,
    chatThreadSortEventId: params.chatThreadSortEventId,
    ...(runOptions ? { runOptions } : {}),
    ...(params.realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
    generationTemplate: params.generationTemplate,
    userMessage: params.userMessage,
    ...(params.options && "computerUseHostId" in params.options
      ? { computerUseHostId: params.options.computerUseHostId ?? null }
      : {}),
    ...(params.options && "cloudBrowserEnabled" in params.options
      ? { cloudBrowserEnabled: params.options.cloudBrowserEnabled ?? false }
      : {}),
    attachFiles: params.result.attachFiles,
    ...sendMessageRevocationPatch(params.options),
  };
}

function createAppendOptimisticSendMessage(
  appendOptimisticMessage$: Command<void, [OptimisticChatMessageInput]>,
) {
  return command(
    (
      { set },
      args: {
        readonly threadId: string;
        readonly agentId: string;
        readonly clientEventId: string;
        readonly chatThreadSortEventId: string;
        readonly createdAt: string;
        readonly result: PreparedSendMessageResult;
        readonly generationTemplate: GenerationTemplateRequest | undefined;
        readonly userMessage: UserMessageDocument;
        readonly options: SendMessageOptions | undefined;
      },
    ) => {
      set(touchOptimisticChatThreadSort$, {
        id: args.chatThreadSortEventId,
        threadId: args.threadId,
        agentId: args.agentId,
        createdAt: args.createdAt,
      });
      set(
        appendOptimisticMessage$,
        createSendOptimisticMessageEntry({
          threadId: args.threadId,
          clientEventId: args.clientEventId,
          createdAt: args.createdAt,
          result: args.result,
          generationTemplate: args.generationTemplate,
          userMessage: args.userMessage,
          options: args.options,
        }),
      );
    },
  );
}

function createComposerSendButtonSignals(messages: {
  allFinished$: Computed<Promise<boolean>>;
  lastAssistantCancelled$: Computed<Promise<boolean>>;
}) {
  const pendingSendCount$ = state(0);
  const composerSendButtonStatus$ = computed(
    async (get): Promise<ComposerSendButtonStatus> => {
      const sendPending = get(pendingSendCount$) > 0;
      const [allFinished, lastAssistantCancelled] = await Promise.all([
        get(messages.allFinished$),
        get(messages.lastAssistantCancelled$),
      ]);
      return (sendPending || !allFinished) && !lastAssistantCancelled
        ? "sending"
        : "idle";
    },
  );
  return { pendingSendCount$, composerSendButtonStatus$ };
}

interface SendMessageDeps {
  threadId: string;
  pendingSendCount$: State<number>;
  agentId$: Computed<string | null>;
  modelSelectionForSend$: Command<
    Promise<ModelProviderSelection | null>,
    [AbortSignal]
  >;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  scrollToBottom$: Command<void, []>;
  syncRemoteMessages$: Command<Promise<void>, [AbortSignal]>;
  appendOptimisticMessage$: Command<void, [OptimisticChatMessageInput]>;
}

interface ValidatedSendMessageRequest {
  readonly prompt: string;
  readonly options: SendMessageOptions | undefined;
  readonly agentId: string;
  readonly modelSelection: ModelProviderSelection | null;
}

const postSendMessage$ = command(
  async (
    { get, set },
    args: {
      readonly agentId: string;
      readonly threadId: string;
      readonly clientEventId: string;
      readonly chatThreadSortEventId: string;
      readonly result: PreparedSendMessageResult;
      readonly modelSelection: ModelProviderSelection | null;
      readonly generationTemplate: GenerationTemplateRequest | undefined;
      readonly userMessage: UserMessageDocument;
      readonly options: SendMessageOptions | undefined;
      readonly flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const features = get(featureSwitch$);
    const codexFastModeEnabled =
      features[FeatureSwitchKey.CodexFastMode] ?? false;
    const realAgentInPreviewEnabled =
      features[FeatureSwitchKey.RealAgentInPreview] ?? false;
    const [, sendResult] = await Promise.all([
      set(args.flushDraftClear$, signal),
      sendChatEvent(
        get(zeroClient$),
        sendMessageRequestBody({
          agentId: args.agentId,
          clientEventId: args.clientEventId,
          chatThreadSortEventId: args.chatThreadSortEventId,
          threadId: args.threadId,
          result: args.result,
          modelSelection: args.modelSelection,
          codexFastModeEnabled,
          realAgentInPreviewEnabled,
          generationTemplate: args.generationTemplate,
          userMessage: args.userMessage,
          options: args.options,
        }),
        signal,
      ),
    ]);
    signal.throwIfAborted();
    return sendResult.runId;
  },
);

function createPerformSendMessage(deps: SendMessageDeps) {
  const {
    threadId,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    scrollToBottom$,
    syncRemoteMessages$,
    appendOptimisticMessage$,
  } = deps;
  const appendOptimisticSendMessage$ = createAppendOptimisticSendMessage(
    appendOptimisticMessage$,
  );
  return command(
    async (
      { get, set },
      request: ValidatedSendMessageRequest,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const generationTemplate = request.options?.editorDocument
        ? request.options.generationTemplate
        : get(draft.generationTemplate$);
      const result =
        request.options?.includeDraftAttachments === false
          ? prepareTextOnlyUserMessage(request.prompt)
          : await set(
              prepareUserMessageFromDraft$,
              draft,
              request.prompt,
              {
                excludeVisualAttachments:
                  shouldExcludeVisualAttachmentsForModel(
                    request.modelSelection?.selectedModel,
                  ),
              },
              signal,
            );
      if (!result) {
        L.debug("sendMessage$ prepare returned null, abort", { threadId });
        return false;
      }
      signal.throwIfAborted();
      const userMessage = userMessageForSend({
        prompt: result.prompt,
        editorDocument: request.options?.editorDocument,
        generationTemplate,
        attachments: result.attachments,
      });
      set(cancelDraftSync$);
      set(draft.clear$);
      const clientEventId = crypto.randomUUID();
      const chatThreadSortEventId = crypto.randomUUID();
      const createdAt = nowDate().toISOString();
      set(appendOptimisticSendMessage$, {
        threadId,
        agentId: request.agentId,
        clientEventId,
        chatThreadSortEventId,
        createdAt,
        result,
        generationTemplate,
        userMessage,
        options: request.options,
      });
      animationFrame(
        () => {
          set(scrollToBottom$);
        },
        { signal },
      );
      const runId = await set(
        postSendMessage$,
        {
          agentId: request.agentId,
          threadId,
          clientEventId,
          chatThreadSortEventId,
          result,
          modelSelection: request.modelSelection,
          generationTemplate,
          userMessage,
          options: request.options,
          flushDraftClear$,
        },
        signal,
      );
      L.debug("sendMessage$ POST accepted", {
        threadId,
        runId,
      });
      if (runId === null) {
        set(reloadBillingStatus$);
        await set(syncRemoteMessages$, signal);
        signal.throwIfAborted();
        set(scrollToBottom$);
      }
      return true;
    },
  );
}

function createSendMessage(deps: SendMessageDeps) {
  const { threadId, pendingSendCount$, agentId$, modelSelectionForSend$ } =
    deps;
  const performSendMessage$ = createPerformSendMessage(deps);
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return command(
    async (
      { get, set },
      prompt: string,
      options: SendMessageOptions | undefined,
      signal: AbortSignal,
    ): Promise<boolean> => {
      L.debug("sendMessage$ start", { threadId, promptLen: prompt.length });
      if (get(optimisticCreateUnsettled$)) {
        return false;
      }
      const agentId = get(agentId$);
      if (!agentId) {
        L.debug("sendMessage$ no agentId, abort", { threadId });
        return false;
      }
      const modelSelection = await set(modelSelectionForSend$, signal);
      signal.throwIfAborted();
      set(pendingSendCount$, (count) => {
        return count + 1;
      });
      return await withCleanup(
        set(
          performSendMessage$,
          {
            prompt,
            options,
            agentId,
            modelSelection,
          },
          signal,
        ),
        () => {
          set(pendingSendCount$, (count) => {
            return count - 1;
          });
        },
      );
    },
  );
}

interface QueueMessageDeps {
  threadId: string;
  agentId$: Computed<string | null>;
  modelSelectionForSend$: Command<
    Promise<ModelProviderSelection | null>,
    [AbortSignal]
  >;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  scrollToBottom$: Command<void, []>;
  appendOptimisticMessage$: Command<void, [OptimisticChatMessageInput]>;
  dataSource: ChatThreadRemote;
}

function createQueueMessage(deps: QueueMessageDeps) {
  const {
    threadId,
    agentId$,
    modelSelectionForSend$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    scrollToBottom$,
    appendOptimisticMessage$,
    dataSource,
  } = deps;
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);

  return command(
    async (
      { get, set },
      prompt: string,
      options: QueueMessageOptions,
      signal: AbortSignal,
    ): Promise<boolean> => {
      if (get(optimisticCreateUnsettled$)) {
        L.debug("queueMessage$ optimistic thread create unsettled, abort", {
          threadId,
        });
        return false;
      }
      const agentId = get(agentId$);
      if (!agentId) {
        L.debug("queueMessage$ no thread metadata, abort", { threadId });
        return false;
      }
      const generationTemplate = options.generationTemplate;
      const modelSelection = await set(modelSelectionForSend$, signal);
      signal.throwIfAborted();
      const result = await set(
        prepareUserMessageFromDraft$,
        draft,
        prompt,
        {
          excludeVisualAttachments: shouldExcludeVisualAttachmentsForModel(
            modelSelection?.selectedModel,
          ),
        },
        signal,
      );
      if (!result) {
        return false;
      }
      signal.throwIfAborted();

      const features = get(featureSwitch$);
      const userMessage = queueUserMessage(options, result);

      set(cancelDraftSync$);
      set(draft.clear$);

      const clientEventId = crypto.randomUUID();
      const chatThreadSortEventId = crypto.randomUUID();
      const nowIso = nowDate().toISOString();
      set(touchOptimisticChatThreadSort$, {
        id: chatThreadSortEventId,
        threadId,
        agentId,
        createdAt: nowIso,
      });
      set(appendOptimisticMessage$, {
        threadId,
        optimisticUserMessageAssociation: "queue",
        message: {
          id: clientEventId,
          threadId,
          eventType: "input.prompt",
          content: result.prompt,
          attachFiles: result.attachments,
          generationTemplate,
          userMessage,
          createdAt: nowIso,
        },
      });
      animationFrame(
        () => {
          set(scrollToBottom$);
        },
        { signal },
      );

      const { runOptions, realAgentInPreviewEnabled } = queueRuntimeOptions(
        features,
        modelSelection,
      );
      await Promise.all([
        set(flushDraftClear$, signal),
        set(
          dataSource.appendQueuedEvent$,
          {
            threadId,
            agentId,
            content: result.prompt,
            attachments: result.attachments ?? null,
            clientEventId,
            chatThreadSortEventId,
            hasTextContent: result.hasTextContent,
            ...(runOptions ? { runOptions } : {}),
            ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
            generationTemplate,
            userMessage,
            ...(options.computerUseHostId === undefined
              ? {}
              : { computerUseHostId: options.computerUseHostId }),
            ...(options.cloudBrowserEnabled === undefined
              ? {}
              : { cloudBrowserEnabled: options.cloudBrowserEnabled }),
          },
          signal,
        ),
      ]);
      signal.throwIfAborted();

      return true;
    },
  );
}

interface RecallMessageDeps {
  threadId: string;
  agentId$: Computed<string | null>;
  rawMessages$: Computed<ChatMessageProjectionEntry[]>;
  draft: DraftSignals;
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  appendOptimisticMessage$: Command<void, [OptimisticChatMessageInput]>;
  dataSource: ChatThreadRemote;
}

function createRecallMessage(deps: RecallMessageDeps) {
  const {
    threadId,
    agentId$,
    rawMessages$,
    draft,
    queueDraftSync$,
    appendOptimisticMessage$,
    dataSource,
  } = deps;

  return command(
    async ({ get, set }, messageId: string, signal: AbortSignal) => {
      const message = queuedMessagesFromRaw(get(rawMessages$)).find(
        (candidate) => {
          return candidate.id === messageId;
        },
      );
      if (
        !message ||
        (message.eventType !== "input.prompt" &&
          message.eventType !== "input.rejected")
      ) {
        return;
      }

      const agentId = get(agentId$);
      if (!agentId) {
        return;
      }

      const clientEventId = crypto.randomUUID();
      set(appendOptimisticMessage$, {
        threadId,
        message: {
          id: clientEventId,
          threadId,
          eventType: "control.revoke",
          content: null,
          revokesEventId: message.id,
          createdAt: nowDate().toISOString(),
        },
      });
      const userMessage = shouldUseUserMessage(message.userMessage)
        ? message.userMessage
        : null;
      const templatePart = userMessage?.parts.find((part) => {
        return part.type === "template";
      });
      set(draft.seed$, {
        content: userMessage
          ? (messageDocumentToPrompt(userMessage) ?? "")
          : (message.content ?? ""),
        userMessage,
        generationTemplate: userMessage
          ? templatePart?.type === "template"
            ? templatePart.template
            : undefined
          : message.generationTemplate,
        attachments: (message.attachFiles ?? []).map(createRestoredAttachment),
      });

      await set(
        dataSource.recallEvent$,
        {
          threadId,
          agentId,
          revokesEventId: message.id,
          clientEventId,
        },
        signal,
      );
      signal.throwIfAborted();
      await set(queueDraftSync$, signal);
      signal.throwIfAborted();
    },
  );
}

interface MessageCommandsDeps
  extends SendMessageDeps, QueueMessageDeps, RecallMessageDeps {}

function createMessageCommands(deps: MessageCommandsDeps) {
  return {
    sendMessage$: createSendMessage(deps),
    queueMessage$: createQueueMessage(deps),
    recallMessage$: createRecallMessage(deps),
  };
}

interface ThreadMessageActionsDeps extends MessageCommandsDeps {
  rawMessages$: Computed<ChatMessageProjectionEntry[]>;
}

function createThreadMessageActions(deps: ThreadMessageActionsDeps) {
  return {
    ...createMessageCommands(deps),
    cancelRun$: createCancelRunWithQueuedRecall(deps),
  };
}

function createCancelRunWithQueuedRecall({
  threadId,
  agentId$,
  rawMessages$,
  appendOptimisticMessage$,
  dataSource,
}: {
  threadId: string;
  agentId$: Computed<string | null>;
  rawMessages$: Computed<ChatMessageProjectionEntry[]>;
  appendOptimisticMessage$: Command<void, [OptimisticChatMessageInput]>;
  dataSource: ChatThreadRemote;
}) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return command(async ({ get, set }, signal: AbortSignal): Promise<void> => {
    if (get(optimisticCreateUnsettled$)) {
      L.debug("cancelRun$ optimistic thread create unsettled, skip", {
        threadId,
      });
      return;
    }
    const agentId = get(agentId$);
    if (!agentId) {
      return;
    }

    const raw = get(rawMessages$);
    const queuedMessages = queuedMessagesFromRaw(raw);

    const interruptRequests = cancellableRunIdsFromRawMessages(raw).map(
      (runId) => {
        const clientEventId = crypto.randomUUID();
        set(appendOptimisticMessage$, {
          threadId,
          message: {
            id: clientEventId,
            threadId,
            eventType: "control.interrupt",
            content: null,
            interruptsRunId: runId,
            createdAt: nowDate().toISOString(),
          },
        });
        return { runId, clientEventId };
      },
    );

    const recallRequests = queuedMessages.map((message) => {
      const clientEventId = crypto.randomUUID();
      set(appendOptimisticMessage$, {
        threadId,
        message: {
          id: clientEventId,
          threadId,
          eventType: "control.revoke",
          content: null,
          revokesEventId: message.id,
          createdAt: nowDate().toISOString(),
        },
      });
      return {
        threadId,
        agentId,
        revokesEventId: message.id,
        clientEventId,
      };
    });

    await Promise.all([
      set(
        dataSource.cancelRuns$,
        {
          threadId,
          agentId,
          interrupts: interruptRequests,
        },
        signal,
      ),
      Promise.all(
        recallRequests.map((request) => {
          return set(dataSource.recallEvent$, request, signal);
        }),
      ),
    ]);
    signal.throwIfAborted();
  });
}

// ---------------------------------------------------------------------------
// Sub-factory: thinking phrases
// ---------------------------------------------------------------------------

const THINKING_TYPEWRITER_INTERVAL_MS = 100;
const THINKING_TYPEWRITER_LINE_PAUSE_MS = 1000;
const THINKING_TYPEWRITER_LINE_PAUSE_TICKS = IN_VITEST
  ? 1
  : Math.ceil(
      THINKING_TYPEWRITER_LINE_PAUSE_MS / THINKING_TYPEWRITER_INTERVAL_MS,
    );
const THINKING_TYPEWRITER_WIDTH_GUARD_PX = 8;
const THINKING_TYPEWRITER_OVERFLOW_PREFIX = "...";

interface ThinkingTypewriterLine {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly text: string;
}

interface ThinkingTypewriterFrame {
  readonly messageId: string | undefined;
  readonly text: string;
  readonly width: number;
  readonly lineIndex: number;
  readonly charIndex: number;
  readonly pauseTicksRemaining: number;
  readonly displayedText: string;
  readonly complete: boolean;
}

function emptyThinkingTypewriterFrame(): ThinkingTypewriterFrame {
  return {
    messageId: undefined,
    text: "",
    width: 0,
    lineIndex: 0,
    charIndex: 0,
    pauseTicksRemaining: 0,
    displayedText: "",
    complete: false,
  };
}

function thinkingTextGraphemes(text: string): string[] {
  return Array.from(text);
}

function thinkingTypewriterStep(width: number): number {
  if (width >= 520) {
    return 3;
  }
  if (width >= 320) {
    return 2;
  }
  return 1;
}

function createThinkingTextMeasurer(
  el: HTMLElement,
): (value: string) => number | undefined {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const style = window.getComputedStyle(el);
  const font =
    style.font ||
    [
      style.fontStyle,
      style.fontVariant,
      style.fontWeight,
      style.fontSize,
      style.fontFamily,
    ]
      .filter(Boolean)
      .join(" ");
  const letterSpacing =
    style.letterSpacing === "normal"
      ? 0
      : Number.parseFloat(style.letterSpacing);

  if (!context || !font) {
    return () => {
      return undefined;
    };
  }

  context.font = font;
  return (value: string) => {
    const measured = context.measureText(value).width;
    if (!Number.isFinite(measured) || measured <= 0) {
      return undefined;
    }
    const spacing =
      Number.isFinite(letterSpacing) && letterSpacing > 0
        ? (thinkingTextGraphemes(value).length - 1) * letterSpacing
        : 0;
    return measured + spacing;
  };
}

function thinkingLabelWidth(el: HTMLElement): number {
  const elementWidth = Math.max(
    el.getBoundingClientRect().width,
    el.clientWidth,
  );
  if (elementWidth > 0) {
    return elementWidth;
  }

  const parent = el.parentElement;
  return Math.max(
    parent?.getBoundingClientRect().width ?? 0,
    parent?.clientWidth ?? 0,
  );
}

function wrapThinkingTextForWidth(args: {
  readonly graphemes: readonly string[];
  readonly width: number;
  readonly measureText: (value: string) => number | undefined;
}): ThinkingTypewriterLine[] {
  if (args.graphemes.length === 0) {
    return [];
  }
  if (!Number.isFinite(args.width) || args.width <= 0) {
    return [
      {
        startIndex: 0,
        endIndex: args.graphemes.length,
        text: args.graphemes.join(""),
      },
    ];
  }

  const maxWidth = Math.max(1, args.width - THINKING_TYPEWRITER_WIDTH_GUARD_PX);
  const lines: ThinkingTypewriterLine[] = [];
  let startIndex = 0;
  let current: string[] = [];

  for (let index = 0; index < args.graphemes.length; index++) {
    const grapheme = args.graphemes[index]!;
    const candidate = [...current, grapheme];
    const candidateText = candidate.join("");
    const measured = args.measureText(candidateText);
    if (measured === undefined) {
      return [
        {
          startIndex: 0,
          endIndex: args.graphemes.length,
          text: args.graphemes.join(""),
        },
      ];
    }

    if (measured <= maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }

    lines.push({
      startIndex,
      endIndex: index,
      text: current.join(""),
    });
    startIndex = index;
    current = [grapheme];
  }

  if (current.length > 0) {
    lines.push({
      startIndex,
      endIndex: args.graphemes.length,
      text: current.join(""),
    });
  }

  return lines;
}

function displayedSlidingThinkingText(args: {
  readonly graphemes: readonly string[];
  readonly startIndex: number;
  readonly charIndex: number;
  readonly width: number;
  readonly measureText: (value: string) => number | undefined;
}): string {
  const visibleGraphemes = args.graphemes.slice(
    args.startIndex,
    args.charIndex,
  );
  const visibleText = visibleGraphemes.join("");
  if (visibleText.length === 0) {
    return "";
  }
  if (!Number.isFinite(args.width) || args.width <= 0) {
    return visibleText;
  }

  const maxWidth = Math.max(1, args.width - THINKING_TYPEWRITER_WIDTH_GUARD_PX);
  const visibleWidth = args.measureText(visibleText);
  if (visibleWidth === undefined || visibleWidth <= maxWidth) {
    return visibleText;
  }

  let displayedText: string | undefined;
  for (let start = visibleGraphemes.length - 1; start >= 0; start--) {
    const candidate = `${THINKING_TYPEWRITER_OVERFLOW_PREFIX}${visibleGraphemes
      .slice(start)
      .join("")}`;
    const measured = args.measureText(candidate);
    if (measured === undefined) {
      return visibleText;
    }
    if (measured <= maxWidth) {
      displayedText = candidate;
      continue;
    }
    if (displayedText) {
      break;
    }
  }

  return displayedText ?? visibleGraphemes[visibleGraphemes.length - 1] ?? "";
}

function nextThinkingTypewriterFrame(args: {
  readonly messageId: string;
  readonly text: string;
  readonly currentFrame: ThinkingTypewriterFrame;
  readonly width: number;
  readonly measureText: (value: string) => number | undefined;
}): ThinkingTypewriterFrame {
  const width = Math.max(0, Math.floor(args.width));
  const graphemes = thinkingTextGraphemes(args.text);
  if (graphemes.length === 0) {
    return emptyThinkingTypewriterFrame();
  }
  const lines = wrapThinkingTextForWidth({
    graphemes,
    width,
    measureText: args.measureText,
  });
  if (lines.length === 0) {
    return emptyThinkingTypewriterFrame();
  }

  const currentFrame =
    args.currentFrame.messageId === args.messageId &&
    args.currentFrame.text === args.text &&
    args.currentFrame.width === width
      ? args.currentFrame
      : {
          ...emptyThinkingTypewriterFrame(),
          messageId: args.messageId,
          text: args.text,
          width,
        };
  const lineIndex = Math.min(currentFrame.lineIndex, lines.length - 1);
  const currentLine = lines[lineIndex]!;
  const nextLine = lines[lineIndex + 1];

  if (currentFrame.pauseTicksRemaining > 0) {
    return {
      ...currentFrame,
      lineIndex,
      pauseTicksRemaining: currentFrame.pauseTicksRemaining - 1,
      displayedText: currentLine.text,
      complete: false,
    };
  }

  if (currentFrame.charIndex >= currentLine.endIndex) {
    if (!nextLine) {
      return {
        ...currentFrame,
        lineIndex,
        displayedText: currentLine.text,
        complete: true,
      };
    }

    const nextCharIndex = Math.min(
      nextLine.endIndex,
      nextLine.startIndex + thinkingTypewriterStep(width),
    );
    return {
      ...currentFrame,
      lineIndex: lineIndex + 1,
      charIndex: nextCharIndex,
      pauseTicksRemaining: 0,
      displayedText: displayedSlidingThinkingText({
        graphemes,
        startIndex: nextLine.startIndex,
        charIndex: nextCharIndex,
        width,
        measureText: args.measureText,
      }),
      complete:
        lineIndex + 1 >= lines.length - 1 && nextCharIndex >= graphemes.length,
    };
  }

  const nextCharIndex = Math.min(
    currentLine.endIndex,
    currentFrame.charIndex + thinkingTypewriterStep(width),
  );

  return {
    ...currentFrame,
    lineIndex,
    charIndex: nextCharIndex,
    pauseTicksRemaining:
      nextCharIndex >= currentLine.endIndex && nextLine !== undefined
        ? THINKING_TYPEWRITER_LINE_PAUSE_TICKS
        : 0,
    displayedText: displayedSlidingThinkingText({
      graphemes,
      startIndex: currentLine.startIndex,
      charIndex: nextCharIndex,
      width,
      measureText: args.measureText,
    }),
    complete: nextCharIndex >= graphemes.length,
  };
}

function thinkingTypewriterFrameComplete(
  frame: ThinkingTypewriterFrame,
): boolean {
  return frame.complete;
}

function createThinkingIndicatorSignals(
  thinkingText$: Computed<Promise<string | null>>,
  thinkingMessageId$: Computed<Promise<string | null>>,
) {
  const blockColors = shuffleBlockColors();
  const blockColors$ = computed(() => {
    return blockColors;
  });
  const thinkingPhrase =
    THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)]!;
  const thinkingPhrase$ = computed(() => {
    return thinkingPhrase;
  });
  const thinkingTypewriterFrame$ = state<ThinkingTypewriterFrame>(
    emptyThinkingTypewriterFrame(),
  );
  const displayedThinkingText$ = computed((get): Promise<string> => {
    return Promise.resolve(get(thinkingTypewriterFrame$).displayedText);
  });
  const resetThinkingTypewriterLoopSignal$ = resetSignal();

  const setThinkingIndicatorTextRef$ = onRef(
    command(async ({ get, set }, el: HTMLElement, signal: AbortSignal) => {
      const loopSignal = set(resetThinkingTypewriterLoopSignal$, signal);
      const measureText = createThinkingTextMeasurer(el);
      set(thinkingTypewriterFrame$, emptyThinkingTypewriterFrame());

      await setLoop(
        async (sig) => {
          const [thinkingText, thinkingMessageId] = await Promise.all([
            get(thinkingText$),
            get(thinkingMessageId$),
          ]);
          sig.throwIfAborted();

          const text = thinkingText?.trim() ?? "";
          if (!thinkingMessageId || text.length === 0) {
            set(thinkingTypewriterFrame$, emptyThinkingTypewriterFrame());
            return true;
          }

          const width = thinkingLabelWidth(el);
          if (width <= 0 && !IN_VITEST) {
            return false;
          }
          const nextFrame = nextThinkingTypewriterFrame({
            messageId: thinkingMessageId,
            text,
            currentFrame: get(thinkingTypewriterFrame$),
            width,
            measureText,
          });
          set(thinkingTypewriterFrame$, nextFrame);
          return thinkingTypewriterFrameComplete(nextFrame);
        },
        THINKING_TYPEWRITER_INTERVAL_MS,
        loopSignal,
      );
    }),
  );

  return {
    blockColors$,
    thinkingPhrase$,
    displayedThinkingText$,
    setThinkingIndicatorTextRef$,
  };
}

// ---------------------------------------------------------------------------
// Factory: createChatThreadSignals
// ---------------------------------------------------------------------------

function publicChatThreadMessageSignals(
  messages: ReturnType<typeof createChatThreadMessagePipeline>,
) {
  return {
    latestRunFinishCreatedAt$: messages.latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$: messages.latestAssistantTextCreatedAt$,
    visibleRenderedChatGroups$: messages.visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$: messages.visibleRenderedChatGroupsReady$,
    sidebarAutoOpenCandidate$: messages.sidebarAutoOpenCandidate$,
    messageImageGroups$: messages.messageImageGroups$,
    artifactSignalsForUrl: messages.artifactSignalsForUrl,
    mailDraftCardSignalsById$: messages.mailDraftCardSignalsById$,
    browserSessionCardSignalsById$: messages.browserSessionCardSignalsById$,
    hasMessages$: messages.hasMessages$,
    hasNewMessages$: messages.hasNewMessages$,
    hasQueuedMessages$: messages.hasQueuedMessages$,
    queuedMessageItems$: messages.queuedMessageItems$,
    emptyQueuedMessageItems$: messages.emptyQueuedMessageItems$,
    thinkingIndicatorMode$: messages.thinkingIndicatorMode$,
    thinkingMessageId$: messages.thinkingMessageId$,
    thinkingText$: messages.thinkingText$,
    recommendedFollowupSource$: messages.recommendedFollowupSource$,
    historyBackfillProgress$: messages.historyBackfillProgress$,
    activeGoalObjective$: messages.activeGoalObjective$,
    donePhrase$: messages.donePhrase$,
    loadMoreRenderedChatGroups$: messages.loadMoreRenderedChatGroups$,
    resetRenderedChatGroupsIfAtBottom$:
      messages.resetRenderedChatGroupsIfAtBottom$,
  };
}

function createThreadComposer(
  draft: DraftSignals,
  threadId: string,
  agentId$: Computed<string | null>,
  inlineTemplatesEnabled: boolean,
  connectorAuthorization?: ComposerConnectorAuthorizationSignals,
) {
  const workflowComposer = createWorkflowComposerSignals(
    draft,
    threadId,
    agentId$,
    inlineTemplatesEnabled,
  );
  return {
    workflowComposer,
    composerConnectors: createComposerConnectorSignals(
      agentId$,
      connectorAuthorization,
    ),
    focusInput$: workflowComposer.focus$,
  };
}

export function createChatThreadSignals(
  threadId: string,
  draft: DraftSignals,
  dataSource: ChatThreadRemote = createRemoteChatThreadDataSource(threadId),
  options: {
    readonly initialOptimisticEntries?: readonly OptimisticChatMessageEntry[];
    readonly inlineTemplatesEnabled?: boolean;
    readonly connectorAuthorization?: ComposerConnectorAuthorizationSignals;
  } = {},
): ChatThreadSignals {
  const initialOptimisticEntries = options.initialOptimisticEntries ?? [];
  const inlineTemplatesEnabled = options.inlineTemplatesEnabled ?? false;
  const threadDraft$ = createRemoteThreadDraft(dataSource);
  const threadMeta$ = createThreadMeta(threadId);
  const threadTitle = createThreadTitleParts(threadMeta$);
  const threadSettledInServer$ = createThreadSettledInServer(threadId);
  const modelSelection = createModelSelection(
    threadId,
    threadMeta$,
    dataSource,
  );
  const modelSelectionForSend$ = createModelSelectionForSend(modelSelection);
  const computerUseHostSelection = createComputerUseHostSelection(
    threadId,
    threadMeta$,
    dataSource,
  );
  const {
    recordScrollHeightForPrepend$,
    clearScrollHeightForPrepend$,
    awayFromBottom$,
    ...scrollSignals
  } = createChatThreadScrollSignals(threadId);
  const container = createChatThreadContainerSignals();
  const { composerFileInput$, setComposerFileInput$ } =
    createComposerFileInput();
  const threadOwned = createThreadOwnedSignals(threadId, threadMeta$);
  const composer = createThreadComposer(
    draft,
    threadId,
    threadOwned.agentId$,
    inlineTemplatesEnabled,
    options.connectorAuthorization,
  );
  const artifact = createArtifacts(threadId);
  const previewImageUrlsByUrl$ = createArtifactPreviewImageUrls(
    artifact.artifacts$,
  );
  const messages = createChatThreadMessagePipeline({
    threadId,
    dataSource,
    initialOptimisticEntries,
    recordScrollHeightForPrepend$,
    clearScrollHeightForPrepend$,
    awayFromBottom$,
    previewImageUrlsByUrl$,
  });
  const { queueDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft, dataSource);
  const composerSendButton = createComposerSendButtonSignals(messages);
  const runTracking = createRunTracking({
    threadId,
    latestRunFinishCreatedAt$: messages.latestRunFinishCreatedAt$,
    initializeIndexedDbMessages$: messages.initializeIndexedDbMessages$,
    mergePersistentMessages$: messages.mergePersistentMessages$,
    syncRemoteMessages$: messages.syncRemoteMessages$,
    settleMessageSync$: messages.settleMessageSync$,
    reloadArtifacts$: artifact.reloadArtifacts$,
    reloadMailDrafts$: messages.reloadMailDrafts$,
    reloadComposerWorkflows$: composer.workflowComposer.reloadWorkflows$,
    autoScroll$: scrollSignals.autoScroll$,
    automationSignals: threadOwned,
    dataSource,
  });
  const messageActions = createThreadMessageActions({
    threadId,
    pendingSendCount$: composerSendButton.pendingSendCount$,
    agentId$: threadOwned.agentId$,
    modelSelectionForSend$,
    rawMessages$: messages.rawMessages$,
    draft,
    queueDraftSync$,
    cancelDraftSync$,
    flushDraftClear$,
    scrollToBottom$: scrollSignals.scrollToBottom$,
    syncRemoteMessages$: messages.syncRemoteMessages$,
    appendOptimisticMessage$: messages.appendOptimisticMessage$,
    dataSource,
  });
  return {
    threadId,
    threadDraft$,
    threadMeta$,
    ...threadTitle,
    threadSettledInServer$,
    ...modelSelection,
    ...computerUseHostSelection,
    ...messageActions,
    composerSendButtonStatus$: composerSendButton.composerSendButtonStatus$,
    ...scrollSignals,
    ...container,
    awayFromBottom$,
    draft,
    ...composer,
    composerFileInput$,
    setComposerFileInput$,
    ...threadOwned,
    queueDraftSync$,
    ...publicChatThreadMessageSignals(messages),
    receiveSyncedEvents$: runTracking.receiveSyncedEvents$,
    subscribeChatThread$: runTracking.subscribeChatThread$,
    ...createThinkingIndicatorSignals(
      messages.thinkingText$,
      messages.thinkingMessageId$,
    ),
    ...artifact,
  };
}
