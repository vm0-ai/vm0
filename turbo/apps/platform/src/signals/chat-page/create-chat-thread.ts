import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay, timeout } from "signal-timers";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { isSupportedRunModel } from "@vm0/api-contracts/contracts/model-providers";
import { IN_VITEST } from "../../env.ts";
import { i18n } from "../../i18n/index.ts";
import { onRef, onRejection, resetSignal, setLoop } from "../utils.ts";
import { createHeaderAutomationSignals } from "./header-automation-menu.ts";
import { createThreadSidebarSignals } from "./thread-sidebar.ts";
import {
  createThreadSidebarAutoOpenCandidate,
  threadSidebarAutoOpenCandidateKey,
} from "./thread-sidebar-auto-open.ts";
import { activeThreadSidebar$ } from "./thread-sidebar-coordinator.ts";
import { CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY } from "./chat-thread-sidebar-layout.ts";
import {
  createChatThreadScrollSignals,
  type ThreadScrollPosition,
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
import type {
  ChatEvent,
  OptimisticChatEvent,
  OptimisticUserMessageAssociation,
} from "./chat-event-types.ts";
import {
  chatEventDebugSummaries,
  chatEventTraceTime,
} from "./chat-event-debug.ts";
import {
  chatThreadArtifactsContract,
  type AttachFile,
  type GenerationTemplateRequest,
  type ChatEvent as PersistedChatEvent,
  type ChatPromptEvent,
  type ChatThreadArtifactRun,
  type UserMessageInputDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ZeroAgentResponse } from "@vm0/api-contracts/contracts/zero-agents";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  isChatRunTerminalEventType,
  revokedChatEventIds,
} from "@vm0/api-contracts/contracts/chat-events";

import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import { runOptionsFromModelProviderSelection } from "./model-selection-request.ts";
import { accept } from "../../lib/accept.ts";
import { zeroClient$ } from "../api-client.ts";
import { agentById } from "../agent.ts";
import {
  codexFastModeEnabled$,
  featureSwitch$,
  imageRecognitionAvailable$,
} from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { pinnedAgentIds$ } from "../zero-page/zero-pinned-agents.ts";
import {
  writeChatMessageToClipboard,
  type ChatClipboardPayload,
} from "../zero-page/clipboard.ts";
import type { EnrichedChatEvent, ChatEventGroup } from "./chat-event.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import {
  deriveRunIndicatorStateFromChatEvents,
  groupSemanticChatEvents,
  isGoalMarkerEvent,
  isGoalQueueEvent,
  isInterruptControlEvent,
  isInterruptedAssistantCancellation,
  isQueueMarkerEvent,
  isRecallControlEvent,
  isUsageEvent,
  liveRunIdsFromChatEvents,
  queuedEventsFromChatEvents,
  semanticChatEventsFromChatEvents,
  type RunIndicatorState,
  type SemanticChatEventState,
  type SemanticChatGroups as GenericSemanticChatGroups,
} from "./chat-event-state.ts";
import { logger } from "../log.ts";
import {
  createCancellationRecoverySignals,
  createRemoteChatThreadDraft,
  patchChatThreadComputerUseHost$,
  patchChatThreadDraft$,
  patchChatThreadModelSelection$,
  subscribeChatThreadRealtime$,
} from "./chat-thread-remote-signals.ts";
import { markChatThreadRead$ } from "./remote-chat-event-data-source.ts";
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
  type ConnectorCardSignalsRegistry,
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
  type ThreadMeta,
} from "./chat-thread-event-sourcing.ts";
import {
  previousRunGroupVisualWindowStartIndex,
  runGroupVisualWindowStartIndex,
} from "./run-group-folding.ts";
import {
  computerUseHosts$,
  selectedComputerUseHostId,
  subscribeComputerUseHostsChanged$,
} from "../zero-page/computer-use-hosts.ts";
import { isCodexFastModeAvailableForSelection } from "../zero-page/model-default-selection.ts";
import { personalModelProvider$ } from "../zero-page/model-first-personal-oauth.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "../zero-page/settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "../zero-page/settings/codex-device-auth.ts";
import type {
  MessageListSignals,
  ChatPanelSignals,
  EventImageGroupProjection,
  QueueMessageOptions,
  RecommendedFollowupSource,
  SendMessageOptions,
  ThinkingIndicatorMode,
} from "./chat-panel-signals.ts";
import { reloadMountedComposerWorkflows$ } from "../zero-page/tiptap-workflow-composer.ts";
import {
  createMailDraftCardSignalsRegistry,
  type MailDraftCardSignalsRegistry,
  type MailDraftSignals,
} from "./mail-draft.ts";
import {
  createBrowserSessionSignals,
  type BrowserLifecycleOptimisticEvents,
  type BrowserSessionSignals,
} from "./browser-session-block.ts";
import { createChatThreadContainerSignals } from "./chat-thread-container.ts";
import { createAssistantErrorRecoverySignals } from "./assistant-error-recovery.ts";
import {
  messageDocumentToPrompt,
  textToMessageDocument,
} from "../zero-page/user-message-document-codec.ts";
import { locale$ } from "../locale.ts";
import {
  createComposerSignals,
  type ComposerSignals,
  type ComposerSubmission,
} from "../zero-page/composer-signals.ts";
import {
  openChatThreadGoalDialog$,
  pauseChatThreadGoal$,
} from "./chat-goal.ts";
import { createChatThreadFeedbackSignals } from "./chat-thread-feedback.ts";
import { createChatThreadSharingSignals } from "./chat-thread-sharing.ts";
import type {
  ChatEventSignals,
  SendChatEventInput,
  SendChatEventResult,
} from "./chat-event-signals.ts";
import { registerChatEventChangeHandler$ } from "./chat-event-change-registry.ts";

const L = logger("ChatThread");

function isInputChatEvent(
  event: ChatEvent,
): event is Extract<
  ChatEvent,
  { eventType: "input.prompt" | "input.rejected" }
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

// ---------------------------------------------------------------------------
// Sub-factory: remote thread draft fetching
// ---------------------------------------------------------------------------

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
        patchChatThreadModelSelection$,
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
      if (!isSupportedRunModel(selectedModel)) {
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
          patchChatThreadComputerUseHost$,
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

  const agent$ = computed(async (get): Promise<ZeroAgentResponse> => {
    const agentId = get(agentId$);
    if (!agentId) {
      throw new Error("Chat thread requires an active agent");
    }
    return await get(agentById(agentId));
  });

  const agentDisplayName$ = computed(async (get): Promise<string | null> => {
    return (await get(agent$)).displayName ?? null;
  });

  const agentPinned$ = computed(async (get): Promise<boolean | null> => {
    const agentId = await get(agentId$);
    if (!agentId) {
      return null;
    }
    const ids = await get(pinnedAgentIds$);
    return ids.includes(agentId);
  });

  return { agent$, agentId$, agentDisplayName$, agentPinned$ };
}

