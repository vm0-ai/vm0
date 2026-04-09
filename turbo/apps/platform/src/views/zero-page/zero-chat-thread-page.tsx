import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
import {
  IconAlertCircle,
  IconLoader2,
  IconPhoto,
  IconChartLine,
  IconPlayerStop,
  IconChevronDown,
  IconCopy,
  IconCheck,
  IconPin,
} from "@tabler/icons-react";
import {
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { RUN_ERROR_GUIDANCE } from "@vm0/core";
import { Markdown } from "../components/markdown.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
import { FileAttachmentChip, ImageLightbox } from "./zero-attachment-chips.tsx";
import {
  lightboxUrl$ as attachmentLightboxUrl$,
  setLightboxUrl$ as setAttachmentLightboxUrl$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  currentChatAgentId$,
  currentChatAgentDisplayName$,
  currentChatAgentAvatarUrl$,
} from "../../signals/agent-chat.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
  currentChatAgentPinned$,
} from "../../signals/zero-page/zero-pinned-agents.ts";

import {
  zeroChatMessages$,
  allFinished$,
  zeroChatInput$,
  setZeroChatInput$,
  clearZeroChatInput$,
  sendExistingThreadMessage$,
  type ZeroChatMessage,
  type UserChatMessage,
  type AssistantChatMessage,
  cancelActiveRun$,
  thinkingMessage$,
  zeroChatAttachments$,
} from "../../signals/chat-page/chat-message.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { useAutoScroll } from "./use-auto-scroll.ts";
import { setChatScrollContainer$ } from "../../signals/chat-page/chat-auto-scroll.ts";
import { Link } from "../router/link.tsx";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveOrgManageTab$ } from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  timelineExpandedIds$,
  toggleTimelineExpanded$,
  copiedMessageIdValue$,
  copyMessageContent$,
} from "../../signals/zero-page/zero-session-chat-ui.ts";

function AvatarOrPlaceholder({
  src,
  className,
  placeholderClassName,
}: {
  src: string | null | undefined;
  className: string;
  placeholderClassName?: string;
}) {
  if (src) {
    return <img src={src} alt="" role="presentation" className={className} />;
  }
  return <div className={placeholderClassName ?? className} aria-hidden />;
}

function HeaderAgentAvatar() {
  const avatarSrc = useResolved(currentChatAgentAvatarUrl$);
  const currentChatAgentId = useResolved(currentChatAgentId$) ?? null;

  if (currentChatAgentId) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              pathname="/agents/:id"
              options={{ pathParams: { id: currentChatAgentId } }}
              className="h-8 w-8 shrink-0 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              aria-label="View agent profile"
            >
              {avatarSrc && (
                <AvatarOrPlaceholder
                  src={avatarSrc}
                  className="h-8 w-8 rounded-full object-cover object-top"
                  placeholderClassName="h-8 w-8 rounded-full bg-muted"
                />
              )}
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
      {avatarSrc && (
        <AvatarOrPlaceholder
          src={avatarSrc}
          className="h-8 w-8 rounded-full object-cover object-top"
          placeholderClassName="h-8 w-8 rounded-full bg-muted"
        />
      )}
    </div>
  );
}

