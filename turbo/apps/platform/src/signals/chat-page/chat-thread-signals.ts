import type { Command, Computed } from "ccstate";
import type {
  ChatEvent,
  GenerationTemplateRequest,
  ChatFollowupsEvent,
  ChatPromptEvent,
  ChatThreadArtifactRun,
  ChatThreadDraft,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import type { ChatClipboardPayload } from "../zero-page/clipboard.ts";
import type { DraftSignals } from "../zero-page/chat-draft.ts";
import type { WorkflowComposerSignals } from "../zero-page/tiptap-workflow-composer.ts";
import type { BodyRenderBlock } from "./parse-body-blocks.ts";
import type { ChatEventGroup } from "./chat-event.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import type { HeaderAutomationSignals } from "./header-automation-menu.ts";
import type { ThreadSidebarSignals } from "./thread-sidebar.ts";
import type { MailDraftSignals } from "./mail-draft.ts";
import type { BrowserSessionSignals } from "./browser-session-block.ts";
import type { ComposerConnectorSignals } from "../zero-page/zero-connectors.ts";
import type { EditorDocumentSnapshot } from "../zero-page/user-message-document-codec.ts";
import type { AgentReferenceSignals } from "./agent-reference-signals.ts";
import type { ArtifactSignals } from "./artifact-card-signals.ts";
import type { ThreadSidebarAutoOpenCandidate } from "./thread-sidebar-auto-open.ts";

type RecommendedFollowup = NonNullable<
  ChatFollowupsEvent["recommendedFollowups"]
>[number];

export interface RecommendedFollowupSource {
  readonly eventId: string;
  readonly followups: readonly RecommendedFollowup[];
}

export type QueuedChatEventItem =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly text: string;
    }
  | {
      readonly kind: "automation";
      readonly id: string;
      readonly automationId: string;
      readonly triggerBrief: string | null;
    };

export type ThinkingIndicatorMode =
  | "waiting"
  | "waiting-queued"
  | "running"
  | "running-queued"
  | "finished"
  | null;

export type ComposerSendButtonStatus = "idle" | "sending";

export interface EventImageGroupProjection {
  readonly role: ChatEventGroup["role"];
  readonly events: readonly {
    readonly attachFiles?: ChatPromptEvent["attachFiles"];
    readonly blocks: readonly BodyRenderBlock[];
  }[];
}

export interface SendMessageOptions {
  readonly revokesEventId?: string;
  readonly includeDraftAttachments?: boolean;
  readonly computerUseHostId?: string | null;
  readonly cloudBrowserEnabled?: boolean;
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly editorDocument?: EditorDocumentSnapshot;
}

export interface QueueMessageOptions {
  readonly computerUseHostId: string | null | undefined;
  readonly cloudBrowserEnabled: boolean | undefined;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: EditorDocumentSnapshot;
}

