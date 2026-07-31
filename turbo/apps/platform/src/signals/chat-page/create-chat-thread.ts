import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay } from "signal-timers";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { IN_VITEST } from "../../env.ts";
import { i18n } from "../../i18n/index.ts";
import {
  onRef,
  onRejection,
  resetSignal,
  settle,
  setLoop,
  withCleanup,
} from "../utils.ts";
import { createHeaderAutomationSignals } from "./header-automation-menu.ts";
import { createThreadSidebarSignals } from "./thread-sidebar.ts";
import { createThreadSidebarAutoOpenCandidate } from "./thread-sidebar-auto-open.ts";
import {
  createChatThreadScrollSignals,
  type ThreadScrollPosition,
  type ThreadScrollRenderRequest,
} from "./chat-thread-scroll.ts";
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
  appendOptimisticChatEvent$,
  createOptimisticChatEventEntry,
  createOptimisticChatEventsForThread,
  reconcileOptimisticChatEvents$,
  removeOptimisticChatEvent$,
  type OptimisticChatEventEntry,
  type OptimisticChatEventInput,
} from "./optimistic-chat-events.ts";
import type { ChatEvent } from "./chat-event-types.ts";
import {
  chatThreadArtifactsContract,
  type AttachFile,
  type GenerationTemplateRequest,
  type ChatThreadArtifactRun,
  type ChatEvent as PersistedChatEvent,
  type ChatPromptEvent,
  type ChatUserMessageEvent,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldActiveChatGoalObjective,
  foldLatestChatUsageByRunId,
  isBrowserLifecycleEventType,
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
import type { EnrichedChatEvent, ChatEventGroup } from "./chat-event.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import { logger } from "../log.ts";
import {
  CHAT_EVENTS_PAGE_LIMIT,
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
import { parseChatEventBodyBlocks } from "./chat-event-body-blocks.ts";
import {
  createArtifactCardSignalsRegistry,
  type ArtifactCardSignalsRegistry,
  type ArtifactSignals,
} from "./artifact-card-signals.ts";
import {
  createAgentReferenceSignalsRegistry,
  type AgentReferenceSignalsRegistry,
} from "./agent-reference-signals.ts";
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
  EventImageGroupProjection,
  QueueMessageOptions,
  QueuedChatEventItem,
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
  type BrowserLifecycleOptimisticEvents,
  type BrowserSessionCardSignalsRegistry,
} from "./browser-session-block.ts";
import { createChatThreadContainerSignals } from "./chat-thread-container.ts";
import { createAssistantErrorRecoverySignals } from "./assistant-error-recovery.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorAuthorizationSignals,
} from "../zero-page/zero-connectors.ts";
import {
  messageDocumentToDisplayText,
  messageDocumentToPrompt,
  textToMessageDocument,
} from "../zero-page/user-message-document-codec.ts";
import { locale$ } from "../locale.ts";

type ChatThreadRemote = ReturnType<typeof createRemoteChatThreadDataSource>;

export type { DraftSignals } from "../zero-page/chat-draft.ts";

const L = logger("ChatThread");

type RecallControlEvent = Extract<
  ChatEvent,
  { eventType: "control.revoke" | "run.dequeued" }
>;

function isRecallControlEvent(event: ChatEvent): event is RecallControlEvent {
  return (
    event.eventType === "control.revoke" || event.eventType === "run.dequeued"
  );
}

function isQueueMarkerEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "run.queued" }> {
  return event.eventType === "run.queued";
}

function isGoalMarkerEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "goal.changed" }> {
  return event.eventType === "goal.changed";
}

function isGoalQueueEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "input.goal" }> {
  return event.eventType === "input.goal";
}

function isUsageEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "usage.recorded" }> {
  return event.eventType === "usage.recorded";
}

function isInterruptControlEvent(
  event: ChatEvent,
): event is Extract<ChatEvent, { eventType: "control.interrupt" }> {
  return event.eventType === "control.interrupt";
}

function isInputChatEvent(
  event: ChatEvent,
): event is Extract<
  ChatEvent,
  { eventType: ChatUserMessageEvent["eventType"] }
> {
  return (
    event.eventType === "input.prompt" || event.eventType === "input.rejected"
  );
}

function chatEventAttachFiles(
  event: ChatEvent,
): ChatPromptEvent["attachFiles"] {
  return isInputChatEvent(event) ? event.attachFiles : undefined;
}

function createInterruptedAssistantProjection(
  event: Extract<ChatEvent, { eventType: "control.interrupt" }>,
  runId: string,
): ChatEvent {
  const { interruptsRunId, ...rest } = event;
  void interruptsRunId;
  return {
    ...rest,
    eventType: "run.cancelled" as const,
    content: "Run cancelled",
    runId,
    error: "Run cancelled",
    runLifecycleEvent: "cancelled",
  };
}

function completedRunIdsFromEvents(events: readonly ChatEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.eventType === "run.completed" && event.runId !== undefined) {
      ids.add(event.runId);
    }
  }
  return Array.from(ids);
}

function isInterruptedAssistantCancellation(
  event: ChatEvent,
  interruptedRunIds: Set<string>,
): boolean {
  const runId = event.runId;
  return (
    runId !== undefined &&
    isCancelledRunEvent(event) &&
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

const THINKING_PHRASE_COUNT = 10;
const DONE_PHRASE_COUNT = 8;

function thinkingPhrase(index: number): string {
  switch (index) {
    case 0: {
      return i18n.t(($) => {
        return $.chat.run.thinking.brewing;
      });
    }
    case 1: {
      return i18n.t(($) => {
        return $.chat.run.thinking.piecingTogether;
      });
    }
    case 2: {
      return i18n.t(($) => {
        return $.chat.run.thinking.spinningUp;
      });
    }
    case 3: {
      return i18n.t(($) => {
        return $.chat.run.thinking.onIt;
      });
    }
    case 4: {
      return i18n.t(($) => {
        return $.chat.run.thinking.assembling;
      });
    }
    case 5: {
      return i18n.t(($) => {
        return $.chat.run.thinking.sketching;
      });
    }
    case 6: {
      return i18n.t(($) => {
        return $.chat.run.thinking.mapping;
      });
    }
    case 7: {
      return i18n.t(($) => {
        return $.chat.run.thinking.wiring;
      });
    }
    case 8: {
      return i18n.t(($) => {
        return $.chat.run.thinking.shaping;
      });
    }
    default: {
      return i18n.t(($) => {
        return $.chat.run.thinking.tuningIn;
      });
    }
  }
}

function formatDonePhrase(lastEvent: ChatEvent | undefined): string {
  const time = lastEvent
    ? new Date(lastEvent.createdAt).toLocaleString(i18n.resolvedLanguage, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })
    : i18n.t(($) => {
        return $.chat.run.justNow;
      });
  const phraseIndex = lastEvent?.id
    ? lastEvent.id.charCodeAt(lastEvent.id.length - 1) % DONE_PHRASE_COUNT
    : 0;
  switch (phraseIndex) {
    case 0: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.wrappedUp;
        },
        { time },
      );
    }
    case 1: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.allDone;
        },
        { time },
      );
    }
    case 2: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.delivered;
        },
        { time },
      );
    }
    case 3: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.finished;
        },
        { time },
      );
    }
    case 4: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.wrap;
        },
        { time },
      );
    }
    case 5: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.missionComplete;
        },
        { time },
      );
    }
    case 6: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.signedOff;
        },
        { time },
      );
    }
    default: {
      return i18n.t(
        ($) => {
          return $.chat.run.done.doneAndDusted;
        },
        { time },
      );
    }
  }
}

function revokedEventIdsFromRawEvents(
  raw: readonly ChatEventProjectionEntry[],
): Set<string> {
  return revokedChatEventIds(
    raw.map((entry) => {
      return entry.event;
    }),
  );
}

function isRawOptimisticRunEvent(entry: ChatEventProjectionEntry): boolean {
  const { event } = entry;
  return (
    event.eventType === "input.prompt" &&
    event.runId === undefined &&
    entry.optimisticUserMessageAssociation === "run"
  );
}

