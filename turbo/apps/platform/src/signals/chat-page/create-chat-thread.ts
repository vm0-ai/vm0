import {
  command,
  computed,
  state,
  type Command,
  type Computed,
  type State,
} from "ccstate";
import { delay, timeout } from "signal-timers";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { isSupportedRunModel } from "@okouai/api-contracts/contracts/model-providers";
import { isVideoModelId } from "@okouai/api-contracts/contracts/video-models";
import {
  DEFAULT_IMAGE_MODEL,
  type ImageModel,
} from "@okouai/core/image-model-catalog";
import {
  DEFAULT_VIDEO_MODEL,
  type VideoModel,
} from "@okouai/core/video-model-catalog";
import { IN_VITEST } from "../../env.ts";
import { i18n } from "../../i18n/index.ts";
import { onRef, onRejection, resetSignal, setLoop, settle } from "../utils.ts";
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
  createThreadScrollPositionSignals,
  type ChatThreadScrollSignals,
  type ReadyScrollAfterRenderRequest,
  type ScrollAfterRenderRequest,
  type ThreadScrollPosition,
} from "./chat-thread-scroll.ts";
import {
  createDraftSignals,
  createRestoredAttachment,
  type DraftSignals,
} from "../okou-page/chat-draft.ts";
import { buildDraftPersistencePayload } from "../okou-page/draft-persistence.ts";
import {
  collectSuccessfulAttachmentInfos,
  prepareUserMessageFromDraft$,
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
  resolveChatEventRecommendedFollowups,
  type ChatRunOptionsRequest,
  type ChatRunVideoOptionsRequest,
  type GenerationTemplateRequest,
  type ChatEvent as PersistedChatEvent,
  type FeedbackNotePart,
  type ResolvedAttachFile,
  type ChatThreadArtifactRun,
  type UserMessageDocument,
  type UserMessageInputDocument,
  type UserMessagePart,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  chatEventCompatibilityRole,
  foldLatestChatUsageByRunId,
  isChatEventContentTextType,
  isChatRunTerminalEventType,
  revokedChatEventIds,
} from "@okouai/api-contracts/contracts/chat-events";

import type { ModelProviderSelection } from "../../views/okou-page/components/model-provider-picker.tsx";
import { runOptionsFromModelProviderSelection } from "./model-selection-request.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import {
  codexFastModeEnabled$,
  featureSwitch$,
} from "../external/feature-switch.ts";
import { orgModelPolicies$ } from "../external/org-model-policies.ts";
import { userModelPreference$ } from "../external/user-model-preference.ts";
import {
  writeChatMessageToClipboard,
  type ChatClipboardPayload,
} from "../okou-page/clipboard.ts";
import type {
  EnrichedChatEvent,
  ChatEventGroup,
  UserMessageFeedbackNoteRenderPart,
  UserMessageRenderDocument,
  UserMessageRenderPart,
} from "./chat-event.ts";
import { isCancelledRunEvent } from "./chat-run-lifecycle.ts";
import {
  deriveRunIndicatorStateFromChatEvents,
  groupSemanticChatEvents,
  isGoalMarkerEvent,
  isInterruptControlEvent,
  isInterruptedAssistantCancellation,
  isQueueMarkerEvent,
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
  patchChatThreadImageModel$,
  patchChatThreadModelSelection$,
  patchChatThreadVideoModel$,
  subscribeChatThreadRealtime$,
} from "./chat-thread-remote-signals.ts";
import { markChatThreadRead$ } from "./chat-thread-mark-read.ts";
import {
  cardSlotUrl,
  classifyChatAttachment,
  type CardDescriptorBlock,
} from "./parse-body-blocks.ts";
import {
  createMermaidDiagramRegistry,
  embedMermaidSignals,
  type MermaidDiagramRegistry,
} from "../mermaid-diagram.ts";
import {
  createImageLoadRegistry,
  embedImageLoadSignals,
  type ImageLoadRegistry,
} from "../image-load.ts";
import {
  chatEventTreeContent,
  chatEventTreePlan,
} from "./chat-event-body-blocks.ts";
import type { ChatActionContext } from "./chat-action-context.ts";
import type { Root } from "hast";
import { createPlainMarkdownTree } from "../../lib/markdown/plain-markdown.ts";
import {
  markdownCardKey,
  parseMarkdownTree,
} from "../../lib/markdown/pipeline.ts";
import type { MarkdownCardRef } from "./markdown-card-ref.ts";
import {
  createArtifactCardSignalsRegistry,
  type ArtifactCardSignalsRegistry,
} from "./artifact-card-signals.ts";
import { createAttachmentResourceUrlResolver } from "../attachment-resource-url.ts";
import {
  createAgentReferenceSignalsRegistry,
  type AgentReferenceSignalsRegistry,
} from "./agent-reference-signals.ts";
import { createConnectorCardSignalsRegistry } from "./connector-action-block.ts";
import { createConnectorAccountActionCardSignalsRegistry } from "./connector-account-action-block.ts";
import { createPermissionCardSignalsRegistry } from "./permission-card-signals.ts";
import { createBankingCardSignalsRegistry } from "./banking-action-block.ts";
import { createComputerUseAuthorizationCardSignalsRegistry } from "./computer-use-authorization-block.ts";
import { createPlanUpgradeCardSignalsRegistry } from "./plan-upgrade-block.ts";
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
import { selectedComputerUseHostId } from "../okou-page/computer-use-hosts.ts";
import { computerUseHostsFromWorker$ } from "../shared-database.ts";
import { isCodexFastModeAvailableForSelection } from "../okou-page/model-default-selection.ts";
import { personalModelProvider$ } from "../okou-page/model-first-personal-oauth.ts";
import { openClaudeCodeDeviceAuthDialogPersonal$ } from "../okou-page/settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialogPersonal$ } from "../okou-page/settings/codex-device-auth.ts";
import type {
  MessageListSignals,
  ChatPanelSignals,
  EventImageGroupProjection,
  QueueMessageOptions,
  RecommendedFollowupSource,
  SendMessageOptions,
  ThinkingIndicatorMode,
} from "./chat-panel-signals.ts";
import { reloadMountedComposerWorkflows$ } from "../okou-page/tiptap-workflow-composer.ts";
import {
  createMailDraftCardSignalsRegistry,
  type MailDraftCardSignalsRegistry,
} from "./mail-draft.ts";
import {
  createBrowserSessionSignals,
  type BrowserLifecycleOptimisticEvents,
} from "./browser-session-block.ts";
import { createChatThreadContainerSignals } from "./chat-thread-container.ts";
import { createAssistantErrorRecoverySignals } from "./assistant-error-recovery.ts";
import {
  messageDocumentToPrompt,
  textToMessageDocument,
} from "../okou-page/user-message-document-codec.ts";
import { locale$ } from "../locale.ts";
import {
  createComposerSignals,
  type ComposerSignals,
  type ComposerSubmission,
} from "../okou-page/composer-signals.ts";
import {
  openChatThreadGoalDialog$,
  pauseChatThreadGoal$,
} from "./chat-goal.ts";
import { createChatThreadFeedbackSignals } from "./chat-thread-feedback.ts";
import { createChatThreadSharingSignals } from "./chat-thread-sharing.ts";
import { createChatConversationLocatorSignals } from "./chat-conversation-locator.ts";
import type {
  ChatEventSignals,
  SendChatEventInput,
  SendChatEventResult,
  SendInputChatEvent,
} from "./chat-event-signals.ts";
import { registerChatEventChangeHandler$ } from "./chat-event-change-registry.ts";
import {
  canonicalUserMessageFileUrl,
  userMessageFileAttachments,
} from "./user-message-files.ts";
import type { ChatForwardContext } from "./chat-forward.ts";
import {
  createComposerConnectorSignals,
  type ComposerConnectorSignals,
} from "../okou-page/connectors.ts";

const L = logger("ChatThread");
const noOpComposerDraftSave$ = command(
  (_context, signal: AbortSignal): Promise<void> => {
    signal.throwIfAborted();
    return Promise.resolve();
  },
);

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
      const authArgs =
        status.status === "needs_reconnect"
          ? {
              mode: "reconnect" as const,
              modelProviderId: status.credentialId,
            }
          : { mode: "connect" as const };
      if (status.providerType === "claude-code-oauth-token") {
        await set(openClaudeCodeDeviceAuthDialogPersonal$, authArgs, signal);
        return;
      }
      await set(openCodexDeviceAuthDialogPersonal$, authArgs, signal);
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
// Sub-factory: composer video model pin
// ---------------------------------------------------------------------------

/**
 * Thread-level video model pin. `null` means the thread follows the member's
 * personal default, so it is a selectable state rather than the absence of one.
 */
