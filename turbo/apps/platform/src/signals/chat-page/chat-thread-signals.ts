import type { Command, Computed } from "ccstate";
import type {
  ChatThreadArtifactRun,
  ChatThreadDraft,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import type { ChatThread } from "../agent-chat.ts";
import type { ChatClipboardPayload } from "../zero-page/clipboard.ts";
import type { DraftSignals } from "../zero-page/chat-draft.ts";
import type { WorkflowComposerSignals } from "../zero-page/tiptap-workflow-composer.ts";
import type {
  EnrichedChatMessage,
  GroupedChatMessageGroup,
} from "./chat-message.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";

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
  remoteThreadDetail$: Computed<Promise<ChatThread | null>>;
  threadDraft$: Computed<Promise<ChatThreadDraft | null>>;
  threadMeta$: Computed<Promise<ThreadMeta | null>>;
  reloadThread$: Command<void, []>;
  threadTitle$: Computed<Promise<string | null>>;
  threadTitleEmoji$: Computed<Promise<string | null>>;
  threadTitleText$: Computed<Promise<string>>;
  threadSettledInServer$: Computed<Promise<boolean>>;
  // -- Composer model selection --------------------------------------------
  // Derived from the thread event projection; user edits register optimistic
  // model_selection_updated events and then persist through the thread API.
  selectedModel$: Computed<Promise<string | null>>;
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
  draft: DraftSignals;
  workflowComposer: WorkflowComposerSignals;
  composerFileInput$: Computed<HTMLElement | null>;
  setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  // -- Agent info (derived from threadMeta$.agentId) ------------------------
  agentId$: Computed<Promise<string | null>>;
  agentDisplayName$: Computed<Promise<string | null>>;
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
  focusInput$: Command<void, []>;
  // -- Draft sync -----------------------------------------------------------
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  // -- Paged messages (sole rendering path) --------------------------------
  latestChatMessageId$: Computed<Promise<string | undefined>>;
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  latestAssistantTextCreatedAt$: Computed<Promise<string | undefined>>;
  groupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  renderedGroupedChatMessages$: Computed<Promise<GroupedChatMessageGroup[]>>;
  hasChatGroups$: Computed<Promise<boolean>>;
  hasQueuedUserMessages$: Computed<Promise<boolean>>;
  queuedUserMessages$: Computed<Promise<readonly EnrichedChatMessage[]>>;
  emptyQueuedUserMessages$: Computed<Promise<readonly EnrichedChatMessage[]>>;
  lastAssistantCancelled$: Computed<Promise<boolean>>;
  messageRunIndicatorState$: Computed<Promise<"running" | "queued" | null>>;
  latestRunStatus$: Computed<Promise<string | null>>;
  // The thread's active goal, folded from goal-state marker messages. Null when
  // there is no active goal. Drives the goal row above the composer.
  activeGoal$: Computed<Promise<ActiveGoalState | null>>;
  allFinished$: Computed<Promise<boolean>>;
  loadMoreRenderedChatGroups$: Command<Promise<boolean>, [AbortSignal]>;
  resetRenderedChatGroupsIfAtBottom$: Command<void, []>;
  subscribeChatThread$: Command<Promise<void>, [AbortSignal]>;
  // -- Thinking indicator ---------------------------------------------------
  blockColors$: Computed<[string, string, string]>;
  thinkingPhrase$: Computed<string>;
  donePhrase$: Computed<Promise<string>>;
  displayedThinkingText$: Computed<Promise<string>>;
  setThinkingIndicatorTextRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  // -- Artifacts ------------------------------------------------------------
  artifacts$: Computed<Promise<ChatThreadArtifactRun[]>>;
  reloadArtifacts$: Command<void, []>;
  setArtifactsRealtimeRef$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
}