function PinPillButton() {
  const pageSignal = useGet(pageSignal$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const pinnedStatus = useLastResolved(currentChatAgentPinned$);
  const showPinPill = pinnedStatus === false;
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const pinSaving = pinLoadable.state === "loading";
  const currentChatAgentId = useResolved(currentChatAgentId$) ?? null;

  if (!showPinPill) {
    return null;
  }

  const handlePin = () => {
    if (!currentChatAgentId) {
      return;
    }
    detach(
      savePinnedIds([...pinnedIds, currentChatAgentId], pageSignal),
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

function ChatThreadHeader() {
  const displayName = useResolved(currentChatAgentDisplayName$);

  return (
    <header className="hidden sm:flex shrink-0 bg-transparent px-6 py-3 items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <HeaderAgentAvatar />
          <PinPillButton />
        </div>
        <span className="font-semibold text-foreground">{displayName}</span>
      </div>
      <div className="hidden sm:flex items-center gap-0.5" />
    </header>
  );
}

// ---------------------------------------------------------------------------
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

export function ZeroChatThreadPage() {
  const messagesLoadable = useLastLoadable(zeroChatMessages$);
  const messages =
    messagesLoadable.state === "hasData" ? messagesLoadable.data : [];
  const sessionError =
    messagesLoadable.state === "hasError"
      ? messagesLoadable.error instanceof Error
        ? messagesLoadable.error.message
        : "Failed to load chat"
      : null;
  const messagesLoading = messagesLoadable.state === "loading";
  const setScrollContainer = useSet(setChatScrollContainer$);

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-transparent">
      <ChatThreadHeader />

      {/* Scrollable area — messages + sticky composer share the same scroll context */}
      <div
        ref={setScrollContainer}
        data-scroll-container
        className="flex-1 overflow-y-auto [scrollbar-gutter:stable] flex flex-col min-h-0"
      >
        <main className="flex-1 px-4 sm:px-6 py-4 items-center @container">
          <div
            data-message-container
            className="w-full max-w-[900px] mx-auto flex flex-1 flex-col gap-6 pb-4 overflow-visible"
          >
            {sessionError && (
              <div className="flex-1 flex items-center justify-center py-16">
                <div className="flex items-center gap-2 text-destructive">
                  <IconAlertCircle size={16} />
                  <p className="text-sm">{sessionError}</p>
                </div>
              </div>
            )}
            {!sessionError && messages.length === 0 && messagesLoading && (
              <ChatSkeleton />
            )}
            {!sessionError && messages.length === 0 && !messagesLoading && (
              <div className="flex-1 flex items-center justify-center py-16">
                <p className="text-sm text-muted-foreground">
                  Send a message to start the conversation
                </p>
              </div>
            )}
            {messages.map((msg) => {
              return <ChatMessageRow key={msg.id} message={msg} />;
            })}
          </div>
        </main>

        {/* Composer — sticky inside the scroll container so it aligns with messages */}
        <ChatThreadComposer />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer wrapper — reads chat signals directly
// ---------------------------------------------------------------------------

function ChatThreadComposer() {
  const messagesLoadable = useLastLoadable(zeroChatMessages$);
  const hasMessages =
    messagesLoadable.state === "hasData" && messagesLoadable.data.length > 0;
  const displayName = useResolved(currentChatAgentDisplayName$) ?? "Zero";
  const allFinishedLoadable = useLoadable(allFinished$);
  const sending =
    allFinishedLoadable.state === "hasData" ? !allFinishedLoadable.data : true;
  const input = useGet(zeroChatInput$);
  const setInput = useSet(setZeroChatInput$);
  const clearInput = useSet(clearZeroChatInput$);
  const send = useSet(sendExistingThreadMessage$);
  const cancelRun = useSet(cancelActiveRun$);
  const pageSignal = useGet(pageSignal$);
  const attachments = useGet(zeroChatAttachments$);

  useAutoScroll(attachments.length);

  const handleSend = (text: string) => {
    clearInput();
    detach(send(text, pageSignal), Reason.DomCallback);
  };

  return (
    <footer
      data-chat-composer
      className="relative sticky bottom-0 z-10 shrink-0 px-4 sm:px-6 pt-3 pb-8 bg-[hsl(var(--background))]"
    >
      <div className="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
      <div className="mx-auto max-w-[900px]">
        <ZeroChatComposer
          className="w-full min-w-0"
          input={input}
          onInputChange={setInput}
          onSend={handleSend}
          sending={sending}
          onCancel={() => {
            detach(cancelRun(pageSignal), Reason.DomCallback);
          }}
          displayName={displayName}
          autoFocus={
            !hasMessages && !window.matchMedia("(pointer: coarse)").matches
          }
        />
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
// Chat message components
// ---------------------------------------------------------------------------

function ChatMessageRow({ message }: { message: ZeroChatMessage }) {
  return (
    <div data-role={message.role}>
      {message.role === "user" ? (
        <UserMessage message={message} />
      ) : (
        <AssistantMessage message={message} />
      )}
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

function isImageFilename(filename: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(filename);
}

function UserMessage({ message }: { message: UserChatMessage }) {
  const { cleanContent, parsed } = parseInlineAttachments(message.content);
  // Preserve user-entered line breaks: CommonMark collapses single newlines
  // into spaces, so convert each \n to a hard line break (two trailing spaces + \n).
  const displayContent = cleanContent.replace(/\n/g, "  \n");
  const lightboxUrl = useGet(attachmentLightboxUrl$);
  const setLightboxUrl = useSet(setAttachmentLightboxUrl$);

  // Merge explicit attachments with those parsed from content
  const allAttachments = [
    ...(message.attachments ?? []).map((a) => {
      return {
        filename: a.filename,
        url: a.url,
        isImage: a.contentType.startsWith("image/"),
      };
    }),
    ...parsed
      .filter((p) => {
        return !(message.attachments ?? []).some((a) => {
          return a.filename === p.filename;
        });
      })
      .map((p) => {
        return {
          filename: p.filename,
          url: p.url,
          isImage: isImageFilename(p.filename),
        };
      }),
  ];

  return (
    <div data-role="user">
      <div className="flex flex-col items-end min-w-0 animate-in fade-in slide-in-from-bottom-2 duration-300 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <div className="hidden @[900px]:block @[900px]:w-9 @[900px]:h-9 @[900px]:shrink-0" />
        <div className="flex flex-col items-end w-full">
          <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-sm leading-relaxed break-words overflow-hidden">
            <div className="px-4 py-3">
              <Markdown source={displayContent} />
            </div>
            {allAttachments.length > 0 && (
              <div className="border-t border-foreground/10 px-3 py-2.5 flex flex-wrap gap-2">
                {allAttachments.map((a) => {
                  return a.isImage ? (
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
                  ) : (
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

function deduplicateSummaries(summaries: string[]): string[] {
  const result: string[] = [];
  for (const s of summaries) {
    if (result[result.length - 1] !== s) {
      result.push(s);
    }
  }
  return result;
}

/** Live run activity rendered from a message's own runLoop signals. */
function MessageRunActivityLine({
  message,
}: {
  message: AssistantChatMessage;
}) {
  const summariesLoadable = useLastLoadable(message.summaries$!);
  const rawSummaries =
    summariesLoadable.state === "hasData" ? summariesLoadable.data : [];
  const detailLoadable = useLastLoadable(message.runLoop!.detail$);
  const runStatus =
    detailLoadable.state === "hasData" ? detailLoadable.data.status : null;
  const queueLoadable = useLastLoadable(message.runLoop!.queuePosition$);
  const queuePosition =
    queueLoadable.state === "hasData" ? queueLoadable.data : 0;
  const isQueued = runStatus === "queued";
  const thinkingMsg = useGet(thinkingMessage$);
  const openDrawer = useSet(openQueueDrawer$);

  if (isQueued) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <IconLoader2
          size={14}
          className="animate-spin text-muted-foreground shrink-0"
        />
        <p className="text-muted-foreground text-xs truncate">
          {queueLabel(queuePosition)}{" "}
          <button
            type="button"
            onClick={openDrawer}
            className="underline hover:text-foreground transition-colors"
          >
            View queue
          </button>
        </p>
      </div>
    );
  }

  if (rawSummaries.length === 0) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <IconLoader2
          size={14}
          className="animate-spin text-foreground/50 shrink-0"
        />
        <p className="zero-shimmer-text text-xs truncate">{thinkingMsg}</p>
      </div>
    );
  }

  const rawItems = deduplicateSummaries(rawSummaries);
  const items = rawItems.map((summary, position) => {
    return {
      key: `${position}-${summary}`,
      summary,
      isLast: position === rawItems.length - 1,
    };
  });

  return (
    <div className="relative flex flex-col gap-3">
      {items.length > 1 && (
        <div
          className="absolute left-[5.5px] top-[6px] bottom-[6px] pointer-events-none"
          aria-hidden
        >
          <div className="w-px h-full bg-border/60 zero-dashed-line" />
        </div>
      )}
      {items.map(({ key, summary, isLast }) => {
        return (
          <p
            key={key}
            className={`flex items-center gap-2.5 min-w-0 text-xs truncate animate-in fade-in slide-in-from-bottom-1 duration-300 ${
              isLast ? "" : "text-muted-foreground"
            }`}
          >
            <span className="h-3 w-3 shrink-0 flex items-center justify-center relative z-[1] rounded-full bg-card">
              {isLast ? (
                <IconLoader2
                  size={12}
                  className="animate-spin text-foreground/50"
                />
              ) : (
                <span
                  className="text-[8px] leading-none text-foreground/30"
                  aria-hidden
                >
                  ●
                </span>
              )}
            </span>
            <span
              className={`truncate ${isLast ? "zero-shimmer-text" : ""}`}
              aria-label={isLast ? "Current activity" : undefined}
            >
              {summary}
            </span>
          </p>
        );
      })}
    </div>
  );
}

function queueLabel(position: number): string {
  if (position <= 1) {
    return "In queue, waiting to start...";
  }
  return `In queue, ${position - 1} task${position - 1 === 1 ? "" : "s"} ahead...`;
}

function CollapsibleTimeline({ message }: { message: AssistantChatMessage }) {
  const expandedIds = useGet(timelineExpandedIds$);
  const expanded = expandedIds.has(message.id);
  const toggleExpanded = useSet(toggleTimelineExpanded$);
  const summaries = message.summaries ?? [];

  if (summaries.length === 0) {
    return null;
  }

  const rawItems = deduplicateSummaries(summaries);
  const items = rawItems.map((summary, position) => {
    return {
      key: `${position}-${summary}`,
      summary,
    };
  });

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => {
          return toggleExpanded(message.id);
        }}
        className="flex items-center justify-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors duration-150"
      >
        <IconChevronDown
          size={12}
          stroke={1.5}
          className={`shrink-0 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`}
        />
        <span className="font-medium">
          Took {items.length} step{items.length === 1 ? "" : "s"}
        </span>
      </button>
      {expanded && (
        <div className="relative flex flex-col gap-3 mt-2">
          {items.length > 1 && (
            <div
              className="absolute left-[5.5px] top-[6px] bottom-[6px] pointer-events-none"
              aria-hidden
            >
              <div className="w-px h-full zero-dashed-line" />
            </div>
          )}
          {items.map(({ key, summary }) => {
            return (
              <p
                key={key}
                className="flex items-center gap-2 min-w-0 text-xs text-muted-foreground truncate"
              >
                <span className="h-3 w-3 shrink-0 flex items-center justify-center relative z-[1] rounded-full bg-card">
                  <span
                    className="text-[8px] leading-none text-foreground/30"
                    aria-hidden
                  >
                    ●
                  </span>
                </span>
                <span className="truncate">{summary}</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AssistantMessage({ message }: { message: AssistantChatMessage }) {
  // Delegate to reactive variant when the message carries its own runLoop signals
  if (message.runLoop) {
    return <ReactiveAssistantMessage message={message} />;
  }
  return <StaticAssistantMessage message={message} />;
}

function failedRunErrorMessage(
  status: string | undefined,
  error: string | null | undefined,
): string {
  if (error) {
    return error;
  }
  if (status === "timeout") {
    return "Run timed out";
  }
  if (status === "cancelled") {
    return "Run cancelled.";
  }
  return "Run failed";
}

/** Assistant message with reactive result$/summaries$/detail$ from runLoop. */
function ReactiveAssistantMessage({
  message,
}: {
  message: AssistantChatMessage;
}) {
  const summariesLoadable = useLastLoadable(message.summaries$!);
  const summaries =
    summariesLoadable.state === "hasData" ? summariesLoadable.data : [];
  const detailLoadable = useLastLoadable(message.runLoop!.detail$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const isFailed =
    detail?.status === "failed" ||
    detail?.status === "timeout" ||
    detail?.status === "cancelled";
  // Build an enriched message with reactive content for the static renderer
  const enrichedMessage: AssistantChatMessage = {
    ...message,
    summaries: summaries.length > 0 ? summaries : message.summaries,
    status: detail?.status ?? undefined,
    error: isFailed
      ? failedRunErrorMessage(detail?.status, detail?.error)
      : undefined,
  };
  return <StaticAssistantMessage message={enrichedMessage} />;
}

function isRunActive(message: AssistantChatMessage): boolean {
  return (
    !!message.runLoop &&
    message.status !== "completed" &&
    message.status !== "failed" &&
    message.status !== "timeout" &&
    message.status !== "cancelled"
  );
}

function AssistantMessageActions({
  message,
  content,
}: {
  message: AssistantChatMessage;
  content: string;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(copiedMessageIdValue$);
  const copied = copiedId === message.id;
  const copyMessage = useSet(copyMessageContent$);

  if (!message.legacyRunId) {
    return null;
  }

  const handleCopy = () => {
    if (!content) {
      return;
    }
    detach(copyMessage(message.id, content, pageSignal), Reason.DomCallback);
  };

  return (
    <div className="@[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px]">
      <div className="hidden @[900px]:block" />
      <div className="flex items-center py-2 gap-1 -ml-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/activities/:id"
                options={{ pathParams: { id: message.legacyRunId } }}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-accent transition-colors duration-150"
                aria-label="View run logs"
              >
                <IconChartLine size={18} stroke={1.5} />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="bottom">View activity logs</TooltipContent>
          </Tooltip>
        </TooltipProvider>
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
      </div>
    </div>
  );
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
      <span>{error}</span>
    </div>
  );
}

function AssistantBubbleAvatar() {
  const avatarSrc = useResolved(currentChatAgentAvatarUrl$);
  return (
    <div className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 overflow-hidden rounded-xl">
      <AvatarOrPlaceholder
        src={avatarSrc}
        className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-full object-cover object-top"
        placeholderClassName="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-full bg-muted"
      />
    </div>
  );
}

function StaticAssistantMessage({
  message,
}: {
  message: AssistantChatMessage;
}) {
  const content = useLastResolved(message.result$) ?? "";

  useAutoScroll(content);

  const showActivityLine = isRunActive(message);
  const hasSummaries = message.summaries && message.summaries.length > 0;

  if (message.error) {
    return (
      <div
        data-role="assistant"
        className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
      >
        <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
          <AssistantBubbleAvatar />
          <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
            {hasSummaries && <CollapsibleTimeline message={message} />}
            <AssistantErrorContent error={message.error} />
          </div>
        </div>
        <AssistantMessageActions message={message} content={content} />
      </div>
    );
  }

  if (content) {
    return (
      <div className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
          <AssistantBubbleAvatar />
          <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
            {hasSummaries && <CollapsibleTimeline message={message} />}
            {showActivityLine && (
              <div className="mb-3 pb-3 border-b">
                <MessageRunActivityLine message={message} />
              </div>
            )}
            <Markdown source={content} />
            {message.cancelled && (
              <div className="mt-3 pt-3 border-t flex items-center gap-1.5 text-xs text-muted-foreground">
                <IconPlayerStop size={12} />
                <span>Cancelled</span>
              </div>
            )}
          </div>
        </div>
        <AssistantMessageActions message={message} content={content} />
      </div>
    );
  }

  // Thinking / loading state
  return (
    <div
      data-role="assistant"
      className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar />
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          {showActivityLine ? (
            <MessageRunActivityLine message={message} />
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <IconLoader2
                size={14}
                className="animate-spin text-foreground/50 shrink-0"
              />
              <p className="zero-shimmer-text text-xs truncate">Thinking...</p>
            </div>
          )}
        </div>
      </div>
      <AssistantMessageActions message={message} content={content} />
    </div>
  );
}
