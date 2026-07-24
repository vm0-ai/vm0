import type { Command, Computed } from "ccstate";
import type {
  GenerationTemplateRequest,
  PagedChatMessage,
  ChatThreadArtifactRun,
  ChatThreadDraft,
} from "@vm0/api-contracts/contracts/chat-threads";
import type { ModelProviderSelection } from "../../views/zero-page/components/model-provider-picker.tsx";
import type { ScrollStepDirection } from "../auto-scroll.ts";
import type { ChatThread } from "../agent-chat.ts";
import type { ChatClipboardPayload } from "../zero-page/clipboard.ts";
import type { DraftSignals } from "../zero-page/chat-draft.ts";
import type { WorkflowComposerSignals } from "../zero-page/tiptap-workflow-composer.ts";
import type { BodyRenderBlock } from "./parse-body-blocks.ts";
import type { GroupedChatMessageGroup } from "./chat-message.ts";
import type { ThreadMeta } from "./chat-thread-event-sourcing.ts";
import type { HeaderAutomationSignals } from "./header-automation-menu.ts";
import type { WorkflowQueueSignals } from "./workflow-queue.ts";
import type { MailDraftSignals } from "./mail-draft.ts";
import type { ComposerConnectorSignals } from "../zero-page/zero-connectors.ts";
import type { EditorDocumentSnapshot } from "../zero-page/user-message-document-codec.ts";

type RecommendedFollowup = NonNullable<
  Extract<PagedChatMessage, { role: "assistant" }>["recommendedFollowups"]
>[number];

export interface RecommendedFollowupSource {
  readonly messageId: string;
  readonly followups: readonly RecommendedFollowup[];
}

export interface QueuedChatMessageItem {
  readonly id: string;
  readonly text: string;
}

export type ThinkingIndicatorMode =
  | "waiting"
  | "waiting-queued"
  | "running"
  | "running-queued"
  | "finished"
  | null;

export type ComposerSendButtonStatus = "idle" | "sending";

export interface MessageImageGroupProjection {
  readonly messages: readonly {
    readonly attachFiles?: PagedChatMessage["attachFiles"];
    readonly blocks: readonly BodyRenderBlock[];
  }[];
}

export interface SendMessageOptions {
  readonly revokesMessageId?: string;
  readonly includeDraftAttachments?: boolean;
  readonly computerUseHostId?: string | null;
  readonly generationTemplate?: GenerationTemplateRequest;
  readonly editorDocument?: EditorDocumentSnapshot;
}

export interface QueueMessageOptions {
  readonly computerUseHostId: string | null | undefined;
  readonly generationTemplate: GenerationTemplateRequest | undefined;
  readonly editorDocument: EditorDocumentSnapshot;
}

export interface ChatThreadSignals {
  threadId: string;
  // -- Data signals ----------------------------------------------------------
  remoteThreadDetail$: Computed<Promise<ChatThread | null>>;
  threadDraft$: Computed<Promise<ChatThreadDraft | null>>;
  threadMeta$: Computed<ThreadMeta | null>;
  reloadThread$: Command<void, []>;
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
  computerUseHostId$: Computed<Promise<string | null>>;
  computerUseHostIdExplicit$: Computed<boolean>;
  setComputerUseHostId$: Command<Promise<void>, [string | null, AbortSignal]>;
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
  workflowQueue: WorkflowQueueSignals;
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
  latestRunFinishCreatedAt$: Computed<Promise<string | undefined>>;
  latestAssistantTextCreatedAt$: Computed<Promise<string | undefined>>;
  visibleRenderedChatGroups$: Computed<Promise<GroupedChatMessageGroup[]>>;
  visibleRenderedChatGroupsReady$: Computed<Promise<boolean>>;
  messageImageGroups$: Computed<Promise<MessageImageGroupProjection[]>>;
  mailDraftCardSignalsById$: Computed<ReadonlyMap<string, MailDraftSignals>>;
  hasMessages$: Computed<Promise<boolean>>;
  hasNewMessages$: Computed<Promise<boolean>>;
  hasQueuedMessages$: Computed<Promise<boolean>>;
  queuedMessageItems$: Computed<Promise<readonly QueuedChatMessageItem[]>>;
  emptyQueuedMessageItems$: Computed<Promise<readonly QueuedChatMessageItem[]>>;
  thinkingIndicatorMode$: Computed<Promise<ThinkingIndicatorMode>>;
  thinkingMessageId$: Computed<Promise<string | null>>;
  thinkingText$: Computed<Promise<string | null>>;
  recommendedFollowupSource$: Computed<
    Promise<RecommendedFollowupSource | null>
  >;
  // Approximate history backfill progress in [0, 1]; null when there is no
  // backfill to show (no messages loaded yet or history fully loaded).
  historyBackfillProgress$: Computed<Promise<number | null>>;
  activeGoalObjective$: Computed<Promise<string | null>>;
  loadMoreRenderedChatGroups$: Command<Promise<boolean>, [AbortSignal]>;
  resetRenderedChatGroupsIfAtBottom$: Command<void, []>;
  receiveSyncedMessages$: Command<
    Promise<void>,
    [PagedChatMessage[], AbortSignal]
  >;
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