export interface ChatThreadSignals {
  threadId: string;
  // -- Data signals ----------------------------------------------------------
  threadDraft$: Computed<Promise<ChatThreadDraft | null>>;
  threadMeta$: Computed<ThreadMeta | null>;
  threadTitle$: Computed<string | null>;
  threadTitleEmoji$: Computed<string | null>;
  threadTitleText$: Computed<string>;
  threadSettledInServer$: Computed<boolean>;
  // -- Composer model selection --------------------------------------------
  // Derived from the thread event projection; user edits register optimistic
  // model_selection_updated events and then persist through the thread API.
  selectedModel$: Computed<string | null>;
  codexFastModeActive$: Computed<Promise<boolean>>;
  selectedModelOauthAvailable$: Computed<Promise<boolean>>;
  configureSelectedModel$: Command<Promise<void>, [AbortSignal]>;
  setModelSelection$: Command<
    Promise<void>,
    [ModelProviderSelection | null, AbortSignal]
  >;
  computerUseHostId$: Computed<string | null>;
  cloudBrowserEnabled$: Computed<boolean>;
  computerUseHostIdExplicit$: Computed<boolean>;
  setComputerUseHostId$: Command<Promise<void>, [string | null, AbortSignal]>;
  setCloudBrowserEnabled$: Command<Promise<void>, [boolean, AbortSignal]>;
  clearComputerUseHostIdOverride$: Command<void, []>;
  sendMessage$: Command<
    Promise<boolean>,
    [string, SendMessageOptions | undefined, AbortSignal]
  >;
  composerSendButtonStatus$: Computed<Promise<ComposerSendButtonStatus>>;
  queueMessage$: Command<
    Promise<boolean>,
    [string, QueueMessageOptions, AbortSignal]
  >;
  recallMessage$: Command<Promise<void>, [string, AbortSignal]>;
  skipAutomationEvent$: Command<Promise<void>, [string, AbortSignal]>;
  cancelRun$: Command<Promise<void>, [AbortSignal]>;
  setScrollContainer$: Command<(() => void) | undefined, [HTMLElement | null]>;
  autoScroll$: Command<void, []>;
  scrollToBottom$: Command<void, []>;
  scrollToTop$: Command<void, []>;
  scrollBy$: Command<boolean, [ScrollStepDirection]>;
  prepareKeyboardScroll$: Command<boolean, []>;
  containerEl$: Computed<HTMLElement | null>;
  setContainerRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  setMainContainerRef$: Command<(() => void) | undefined, [HTMLElement | null]>;
  // True when the event list is scrolled away from the bottom - drives the
  // feature-gated scroll-to-bottom button. Read-only outside scroll signals.
  awayFromBottom$: Computed<boolean>;
  draft: DraftSignals;
  workflowComposer: WorkflowComposerSignals;
  composerConnectors: ComposerConnectorSignals;
  composerFileInput$: Computed<HTMLElement | null>;
  setComposerFileInput$: Command<
    (() => void) | undefined,
    [HTMLElement | null]
  >;
  // -- Agent info (derived from threadMeta$.agentId) ------------------------
  agentId$: Computed<string | null>;
  agentDisplayName$: Computed<Promise<string | null>>;
  agentPinned$: Computed<Promise<boolean | null>>;
  // -- Thread-owned automation resources -----------------------------------
  headerAutomations: HeaderAutomationSignals;
  // -- Thread-owned utility sidebar -----------------------------------------
  sidebar: ThreadSidebarSignals;
  // -- Per-thread UI state --------------------------------------------------
  timelineExpandedIds$: Computed<Set<string>>;
  toggleTimelineExpanded$: Command<void, [string]>;
  copiedEventId$: Computed<string | null>;
  copyEvent$: Command<
    Promise<void>,
    [string, ChatClipboardPayload, AbortSignal]
  >;
  // -- Focus ----------------------------------------------------------------
  focusInput$: Command<void, []>;
  // -- Draft sync -----------------------------------------------------------
  queueDraftSync$: Command<Promise<void>, [AbortSignal]>;
  // -- Paged events (sole rendering path) ----------------------------------
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  latestAssistantTextCreatedAt$: Computed<Promise<string | undefined>>;
  indexedDbEventsInitialized$: Computed<Promise<void>>;
  visibleRenderedChatGroups$: Computed<Promise<ChatEventGroup[]>>;
  visibleRenderedChatGroupsReady$: Computed<Promise<boolean>>;
  sidebarAutoOpenCandidate$: Computed<
    Promise<ThreadSidebarAutoOpenCandidate | null>
  >;
  eventImageGroups$: Computed<Promise<EventImageGroupProjection[]>>;
  artifactSignalsForUrl: (url: string) => ArtifactSignals | undefined;
  agentReferenceSignalsForId: (agentId: string) => AgentReferenceSignals;
  mailDraftCardSignalsById$: Computed<ReadonlyMap<string, MailDraftSignals>>;
  browserSessionCardSignalsById$: Computed<
    ReadonlyMap<string, BrowserSessionSignals>
  >;
  latestBrowserSessionSignals$: Computed<BrowserSessionSignals | null>;
  hasEvents$: Computed<Promise<boolean>>;
  hasNewEvents$: Computed<Promise<boolean>>;
  hasQueuedEvents$: Computed<Promise<boolean>>;
  queuedEventItems$: Computed<Promise<readonly QueuedChatEventItem[]>>;
  emptyQueuedEventItems$: Computed<Promise<readonly QueuedChatEventItem[]>>;
  thinkingIndicatorMode$: Computed<Promise<ThinkingIndicatorMode>>;
  thinkingEventId$: Computed<Promise<string | null>>;
  thinkingText$: Computed<Promise<string | null>>;
  recommendedFollowupSource$: Computed<
    Promise<RecommendedFollowupSource | null>
  >;
  // Approximate history backfill progress in [0, 1]; null when there is no
  // backfill to show (no events loaded yet or history fully loaded).
  historyBackfillProgress$: Computed<Promise<number | null>>;
  activeGoalObjective$: Computed<Promise<string | null>>;
  loadMoreRenderedChatGroups$: Command<Promise<boolean>, [AbortSignal]>;
  resetRenderedChatGroupsIfAtBottom$: Command<void, []>;
  receiveSyncedEvents$: Command<Promise<void>, [ChatEvent[], AbortSignal]>;
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
}
