import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { animationFrame, delay } from "signal-timers";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { IN_VITEST } from "../../env.ts";
import {
  onRef,
  onRejection,
  resetSignalScope,
  resetSignal,
  setLoop,
  withCleanup,
} from "../utils.ts";
import { createHeaderAutomationSignals } from "./header-automation-menu.ts";
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
import type { ChatThread } from "../agent-chat.ts";
import {
  chatMessagesContract,
  chatThreadArtifactsContract,
  type AttachFile,
  type ChatMessageUsagePayload,
  type GenerationTemplateRequest,
  type ChatThreadArtifactRun,
  type PagedChatMessage,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";

import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { runOptionsFromModelProviderSelection } from "./model-selection-request.ts";
import { accept } from "../../lib/accept.ts";
import { nowDate } from "../../lib/time.ts";
import { captureTaskCompletedSuccessfully } from "../../lib/posthog.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import { chatMessageOrderSequence } from "../chat-message-order.ts";
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
import { logger } from "../log.ts";
import { createRemoteChatThreadDataSource } from "./remote-chat-thread-data-source.ts";
import {
  loadIndexedDbChatMessages$,
  writeIndexedDbChatMessages$,
} from "./chat-message-indexed-db.ts";
import type { BodyRenderBlock, ParsedBodyBlock } from "./parse-body-blocks.ts";
import { parseMessageBodyBlocks } from "./chat-message-body-blocks.ts";
import {
  createArtifactCardSignalsRegistry,
  type ArtifactCardSignalsRegistry,
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
import { reloadWorkflowData$ } from "../workflows-page/workflow-reload.ts";
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
import { createMailDraftCardSignalsRegistry } from "./mail-draft.ts";
import { createComposerConnectorSignals } from "../zero-page/zero-connectors.ts";

type ChatThreadRemote = ReturnType<typeof createRemoteChatThreadDataSource>;

export type {
  DraftInputSyncTarget,
  DraftSignals,
} from "../zero-page/chat-draft.ts";
export type {
  ChatThreadSignals,
  SendMessageOptions,
} from "./chat-thread-signals.ts";

const L = logger("ChatThread");
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const QUEUED_RUN_MARKER_EVENT_ID = "queue:queued";

function createChatThreadScrollSignals(threadId: string) {
  return createScrollSignals(threadId, {
    observeViewportResizeOnMobile: true,
  });
}

function isRecallControlMessage(msg: PagedChatMessage): boolean {
  return (
    ((msg.role === "user" && msg.runId === undefined && msg.content === null) ||
      (msg.role === "assistant" && msg.content === null)) &&
    msg.revokesMessageId !== undefined
  );
}

function isQueueMarkerMessage(msg: PagedChatMessage): boolean {
  return (
    msg.role === "assistant" &&
    msg.runEventId === QUEUED_RUN_MARKER_EVENT_ID &&
    msg.runId !== undefined
  );
}

function isGoalMarkerMessage(msg: PagedChatMessage): boolean {
  return msg.role === "assistant" && msg.goalEvent !== undefined;
}

/**
 * Fold the thread's message stream into its current goal, surfaced above the
 * composer. Goal markers are chronological and last-write-wins: active shows
 * the cached objective brief; paused, blocked, complete, and cleared hide it.
 */
function foldActiveGoal(messages: readonly PagedChatMessage[]): string | null {
  let objective: string | null = null;
  for (const message of messages) {
    const goalEvent =
      message.role === "assistant" ? message.goalEvent : undefined;
    if (!goalEvent) {
      continue;
    }
    if (goalEvent.type === "cleared") {
      objective = null;
      continue;
    }
    if (goalEvent.status === "active") {
      objective = goalEvent.objectiveBrief;
      continue;
    }
    objective = null;
  }
  const trimmed = objective?.trim();
  return trimmed || null;
}

function isUsageMessage(msg: PagedChatMessage): msg is Extract<
  PagedChatMessage,
  { role: "assistant" }
> & {
  usage: NonNullable<PagedChatMessage["usage"]>;
} {
  return msg.role === "assistant" && msg.usage !== undefined;
}

function isInterruptControlMessage(msg: PagedChatMessage): boolean {
  return (
    msg.role === "user" &&
    msg.runId === undefined &&
    msg.interruptsRunId !== undefined
  );
}

function isCancelledAssistantMessage(msg: PagedChatMessage): boolean {
  return (
    msg.role === "assistant" &&
    msg.runId !== undefined &&
    (msg.runLifecycleEvent === "cancelled" ||
      msg.error?.trim().toLowerCase() === "run cancelled")
  );
}

function createInterruptedAssistantProjection(
  message: PagedChatMessage,
  runId: string,
): PagedChatMessage {
  return {
    ...message,
    role: "assistant" as const,
    content: "Run cancelled",
    runId,
    interruptsRunId: runId,
    error: "Run cancelled",
    runLifecycleEvent: "cancelled",
  };
}

function completedRunIdsFromMessages(
  messages: readonly PagedChatMessage[],
): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if (
      message.role === "assistant" &&
      message.runId !== undefined &&
      message.runLifecycleEvent === "completed"
    ) {
      ids.add(message.runId);
    }
  }
  return Array.from(ids);
}