function createThreadOwnedSignals(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  return {
    ...createAgentInfoSignals(threadMeta$),
    headerAutomations: createHeaderAutomationSignals(threadId),
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
  const resetCopiedSignal$ = resetSignal();

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
      const copiedSignal = set(resetCopiedSignal$, signal);
      set(internalCopiedId$, eventId);
      const clearCopiedId = () => {
        if (get(internalCopiedId$) === eventId) {
          set(internalCopiedId$, null);
        }
      };
      copiedSignal.addEventListener("abort", clearCopiedId, { once: true });
      timeout(
        () => {
          copiedSignal.removeEventListener("abort", clearCopiedId);
          clearCopiedId();
        },
        2000,
        { signal: copiedSignal },
      );
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

function createDraftSync(threadId: string, draft: DraftSignals) {
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
        patchChatThreadDraft$,
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
        patchChatThreadDraft$,
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
  readonly event: ChatEvent;
  readonly blocks: BodyRenderBlock[];
}

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
    if (part.type === "source" && part.kind === "agent") {
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
  threadId: string,
  event: ChatEvent,
  registerBodyBlocks: BodyBlocksRenderer,
  artifactCardSignals: ArtifactCardSignalsRegistry,
  agentReferenceSignals: AgentReferenceSignalsRegistry,
): RegisteredChatEvent {
  registerEventAttachments(event, artifactCardSignals);
  registerEventAgentReferences(event, agentReferenceSignals);
  const blocks = skipsEventBodyRendering(event)
    ? []
    : registerBodyBlocks(parseChatEventBodyBlocks(event, threadId));
  return { event, blocks };
}

interface ServerChatEventProjectionEntry {
  event: PersistedChatEvent;
  source: "server";
  blocks: BodyRenderBlock[];
  optimisticUserMessageAssociation?: never;
}

interface OptimisticChatEventProjectionEntry {
  event: OptimisticChatEvent;
  source: "optimistic";
  blocks: BodyRenderBlock[];
  optimisticUserMessageAssociation?: OptimisticUserMessageAssociation;
}

type ChatEventProjectionEntry =
  | ServerChatEventProjectionEntry
  | OptimisticChatEventProjectionEntry;

function isPersistedChatEvent(event: ChatEvent): event is PersistedChatEvent {
  return event.seqId !== undefined;
}

function createRawEventsComputed(
  registeredEvents$: State<RegisteredChatEvent[]>,
): Computed<ChatEventProjectionEntry[]> {
  return computed((get): ChatEventProjectionEntry[] => {
    return get(registeredEvents$).map((entry) => {
      const { event } = entry;
      if (isPersistedChatEvent(event)) {
        return { ...entry, event, source: "server" };
      }
      return {
        ...entry,
        event,
        source: "optimistic",
        optimisticUserMessageAssociation:
          event.optimisticUserMessageAssociation,
      };
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

interface SemanticChatEvent extends SemanticChatEventState {
  readonly blocks: BodyRenderBlock[];
}

type SemanticChatGroups = GenericSemanticChatGroups<SemanticChatEvent>;
type SemanticChatEventGroup = SemanticChatGroups["activeGroups"][number];

function semanticTranscriptEventsFromRaw(
  raw: readonly ChatEventProjectionEntry[],
  chatEvents: readonly ChatEvent[],
): SemanticChatEvent[] {
  const blocksByEventId = new Map(
    raw.map((entry) => {
      return [entry.event.id, entry.blocks] as const;
    }),
  );
  return semanticChatEventsFromChatEvents(chatEvents).map((entry) => {
    return {
      ...entry,
      blocks: blocksByEventId.get(entry.event.id) ?? [],
    };
  });
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
    thinkingIndicatorMode$,
    thinkingEventId$,
    thinkingText$,
    recommendedFollowupSource$,
    donePhrase$,
  };
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
  const revokedEventIds = revokedChatEventIds(
    raw.map((entry) => {
      return entry.event;
    }),
  );
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

/** Per-thread chat event sequences start at 1, so this marks the oldest event. */
const FIRST_CHAT_EVENT_SEQ_ID = 1;

interface BodyBlockRegistries {
  readonly artifactCardSignals: ArtifactCardSignalsRegistry;
  readonly connectorCardSignals: ConnectorCardSignalsRegistry;
  readonly permissionCardSignals: PermissionCardSignalsRegistry;
  readonly computerUseAuthorizationCardSignals: ComputerUseAuthorizationCardSignalsRegistry;
  readonly planUpgradeCardSignals: PlanUpgradeCardSignalsRegistry;
  readonly mailDraftCardSignals: ReturnType<
    typeof createMailDraftCardSignalsRegistry
  >;
  readonly browserSessionSignals: BrowserSessionSignals;
}

function createBodyBlocksRenderer({
  artifactCardSignals,
  connectorCardSignals,
  permissionCardSignals,
  computerUseAuthorizationCardSignals,
  planUpgradeCardSignals,
  mailDraftCardSignals,
  browserSessionSignals,
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
              signals: browserSessionSignals,
            };
          }
        }
        const exhaustive: never = block;
        return exhaustive;
      });
    };
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

function createEventHistoryBackfillPending(
  rawEvents$: Computed<ChatEventProjectionEntry[]>,
): Computed<boolean> {
  return computed((get): boolean => {
    const first = get(rawEvents$).find(isServerProjectionEntry);
    return first !== undefined && first.event.seqId !== FIRST_CHAT_EVENT_SEQ_ID;
  });
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

function createPagedEventResources(
  threadId: string,
  chatEvents$: Computed<ChatEvent[]>,
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>,
  browserLifecycleOptimisticEvents: BrowserLifecycleOptimisticEvents,
) {
  const mailDraftCardSignals = createMailDraftCardSignalsRegistry(threadId);
  const browserSessionSignals = createBrowserSessionSignals(
    threadId,
    browserLifecycleOptimisticEvents,
  );
  const artifactCardSignals = createArtifactCardSignalsRegistry(
    previewImageUrlsByUrl$,
  );
  const agentReferenceSignals = createAgentReferenceSignalsRegistry();
  const bodyBlocksRenderer = createBodyBlocksRenderer({
    artifactCardSignals,
    connectorCardSignals: createConnectorCardSignalsRegistry(),
    permissionCardSignals: createPermissionCardSignalsRegistry(),
    computerUseAuthorizationCardSignals:
      createComputerUseAuthorizationCardSignalsRegistry(),
    planUpgradeCardSignals: createPlanUpgradeCardSignalsRegistry(),
    mailDraftCardSignals,
    browserSessionSignals,
  });
  const registerBodyBlocks = bodyBlocksRenderer("register");
  const registeredEvents$ = state<RegisteredChatEvent[]>([]);
  const syncRegisteredEvents$ = command(
    ({ get, set }, signal: AbortSignal): void => {
      signal.throwIfAborted();
      const events = get(chatEvents$);
      set(registeredEvents$, (previous) => {
        const previousById = new Map(
          previous.map((entry) => {
            return [entry.event.id, entry] as const;
          }),
        );
        return events.map((event) => {
          const existing = previousById.get(event.id);
          if (existing?.event === event) {
            return existing;
          }
          return registerChatEvent(
            threadId,
            event,
            registerBodyBlocks,
            artifactCardSignals,
            agentReferenceSignals,
          );
        });
      });
    },
  );
  return {
    agentReferenceSignals,
    artifactCardSignals,
    mailDraftCardSignals,
    publicSignals: {
      browserSessionSignals,
      subscribeBrowserSessions$: browserSessionSignals.subscribe$,
      artifactSignalsForUrl: (url: string): ArtifactSignals | undefined => {
        return artifactCardSignals.find(url);
      },
      agentReferenceSignalsForId: (agentId: string) => {
        return agentReferenceSignals.resolve(agentId);
      },
    },
    registeredEvents$,
    syncRegisteredEvents$,
  };
}

interface BrowserLifecycleOptimisticEvent {
  readonly eventId: string;
  readonly eventType: "browser.open" | "browser.close";
}

function createPagedEventProjections({
  chatEvents$,
  registeredEvents$,
  mailDraftCardSignals,
}: {
  chatEvents$: Computed<ChatEvent[]>;
  registeredEvents$: State<RegisteredChatEvent[]>;
  mailDraftCardSignals: MailDraftCardSignalsRegistry;
}) {
  const rawEvents$ = createRawEventsComputed(registeredEvents$);
  const historyBackfillPending$ = createEventHistoryBackfillPending(rawEvents$);
  const semanticEvents$ = computed((get): SemanticChatEvent[] => {
    return semanticTranscriptEventsFromRaw(get(rawEvents$), get(chatEvents$));
  });
  const eventRunIndicatorState$ = createEventRunIndicatorState(chatEvents$);
  return {
    rawEvents$,
    chatEvents$,
    historyBackfillPending$,
    eventRunIndicatorState$,
    mailDraftCardSignalsById$: createMailDraftCardSignalsById(
      rawEvents$,
      mailDraftCardSignals,
    ),
    ...createLatestEventSignals(rawEvents$),
    ...createEventSemanticSignals(semanticEvents$, eventRunIndicatorState$),
    ...createRenderedChatGroups(semanticEvents$),
  };
}

interface MarkThreadReadDeps {
  threadId: string;
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  locallyMarkedReadAt$: State<string | undefined>;
}

function createMarkThreadReadIfNeeded({
  threadId,
  latestRunFinishCreatedAt$,
  locallyMarkedReadAt$,
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

    const newLastReadAt = await set(markChatThreadRead$, { threadId }, sig);
    sig.throwIfAborted();
    if (newLastReadAt !== null) {
      set(locallyMarkedReadAt$, newLastReadAt);
    }
    // No sidebar reload needed: markRead$ records an optimistic read mark
    // and applies the response's unread snapshot, so the unread dot clears
    // without refetching the thread list.
  });
}

function createEventChangeEffects(
  threadId: string,
  chatEvents: ChatEventSignals,
  projections: Pick<
    ReturnType<typeof createPagedEventProjections>,
    "rawEvents$" | "latestRunFinishCreatedAt$"
  >,
  syncRegisteredEvents$: Command<void, [AbortSignal]>,
) {
  const scroll = createChatThreadScrollSignals(threadId);
  const sidebar = createThreadSidebarSignals(threadId);
  const locallyMarkedReadAt$ = state<string | undefined>(undefined);
  const markThreadReadIfNeeded$ = createMarkThreadReadIfNeeded({
    threadId,
    latestRunFinishCreatedAt$: projections.latestRunFinishCreatedAt$,
    locallyMarkedReadAt$,
  });
  const sidebarAutoOpenCandidate$ = createThreadSidebarAutoOpenCandidate(
    projections.rawEvents$,
  );
  const autoOpenSidebar$ = command(
    ({ get, set }, signal: AbortSignal): void => {
      signal.throwIfAborted();
      if (
        typeof window === "undefined" ||
        !window.matchMedia(CHAT_THREAD_SIDEBAR_SPLIT_VIEW_MEDIA_QUERY).matches
      ) {
        return;
      }
      const candidate = get(sidebarAutoOpenCandidate$);
      if (
        !candidate ||
        get(sidebar.target$) !== null ||
        get(activeThreadSidebar$) !== null
      ) {
        return;
      }
      const candidateKey = threadSidebarAutoOpenCandidateKey(candidate);
      if (!set(sidebar.claimAutoOpenCandidate$, candidateKey)) {
        return;
      }
      set(sidebar.open$, { type: "browser" });
    },
  );
  const afterEventsChange$ = command(
    async ({ get, set }, signal: AbortSignal): Promise<void> => {
      const hasOptimisticUserMessage = get(
        chatEvents.hasOptimisticUserMessage$,
      );
      // Scroll events own the DOM-aware decision: reaching the tail clears the
      // held position there. An event batch can run while this thread's DOM is
      // empty or stale, so restoration must read only the position already
      // captured for the reader.
      const scrollPosition = hasOptimisticUserMessage
        ? null
        : get(scroll.threadScrollPosition$);
      L.debug("events change scroll decision", {
        traceTime: chatEventTraceTime(),
        threadId,
        hasOptimisticUserMessage,
        storedTargetEventId:
          get(scroll.threadScrollPosition$)?.targetEventId ?? null,
        targetEventId: scrollPosition?.targetEventId ?? null,
        eventTail: chatEventDebugSummaries(
          get(chatEvents.chatEvents$).slice(-10),
        ),
      });
      await Promise.all([
        set(syncRegisteredEvents$, signal),
        set(autoOpenSidebar$, signal),
        set(scroll.autoScroll$, scrollPosition, signal),
        set(markThreadReadIfNeeded$, signal),
      ]);
      signal.throwIfAborted();
    },
  );
  return { scroll, sidebar, afterEventsChange$ };
}

function createChatThreadMessagePipeline({
  threadId,
  chatEvents,
  previewImageUrlsByUrl$,
}: {
  threadId: string;
  chatEvents: ChatEventSignals;
  previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>;
}) {
  const browserLifecycleOptimisticEvents: BrowserLifecycleOptimisticEvents = {
    append$: command(
      async (
        { set },
        event: BrowserLifecycleOptimisticEvent,
        signal: AbortSignal,
      ): Promise<void> => {
        await set(
          chatEvents.sendEvent$,
          { kind: "browser-lifecycle", ...event },
          signal,
        );
      },
    ),
  };
  const resources = createPagedEventResources(
    threadId,
    chatEvents.chatEvents$,
    previewImageUrlsByUrl$,
    browserLifecycleOptimisticEvents,
  );
  const projections = createPagedEventProjections({
    chatEvents$: chatEvents.chatEvents$,
    registeredEvents$: resources.registeredEvents$,
    mailDraftCardSignals: resources.mailDraftCardSignals,
  });
  const effects = createEventChangeEffects(
    threadId,
    chatEvents,
    projections,
    resources.syncRegisteredEvents$,
  );
  const chatSkeletonVisible$ = computed((get): boolean => {
    return (
      !get(chatEvents.initialRemoteEventsResolved$) &&
      get(projections.rawEvents$).length === 0
    );
  });
  const setup$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(
        registerChatEventChangeHandler$,
        chatEvents.chatEvents$,
        effects.afterEventsChange$,
        signal,
      );
      set(resources.syncRegisteredEvents$, signal);
      set(effects.sidebar.enableEntryAnimations$);
      await set(chatEvents.setup$, signal);
      signal.throwIfAborted();
    },
  );
  const renderWindow = createChatRenderWindow({
    threadId,
    allRenderedChatGroups$: projections.allRenderedChatGroups$,
    threadScrollPosition$: effects.scroll.threadScrollPosition$,
    awayFromBottom$: effects.scroll.awayFromBottom$,
  });
  const assistantErrorRecovery = createAssistantErrorRecoverySignals({
    threadId,
    chatEvents,
    visibleRenderedChatGroups$: renderWindow.visibleRenderedChatGroups$,
  });

  const loadMoreRenderedChatGroups$ = command(
    async ({ set }, signal: AbortSignal): Promise<boolean> => {
      const scrollPosition = set(
        effects.scroll.readRenderedThreadScrollPosition$,
      );
      const didPrepend = await set(
        renderWindow.loadMoreRenderedChatGroups$,
        signal,
      );
      signal.throwIfAborted();
      if (didPrepend) {
        await set(effects.scroll.autoScroll$, scrollPosition, signal);
        signal.throwIfAborted();
      }
      return didPrepend;
    },
  );
  return {
    scroll: effects.scroll,
    sidebar: effects.sidebar,
    setup$,
    chatSkeletonVisible$,
    ...assistantErrorRecovery,
    ...projections,
    ...resources.publicSignals,
    ...renderWindow,
    loadMoreRenderedChatGroups$,
  };
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

function createEventRunIndicatorState(chatEvents$: Computed<ChatEvent[]>) {
  return computed((get): Promise<RunIndicatorState> => {
    return Promise.resolve(
      deriveRunIndicatorStateFromChatEvents(get(chatEvents$)),
    );
  });
}

// ---------------------------------------------------------------------------
// Factory: createRunTracking
// ---------------------------------------------------------------------------

interface RunTrackingDeps {
  threadId: string;
  setupChatEvents$: Command<Promise<void>, [AbortSignal]>;
  catchUpChatEvents$: Command<Promise<void>, [AbortSignal]>;
  reloadArtifacts$: Command<void, []>;
  subscribeBrowserSessions$: Command<Promise<void>, [AbortSignal]>;
  automationSignals: Pick<ChatPanelSignals, "headerAutomations">;
  cancellationRecovery: ReturnType<typeof createCancellationRecoverySignals>;
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

function createOnSubscribedCommand({
  threadId,
  catchUpChatEvents$,
  reloadArtifacts$,
  cancellationRecovery,
}: Pick<
  RunTrackingDeps,
  | "threadId"
  | "catchUpChatEvents$"
  | "reloadArtifacts$"
  | "cancellationRecovery"
>): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ catchup start", { threadId });
    set(cancellationRecovery.reload$);
    set(reloadArtifacts$);
    await Promise.all([
      get(cancellationRecovery.pending$),
      set(reloadMountedComposerWorkflows$, signal),
      set(catchUpChatEvents$, signal),
    ]);
    signal.throwIfAborted();
    L.debug("subscribeChatThread$ catchup done", { threadId });
  });
}