function createVideoModelSelection(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  // Thread meta keeps the pin loose so a model that later leaves the catalog
  // still replays; the picker only offers catalog models, so narrow here.
  const selectedVideoModel$ = computed((get): VideoModel | null => {
    const selected = get(threadMeta$)?.selectedVideoModel ?? null;
    return selected !== null && isVideoModelId(selected) ? selected : null;
  });

  // Same three steps the API resolves a run's video model through, so the
  // composer's parameter panel offers what that run would accept.
  const effectiveVideoModel$ = computed(async (get): Promise<VideoModel> => {
    const pinned = get(selectedVideoModel$);
    if (pinned !== null) {
      return pinned;
    }
    // The member default is contract-typed to the catalog enum, unlike the
    // loose thread pin above, so it needs no narrowing of its own.
    return (
      (await get(userModelPreference$)).selectedVideoModel ??
      DEFAULT_VIDEO_MODEL
    );
  });

  const setVideoModelSelection$ = command(
    async ({ set }, value: VideoModel | null, signal: AbortSignal) => {
      await set(
        patchChatThreadVideoModel$,
        { threadId, videoModel: value },
        signal,
      );
      signal.throwIfAborted();
    },
  );

  return { selectedVideoModel$, effectiveVideoModel$, setVideoModelSelection$ };
}

// ---------------------------------------------------------------------------
// Sub-factory: composer image model pin
// ---------------------------------------------------------------------------

/**
 * Thread-level image model pin. `null` means the thread follows the member's
 * personal default, so the picker still resolves and displays an effective
 * model in that state.
 */
