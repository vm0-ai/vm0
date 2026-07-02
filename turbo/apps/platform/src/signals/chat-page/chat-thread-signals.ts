import type { Command, Computed } from "ccstate";
import type { ChatThreadArtifactRun } from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import type { ChatThread } from "../agent-chat.ts";
import type { ChatClipboardPayload } from "../zero-page/clipboard.ts";
import type { DraftSignals } from "../zero-page/chat-draft.ts";
import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
} from "./chat-message.ts";

export interface LoadHistoryResult {
  hasMore: boolean;
}

/** The thread's current active goal, folded from its message stream. */
export interface ActiveGoalState {
  readonly objective: string;
}

export interface SendMessageOptions {
  readonly revokesMessageId?: string;
  readonly includeDraftAttachments?: boolean;
  readonly computerUseHostId?: string | null;
}

export interface ChatThreadSignals {
  threadId: string;
  // -- Data signals ----------------------------------------------------------
  threadData$: Computed<Promise<ChatThread | null>>;
  reloadThread$: Command<void, []>;
  threadTitleEmoji$: Computed<Promise<string | null>>;
  threadTitleText$: Computed<Promise<string>>;
  // -- Composer model override ---------------------------------------------
  // Seeded from threadData$ on first resolve; user edits via setModelSelection$
  // take over and are preserved across subsequent threadData$ reloads.
  modelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  setModelSelection$: Command<
    Promise<void>,
    [ModelProviderSelection | null, AbortSignal]
  >;
  computerUseHostId$: Computed<Promise<string | null>>;
  computerUseHostIdExplicit$: Computed<boolean>;
  setComputerUseHostId$: Command<Promise<void>, [string | null, AbortSignal]>;
  clearComputerUseHostIdOverride$: Command<void, []>;
  sendMessage$: Command<
    Promise<void>,
    [
      string,
      ModelProviderSelection | null,
      SendMessageOptions | undefined,
      AbortSignal,
    ]
  >;
  queueMessage$: Command<
    Promise<void>,
    [string, string | null | undefined, AbortSignal]
  >;
  recallMessage$: Command<Promise<void>, [EnrichedChatMessage, AbortSignal]>;
  cancelRun$: Command<Promise<void>, [AbortSignal]>;
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  autoScroll$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  scrollToTop$: Command<void, []>;
  scrollBy$: Command<boolean, [ScrollStepDirection]>;
  prepareKeyboardScroll$: Command<boolean, []>;
  containerEl$: Computed<HTMLElement | null>;
  setContainerRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  // True when the message list is scrolled away from the bottom - drives the
  // feature-gated scroll-to-bottom button. Read-only outside scroll signals.
  awayFromBottom$: Computed<boolean>;
  // -- Initial-load skeleton ------------------------------------------------
  // Starts hidden - `setupChatThreadInitScroll$` flips it on only when the
  // IDB cache misses, so cache hits skip the skeleton entirely. Flipped off
  // once messages resolve and the viewport is scrolled into place.
  skeletonVisible$: Computed<boolean>;
  showSkeleton$: Command<void, []>;
  hideSkeleton$: Command<void, []>;
  draft: DraftSignals;
  composerFileInput$: Computed<HTMLElement | null>;
  setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  // -- Agent info (derived from threadData$.agentId) ------------------------
  agentId$: Computed<Promise<string | null>>;
  agentDisplayName$: Computed<Promise<string | null>>;
  defaultModelSelection$: Computed<Promise<ModelProviderSelection | null>>;
  agentPinned$: Computed<Promise<boolean | null>>;
  // -- Per-thread UI state --------------------------------------------------
  timelineExpandedIds$: Computed<Set<string>>;
  toggleTimelineExpanded$: Command<void, [string]>;
  copiedMessageId$: Computed<string | null>;
  copyMessage$: Command<
    Promise<void>,
    [string, ChatClipboardPayload, AbortSignal]
  >;
  // -- Focus ----------------------------------------------------------------
  setInputRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  focusInput$: Command<void, []>;
  // -- Draft sync -----------------------------------------------------------
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  // -- Paged messages (sole rendering path) --------------------------------
  earliestChatMessageId$: Computed<Promise<string | undefined>>;
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  latestAssistantTextCreatedAt$: Computed<Promise<string | undefined>>;
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  renderedGroupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  hasOlderHistory$: Computed<Promise<boolean>>;
  latestRunStatus$: Computed<Promise<string | null>>;
  // The thread's active goal, folded from goal-state marker messages. Null when
  // there is no active goal. Drives the goal row above the composer.
  activeGoal$: Computed<Promise<ActiveGoalState | null>>;
  allFinished$: Computed<Promise<boolean>>;
  loadMoreRenderedChatGroups$: Command<Promise<boolean>, [AbortSignal]>;
  resetRenderedChatGroupsIfAtBottom$: Command<void, []>;
  fetchNextPage$: Command<Promise<boolean>, [AbortSignal]>;
  loadHistory$: Command<Promise<LoadHistoryResult>, [AbortSignal]>;
  subscribeChatThread$: Command<Promise<void>, [AbortSignal]>;
  // -- Thinking indicator ---------------------------------------------------
  blockColors$: Computed<[string, string, string]>;
  rotatingPhrase$: Computed<string>;
  donePhrase$: Computed<string>;
  displayedThinkingText$: Computed<Promise<string>>;
  setThinkingIndicatorTextRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  runPhraseLoop$: Command<Promise<void>, [AbortSignal]>;
  // -- Artifacts ------------------------------------------------------------
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>;
  reloadArtifacts$: Command<void, []>;
  setArtifactsRealtimeRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}