function createRunTracking({
  threadId,
  setupChatEvents$,
  catchUpChatEvents$,
  reloadArtifacts$,
  subscribeBrowserSessions$,
  automationSignals,
  cancellationRecovery,
}: RunTrackingDeps) {
  const onSubscribed$ = createOnSubscribedCommand({
    threadId,
    catchUpChatEvents$,
    reloadArtifacts$,
    cancellationRecovery,
  });

  const subscribeChatThread$ = command(async ({ set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ start", { threadId });
    await set(setupChatEvents$, signal);
    signal.throwIfAborted();

    const onThreadDetailChanged$ = command(({ set }) => {
      L.debug("onThreadDetailChanged$ fired", { threadId });
      set(cancellationRecovery.reload$);
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

    const onWorkflowsChanged$ = command(
      async ({ set }, signal: AbortSignal): Promise<boolean> => {
        L.debug("onWorkflowsChanged$ fired", { threadId });
        await set(reloadMountedComposerWorkflows$, signal);
        return false;
      },
    );

    await Promise.all([
      set(subscribeComputerUseHostsChanged$, signal),
      set(subscribeBrowserSessions$, signal),
      set(
        subscribeChatThreadRealtime$,
        {
          threadId,
          handlers: {
            onThreadDetailChanged$,
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

  return { subscribeChatThread$ };
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
}): UserMessageInputDocument {
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
): UserMessageInputDocument {
  return userMessageForSend({
    prompt: result.prompt,
    editorDocument: options.editorDocument,
    generationTemplate: options.generationTemplate,
    attachments: result.attachments,
  });
}

function sendRuntimeOptions(
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

interface SendMessageDeps {
  threadId: string;
  agentId$: Computed<string | null>;
  modelSelectionForSend$: Command<
    Promise<ModelProviderSelection | null>,
    [AbortSignal]
  >;
  draft: DraftSignals;
  cancelDraftSync$: Command<void, []>;
  flushDraftClear$: Command<Promise<void>, [AbortSignal]>;
  sendEvent$: Command<
    Promise<SendChatEventResult>,
    [SendChatEventInput, AbortSignal]
  >;
}

interface ValidatedSendMessageRequest {
  readonly prompt: string;
  readonly options: SendMessageOptions | undefined;
  readonly agentId: string;
  readonly modelSelection: ModelProviderSelection | null;
}

function createPerformSendMessage(deps: SendMessageDeps) {
  const { threadId, draft, cancelDraftSync$, flushDraftClear$, sendEvent$ } =
    deps;
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
                    get(imageRecognitionAvailable$),
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
      const { runOptions, realAgentInPreviewEnabled } = sendRuntimeOptions(
        get(featureSwitch$),
        request.modelSelection,
      );
      const [, sendResult] = await Promise.all([
        set(flushDraftClear$, signal),
        set(
          sendEvent$,
          {
            kind: "input",
            delivery: "run",
            agentId: request.agentId,
            prompt: result.prompt,
            hasTextContent: result.hasTextContent,
            attachFiles: result.attachFiles,
            attachments: result.attachments,
            generationTemplate,
            userMessage,
            ...(runOptions === undefined ? {} : { runOptions }),
            ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
            ...(request.options && "computerUseHostId" in request.options
              ? { computerUseHostId: request.options.computerUseHostId ?? null }
              : {}),
            ...(request.options && "cloudBrowserEnabled" in request.options
              ? {
                  cloudBrowserEnabled:
                    request.options.cloudBrowserEnabled ?? false,
                }
              : {}),
            ...(request.options?.revokesEventId === undefined
              ? {}
              : { revokesEventId: request.options.revokesEventId }),
          },
          signal,
        ),
      ]);
      signal.throwIfAborted();
      L.debug("sendMessage$ POST accepted", {
        threadId,
        runId: sendResult.runId,
      });
      return true;
    },
  );
}

function createSendMessage(deps: SendMessageDeps) {
  const { threadId, agentId$, modelSelectionForSend$ } = deps;
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
      return await set(
        performSendMessage$,
        {
          prompt,
          options,
          agentId,
          modelSelection,
        },
        signal,
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
  sendEvent$: Command<
    Promise<SendChatEventResult>,
    [SendChatEventInput, AbortSignal]
  >;
}

function createQueueMessage(deps: QueueMessageDeps) {
  const {
    threadId,
    agentId$,
    modelSelectionForSend$,
    draft,
    cancelDraftSync$,
    flushDraftClear$,
    sendEvent$,
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
            get(imageRecognitionAvailable$),
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

      const { runOptions, realAgentInPreviewEnabled } = sendRuntimeOptions(
        features,
        modelSelection,
      );
      await Promise.all([
        set(flushDraftClear$, signal),
        set(
          sendEvent$,
          {
            kind: "input",
            delivery: "queue",
            agentId,
            prompt: result.prompt,
            hasTextContent: result.hasTextContent,
            attachFiles: result.attachments,
            attachments: result.attachments,
            generationTemplate,
            userMessage,
            ...(runOptions === undefined ? {} : { runOptions }),
            ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
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
  chatEvents$: Computed<ChatEvent[]>;
  draft: DraftSignals;
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  sendEvent$: Command<
    Promise<SendChatEventResult>,
    [SendChatEventInput, AbortSignal]
  >;
}

function createRecallMessage(deps: RecallMessageDeps) {
  const { agentId$, chatEvents$, draft, queueDraftSync$, sendEvent$ } = deps;

  return command(async ({ get, set }, eventId: string, signal: AbortSignal) => {
    const event = queuedEventsFromChatEvents(get(chatEvents$)).find(
      (candidate) => {
        return candidate.id === eventId;
      },
    );
    if (!event || event.eventType !== "input.prompt") {
      return;
    }
    const agentId = get(agentId$);
    if (!agentId) {
      return;
    }

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
      sendEvent$,
      {
        kind: "revoke",
        agentId,
        revokesEventId: event.id,
      },
      signal,
    );
    signal.throwIfAborted();
    await set(queueDraftSync$, signal);
    signal.throwIfAborted();
  });
}

function createSkipAutomationEvent({
  agentId$,
  chatEvents$,
  sendEvent$,
}: RecallMessageDeps) {
  return command(
    async (
      { get, set },
      eventId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const event = queuedEventsFromChatEvents(get(chatEvents$)).find(
        (candidate) => {
          return (
            candidate.id === eventId &&
            candidate.eventType === "input.automation"
          );
        },
      );
      const agentId = get(agentId$);
      if (!event || !agentId) {
        return;
      }

      await set(
        sendEvent$,
        {
          kind: "revoke",
          agentId,
          revokesEventId: event.id,
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

function createThreadMessageActions(deps: MessageCommandsDeps) {
  return {
    ...createMessageCommands(deps),
    skipAutomationEvent$: createSkipAutomationEvent(deps),
    cancelRun$: createCancelRunWithQueuedRecall(deps),
  };
}

function createCancelRunWithQueuedRecall({
  threadId,
  agentId$,
  chatEvents$,
  sendEvent$,
}: {
  threadId: string;
  agentId$: Computed<string | null>;
  chatEvents$: Computed<ChatEvent[]>;
  sendEvent$: Command<
    Promise<SendChatEventResult>,
    [SendChatEventInput, AbortSignal]
  >;
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

    const chatEvents = get(chatEvents$);
    const queuedEvents = queuedEventsFromChatEvents(chatEvents).filter(
      (event) => {
        return event.eventType === "input.prompt";
      },
    );
    await Promise.all([
      ...liveRunIdsFromChatEvents(chatEvents).map((runId) => {
        return set(
          sendEvent$,
          {
            kind: "interrupt",
            agentId,
            interruptsRunId: runId,
          },
          signal,
        );
      }),
      ...queuedEvents.map((event) => {
        return set(
          sendEvent$,
          {
            kind: "revoke",
            agentId,
            revokesEventId: event.id,
          },
          signal,
        );
      }),
    ]);
    signal.throwIfAborted();
  });
}

// ---------------------------------------------------------------------------
// Sub-factory: thinking phrases
// ---------------------------------------------------------------------------

const THINKING_TYPEWRITER_INTERVAL_MS = IN_VITEST ? 10 : 100;
const THINKING_TYPEWRITER_CHUNK_HOLD_MS = 700;
const THINKING_TYPEWRITER_CHUNK_HOLD_TICKS = IN_VITEST
  ? 1
  : Math.ceil(
      THINKING_TYPEWRITER_CHUNK_HOLD_MS / THINKING_TYPEWRITER_INTERVAL_MS,
    );
/** Keep in sync with the opacity transition on the thinking label. */
const THINKING_TYPEWRITER_FADE_MS = 200;
const THINKING_TYPEWRITER_FADE_TICKS = IN_VITEST
  ? 1
  : Math.ceil(THINKING_TYPEWRITER_FADE_MS / THINKING_TYPEWRITER_INTERVAL_MS);
const THINKING_TYPEWRITER_WIDTH_GUARD_PX = 8;
/** Fallback glyph advance used only when text measurement is unavailable. */
const THINKING_TYPEWRITER_FALLBACK_GLYPH_PX = 14;
/** Clause terminators that always end a chunk. */
const THINKING_TYPEWRITER_BREAKS = "，、；：。！？…";
/** Clause terminators that only end a chunk when followed by a space. */
const THINKING_TYPEWRITER_SPACED_BREAKS = ",;:.!?";

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
  readonly fadeTicksRemaining: number;
  readonly fadingOut: boolean;
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
    fadeTicksRemaining: 0,
    fadingOut: false,
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
    lines.push(
      ...packThinkingClauses({
        graphemes: args.graphemes,
        line: hardLine,
        maxWidth,
        measureText: args.measureText,
      }),
    );
  }

  return lines.length > 0 ? lines : hardLines;
}

/**
 * Split a line at clause terminators. The terminator and any whitespace that
 * follows it stay with the clause they close, so the next clause never starts
 * with a stray space.
 */
function thinkingClauseSegments(
  graphemes: readonly string[],
  line: ThinkingTypewriterLine,
): ThinkingTypewriterLine[] {
  const segments: ThinkingTypewriterLine[] = [];
  let startIndex = line.startIndex;

  for (let index = line.startIndex; index < line.endIndex; index++) {
    const grapheme = graphemes[index]!;
    const next = index + 1 < line.endIndex ? graphemes[index + 1] : undefined;
    const breaksHere =
      THINKING_TYPEWRITER_BREAKS.includes(grapheme) ||
      (THINKING_TYPEWRITER_SPACED_BREAKS.includes(grapheme) &&
        (next === undefined || next.trim().length === 0));
    if (!breaksHere) {
      continue;
    }

    let endIndex = index + 1;
    while (
      endIndex < line.endIndex &&
      graphemes[endIndex]!.trim().length === 0
    ) {
      endIndex++;
    }
    segments.push({
      startIndex,
      endIndex,
      text: graphemes.slice(startIndex, endIndex).join(""),
    });
    startIndex = endIndex;
    index = endIndex - 1;
  }

  if (startIndex < line.endIndex) {
    segments.push({
      startIndex,
      endIndex: line.endIndex,
      text: graphemes.slice(startIndex, line.endIndex).join(""),
    });
  }

  return segments.length > 0 ? segments : [line];
}

/** Split a segment that is too wide to show at once, one grapheme at a time. */
function splitThinkingSegmentByWidth(args: {
  readonly graphemes: readonly string[];
  readonly segment: ThinkingTypewriterLine;
  readonly maxWidth: number;
  readonly measureText: (value: string) => number | undefined;
}): ThinkingTypewriterLine[] {
  const parts: ThinkingTypewriterLine[] = [];
  let startIndex = args.segment.startIndex;
  let current: string[] = [];

  for (
    let index = args.segment.startIndex;
    index < args.segment.endIndex;
    index++
  ) {
    const grapheme = args.graphemes[index]!;
    const candidate = [...current, grapheme];
    const measured = args.measureText(candidate.join(""));
    if (measured === undefined) {
      return [];
    }
    if (measured <= args.maxWidth || current.length === 0) {
      current = candidate;
      continue;
    }
    parts.push({
      startIndex,
      endIndex: index,
      text: current.join(""),
    });
    startIndex = index;
    current = [grapheme];
  }

  if (current.length > 0) {
    parts.push({
      startIndex,
      endIndex: args.segment.endIndex,
      text: current.join(""),
    });
  }
  return parts;
}

/** Last resort when the canvas measurer is unavailable: split by glyph count. */
function splitThinkingSegmentByCount(
  graphemes: readonly string[],
  segment: ThinkingTypewriterLine,
  maxGraphemes: number,
): ThinkingTypewriterLine[] {
  const parts: ThinkingTypewriterLine[] = [];
  for (
    let startIndex = segment.startIndex;
    startIndex < segment.endIndex;
    startIndex += maxGraphemes
  ) {
    const endIndex = Math.min(startIndex + maxGraphemes, segment.endIndex);
    parts.push({
      startIndex,
      endIndex,
      text: graphemes.slice(startIndex, endIndex).join(""),
    });
  }
  return parts;
}

/**
 * Greedily merge neighbouring clauses while they still fit the label, so every
 * emitted line is short enough to display whole and never has to scroll.
 */
function packThinkingClauses(args: {
  readonly graphemes: readonly string[];
  readonly line: ThinkingTypewriterLine;
  readonly maxWidth: number;
  readonly measureText: (value: string) => number | undefined;
}): ThinkingTypewriterLine[] {
  const segments = thinkingClauseSegments(args.graphemes, args.line);
  const lines: ThinkingTypewriterLine[] = [];
  let pending: ThinkingTypewriterLine | undefined;

  for (const segment of segments) {
    const merged: ThinkingTypewriterLine = pending
      ? {
          startIndex: pending.startIndex,
          endIndex: segment.endIndex,
          text: args.graphemes
            .slice(pending.startIndex, segment.endIndex)
            .join(""),
        }
      : segment;
    const mergedWidth = args.measureText(merged.text);
    if (mergedWidth !== undefined && mergedWidth <= args.maxWidth) {
      pending = merged;
      continue;
    }

    if (pending) {
      lines.push(pending);
      pending = undefined;
    }

    const segmentWidth = args.measureText(segment.text);
    if (segmentWidth !== undefined && segmentWidth <= args.maxWidth) {
      pending = segment;
      continue;
    }

    const byWidth =
      segmentWidth === undefined
        ? []
        : splitThinkingSegmentByWidth({
            graphemes: args.graphemes,
            segment,
            maxWidth: args.maxWidth,
            measureText: args.measureText,
          });
    lines.push(
      ...(byWidth.length > 0
        ? byWidth
        : splitThinkingSegmentByCount(
            args.graphemes,
            segment,
            Math.max(
              1,
              Math.floor(args.maxWidth / THINKING_TYPEWRITER_FALLBACK_GLYPH_PX),
            ),
          )),
    );
  }

  if (pending) {
    lines.push(pending);
  }
  return lines;
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

  // Fading out the finished chunk before the next one types in.
  if (currentFrame.fadeTicksRemaining > 0) {
    const fadeTicksRemaining = currentFrame.fadeTicksRemaining - 1;
    if (fadeTicksRemaining > 0 || !nextLine) {
      return {
        ...currentFrame,
        lineIndex,
        fadeTicksRemaining,
        fadingOut: fadeTicksRemaining > 0,
        displayedText: currentLine.text,
        complete: false,
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
      fadeTicksRemaining: 0,
      fadingOut: false,
      displayedText: graphemes
        .slice(nextLine.startIndex, nextCharIndex)
        .join(""),
      complete: false,
    };
  }

  // Holding on a fully typed chunk so it can be read before it is replaced.
  if (currentFrame.pauseTicksRemaining > 0) {
    const pauseTicksRemaining = currentFrame.pauseTicksRemaining - 1;
    const startFade = pauseTicksRemaining === 0 && nextLine !== undefined;
    return {
      ...currentFrame,
      lineIndex,
      pauseTicksRemaining,
      fadeTicksRemaining: startFade ? THINKING_TYPEWRITER_FADE_TICKS : 0,
      fadingOut: startFade,
      displayedText: currentLine.text,
      complete: false,
    };
  }

  if (currentFrame.charIndex >= currentLine.endIndex) {
    return {
      ...currentFrame,
      lineIndex,
      pauseTicksRemaining: nextLine ? THINKING_TYPEWRITER_CHUNK_HOLD_TICKS : 0,
      displayedText: currentLine.text,
      complete: !nextLine,
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
        ? THINKING_TYPEWRITER_CHUNK_HOLD_TICKS
        : 0,
    displayedText: graphemes
      .slice(currentLine.startIndex, nextCharIndex)
      .join(""),
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
  const thinkingTextFadingOut$ = computed((get): Promise<boolean> => {
    return Promise.resolve(get(thinkingTypewriterFrame$).fadingOut);
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
    thinkingTextFadingOut$,
    setThinkingIndicatorTextRef$,
  };
}

// ---------------------------------------------------------------------------
// Factory: createChatPanelSignals
// ---------------------------------------------------------------------------

function publicChatThreadEventSignals(events: MessageListSignals) {
  return {
    latestRunFinishCreatedAt$: events.latestRunFinishCreatedAt$,
    latestAssistantTextCreatedAt$: events.latestAssistantTextCreatedAt$,
    visibleRenderedChatGroups$: events.visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$: events.visibleRenderedChatGroupsReady$,
    chatSkeletonVisible$: events.chatSkeletonVisible$,
    assistantErrorRecovery$: events.assistantErrorRecovery$,
    retryAssistantError$: events.retryAssistantError$,
    resetCodexSubscriptionAndRetry$: events.resetCodexSubscriptionAndRetry$,
    eventImageGroups$: events.eventImageGroups$,
    artifactSignalsForUrl: events.artifactSignalsForUrl,
    agentReferenceSignalsForId: events.agentReferenceSignalsForId,
    mailDraftCardSignalsById$: events.mailDraftCardSignalsById$,
    browserSessionSignals: events.browserSessionSignals,
    hasEvents$: events.hasEvents$,
    thinkingIndicatorMode$: events.thinkingIndicatorMode$,
    thinkingEventId$: events.thinkingEventId$,
    thinkingText$: events.thinkingText$,
    recommendedFollowupSource$: events.recommendedFollowupSource$,
    historyBackfillPending$: events.historyBackfillPending$,
    donePhrase$: events.donePhrase$,
    loadMoreRenderedChatGroups$: events.loadMoreRenderedChatGroups$,
    resetRenderedChatGroupsIfAtBottom$:
      events.resetRenderedChatGroupsIfAtBottom$,
  };
}

interface CreateChatThreadComposerSignalsOptions {
  readonly chatEvents: ChatEventSignals;
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly draft: DraftSignals;
  readonly queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  readonly modelSelection: ReturnType<typeof createModelSelection>;
  readonly computerUseHostSelection: ReturnType<
    typeof createComputerUseHostSelection
  >;
  readonly messageActions: ReturnType<typeof createThreadMessageActions>;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
}

interface ChatThreadComposerContext {
  readonly threadMeta$: Computed<ThreadMeta | null>;
  readonly agent$: Computed<Promise<ZeroAgentResponse>>;
  readonly agentId$: Computed<string | null>;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
}

function createThreadSubmitMessageSignal(
  options: CreateChatThreadComposerSignalsOptions,
) {
  const { computerUseHostSelection, messageActions } = options;
  return command(
    async (
      { get, set },
      action: "send" | "queue",
      submission: ComposerSubmission,
      signal: AbortSignal,
    ): Promise<boolean> => {
      const explicit = get(computerUseHostSelection.computerUseHostIdExplicit$);
      const storedHostId = get(computerUseHostSelection.computerUseHostId$);
      const hosts = await get(computerUseHosts$);
      signal.throwIfAborted();
      const computerUseHostId = selectedComputerUseHostId(hosts, storedHostId);
      const cloudBrowserEnabled = get(
        computerUseHostSelection.cloudBrowserEnabled$,
      );
      const submitted =
        action === "queue"
          ? await set(
              messageActions.queueMessage$,
              submission.prompt,
              {
                computerUseHostId: explicit ? computerUseHostId : undefined,
                cloudBrowserEnabled: explicit ? cloudBrowserEnabled : undefined,
                generationTemplate: submission.generationTemplate,
                editorDocument: submission.editorDocument,
              },
              signal,
            )
          : await set(
              messageActions.sendMessage$,
              submission.prompt,
              {
                ...(explicit ? { computerUseHostId } : {}),
                ...(explicit ? { cloudBrowserEnabled } : {}),
                generationTemplate: submission.generationTemplate,
                editorDocument: submission.editorDocument,
              },
              signal,
            );
      if (submitted) {
        set(computerUseHostSelection.clearComputerUseHostIdOverride$);
      }
      return submitted;
    },
  );
}

function createThreadPendingActionSignals(
  options: CreateChatThreadComposerSignalsOptions,
) {
  const { messageActions } = options;
  const threadId = options.chatEvents.threadId;
  const removeQueuedMessage$ = command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<void> => {
      await set(messageActions.recallMessage$, eventId, signal);
    },
  );
  const removeWorkflowEvent$ = command(
    async ({ set }, eventId: string, signal: AbortSignal): Promise<void> => {
      await set(messageActions.skipAutomationEvent$, eventId, signal);
    },
  );
  const cancelActiveGoal$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      await set(pauseChatThreadGoal$, threadId, signal);
    },
  );
  const openActiveGoal$ = command(({ set }): void => {
    set(openChatThreadGoalDialog$, threadId);
  });
  return {
    removeQueuedMessage$,
    removeWorkflowEvent$,
    cancelActiveGoal$,
    openActiveGoal$,
  };
}

function createChatThreadComposerSignals(
  options: CreateChatThreadComposerSignalsOptions,
): ComposerSignals {
  const { modelSelection, computerUseHostSelection, messageActions } = options;
  const composerModelSelection$ = computed(
    async (get): Promise<ModelProviderSelection | null> => {
      const selectedModel = get(modelSelection.selectedModel$);
      if (!isSupportedRunModel(selectedModel)) {
        return null;
      }
      return (await get(modelSelection.codexFastModeActive$))
        ? { selectedModel, codexServiceTier: "fast" }
        : { selectedModel };
    },
  );
  return createComposerSignals({
    agent$: options.agent$,
    draft: {
      signals: options.draft,
      save$: options.queueDraftSync$,
    },
    chatEvents$: options.chatEvents.chatEvents$,
    threadId: options.chatEvents.threadId,
    singleLineOnMobile: true,
    modelSelection$: composerModelSelection$,
    selectedModelOauthAvailable$: modelSelection.selectedModelOauthAvailable$,
    setModelSelection$: modelSelection.setModelSelection$,
    configureSelectedModel$: modelSelection.configureSelectedModel$,
    computerUseHostId$: computerUseHostSelection.computerUseHostId$,
    cloudBrowserEnabled$: computerUseHostSelection.cloudBrowserEnabled$,
    setComputerUseHostId$: computerUseHostSelection.setComputerUseHostId$,
    setCloudBrowserEnabled$: computerUseHostSelection.setCloudBrowserEnabled$,
    submitMessage$: createThreadSubmitMessageSignal(options),
    cancelRun$: messageActions.cancelRun$,
    cancellationRecoveryPending$: options.cancellationRecoveryPending$,
    ...createThreadPendingActionSignals(options),
  });
}

function createThreadComposerSignalsWithContext(
  threadId: string,
  chatEvents: ChatEventSignals,
  context: ChatThreadComposerContext,
  draft: DraftSignals,
): ComposerSignals {
  const modelSelection = createModelSelection(threadId, context.threadMeta$);
  const modelSelectionForSend$ = createModelSelectionForSend(modelSelection);
  const computerUseHostSelection = createComputerUseHostSelection(
    threadId,
    context.threadMeta$,
  );
  const { queueDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft);
  const messageActions = createThreadMessageActions({
    threadId,
    agentId$: context.agentId$,
    modelSelectionForSend$,
    chatEvents$: chatEvents.chatEvents$,
    draft,
    queueDraftSync$,
    cancelDraftSync$,
    flushDraftClear$,
    sendEvent$: chatEvents.sendEvent$,
  });
  return createChatThreadComposerSignals({
    chatEvents,
    agent$: context.agent$,
    draft,
    queueDraftSync$,
    modelSelection,
    computerUseHostSelection,
    messageActions,
    cancellationRecoveryPending$: context.cancellationRecoveryPending$,
  });
}

/**
 * Creates the public composer signals for a chat thread.
 *
 * @public
 */
export function createThreadComposerSignals(
  threadId: string,
  chatEvents: ChatEventSignals,
): ComposerSignals {
  const threadMeta$ = createThreadMeta(threadId);
  const agent = createAgentInfoSignals(threadMeta$);
  const cancellationRecovery = createCancellationRecoverySignals(threadId);
  return createThreadComposerSignalsWithContext(
    threadId,
    chatEvents,
    {
      threadMeta$,
      agent$: agent.agent$,
      agentId$: agent.agentId$,
      cancellationRecoveryPending$: cancellationRecovery.pending$,
    },
    createDraftSignals(),
  );
}

function createChatPanelSignalsWithDraft(
  chatEvents: ChatEventSignals,
  draft: DraftSignals,
  signal: AbortSignal,
): ChatPanelSignals {
  const threadId = chatEvents.threadId;
  const lifecycleId = crypto.randomUUID();
  const artifact = createArtifacts(threadId);
  const threadDraft$ = createRemoteChatThreadDraft(threadId);
  const threadMeta$ = createThreadMeta(threadId);
  const threadTitle = createThreadTitleParts(threadMeta$);
  const threadSettledInServer$ = createThreadSettledInServer(threadId);
  const container = createChatThreadContainerSignals();
  const threadOwned = createThreadOwnedSignals(threadId, threadMeta$);
  const cancellationRecovery = createCancellationRecoverySignals(threadId);
  const composer = createThreadComposerSignalsWithContext(
    threadId,
    chatEvents,
    {
      threadMeta$,
      agent$: threadOwned.agent$,
      agentId$: threadOwned.agentId$,
      cancellationRecoveryPending$: cancellationRecovery.pending$,
    },
    draft,
  );
  const feedback = createChatThreadFeedbackSignals(threadId, composer.feedback);
  const messages: MessageListSignals = {
    ...createChatThreadMessagePipeline({
      threadId,
      chatEvents,
      previewImageUrlsByUrl$: createArtifactPreviewImageUrls(
        artifact.artifacts$,
      ),
    }),
    ...artifact,
  };
  const sharing = createChatThreadSharingSignals(threadId, messages.scroll);
  const runTracking = createRunTracking({
    threadId,
    setupChatEvents$: messages.setup$,
    catchUpChatEvents$: chatEvents.catchUp$,
    reloadArtifacts$: messages.reloadArtifacts$,
    subscribeBrowserSessions$: messages.subscribeBrowserSessions$,
    automationSignals: threadOwned,
    cancellationRecovery,
  });
  return {
    threadId,
    lifecycleId,
    signal,
    threadDraft$,
    threadMeta$,
    ...threadTitle,
    threadSettledInServer$,
    scrollContainerOnRef$: messages.scroll.scrollContainerOnRef$,
    scrollContentOnRef$: messages.scroll.scrollContentOnRef$,
    threadScrollPosition$: messages.scroll.threadScrollPosition$,
    awayFromBottom$: messages.scroll.awayFromBottom$,
    scrollTo$: messages.scroll.scrollTo$,
    scrollToTop$: messages.scroll.scrollToTop$,
    scrollToBottom$: messages.scroll.scrollToBottom$,
    ...container,
    composer,
    feedback,
    sharing,
    ...threadOwned,
    sidebar: messages.sidebar,
    ...publicChatThreadEventSignals(messages),
    subscribeChatThread$: runTracking.subscribeChatThread$,
    ...createThinkingIndicatorSignals(
      messages.thinkingText$,
      messages.thinkingEventId$,
    ),
    artifacts$: messages.artifacts$,
    reloadArtifacts$: messages.reloadArtifacts$,
  };
}

/**
 * Creates the public panel signals for a chat thread.
 *
 * @public
 */
export function createChatPanelSignals(
  chatEvents: ChatEventSignals,
  signal: AbortSignal,
): ChatPanelSignals {
  return createChatPanelSignalsWithDraft(
    chatEvents,
    createDraftSignals(),
    signal,
  );
}

export const createCachedChatPanelSignals$ = command(
  ({ set }, chatEvents: ChatEventSignals, signal: AbortSignal) => {
    const { draft, isNew } = set(ensureDraft$, chatEvents.threadId);
    return {
      thread: createChatPanelSignalsWithDraft(chatEvents, draft, signal),
      isNew,
    };
  },
);