function createImageModelSelection(
  threadId: string,
  threadMeta$: Computed<ThreadMeta | null>,
) {
  const selectedImageModel$ = computed((get): ImageModel | null => {
    const selected = get(threadMeta$)?.selectedImageModel ?? null;
    return isImageModelId(selected) ? selected : null;
  });

  const effectiveImageModel$ = computed(async (get): Promise<ImageModel> => {
    const pinned = get(selectedImageModel$);
    if (pinned !== null) {
      return pinned;
    }
    return (
      (await get(userModelPreference$)).selectedImageModel ??
      DEFAULT_IMAGE_MODEL
    );
  });

  const setImageModelSelection$ = command(
    async ({ set }, value: ImageModel | null, signal: AbortSignal) => {
      await set(
        patchChatThreadImageModel$,
        { threadId, imageModel: value },
        signal,
      );
      signal.throwIfAborted();
    },
  );

  return { selectedImageModel$, effectiveImageModel$, setImageModelSelection$ };
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

function createThreadOwnedSignals(threadId: string) {
  return {
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
        const annotations = get(r.attachment.annotations$);
        const annotatedFileId = get(r.attachment.annotatedFileId$);
        return {
          id: r.info.id,
          url: r.info.url,
          filename: r.attachment.filename,
          contentType: r.info.contentType,
          size: r.attachment.size,
          ...(annotatedFileId ? { annotatedFileId } : {}),
          ...(annotations ? { annotations } : {}),
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
          draftVoice: null,
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
  const allChatGroups$ = computed((get): ChatEventGroup[] => {
    return groupEventsForDisplay(
      enrichedChatEventsFromSemantic(get(semanticEvents$)),
    );
  });

  const allRenderedChatGroups$ = computed((get): Promise<ChatEventGroup[]> => {
    return Promise.resolve(get(allChatGroups$));
  });
  const eventImageGroups$ = computed(
    async (get): Promise<EventImageGroupProjection[]> => {
      return (await get(allRenderedChatGroups$)).map((group) => {
        return {
          role: group.role,
          events: group.events.map((event) => {
            return {
              userMessage: isInputChatEvent(event)
                ? event.userMessage
                : undefined,
              tree: event.tree,
            };
          }),
        };
      });
    },
  );

  return {
    allChatGroups$,
    allRenderedChatGroups$,
    eventImageGroups$,
  };
}

interface RegisteredChatEvent {
  readonly event: ChatEvent;
  readonly userMessageRenderDocument: UserMessageRenderDocument | undefined;
}

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

const registerFeedbackNoteRenderPart$ = command(
  (
    { set },
    part: FeedbackNotePart,
    agentReferenceSignals: AgentReferenceSignalsRegistry,
  ): UserMessageFeedbackNoteRenderPart => {
    switch (part.type) {
      case "text": {
        return { type: "text", part };
      }
      case "chat_thread": {
        return { type: "chat_thread", part };
      }
      case "template": {
        return { type: "template", part };
      }
      case "agent": {
        return {
          type: part.type,
          part,
          signals: set(agentReferenceSignals.register$, part.agentId),
        };
      }
    }
  },
);

interface UserMessagePartRegistries {
  readonly artifactCardSignals: ArtifactCardSignalsRegistry;
  readonly agentReferenceSignals: AgentReferenceSignalsRegistry;
}

const registerUserMessageRenderPart$ = command(
  (
    { set },
    part: UserMessagePart,
    registries: UserMessagePartRegistries,
  ): UserMessageRenderPart => {
    const { artifactCardSignals, agentReferenceSignals } = registries;
    switch (part.type) {
      case "text": {
        return { type: "text", part };
      }
      case "chat_thread": {
        return { type: "chat_thread", part };
      }
      case "template": {
        return { type: "template", part };
      }
      case "automation": {
        return { type: "automation", part };
      }
      case "goal": {
        return { type: "goal", part };
      }
      case "model": {
        return { type: "model", part };
      }
      case "agent": {
        return {
          type: part.type,
          part,
          signals: set(agentReferenceSignals.register$, part.agentId),
        };
      }
      case "source": {
        return part.kind === "agent"
          ? {
              type: part.type,
              kind: "agent",
              part,
              signals: set(agentReferenceSignals.register$, part.agentId),
            }
          : { type: part.type, kind: "external", part };
      }
      case "file": {
        const renderFileId = part.annotatedFileId ?? part.fileId;
        const url = canonicalUserMessageFileUrl(renderFileId);
        const renderContentType = part.annotatedFileId
          ? "image/png"
          : part.contentType;
        return {
          type: part.type,
          part,
          signals: set(artifactCardSignals.register$, {
            filename: part.filenameSnapshot,
            url,
            kind: classifyChatAttachment({
              filename: part.filenameSnapshot,
              url,
              contentType: renderContentType,
            }),
          }),
        };
      }
      case "feedback": {
        return {
          type: part.type,
          part,
          note: part.note.map((notePart) => {
            return set(
              registerFeedbackNoteRenderPart$,
              notePart,
              agentReferenceSignals,
            );
          }),
        };
      }
    }
  },
);

function chatEventUserMessage(
  event: ChatEvent,
): UserMessageDocument | undefined {
  return "userMessage" in event ? event.userMessage : undefined;
}

const registerUserMessageRenderDocument$ = command(
  (
    { set },
    event: ChatEvent,
    registries: UserMessagePartRegistries,
  ): UserMessageRenderDocument | undefined => {
    const document = chatEventUserMessage(event);
    if (!document) {
      return undefined;
    }
    return {
      document,
      parts: document.parts.map((part) => {
        return set(registerUserMessageRenderPart$, part, registries);
      }),
    };
  },
);

interface ServerChatEventProjectionEntry {
  event: PersistedChatEvent;
  source: "server";
  userMessageRenderDocument: UserMessageRenderDocument | undefined;
  optimisticUserMessageAssociation?: never;
}

interface OptimisticChatEventProjectionEntry {
  event: OptimisticChatEvent;
  source: "optimistic";
  userMessageRenderDocument: UserMessageRenderDocument | undefined;
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

function enrichedChatEventsFromSemantic(
  entries: readonly SemanticChatEvent[],
): EnrichedChatEvent[] {
  return entries.map((entry) => {
    const { event, isQueued, userMessageRenderDocument } = entry;
    return {
      ...event,
      tree: entry.tree,
      richContentError: entry.richContentError,
      isQueued,
      userMessageRenderDocument,
    };
  });
}

interface SemanticChatEvent extends SemanticChatEventState {
  readonly tree: Root | undefined;
  readonly richContentError: boolean;
  readonly userMessageRenderDocument: UserMessageRenderDocument | undefined;
}

type SemanticChatGroups = GenericSemanticChatGroups<SemanticChatEvent>;
type SemanticChatEventGroup = SemanticChatGroups["activeGroups"][number];

function semanticTranscriptEventsFromRaw(
  raw: readonly ChatEventProjectionEntry[],
  chatEvents: readonly ChatEvent[],
  trees: ReadonlyMap<string, Root>,
  richContentErrors: ReadonlySet<string>,
): SemanticChatEvent[] {
  const renderDocumentByEventId = new Map(
    raw.map((entry) => {
      return [entry.event.id, entry.userMessageRenderDocument] as const;
    }),
  );
  return semanticChatEventsFromChatEvents(chatEvents).map((entry) => {
    return {
      ...entry,
      tree: trees.get(entry.event.id),
      richContentError: richContentErrors.has(entry.event.id),
      userMessageRenderDocument: renderDocumentByEventId.get(entry.event.id),
    };
  });
}

function isRenderableAssistantSemanticEvent(entry: SemanticChatEvent): boolean {
  const { event } = entry;
  return (
    chatEventCompatibilityRole(event.eventType) === "assistant" &&
    ((isChatEventContentTextType(event.eventType) && Boolean(event.content)) ||
      ("error" in event && Boolean(event.error)))
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
      if (event.eventType === "output.followups") {
        const followups = resolveChatEventRecommendedFollowups(event);
        if (followups.length > 0) {
          return { eventId: event.id, followups };
        }
        return null;
      }
      if (
        isChatEventContentTextType(event.eventType) &&
        event.content?.trim()
      ) {
        return null;
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
      isChatEventContentTextType(event.eventType) &&
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

function createArtifacts(threadId: string) {
  const internalArtifactsReload$ = state(0);
  const artifacts$ = computed(async (get): Promise<ChatThreadArtifactRun[]> => {
    get(internalArtifactsReload$);
    const client = get(apiClient$)(chatThreadArtifactsContract);
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

interface EventTreeRegistries {
  readonly chatActionContext: ChatActionContext;
  readonly artifactCardSignals: ArtifactCardSignalsRegistry;
  readonly connectorCardSignals: ReturnType<
    typeof createConnectorCardSignalsRegistry
  >;
  readonly connectorAccountActionCardSignals: ReturnType<
    typeof createConnectorAccountActionCardSignalsRegistry
  >;
  readonly permissionCardSignals: ReturnType<
    typeof createPermissionCardSignalsRegistry
  >;
  readonly bankingCardSignals: ReturnType<
    typeof createBankingCardSignalsRegistry
  >;
  readonly computerUseAuthorizationCardSignals: ReturnType<
    typeof createComputerUseAuthorizationCardSignalsRegistry
  >;
  readonly planUpgradeCardSignals: ReturnType<
    typeof createPlanUpgradeCardSignalsRegistry
  >;
  readonly mailDraftCardSignals: MailDraftCardSignalsRegistry;
  readonly browserSessionSignals: ReturnType<
    typeof createBrowserSessionSignals
  >;
  readonly mermaidDiagrams: MermaidDiagramRegistry;
  readonly imageLoads: ImageLoadRegistry;
}

function createCardRefRegistrar({
  chatActionContext,
  artifactCardSignals,
  connectorCardSignals,
  connectorAccountActionCardSignals,
  permissionCardSignals,
  bankingCardSignals,
  computerUseAuthorizationCardSignals,
  planUpgradeCardSignals,
  mailDraftCardSignals,
  browserSessionSignals,
}: EventTreeRegistries): Command<MarkdownCardRef, [CardDescriptorBlock]> {
  return command(
    ({ set }, descriptor: CardDescriptorBlock): MarkdownCardRef => {
      switch (descriptor.type) {
        case "artifact": {
          return {
            kind: descriptor.type,
            signals: set(artifactCardSignals.register$, descriptor.descriptor),
            threadId: chatActionContext.threadId,
          };
        }
        case "connector-action": {
          return {
            kind: descriptor.type,
            signals: set(connectorCardSignals.register$, descriptor.descriptor),
          };
        }
        case "connector-account-action": {
          return {
            kind: descriptor.type,
            signals: set(
              connectorAccountActionCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "permission-action": {
          return {
            kind: descriptor.type,
            signals: set(
              permissionCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "banking-action": {
          return {
            kind: descriptor.type,
            signals: set(bankingCardSignals.register$, descriptor.descriptor),
          };
        }
        case "unavailable-action": {
          return { kind: descriptor.type };
        }
        case "computer-use-authorization": {
          return {
            kind: descriptor.type,
            signals: set(
              computerUseAuthorizationCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "plan-upgrade": {
          return {
            kind: descriptor.type,
            signals: set(
              planUpgradeCardSignals.register$,
              descriptor.descriptor,
            ),
          };
        }
        case "mail-draft": {
          return {
            kind: descriptor.type,
            signals: set(mailDraftCardSignals.register$, descriptor.descriptor),
          };
        }
        case "browser-session": {
          return { kind: descriptor.type, signals: browserSessionSignals };
        }
      }
      const exhaustive: never = descriptor;
      return exhaustive;
    },
  );
}

interface EventTree {
  readonly content: string;
  readonly tree: Root | undefined;
  readonly error: boolean;
}

interface RichEventTreePlan {
  readonly eventId: string;
  readonly content: string;
  readonly treeSource: string;
  readonly descriptors: readonly CardDescriptorBlock[];
}

function planEventTreeUpdates(
  events: readonly ChatEvent[],
  current: ReadonlyMap<string, EventTree>,
  chatActionContext: ChatActionContext,
): {
  readonly next: Map<string, EventTree> | undefined;
  readonly richPlans: RichEventTreePlan[];
} {
  let next: Map<string, EventTree> | undefined;
  const richPlans: RichEventTreePlan[] = [];
  for (const event of events) {
    const content = chatEventTreeContent(event);
    if (content === null || current.get(event.id)?.content === content) {
      continue;
    }
    const plan = chatEventTreePlan(event, chatActionContext);
    if (plan === null) {
      continue;
    }
    const plainTree = createPlainMarkdownTree(plan.treeSource, {
      mathEnabled: false,
    });
    next ??= new Map(current);
    if (plainTree !== null) {
      next.set(event.id, {
        content: plan.content,
        tree: plainTree,
        error: false,
      });
      continue;
    }
    // A streaming event must stop showing its prior tree while the new rich
    // body loads. This pending identity also deduplicates concurrent ensures.
    next.set(event.id, {
      content: plan.content,
      tree: undefined,
      error: false,
    });
    richPlans.push({ eventId: event.id, ...plan });
  }
  return { next, richPlans };
}

function markPendingEventTreesFailed(
  current: ReadonlyMap<string, EventTree>,
  plans: readonly RichEventTreePlan[],
): Map<string, EventTree> | undefined {
  let failed: Map<string, EventTree> | undefined;
  for (const plan of plans) {
    const entry = current.get(plan.eventId);
    if (
      entry?.content === plan.content &&
      entry.tree === undefined &&
      !entry.error
    ) {
      failed ??= new Map(current);
      failed.set(plan.eventId, { ...entry, error: true });
    }
  }
  return failed;
}

function createEventTreeSignals(registries: EventTreeRegistries) {
  const { chatActionContext, mermaidDiagrams, imageLoads } = registries;

  const internalEventTrees$ = state<ReadonlyMap<string, EventTree>>(new Map());
  const eventTrees$ = computed((get): ReadonlyMap<string, Root> => {
    const trees = new Map<string, Root>();
    for (const [eventId, entry] of get(internalEventTrees$)) {
      if (entry.tree !== undefined) {
        trees.set(eventId, entry.tree);
      }
    }
    return trees;
  });
  const eventTreeErrors$ = computed((get): ReadonlySet<string> => {
    const errors = new Set<string>();
    for (const [eventId, entry] of get(internalEventTrees$)) {
      if (entry.error) {
        errors.add(eventId);
      }
    }
    return errors;
  });

  const registerCardRef$ = createCardRefRegistrar(registries);
  const parseRichEventTrees$ = command(
    async (
      { get, set },
      richPlans: readonly RichEventTreePlan[],
      signal: AbortSignal,
    ): Promise<void> => {
      // Keep parser failures on the promise consumed by `settle` below.
      await Promise.resolve();
      signal.throwIfAborted();
      const pending = get(internalEventTrees$);
      let parsed: Map<string, EventTree> | undefined;
      for (const plan of richPlans) {
        const pendingEntry = pending.get(plan.eventId);
        if (
          pendingEntry?.content !== plan.content ||
          pendingEntry.tree !== undefined ||
          pendingEntry.error
        ) {
          continue;
        }
        const cards = new Map<string, MarkdownCardRef>();
        for (const descriptor of plan.descriptors) {
          cards.set(
            markdownCardKey(cardSlotUrl(descriptor)),
            set(registerCardRef$, descriptor),
          );
        }
        const tree = parseMarkdownTree(plan.treeSource, {
          mermaid: true,
          cards,
        });
        embedMermaidSignals(tree, (code) => {
          return set(mermaidDiagrams.register$, code);
        });
        embedImageLoadSignals(tree, (url) => {
          return set(imageLoads.register$, url);
        });
        parsed ??= new Map(pending);
        parsed.set(plan.eventId, {
          content: plan.content,
          tree,
          error: false,
        });
      }
      signal.throwIfAborted();
      if (parsed) {
        set(internalEventTrees$, parsed);
      }
    },
  );

  /**
   * Parses the markdown tree of every listed event that has none yet, or whose
   * body changed since it was parsed. Cards register here, ahead of the parse
   * that resolves their slots. Runs after every write that can change the
   * visible window, including scroll captures, so the unchanged path costs a
   * content lookup per event, not a plan.
   */
  const ensureEventTrees$ = command(
    async (
      { get, set },
      events: readonly ChatEvent[],
      signal: AbortSignal,
    ): Promise<void> => {
      const current = get(internalEventTrees$);
      const { next, richPlans } = planEventTreeUpdates(
        events,
        current,
        chatActionContext,
      );
      if (next) {
        set(internalEventTrees$, next);
      }
      if (richPlans.length === 0) {
        return;
      }

      const result = await settle(
        set(parseRichEventTrees$, richPlans, signal),
        signal,
      );
      if (!result.ok) {
        const pending = get(internalEventTrees$);
        const failed = markPendingEventTreesFailed(pending, richPlans);
        if (failed) {
          set(internalEventTrees$, failed);
        }
      }
    },
  );

  const retryRichEventTree$ = command(
    async (
      { get, set },
      event: ChatEvent,
      signal: AbortSignal,
    ): Promise<void> => {
      const current = get(internalEventTrees$);
      const entry = current.get(event.id);
      const content = chatEventTreeContent(event);
      if (!entry?.error || content === null || entry.content !== content) {
        return;
      }
      const next = new Map(current);
      next.delete(event.id);
      set(internalEventTrees$, next);
      await set(ensureEventTrees$, [event], signal);
    },
  );

  return {
    eventTrees$,
    eventTreeErrors$,
    ensureEventTrees$,
    retryRichEventTree$,
  };
}

function createPagedEventResources(
  {
    chatActionContext,
    chatEvents$,
    previewImageUrlsByUrl$,
    browserLifecycleOptimisticEvents,
    connector,
  }: {
    readonly chatActionContext: ChatActionContext;
    readonly chatEvents$: Computed<ChatEvent[]>;
    readonly previewImageUrlsByUrl$: Computed<
      Promise<ReadonlyMap<string, string>>
    >;
    readonly browserLifecycleOptimisticEvents: BrowserLifecycleOptimisticEvents;
    readonly connector: ComposerConnectorSignals;
  },
  ownerSignal: AbortSignal,
) {
  const { threadId } = chatActionContext;
  const mailDraftCardSignals = createMailDraftCardSignalsRegistry(threadId);
  const browserSessionSignals = createBrowserSessionSignals(
    threadId,
    browserLifecycleOptimisticEvents,
  );
  const resolveAttachmentResourceUrl = createAttachmentResourceUrlResolver();
  const artifactCardSignals = createArtifactCardSignalsRegistry(
    previewImageUrlsByUrl$,
    resolveAttachmentResourceUrl,
  );
  const agentReferenceSignals = createAgentReferenceSignalsRegistry();
  const connectorCardSignals = createConnectorCardSignalsRegistry();
  const connectorAccountActionCardSignals =
    createConnectorAccountActionCardSignalsRegistry(connector);
  const permissionCardSignals = createPermissionCardSignalsRegistry();
  const bankingCardSignals = createBankingCardSignalsRegistry();
  const computerUseAuthorizationCardSignals =
    createComputerUseAuthorizationCardSignalsRegistry();
  const planUpgradeCardSignals = createPlanUpgradeCardSignalsRegistry();
  const mermaidDiagrams = createMermaidDiagramRegistry(ownerSignal);
  const imageLoads = createImageLoadRegistry();

  const registerChatEvent$ = command(
    ({ set }, event: ChatEvent): RegisteredChatEvent => {
      return {
        event,
        userMessageRenderDocument: set(
          registerUserMessageRenderDocument$,
          event,
          {
            artifactCardSignals,
            agentReferenceSignals,
          },
        ),
      };
    },
  );

  const {
    eventTrees$,
    eventTreeErrors$,
    ensureEventTrees$,
    retryRichEventTree$,
  } = createEventTreeSignals({
    chatActionContext,
    artifactCardSignals,
    connectorCardSignals,
    connectorAccountActionCardSignals,
    permissionCardSignals,
    bankingCardSignals,
    computerUseAuthorizationCardSignals,
    planUpgradeCardSignals,
    mailDraftCardSignals,
    browserSessionSignals,
    mermaidDiagrams,
    imageLoads,
  });

  const registeredEvents$ = state<RegisteredChatEvent[]>([]);
  // Tree parsing is not part of the sync: the render window decides which
  // events need trees, so the ensure step runs at the window's write points.
  const syncRegisteredEvents$ = command(
    ({ get, set }, signal: AbortSignal): void => {
      signal.throwIfAborted();
      const events = get(chatEvents$);
      const previousById = new Map(
        get(registeredEvents$).map((entry) => {
          return [entry.event.id, entry] as const;
        }),
      );
      const next = events.map((event) => {
        const existing = previousById.get(event.id);
        if (existing?.event === event) {
          return existing;
        }
        return set(registerChatEvent$, event);
      });
      set(registeredEvents$, next);
    },
  );
  return {
    artifactCardSignals,
    eventTrees$,
    eventTreeErrors$,
    ensureEventTrees$,
    publicSignals: {
      browserSessionSignals,
      subscribeBrowserSessions$: browserSessionSignals.subscribe$,
      retryRichEventTree$,
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
  eventTrees$,
  eventTreeErrors$,
}: {
  chatEvents$: Computed<ChatEvent[]>;
  registeredEvents$: State<RegisteredChatEvent[]>;
  eventTrees$: Computed<ReadonlyMap<string, Root>>;
  eventTreeErrors$: Computed<ReadonlySet<string>>;
}) {
  const rawEvents$ = createRawEventsComputed(registeredEvents$);
  const semanticEvents$ = computed((get): SemanticChatEvent[] => {
    return semanticTranscriptEventsFromRaw(
      get(rawEvents$),
      get(chatEvents$),
      get(eventTrees$),
      get(eventTreeErrors$),
    );
  });
  const eventRunIndicatorState$ = createEventRunIndicatorState(chatEvents$);
  return {
    rawEvents$,
    chatEvents$,
    eventRunIndicatorState$,
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
  {
    threadId,
    chatEvents,
    projections,
    scroll,
    syncVisibleEventTrees$,
  }: {
    readonly threadId: string;
    readonly chatEvents: ChatEventSignals;
    readonly projections: Pick<
      ReturnType<typeof createPagedEventProjections>,
      "rawEvents$" | "latestRunFinishCreatedAt$"
    >;
    readonly scroll: ChatThreadScrollSignals;
    readonly syncVisibleEventTrees$: Command<
      Promise<void>,
      [boolean, AbortSignal]
    >;
  },
  ownerSignal: AbortSignal,
) {
  const sidebar = createThreadSidebarSignals(threadId, ownerSignal);
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
  const updateEventPresentation$ = command(
    async (
      { set },
      scrollPosition: ThreadScrollPosition | null,
      signal: AbortSignal,
    ): Promise<void> => {
      const eventTreesReady = set(syncVisibleEventTrees$, true, signal);
      await Promise.all([eventTreesReady, set(autoOpenSidebar$, signal)]);
      signal.throwIfAborted();
      await set(scroll.autoScroll$, scrollPosition, signal);
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
        set(updateEventPresentation$, scrollPosition, signal),
        set(markThreadReadIfNeeded$, signal),
      ]);
      signal.throwIfAborted();
    },
  );
  return { sidebar, afterEventsChange$ };
}

function createChatEventPresentationLifecycle({
  chatEvents,
  afterEventsChange$,
  syncVisibleEventTrees$,
  enableSidebarEntryAnimations$,
  initialEventsReady$,
}: {
  readonly chatEvents: ChatEventSignals;
  readonly afterEventsChange$: Command<Promise<void>, [AbortSignal]>;
  readonly syncVisibleEventTrees$: Command<
    Promise<void>,
    [boolean, AbortSignal]
  >;
  readonly enableSidebarEntryAnimations$: Command<void, []>;
  readonly initialEventsReady$: State<boolean>;
}) {
  const setup$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      set(
        registerChatEventChangeHandler$,
        chatEvents.chatEvents$,
        afterEventsChange$,
        signal,
      );
      await set(syncVisibleEventTrees$, false, signal);
      set(enableSidebarEntryAnimations$);
      const result = await settle(set(chatEvents.setup$, signal), signal);
      if (!result.ok) {
        set(initialEventsReady$, true);
        throw result.error;
      }
    },
  );
  const catchUp$ = command(
    async ({ set }, signal: AbortSignal): Promise<void> => {
      const result = await settle(set(chatEvents.catchUp$, signal), signal);
      set(initialEventsReady$, true);
      if (!result.ok) {
        throw result.error;
      }
    },
  );
  return { setup$, catchUp$ };
}

function createReadyScrollAfterRenderRequest(
  pendingScrollAfterRenderRequest$: Computed<ScrollAfterRenderRequest | null>,
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>,
): Computed<Promise<ReadyScrollAfterRenderRequest | null>> {
  return computed(async (get) => {
    const request = get(pendingScrollAfterRenderRequest$);
    if (request === null) {
      return null;
    }
    const renderedGroups = await get(visibleRenderedChatGroups$);
    const currentRequest = get(pendingScrollAfterRenderRequest$);
    if (currentRequest?.revision !== request.revision) {
      return null;
    }
    return {
      request,
      renderedEventKeys: renderedGroups.flatMap((group) => {
        return group.events.map((event) => {
          return `${event.id}:${event.isQueued ? "queued" : "active"}`;
        });
      }),
    };
  });
}

function createBrowserLifecycleOptimisticEvents(
  chatEvents: ChatEventSignals,
): BrowserLifecycleOptimisticEvents {
  return {
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
}

function createChatThreadMessagePipeline(
  {
    chatActionContext,
    chatEvents,
    previewImageUrlsByUrl$,
    connector,
  }: {
    chatActionContext: ChatActionContext;
    chatEvents: ChatEventSignals;
    previewImageUrlsByUrl$: Computed<Promise<ReadonlyMap<string, string>>>;
    connector: ComposerConnectorSignals;
  },
  ownerSignal: AbortSignal,
) {
  const { threadId } = chatActionContext;
  const browserLifecycleOptimisticEvents =
    createBrowserLifecycleOptimisticEvents(chatEvents);
  // Position is created before scroll writers are wired to the render window.
  const position = createThreadScrollPositionSignals(threadId);
  const resources = createPagedEventResources(
    {
      chatActionContext,
      chatEvents$: chatEvents.chatEvents$,
      previewImageUrlsByUrl$,
      browserLifecycleOptimisticEvents,
      connector,
    },
    ownerSignal,
  );
  const projections = createPagedEventProjections({
    chatEvents$: chatEvents.chatEvents$,
    registeredEvents$: resources.registeredEvents$,
    eventTrees$: resources.eventTrees$,
    eventTreeErrors$: resources.eventTreeErrors$,
  });
  const initialEventsReady$ = state(false);
  const initialEventsReadyView$ = computed((get): boolean => {
    return get(initialEventsReady$);
  });
  const renderWindow = createChatRenderWindow({
    threadId,
    allRenderedChatGroups$: projections.allRenderedChatGroups$,
    threadScrollPosition$: position.threadScrollPosition$,
    awayFromBottom$: position.awayFromBottom$,
    ensureEventTrees$: resources.ensureEventTrees$,
    initialEventsReady$,
  });
  const syncVisibleEventTrees$ = command(
    async (
      { set },
      revealPreparedEvents: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      set(resources.syncRegisteredEvents$, signal);
      await set(
        renderWindow.ensureVisibleEventTrees$,
        revealPreparedEvents,
        signal,
      );
    },
  );
  const afterPositionChanged$ = createEnsureVisibleEventTreesAfterScroll(
    renderWindow.ensureVisibleEventTrees$,
  );
  const scroll = createChatThreadScrollSignals(
    threadId,
    position,
    {
      afterThreadScrollPositionChanged$: afterPositionChanged$,
      preloadPreviousRenderWindowForEvent$:
        renderWindow.preloadPreviousRenderWindowForEvent$,
    },
    chatEvents.chatEvents$,
    initialEventsReadyView$,
  );
  const effects = createEventChangeEffects(
    {
      threadId,
      chatEvents,
      projections,
      scroll,
      syncVisibleEventTrees$,
    },
    ownerSignal,
  );
  const lifecycle = createChatEventPresentationLifecycle({
    chatEvents,
    afterEventsChange$: effects.afterEventsChange$,
    syncVisibleEventTrees$,
    enableSidebarEntryAnimations$: effects.sidebar.enableEntryAnimations$,
    initialEventsReady$,
  });
  const assistantErrorRecovery = createAssistantErrorRecoverySignals({
    threadId,
    chatEvents,
    visibleRenderedChatGroups$: renderWindow.visibleRenderedChatGroups$,
  });
  const readyScrollAfterRenderRequest$ = createReadyScrollAfterRenderRequest(
    scroll.pendingScrollAfterRenderRequest$,
    renderWindow.visibleRenderedChatGroups$,
  );
  const loadMoreRenderedChatGroups$ = command(
    async ({ set }, signal: AbortSignal): Promise<boolean> => {
      const scrollPosition = set(scroll.readRenderedThreadScrollPosition$);
      const didPrepend = await set(
        renderWindow.loadMoreRenderedChatGroups$,
        signal,
      );
      signal.throwIfAborted();
      if (didPrepend) {
        await set(scroll.autoScroll$, scrollPosition, signal);
        signal.throwIfAborted();
      }
      return didPrepend;
    },
  );
  return {
    scroll,
    sidebar: effects.sidebar,
    ...lifecycle,
    initialEventsReady$: initialEventsReadyView$,
    ...assistantErrorRecovery,
    ...projections,
    ...resources.publicSignals,
    ...renderWindow,
    readyScrollAfterRenderRequest$,
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
  reloadConnectorAccounts$: Command<void, []>;
  reloadConnectorAccountPreference$: Command<void, []>;
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

function eventRunStartIndex(
  groups: readonly ChatEventGroup[],
  eventId: string,
): number | null {
  const targetGroupIndex = groups.findIndex((group) => {
    return group.events.some((event) => {
      return event.id === eventId;
    });
  });
  if (targetGroupIndex === -1) {
    return null;
  }
  const targetRunId = groups[targetGroupIndex]?.events.find((event) => {
    return event.id === eventId;
  })?.runId;
  let startIndex = targetGroupIndex;
  while (
    targetRunId !== undefined &&
    startIndex > 0 &&
    groups[startIndex - 1]?.events.some((event) => {
      return event.runId === targetRunId;
    })
  ) {
    startIndex--;
  }
  return startIndex;
}

function scrollTargetStartIndex(
  groups: readonly ChatEventGroup[],
  position: ThreadScrollPosition | null,
): number | null {
  return position === null
    ? null
    : eventRunStartIndex(groups, position.targetEventId);
}

interface ChatRenderWindowOptions {
  readonly threadId: string;
  readonly allRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  readonly threadScrollPosition$: Computed<ThreadScrollPosition | null>;
  readonly awayFromBottom$: Computed<boolean>;
  readonly ensureEventTrees$: Command<
    Promise<void>,
    [readonly ChatEvent[], AbortSignal]
  >;
  readonly initialEventsReady$: State<boolean>;
}

interface PreloadPreviousRenderWindowOptions {
  readonly threadId: string;
  readonly allRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  readonly ensureVisibleEventTrees$: Command<
    Promise<void>,
    [boolean, AbortSignal]
  >;
}

function createPreloadPreviousRenderWindowForEvent({
  threadId,
  allRenderedChatGroups$,
  ensureVisibleEventTrees$,
}: PreloadPreviousRenderWindowOptions): Command<
  Promise<void>,
  [string, AbortSignal]
> {
  return command(
    async (
      { get, set },
      eventId: string,
      signal: AbortSignal,
    ): Promise<void> => {
      const groups = await get(allRenderedChatGroups$);
      signal.throwIfAborted();
      const targetStartIndex = eventRunStartIndex(groups, eventId);
      if (targetStartIndex === null) {
        return;
      }
      const preloadStartIndex = previousRenderWindowStartIndex(
        groups,
        targetStartIndex,
      );
      const current = renderWindowStateForThread(
        get(renderWindowStateByThreadId$),
        threadId,
      );
      const requestedStartIndex = renderWindowStartIndex(
        groups,
        current.cursorGroupId,
      );
      const nextStartIndex = Math.min(requestedStartIndex, preloadStartIndex);
      if (nextStartIndex < requestedStartIndex) {
        set(
          renderWindowStateByThreadId$,
          setThreadRenderWindowState(
            get(renderWindowStateByThreadId$),
            threadId,
            {
              cursorGroupId: groups[nextStartIndex]?.beginEventId ?? null,
            },
          ),
        );
      }
      // Locator jumps need stable content above the destination before their
      // smooth-scroll request commits. Persist this one-time expansion in the
      // cursor instead of deriving it from every live scroll position.
      await set(ensureVisibleEventTrees$, false, signal);
    },
  );
}

function createChatRenderWindow({
  threadId,
  allRenderedChatGroups$,
  threadScrollPosition$,
  awayFromBottom$,
  ensureEventTrees$,
  initialEventsReady$,
}: ChatRenderWindowOptions) {
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
        get(threadScrollPosition$),
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

  /**
   * Parses the trees of every event currently in the render window. Every
   * write that can grow the window or change what it holds runs this
   * afterwards: the event sync, the load-more cursor, and the scroll position
   * commands. Parsing stays command-driven — reading the window never parses.
   */
  const ensureVisibleEventTrees$ = command(
    async (
      { get, set },
      revealPreparedEvents: boolean,
      signal: AbortSignal,
    ): Promise<void> => {
      const groups = await get(visibleRenderedChatGroups$);
      signal.throwIfAborted();
      const richContentReady = set(
        ensureEventTrees$,
        groups.flatMap((group) => {
          return group.events;
        }),
        signal,
      );
      if (revealPreparedEvents) {
        set(initialEventsReady$, true);
      }
      await richContentReady;
    },
  );

  const preloadPreviousRenderWindowForEvent$ =
    createPreloadPreviousRenderWindowForEvent({
      threadId,
      allRenderedChatGroups$,
      ensureVisibleEventTrees$,
    });

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
        get(threadScrollPosition$),
      );
      const startIndex =
        targetStartIndex === null
          ? requestedStartIndex
          : Math.min(requestedStartIndex, targetStartIndex);
      const nextStartIndex = previousRenderWindowStartIndex(groups, startIndex);
      if (nextStartIndex === startIndex) {
        return false;
      }
      set(
        renderWindowStateByThreadId$,
        setThreadRenderWindowState(
          get(renderWindowStateByThreadId$),
          threadId,
          {
            cursorGroupId: groups[nextStartIndex]?.beginEventId ?? null,
          },
        ),
      );
      // The newly revealed groups need trees before the prepend renders, so
      // the caller's scroll restoration lands on the final layout.
      await set(ensureVisibleEventTrees$, false, signal);
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
    // Resetting the cursor only shrinks the window — the visible slice is a
    // suffix, so every event it still holds already has its tree and no
    // ensure pass is needed here.
    set(
      renderWindowStateByThreadId$,
      setThreadRenderWindowState(get(renderWindowStateByThreadId$), threadId, {
        ...current,
        cursorGroupId: null,
      }),
    );
  });

  return {
    visibleRenderedChatGroups$,
    visibleRenderedChatGroupsReady$,
    ensureVisibleEventTrees$,
    preloadPreviousRenderWindowForEvent$,
    loadMoreRenderedChatGroups$,
    resetRenderedChatGroupsIfAtBottom$,
  };
}

function createEnsureVisibleEventTreesAfterScroll(
  ensureVisibleEventTrees$: Command<Promise<void>, [boolean, AbortSignal]>,
): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ set }, signal: AbortSignal): Promise<void> => {
    await set(ensureVisibleEventTrees$, false, signal);
  });
}

function createOnSubscribedCommand({
  threadId,
  catchUpChatEvents$,
  reloadArtifacts$,
  cancellationRecovery,
  reloadConnectorAccounts$,
}: Pick<
  RunTrackingDeps,
  | "threadId"
  | "catchUpChatEvents$"
  | "reloadArtifacts$"
  | "cancellationRecovery"
  | "reloadConnectorAccounts$"
>): Command<Promise<void>, [AbortSignal]> {
  return command(async ({ get, set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ catchup start", { threadId });
    set(cancellationRecovery.reload$);
    set(reloadArtifacts$);
    set(reloadConnectorAccounts$);
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
  reloadConnectorAccounts$,
  reloadConnectorAccountPreference$,
}: RunTrackingDeps) {
  const onSubscribed$ = createOnSubscribedCommand({
    threadId,
    catchUpChatEvents$,
    reloadArtifacts$,
    cancellationRecovery,
    reloadConnectorAccounts$,
  });

  const subscribeChatThread$ = command(async ({ set }, signal: AbortSignal) => {
    L.debug("subscribeChatThread$ start", { threadId });
    await set(setupChatEvents$, signal);
    signal.throwIfAborted();

    const onThreadDetailChanged$ = command(({ set }) => {
      L.debug("onThreadDetailChanged$ fired", { threadId });
      set(cancellationRecovery.reload$);
      set(reloadConnectorAccountPreference$);
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
  attachments: ResolvedAttachFile[] | undefined;
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
  readonly attachments: ResolvedAttachFile[] | undefined;
}): UserMessageInputDocument {
  const userMessage = editorDocument
    ? editorDocument.toMessageDocument({
        selectedTemplate: generationTemplate,
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
  videoRunOptions: ChatRunVideoOptionsRequest | undefined,
) {
  return {
    runOptions: runOptionsFromModelProviderSelection(
      modelSelection,
      features[FeatureSwitchKey.CodexFastMode] ?? false,
      videoRunOptions,
    ),
    realAgentInPreviewEnabled:
      features[FeatureSwitchKey.RealAgentInPreview] ?? false,
  };
}

interface SendMessageDeps {
  readonly threadId: string;
  readonly agentId: string;
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

function generationTemplateForSend(
  request: ValidatedSendMessageRequest,
  draftGenerationTemplate: GenerationTemplateRequest | undefined,
): GenerationTemplateRequest | undefined {
  return request.options?.editorDocument
    ? request.options.generationTemplate
    : draftGenerationTemplate;
}

function prepareSendMessageResult(
  textOnly: boolean,
  prompt: string,
  prepareFromDraft: () => Promise<PreparedSendMessageResult | null>,
): Promise<PreparedSendMessageResult | null> {
  return textOnly
    ? Promise.resolve(prepareTextOnlyUserMessage(prompt))
    : prepareFromDraft();
}

function flushDraftForSend(
  forward: ChatForwardContext | undefined,
  flush: () => Promise<void>,
): Promise<void> {
  return forward ? Promise.resolve() : flush();
}

function sendInputForRequest(args: {
  readonly request: ValidatedSendMessageRequest;
  readonly result: PreparedSendMessageResult;
  readonly userMessage: UserMessageInputDocument;
  readonly runOptions: ChatRunOptionsRequest | undefined;
  readonly realAgentInPreviewEnabled: boolean;
}): SendInputChatEvent {
  const { request, result } = args;
  return {
    kind: "input",
    delivery: "run",
    agentId: request.agentId,
    prompt: result.prompt,
    hasTextContent: result.hasTextContent,
    userMessage: args.userMessage,
    selectedModel: request.modelSelection?.selectedModel ?? null,
    ...(args.runOptions === undefined ? {} : { runOptions: args.runOptions }),
    ...(args.realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
    ...(request.options && "computerUseHostId" in request.options
      ? { computerUseHostId: request.options.computerUseHostId ?? null }
      : {}),
    ...(request.options && "cloudBrowserEnabled" in request.options
      ? { cloudBrowserEnabled: request.options.cloudBrowserEnabled ?? false }
      : {}),
    ...(request.options?.revokesEventId === undefined
      ? {}
      : { revokesEventId: request.options.revokesEventId }),
    ...(request.options?.forward ? { source: request.options.forward } : {}),
    ...(request.options?.onOptimisticSend
      ? { onOptimisticSend: request.options.onOptimisticSend }
      : {}),
  };
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
      const generationTemplate = generationTemplateForSend(
        request,
        get(draft.generationTemplate$),
      );
      const submissionPrompt = request.prompt;
      const result = await prepareSendMessageResult(
        request.options?.includeDraftAttachments === false,
        submissionPrompt,
        () => {
          return set(
            prepareUserMessageFromDraft$,
            draft,
            submissionPrompt,
            signal,
          );
        },
      );
      signal.throwIfAborted();
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
        request.options?.videoRunOptions,
      );
      const [, sendResult] = await Promise.all([
        flushDraftForSend(request.options?.forward, () => {
          return set(flushDraftClear$, signal);
        }),
        set(
          sendEvent$,
          sendInputForRequest({
            request,
            result,
            userMessage,
            runOptions,
            realAgentInPreviewEnabled,
          }),
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
  const { threadId, agentId, modelSelectionForSend$ } = deps;
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
  readonly threadId: string;
  readonly agentId: string;
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
    agentId,
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
      const modelSelection = await set(modelSelectionForSend$, signal);
      signal.throwIfAborted();
      const result = await set(
        prepareUserMessageFromDraft$,
        draft,
        prompt,
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
        options.videoRunOptions,
      );
      await Promise.all([
        options.forward ? Promise.resolve() : set(flushDraftClear$, signal),
        set(
          sendEvent$,
          {
            kind: "input",
            delivery: "queue",
            agentId,
            prompt: result.prompt,
            hasTextContent: result.hasTextContent,
            userMessage,
            selectedModel: modelSelection?.selectedModel ?? null,
            ...(runOptions === undefined ? {} : { runOptions }),
            ...(realAgentInPreviewEnabled ? { realAgentInPreview: true } : {}),
            ...(options.computerUseHostId === undefined
              ? {}
              : { computerUseHostId: options.computerUseHostId }),
            ...(options.cloudBrowserEnabled === undefined
              ? {}
              : { cloudBrowserEnabled: options.cloudBrowserEnabled }),
            ...(options.forward ? { source: options.forward } : {}),
            ...(options.onOptimisticSend
              ? { onOptimisticSend: options.onOptimisticSend }
              : {}),
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
  readonly threadId: string;
  readonly agentId: string;
  chatEvents$: Computed<ChatEvent[]>;
  draft: DraftSignals;
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  sendEvent$: Command<
    Promise<SendChatEventResult>,
    [SendChatEventInput, AbortSignal]
  >;
}

function createRecallMessage(deps: RecallMessageDeps) {
  const { agentId, chatEvents$, draft, queueDraftSync$, sendEvent$ } = deps;

  return command(async ({ get, set }, eventId: string, signal: AbortSignal) => {
    const event = queuedEventsFromChatEvents(get(chatEvents$)).find(
      (candidate) => {
        return candidate.id === eventId;
      },
    );
    if (!event || event.eventType !== "input.prompt") {
      return;
    }
    const userMessage = event.userMessage;
    const templatePart = userMessage.parts.find((part) => {
      return part.type === "template";
    });
    await set(
      draft.seed$,
      {
        content: messageDocumentToPrompt(userMessage) ?? "",
        userMessage,
        draftVoice: null,
        generationTemplate:
          templatePart?.type === "template" ? templatePart.template : undefined,
        attachments: userMessageFileAttachments(userMessage).map(
          createRestoredAttachment,
        ),
      },
      signal,
    );

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
  agentId,
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
      if (!event) {
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
  agentId,
  chatEvents$,
  sendEvent$,
}: {
  readonly threadId: string;
  readonly agentId: string;
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
const THINKING_TYPEWRITER_LINE_HOLD_MS = 1400;
const THINKING_TYPEWRITER_LINE_HOLD_TICKS = IN_VITEST
  ? 1
  : Math.ceil(
      THINKING_TYPEWRITER_LINE_HOLD_MS / THINKING_TYPEWRITER_INTERVAL_MS,
    );
/** Keep in sync with the opacity transition on the thinking label. */
const THINKING_TYPEWRITER_FADE_MS = 200;
const THINKING_TYPEWRITER_FADE_TICKS = IN_VITEST
  ? 1
  : Math.ceil(THINKING_TYPEWRITER_FADE_MS / THINKING_TYPEWRITER_INTERVAL_MS);
const THINKING_TYPEWRITER_WIDTH_GUARD_PX = 8;
/** Fallback glyph advance used only when text measurement is unavailable. */
const THINKING_TYPEWRITER_FALLBACK_GLYPH_PX = 14;
const THINKING_TYPEWRITER_ELLIPSIS = "…";

interface ThinkingTypewriterLine {
  readonly startIndex: number;
  readonly endIndex: number;
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
  readonly lineOverflowed: boolean;
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
    lineOverflowed: false,
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

function thinkingTypewriterLines(
  graphemes: readonly string[],
): ThinkingTypewriterLine[] {
  if (graphemes.length === 0) {
    return [];
  }

  const lines: ThinkingTypewriterLine[] = [];
  let startIndex = 0;

  for (let index = 0; index <= graphemes.length; index++) {
    const grapheme = graphemes[index]!;
    const isHardBreak =
      index === graphemes.length || grapheme === "\n" || grapheme === "\r";
    if (!isHardBreak) {
      continue;
    }

    const text = graphemes.slice(startIndex, index).join("");
    if (text.trim().length > 0) {
      lines.push({
        startIndex,
        endIndex: index,
      });
    }
    startIndex = index + 1;
  }

  return lines;
}

function fitThinkingTypewriterLine(args: {
  readonly text: string;
  readonly maxWidth: number;
  readonly measureText: (value: string) => number | undefined;
}): { readonly displayedText: string; readonly lineOverflowed: boolean } {
  const textWidth = (value: string): number => {
    return (
      args.measureText(value) ??
      thinkingTextGraphemes(value).length *
        THINKING_TYPEWRITER_FALLBACK_GLYPH_PX
    );
  };
  if (textWidth(args.text) <= args.maxWidth) {
    return { displayedText: args.text, lineOverflowed: false };
  }

  const graphemes = thinkingTextGraphemes(args.text);
  for (let endIndex = graphemes.length - 1; endIndex >= 0; endIndex--) {
    const displayedText = `${graphemes.slice(0, endIndex).join("")}${THINKING_TYPEWRITER_ELLIPSIS}`;
    if (textWidth(displayedText) <= args.maxWidth) {
      return { displayedText, lineOverflowed: true };
    }
  }
  return {
    displayedText: THINKING_TYPEWRITER_ELLIPSIS,
    lineOverflowed: true,
  };
}

function revealThinkingTypewriterLine(args: {
  readonly currentFrame: ThinkingTypewriterFrame;
  readonly graphemes: readonly string[];
  readonly line: ThinkingTypewriterLine;
  readonly lineIndex: number;
  readonly maxWidth: number;
  readonly measureText: (value: string) => number | undefined;
  readonly nextLineExists: boolean;
  readonly step: number;
}): ThinkingTypewriterFrame {
  const charIndex = Math.min(
    args.line.endIndex,
    args.currentFrame.charIndex + args.step,
  );
  const revealedText = args.graphemes
    .slice(args.line.startIndex, charIndex)
    .join("");
  const { displayedText, lineOverflowed } = fitThinkingTypewriterLine({
    text: revealedText,
    maxWidth: args.maxWidth,
    measureText: args.measureText,
  });
  const lineFinished = charIndex >= args.line.endIndex || lineOverflowed;

  return {
    ...args.currentFrame,
    lineIndex: args.lineIndex,
    charIndex,
    pauseTicksRemaining:
      lineFinished && args.nextLineExists
        ? THINKING_TYPEWRITER_LINE_HOLD_TICKS
        : 0,
    fadeTicksRemaining: 0,
    fadingOut: false,
    lineOverflowed,
    displayedText,
    complete: lineFinished && !args.nextLineExists,
  };
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
  const lines = thinkingTypewriterLines(graphemes);
  if (lines.length === 0) {
    return emptyThinkingTypewriterFrame();
  }
  const maxWidth =
    width > 0
      ? Math.max(1, width - THINKING_TYPEWRITER_WIDTH_GUARD_PX)
      : Number.POSITIVE_INFINITY;

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

  // Fading out the finished line before the next one types in.
  if (currentFrame.fadeTicksRemaining > 0) {
    const fadeTicksRemaining = currentFrame.fadeTicksRemaining - 1;
    if (fadeTicksRemaining > 0 || !nextLine) {
      return {
        ...currentFrame,
        lineIndex,
        fadeTicksRemaining,
        fadingOut: fadeTicksRemaining > 0,
        displayedText: currentFrame.displayedText,
        complete: false,
      };
    }

    return revealThinkingTypewriterLine({
      currentFrame: {
        ...currentFrame,
        charIndex: nextLine.startIndex,
      },
      graphemes,
      line: nextLine,
      lineIndex: lineIndex + 1,
      maxWidth,
      measureText: args.measureText,
      nextLineExists: lines[lineIndex + 2] !== undefined,
      step: thinkingTypewriterStep(width),
    });
  }

  // Holding on a finished line so it can be read before it is replaced.
  if (currentFrame.pauseTicksRemaining > 0) {
    const pauseTicksRemaining = currentFrame.pauseTicksRemaining - 1;
    const startFade = pauseTicksRemaining === 0 && nextLine !== undefined;
    return {
      ...currentFrame,
      lineIndex,
      pauseTicksRemaining,
      fadeTicksRemaining: startFade ? THINKING_TYPEWRITER_FADE_TICKS : 0,
      fadingOut: startFade,
      displayedText: currentFrame.displayedText,
      complete: false,
    };
  }

  if (
    currentFrame.charIndex >= currentLine.endIndex ||
    currentFrame.lineOverflowed
  ) {
    return {
      ...currentFrame,
      lineIndex,
      pauseTicksRemaining: nextLine ? THINKING_TYPEWRITER_LINE_HOLD_TICKS : 0,
      displayedText: currentFrame.displayedText,
      complete: !nextLine,
    };
  }

  return revealThinkingTypewriterLine({
    currentFrame,
    graphemes,
    line: currentLine,
    lineIndex,
    maxWidth,
    measureText: args.measureText,
    nextLineExists: nextLine !== undefined,
    step: thinkingTypewriterStep(width),
  });
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
    readyScrollAfterRenderRequest$: events.readyScrollAfterRenderRequest$,
    initialEventsReady$: events.initialEventsReady$,
    assistantErrorRecovery$: events.assistantErrorRecovery$,
    retryAssistantError$: events.retryAssistantError$,
    resetCodexSubscriptionAndRetry$: events.resetCodexSubscriptionAndRetry$,
    eventImageGroups$: events.eventImageGroups$,
    browserSessionSignals: events.browserSessionSignals,
    hasEvents$: events.hasEvents$,
    thinkingIndicatorMode$: events.thinkingIndicatorMode$,
    thinkingEventId$: events.thinkingEventId$,
    thinkingText$: events.thinkingText$,
    recommendedFollowupSource$: events.recommendedFollowupSource$,
    donePhrase$: events.donePhrase$,
    loadMoreRenderedChatGroups$: events.loadMoreRenderedChatGroups$,
    resetRenderedChatGroupsIfAtBottom$:
      events.resetRenderedChatGroupsIfAtBottom$,
    retryRichEventTree$: events.retryRichEventTree$,
  };
}

interface CreateChatThreadComposerSignalsOptions {
  readonly chatEvents: ChatEventSignals;
  readonly agentId: string;
  readonly draft: DraftSignals;
  readonly queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  readonly modelSelection: ReturnType<typeof createModelSelection>;
  readonly imageModelSelection: ReturnType<typeof createImageModelSelection>;
  readonly videoModelSelection: ReturnType<typeof createVideoModelSelection>;
  readonly computerUseHostSelection: ReturnType<
    typeof createComputerUseHostSelection
  >;
  readonly messageActions: ReturnType<typeof createThreadMessageActions>;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
  readonly forward?: ChatForwardContext;
  readonly onOptimisticSend?: () => void;
  readonly connector: ComposerSignals["connector"];
}

interface ChatThreadComposerContext {
  readonly threadMeta$: Computed<ThreadMeta | null>;
  readonly agentId: string;
  readonly cancellationRecoveryPending$: Computed<Promise<boolean>>;
  readonly forward?: ChatForwardContext;
  readonly onOptimisticSend?: () => void;
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
      const hosts = await get(computerUseHostsFromWorker$);
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
                ...(submission.videoRunOptions === undefined
                  ? {}
                  : { videoRunOptions: submission.videoRunOptions }),
                ...(options.forward ? { forward: options.forward } : {}),
                ...(options.onOptimisticSend
                  ? { onOptimisticSend: options.onOptimisticSend }
                  : {}),
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
                ...(submission.videoRunOptions === undefined
                  ? {}
                  : { videoRunOptions: submission.videoRunOptions }),
                ...(options.forward ? { forward: options.forward } : {}),
                ...(options.onOptimisticSend
                  ? { onOptimisticSend: options.onOptimisticSend }
                  : {}),
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
  const removeAutomationEvent$ = command(
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
    removeAutomationEvent$,
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
    agentId: options.agentId,
    connector: options.connector,
    draft: {
      signals: options.draft,
      save$: options.forward ? noOpComposerDraftSave$ : options.queueDraftSync$,
    },
    chatEvents$: options.chatEvents.chatEvents$,
    threadId: options.chatEvents.threadId,
    singleLineOnMobile: true,
    modelSelection$: composerModelSelection$,
    selectedModelOauthAvailable$: modelSelection.selectedModelOauthAvailable$,
    setModelSelection$: modelSelection.setModelSelection$,
    configureSelectedModel$: modelSelection.configureSelectedModel$,
    imageModel: {
      selectedImageModel$: options.imageModelSelection.selectedImageModel$,
      effectiveImageModel$: options.imageModelSelection.effectiveImageModel$,
      setImageModel$: options.imageModelSelection.setImageModelSelection$,
    },
    videoModel: {
      selectedVideoModel$: options.videoModelSelection.selectedVideoModel$,
      effectiveVideoModel$: options.videoModelSelection.effectiveVideoModel$,
      setVideoModel$: options.videoModelSelection.setVideoModelSelection$,
    },
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
  const connector = createComposerConnectorSignals(context.agentId, threadId);
  const modelSelection = createModelSelection(threadId, context.threadMeta$);
  const modelSelectionForSend$ = createModelSelectionForSend(modelSelection);
  const imageModelSelection = createImageModelSelection(
    threadId,
    context.threadMeta$,
  );
  const videoModelSelection = createVideoModelSelection(
    threadId,
    context.threadMeta$,
  );
  const computerUseHostSelection = createComputerUseHostSelection(
    threadId,
    context.threadMeta$,
  );
  const { queueDraftSync$, cancelDraftSync$, flushDraftClear$ } =
    createDraftSync(threadId, draft);
  const messageActions = createThreadMessageActions({
    threadId,
    agentId: context.agentId,
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
    agentId: context.agentId,
    draft,
    queueDraftSync$,
    modelSelection,
    imageModelSelection,
    videoModelSelection,
    computerUseHostSelection,
    messageActions,
    cancellationRecoveryPending$: context.cancellationRecoveryPending$,
    connector,
    forward: context.forward,
    onOptimisticSend: context.onOptimisticSend,
  });
}

/**
 * Creates the public composer signals for a chat thread.
 *
 * @public
 */
export function createThreadComposerSignals(
  threadId: string,
  agentId: string,
  chatEvents: ChatEventSignals,
  options: {
    readonly forward?: ChatForwardContext;
    readonly onOptimisticSend?: () => void;
  } = {},
): ComposerSignals {
  const threadMeta$ = createThreadMeta(threadId);
  const cancellationRecovery = createCancellationRecoverySignals(threadId);
  return createThreadComposerSignalsWithContext(
    threadId,
    chatEvents,
    {
      threadMeta$,
      agentId,
      cancellationRecoveryPending$: cancellationRecovery.pending$,
      forward: options.forward,
      onOptimisticSend: options.onOptimisticSend,
    },
    createDraftSignals(),
  );
}

function createChatPanelSignalsWithDraft(
  chatEvents: ChatEventSignals,
  agentId: string,
  draft: DraftSignals,
  signal: AbortSignal,
): ChatPanelSignals {
  const threadId = chatEvents.threadId;
  const artifact = createArtifacts(threadId);
  const threadDraft$ = createRemoteChatThreadDraft(threadId);
  const threadMeta$ = createThreadMeta(threadId);
  const threadTitle = createThreadTitleParts(threadMeta$);
  const container = createChatThreadContainerSignals();
  const threadOwned = createThreadOwnedSignals(threadId);
  const cancellationRecovery = createCancellationRecoverySignals(threadId);
  const composer = createThreadComposerSignalsWithContext(
    threadId,
    chatEvents,
    {
      threadMeta$,
      agentId,
      cancellationRecoveryPending$: cancellationRecovery.pending$,
    },
    draft,
  );
  const messagePipeline = createChatThreadMessagePipeline(
    {
      chatActionContext: { threadId, agentId },
      chatEvents,
      previewImageUrlsByUrl$: createArtifactPreviewImageUrls(
        artifact.artifacts$,
      ),
      connector: composer.connector,
    },
    signal,
  );
  const messages: MessageListSignals = {
    ...messagePipeline,
    ...artifact,
  };
  const feedback = createChatThreadFeedbackSignals(
    threadId,
    composer.feedback,
    messages.scroll.isProgrammaticScrollEvent$,
  );
  const sharing = createChatThreadSharingSignals(threadId, messages.scroll);
  const locator = createChatConversationLocatorSignals({
    threadId,
    scrollContainer$: messages.scroll.scrollContainer$,
    scrollToEvent$: messages.scroll.scrollToEvent$,
    allChatGroups$: messagePipeline.allChatGroups$,
    threadScrollPosition$: messages.scroll.threadScrollPosition$,
  });
  const runTracking = createRunTracking({
    threadId,
    setupChatEvents$: messages.setup$,
    catchUpChatEvents$: messages.catchUp$,
    reloadArtifacts$: messages.reloadArtifacts$,
    subscribeBrowserSessions$: messages.subscribeBrowserSessions$,
    automationSignals: threadOwned,
    cancellationRecovery,
    reloadConnectorAccounts$: composer.connector.accounts.reload$,
    reloadConnectorAccountPreference$:
      composer.connector.accounts.reloadPreference$,
  });
  return {
    threadId,
    agentId,
    signal,
    threadDraft$,
    threadMeta$,
    ...threadTitle,
    scrollContainerOnRef$: messages.scroll.scrollContainerOnRef$,
    scrollContentOnRef$: messages.scroll.scrollContentOnRef$,
    scrollCommitOnRef$: messages.scroll.scrollCommitOnRef$,
    scrollContainer$: messages.scroll.scrollContainer$,
    threadScrollPosition$: messages.scroll.threadScrollPosition$,
    awayFromBottom$: messages.scroll.awayFromBottom$,
    scrollToEvent$: messages.scroll.scrollToEvent$,
    scrollTo$: messages.scroll.scrollTo$,
    scrollToTop$: messages.scroll.scrollToTop$,
    scrollToBottom$: messages.scroll.scrollToBottom$,
    ...container,
    composer,
    feedback,
    sharing,
    locator,
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
  agentId: string,
  signal: AbortSignal,
): ChatPanelSignals {
  return createChatPanelSignalsWithDraft(
    chatEvents,
    agentId,
    createDraftSignals(),
    signal,
  );
}

export const createCachedChatPanelSignals$ = command(
  (
    { set },
    chatEvents: ChatEventSignals,
    agentId: string,
    signal: AbortSignal,
  ) => {
    const { draft, isNew } = set(ensureDraft$, chatEvents.threadId);
    return {
      thread: createChatPanelSignalsWithDraft(
        chatEvents,
        agentId,
        draft,
        signal,
      ),
      isNew,
    };
  },
);
