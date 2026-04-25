import type { CSSProperties } from "react";
import {
  useGet,
  useSet,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import {
  IconAlertCircle,
  IconPhoto,
  IconChartLine,
  IconPlayerStop,
  IconCopy,
  IconCheck,
  IconPin,
  IconVolume2,
  IconArrowBarToUp,
} from "@tabler/icons-react";
import {
  cn,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { RUN_ERROR_GUIDANCE } from "@vm0/core/contracts/errors";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  ttsPlayingRunId$,
  playTts$,
  stopTts$,
} from "../../signals/voice-io/voice-io-tts.ts";
import {
  autoReadEnabled$,
  toggleAutoRead$,
} from "../../signals/voice-io/voice-io-settings.ts";
import { Markdown } from "../components/markdown.tsx";
import { detach, Reason, onDomEventFn } from "../../signals/utils.ts";
import {
  AttachmentLightbox,
  FileAttachmentChip,
  PreviewableFileAttachmentChip,
} from "./zero-attachment-chips.tsx";
import {
  AttachmentPreview,
  classifyChatAttachment,
  filenameFromUrl,
} from "./zero-attachment-preview.tsx";
import {
  lightboxUrl$ as attachmentLightboxUrl$,
  openImageLightbox$ as openAttachmentImageLightbox$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import {
  chatShortcutHelpOpen$,
  setChatShortcutHelpOpen$,
} from "../../signals/chat-page/chat-shortcut-help.ts";
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
import { ShortcutHelpDialog } from "../components/shortcut-help-dialog.tsx";

import type {
  GroupedChatMessageGroup,
  PagedChatMessage,
} from "../../signals/chat-page/chat-message.ts";
import type { ChatThreadSignals } from "../../signals/chat-page/create-chat-thread.ts";
import type { ChatThread } from "../../signals/agent-chat.ts";
import { ATTACH_ONLY_PLACEHOLDER } from "../../signals/chat-page/resolve-draft-attachments.ts";
import type { ChatClipboardAttachment } from "../../signals/zero-page/clipboard.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { orgModelProviders$ } from "../../signals/external/org-model-providers.ts";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../signals/zero-page/settings/org-manage-tabs-state.ts";

const CHAT_SHORTCUT_SECTIONS = [
  {
    title: "Global",
    shortcuts: [
      { key: "shift+/", label: "Show shortcuts" },
      { key: "mod+b", label: "Toggle sidebar" },
    ],
  },
  {
    title: "Messages",
    shortcuts: [
      { key: "mod+arrowup", label: "Scroll to top" },
      { key: "mod+arrowdown", label: "Scroll to bottom" },
      { key: "mod+shift+arrowup", label: "Previous thread" },
      { key: "mod+shift+arrowdown", label: "Next thread" },
    ],
  },
  {
    title: "Composer",
    shortcuts: [
      { key: "enter", label: "Send message" },
      { key: "escape", label: "Blur composer" },
      { key: "mod+alt+.", label: "Switch model" },
    ],
  },
] as const;

function HeaderAgentAvatar({ thread }: { thread: ChatThreadSignals }) {
  const agentId = useLastResolved(thread.agentId$);

  if (!agentId) {
    return <Skeleton className="h-8 w-8 rounded-xl" />;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            pathname="/agents/:agentId"
            options={{ pathParams: { agentId } }}
            className="h-8 w-8 shrink-0 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="View agent profile"
          >
            <AgentAvatarImg
              name={agentId}
              alt=""
              className="h-8 w-8 rounded-full object-cover object-top"
            />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">View agent profile</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PinPillButton({ thread }: { thread: ChatThreadSignals }) {
  const pageSignal = useGet(pageSignal$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const pinnedStatus = useLastResolved(thread.agentPinned$);
  const showPinPill = pinnedStatus === false;
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const pinSaving = pinLoadable.state === "loading";
  const agentId = useLastResolved(thread.agentId$) ?? null;

  if (!showPinPill) {
    return null;
  }

  const handlePin = () => {
    if (!agentId) {
      return;
    }
    detach(
      savePinnedIds([...pinnedIds, agentId], pageSignal),
      Reason.DomCallback,
    );
  };

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={handlePin}
            disabled={pinSaving}
            className="absolute -top-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full zero-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground hover:shadow-md cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Pin to sidebar"
          >
            <IconPin size={10} stroke={2} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="text-xs">Pin to sidebar</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function ChatThreadHeader({ thread }: { thread: ChatThreadSignals }) {
  const displayName = useLastResolved(thread.agentDisplayName$);
  const autoRead = useGet(autoReadEnabled$);
  const toggleAutoReadFn = useSet(toggleAutoRead$);
  const features = useLastResolved(featureSwitch$);
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;

  return (
    <header className="hidden sm:flex shrink-0 bg-transparent px-6 py-3 items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <HeaderAgentAvatar thread={thread} />
          <PinPillButton thread={thread} />
        </div>
        {displayName ? (
          <span className="font-semibold text-foreground">{displayName}</span>
        ) : (
          <Skeleton className="h-5 w-32 rounded" />
        )}
      </div>
      <div className="hidden sm:flex items-center gap-0.5">
        {audioOutputEnabled && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => {
                    toggleAutoReadFn();
                  }}
                  className={cn(
                    "p-1.5 rounded-md transition-colors duration-150",
                    autoRead
                      ? "text-primary bg-primary/10"
                      : "text-muted-foreground/60 hover:text-foreground hover:bg-accent",
                  )}
                  aria-label="Toggle auto-read"
                  aria-pressed={autoRead}
                >
                  <IconVolume2 size={18} stroke={1.5} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {autoRead ? "Auto-read on" : "Auto-read off"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
    </header>
  );
}

interface ZeroChatThreadPageProps {
  thread: ChatThreadSignals;
}

export function ZeroChatThreadPage({ thread }: ZeroChatThreadPageProps) {
  const shortcutHelpOpen = useGet(chatShortcutHelpOpen$);
  const setShortcutHelpOpen = useSet(setChatShortcutHelpOpen$);

  return (
    <>
      <ZeroChatThreadPageInner thread={thread} />
      <ShortcutHelpDialog
        open={shortcutHelpOpen}
        onOpenChange={setShortcutHelpOpen}
        description="Available shortcuts on this page"
        sections={CHAT_SHORTCUT_SECTIONS}
      />
    </>
  );
}

type LoadableValue<T> =
  | { state: "loading" }
  | { state: "hasData"; data: T }
  | { state: "hasError"; error: unknown };

function resolveSessionError(
  threadDataLoadable: LoadableValue<ChatThread | null>,
  groupsLoadable: LoadableValue<GroupedChatMessageGroup[]>,
): string | null {
  if (threadDataLoadable.state === "hasError") {
    return threadDataLoadable.error instanceof Error
      ? threadDataLoadable.error.message
      : "Failed to load chat";
  }
  if (groupsLoadable.state === "hasError") {
    return groupsLoadable.error instanceof Error
      ? groupsLoadable.error.message
      : "Failed to load messages";
  }
  return null;
}

function ZeroChatThreadPageInner({
  thread,
  autoFocus = true,
}: {
  thread: ChatThreadSignals;
  autoFocus?: boolean;
}) {
  const features = useLastResolved(featureSwitch$);
  const groupsLoadable = useLastLoadable(thread.groupedChatMessages$);
  const hasOlderHistory = useLastResolved(thread.hasOlderHistory$) ?? false;
  const [loadHistoryLoadable, loadHistory] = useLoadableSet(
    thread.loadHistory$,
  );
  const threadDataLoadable = useLastLoadable(thread.threadData$);
  const sessionError = resolveSessionError(threadDataLoadable, groupsLoadable);
  const messagesLoading = groupsLoadable.state === "loading";
  const groups = groupsLoadable.state === "hasData" ? groupsLoadable.data : [];
  const setScrollContainer = useSet(thread.setScrollContainer$);
  const skeletonVisible = useGet(thread.skeletonVisible$);
  const lightboxUrl = useGet(attachmentLightboxUrl$);
  const manualHistoryEnabled =
    features?.[FeatureSwitchKey.ChatManualHistory] ?? false;
  const loadingHistory = loadHistoryLoadable.state === "loading";
  const pageSignal = useGet(pageSignal$);
  const onLoadHistory = onDomEventFn(() => {
    return loadHistory(pageSignal);
  });

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-transparent">
      <ChatThreadHeader thread={thread} />

      <div className="flex-1 min-h-0 relative">
        <div
          ref={setScrollContainer}
          data-scroll-container
          className="absolute inset-0 overflow-y-auto [scrollbar-gutter:stable]"
        >
          <main className="px-4 sm:px-6 py-4 items-center @container">
            <div
              data-message-container
              className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4 overflow-visible"
              style={{ visibility: skeletonVisible ? "hidden" : "visible" }}
            >
              {!sessionError &&
                !skeletonVisible &&
                manualHistoryEnabled &&
                hasOlderHistory && (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      disabled={loadingHistory}
                      onClick={onLoadHistory}
                      className="inline-flex h-8 items-center rounded-lg border border-border bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Load history
                    </button>
                  </div>
                )}
              {sessionError && (
                <div className="flex-1 flex items-center justify-center py-16">
                  <div className="flex items-center gap-2 text-destructive">
                    <IconAlertCircle size={16} />
                    <p className="text-sm">{sessionError}</p>
                  </div>
                </div>
              )}
              {!sessionError &&
                groups.length === 0 &&
                !messagesLoading &&
                !skeletonVisible && (
                  <div className="flex-1 flex items-center justify-center py-16">
                    <p className="text-sm text-muted-foreground">
                      Send a message to start the conversation
                    </p>
                  </div>
                )}
              {groups.map((group) => {
                return (
                  <PagedGroupRow
                    key={group.beginMessageId}
                    group={group}
                    thread={thread}
                  />
                );
              })}
              <ThinkingIndicator thread={thread} />
            </div>
          </main>
        </div>
        {skeletonVisible && !sessionError && (
          <div
            data-chat-skeleton
            className="absolute inset-0 overflow-hidden pointer-events-none"
          >
            <main className="px-4 sm:px-6 py-4 items-center @container">
              <div className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4">
                <ChatSkeleton />
              </div>
            </main>
          </div>
        )}
      </div>

      <ChatThreadComposer thread={thread} autoFocus={autoFocus} />
      {lightboxUrl && <AttachmentLightbox />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer wrapper — reads chat signals from thread prop
// ---------------------------------------------------------------------------

function ChatThreadComposer({
  thread,
  autoFocus: autoFocusProp = true,
}: {
  thread: ChatThreadSignals;
  autoFocus?: boolean;
}) {
  const groups = useLastResolved(thread.groupedChatMessages$) ?? [];
  const hasMessages = groups.length > 0;
  const hasUserMessages = groups.some((g) => {
    return g.role === "user";
  });
  const displayName = useLastResolved(thread.agentDisplayName$) ?? "Zero";
  const allFinishedLoadable = useLastLoadable(thread.allFinished$);
  const allFinished =
    allFinishedLoadable.state === "hasData" ? allFinishedLoadable.data : false;
  const [sendLoadable, send] = useLoadableSet(thread.sendMessage$);
  const sending = !allFinished || sendLoadable.state === "loading";
  const input = useGet(thread.draft.input$);
  const setInput = useSet(thread.draft.setInput$);
  const cancelRun = useSet(thread.cancelRun$);
  const setInputRef = useSet(thread.setInputRef$);
  const scheduleDraftSync = useSet(thread.scheduleDraftSync$);
  const pageSignal = useGet(pageSignal$);
  const { signal: rootSignal } = useGet(rootSignal$);

  // Per-thread composer state lives in ccstate signals on the factory so the
  // initial value seeds from threadData once it resolves (a React useState
  // initializer would snapshot `undefined` on first render). `modelSelection$`
  // internally flips to a user-override once `setModelSelection$` is called,
  // so unsaved edits survive subsequent threadData$ reloads.
  const threadData = useLastResolved(thread.threadData$);
  const orgProviders = useLastResolved(orgModelProviders$);
  const modelSelection = useLastResolved(thread.modelSelection$) ?? null;
  const setModelSelection = useSet(thread.setModelSelection$);
  const agentModelDefault = useLastResolved(thread.agentModelDefault$) ?? null;
  // During thread switch the thread-level skeleton is visible and
  // `threadData` / `allFinished$` may still reflect the previous thread;
  // render the whole action cluster as a skeleton so we don't flash stale
  // picker state or a wrong send/stop button.
  const skeletonVisible = useGet(thread.skeletonVisible$);

  const handleInputChange = (text: string) => {
    setInput(text);
    detach(scheduleDraftSync(pageSignal), Reason.DomCallback);
  };

  const handleDraftChange = () => {
    detach(scheduleDraftSync(pageSignal), Reason.DomCallback);
  };

  const handleSend = (text: string) => {
    setInput("");
    // Use rootSignal so in-run page navigation (e.g. IPA internal nav) doesn't
    // cancel the pending send.
    detach(send(text, modelSelection, rootSignal), Reason.DomCallback);
  };

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 bg-[hsl(var(--background))]"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div className="overflow-y-auto [scrollbar-gutter:stable] px-4 sm:px-6 pt-3 pb-2">
        <div className="mx-auto max-w-[900px]">
          <ZeroChatComposer
            className="w-full min-w-0"
            input={input}
            onInputChange={handleInputChange}
            onSend={handleSend}
            sending={sending}
            onCancel={() => {
              detach(cancelRun(pageSignal), Reason.DomCallback);
            }}
            displayName={displayName}
            autoFocus={
              autoFocusProp &&
              !hasMessages &&
              !window.matchMedia("(pointer: coarse)").matches
            }
            onDraftChange={handleDraftChange}
            draft={thread.draft}
            composerFileInput$={thread.composerFileInput$}
            setComposerFileInput$={thread.setComposerFileInput$}
            setInputRef={setInputRef}
            actionsLoading={skeletonVisible}
            modelPicker={
              orgProviders && orgProviders.modelProviders.length > 0
                ? {
                    providers: orgProviders.modelProviders,
                    value: modelSelection,
                    onChange: setModelSelection,
                    sessionProviderType:
                      threadData?.latestSessionProviderType ?? null,
                    // Lock as soon as the thread has a user message — provider
                    // must stay consistent within a session to maintain
                    // continuity.
                    disabled: hasUserMessages,
                    agentDefault: agentModelDefault,
                  }
                : undefined
            }
          />
        </div>
      </div>
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Skeleton placeholder while session loads
// ---------------------------------------------------------------------------

function ChatSkeleton() {
  return (
    <>
      {/* User bubble skeleton */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-[60%] rounded-xl" />
      </div>
      {/* Assistant bubble skeleton */}
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-[90%] rounded-lg" />
          <Skeleton className="h-4 w-[75%] rounded-lg" />
          <Skeleton className="h-4 w-[40%] rounded-lg" />
        </div>
      </div>
      {/* User bubble skeleton */}
      <div className="flex justify-end">
        <Skeleton className="h-10 w-[45%] rounded-xl" />
      </div>
      {/* Assistant bubble skeleton */}
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-[85%] rounded-lg" />
          <Skeleton className="h-4 w-[60%] rounded-lg" />
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Thinking indicator — shown the entire time a run is active
// ---------------------------------------------------------------------------

function ThinkingIndicator({ thread }: { thread: ChatThreadSignals }) {
  const groups = useLastResolved(thread.groupedChatMessages$) ?? [];
  const allFinishedLoadable = useLastLoadable(thread.allFinished$);
  const runActive =
    allFinishedLoadable.state === "hasData" && !allFinishedLoadable.data;
  const [c1, c2, c3] = useGet(thread.blockColors$);
  const blockStyle = {
    "--zb-c1": c1,
    "--zb-c2": c2,
    "--zb-c3": c3,
  } as CSSProperties;

  const lastGroup = groups[groups.length - 1];
  const lastIsAssistant = lastGroup?.role === "assistant";
  const waitingForAssistant = !!lastGroup && !lastIsAssistant;
  const running = runActive || waitingForAssistant;
  const rotatingLabel = useGet(thread.rotatingPhrase$);
  const donePhrase = useGet(thread.donePhrase$);
  const latestRunStatus = useLastResolved(thread.latestRunStatus$);
  const isQueued = latestRunStatus === "queued";
  const openQueueDrawer = useSet(openQueueDrawer$);

  const thinkingLabel = isQueued ? (
    <p className="zero-shimmer-text text-xs truncate">
      Waiting in{" "}
      <button
        type="button"
        onClick={openQueueDrawer}
        className="cursor-pointer underline underline-offset-2"
      >
        queue...
      </button>
    </p>
  ) : (
    <p className="zero-shimmer-text text-xs truncate">{rotatingLabel}</p>
  );

  if (!lastGroup) {
    return null;
  }

  // Shared inline row with fixed h-5 to prevent layout jump on transition
  if (lastIsAssistant || !running) {
    return (
      <div
        data-role="assistant-thinking"
        className="-mt-5 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start"
      >
        <div className="hidden @[900px]:block" />
        <div className="min-w-0">
          {running ? (
            <div className="flex items-center gap-2 h-5">
              <span className="zero-blocks shrink-0" style={blockStyle}>
                <span />
                <span />
                <span />
              </span>
              {thinkingLabel}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5 h-5 justify-center">
              <div className="h-px w-full bg-border/40" />
              <div className="flex items-center gap-2">
                <p className="text-[11px] italic text-muted-foreground/40 font-serif shrink-0">
                  {donePhrase}
                </p>
                <div className="h-px flex-1 bg-border/40" />
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Waiting for first assistant response — show bubble with avatar
  return (
    <div
      data-role="assistant"
      className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <span className="zero-blocks shrink-0" style={blockStyle}>
              <span />
              <span />
              <span />
            </span>
            {thinkingLabel}
          </div>
        </div>
      </div>
      <div
        aria-hidden
        className="@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]"
      >
        <div className="hidden @[900px]:block" />
        <div className="flex items-center py-2 gap-1 -ml-1" />
      </div>
    </div>
  );
}

/**
 * Parse inline attachment lines from message content.
 * Matches `[Attached file: name](url)` optionally followed by a curl line.
 * Returns the cleaned content and parsed attachments.
 */
function parseInlineAttachments(content: string): {
  cleanContent: string;
  parsed: { filename: string; url: string }[];
} {
  const parsed: { filename: string; url: string }[] = [];
  const cleaned = content.replace(
    /\[Attached file: ([^\]]+)\]\(([^)]+)\)(?:\nDownload with: curl [^\n]*)?\n?/g,
    (_match, filename: string, url: string) => {
      parsed.push({ filename, url });
      return "";
    },
  );
  return { cleanContent: cleaned.trim(), parsed };
}

type BodyRenderBlock =
  | {
      type: "markdown";
      content: string;
    }
  | {
      type: "preview";
      preview: {
        filename: string;
        url: string;
        kind: "markdown" | "text" | "json" | "csv" | "pdf" | "html";
      };
    };

function parseBodyRenderBlocks(content: string): {
  cleanContent: string;
  blocks: BodyRenderBlock[];
} {
  const blocks: BodyRenderBlock[] = [];
  const lines = content.split("\n");
  const keptLines: string[] = [];
  const markdownBuffer: string[] = [];
  let openFence: {
    marker: "`" | "~";
    length: number;
  } | null = null;

  const flushMarkdownBuffer = () => {
    const joined = markdownBuffer.join("\n").trim();
    if (joined) {
      blocks.push({ type: "markdown", content: joined });
    }
    markdownBuffer.length = 0;
  };

  for (const line of lines) {
    const trimmedLine = line.trim();
    const fenceMatch = trimmedLine.match(/^(`{3,}|~{3,})/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const marker = fence.startsWith("`") ? "`" : "~";
      if (
        openFence &&
        openFence.marker === marker &&
        fence.length >= openFence.length
      ) {
        openFence = null;
      } else if (!openFence) {
        openFence = { marker, length: fence.length };
      }
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    if (openFence) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const wrappers: [string, string][] = [
      ["**", "**"],
      ["__", "__"],
      ["*", "*"],
      ["_", "_"],
      ["~~", "~~"],
    ];
    let candidate = trimmedLine;

    for (const [prefix, suffix] of wrappers) {
      if (candidate.startsWith(prefix) && candidate.endsWith(suffix)) {
        candidate = candidate
          .slice(prefix.length, candidate.length - suffix.length)
          .trim();
        break;
      }
    }

    const match = candidate.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (!match) {
      markdownBuffer.push(line);
      keptLines.push(line);
      continue;
    }

    const url = match[2];
    const filename = filenameFromUrl(url);
    const kind = classifyChatAttachment({ filename, url });

    if (
      kind === "markdown" ||
      kind === "text" ||
      kind === "json" ||
      kind === "csv" ||
      kind === "pdf" ||
      kind === "html"
    ) {
      flushMarkdownBuffer();
      blocks.push({
        type: "preview",
        preview: { filename, url, kind },
      });
      continue;
    }

    markdownBuffer.push(line);
    keptLines.push(line);
  }

  flushMarkdownBuffer();

  return {
    cleanContent: keptLines.join("\n").trim(),
    blocks,
  };
}

function BodyContentBlocks({
  blocks,
  openLightbox,
  hardBreaks,
}: {
  blocks: BodyRenderBlock[];
  openLightbox: (url: string) => void;
  hardBreaks: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      {blocks.map((block) => {
        if (block.type === "markdown") {
          return (
            <Markdown
              key={`markdown-${block.content}`}
              source={
                hardBreaks
                  ? block.content.replace(/\n/g, "  \n")
                  : block.content
              }
              mediaPreview
              onImageClick={openLightbox}
            />
          );
        }

        return (
          <AttachmentPreview
            key={`preview-${block.preview.url}`}
            attachment={{
              filename: block.preview.filename,
              url: block.preview.url,
              contentType:
                block.preview.kind === "markdown"
                  ? "text/markdown"
                  : block.preview.kind === "text"
                    ? "text/plain"
                    : block.preview.kind === "json"
                      ? "application/json"
                      : block.preview.kind === "csv"
                        ? "text/csv"
                        : block.preview.kind === "pdf"
                          ? "application/pdf"
                          : "text/html",
            }}
          />
        );
      })}
    </div>
  );
}

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
}

function isVideoFilename(filename: string): boolean {
  return /\.(mp4|webm|mov)$/i.test(filename);
}

function AssistantErrorContent({ error }: { error: string }) {
  const setOrgManageOpen = useSet(setOrgManageDialogOpen$);
  const setTab = useSet(setActiveOrgManageTab$);
  const pageSignal = useGet(pageSignal$);

  const noProviderGuidance = RUN_ERROR_GUIDANCE.NO_MODEL_PROVIDER;
  const isNoModelProvider =
    noProviderGuidance !== undefined &&
    error.toLowerCase().includes(noProviderGuidance.title.toLowerCase());

  if (isNoModelProvider) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          No model provider configured yet.{" "}
          <button
            type="button"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
            onClick={() => {
              setTab("providers");
              detach(setOrgManageOpen(true, pageSignal), Reason.DomCallback);
            }}
          >
            Set one up in Workspace Settings
          </button>{" "}
          to get started.
        </span>
      </div>
    );
  }

  const incompatibleGuidance = RUN_ERROR_GUIDANCE.PROVIDER_INCOMPATIBLE;
  const isProviderIncompatible =
    (incompatibleGuidance !== undefined &&
      error.toLowerCase().includes(incompatibleGuidance.title.toLowerCase())) ||
    error.includes("Cannot continue session") ||
    error.includes("Invalid signature in thinking block");

  if (isProviderIncompatible) {
    return (
      <div className="flex items-start gap-2 text-foreground">
        <IconAlertCircle
          size={16}
          className="shrink-0 mt-[3px] text-amber-500"
        />
        <span>
          This session was started with a different model provider and
          can&apos;t be continued with the current one.{" "}
          <Link
            pathname="/"
            className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
          >
            Start a new session
          </Link>
        </span>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 text-destructive">
      <IconAlertCircle size={16} className="shrink-0 mt-[3px]" />
      <Markdown source={error} />
    </div>
  );
}

function AssistantBubbleAvatar({ thread }: { thread: ChatThreadSignals }) {
  const agentId = useLastResolved(thread.agentId$) ?? "";
  return (
    <div className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 overflow-hidden rounded-xl">
      <AgentAvatarImg
        name={agentId}
        alt=""
        className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-full object-cover object-top"
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Paged message rendering — renders from groupedChatMessages$ (flat data,
// no signal-based run loops).
// ---------------------------------------------------------------------------

function PagedGroupRow({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  if (group.role === "user") {
    return <PagedUserGroup group={group} thread={thread} />;
  }
  return <PagedAssistantGroup group={group} thread={thread} />;
}

function PagedUserGroup({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  return (
    <>
      {group.messages.map((msg) => {
        return <PagedUserMessage key={msg.id} message={msg} thread={thread} />;
      })}
    </>
  );
}

function resolveAttachments(
  message: PagedChatMessage,
  parsed: { filename: string; url: string }[],
) {
  const source =
    message.attachFiles && message.attachFiles.length > 0
      ? message.attachFiles
      : parsed;
  return source.map((f) => {
    const contentType =
      "contentType" in f && typeof f.contentType === "string"
        ? f.contentType
        : undefined;
    const kind = classifyChatAttachment({
      filename: f.filename,
      url: f.url,
      contentType,
    });
    return {
      filename: f.filename,
      url: f.url,
      contentType,
      isImage: kind === "image" || isImageFilename(f.filename),
      isVideo: kind === "video" || isVideoFilename(f.filename),
      kind,
    };
  });
}

function attachmentIdFromUrl(url: string): string | null {
  if (!URL.canParse(url, window.location.origin)) {
    return null;
  }
  const parsed = new URL(url, window.location.origin);
  const match = parsed.pathname.match(/^\/f\/[^/]+\/([^/]+)\/[^/]+$/);
  return match?.[1] ?? null;
}

function inferAttachmentContentType(filename: string, kind: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".svg")) {
    return "image/svg+xml";
  }
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  if (lower.endsWith(".webm")) {
    return "video/webm";
  }
  if (lower.endsWith(".mov")) {
    return "video/quicktime";
  }
  switch (kind) {
    case "markdown": {
      return "text/markdown";
    }
    case "text": {
      return "text/plain";
    }
    case "json": {
      return "application/json";
    }
    case "csv": {
      return "text/csv";
    }
    case "pdf": {
      return "application/pdf";
    }
    case "html": {
      return "text/html";
    }
    default: {
      return "application/octet-stream";
    }
  }
}

function clipboardAttachmentsFromMessage(
  message: PagedChatMessage,
  parsed: { filename: string; url: string }[],
): ChatClipboardAttachment[] {
  const source =
    message.attachFiles && message.attachFiles.length > 0
      ? message.attachFiles
      : parsed;
  return source.map((f) => {
    const contentType =
      "contentType" in f && typeof f.contentType === "string"
        ? f.contentType
        : undefined;
    const kind = classifyChatAttachment({
      filename: f.filename,
      url: f.url,
      contentType,
    });
    return {
      id:
        "id" in f && typeof f.id === "string"
          ? f.id
          : attachmentIdFromUrl(f.url),
      filename: f.filename,
      url: f.url,
      contentType: contentType ?? inferAttachmentContentType(f.filename, kind),
      size: "size" in f && typeof f.size === "number" ? f.size : 0,
    };
  });
}

function UserMessageAttachments({
  attachments,
  onImageClick,
}: {
  attachments: ReturnType<typeof resolveAttachments>;
  onImageClick: (url: string) => void;
}) {
  if (attachments.length === 0) {
    return null;
  }

  return (
    <div className="border-t border-foreground/10 px-3 py-2.5 flex flex-wrap gap-2">
      {attachments.map((a) => {
        if (a.isImage) {
          return (
            <button
              key={a.url}
              type="button"
              onClick={() => {
                onImageClick(a.url);
              }}
              className="group relative rounded-lg overflow-hidden border border-foreground/10 hover:border-foreground/25 transition-colors"
            >
              <img
                src={a.url}
                alt={a.filename}
                className="h-9 max-w-[72px] object-cover"
              />
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/30 transition-colors">
                <IconPhoto
                  size={18}
                  className="text-white opacity-0 group-hover:opacity-100 transition-opacity drop-shadow"
                />
              </span>
            </button>
          );
        }
        if (a.isVideo) {
          return (
            <video
              key={a.url}
              src={a.url}
              controls
              className="max-h-48 max-w-full rounded-lg border border-foreground/10"
            />
          );
        }
        if (
          a.kind === "markdown" ||
          a.kind === "text" ||
          a.kind === "json" ||
          a.kind === "csv" ||
          a.kind === "pdf" ||
          a.kind === "html"
        ) {
          return (
            <PreviewableFileAttachmentChip
              key={a.url}
              filename={a.filename}
              url={a.url}
              kind={a.kind}
            />
          );
        }
        return (
          <FileAttachmentChip key={a.url} filename={a.filename} url={a.url} />
        );
      })}
    </div>
  );
}

function PagedUserMessage({
  message,
  thread,
}: {
  message: PagedChatMessage;
  thread: ChatThreadSignals;
}) {
  const content = message.content ?? "";
  // Two attachment sources coexist: the structured `attachFiles` field
  // (current flow) and legacy `[Attached file: ...](url)` inline lines left
  // over from messages sent before #10243 split the flows. Use the structured
  // source when it's present and fall back to inline parsing otherwise.
  const { cleanContent, parsed } = parseInlineAttachments(content);
  // `ATTACH_ONLY_PLACEHOLDER` is the server-side placeholder stored when the
  // user sent only files with no typed text — strip it so the bubble shows
  // just the attachments.
  const strippedContent =
    message.attachFiles &&
    message.attachFiles.length > 0 &&
    cleanContent.trim() === ATTACH_ONLY_PLACEHOLDER
      ? ""
      : cleanContent;
  const { blocks: bodyBlocks } = parseBodyRenderBlocks(strippedContent);
  const pageSignal = useGet(pageSignal$);
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = (url: string) => {
    openImageLightbox(url);
  };
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === message.id;
  const copyMessage = useSet(thread.copyMessage$);
  const allAttachments = resolveAttachments(message, parsed);
  const clipboardAttachments = clipboardAttachmentsFromMessage(message, parsed);
  const copyText = strippedContent;
  const canCopy = copyText.trim().length > 0 || clipboardAttachments.length > 0;

  const handleCopy = () => {
    if (!canCopy) {
      return;
    }
    detach(
      copyMessage(
        message.id,
        { text: copyText, attachments: clipboardAttachments },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  return (
    <div data-role="user" className="group">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-sm leading-relaxed [overflow-wrap:anywhere] overflow-hidden">
            {bodyBlocks.length > 0 && (
              <div className="px-4 py-3">
                <BodyContentBlocks
                  blocks={bodyBlocks}
                  openLightbox={openLightbox}
                  hardBreaks
                />
              </div>
            )}
            <UserMessageAttachments
              attachments={allAttachments}
              onImageClick={openLightbox}
            />
          </div>
          {canCopy && (
            <div className="flex justify-end mt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
              <button
                type="button"
                onClick={handleCopy}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="Copy message"
              >
                {copied ? (
                  <IconCheck size={18} stroke={1.5} />
                ) : (
                  <IconCopy size={18} stroke={1.5} />
                )}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PagedAssistantGroup({
  group,
  thread,
}: {
  group: GroupedChatMessageGroup;
  thread: ChatThreadSignals;
}) {
  const groupElementId = `chat-message-group-${group.beginMessageId}`;
  const fullContent = group.messages
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");

  return (
    <div
      id={groupElementId}
      data-role="assistant"
      className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="relative flex flex-col gap-3">
          {group.messages.map((msg) => {
            return <PagedAssistantMessageItem key={msg.id} message={msg} />;
          })}
        </div>
      </div>
      <PagedGroupActions
        group={group}
        content={fullContent}
        thread={thread}
        onScrollToMessageStart={() => {
          document.getElementById(groupElementId)?.scrollIntoView({
            block: "start",
            behavior: "smooth",
          });
        }}
      />
    </div>
  );
}

function PagedAssistantMessageItem({ message }: { message: PagedChatMessage }) {
  const openImageLightbox = useSet(openAttachmentImageLightbox$);
  const openLightbox = (url: string) => {
    openImageLightbox(url);
  };

  if (message.error) {
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 [overflow-wrap:anywhere]">
        <AssistantErrorContent error={message.error} />
      </div>
    );
  }

  if (message.content) {
    const { blocks } = parseBodyRenderBlocks(message.content);
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 [overflow-wrap:anywhere]">
        {blocks.length > 0 ? (
          <BodyContentBlocks
            blocks={blocks}
            openLightbox={openLightbox}
            hardBreaks={false}
          />
        ) : null}
      </div>
    );
  }

  return null;
}

function PagedGroupPrimaryActions({
  firstRunId,
  hasContent,
  copied,
  audioOutputEnabled,
  isPlayingThis,
  onCopy,
  onTts,
}: {
  firstRunId: string | undefined;
  hasContent: boolean;
  copied: boolean;
  audioOutputEnabled: boolean;
  isPlayingThis: boolean;
  onCopy: () => void;
  onTts: () => void;
}) {
  return (
    <div className="flex items-center gap-1">
      {firstRunId && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/activities/:activityRunId"
                options={{
                  pathParams: { activityRunId: firstRunId },
                }}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="View run logs"
              >
                <IconChartLine size={18} stroke={1.5} />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">View activity logs</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasContent && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onCopy}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="Copy message"
              >
                {copied ? (
                  <IconCheck size={18} stroke={1.5} />
                ) : (
                  <IconCopy size={18} stroke={1.5} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {copied ? "Copied!" : "Copy message"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasContent && firstRunId && audioOutputEnabled && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onTts}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label={isPlayingThis ? "Stop reading" : "Read aloud"}
              >
                {isPlayingThis ? (
                  <IconPlayerStop size={18} stroke={1.5} />
                ) : (
                  <IconVolume2 size={18} stroke={1.5} />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {isPlayingThis ? "Stop reading" : "Read aloud"}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function MessageStartButton({ onClick }: { onClick: () => void }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
            aria-label="Scroll to message start"
          >
            <IconArrowBarToUp size={18} stroke={1.5} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Scroll to start</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function PagedGroupActions({
  group,
  content,
  thread,
  onScrollToMessageStart,
}: {
  group: GroupedChatMessageGroup;
  content: string;
  thread: ChatThreadSignals;
  onScrollToMessageStart: () => void;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === group.beginMessageId;
  const copyMessage = useSet(thread.copyMessage$);

  const features = useLastResolved(featureSwitch$);
  const audioOutputEnabled = features?.[FeatureSwitchKey.AudioOutput] ?? false;
  const messageStartButtonEnabled =
    features?.[FeatureSwitchKey.ChatMessageStartButton] ?? false;
  const playingRunId = useGet(ttsPlayingRunId$);
  const firstRunId = group.messages.find((m) => {
    return m.runId;
  })?.runId;
  const hasContent = content.length > 0;
  const isPlayingThis = !!firstRunId && playingRunId === firstRunId;
  const playTts = useSet(playTts$);
  const stopTts = useSet(stopTts$);

  if (group.role === "user") {
    return null;
  }

  const handleCopy = () => {
    if (!content) {
      return;
    }
    detach(
      copyMessage(
        group.beginMessageId,
        { text: content, attachments: [] },
        pageSignal,
      ),
      Reason.DomCallback,
    );
  };

  const handleTts = () => {
    if (!firstRunId) {
      return;
    }
    if (isPlayingThis) {
      detach(stopTts(), Reason.DomCallback);
    } else {
      detach(playTts(firstRunId, content, pageSignal), Reason.DomCallback);
    }
  };

  return (
    <div className="@[900px]:grid @[900px]:grid-cols-[36px_minmax(0,1fr)] @[900px]:gap-2.5 @[900px]:-ml-[46px]">
      <div className="hidden @[900px]:block" />
      <div className="flex items-center justify-between pt-2 pb-1 gap-2 -ml-1">
        <PagedGroupPrimaryActions
          firstRunId={firstRunId}
          hasContent={hasContent}
          copied={copied}
          audioOutputEnabled={audioOutputEnabled}
          isPlayingThis={isPlayingThis}
          onCopy={handleCopy}
          onTts={handleTts}
        />
        {messageStartButtonEnabled && (
          <MessageStartButton onClick={onScrollToMessageStart} />
        )}
      </div>
    </div>
  );
}