function isInterruptedAssistantCancellation(
  message: PagedChatMessage,
  interruptedRunIds: Set<string>,
): boolean {
  const runId = message.runId;
  return (
    runId !== undefined &&
    isCancelledAssistantMessage(message) &&
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

function formatDonePhrase(lastMsg: PagedChatMessage | undefined): string {
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
  return new Set(
    raw.flatMap((entry) => {
      return entry.message.revokesMessageId
        ? [entry.message.revokesMessageId]
        : [];
    }),
  );
}

function isRawOptimisticRunMessage(entry: ChatMessageProjectionEntry): boolean {
  const { message } = entry;
  return (
    message.role === "user" &&
    message.runId === undefined &&
    entry.optimisticUserMessageAssociation === "run"
  );
}

function terminatedRunIdsFromRawMessages(
  raw: readonly ChatMessageProjectionEntry[],
): Set<string> {
  const terminatedRunIds = new Set<string>();
  for (const { message } of raw) {
    if (message.interruptsRunId !== undefined) {
      terminatedRunIds.add(message.interruptsRunId);
    }
    if (
      message.role === "assistant" &&
      message.runId !== undefined &&
      message.runLifecycleEvent !== undefined
    ) {
      terminatedRunIds.add(message.runId);
    }
  }
  return terminatedRunIds;
}

type RunIndicatorState = "running" | "queued" | null;

type AssistantPagedChatMessage = Extract<
  PagedChatMessage,
  { role: "assistant" }
>;

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
  message: AssistantPagedChatMessage,
): RunIndicatorState | undefined {
  const runId = message.runId;
  if (isQueueMarkerMessage(message)) {
    if (runId !== undefined && terminatedRunIds.has(runId)) {
      return undefined;
    }
    return "queued";
  }
  if (runId !== undefined && message.runLifecycleEvent !== undefined) {
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
      message.role !== "user" ||
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
      message.role === "assistant"
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
    if (message.role === "assistant") {
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
// Sub-factory: remote thread detail fetching
// ---------------------------------------------------------------------------

// The data source owns remote thread detail/draft reads plus `reloadThread$`
// as the detail invalidation lever. Local mode never reloads; remote mode bumps
// an internal counter on its `remoteThreadDetail$` computed.
function createRemoteThreadDetail(dataSource: ChatThreadRemote) {
  return {
    remoteThreadDetail$: dataSource.remoteThreadDetail$,
    threadDraft$: dataSource.threadDraft$,
    reloadThread$: dataSource.reloadThread$,
  };
}

function createThreadMeta(threadId: string) {
  return threadMeta(threadId);
}

function createThreadTitleParts(
  threadMeta$: Computed<Promise<ThreadMeta | null>>,
) {
  const threadTitle$ = computed(async (get): Promise<string | null> => {
    return (await get(threadMeta$))?.title ?? null;
  });
  const threadTitleParts$ = computed(async (get) => {
    return getChatThreadTitleParts(await get(threadTitle$));
  });
  const threadTitleEmoji$ = computed(async (get) => {
    return (await get(threadTitleParts$)).emoji;
  });
  const threadTitleText$ = computed(async (get) => {
    return (await get(threadTitleParts$)).text;
  });
  return { threadTitle$, threadTitleEmoji$, threadTitleText$ };
}

function createThreadSettledInServer(
  threadId: string,
  threadMeta$: Computed<Promise<ThreadMeta | null>>,
) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return computed(async (get): Promise<boolean> => {
    const threadMeta = await get(threadMeta$);
    const optimisticCreateUnsettled = get(optimisticCreateUnsettled$);
    if (threadMeta === null) {
      if (optimisticCreateUnsettled) {
        return false;
      }
      throw new Error("Chat not found");
    }
    return !optimisticCreateUnsettled;
  });
}

// ---------------------------------------------------------------------------
// Sub-factory: composer model override
// ---------------------------------------------------------------------------

function createModelSelection(
  threadId: string,
  threadMeta$: Computed<Promise<ThreadMeta | null>>,
  remoteThreadDetail$: Computed<Promise<ChatThread | null>>,
  dataSource: ChatThreadRemote,
) {
  const selectedModel$ = computed(async (get): Promise<string | null> => {
    const threadMeta = await get(threadMeta$);
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
      set(dataSource.reloadThread$);
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
    return (await get(remoteThreadDetail$))?.codexServiceTier === "fast";
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
  selectedModel$: Computed<Promise<string | null>>;
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
  remoteThreadDetail$: Computed<Promise<ChatThread | null>>,
  dataSource: ChatThreadRemote,
) {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  const internalUserOverride$ = state<
    { kind: "unset" } | { kind: "set"; value: string | null; dirty: boolean }
  >({ kind: "unset" });

  const computerUseHostId$ = computed(async (get): Promise<string | null> => {
    const user = get(internalUserOverride$);
    if (user.kind === "set") {
      return user.value;
    }
    const thread = await get(remoteThreadDetail$);
    return thread?.computerUseHostId ?? null;
  });

  const computerUseHostIdExplicit$ = computed((get): boolean => {
    const user = get(internalUserOverride$);
    return user.kind === "set" && user.dirty;
  });

  const setComputerUseHostId$ = command(
    async (
      { get, set },
      computerUseHostId: string | null,
      signal: AbortSignal,
    ) => {
      set(internalUserOverride$, {
        kind: "set",
        value: computerUseHostId,
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
          { threadId, computerUseHostId },
          signal,
        ),
        () => {
          if (!signal.aborted) {
            set(internalUserOverride$, {
              kind: "set",
              value: computerUseHostId,
              dirty: false,
            });
          }
        },
      );
      signal.throwIfAborted();
      set(internalUserOverride$, {
        kind: "set",
        value: computerUseHostId,
        dirty: false,
      });
      set(dataSource.reloadThread$);
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
    computerUseHostIdExplicit$,
    setComputerUseHostId$,
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

function createAgentInfoSignals(
  threadMeta$: Computed<Promise<ThreadMeta | null>>,
) {
  // agentId$ is read by avatar and pinned UI on first paint.
  // Resolving it via threadMeta$ avoids blocking the avatar render on the
  // chat-threads/:id round-trip, even though the agentId rarely changes
  // for a given thread.
  const agentId$ = computed(async (get): Promise<string | null> => {
    const meta = await get(threadMeta$);
    return meta?.agentId ?? null;
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
  threadMeta$: Computed<Promise<ThreadMeta | null>>,
) {
  return {
    ...createAgentInfoSignals(threadMeta$),
    headerAutomations: createHeaderAutomationSignals(threadId),
    workflowQueue: createWorkflowQueueSignals(threadId),
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

      const input = get(draft.input$);
      const content = input.trim() || null;
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

      await set(
        dataSource.patchDraft$,
        {
          threadId,
          content,
          attachments: persisted.length > 0 ? persisted : null,
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
        { threadId, content: null, attachments: null },
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
      result.push({
        beginMessageId: msg.id,
        role: msg.role,
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
  if (group.role !== msg.role) {
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
  const usageByRunId = new Map<
    string,
    NonNullable<EnrichedChatMessage["usage"]>
  >();
  for (const msg of messages) {
    if (isUsageMessage(msg)) {
      if (msg.runId !== undefined) {
        setLatestUsageForRun(usageByRunId, msg.runId, msg.usage);
      }
      continue;
    }
    if (msg.role === "user" && msg.isQueued) {
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

function usageSettledAtMs(usage: ChatMessageUsagePayload): number {
  const timestamp = Date.parse(usage.settledAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function setLatestUsageForRun(
  usageByRunId: Map<string, ChatMessageUsagePayload>,
  runId: string,
  usage: ChatMessageUsagePayload,
): void {
  const existing = usageByRunId.get(runId);
  if (
    existing === undefined ||
    usageSettledAtMs(usage) >= usageSettledAtMs(existing)
  ) {
    usageByRunId.set(runId, usage);
  }
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

  const messageImageGroups$ = computed(
    async (get): Promise<MessageImageGroupProjection[]> => {
      return (await get(allRenderedChatGroups$)).map((group) => {
        return {
          messages: group.messages.map((message) => {
            return {
              attachFiles: message.attachFiles,
              blocks: message.blocks,
            };
          }),
        };
      });
    },
  );

  return {
    allRenderedChatGroups$,
    messageImageGroups$,
  };
}

interface RegisteredChatMessage {
  readonly message: PagedChatMessage;
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

function compareServerMessageOrder(
  left: PagedChatMessage,
  right: PagedChatMessage,
): number {
  const createdAtOrder = compareCreatedAt(left.createdAt, right.createdAt);
  if (createdAtOrder !== 0) {
    return createdAtOrder;
  }

  const leftSequence = chatMessageOrderSequence(left);
  const rightSequence = chatMessageOrderSequence(right);
  if (leftSequence !== rightSequence) {
    return leftSequence - rightSequence;
  }

  return 0;
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
    return compareServerMessageOrder(left.message, right.message);
  });
}

function skipsMessageBodyRendering(message: PagedChatMessage): boolean {
  return (
    isInterruptControlMessage(message) ||
    isRecallControlMessage(message) ||
    isQueueMarkerMessage(message) ||
    isGoalMarkerMessage(message)
  );
}

function registerChatMessage(
  message: PagedChatMessage,
  registerBodyBlocks: BodyBlocksRenderer,
): RegisteredChatMessage {
  const blocks = skipsMessageBodyRendering(message)
    ? []
    : registerBodyBlocks(parseMessageBodyBlocks(message));
  return { message, blocks };
}

function createMergePersistentMessages(
  threadId: string,
  persistentMessages$: PersistentChatMessages$,
  registerBodyBlocks: BodyBlocksRenderer,
) {
  return command(({ get, set }, msgs: PagedChatMessage[]): void => {
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
      return registerChatMessage(message, registerBodyBlocks);
    });
    set(persistentMessages$, (prev) => {
      return mergeRegisteredMessages([prev, registeredMessages]);
    });
    set(reconcileOptimisticChatMessages$, { threadId, messages: msgs });
  });
}

function createWritePersistentMessages(
  threadId: string,
  mergePersistentMessages$: Command<void, [PagedChatMessage[]]>,
) {
  return command(
    async (
      { set },
      msgs: PagedChatMessage[],
      signal: AbortSignal,
    ): Promise<void> => {
      if (msgs.length === 0) {
        return;
      }
      set(mergePersistentMessages$, msgs);
      await set(writeIndexedDbChatMessages$, threadId, msgs, signal);
      signal.throwIfAborted();
    },
  );
}

interface ChatMessageProjectionEntry {
  message: PagedChatMessage;
  source: "server" | "optimistic";
  blocks: BodyRenderBlock[];
  optimisticUserMessageAssociation?: OptimisticChatMessageEntry["optimisticUserMessageAssociation"];
}

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
        if (message.role !== "assistant") {
          return {
            ...message,
            role: "user" as const,
            blocks: entry.blocks,
            isQueued,
            isOptimisticRun,
          };
        }
        return {
          ...message,
          role: "assistant" as const,
          blocks: entry.blocks,
          isQueued,
          isOptimisticRun: false,
        };
      }),
    );
  });
}

interface SemanticChatMessage {
  readonly message: PagedChatMessage;
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
      return isRecallControlMessage(message) && message.revokesMessageId
        ? [message.revokesMessageId]
        : [];
    }),
  );
  const replacedIds = new Set(
    raw.flatMap((entry) => {
      const { message } = entry;
      return !isRecallControlMessage(message) && message.revokesMessageId
        ? [message.revokesMessageId]
        : [];
    }),
  );

  return raw.flatMap((entry): SemanticChatMessage[] => {
    const { message } = entry;
    if (
      isRecallControlMessage(message) ||
      isQueueMarkerMessage(message) ||
      isGoalMarkerMessage(message) ||
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
      message.role === "user" && message.runId === undefined;
    const optimisticAssociation = entry.optimisticUserMessageAssociation;
    const isOptimisticRun =
      isUnassociatedUser && optimisticAssociation === "run";
    const isQueued =
      isUnassociatedUser &&
      optimisticAssociation !== "run" &&
      message.error === undefined;
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
  if (group.role !== semanticMessage.message.role) {
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
      role: semanticMessage.message.role,
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
    if (semanticMessage.message.role === "user" && semanticMessage.isQueued) {
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
): PagedChatMessage[] {
  return semanticMessages.flatMap((entry) => {
    const { message } = entry;
    return message.role === "user" && entry.isQueued ? [message] : [];
  });
}

function queuedMessagesFromRaw(
  raw: readonly ChatMessageProjectionEntry[],
): PagedChatMessage[] {
  return queuedMessagesFromSemanticMessages(
    semanticTranscriptMessagesFromRaw(raw),
  );
}

function lastAssistantCancelledFromGroups(groups: SemanticChatGroups): boolean {
  const lastGroup = groups.allGroups.at(-1);
  const lastMessage = lastGroup?.messages.at(-1)?.message;
  return lastMessage ? isCancelledAssistantMessage(lastMessage) : false;
}

function isRenderableAssistantSemanticMessage(
  entry: SemanticChatMessage,
): boolean {
  const { message } = entry;
  return (
    message.role === "assistant" &&
    (Boolean(message.content) || Boolean(message.error))
  );
}

function isThinkingMarkerSemanticMessage(entry: SemanticChatMessage): boolean {
  const { message } = entry;
  return (
    message.role === "assistant" &&
    message.content === null &&
    message.error === undefined &&
    typeof message.thinking === "string" &&
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
    ? isCancelledAssistantMessage(lastAssistantMessage)
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
    !queued && running && rawThinkingMessage?.message.role === "assistant"
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
      if (!message || message.role !== "assistant") {
        continue;
      }
      if (message.content?.trim()) {
        return null;
      }
      const followups = message.recommendedFollowups ?? [];
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
  const queuedMessages$ = computed((get): PagedChatMessage[] => {
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
          return { id: message.id, text: (message.content ?? "").trim() };
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
  const initialSync = Promise.withResolvers<void>();
  const internalMessageSyncPromise$ = state(initialSync.promise);
  const hasNewMessages$ = computed(async (get): Promise<boolean> => {
    await get(internalMessageSyncPromise$);
    return await get(hasMessages$);
  });
  const trackMessageSync$ = command(({ set }, promise: Promise<void>): void => {
    set(internalMessageSyncPromise$, promise);
    initialSync.resolve(undefined);
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

function latestServerMessageId(
  raw: readonly ChatMessageProjectionEntry[],
): string | undefined {
  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    if (isServerProjectionEntry(entry)) {
      return entry.message.id;
    }
  }
  return undefined;
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
    if (
      message.role === "assistant" &&
      message.runLifecycleEvent !== undefined
    ) {
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
      message.role === "assistant" &&
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
  const latestChatMessageId$ = computed((get): Promise<string | undefined> => {
    return Promise.resolve(latestServerMessageId(get(rawMessages$)));
  });
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
    latestChatMessageId$,
    latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$,
  };
}

function createSyncRemoteMessagesCommand({
  threadId,
  persistentMessages$,
  hasReachedOldestMessage$,
  mergePersistentMessages$,
  dataSource,
}: {
  threadId: string;
  persistentMessages$: PersistentChatMessages$;
  hasReachedOldestMessage$: State<boolean>;
  mergePersistentMessages$: Command<void, [PagedChatMessage[]]>;
  dataSource: ChatThreadRemote;
}): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const persistentMessages = get(persistentMessages$);
    const accumulatedMessages: PagedChatMessage[] = [];
    let sinceId = persistentMessages.at(-1)?.message.id;
    const startedWithoutCursor = sinceId === undefined;
    let initialHasHistoryBefore: boolean | undefined;

    async function syncMessagesAfter(): Promise<void> {
      const requestedSinceId = sinceId;
      const result = await set(
        dataSource.listMessagesAfter$,
        { threadId, sinceId: requestedSinceId },
        signal,
      );
      signal.throwIfAborted();
      L.debug("syncRemoteMessages$ listMessagesAfter result", {
        threadId,
        sinceId: requestedSinceId ?? null,
        gotCount: result.messages.length,
      });

      if (requestedSinceId === undefined) {
        initialHasHistoryBefore = result.hasHistoryBefore;
      }

      if (result.messages.length === 0) {
        return;
      }

      accumulatedMessages.push(...result.messages);
      await set(writeIndexedDbChatMessages$, threadId, result.messages, signal);
      signal.throwIfAborted();
      sinceId = result.messages.at(-1)!.id;

      return syncMessagesAfter();
    }
    await syncMessagesAfter();
    signal.throwIfAborted();

    if (!get(hasReachedOldestMessage$)) {
      const oldestMessageId =
        persistentMessages[0]?.message.id ?? accumulatedMessages[0]?.id;
      if (
        (startedWithoutCursor && initialHasHistoryBefore === false) ||
        oldestMessageId === undefined
      ) {
        set(hasReachedOldestMessage$, true);
      } else {
        let beforeId = oldestMessageId;
        async function syncMessagesBefore(): Promise<void> {
          const result = await set(
            dataSource.listMessagesBefore$,
            { threadId, beforeId },
            signal,
          );
          signal.throwIfAborted();
          L.debug("syncRemoteMessages$ listMessagesBefore result", {
            threadId,
            beforeId,
            gotCount: result.messages.length,
            hasHistoryBefore: result.hasHistoryBefore,
          });

          if (result.messages.length > 0) {
            accumulatedMessages.push(...result.messages);
            await set(
              writeIndexedDbChatMessages$,
              threadId,
              result.messages,
              signal,
            );
            signal.throwIfAborted();
          }

          if (!result.hasHistoryBefore) {
            set(hasReachedOldestMessage$, true);
            return;
          }

          beforeId = result.messages[0]!.id;

          return syncMessagesBefore();
        }
        await syncMessagesBefore();
      }
    }
    signal.throwIfAborted();
    set(mergePersistentMessages$, accumulatedMessages);
  });
}

function messageUpdatedPayloadMessageId(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("messageId" in payload) ||
    typeof payload.messageId !== "string" ||
    !uuidPattern.test(payload.messageId)
  ) {
    return null;
  }
  return payload.messageId;
}

function createFetchUpdatedMessageCommand({
  threadId,
  dataSource,
  writePersistentMessages$,
}: {
  threadId: string;
  dataSource: ChatThreadRemote;
  writePersistentMessages$: Command<
    Promise<void>,
    [PagedChatMessage[], AbortSignal]
  >;
}): Command<Promise<boolean>, [unknown, AbortSignal]> {
  return command(
    async (
      { set },
      payload: unknown,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const messageId = messageUpdatedPayloadMessageId(payload);
      if (messageId === null) {
        L.warn("Ignoring chat message update with invalid payload", {
          threadId,
        });
        return false;
      }

      const message = await set(
        dataSource.getMessage$,
        { threadId, messageId },
        signal,
      );
      signal.throwIfAborted();
      if (message === null) {
        return false;
      }

      await set(writePersistentMessages$, [message], signal);
      signal.throwIfAborted();
      return false;
    },
  );
}

function createActiveGoalObjectiveComputed(
  rawMessages$: Computed<ChatMessageProjectionEntry[]>,
): Computed<Promise<string | null>> {
  return computed((get): Promise<string | null> => {
    const raw = get(rawMessages$);
    return Promise.resolve(
      foldActiveGoal(
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
  readonly mailDraftCardSignals: ReturnType<
    typeof createMailDraftCardSignalsRegistry
  >;
}

function createBodyBlocksRenderer({
  artifactCardSignals,
  connectorCardSignals,
  customConnectorCardSignals,
  permissionCardSignals,
  computerUseAuthorizationCardSignals,
  mailDraftCardSignals,
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
        }
        const exhaustive: never = block;
        return exhaustive;
      });
    };
  };
}

function createPagedMessages(
  threadId: string,
  dataSource: ChatThreadRemote,
  initialOptimisticEntries: readonly OptimisticChatMessageEntry[],
) {
  const mailDraftCardSignals = createMailDraftCardSignalsRegistry();
  const artifactCardSignals = createArtifactCardSignalsRegistry();
  const connectorCardSignals = createConnectorCardSignalsRegistry();
  const customConnectorCardSignals = createCustomConnectorCardSignalsRegistry();
  const permissionCardSignals = createPermissionCardSignalsRegistry();
  const computerUseAuthorizationCardSignals =
    createComputerUseAuthorizationCardSignalsRegistry();
  const bodyBlocksRenderer = createBodyBlocksRenderer({
    artifactCardSignals,
    connectorCardSignals,
    customConnectorCardSignals,
    permissionCardSignals,
    computerUseAuthorizationCardSignals,
    mailDraftCardSignals,
  });
  const registerBodyBlocks = bodyBlocksRenderer("register");
  const resolveBodyBlocks = bodyBlocksRenderer("resolve");

  for (const entry of initialOptimisticEntries) {
    registerBodyBlocks(entry.parsedBodyBlocks);
  }
  const persistentChatMessages$ = state<RegisteredChatMessage[]>([]);
  const hasReachedOldestMessage$ = state(false);
  const optimisticMessages$ = createOptimisticChatMessagesForThread(threadId);
  const appendOptimisticMessage$ = command(
    ({ set }, input: OptimisticChatMessageInput): void => {
      const entry = createOptimisticChatMessageEntry(input);
      registerBodyBlocks(entry.parsedBodyBlocks);
      set(appendOptimisticChatMessage$, entry);
    },
  );

  const rawMessages$ = createRawMessagesComputed({
    persistentMessages$: persistentChatMessages$,
    optimisticMessages$,
    resolveBodyBlocks,
  });
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

  const mailDraftCardSignalsById$ = computed((get) => {
    get(rawMessages$);
    return mailDraftCardSignals.entries();
  });

  const mergePersistentMessages$ = createMergePersistentMessages(
    threadId,
    persistentChatMessages$,
    registerBodyBlocks,
  );
  const writePersistentMessages$ = createWritePersistentMessages(
    threadId,
    mergePersistentMessages$,
  );

  const mergeIndexedDbMessages$ = command(
    ({ set }, messages: PagedChatMessage[]): void => {
      const registeredMessages = messages.map((message) => {
        return registerChatMessage(message, registerBodyBlocks);
      });
      set(persistentChatMessages$, (previous) => {
        return mergeRegisteredMessages([registeredMessages, previous]);
      });
    },
  );

  const initializeIndexedDbMessages$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const indexedDbMessages = await set(
        loadIndexedDbChatMessages$,
        threadId,
        signal,
      );
      signal.throwIfAborted();
      set(mergeIndexedDbMessages$, indexedDbMessages);
    },
  );

  const latestMessageSignals = createLatestMessageSignals(rawMessages$);

  const runSyncRemoteMessages$ = createSyncRemoteMessagesCommand({
    threadId,
    persistentMessages$: persistentChatMessages$,
    hasReachedOldestMessage$,
    mergePersistentMessages$,
    dataSource,
  });
  const syncRemoteMessages$ = createTrackedMessageSyncCommand(
    runSyncRemoteMessages$,
    messageSync.trackMessageSync$,
  );
  const fetchUpdatedMessage$ = createFetchUpdatedMessageCommand({
    threadId,
    dataSource,
    writePersistentMessages$,
  });

  return {
    initializeIndexedDbMessages$,
    writePersistentMessages$,
    ...latestMessageSignals,
    appendOptimisticMessage$,
    ...semanticSignals,
    ...messageSync,
    ...renderedMessages,
    rawMessages$,
    messageRunIndicatorState$,
    activeGoalObjective$,
    mailDraftCardSignalsById$,
    syncRemoteMessages$,
    fetchUpdatedMessage$,
  };
}

function createChatThreadMessagePipeline({
  threadId,
  dataSource,
  initialOptimisticEntries,
  recordScrollHeightForPrepend$,
  clearScrollHeightForPrepend$,
  awayFromBottom$,
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
}) {
  const pagedMessages = createPagedMessages(
    threadId,
    dataSource,
    initialOptimisticEntries,
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

function createContainerRef() {
  const internalContainerEl$ = state<HTMLElement | null>(null);
  const containerEl$ = computed((get) => {
    return get(internalContainerEl$);
  });
  const setContainerRef$ = onRef(
    command(({ set }, el: HTMLElement, signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        set(internalContainerEl$, null);
      });
      set(internalContainerEl$, el);
    }),
  );
  return { containerEl$, setContainerRef$ };
}

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
  reloadThread$: Command<void, []>;
  remoteThreadDetail$: Computed<Promise<ChatThread | null>>;
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  initializeIndexedDbMessages$: Command<Promise<void>, [AbortSignal]>;
  syncRemoteMessages$: Command<Promise<void>, [AbortSignal]>;
  settleMessageSync$: Command<Promise<void>, []>;
  fetchUpdatedMessage$: Command<Promise<boolean>, [unknown, AbortSignal]>;
  reloadArtifacts$: Command<void, []>;
  autoScroll$: Command<void, []>;
  automationSignals: Pick<
    ChatThreadSignals,
    "headerAutomations" | "workflowQueue"
  >;
  dataSource: ChatThreadRemote;
}

interface MarkThreadReadDeps {
  threadId: string;
  remoteThreadDetail$: Computed<Promise<ChatThread | null>>;
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
  remoteThreadDetail$,
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

    const thread = await get(remoteThreadDetail$);
    sig.throwIfAborted();
    if (thread === null) {
      return;
    }
    const lastReadAt = get(locallyMarkedReadAt$) ?? thread.lastReadAt;
    if (
      lastReadAt !== null &&
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
  reloadThread$,
  remoteThreadDetail$,
  latestChatMessageId$,
  syncRemoteMessages$,
  settleMessageSync$,
  fetchUpdatedMessage$,
  reloadArtifacts$,
  markThreadReadIfNeeded$,
}: Pick<
  RunTrackingDeps,
  | "threadId"
  | "reloadThread$"
  | "remoteThreadDetail$"
  | "latestChatMessageId$"
  | "syncRemoteMessages$"
  | "settleMessageSync$"
  | "fetchUpdatedMessage$"
  | "reloadArtifacts$"
> & {
  markThreadReadIfNeeded$: Command<Promise<void>, [AbortSignal]>;
}): Command<Promise<void>, [AbortSignal]> {
  const optimisticCreateUnsettled$ =
    optimisticChatThreadCreateUnsettled(threadId);
  return command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ catchup start", { threadId });
    set(reloadThread$);
    set(reloadArtifacts$);
    set(reloadWorkflowData$);
    await Promise.all([
      get(remoteThreadDetail$),
      get(optimisticCreateUnsettled$)
        ? set(settleMessageSync$)
        : set(syncRemoteMessages$, signal),
    ]);
    signal.throwIfAborted();
    const latestMessageId = await get(latestChatMessageId$);
    signal.throwIfAborted();
    if (latestMessageId) {
      // In-place message updates, such as completed marker followups, are not
      // returned by a sinceId fetch. Refresh the latest loaded row after the
      // realtime callbacks are registered so update events racing with this
      // fetch are queued instead of missed.
      await set(fetchUpdatedMessage$, { messageId: latestMessageId }, signal);
    }
    await set(markThreadReadIfNeeded$, signal);
    signal.throwIfAborted();
    L.debug("subscribeChatThread$ catchup done", { threadId });
  });
}

function createRunTracking({
  threadId,
  reloadThread$,
  remoteThreadDetail$,
  latestChatMessageId$,
  latestRunFinishCreatedAt$,
  initializeIndexedDbMessages$,
  syncRemoteMessages$,
  settleMessageSync$,
  fetchUpdatedMessage$,
  reloadArtifacts$,
  autoScroll$,
  automationSignals,
  dataSource,
}: RunTrackingDeps) {
  const locallyMarkedReadAt$ = state<string | undefined>(undefined);
  const resetChatSubscriptionSignal$ = resetSignalScope();

  const markThreadReadIfNeeded$ = createMarkThreadReadIfNeeded({
    threadId,
    remoteThreadDetail$,
    latestRunFinishCreatedAt$,
    locallyMarkedReadAt$,
    dataSource,
  });

  const onSubscribed$ = createOnSubscribedCommand({
    threadId,
    reloadThread$,
    remoteThreadDetail$,
    latestChatMessageId$,
    syncRemoteMessages$,
    settleMessageSync$,
    fetchUpdatedMessage$,
    reloadArtifacts$,
    markThreadReadIfNeeded$,
  });

  const subscribeChatThread$ = command(async ({ set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ start", { threadId });
    await set(initializeIndexedDbMessages$, signal);
    signal.throwIfAborted();

    const onThreadDetailChanged$ = command(({ set }) => {
      L.debug("onThreadDetailChanged$ fired", { threadId });
      set(reloadThread$);
      return false;
    });

    const onMessageCreated$ = command(async ({ set }, sig: AbortSignal) => {
      L.debug("onMessageCreated$ fired", { threadId });
      await set(syncRemoteMessages$, sig);
      L.debug("onMessageCreated$ syncRemoteMessages$ done", { threadId });
      await set(markThreadReadIfNeeded$, sig);
      animationFrame(
        () => {
          set(autoScroll$);
        },
        { signal: sig },
      );
      return false;
    });

    const onMessageUpdated$ = command(
      async ({ set }, payload: unknown, sig: AbortSignal) => {
        L.debug("onMessageUpdated$ fired", { threadId });
        return await set(fetchUpdatedMessage$, payload, sig);
      },
    );

    const onRunChanged$ = command(async ({ set }, sig: AbortSignal) => {
      L.debug("onRunChanged$ fired", { threadId });
      await set(syncRemoteMessages$, sig);
      sig.throwIfAborted();
      animationFrame(
        () => {
          set(autoScroll$);
        },
        { signal: sig },
      );
      return false;
    });

    const onAutomationsChanged$ = command(({ set }) => {
      set(automationSignals.headerAutomations.reload$);
      return false;
    });

    const onArtifactsChanged$ = command(({ set }) => {
      L.debug("onArtifactsChanged$ fired", { threadId });
      set(reloadArtifacts$);
      return false;
    });

    const onWorkflowsChanged$ = command(({ set }) => {
      L.debug("onWorkflowsChanged$ fired", { threadId });
      set(reloadWorkflowData$);
      return false;
    });

    const subscriptionScope = set(resetChatSubscriptionSignal$, signal);
    const subscriptionSignal = subscriptionScope.signal;

    await withCleanup(
      Promise.all([
        set(markThreadReadIfNeeded$, subscriptionSignal),
        set(subscribeComputerUseHostsChanged$, subscriptionSignal),
        set(
          dataSource.subscribeRealtime$,
          {
            threadId,
            handlers: {
              onThreadDetailChanged$,
              onMessageCreated$,
              onMessageUpdated$,
              onRunChanged$,
              onAutomationsChanged$,
              onArtifactsChanged$,
              onWorkflowsChanged$,
              onWorkflowQueueChanged$:
                automationSignals.workflowQueue.handleChanged$,
              onSubscribed$,
            },
          },
          subscriptionSignal,
        ),
      ]),
      () => {
        subscriptionScope.abort(signal.reason);
      },
    );
    signal.throwIfAborted();
  });

  return { subscribeChatThread$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: sendMessage command
// ---------------------------------------------------------------------------

interface PreparedSendMessageResult {
  prompt: string;
  attachFiles: AttachFile[] | undefined;
  attachments: PagedChatMessage["attachFiles"];
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

function structuredPromptForSend({
  enabled,
  editorDocument,
  generationTemplate,
  attachments,
}: {
  readonly enabled: boolean;
  readonly editorDocument: SendMessageOptions["editorDocument"];
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly attachments: PagedChatMessage["attachFiles"];
}): UserMessageDocument | undefined {
  if (!enabled || !editorDocument) {
    return undefined;
  }
  const structuredPrompt = editorDocument.toMessageDocument({
    generationTemplate,
    attachments,
  });
  if (!structuredPrompt) {
    throw new Error("Failed to serialize structured prompt");
  }
  return structuredPrompt;
}

function queueStructured(
  features: Partial<Record<FeatureSwitchKey, boolean>>,
  options: QueueMessageOptions,
  result: PreparedSendMessageResult,
): UserMessageDocument | undefined {
  return structuredPromptForSend({
    enabled: features[FeatureSwitchKey.StructuredPrompt] ?? false,
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
  clientMessageId,
  createdAt,
  result,
  generationTemplate,
  structuredPrompt,
  options,
}: {
  threadId: string;
  clientMessageId: string;
  createdAt: string;
  result: PreparedSendMessageResult;
  generationTemplate: GenerationTemplateRequest | undefined;
  structuredPrompt: UserMessageDocument | undefined;
  options: SendMessageOptions | undefined;
}): OptimisticChatMessageInput {
  return {
    threadId,
    optimisticUserMessageAssociation: "run",
    message: {
      id: clientMessageId,
      role: "user",
      content: result.prompt,
      attachFiles: result.attachments,
      generationTemplate,
      ...(structuredPrompt ? { structuredPrompt } : {}),
      ...sendMessageRevocationPatch(options),
      createdAt,
    },
  };
}

function sendMessageRevocationPatch(options: SendMessageOptions | undefined): {
  readonly revokesMessageId?: string;
} {
  return options?.revokesMessageId
    ? { revokesMessageId: options.revokesMessageId }
    : {};
}

function sendMessageRequestBody(params: {
  readonly agentId: string;
  readonly threadId: string;
  readonly clientMessageId: string;
  readonly chatThreadSortEventId: string;
  readonly result: PreparedSendMessageResult;
  readonly modelSelection: ModelProviderSelection | null;
  readonly codexFastModeEnabled: boolean;
  readonly realAgentInPreviewEnabled: boolean;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly structuredPrompt: UserMessageDocument | undefined;
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
    clientMessageId: params.clientMessageId,
    chatThreadSortEventId: params.chatThreadSortEventId,
    ...(runOptions ? { runOptions } : {}),
    ...(params.realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
    generationTemplate: params.generationTemplate,
    ...(params.structuredPrompt
      ? { structuredPrompt: params.structuredPrompt }
      : {}),
    ...(params.options && "computerUseHostId" in params.options
      ? { computerUseHostId: params.options.computerUseHostId ?? null }
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
        readonly clientMessageId: string;
        readonly chatThreadSortEventId: string;
        readonly createdAt: string;
        readonly result: PreparedSendMessageResult;
        readonly generationTemplate: GenerationTemplateRequest | undefined;
        readonly structuredPrompt: UserMessageDocument | undefined;
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
          clientMessageId: args.clientMessageId,
          createdAt: args.createdAt,
          result: args.result,
          generationTemplate: args.generationTemplate,
          structuredPrompt: args.structuredPrompt,
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
  threadMeta$: Computed<Promise<ThreadMeta | null>>;
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
      readonly clientMessageId: string;
      readonly chatThreadSortEventId: string;
      readonly result: PreparedSendMessageResult;
      readonly modelSelection: ModelProviderSelection | null;
      readonly generationTemplate: GenerationTemplateRequest | undefined;
      readonly structuredPrompt: UserMessageDocument | undefined;
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
    const client = get(zeroClient$)(chatMessagesContract);
    const [, sendResult] = await Promise.all([
      set(args.flushDraftClear$, signal),
      accept(
        client.send({
          body: sendMessageRequestBody({
            agentId: args.agentId,
            clientMessageId: args.clientMessageId,
            chatThreadSortEventId: args.chatThreadSortEventId,
            threadId: args.threadId,
            result: args.result,
            modelSelection: args.modelSelection,
            codexFastModeEnabled,
            realAgentInPreviewEnabled,
            generationTemplate: args.generationTemplate,
            structuredPrompt: args.structuredPrompt,
            options: args.options,
          }),
          fetchOptions: { signal },
        }),
        [201],
      ),
    ]);
    signal.throwIfAborted();
    return sendResult.body.runId;
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
      const features = get(featureSwitch$);
      const structuredPrompt = structuredPromptForSend({
        enabled: features[FeatureSwitchKey.StructuredPrompt] ?? false,
        editorDocument: request.options?.editorDocument,
        generationTemplate,
        attachments: result.attachments,
      });
      set(cancelDraftSync$);
      set(draft.clear$);
      const clientMessageId = crypto.randomUUID();
      const chatThreadSortEventId = crypto.randomUUID();
      const createdAt = nowDate().toISOString();
      set(appendOptimisticSendMessage$, {
        threadId,
        agentId: request.agentId,
        clientMessageId,
        chatThreadSortEventId,
        createdAt,
        result,
        generationTemplate,
        structuredPrompt,
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
          clientMessageId,
          chatThreadSortEventId,
          result,
          modelSelection: request.modelSelection,
          generationTemplate,
          structuredPrompt,
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
  const { threadId, pendingSendCount$, threadMeta$, modelSelectionForSend$ } =
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
      const meta = await get(threadMeta$);
      signal.throwIfAborted();
      if (!meta) {
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
            agentId: meta.agentId,
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
  threadMeta$: Computed<Promise<ThreadMeta | null>>;
  modelSelectionForSend$: Command<
    Promise<ModelProviderSelection | null>,
    [AbortSignal]
  >;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  scrollToBottom$: Command<void, []>;
  writePersistentMessages$: Command<
    Promise<void>,
    [PagedChatMessage[], AbortSignal]
  >;
  appendOptimisticMessage$: Command<void, [OptimisticChatMessageInput]>;
  dataSource: ChatThreadRemote;
}

function createQueueMessage(deps: QueueMessageDeps) {
  const {
    threadId,
    threadMeta$,
    modelSelectionForSend$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    scrollToBottom$,
    writePersistentMessages$,
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
      const meta = await get(threadMeta$);
      signal.throwIfAborted();
      if (!meta) {
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
      const structuredPrompt = queueStructured(features, options, result);

      set(cancelDraftSync$);
      set(draft.clear$);

      const clientMessageId = crypto.randomUUID();
      const chatThreadSortEventId = crypto.randomUUID();
      const nowIso = nowDate().toISOString();
      set(touchOptimisticChatThreadSort$, {
        id: chatThreadSortEventId,
        threadId,
        agentId: meta.agentId,
        createdAt: nowIso,
      });
      set(appendOptimisticMessage$, {
        threadId,
        optimisticUserMessageAssociation: "queue",
        message: {
          id: clientMessageId,
          role: "user",
          content: result.prompt,
          attachFiles: result.attachments,
          generationTemplate,
          ...(structuredPrompt ? { structuredPrompt } : {}),
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
      const [, persistedMessage] = await Promise.all([
        set(flushDraftClear$, signal),
        set(
          dataSource.appendQueuedMessage$,
          {
            threadId,
            agentId: meta.agentId,
            content: result.prompt,
            attachments: result.attachments ?? null,
            clientMessageId,
            chatThreadSortEventId,
            hasTextContent: result.hasTextContent,
            ...(runOptions ? { runOptions } : {}),
            ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
            generationTemplate,
            ...(structuredPrompt ? { structuredPrompt } : {}),
            ...(options.computerUseHostId === undefined
              ? {}
              : { computerUseHostId: options.computerUseHostId }),
          },
          signal,
        ),
      ]);
      signal.throwIfAborted();
      await set(writePersistentMessages$, [persistedMessage], signal);
      signal.throwIfAborted();

      return true;
    },
  );
}

interface RecallMessageDeps {
  threadId: string;
  threadMeta$: Computed<Promise<ThreadMeta | null>>;
  rawMessages$: Computed<ChatMessageProjectionEntry[]>;
  draft: DraftSignals;
  writePersistentMessages$: Command<
    Promise<void>,
    [PagedChatMessage[], AbortSignal]
  >;
  appendOptimisticMessage$: Command<void, [OptimisticChatMessageInput]>;
  dataSource: ChatThreadRemote;
}

function createRecallMessage(deps: RecallMessageDeps) {
  const {
    threadId,
    threadMeta$,
    rawMessages$,
    draft,
    writePersistentMessages$,
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
      if (!message) {
        return;
      }

      const meta = await get(threadMeta$);
      signal.throwIfAborted();
      if (!meta) {
        return;
      }

      const clientMessageId = crypto.randomUUID();
      set(appendOptimisticMessage$, {
        threadId,
        message: {
          id: clientMessageId,
          role: "user",
          content: null,
          revokesMessageId: message.id,
          createdAt: nowDate().toISOString(),
        },
      });
      set(
        draft.seed$,
        message.content ?? "",
        (message.attachFiles ?? []).map(createRestoredAttachment),
      );

      const persistedMessage = await set(
        dataSource.recallMessage$,
        {
          threadId,
          agentId: meta.agentId,
          revokesMessageId: message.id,
          clientMessageId,
        },
        signal,
      );
      signal.throwIfAborted();
      await set(writePersistentMessages$, [persistedMessage], signal);
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
  threadMeta$,
  rawMessages$,
  writePersistentMessages$,
  appendOptimisticMessage$,
  dataSource,
}: {
  threadId: string;
  threadMeta$: Computed<Promise<ThreadMeta | null>>;
  rawMessages$: Computed<ChatMessageProjectionEntry[]>;
  writePersistentMessages$: Command<
    Promise<void>,
    [PagedChatMessage[], AbortSignal]
  >;
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
    const meta = await get(threadMeta$);
    signal.throwIfAborted();
    if (!meta) {
      return;
    }

    const raw = get(rawMessages$);
    const queuedMessages = queuedMessagesFromRaw(raw);

    const interruptRequests = cancellableRunIdsFromRawMessages(raw).map(
      (runId) => {
        const clientMessageId = crypto.randomUUID();
        set(appendOptimisticMessage$, {
          threadId,
          message: {
            id: clientMessageId,
            role: "user",
            content: null,
            interruptsRunId: runId,
            createdAt: nowDate().toISOString(),
          },
        });
        return { runId, clientMessageId };
      },
    );

    const recallRequests = queuedMessages.map((message) => {
      const clientMessageId = crypto.randomUUID();
      set(appendOptimisticMessage$, {
        threadId,
        message: {
          id: clientMessageId,
          role: "user",
          content: null,
          revokesMessageId: message.id,
          createdAt: nowDate().toISOString(),
        },
      });
      return {
        threadId,
        agentId: meta.agentId,
        revokesMessageId: message.id,
        clientMessageId,
      };
    });

    const [, recalledMessages] = await Promise.all([
      set(
        dataSource.cancelRuns$,
        {
          threadId,
          agentId: meta.agentId,
          interrupts: interruptRequests,
        },
        signal,
      ),
      Promise.all(
        recallRequests.map((request) => {
          return set(dataSource.recallMessage$, request, signal);
        }),
      ),
    ]);
    signal.throwIfAborted();
    await set(writePersistentMessages$, recalledMessages, signal);
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
    latestChatMessageId$: messages.latestChatMessageId$,
    latestRunFinishCreatedAt$: messages.latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$: messages.latestAssistantTextCreatedAt$,
    visibleRenderedChatGroups$: messages.visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$: messages.visibleRenderedChatGroupsReady$,
    messageImageGroups$: messages.messageImageGroups$,
    mailDraftCardSignalsById$: messages.mailDraftCardSignalsById$,
    hasMessages$: messages.hasMessages$,
    hasNewMessages$: messages.hasNewMessages$,
    hasQueuedMessages$: messages.hasQueuedMessages$,
    queuedMessageItems$: messages.queuedMessageItems$,
    emptyQueuedMessageItems$: messages.emptyQueuedMessageItems$,
    thinkingIndicatorMode$: messages.thinkingIndicatorMode$,
    thinkingMessageId$: messages.thinkingMessageId$,
    thinkingText$: messages.thinkingText$,
    recommendedFollowupSource$: messages.recommendedFollowupSource$,
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
  agentId$: Computed<Promise<string | null>>,
) {
  const workflowComposer = createWorkflowComposerSignals(draft, threadId);
  return {
    workflowComposer,
    composerConnectors: createComposerConnectorSignals(agentId$),
    focusInput$: workflowComposer.focus$,
  };
}

export function createChatThreadSignals(
  threadId: string,
  draft: DraftSignals,
  dataSource: ChatThreadRemote = createRemoteChatThreadDataSource(threadId),
  initialOptimisticEntries: readonly OptimisticChatMessageEntry[] = [],
): ChatThreadSignals {
  const { remoteThreadDetail$, threadDraft$, reloadThread$ } =
    createRemoteThreadDetail(dataSource);
  const threadMeta$ = createThreadMeta(threadId);
  const threadTitle = createThreadTitleParts(threadMeta$);
  const threadSettledInServer$ = createThreadSettledInServer(
    threadId,
    threadMeta$,
  );
  const modelSelection = createModelSelection(
    threadId,
    threadMeta$,
    remoteThreadDetail$,
    dataSource,
  );
  const modelSelectionForSend$ = createModelSelectionForSend(modelSelection);
  const computerUseHostSelection = createComputerUseHostSelection(
    threadId,
    remoteThreadDetail$,
    dataSource,
  );
  const {
    recordScrollHeightForPrepend$,
    clearScrollHeightForPrepend$,
    awayFromBottom$,
    ...scrollSignals
  } = createChatThreadScrollSignals(threadId);
  const { containerEl$, setContainerRef$ } = createContainerRef();
  const { composerFileInput$, setComposerFileInput$ } =
    createComposerFileInput();
  const threadOwned = createThreadOwnedSignals(threadId, threadMeta$);
  const messages = createChatThreadMessagePipeline({
    threadId,
    dataSource,
    initialOptimisticEntries,
    recordScrollHeightForPrepend$,
    clearScrollHeightForPrepend$,
    awayFromBottom$,
  });
  const { queueDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft, dataSource);
  const composerSendButton = createComposerSendButtonSignals(messages);
  const artifact = createArtifacts(threadId);
  const runTracking = createRunTracking({
    threadId,
    reloadThread$,
    remoteThreadDetail$,
    latestChatMessageId$: messages.latestChatMessageId$,
    latestRunFinishCreatedAt$: messages.latestRunFinishCreatedAt$,
    initializeIndexedDbMessages$: messages.initializeIndexedDbMessages$,
    syncRemoteMessages$: messages.syncRemoteMessages$,
    settleMessageSync$: messages.settleMessageSync$,
    fetchUpdatedMessage$: messages.fetchUpdatedMessage$,
    reloadArtifacts$: artifact.reloadArtifacts$,
    autoScroll$: scrollSignals.autoScroll$,
    automationSignals: threadOwned,
    dataSource,
  });
  const messageActions = createThreadMessageActions({
    threadId,
    pendingSendCount$: composerSendButton.pendingSendCount$,
    threadMeta$,
    modelSelectionForSend$,
    rawMessages$: messages.rawMessages$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    scrollToBottom$: scrollSignals.scrollToBottom$,
    syncRemoteMessages$: messages.syncRemoteMessages$,
    writePersistentMessages$: messages.writePersistentMessages$,
    appendOptimisticMessage$: messages.appendOptimisticMessage$,
    dataSource,
  });
  const composer = createThreadComposer(draft, threadId, threadOwned.agentId$);
  return {
    threadId,
    remoteThreadDetail$,
    threadDraft$,
    threadMeta$,
    reloadThread$,
    ...threadTitle,
    threadSettledInServer$,
    ...modelSelection,
    ...computerUseHostSelection,
    ...messageActions,
    composerSendButtonStatus$: composerSendButton.composerSendButtonStatus$,
    ...scrollSignals,
    containerEl$,
    setContainerRef$,
    awayFromBottom$,
    draft,
    ...composer,
    composerFileInput$,
    setComposerFileInput$,
    ...threadOwned,
    queueDraftSync$,
    ...publicChatThreadMessageSignals(messages),
    subscribeChatThread$: runTracking.subscribeChatThread$,
    ...createThinkingIndicatorSignals(
      messages.thinkingText$,
      messages.thinkingMessageId$,
    ),
    ...artifact,
  };
}