function terminatedRunIdsFromRawEvents(
  raw: readonly ChatEventProjectionEntry[],
): Set<string> {
  return terminatedChatRunIds(
    raw.map((entry) => {
      return entry.event;
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
  event: ChatEvent,
): RunIndicatorState | undefined {
  const runId = event.runId;
  if (isQueueMarkerEvent(event)) {
    if (runId !== undefined && terminatedRunIds.has(runId)) {
      return undefined;
    }
    return "queued";
  }
  if (runId !== undefined && isChatRunTerminalEventType(event.eventType)) {
    return null;
  }
  if (runId === undefined) {
    return undefined;
  }
  return runActivityIndicatorState(terminatedRunIds, runId);
}

function nonAssistantRunIndicatorState(
  terminatedRunIds: ReadonlySet<string>,
  entry: ChatEventProjectionEntry,
): RunIndicatorState | undefined {
  if (isRawOptimisticRunEvent(entry)) {
    return "running";
  }
  const { runId } = entry.event;
  return runId === undefined
    ? undefined
    : runActivityIndicatorState(terminatedRunIds, runId);
}

function visibleRunStartIndexByRunId(
  raw: readonly ChatEventProjectionEntry[],
  revokedEventIds: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  // Only a user event proves that a run started inside the loaded window;
  // the first visible assistant event may be mid-run after pagination.
  const runStartIndexByRunId = new Map<string, number>();
  for (let index = 0; index < raw.length; index++) {
    const event = raw[index]!.event;
    const runId = event.runId;
    if (
      (event.eventType !== "input.prompt" &&
        event.eventType !== "input.rejected") ||
      runId === undefined ||
      runStartIndexByRunId.has(runId) ||
      revokedEventIds.has(event.id)
    ) {
      continue;
    }
    runStartIndexByRunId.set(runId, index);
  }
  return runStartIndexByRunId;
}

function laterStartedRunIndicatorState(
  raw: readonly ChatEventProjectionEntry[],
  terminatedRunId: string,
  terminatedRunIds: ReadonlySet<string>,
  revokedEventIds: ReadonlySet<string>,
  runStartIndexByRunId: ReadonlyMap<string, number>,
): RunIndicatorState | undefined {
  const terminatedRunStartIndex = runStartIndexByRunId.get(terminatedRunId);
  if (terminatedRunStartIndex === undefined) {
    return undefined;
  }

  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    const { event } = entry;
    const runId = event.runId;
    if (
      runId === undefined ||
      (runStartIndexByRunId.get(runId) ?? -1) <= terminatedRunStartIndex ||
      revokedEventIds.has(event.id) ||
      isUsageEvent(event) ||
      isGoalMarkerEvent(event)
    ) {
      continue;
    }
    const state =
      chatEventCompatibilityRole(event.eventType) === "assistant"
        ? assistantRunIndicatorState(terminatedRunIds, event)
        : nonAssistantRunIndicatorState(terminatedRunIds, entry);
    if (state === "running" || state === "queued") {
      return state;
    }
  }
  return undefined;
}

function deriveRunIndicatorStateFromRawEvents(
  raw: readonly ChatEventProjectionEntry[],
): RunIndicatorState {
  const revokedEventIds = revokedEventIdsFromRawEvents(raw);
  const terminatedRunIds = terminatedRunIdsFromRawEvents(raw);
  const runStartIndexByRunId = visibleRunStartIndexByRunId(
    raw,
    revokedEventIds,
  );

  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    const { event } = entry;
    if (revokedEventIds.has(event.id)) {
      continue;
    }
    if (isUsageEvent(event) || isGoalMarkerEvent(event)) {
      continue;
    }
    if (chatEventCompatibilityRole(event.eventType) === "assistant") {
      const state = assistantRunIndicatorState(terminatedRunIds, event);
      if (state === null && event.runId !== undefined) {
        const laterRunState = laterStartedRunIndicatorState(
          raw,
          event.runId,
          terminatedRunIds,
          revokedEventIds,
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

function liveRunIdsFromRawEvents(
  raw: readonly ChatEventProjectionEntry[],
): string[] {
  const terminatedRunIds = terminatedRunIdsFromRawEvents(raw);
  const revokedEventIds = revokedEventIdsFromRawEvents(raw);
  const liveRunIds: string[] = [];
  const seenRunIds = new Set<string>();
  for (const { event } of raw) {
    const runId = event.runId;
    if (
      runId !== undefined &&
      !revokedEventIds.has(event.id) &&
      !terminatedRunIds.has(runId) &&
      !isQueueMarkerEvent(event) &&
      !isUsageEvent(event) &&
      !isGoalMarkerEvent(event) &&
      !seenRunIds.has(runId)
    ) {
      liveRunIds.push(runId);
      seenRunIds.add(runId);
    }
  }
  return liveRunIds;
}

function cancellableRunIdsFromRawEvents(
  raw: readonly ChatEventProjectionEntry[],
): string[] {
  return liveRunIdsFromRawEvents(raw);
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

  const toggleTimelineExpanded$ = command(({ get, set }, eventId: string) => {
    const current = get(internalExpandedIds$);
    const next = new Set(current);
    if (next.has(eventId)) {
      next.delete(eventId);
    } else {
      next.add(eventId);
    }
    set(internalExpandedIds$, next);
  });

  // Copy state with 2s auto-clear
  const internalCopiedId$ = state<string | null>(null);
  const internalCopiedTimerId$ = state<number | null>(null);

  const copiedEventId$ = computed((get) => {
    return get(internalCopiedId$);
  });

  const copyEvent$ = command(
    async (
      { get, set },
      eventId: string,
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
      set(internalCopiedId$, eventId);
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
    copiedEventId$,
    copyEvent$,
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
// Sub-factory: paginated chat events
// ---------------------------------------------------------------------------

/**
 * Merge new events into existing groups.
 *
 * Upsert semantics by `id`: if an incoming event's id already exists in
 * the groups, its fields are replaced in place — this lets an optimistic
 * user row reconcile with the server-pushed row without React unmounting
 * and remounting the event (the React key stays the same).
 */
function mergeIntoGroups(
  groups: ChatEventGroup[],
  events: EnrichedChatEvent[],
): ChatEventGroup[] {
  const result = groups.map((g) => {
    return { ...g, events: [...g.events] };
  });

  const positionById = new Map<string, { groupIdx: number; msgIdx: number }>();
  for (let gi = 0; gi < result.length; gi++) {
    const group = result[gi]!;
    for (let mi = 0; mi < group.events.length; mi++) {
      positionById.set(group.events[mi]!.id, { groupIdx: gi, msgIdx: mi });
    }
  }

  for (const event of events) {
    const existing = positionById.get(event.id);
    if (existing) {
      result[existing.groupIdx]!.events[existing.msgIdx] = event;
      continue;
    }

    const last = result[result.length - 1];
    if (last && shouldMergeIntoGroup(last, event)) {
      last.events.push(event);
      positionById.set(event.id, {
        groupIdx: result.length - 1,
        msgIdx: last.events.length - 1,
      });
    } else {
      const role = chatEventCompatibilityRole(event.eventType);
      result.push({
        beginEventId: event.id,
        role,
        events: [event],
      });
      positionById.set(event.id, { groupIdx: result.length - 1, msgIdx: 0 });
    }
  }
  return result;
}

function firstRunIdForGroup(group: ChatEventGroup): string | undefined {
  return group.events.find((event) => {
    return event.runId !== undefined;
  })?.runId;
}

function shouldMergeIntoGroup(
  group: ChatEventGroup,
  event: EnrichedChatEvent,
): boolean {
  if (group.role !== chatEventCompatibilityRole(event.eventType)) {
    return false;
  }
  if (group.role !== "assistant") {
    return true;
  }

  const groupRunId = firstRunIdForGroup(group);
  if (groupRunId === undefined || event.runId === undefined) {
    return true;
  }
  return groupRunId === event.runId;
}

function orderEventsByRunTurn(
  events: readonly EnrichedChatEvent[],
): EnrichedChatEvent[] {
  const items: {
    order: number;
    events: EnrichedChatEvent[];
  }[] = [];
  const itemByRunId = new Map<string, (typeof items)[number]>();

  for (const event of events) {
    const runId = event.runId;
    if (runId === undefined) {
      items.push({ order: items.length, events: [event] });
      continue;
    }

    const existing = itemByRunId.get(runId);
    if (existing) {
      existing.events.push(event);
      continue;
    }

    const item = { order: items.length, events: [event] };
    itemByRunId.set(runId, item);
    items.push(item);
  }

  return items
    .sort((a, b) => {
      return a.order - b.order;
    })
    .flatMap((item) => {
      return item.events;
    });
}

function groupEventsForDisplay(events: EnrichedChatEvent[]): ChatEventGroup[] {
  const activeEvents: EnrichedChatEvent[] = [];
  const queuedEvents: EnrichedChatEvent[] = [];
  const usageByRunId = foldLatestChatUsageByRunId(events);
  for (const event of events) {
    if (isUsageEvent(event)) {
      continue;
    }
    if (
      chatEventCompatibilityRole(event.eventType) === "user" &&
      event.isQueued
    ) {
      queuedEvents.push(event);
      continue;
    }
    activeEvents.push(event);
  }

  const groups = [
    ...mergeIntoGroups([], orderEventsByRunTurn(activeEvents)),
    ...mergeIntoGroups([], queuedEvents),
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
  semanticEvents$: Computed<SemanticChatEvent[]>,
) {
  const transcriptEvents$ = createTranscriptEventsComputed(semanticEvents$);

  const allRenderedChatGroups$ = computed(
    async (get): Promise<ChatEventGroup[]> => {
      const events = await get(transcriptEvents$);
      return groupEventsForDisplay(events);
    },
  );
  const eventImageGroups$ = computed(
    async (get): Promise<EventImageGroupProjection[]> => {
      return (await get(allRenderedChatGroups$)).map((group) => {
        return {
          role: group.role,
          events: group.events.map((event) => {
            return {
              attachFiles: chatEventAttachFiles(event),
              blocks: event.blocks,
            };
          }),
        };
      });
    },
  );

  return {
    allRenderedChatGroups$,
    eventImageGroups$,
  };
}

interface RegisteredChatEvent {
  readonly event: PersistedChatEvent;
  readonly blocks: BodyRenderBlock[];
}

type PersistentChatEvents$ = State<RegisteredChatEvent[]>;

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

function mergeRegisteredEvents(
  eventSets: readonly (readonly RegisteredChatEvent[])[],
): RegisteredChatEvent[] {
  const byId = new Map<string, RegisteredChatEvent>();
  for (const entries of eventSets) {
    for (const entry of entries) {
      byId.set(entry.event.id, entry);
    }
  }
  return Array.from(byId.values()).sort((left, right) => {
    return left.event.seqId - right.event.seqId;
  });
}

function skipsEventBodyRendering(event: ChatEvent): boolean {
  return (
    isInterruptControlEvent(event) ||
    isRecallControlEvent(event) ||
    isQueueMarkerEvent(event) ||
    isGoalQueueEvent(event) ||
    isGoalMarkerEvent(event)
  );
}

function registerEventAttachments(
  event: ChatEvent,
  artifactCardSignals: ArtifactCardSignalsRegistry,
): void {
  for (const attachment of chatEventAttachFiles(event) ?? []) {
    artifactCardSignals.register({
      filename: attachment.filename,
      url: attachment.url,
      kind: classifyChatAttachment(attachment),
    });
  }
}

function registerEventAgentReferences(
  event: ChatEvent,
  agentReferenceSignals: AgentReferenceSignalsRegistry,
): void {
  if (!isInputChatEvent(event)) {
    return;
  }
  for (const part of event.userMessage.parts) {
    if (part.type === "agent") {
      agentReferenceSignals.register(part.agentId);
      continue;
    }
    if (part.type !== "feedback") {
      continue;
    }
    for (const notePart of part.note) {
      if (notePart.type === "agent") {
        agentReferenceSignals.register(notePart.agentId);
      }
    }
  }
}

function registerChatEvent(
  event: PersistedChatEvent,
  registerBodyBlocks: BodyBlocksRenderer,
  artifactCardSignals: ArtifactCardSignalsRegistry,
  agentReferenceSignals: AgentReferenceSignalsRegistry,
): RegisteredChatEvent {
  registerEventAttachments(event, artifactCardSignals);
  registerEventAgentReferences(event, agentReferenceSignals);
  const blocks = skipsEventBodyRendering(event)
    ? []
    : registerBodyBlocks(parseChatEventBodyBlocks(event));
  return { event, blocks };
}

function createMergePersistentEvents(
  threadId: string,
  persistentEvents$: PersistentChatEvents$,
  registerBodyBlocks: BodyBlocksRenderer,
  artifactCardSignals: ArtifactCardSignalsRegistry,
  agentReferenceSignals: AgentReferenceSignalsRegistry,
) {
  return command(({ get, set }, events: PersistedChatEvent[]): void => {
    if (events.length === 0) {
      return;
    }
    const reportedCompletedRunIds = new Set(
      completedRunIdsFromEvents(
        get(persistentEvents$).map((entry) => {
          return entry.event;
        }),
      ),
    );
    const newlyCompletedRunIds = completedRunIdsFromEvents(events).filter(
      (runId) => {
        return !reportedCompletedRunIds.has(runId);
      },
    );
    for (const _ of newlyCompletedRunIds) {
      captureTaskCompletedSuccessfully();
    }
    const registeredEvents = events.map((event) => {
      return registerChatEvent(
        event,
        registerBodyBlocks,
        artifactCardSignals,
        agentReferenceSignals,
      );
    });
    set(persistentEvents$, (prev) => {
      return mergeRegisteredEvents([prev, registeredEvents]);
    });
    set(reconcileOptimisticChatEvents$, { threadId, events: events });
  });
}

interface ServerChatEventProjectionEntry {
  event: PersistedChatEvent;
  source: "server";
  blocks: BodyRenderBlock[];
  optimisticUserMessageAssociation?: never;
}

interface OptimisticChatEventProjectionEntry {
  event: OptimisticChatEventEntry["event"];
  source: "optimistic";
  blocks: BodyRenderBlock[];
  optimisticUserMessageAssociation?: OptimisticChatEventEntry["optimisticUserMessageAssociation"];
}

type ChatEventProjectionEntry =
  | ServerChatEventProjectionEntry
  | OptimisticChatEventProjectionEntry;

function projectRawEvents({
  persistentEvents,
  optimisticEntries,
  resolveBodyBlocks,
}: {
  persistentEvents: readonly RegisteredChatEvent[];
  optimisticEntries: readonly OptimisticChatEventEntry[];
  resolveBodyBlocks: BodyBlocksRenderer;
}): ChatEventProjectionEntry[] {
  const serverIds = new Set(
    persistentEvents.map((entry) => {
      return entry.event.id;
    }),
  );
  const optimistic = optimisticEntries.filter((entry) => {
    return !serverIds.has(entry.event.id);
  });
  // Optimistic events do not have a server sequence yet. Keep their array
  // order and append them after every persistent event.
  return [
    ...persistentEvents.map((entry) => {
      return { ...entry, source: "server" as const };
    }),
    ...optimistic.map((entry) => {
      return {
        event: entry.event,
        blocks: resolveBodyBlocks(entry.parsedBodyBlocks),
        source: "optimistic" as const,
        optimisticUserMessageAssociation:
          entry.optimisticUserMessageAssociation,
      };
    }),
  ];
}

function createRawEventsComputed({
  persistentEvents$,
  optimisticEvents$,
  resolveBodyBlocks,
}: {
  persistentEvents$: PersistentChatEvents$;
  optimisticEvents$: Computed<OptimisticChatEventEntry[]>;
  resolveBodyBlocks: BodyBlocksRenderer;
}): Computed<ChatEventProjectionEntry[]> {
  return computed((get): ChatEventProjectionEntry[] => {
    return projectRawEvents({
      persistentEvents: get(persistentEvents$),
      optimisticEntries: get(optimisticEvents$),
      resolveBodyBlocks,
    });
  });
}

function createTranscriptEventsComputed(
  semanticEvents$: Computed<SemanticChatEvent[]>,
): Computed<Promise<EnrichedChatEvent[]>> {
  return computed((get): Promise<EnrichedChatEvent[]> => {
    return Promise.resolve(
      get(semanticEvents$).map((entry) => {
        const { event, isQueued, isOptimisticRun } = entry;
        const role = chatEventCompatibilityRole(event.eventType);
        if (role !== "assistant") {
          return {
            ...event,
            blocks: entry.blocks,
            isQueued,
            isOptimisticRun,
          };
        }
        return {
          ...event,
          blocks: entry.blocks,
          isQueued,
          isOptimisticRun: false,
        };
      }),
    );
  });
}

interface SemanticChatEvent {
  readonly event: ChatEvent;
  readonly blocks: BodyRenderBlock[];
  readonly isQueued: boolean;
  readonly isOptimisticRun: boolean;
}

type QueuedChatEvent = Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.automation" }
>;

function isQueuedChatEvent(event: ChatEvent): event is QueuedChatEvent {
  return (
    event.eventType === "input.prompt" || event.eventType === "input.automation"
  );
}

interface SemanticChatEventGroup {
  readonly role: "user" | "assistant";
  readonly events: SemanticChatEvent[];
}

interface SemanticChatGroups {
  readonly activeGroups: SemanticChatEventGroup[];
  readonly allGroups: SemanticChatEventGroup[];
}

function semanticTranscriptEventsFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): SemanticChatEvent[] {
  const interruptedRunIds = new Set(
    raw.flatMap((entry) => {
      const { event } = entry;
      return isInterruptControlEvent(event) && event.interruptsRunId
        ? [event.interruptsRunId]
        : [];
    }),
  );
  const recalledIds = new Set(
    raw.flatMap((entry) => {
      const { event } = entry;
      return isRecallControlEvent(event) && event.revokesEventId
        ? [event.revokesEventId]
        : [];
    }),
  );
  const replacedIds = new Set(
    raw.flatMap((entry) => {
      const { event } = entry;
      return !isRecallControlEvent(event) && event.revokesEventId
        ? [event.revokesEventId]
        : [];
    }),
  );

  return raw.flatMap((entry): SemanticChatEvent[] => {
    const { event } = entry;
    if (
      isRecallControlEvent(event) ||
      isQueueMarkerEvent(event) ||
      isGoalQueueEvent(event) ||
      isGoalMarkerEvent(event) ||
      isBrowserLifecycleEventType(event.eventType) ||
      isInterruptedAssistantCancellation(event, interruptedRunIds) ||
      recalledIds.has(event.id) ||
      replacedIds.has(event.id)
    ) {
      return [];
    }
    if (isInterruptControlEvent(event) && event.interruptsRunId) {
      return [
        {
          event: createInterruptedAssistantProjection(
            event,
            event.interruptsRunId,
          ),
          blocks: [],
          isQueued: false,
          isOptimisticRun: false,
        },
      ];
    }

    const isUnassociatedUser =
      chatEventCompatibilityRole(event.eventType) === "user" &&
      event.runId === undefined;
    const optimisticAssociation = entry.optimisticUserMessageAssociation;
    const isOptimisticRun =
      isUnassociatedUser && optimisticAssociation === "run";
    const isQueued =
      isUnassociatedUser &&
      optimisticAssociation !== "run" &&
      (event.eventType === "input.prompt" ||
        event.eventType === "input.automation");
    return [{ event, blocks: entry.blocks, isQueued, isOptimisticRun }];
  });
}

function orderSemanticEventsByRunTurn(
  events: readonly SemanticChatEvent[],
): SemanticChatEvent[] {
  const items: {
    order: number;
    events: SemanticChatEvent[];
  }[] = [];
  const itemByRunId = new Map<string, (typeof items)[number]>();

  for (const semanticEvent of events) {
    const runId = semanticEvent.event.runId;
    if (runId === undefined) {
      items.push({ order: items.length, events: [semanticEvent] });
      continue;
    }
    const existing = itemByRunId.get(runId);
    if (existing) {
      existing.events.push(semanticEvent);
      continue;
    }
    const item = { order: items.length, events: [semanticEvent] };
    itemByRunId.set(runId, item);
    items.push(item);
  }

  return items
    .sort((left, right) => {
      return left.order - right.order;
    })
    .flatMap((item) => {
      return item.events;
    });
}

function shouldMergeSemanticEvent(
  group: SemanticChatEventGroup,
  semanticEvent: SemanticChatEvent,
): boolean {
  if (
    group.role !== chatEventCompatibilityRole(semanticEvent.event.eventType)
  ) {
    return false;
  }
  if (group.role !== "assistant") {
    return true;
  }
  const groupRunId = group.events.find((entry) => {
    return entry.event.runId !== undefined;
  })?.event.runId;
  const eventRunId = semanticEvent.event.runId;
  return (
    groupRunId === undefined ||
    eventRunId === undefined ||
    groupRunId === eventRunId
  );
}

function groupSemanticEvents(
  events: readonly SemanticChatEvent[],
): SemanticChatEventGroup[] {
  const groups: SemanticChatEventGroup[] = [];
  for (const semanticEvent of events) {
    const lastGroup = groups.at(-1);
    if (lastGroup && shouldMergeSemanticEvent(lastGroup, semanticEvent)) {
      lastGroup.events.push(semanticEvent);
      continue;
    }
    groups.push({
      role: chatEventCompatibilityRole(semanticEvent.event.eventType),
      events: [semanticEvent],
    });
  }
  return groups;
}

function groupSemanticChatEvents(
  semanticEvents: readonly SemanticChatEvent[],
): SemanticChatGroups {
  const activeEvents: SemanticChatEvent[] = [];
  const queuedEvents: SemanticChatEvent[] = [];
  for (const semanticEvent of semanticEvents) {
    if (isUsageEvent(semanticEvent.event)) {
      continue;
    }
    if (
      chatEventCompatibilityRole(semanticEvent.event.eventType) === "user" &&
      semanticEvent.isQueued
    ) {
      queuedEvents.push(semanticEvent);
      continue;
    }
    activeEvents.push(semanticEvent);
  }
  const activeGroups = groupSemanticEvents(
    orderSemanticEventsByRunTurn(activeEvents),
  );
  return {
    activeGroups,
    allGroups: [...activeGroups, ...groupSemanticEvents(queuedEvents)],
  };
}

function queuedEventsFromSemanticEvents(
  semanticEvents: readonly SemanticChatEvent[],
): QueuedChatEvent[] {
  return semanticEvents.flatMap((entry) => {
    const { event } = entry;
    return chatEventCompatibilityRole(event.eventType) === "user" &&
      entry.isQueued &&
      isQueuedChatEvent(event)
      ? [event]
      : [];
  });
}

function queuedEventsFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): QueuedChatEvent[] {
  return queuedEventsFromSemanticEvents(semanticTranscriptEventsFromRaw(raw));
}

function lastAssistantCancelledFromGroups(groups: SemanticChatGroups): boolean {
  const lastGroup = groups.allGroups.at(-1);
  const lastEvent = lastGroup?.events.at(-1)?.event;
  return lastEvent ? isCancelledRunEvent(lastEvent) : false;
}

function isRenderableAssistantSemanticEvent(entry: SemanticChatEvent): boolean {
  const { event } = entry;
  return (
    chatEventCompatibilityRole(event.eventType) === "assistant" &&
    (Boolean(event.content) || ("error" in event && Boolean(event.error)))
  );
}

function isThinkingMarkerSemanticEvent(entry: SemanticChatEvent): boolean {
  const { event } = entry;
  return (
    event.eventType === "output.thinking" &&
    event.content === null &&
    event.thinking.trim().length > 0 &&
    event.runId !== undefined
  );
}

function lastRunThinkingEvent(
  groups: readonly SemanticChatEventGroup[],
): SemanticChatEvent | undefined {
  const events = groups.flatMap((group) => {
    return group.events;
  });
  const lastEvent = events.at(-1);
  if (!lastEvent || !isThinkingMarkerSemanticEvent(lastEvent)) {
    return undefined;
  }
  const runId = lastEvent.event.runId;
  const runHasAssistantText = events.some((entry) => {
    return (
      entry.event.runId === runId && isRenderableAssistantSemanticEvent(entry)
    );
  });
  return runHasAssistantText ? undefined : lastEvent;
}

interface ThinkingIndicatorProjection {
  readonly mode: ThinkingIndicatorMode;
  readonly thinkingEventId: string | null;
  readonly thinkingText: string | null;
}

function assistantGroupOnlyHasThinking(
  group: SemanticChatEventGroup,
  thinkingEvent: SemanticChatEvent | undefined,
): boolean {
  if (group.role !== "assistant" || thinkingEvent === undefined) {
    return false;
  }
  return !group.events.some((entry) => {
    return isRenderableAssistantSemanticEvent(entry);
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
    return { mode: null, thinkingEventId: null, thinkingText: null };
  }
  const lastIsAssistant = lastGroup.role === "assistant";
  const lastAssistantEvent = lastIsAssistant
    ? lastGroup.events.at(-1)?.event
    : undefined;
  const rawThinkingEvent = lastRunThinkingEvent(activeGroups);
  const lastAssistantOnlyThinking = assistantGroupOnlyHasThinking(
    lastGroup,
    rawThinkingEvent,
  );
  const lastAssistantCancelled = lastAssistantEvent
    ? isCancelledRunEvent(lastAssistantEvent)
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
    return { mode: null, thinkingEventId: null, thinkingText: null };
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
    rawThinkingEvent?.event.eventType === "output.thinking"
      ? rawThinkingEvent.event.thinking?.trim() || null
      : null;
  return {
    mode,
    thinkingEventId: thinkingText ? (rawThinkingEvent?.event.id ?? null) : null,
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
      let eventIndex = group.events.length - 1;
      eventIndex >= 0;
      eventIndex--
    ) {
      const event = group.events[eventIndex]?.event;
      if (
        !event ||
        chatEventCompatibilityRole(event.eventType) !== "assistant"
      ) {
        continue;
      }
      if (event.content?.trim()) {
        return null;
      }
      if (event.eventType !== "output.followups") {
        continue;
      }
      const followups = event.recommendedFollowups;
      if (followups.length > 0) {
        return { eventId: event.id, followups };
      }
    }
  }
  return null;
}

function createEventSemanticSignals(
  semanticEvents$: Computed<SemanticChatEvent[]>,
  eventRunIndicatorState$: Computed<Promise<RunIndicatorState>>,
) {
  const semanticGroups$ = computed((get): SemanticChatGroups => {
    return groupSemanticChatEvents(get(semanticEvents$));
  });
  const queuedEvents$ = computed((get): QueuedChatEvent[] => {
    return queuedEventsFromSemanticEvents(get(semanticEvents$));
  });
  const thinkingIndicatorProjection$ = computed(
    async (get): Promise<ThinkingIndicatorProjection> => {
      const runState = await get(eventRunIndicatorState$);
      return thinkingIndicatorProjectionFromGroups(
        get(semanticGroups$),
        runState,
      );
    },
  );
  const hasEvents$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      get(semanticEvents$).some((entry) => {
        return !isUsageEvent(entry.event);
      }),
    );
  });
  const hasQueuedEvents$ = computed((get): Promise<boolean> => {
    return Promise.resolve(get(queuedEvents$).length > 0);
  });
  const queuedEventItems$ = computed(
    (get): Promise<readonly QueuedChatEventItem[]> => {
      return Promise.resolve(
        get(queuedEvents$).map((event) => {
          if (event.eventType === "input.automation") {
            return {
              kind: "automation" as const,
              id: event.id,
              automationId: event.automationId,
              triggerBrief: event.triggerBrief,
            };
          }
          return {
            kind: "message" as const,
            id: event.id,
            text: (
              messageDocumentToDisplayText(event.userMessage) ?? ""
            ).trim(),
          };
        }),
      );
    },
  );
  const emptyQueuedEventItems = Promise.resolve(
    [] as readonly QueuedChatEventItem[],
  );
  const emptyQueuedEventItems$ = computed(() => {
    return emptyQueuedEventItems;
  });
  const lastAssistantCancelled$ = computed((get): Promise<boolean> => {
    return Promise.resolve(
      lastAssistantCancelledFromGroups(get(semanticGroups$)),
    );
  });
  const allFinished$ = computed(async (get): Promise<boolean> => {
    return (await get(eventRunIndicatorState$)) === null;
  });
  const thinkingIndicatorMode$ = computed(
    async (get): Promise<ThinkingIndicatorMode> => {
      return (await get(thinkingIndicatorProjection$)).mode;
    },
  );
  const thinkingText$ = computed(async (get): Promise<string | null> => {
    return (await get(thinkingIndicatorProjection$)).thinkingText;
  });
  const thinkingEventId$ = computed(async (get): Promise<string | null> => {
    return (await get(thinkingIndicatorProjection$)).thinkingEventId;
  });
  const recommendedFollowupSource$ = computed(
    (get): Promise<RecommendedFollowupSource | null> => {
      return Promise.resolve(
        latestRecommendedFollowupsFromGroups(get(semanticGroups$)),
      );
    },
  );
  const donePhrase$ = computed((get): Promise<string> => {
    get(locale$);
    const lastEvent = get(semanticGroups$)
      .allGroups.at(-1)
      ?.events.at(-1)?.event;
    return Promise.resolve(formatDonePhrase(lastEvent));
  });

  return {
    hasEvents$,
    hasQueuedEvents$,
    queuedEventItems$,
    emptyQueuedEventItems$,
    lastAssistantCancelled$,
    allFinished$,
    thinkingIndicatorMode$,
    thinkingEventId$,
    thinkingText$,
    recommendedFollowupSource$,
    donePhrase$,
  };
}

interface EventSyncTracking {
  readonly completion: Promise<void>;
  readonly initialRemoteEventsReady: Promise<boolean>;
}

type MarkInitialRemoteEventsReady = (
  browserLifecycleAuthoritative: boolean,
) => void;

async function eventSyncCompletionAsAuthoritative(
  completion: Promise<void>,
): Promise<boolean> {
  await completion;
  return true;
}

function createEventSyncSignals(hasEvents$: Computed<Promise<boolean>>) {
  const initialSyncStarted = Promise.withResolvers<void>();
  const internalEventSync$ = state<EventSyncTracking | null>(null);
  const eventSyncTracking$ = computed(
    async (get): Promise<EventSyncTracking> => {
      await initialSyncStarted.promise;
      const tracking = get(internalEventSync$);
      if (!tracking) {
        throw new Error("Initial chat event sync tracking is missing");
      }
      return tracking;
    },
  );
  const initialRemoteEventsComplete$ = computed(async (get): Promise<void> => {
    await (
      await get(eventSyncTracking$)
    ).completion;
  });
  const hasNewEvents$ = computed(async (get): Promise<boolean> => {
    await get(initialRemoteEventsComplete$);
    return await get(hasEvents$);
  });
  const initialBrowserLifecycleAuthoritative$ = computed(
    async (get): Promise<boolean> => {
      return await (
        await get(eventSyncTracking$)
      ).initialRemoteEventsReady;
    },
  );
  const initialRemoteEventsReady$ = computed(async (get): Promise<void> => {
    await get(initialBrowserLifecycleAuthoritative$);
  });
  const trackEventSync$ = command(
    ({ set }, tracking: EventSyncTracking): void => {
      set(internalEventSync$, tracking);
      initialSyncStarted.resolve(undefined);
    },
  );
  const settleEventSync$ = command(({ set }): Promise<void> => {
    const promise = Promise.resolve();
    set(trackEventSync$, {
      completion: promise,
      initialRemoteEventsReady: Promise.resolve(true),
    });
    return promise;
  });
  return {
    hasNewEvents$,
    initialRemoteEventsReady$,
    initialBrowserLifecycleAuthoritative$,
    initialRemoteEventsComplete$,
    trackEventSync$,
    settleEventSync$,
  };
}

function createTrackedEventSyncCommand(
  runSyncRemoteEvents$: Command<
    Promise<void>,
    [MarkInitialRemoteEventsReady, AbortSignal]
  >,
  trackEventSync$: Command<void, [EventSyncTracking]>,
): Command<Promise<void>, [AbortSignal]> {
  return command(({ set }, signal: AbortSignal): Promise<void> => {
    const initialRemoteEventsReady = Promise.withResolvers<boolean>();
    const completion = set(
      runSyncRemoteEvents$,
      initialRemoteEventsReady.resolve,
      signal,
    );
    set(trackEventSync$, {
      completion,
      initialRemoteEventsReady: Promise.race([
        initialRemoteEventsReady.promise,
        eventSyncCompletionAsAuthoritative(completion),
      ]),
    });
    return completion;
  });
}

function isServerProjectionEntry(entry: ChatEventProjectionEntry): boolean {
  return entry.source === "server";
}

function latestRunFinishCreatedAtFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): string | undefined {
  for (let index = raw.length - 1; index >= 0; index--) {
    const entry = raw[index]!;
    if (!isServerProjectionEntry(entry)) {
      continue;
    }
    const { event } = entry;
    if (isChatRunTerminalEventType(event.eventType)) {
      return event.createdAt;
    }
  }
  return undefined;
}

function latestAssistantTextCreatedAtFromRaw(
  raw: readonly ChatEventProjectionEntry[],
): string | undefined {
  const revokedEventIds = revokedEventIdsFromRawEvents(raw);
  const interruptedRunIds = new Set(
    raw.flatMap((entry) => {
      const { event } = entry;
      return isInterruptControlEvent(event) && event.interruptsRunId
        ? [event.interruptsRunId]
        : [];
    }),
  );
  for (let index = raw.length - 1; index >= 0; index--) {
    const event = raw[index]!.event;
    if (revokedEventIds.has(event.id)) {
      continue;
    }
    if (isInterruptControlEvent(event)) {
      return event.createdAt;
    }
    if (
      chatEventCompatibilityRole(event.eventType) === "assistant" &&
      !isUsageEvent(event) &&
      !isQueueMarkerEvent(event) &&
      !isGoalMarkerEvent(event) &&
      !isInterruptedAssistantCancellation(event, interruptedRunIds) &&
      (event.content?.trim().length ?? 0) > 0
    ) {
      return event.createdAt;
    }
  }
  return undefined;
}

function createLatestEventSignals(
  rawEvents$: Computed<ChatEventProjectionEntry[]>,
) {
  const latestRunFinishCreatedAt$ = computed(
    (get): Promise<string | undefined> => {
      return Promise.resolve(latestRunFinishCreatedAtFromRaw(get(rawEvents$)));
    },
  );
  const latestAssistantTextCreatedAt$ = computed(
    (get): Promise<string | undefined> => {
      return Promise.resolve(
        latestAssistantTextCreatedAtFromRaw(get(rawEvents$)),
      );
    },
  );
  return {
    latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$,
  };
}

const HISTORY_BACKFILL_MERGE_BATCH_SIZE = 300;

/** Per-thread chat event sequences start at 1, so this marks the oldest event. */
const FIRST_CHAT_EVENT_SEQ_ID = 1;

function isBrowserLifecycleEvent(event: PersistedChatEvent): boolean {
  return (
    event.eventType === "browser.started" ||
    event.eventType === "browser.stopped"
  );
}

function createSyncRemoteEventsCommand({
  threadId,
  persistentEvents$,
  hasReachedOldestEvent$,
  mergePersistentEvents$,
  threadScrollPosition$,
  requestScrollAfterRender$,
  dataSource,
}: {
  threadId: string;
  persistentEvents$: PersistentChatEvents$;
  hasReachedOldestEvent$: Computed<boolean>;
  mergePersistentEvents$: Command<void, [PersistedChatEvent[]]>;
  threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  requestScrollAfterRender$: Command<void, [ThreadScrollPosition | null]>;
  dataSource: ChatThreadRemote;
}): Command<Promise<void>, [MarkInitialRemoteEventsReady, AbortSignal]> {
  return command(
    async (
      { get, set },
      markInitialRemoteEventsReady: MarkInitialRemoteEventsReady,
      signal: AbortSignal,
    ) => {
      const mergeEvents = (events: PersistedChatEvent[]): void => {
        const scrollPosition = get(threadScrollPosition$);
        set(mergePersistentEvents$, events);
        set(requestScrollAfterRender$, scrollPosition);
      };
      const persistentEvents = get(persistentEvents$);
      const accumulatedEvents: PersistedChatEvent[] = [];
      let mergedEventCount = 0;
      const latestPersistentEvent = persistentEvents.at(-1);
      let sinceSeqId = latestPersistentEvent?.event.seqId;
      let initialPageOldestEvent: PersistedChatEvent | undefined;
      let browserLifecycleObserved = persistentEvents.some(({ event }) => {
        return isBrowserLifecycleEvent(event);
      });

      async function syncEventsAfter(): Promise<void> {
        const requestedSinceSeqId = sinceSeqId;
        const isInitialPage = requestedSinceSeqId === undefined;
        const events = await set(
          dataSource.listEventsAfter$,
          { threadId, sinceSeqId: requestedSinceSeqId },
          signal,
        );
        signal.throwIfAborted();
        L.debug("syncRemoteMessages$ listEventsAfter result", {
          threadId,
          sinceSeqId: requestedSinceSeqId ?? null,
          gotCount: events.length,
        });

        if (events.length === 0) {
          return;
        }
        browserLifecycleObserved ||= events.some(isBrowserLifecycleEvent);

        await set(writeIndexedDbChatEvents$, threadId, events, signal);
        signal.throwIfAborted();
        if (isInitialPage) {
          initialPageOldestEvent = events[0]!;
          mergeEvents(events);
        } else {
          accumulatedEvents.push(...events);
        }
        sinceSeqId = events.at(-1)!.seqId;

        if (
          requestedSinceSeqId !== undefined &&
          events.length < CHAT_EVENTS_PAGE_LIMIT
        ) {
          return;
        }
        return syncEventsAfter();
      }
      await syncEventsAfter();
      signal.throwIfAborted();
      // When IndexedDB supplied the starting cursor, forward catch-up events
      // were accumulated rather than merged. Apply them before the sidebar
      // reads the lifecycle projection so cached state cannot win over remote
      // events that happened later.
      mergeEvents(accumulatedEvents.slice(mergedEventCount));
      mergedEventCount = accumulatedEvents.length;
      markInitialRemoteEventsReady(
        browserLifecycleObserved || get(hasReachedOldestEvent$),
      );

      if (!get(hasReachedOldestEvent$)) {
        const oldestEvent =
          persistentEvents[0]?.event ??
          initialPageOldestEvent ??
          accumulatedEvents[0];
        if (oldestEvent !== undefined) {
          let beforeSeqId = oldestEvent.seqId;
          async function syncEventsBefore(): Promise<void> {
            const events = await set(
              dataSource.listEventsBefore$,
              { threadId, beforeSeqId },
              signal,
            );
            signal.throwIfAborted();
            L.debug("syncRemoteMessages$ listEventsBefore result", {
              threadId,
              beforeSeqId,
              gotCount: events.length,
            });

            const oldestInPage = events[0];
            if (oldestInPage !== undefined) {
              accumulatedEvents.push(...events);
              await set(writeIndexedDbChatEvents$, threadId, events, signal);
              signal.throwIfAborted();
              // Flush periodically so long backfills surface incrementally
              // (e.g. the history backfill progress bar) instead of appearing
              // only after every page has been fetched.
              if (
                accumulatedEvents.length - mergedEventCount >=
                HISTORY_BACKFILL_MERGE_BATCH_SIZE
              ) {
                mergeEvents(accumulatedEvents.slice(mergedEventCount));
                mergedEventCount = accumulatedEvents.length;
              }
            }

            // A thread's first event always carries seqId 1, so reaching it is
            // the only stop condition for walking history backwards. An empty
            // page leaves no usable cursor, which also ends the walk.
            if (
              oldestInPage === undefined ||
              oldestInPage.seqId <= FIRST_CHAT_EVENT_SEQ_ID
            ) {
              return;
            }

            beforeSeqId = oldestInPage.seqId;

            return syncEventsBefore();
          }
          await syncEventsBefore();
        }
      }
      signal.throwIfAborted();
      mergeEvents(accumulatedEvents.slice(mergedEventCount));
    },
  );
}

function createActiveGoalObjectiveComputed(
  rawEvents$: Computed<ChatEventProjectionEntry[]>,
): Computed<Promise<string | null>> {
  return computed((get): Promise<string | null> => {
    const raw = get(rawEvents$);
    return Promise.resolve(
      foldActiveChatGoalObjective(
        raw.map((entry) => {
          return entry.event;
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

function createInitializeIndexedDbEvents({
  artifactCardSignals,
  agentReferenceSignals,
  threadId,
  persistentEvents$,
  registerBodyBlocks,
}: {
  artifactCardSignals: ArtifactCardSignalsRegistry;
  agentReferenceSignals: AgentReferenceSignalsRegistry;
  threadId: string;
  persistentEvents$: PersistentChatEvents$;
  registerBodyBlocks: BodyBlocksRenderer;
}) {
  const initialized = Promise.withResolvers<void>();
  const mergeIndexedDbEvents$ = command(
    ({ set }, events: PersistedChatEvent[]): void => {
      const registeredEvents = events.map((event) => {
        return registerChatEvent(
          event,
          registerBodyBlocks,
          artifactCardSignals,
          agentReferenceSignals,
        );
      });
      set(persistentEvents$, (previous) => {
        return mergeRegisteredEvents([previous, registeredEvents]);
      });
    },
  );

  const initializeIndexedDbEvents$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const result = await settle(
        set(loadIndexedDbChatEvents$, threadId, signal),
        signal,
      );
      if (result.ok) {
        set(mergeIndexedDbEvents$, result.value);
      }
      initialized.resolve(undefined);
      if (!result.ok) {
        throw result.error;
      }
    },
  );

  return {
    indexedDbEventsInitialized$: computed(() => {
      return initialized.promise;
    }),
    initializeIndexedDbEvents$,
  };
}

function createMailDraftCardSignalsById(
  rawEvents$: Computed<ChatEventProjectionEntry[]>,
  mailDraftCardSignals: MailDraftCardSignalsRegistry,
): Computed<ReadonlyMap<string, MailDraftSignals>> {
  return computed((get) => {
    get(rawEvents$);
    return new Map(mailDraftCardSignals.entries());
  });
}

function createEventHistoryBackfillProgress(
  hasReachedOldestEvent$: Computed<boolean>,
  persistentEvents$: PersistentChatEvents$,
): Computed<Promise<number | null>> {
  // Approximate backfill progress from the loaded seqId range. The thread's
  // true max seqId is not exposed to the client, so the newest loaded event
  // stands in for it. The reached-oldest computed hides progress once the
  // first persistent seqId is 1. Null hides the loading skeleton.
  return computed((get): Promise<number | null> => {
    if (get(hasReachedOldestEvent$)) {
      return Promise.resolve(null);
    }
    const events = get(persistentEvents$);
    const first = events[0];
    const last = events.at(-1);
    if (first === undefined || last === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve(
      (last.event.seqId - first.event.seqId) / last.event.seqId,
    );
  });
}

function createBrowserLifecycleOptimisticEvents(
  threadId: string,
): BrowserLifecycleOptimisticEvents {
  return {
    append$: command(({ set }, { eventId, eventType }): void => {
      set(
        appendOptimisticChatEvent$,
        createOptimisticChatEventEntry({
          threadId,
          event: {
            id: eventId,
            threadId,
            eventType,
            content: null,
            createdAt: nowDate().toISOString(),
          },
        }),
      );
    }),
    remove$: command(({ set }, eventId): void => {
      set(removeOptimisticChatEvent$, { threadId, eventId });
    }),
  };
}

function createPagedEventResources(
  threadId: string,
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
) {
  const mailDraftCardSignals = createMailDraftCardSignalsRegistry(threadId);
  const browserSessionCardSignals = createBrowserSessionCardSignalsRegistry(
    threadId,
    createBrowserLifecycleOptimisticEvents(threadId),
  );
  const artifactCardSignals = createArtifactCardSignalsRegistry(
    previewImageUrlsByUrl$,
  );
  const agentReferenceSignals = createAgentReferenceSignalsRegistry();
  const bodyBlocksRenderer = createBodyBlocksRenderer({
    artifactCardSignals,
    connectorCardSignals: createConnectorCardSignalsRegistry(),
    customConnectorCardSignals: createCustomConnectorCardSignalsRegistry(),
    permissionCardSignals: createPermissionCardSignalsRegistry(),
    computerUseAuthorizationCardSignals:
      createComputerUseAuthorizationCardSignalsRegistry(),
    planUpgradeCardSignals: createPlanUpgradeCardSignalsRegistry(),
    mailDraftCardSignals,
    browserSessionCardSignals,
  });
  const registerBodyBlocks = bodyBlocksRenderer("register");
  return {
    agentReferenceSignals,
    artifactCardSignals,
    browserSessionCardSignals,
    mailDraftCardSignals,
    registerBodyBlocks,
    registerOptimisticEventResources(entry: OptimisticChatEventEntry): void {
      registerBodyBlocks(entry.parsedBodyBlocks);
      registerEventAttachments(entry.event, artifactCardSignals);
      registerEventAgentReferences(entry.event, agentReferenceSignals);
    },
    resolveBodyBlocks: bodyBlocksRenderer("resolve"),
  };
}

function createPagedEvents(
  threadId: string,
  dataSource: ChatThreadRemote,
  initialOptimisticEntries: readonly OptimisticChatEventEntry[],
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
  scroll: {
    threadScrollPosition$: Computed<ThreadScrollPosition | null>;
    requestScrollAfterRender$: Command<void, [ThreadScrollPosition | null]>;
  },
) {
  const {
    agentReferenceSignals,
    artifactCardSignals,
    browserSessionCardSignals,
    mailDraftCardSignals,
    registerBodyBlocks,
    registerOptimisticEventResources,
    resolveBodyBlocks,
  } = createPagedEventResources(threadId, previewImageUrlsByUrl$);

  for (const entry of initialOptimisticEntries) {
    registerOptimisticEventResources(entry);
  }
  const persistentChatEvents$ = state<RegisteredChatEvent[]>([]);
  const hasReachedOldestEvent$ = computed((get): boolean => {
    return (
      get(persistentChatEvents$)[0]?.event.seqId === FIRST_CHAT_EVENT_SEQ_ID
    );
  });
  const optimisticEvents$ = createOptimisticChatEventsForThread(threadId);
  const appendOptimisticEvent$ = command(
    ({ set }, input: OptimisticChatEventInput): void => {
      const entry = createOptimisticChatEventEntry(input);
      registerOptimisticEventResources(entry);
      set(appendOptimisticChatEvent$, entry);
    },
  );

  const rawEvents$ = createRawEventsComputed({
    persistentEvents$: persistentChatEvents$,
    optimisticEvents$,
    resolveBodyBlocks,
  });
  const sidebarAutoOpenCandidate$ =
    createThreadSidebarAutoOpenCandidate(rawEvents$);
  const historyBackfillProgress$ = createEventHistoryBackfillProgress(
    hasReachedOldestEvent$,
    persistentChatEvents$,
  );
  const semanticEvents$ = computed((get): SemanticChatEvent[] => {
    return semanticTranscriptEventsFromRaw(get(rawEvents$));
  });
  const eventRunIndicatorState$ = createEventRunIndicatorState(rawEvents$);
  const semanticSignals = createEventSemanticSignals(
    semanticEvents$,
    eventRunIndicatorState$,
  );
  const eventSync = createEventSyncSignals(semanticSignals.hasEvents$);

  // The thread's active goal, folded from lifecycle control events so the
  // composer reads it without polling a separate resource. Reads rawEvents$
  // because goal markers are control rows, not transcript rows.
  const activeGoalObjective$ = createActiveGoalObjectiveComputed(rawEvents$);

  const renderedGroups = createRenderedChatGroups(semanticEvents$);

  const mailDraftCardSignalsById$ = createMailDraftCardSignalsById(
    rawEvents$,
    mailDraftCardSignals,
  );
  const mergePersistentEvents$ = createMergePersistentEvents(
    threadId,
    persistentChatEvents$,
    registerBodyBlocks,
    artifactCardSignals,
    agentReferenceSignals,
  );
  const indexedDbEvents = createInitializeIndexedDbEvents({
    artifactCardSignals,
    agentReferenceSignals,
    threadId,
    persistentEvents$: persistentChatEvents$,
    registerBodyBlocks,
  });

  const latestEventSignals = createLatestEventSignals(rawEvents$);

  const runSyncRemoteEvents$ = createSyncRemoteEventsCommand({
    threadId,
    persistentEvents$: persistentChatEvents$,
    hasReachedOldestEvent$,
    mergePersistentEvents$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    requestScrollAfterRender$: scroll.requestScrollAfterRender$,
    dataSource,
  });
  const syncRemoteEvents$ = createTrackedEventSyncCommand(
    runSyncRemoteEvents$,
    eventSync.trackEventSync$,
  );

  return {
    ...indexedDbEvents,
    mergePersistentEvents$,
    ...latestEventSignals,
    appendOptimisticEvent$,
    ...semanticSignals,
    ...eventSync,
    ...renderedGroups,
    rawEvents$,
    sidebarAutoOpenCandidate$,
    historyBackfillProgress$,
    eventRunIndicatorState$,
    activeGoalObjective$,
    mailDraftCardSignalsById$,
    reloadMailDrafts$: mailDraftCardSignals.reload$,
    browserSessionSignals: browserSessionCardSignals.browser,
    subscribeBrowserSessions$: browserSessionCardSignals.subscribe$,
    artifactSignalsForUrl: (url: string): ArtifactSignals | undefined => {
      return artifactCardSignals.find(url);
    },
    agentReferenceSignalsForId: (agentId: string) => {
      return agentReferenceSignals.resolve(agentId);
    },
    syncRemoteEvents$,
  };
}

function createChatThreadEventPipeline({
  threadId,
  dataSource,
  initialOptimisticEntries,
  threadScrollPosition$,
  requestScrollAfterRender$,
  awayFromBottom$,
  previewImageUrlsByUrl$,
}: {
  threadId: string;
  dataSource: ChatThreadRemote;
  initialOptimisticEntries: readonly OptimisticChatEventEntry[];
  threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  requestScrollAfterRender$: Command<void, [ThreadScrollPosition | null]>;
  awayFromBottom$: Computed<boolean>;
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>;
}) {
  const pagedEvents = createPagedEvents(
    threadId,
    dataSource,
    initialOptimisticEntries,
    previewImageUrlsByUrl$,
    { threadScrollPosition$, requestScrollAfterRender$ },
  );
  const renderWindow = createChatRenderWindow({
    threadId,
    allRenderedChatGroups$: pagedEvents.allRenderedChatGroups$,
    threadScrollPosition$,
    awayFromBottom$,
  });

  const loadMoreRenderedChatGroups$ =
    createLoadMoreRenderedChatGroupsWithPrependScroll(
      threadScrollPosition$,
      requestScrollAfterRender$,
      renderWindow.loadMoreRenderedChatGroups$,
    );
  return {
    ...pagedEvents,
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

function createEventRunIndicatorState(
  rawEvents$: Computed<ChatEventProjectionEntry[]>,
) {
  return computed((get): Promise<RunIndicatorState> => {
    const raw = get(rawEvents$);
    return Promise.resolve(deriveRunIndicatorStateFromRawEvents(raw));
  });
}

function createLoadMoreRenderedChatGroupsWithPrependScroll(
  threadScrollPosition$: Computed<ThreadScrollPosition | null>,
  requestScrollAfterRender$: Command<void, [ThreadScrollPosition | null]>,
  loadMoreRenderedChatGroups$: Command<Promise<boolean>, [AbortSignal]>,
) {
  return command(async ({ get, set }, signal: AbortSignal) => {
    const scrollPosition = get(threadScrollPosition$);
    const didPrepend = await set(loadMoreRenderedChatGroups$, signal);
    signal.throwIfAborted();
    if (didPrepend) {
      set(requestScrollAfterRender$, scrollPosition);
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
  initializeIndexedDbEvents$: Command<Promise<void>, [AbortSignal]>;
  mergePersistentEvents$: Command<void, [PersistedChatEvent[]]>;
  syncRemoteEvents$: Command<Promise<void>, [AbortSignal]>;
  settleEventSync$: Command<Promise<void>, []>;
  reloadArtifacts$: Command<void, []>;
  reloadMailDrafts$: Command<void, []>;
  subscribeBrowserSessions$: Command<Promise<void>, [AbortSignal]>;
  reloadComposerWorkflows$: Command<Promise<void>, [AbortSignal]>;
  threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  requestScrollAfterRender$: Command<void, [ThreadScrollPosition | null]>;
  automationSignals: Pick<ChatThreadSignals, "headerAutomations">;
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
  groups: readonly ChatEventGroup[],
  cursorGroupId: string | null,
): number {
  return runGroupVisualWindowStartIndex(
    groups,
    cursorGroupId,
    INITIAL_RENDER_GROUP_COUNT,
  );
}

function previousRenderWindowStartIndex(
  groups: readonly ChatEventGroup[],
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

function scrollTargetStartIndex(
  groups: readonly ChatEventGroup[],
  targetEventId: string | null,
): number | null {
  if (targetEventId === null) {
    return null;
  }
  const targetGroupIndex = groups.findIndex((group) => {
    return group.events.some((event) => {
      return event.id === targetEventId;
    });
  });
  if (targetGroupIndex === -1) {
    return null;
  }
  const targetRunId = groups[targetGroupIndex]?.events.find((event) => {
    return event.id === targetEventId;
  })?.runId;
  if (targetRunId === undefined) {
    return targetGroupIndex;
  }
  let startIndex = targetGroupIndex;
  while (
    startIndex > 0 &&
    groups[startIndex - 1]?.events.some((event) => {
      return event.runId === targetRunId;
    })
  ) {
    startIndex--;
  }
  return startIndex;
}

function createChatRenderWindow({
  threadId,
  allRenderedChatGroups$,
  threadScrollPosition$,
  awayFromBottom$,
}: {
  threadId: string;
  allRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  awayFromBottom$: Computed<boolean>;
}) {
  const visibleRenderedChatGroups$ = computed(
    async (get): Promise<ChatEventGroup[]> => {
      const groups = await get(allRenderedChatGroups$);
      const { cursorGroupId } = renderWindowStateForThread(
        get(renderWindowStateByThreadId$),
        threadId,
      );
      const requestedStartIndex = renderWindowStartIndex(groups, cursorGroupId);
      const targetStartIndex = scrollTargetStartIndex(
        groups,
        get(threadScrollPosition$)?.targetEventId ?? null,
      );
      return groups.slice(
        targetStartIndex === null
          ? requestedStartIndex
          : Math.min(requestedStartIndex, targetStartIndex),
      );
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
      const requestedStartIndex = renderWindowStartIndex(
        groups,
        current.cursorGroupId,
      );
      const targetStartIndex = scrollTargetStartIndex(
        groups,
        get(threadScrollPosition$)?.targetEventId ?? null,
      );
      const startIndex =
        targetStartIndex === null
          ? requestedStartIndex
          : Math.min(requestedStartIndex, targetStartIndex);
      const nextStartIndex = previousRenderWindowStartIndex(groups, startIndex);
      if (nextStartIndex === startIndex) {
        return false;
      }
      set(renderWindowStateByThreadId$, (prev) => {
        return setThreadRenderWindowState(prev, threadId, {
          cursorGroupId: groups[nextStartIndex]?.beginEventId ?? null,
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
  syncRemoteEvents$,
  settleEventSync$,
  reloadArtifacts$,
  reloadMailDrafts$,
  reloadComposerWorkflows$,
  markThreadReadIfNeeded$,
}: Pick<
  RunTrackingDeps,
  | "threadId"
  | "syncRemoteEvents$"
  | "settleEventSync$"
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
        ? set(settleEventSync$)
        : set(syncRemoteEvents$, signal),
    ]);
    signal.throwIfAborted();
    await set(markThreadReadIfNeeded$, signal);
    signal.throwIfAborted();
    L.debug("subscribeChatThread$ catchup done", { threadId });
  });
}

function createReceiveSyncedEventsCommand({
  threadId,
  mergePersistentEvents$,
  markThreadReadIfNeeded$,
  threadScrollPosition$,
  requestScrollAfterRender$,
}: Pick<
  RunTrackingDeps,
  | "threadId"
  | "mergePersistentEvents$"
  | "threadScrollPosition$"
  | "requestScrollAfterRender$"
> & {
  markThreadReadIfNeeded$: Command<Promise<void>, [AbortSignal]>;
}): Command<Promise<void>, [PersistedChatEvent[], AbortSignal]> {
  return command(
    async (
      { get, set },
      events: PersistedChatEvent[],
      signal: AbortSignal,
    ): Promise<void> => {
      signal.throwIfAborted();
      L.debug("receiveSyncedEvents$ fired", {
        threadId,
        count: events.length,
      });
      const scrollPosition = get(threadScrollPosition$);
      set(mergePersistentEvents$, events);
      set(requestScrollAfterRender$, scrollPosition);
      await set(markThreadReadIfNeeded$, signal);
      signal.throwIfAborted();
    },
  );
}

function createRunTracking({
  threadId,
  latestRunFinishCreatedAt$,
  initializeIndexedDbEvents$,
  mergePersistentEvents$,
  syncRemoteEvents$,
  settleEventSync$,
  reloadArtifacts$,
  reloadMailDrafts$,
  subscribeBrowserSessions$,
  reloadComposerWorkflows$,
  threadScrollPosition$,
  requestScrollAfterRender$,
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
    mergePersistentEvents$,
    markThreadReadIfNeeded$,
    threadScrollPosition$,
    requestScrollAfterRender$,
  });

  const onSubscribed$ = createOnSubscribedCommand({
    threadId,
    syncRemoteEvents$,
    settleEventSync$,
    reloadArtifacts$,
    reloadMailDrafts$,
    reloadComposerWorkflows$,
    markThreadReadIfNeeded$,
  });

  const subscribeChatThread$ = command(async ({ set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ start", { threadId });
    await set(initializeIndexedDbEvents$, signal);
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
      set(subscribeBrowserSessions$, signal),
      set(
        dataSource.subscribeRealtime$,
        {
          threadId,
          handlers: {
            onAutomationsChanged$,
            onArtifactsChanged$,
            onWorkflowsChanged$,
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

function createSendOptimisticEventEntry({
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
}): OptimisticChatEventInput {
  return {
    threadId,
    optimisticUserMessageAssociation: "run",
    event: {
      id: clientEventId,
      threadId,
      eventType: "input.prompt",
      content: null,
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

function createAppendOptimisticSendEvent(
  appendOptimisticEvent$: Command<void, [OptimisticChatEventInput]>,
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
        appendOptimisticEvent$,
        createSendOptimisticEventEntry({
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

function createComposerSendButtonSignals(events: {
  allFinished$: Computed<Promise<boolean>>;
  lastAssistantCancelled$: Computed<Promise<boolean>>;
}) {
  const pendingSendCount$ = state(0);
  const composerSendButtonStatus$ = computed(
    async (get): Promise<ComposerSendButtonStatus> => {
      const sendPending = get(pendingSendCount$) > 0;
      const [allFinished, lastAssistantCancelled] = await Promise.all([
        get(events.allFinished$),
        get(events.lastAssistantCancelled$),
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
  threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  requestScrollAfterRender$: Command<void, [ThreadScrollPosition | null]>;
  syncRemoteEvents$: Command<Promise<void>, [AbortSignal]>;
  appendOptimisticEvent$: Command<void, [OptimisticChatEventInput]>;
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
    threadScrollPosition$,
    requestScrollAfterRender$,
    syncRemoteEvents$,
    appendOptimisticEvent$,
  } = deps;
  const appendOptimisticSendEvent$ = createAppendOptimisticSendEvent(
    appendOptimisticEvent$,
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
      const scrollPosition = get(threadScrollPosition$);
      set(appendOptimisticSendEvent$, {
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
      set(requestScrollAfterRender$, scrollPosition);
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
        await set(syncRemoteEvents$, signal);
        signal.throwIfAborted();
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
  threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  requestScrollAfterRender$: Command<void, [ThreadScrollPosition | null]>;
  appendOptimisticEvent$: Command<void, [OptimisticChatEventInput]>;
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
    threadScrollPosition$,
    requestScrollAfterRender$,
    appendOptimisticEvent$,
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
      const scrollPosition = get(threadScrollPosition$);
      set(touchOptimisticChatThreadSort$, {
        id: chatThreadSortEventId,
        threadId,
        agentId,
        createdAt: nowIso,
      });
      set(appendOptimisticEvent$, {
        threadId,
        optimisticUserMessageAssociation: "queue",
        event: {
          id: clientEventId,
          threadId,
          eventType: "input.prompt",
          content: null,
          attachFiles: result.attachments,
          generationTemplate,
          userMessage,
          createdAt: nowIso,
        },
      });
      set(requestScrollAfterRender$, scrollPosition);

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
  rawEvents$: Computed<ChatEventProjectionEntry[]>;
  draft: DraftSignals;
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  appendOptimisticEvent$: Command<void, [OptimisticChatEventInput]>;
  dataSource: ChatThreadRemote;
}

function createRecallMessage(deps: RecallMessageDeps) {
  const {
    threadId,
    agentId$,
    rawEvents$,
    draft,
    queueDraftSync$,
    appendOptimisticEvent$,
    dataSource,
  } = deps;

  return command(async ({ get, set }, eventId: string, signal: AbortSignal) => {
    const event = queuedEventsFromRaw(get(rawEvents$)).find((candidate) => {
      return candidate.id === eventId;
    });
    if (!event || event.eventType !== "input.prompt") {
      return;
    }
    const agentId = get(agentId$);
    if (!agentId) {
      return;
    }

    const clientEventId = crypto.randomUUID();
    set(appendOptimisticEvent$, {
      threadId,
      event: {
        id: clientEventId,
        threadId,
        eventType: "control.revoke",
        content: null,
        revokesEventId: event.id,
        createdAt: nowDate().toISOString(),
      },
    });
    const userMessage = event.userMessage;
    const templatePart = userMessage.parts.find((part) => {
      return part.type === "template";
    });
    const fileIds = new Set(
      userMessage.parts.flatMap((part) => {
        return part.type === "file" ? [part.fileId] : [];
      }),
    );
    set(draft.seed$, {
      content: messageDocumentToPrompt(userMessage) ?? "",
      userMessage,
      generationTemplate:
        templatePart?.type === "template" ? templatePart.template : undefined,
      attachments: (event.attachFiles ?? [])
        .filter((attachment) => {
          return fileIds.has(attachment.id);
        })
        .map(createRestoredAttachment),
    });

    await set(
      dataSource.recallEvent$,
      {
        threadId,
        agentId,
        revokesEventId: event.id,
        clientEventId,
      },
      signal,
    );
    signal.throwIfAborted();
    await set(queueDraftSync$, signal);
    signal.throwIfAborted();
  });
}

function createSkipAutomationEvent({
  threadId,
  agentId$,
  rawEvents$,
  appendOptimisticEvent$,
  dataSource,
}: RecallMessageDeps) {
  return command(
    async (
      { get, set },
      eventId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const event = queuedEventsFromRaw(get(rawEvents$)).find((candidate) => {
        return (
          candidate.id === eventId && candidate.eventType === "input.automation"
        );
      });
      const agentId = get(agentId$);
      if (!event || !agentId) {
        return;
      }

      const clientEventId = crypto.randomUUID();
      set(appendOptimisticEvent$, {
        threadId,
        event: {
          id: clientEventId,
          threadId,
          eventType: "control.revoke",
          content: null,
          revokesEventId: event.id,
          createdAt: nowDate().toISOString(),
        },
      });
      await set(
        dataSource.recallEvent$,
        {
          threadId,
          agentId,
          revokesEventId: event.id,
          clientEventId,
        },
        signal,
      );
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
  rawEvents$: Computed<ChatEventProjectionEntry[]>;
}

function createThreadMessageActions(deps: ThreadMessageActionsDeps) {
  return {
    ...createMessageCommands(deps),
    skipAutomationEvent$: createSkipAutomationEvent(deps),
    cancelRun$: createCancelRunWithQueuedRecall(deps),
  };
}

function createCancelRunWithQueuedRecall({
  threadId,
  agentId$,
  rawEvents$,
  appendOptimisticEvent$,
  dataSource,
}: {
  threadId: string;
  agentId$: Computed<string | null>;
  rawEvents$: Computed<ChatEventProjectionEntry[]>;
  appendOptimisticEvent$: Command<void, [OptimisticChatEventInput]>;
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

    const raw = get(rawEvents$);
    const queuedEvents = queuedEventsFromRaw(raw).filter((event) => {
      return event.eventType === "input.prompt";
    });

    const interruptRequests = cancellableRunIdsFromRawEvents(raw).map(
      (runId) => {
        const clientEventId = crypto.randomUUID();
        set(appendOptimisticEvent$, {
          threadId,
          event: {
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

    const recallRequests = queuedEvents.map((event) => {
      const clientEventId = crypto.randomUUID();
      set(appendOptimisticEvent$, {
        threadId,
        event: {
          id: clientEventId,
          threadId,
          eventType: "control.revoke",
          content: null,
          revokesEventId: event.id,
          createdAt: nowDate().toISOString(),
        },
      });
      return {
        threadId,
        agentId,
        revokesEventId: event.id,
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
  readonly eventId: string | undefined;
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
    eventId: undefined,
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

  const hardLines: ThinkingTypewriterLine[] = [];
  let startIndex = 0;

  for (let index = 0; index <= args.graphemes.length; index++) {
    const grapheme = args.graphemes[index]!;
    const isHardBreak =
      index === args.graphemes.length || grapheme === "\n" || grapheme === "\r";
    if (!isHardBreak) {
      continue;
    }

    const text = args.graphemes.slice(startIndex, index).join("");
    if (text.trim().length > 0) {
      hardLines.push({
        startIndex,
        endIndex: index,
        text,
      });
    }
    startIndex = index + 1;
  }

  if (!Number.isFinite(args.width) || args.width <= 0) {
    return hardLines;
  }

  const maxWidth = Math.max(1, args.width - THINKING_TYPEWRITER_WIDTH_GUARD_PX);
  const lines: ThinkingTypewriterLine[] = [];

  for (const hardLine of hardLines) {
    const wrappedLines: ThinkingTypewriterLine[] = [];
    let wrappedStartIndex = hardLine.startIndex;
    let current: string[] = [];
    let measurementFailed = false;

    for (let index = hardLine.startIndex; index < hardLine.endIndex; index++) {
      const grapheme = args.graphemes[index]!;
      const candidate = [...current, grapheme];
      const measured = args.measureText(candidate.join(""));
      if (measured === undefined) {
        measurementFailed = true;
        break;
      }

      if (measured <= maxWidth || current.length === 0) {
        current = candidate;
        continue;
      }

      wrappedLines.push({
        startIndex: wrappedStartIndex,
        endIndex: index,
        text: current.join(""),
      });
      wrappedStartIndex = index;
      current = [grapheme];
    }

    if (measurementFailed) {
      lines.push(hardLine);
      continue;
    }

    if (current.length > 0) {
      wrappedLines.push({
        startIndex: wrappedStartIndex,
        endIndex: hardLine.endIndex,
        text: current.join(""),
      });
    }
    lines.push(...wrappedLines);
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
  readonly eventId: string;
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
    args.currentFrame.eventId === args.eventId &&
    args.currentFrame.text === args.text &&
    args.currentFrame.width === width
      ? args.currentFrame
      : {
          ...emptyThinkingTypewriterFrame(),
          eventId: args.eventId,
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
  thinkingEventId$: Computed<Promise<string | null>>,
) {
  const blockColors = shuffleBlockColors();
  const blockColors$ = computed(() => {
    return blockColors;
  });
  const thinkingPhraseIndex = Math.floor(Math.random() * THINKING_PHRASE_COUNT);
  const thinkingPhrase$ = computed((get) => {
    get(locale$);
    return thinkingPhrase(thinkingPhraseIndex);
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
          const [thinkingText, thinkingEventId] = await Promise.all([
            get(thinkingText$),
            get(thinkingEventId$),
          ]);
          sig.throwIfAborted();

          const text = thinkingText?.trim() ?? "";
          if (!thinkingEventId || text.length === 0) {
            set(thinkingTypewriterFrame$, emptyThinkingTypewriterFrame());
            return true;
          }

          const width = thinkingLabelWidth(el);
          if (width <= 0 && !IN_VITEST) {
            return false;
          }
          const nextFrame = nextThinkingTypewriterFrame({
            eventId: thinkingEventId,
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

function publicChatThreadEventSignals(
  events: ReturnType<typeof createChatThreadEventPipeline>,
) {
  return {
    latestRunFinishCreatedAt$: events.latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$: events.latestAssistantTextCreatedAt$,
    visibleRenderedChatGroups$: events.visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$: events.visibleRenderedChatGroupsReady$,
    indexedDbEventsInitialized$: events.indexedDbEventsInitialized$,
    sidebarAutoOpenCandidate$: events.sidebarAutoOpenCandidate$,
    eventImageGroups$: events.eventImageGroups$,
    artifactSignalsForUrl: events.artifactSignalsForUrl,
    agentReferenceSignalsForId: events.agentReferenceSignalsForId,
    mailDraftCardSignalsById$: events.mailDraftCardSignalsById$,
    browserSessionSignals: events.browserSessionSignals,
    hasEvents$: events.hasEvents$,
    hasNewEvents$: events.hasNewEvents$,
    initialRemoteEventsReady$: events.initialRemoteEventsReady$,
    initialBrowserLifecycleAuthoritative$:
      events.initialBrowserLifecycleAuthoritative$,
    initialRemoteEventsComplete$: events.initialRemoteEventsComplete$,
    hasQueuedEvents$: events.hasQueuedEvents$,
    queuedEventItems$: events.queuedEventItems$,
    emptyQueuedEventItems$: events.emptyQueuedEventItems$,
    thinkingIndicatorMode$: events.thinkingIndicatorMode$,
    thinkingEventId$: events.thinkingEventId$,
    thinkingText$: events.thinkingText$,
    recommendedFollowupSource$: events.recommendedFollowupSource$,
    historyBackfillProgress$: events.historyBackfillProgress$,
    activeGoalObjective$: events.activeGoalObjective$,
    donePhrase$: events.donePhrase$,
    loadMoreRenderedChatGroups$: events.loadMoreRenderedChatGroups$,
    resetRenderedChatGroupsIfAtBottom$:
      events.resetRenderedChatGroupsIfAtBottom$,
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

function createScrollRenderRequestReady(
  pendingScrollRenderRequest$: Computed<ThreadScrollRenderRequest | null>,
  events: ReturnType<typeof createChatThreadEventPipeline>,
): Computed<Promise<ThreadScrollRenderRequest | null>> {
  return computed(async (get) => {
    const request = get(pendingScrollRenderRequest$);
    if (!request) {
      return null;
    }
    await Promise.all([
      get(events.visibleRenderedChatGroups$),
      get(events.thinkingIndicatorMode$),
      get(events.historyBackfillProgress$),
      get(events.hasEvents$),
      request.position === null ? Promise.resolve() : get(events.hasNewEvents$),
    ]);
    return get(pendingScrollRenderRequest$);
  });
}

export function createChatThreadSignals(
  threadId: string,
  draft: DraftSignals,
  dataSource: ChatThreadRemote = createRemoteChatThreadDataSource(threadId),
  options: {
    readonly initialOptimisticEntries?: readonly OptimisticChatEventEntry[];
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
  const scroll = createChatThreadScrollSignals(threadId);
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
  const events = createChatThreadEventPipeline({
    threadId,
    dataSource,
    initialOptimisticEntries,
    threadScrollPosition$: scroll.threadScrollPosition$,
    requestScrollAfterRender$: scroll.requestScrollAfterRender$,
    awayFromBottom$: scroll.awayFromBottom$,
    previewImageUrlsByUrl$,
  });
  const { queueDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft, dataSource);
  const composerSendButton = createComposerSendButtonSignals(events);
  const runTracking = createRunTracking({
    threadId,
    latestRunFinishCreatedAt$: events.latestRunFinishCreatedAt$,
    initializeIndexedDbEvents$: events.initializeIndexedDbEvents$,
    mergePersistentEvents$: events.mergePersistentEvents$,
    syncRemoteEvents$: events.syncRemoteEvents$,
    settleEventSync$: events.settleEventSync$,
    reloadArtifacts$: artifact.reloadArtifacts$,
    reloadMailDrafts$: events.reloadMailDrafts$,
    subscribeBrowserSessions$: events.subscribeBrowserSessions$,
    reloadComposerWorkflows$: composer.workflowComposer.reloadWorkflows$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    requestScrollAfterRender$: scroll.requestScrollAfterRender$,
    automationSignals: threadOwned,
    dataSource,
  });
  const messageActions = createThreadMessageActions({
    threadId,
    pendingSendCount$: composerSendButton.pendingSendCount$,
    agentId$: threadOwned.agentId$,
    modelSelectionForSend$,
    rawEvents$: events.rawEvents$,
    draft,
    queueDraftSync$,
    cancelDraftSync$,
    flushDraftClear$,
    threadScrollPosition$: scroll.threadScrollPosition$,
    requestScrollAfterRender$: scroll.requestScrollAfterRender$,
    syncRemoteEvents$: events.syncRemoteEvents$,
    appendOptimisticEvent$: events.appendOptimisticEvent$,
    dataSource,
  });
  const assistantErrorRecovery = createAssistantErrorRecoverySignals({
    visibleRenderedChatGroups$: events.visibleRenderedChatGroups$,
    selectedModel$: modelSelection.selectedModel$,
    sendMessage$: messageActions.sendMessage$,
  });
  const scrollRenderRequestReady$ = createScrollRenderRequestReady(
    scroll.pendingScrollRenderRequest$,
    events,
  );
  return {
    threadId,
    threadDraft$,
    threadMeta$,
    ...threadTitle,
    threadSettledInServer$,
    ...modelSelection,
    ...computerUseHostSelection,
    ...messageActions,
    ...assistantErrorRecovery,
    composerSendButtonStatus$: composerSendButton.composerSendButtonStatus$,
    ...scroll,
    scrollRenderRequestReady$,
    ...container,
    draft,
    ...composer,
    composerFileInput$,
    setComposerFileInput$,
    ...threadOwned,
    queueDraftSync$,
    ...publicChatThreadEventSignals(events),
    receiveSyncedEvents$: runTracking.receiveSyncedEvents$,
    subscribeChatThread$: runTracking.subscribeChatThread$,
    ...createThinkingIndicatorSignals(
      events.thinkingText$,
      events.thinkingEventId$,
    ),
    ...artifact,
  };
}
