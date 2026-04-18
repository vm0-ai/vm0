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
  IconLoader2,
  IconPhoto,
  IconChartLine,
  IconPlayerStop,
  IconCopy,
  IconCheck,
  IconPin,
  IconVolume2,
} from "@tabler/icons-react";
import {
  cn,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { FeatureSwitchKey, RUN_ERROR_GUIDANCE } from "@vm0/core";
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
import { detach, Reason } from "../../signals/utils.ts";
import { FileAttachmentChip, ImageLightbox } from "./zero-attachment-chips.tsx";
import {
  lightboxUrl$ as attachmentLightboxUrl$,
  setLightboxUrl$ as setAttachmentLightboxUrl$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";

import type {
  GroupedChatMessageGroup,
  PagedChatMessage,
} from "../../signals/chat-page/chat-message.ts";
import {
  currentChatThreadSignals$,
  type ChatThreadSignals,
} from "../../signals/chat-page/create-chat-thread.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../signals/zero-page/settings/org-manage-tabs-state.ts";

function HeaderAgentAvatar({ thread }: { thread: ChatThreadSignals }) {
  const agentId = useLastResolved(thread.agentId$) ?? null;

  if (agentId) {
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

  return (
    <div className="h-8 w-8 shrink-0 overflow-hidden rounded-xl">
      <AgentAvatarImg
        name=""
        alt=""
        className="h-8 w-8 rounded-full object-cover object-top"
      />
    </div>
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
  const features = useLastResolved(featureSwitch$);
  const audioIOEnabled = features?.[FeatureSwitchKey.AudioIO] ?? false;
  const autoRead = useGet(autoReadEnabled$);
  const toggleAutoReadFn = useSet(toggleAutoRead$);

  return (
    <header className="hidden sm:flex shrink-0 bg-transparent px-6 py-3 items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <HeaderAgentAvatar thread={thread} />
          <PinPillButton thread={thread} />
        </div>
        <span className="font-semibold text-foreground">{displayName}</span>
      </div>
      <div className="hidden sm:flex items-center gap-0.5">
        {audioIOEnabled && (
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

// ---------------------------------------------------------------------------
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

export function ZeroChatThreadPage() {
  const thread = useGet(currentChatThreadSignals$);

  if (!thread) {
    return null;
  }

  return <ZeroChatThreadPageInner thread={thread} />;
}

export function ZeroChatThreadPageInner({
  thread,
  autoFocus = true,
}: {
  thread: ChatThreadSignals;
  autoFocus?: boolean;
}) {
  const groupsLoadable = useLastLoadable(thread.groupedChatMessages$);
  const threadDataLoadable = useLastLoadable(thread.threadData$);
  const sessionError =
    threadDataLoadable.state === "hasError"
      ? threadDataLoadable.error instanceof Error
        ? threadDataLoadable.error.message
        : "Failed to load chat"
      : groupsLoadable.state === "hasError"
        ? groupsLoadable.error instanceof Error
          ? groupsLoadable.error.message
          : "Failed to load messages"
        : null;
  const messagesLoading = groupsLoadable.state === "loading";
  const groups = groupsLoadable.state === "hasData" ? groupsLoadable.data : [];
  const setScrollContainer = useSet(thread.setScrollContainer$);

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-transparent">
      <ChatThreadHeader thread={thread} />

      <div
        ref={setScrollContainer}
        data-scroll-container
        className="flex-1 overflow-y-auto [scrollbar-gutter:stable] min-h-0"
      >
        <main className="px-4 sm:px-6 py-4 items-center @container">
          <div
            data-message-container
            className="w-full max-w-[900px] mx-auto flex flex-col gap-6 pb-4 overflow-visible"
          >
            {sessionError && (
              <div className="flex-1 flex items-center justify-center py-16">
                <div className="flex items-center gap-2 text-destructive">
                  <IconAlertCircle size={16} />
                  <p className="text-sm">{sessionError}</p>
                </div>
              </div>
            )}
            {!sessionError && groups.length === 0 && messagesLoading && (
              <ChatSkeleton />
            )}
            {!sessionError && groups.length === 0 && !messagesLoading && (
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

      <ChatThreadComposer thread={thread} autoFocus={autoFocus} />
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
  const displayName = useLastResolved(thread.agentDisplayName$) ?? "Zero";
  const allFinished = useLastResolved(thread.allFinished$) ?? false;
  const [sendLoadable, send] = useLoadableSet(thread.sendMessage$);
  const sending = !allFinished || sendLoadable.state === "loading";
  const input = useGet(thread.draft.input$);
  const setInput = useSet(thread.draft.setInput$);
  const cancelRun = useSet(thread.cancelRun$);
  const setInputRef = useSet(thread.setInputRef$);
  const scheduleDraftSync = useSet(thread.scheduleDraftSync$);
  const pageSignal = useGet(pageSignal$);
  const { signal: rootSignal } = useGet(rootSignal$);

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
    detach(send(text, rootSignal), Reason.DomCallback);
  };

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 px-4 sm:px-6 pt-3 pb-2 bg-[hsl(var(--background))]"
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
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
        />
        <div
          aria-hidden={allFinished}
          className={cn(
            "flex items-center justify-end gap-1.5 mt-2 pr-1 transition-opacity",
            allFinished && "opacity-0",
          )}
        >
          <IconLoader2
            size={12}
            className="animate-spin text-foreground/50 shrink-0"
          />
          <span className="zero-shimmer-text text-xs">
            {displayName} is working...
          </span>
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
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
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
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
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
// Thinking indicator — shown when waiting for assistant response
// ---------------------------------------------------------------------------

function ThinkingIndicator({ thread }: { thread: ChatThreadSignals }) {
  const groups = useLastResolved(thread.groupedChatMessages$) ?? [];
  const lastGroup = groups[groups.length - 1];
  const show = lastGroup && lastGroup.role !== "assistant";

  if (!show) {
    return null;
  }

  return (
    <div
      data-role="assistant"
      className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          <div className="flex items-center gap-2 min-w-0">
            <IconLoader2
              size={14}
              className="animate-spin text-foreground/50 shrink-0"
            />
            <p className="zero-shimmer-text text-xs truncate">Thinking...</p>
          </div>
        </div>
      </div>
      <div
        aria-hidden
        className="@[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px]"
      >
        <div className="hidden @[900px]:block" />
        <div className="flex items-center py-2 gap-1 -ml-1" />
      </div>
    </div>
  );
}

// Absolutely positioned so it contributes zero layout — the surrounding
// message bubble's height is unchanged whether the cursor is shown or not.
function InlineStreamingCursor({
  thread,
  groupBeginMessageId,
}: {
  thread: ChatThreadSignals;
  groupBeginMessageId: string;
}) {
  const features = useLastResolved(featureSwitch$);
  const enabled = features?.[FeatureSwitchKey.InlineThinkingDot] ?? false;
  const allFinished = useLastResolved(thread.allFinished$) ?? false;
  const groups = useLastResolved(thread.groupedChatMessages$) ?? [];
  const lastGroup = groups[groups.length - 1];
  const isLastAssistantGroup =
    !!lastGroup &&
    lastGroup.role === "assistant" &&
    lastGroup.beginMessageId === groupBeginMessageId;

  if (!enabled || allFinished || !isLastAssistantGroup) {
    return null;
  }

  return (
    <span
      aria-hidden
      className="pointer-events-none absolute -bottom-2 left-0 flex gap-1.5 animate-in fade-in duration-200"
    >
      {[0, 120, 240, 360, 480, 600, 720, 840].map((delay) => {
        return (
          <span
            key={delay}
            className="zero-dot-trail-item inline-block size-1 rounded-full bg-foreground/50"
            style={{ animationDelay: `${delay}ms` }}
          />
        );
      })}
    </span>
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
    return <PagedUserGroup group={group} />;
  }
  return <PagedAssistantGroup group={group} thread={thread} />;
}

function PagedUserGroup({ group }: { group: GroupedChatMessageGroup }) {
  return (
    <>
      {group.messages.map((msg) => {
        return <PagedUserMessage key={msg.id} message={msg} />;
      })}
    </>
  );
}

function PagedUserMessage({ message }: { message: PagedChatMessage }) {
  const content = message.content ?? "";
  const { cleanContent, parsed } = parseInlineAttachments(content);
  const displayContent = cleanContent.replace(/\n/g, "  \n");
  const lightboxUrl = useGet(attachmentLightboxUrl$);
  const setLightboxUrl = useSet(setAttachmentLightboxUrl$);

  const allAttachments = parsed.map((p) => {
    return {
      filename: p.filename,
      url: p.url,
      isImage: isImageFilename(p.filename),
      isVideo: isVideoFilename(p.filename),
    };
  });

  return (
    <div data-role="user">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-sm leading-relaxed break-words overflow-hidden">
            {displayContent && (
              <div className="px-4 py-3">
                <Markdown source={displayContent} />
              </div>
            )}
            {allAttachments.length > 0 && (
              <div className="border-t border-foreground/10 px-3 py-2.5 flex flex-wrap gap-2">
                {allAttachments.map((a) => {
                  if (a.isImage) {
                    return (
                      <button
                        key={a.url}
                        type="button"
                        onClick={() => {
                          return setLightboxUrl(a.url);
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
                  return (
                    <FileAttachmentChip
                      key={a.url}
                      filename={a.filename}
                      url={a.url}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
      {lightboxUrl && <ImageLightbox url={lightboxUrl} />}
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
  const fullContent = group.messages
    .map((m) => {
      return m.content;
    })
    .filter(Boolean)
    .join("\n\n");

  return (
    <div
      data-role="assistant"
      className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="relative flex flex-col gap-3">
          {group.messages.map((msg) => {
            return <PagedAssistantMessageItem key={msg.id} message={msg} />;
          })}
          <InlineStreamingCursor
            thread={thread}
            groupBeginMessageId={group.beginMessageId}
          />
        </div>
      </div>
      <PagedGroupActions group={group} content={fullContent} thread={thread} />
    </div>
  );
}

function PagedAssistantMessageItem({ message }: { message: PagedChatMessage }) {
  if (message.error) {
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
        <AssistantErrorContent error={message.error} />
      </div>
    );
  }

  if (message.content) {
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
        <Markdown source={message.content} />
      </div>
    );
  }

  return null;
}

function PagedGroupActions({
  group,
  content,
  thread,
}: {
  group: GroupedChatMessageGroup;
  content: string;
  thread: ChatThreadSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === group.beginMessageId;
  const copyMessage = useSet(thread.copyMessage$);

  const features = useLastResolved(featureSwitch$);
  const audioIOEnabled = features?.[FeatureSwitchKey.AudioIO] ?? false;
  const playingRunId = useGet(ttsPlayingRunId$);
  const firstRunId = group.messages.find((m) => {
    return m.runId;
  })?.runId;
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
      copyMessage(group.beginMessageId, content, pageSignal),
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
    <div className="@[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px]">
      <div className="hidden @[900px]:block" />
      <div className="flex items-center py-2 gap-1 -ml-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity duration-150">
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
        {content && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {copied ? "Copied!" : "Copy message"}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {content && audioIOEnabled && firstRunId && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleTts}
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
    </div>
  );
}
