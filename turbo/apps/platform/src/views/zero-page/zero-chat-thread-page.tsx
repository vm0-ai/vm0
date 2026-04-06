import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
  useResolved,
} from "ccstate-react";
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
import { FileAttachmentChip, ImageLightbox } from "./zero-attachment-chips.tsx";
import {
  lightboxUrl$ as attachmentLightboxUrl$,
  setLightboxUrl$ as setAttachmentLightboxUrl$,
} from "../../signals/zero-page/zero-attachment-chips.ts";
import {
  agentDisplayName$,
  defaultAgentId$,
} from "../../signals/zero-page/zero-agent-name.ts";
import { zeroChatAgentId$ } from "../../signals/zero-page/zero-active-agent.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
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
} from "../../signals/zero-page/zero-chat.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { Link } from "../router/link.tsx";
import { setOrgManageDialogOpen$ } from "../../signals/zero-page/settings/org-manage-dialog.ts";
import { setActiveTab$ } from "../../signals/zero-page/settings/org-manage-tabs-state.ts";
import {
  timelineExpandedIds$,
  toggleTimelineExpanded$,
  copiedMessageIdValue$,
  copyMessageContent$,
} from "../../signals/zero-page/zero-session-chat-ui.ts";
import { useAgentAvatar } from "./zero-sidebar-shared.tsx";
import { zeroSubagents$ } from "../../signals/zero-page/zero-agents.ts";
function scrollToLatestMessage() {
  const scrollEl = document.querySelector<HTMLElement>(
    "[data-scroll-container]",
  );
  const container = document.querySelector<HTMLElement>(
    "[data-message-container]",
  );
  if (!scrollEl || !container) {
    return;
  }

  const children = container.children;
  if (children.length === 0) {
    return;
  }

  let lastUser: HTMLElement | null = null;
  let lastAssistant: HTMLElement | null = null;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i] as HTMLElement;
    const role = child.dataset.role;
    if (!lastAssistant && role === "assistant") {
      lastAssistant = child;
    }
    if (!lastUser && role === "user") {
      lastUser = child;
    }
    if (lastUser && lastAssistant) {
      break;
    }
  }

  if (!lastUser) {
    return;
  }

  const visibleHeight = scrollEl.clientHeight;
  const userTop = lastUser.offsetTop - container.offsetTop;

  if (lastAssistant && lastAssistant.offsetTop > lastUser.offsetTop) {
    const assistantBottom =
      lastAssistant.offsetTop -
      container.offsetTop +
      lastAssistant.offsetHeight;
    if (assistantBottom - userTop <= visibleHeight) {
      scrollEl.scrollTop = userTop;
    } else {
      scrollEl.scrollTop = assistantBottom - visibleHeight;
    }
  } else {
    scrollEl.scrollTop = userTop;
  }
}

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

// ---------------------------------------------------------------------------
// Shared hook: resolve current chat agent identity
// ---------------------------------------------------------------------------

function useChatAgentIdentity() {
  const chatAgentLoadable = useLastLoadable(zeroChatAgentId$);
  const currentChatAgentId =
    chatAgentLoadable.state === "hasData" ? chatAgentLoadable.data : null;
  const subagentsLoadable = useLastLoadable(zeroSubagents$);
  const subagents =
    subagentsLoadable.state === "hasData" ? subagentsLoadable.data : [];
  const selectedSubagent = currentChatAgentId
    ? subagents.find((a) => {
        return a.id === currentChatAgentId;
      })
    : null;
  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultRawName =
    defaultAgentIdLoadable.state === "hasData"
      ? defaultAgentIdLoadable.data
      : null;
  const resolvedAgentId = selectedSubagent?.id ?? defaultRawName;

  const defaultDisplayName = useResolved(agentDisplayName$) ?? "Zero";
  const displayName = selectedSubagent
    ? (selectedSubagent.displayName ?? selectedSubagent.id)
    : defaultDisplayName;
  const avatarSrc = useAgentAvatar(resolvedAgentId ?? "");

  return { currentChatAgentId, resolvedAgentId, displayName, avatarSrc };
}

// ---------------------------------------------------------------------------
// Header — reads signals directly
// ---------------------------------------------------------------------------

function ChatThreadHeader() {
  const { currentChatAgentId, resolvedAgentId, displayName, avatarSrc } =
    useChatAgentIdentity();
  const pageSignal = useGet(pageSignal$);

  // Pin pill
  const pinnedLoadable = useLastLoadable(pinnedAgentIds$);
  const pinnedIds =
    pinnedLoadable.state === "hasData" ? pinnedLoadable.data : [];
  const savePinnedIds = useSet(updatePinnedAgentIds$);
  const showPinPill =
    currentChatAgentId !== null && !pinnedIds.includes(currentChatAgentId);
  const handlePin = () => {
    if (currentChatAgentId) {
      detach(
        savePinnedIds([...pinnedIds, currentChatAgentId], pageSignal),
        Reason.DomCallback,
      );
    }
  };

  return (
    <header className="hidden sm:flex shrink-0 bg-transparent px-6 py-3 items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          {resolvedAgentId ? (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Link
                    pathname="/agents/:id"
                    options={{ pathParams: { id: resolvedAgentId } }}
                    className="h-8 w-8 shrink-0 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                    aria-label="View agent profile"
                  >
                    <AvatarOrPlaceholder
                      src={avatarSrc}
                      className="h-8 w-8 rounded-full object-cover object-top"
                      placeholderClassName="h-8 w-8 rounded-full bg-muted"
                    />
                  </Link>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">View agent profile</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : (
            <div className="h-8 w-8 shrink-0 overflow-hidden rounded-xl">
              <AvatarOrPlaceholder
                src={avatarSrc}
                className="h-8 w-8 rounded-full object-cover object-top"
                placeholderClassName="h-8 w-8 rounded-full bg-muted"
              />
            </div>
          )}
          {showPinPill && (
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onPointerDown={handlePin}
                    className="absolute -top-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full zero-border bg-background text-muted-foreground shadow-sm transition-colors hover:bg-accent hover:text-foreground hover:shadow-md cursor-pointer"
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
          )}
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

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-transparent">
      <ChatThreadHeader />

      {/* Scrollable area — messages + sticky composer share the same scroll context */}
      <div
        data-scroll-container
        className="flex-1 overflow-auto flex flex-col min-h-0"
      >
        <main className="flex-1 px-4 sm:px-6 py-4 items-center @container">
          <div
            data-message-container
            ref={(node) => {
              if (!node) {
                return;
              }
              const observer = new MutationObserver(() => {
                scrollToLatestMessage();
              });
              observer.observe(node, {
                childList: true,
                subtree: true,
                characterData: true,
              });
              return () => {
                observer.disconnect();
              };
            }}
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
        <ChatThreadComposer hasMessages={messages.length > 0} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer wrapper — reads chat signals directly
// ---------------------------------------------------------------------------

function ChatThreadComposer({ hasMessages }: { hasMessages: boolean }) {
  const { displayName } = useChatAgentIdentity();
  const allFinishedLoadable = useLoadable(allFinished$);
  const sending =
    allFinishedLoadable.state === "hasData" ? !allFinishedLoadable.data : true;
  const input = useGet(zeroChatInput$);
  const setInput = useSet(setZeroChatInput$);
  const clearInput = useSet(clearZeroChatInput$);
  const send = useSet(sendExistingThreadMessage$);
  const cancelRun = useSet(cancelActiveRun$);
  const pageSignal = useGet(pageSignal$);

  const handleSend = (text: string) => {
    clearInput();
    detach(send(text, pageSignal), Reason.DomCallback);
  };

  return (
    <footer className="relative sticky bottom-0 z-10 shrink-0 px-4 sm:px-6 pt-3 pb-8 bg-[hsl(var(--background))]">
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
          autoFocus={!hasMessages}
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
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-xl" />
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
        <Skeleton className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-xl" />
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
                      onPointerDown={() => {
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
  return (
    <RunActivityLineView
      summaries={rawSummaries}
      isQueued={isQueued}
      queuePosition={queuePosition}
      thinkingMsg={thinkingMsg}
    />
  );
}

/** Live run activity rendered from global signals (legacy path). */

function RunActivityLineView({
  summaries: rawSummaries,
  isQueued,
  queuePosition,
  thinkingMsg,
}: {
  summaries: string[];
  isQueued: boolean;
  queuePosition: number;
  thinkingMsg: string;
}) {
  if (isQueued) {
    return (
      <div className="flex items-center gap-2 min-w-0">
        <IconLoader2
          size={14}
          className="animate-spin text-muted-foreground shrink-0"
        />
        <p className="text-muted-foreground text-xs truncate">
          {queueLabel(queuePosition)}{" "}
          <Link
            pathname="/queues"
            className="underline hover:text-foreground transition-colors"
          >
            View queue
          </Link>
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

function CollapsibleTimeline({
  summaries,
  messageId,
}: {
  summaries: string[];
  messageId: string;
}) {
  const expandedIds = useGet(timelineExpandedIds$);
  const expanded = expandedIds.has(messageId);
  const toggleExpanded = useSet(toggleTimelineExpanded$);

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
        onPointerDown={() => {
          return toggleExpanded(messageId);
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
  const isTerminal = isFailed || detail?.status === "completed";

  // Build an enriched message with reactive content for the static renderer
  const enrichedMessage: AssistantChatMessage = {
    ...message,
    summaries: summaries.length > 0 ? summaries : message.summaries,
    status: detail?.status ?? undefined,
    error: isFailed
      ? failedRunErrorMessage(detail?.status, detail?.error)
      : undefined,
  };
  return (
    <StaticAssistantMessage
      message={enrichedMessage}
      renderActivityLine={
        !isTerminal ? <MessageRunActivityLine message={message} /> : undefined
      }
    />
  );
}

function StaticAssistantMessage({
  message,
  renderActivityLine,
}: {
  message: AssistantChatMessage;
  renderActivityLine?: React.ReactNode;
}) {
  const { avatarSrc } = useChatAgentIdentity();
  const setOrgManageOpen = useSet(setOrgManageDialogOpen$);
  const setTab = useSet(setActiveTab$);
  const pageSignal = useGet(pageSignal$);
  const content = useLastResolved(message.result$) ?? "";
  const avatar = (
    <div className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 shrink-0 @[900px]:mt-0.5 overflow-hidden rounded-xl">
      <AvatarOrPlaceholder
        src={avatarSrc}
        className="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-full object-cover object-top"
        placeholderClassName="h-7 w-7 @[900px]:h-9 @[900px]:w-9 rounded-full bg-muted"
      />
    </div>
  );

  const hasSummaries = message.summaries && message.summaries.length > 0;

  const copiedId = useGet(copiedMessageIdValue$);
  const copied = copiedId === message.id;
  const copyMessage = useSet(copyMessageContent$);

  const handleCopy = () => {
    if (!content) {
      return;
    }
    detach(copyMessage(message.id, content), Reason.DomCallback);
  };

  const logButton = message.legacyRunId ? (
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
                  onPointerDown={handleCopy}
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
  ) : null;

  if (message.error) {
    const noProviderGuidance = RUN_ERROR_GUIDANCE.NO_MODEL_PROVIDER;
    const isNoModelProvider =
      noProviderGuidance !== undefined &&
      message.error
        .toLowerCase()
        .includes(noProviderGuidance.title.toLowerCase());
    const incompatibleGuidance = RUN_ERROR_GUIDANCE.PROVIDER_INCOMPATIBLE;
    const isProviderIncompatible =
      (incompatibleGuidance !== undefined &&
        message.error
          .toLowerCase()
          .includes(incompatibleGuidance.title.toLowerCase())) ||
      message.error.includes("Cannot continue session") ||
      message.error.includes("Invalid signature in thinking block");
    return (
      <div
        data-role="assistant"
        className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
      >
        <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
          {avatar}
          <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
            {hasSummaries && (
              <CollapsibleTimeline
                summaries={message.summaries!}
                messageId={message.id}
              />
            )}
            {isNoModelProvider ? (
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
                    onPointerDown={() => {
                      setTab("providers");
                      setOrgManageOpen(true, pageSignal).catch(() => {
                        return undefined;
                      });
                    }}
                  >
                    Set one up in Workspace Settings
                  </button>{" "}
                  to get started.
                </span>
              </div>
            ) : isProviderIncompatible ? (
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
            ) : (
              <div className="flex items-start gap-2 text-destructive">
                <IconAlertCircle size={16} className="shrink-0 mt-[3px]" />
                <span>{message.error}</span>
              </div>
            )}
          </div>
        </div>
        {logButton}
      </div>
    );
  }

  if (content) {
    return (
      <div className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
          {avatar}
          <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
            {hasSummaries && (
              <CollapsibleTimeline
                summaries={message.summaries!}
                messageId={message.id}
              />
            )}
            {renderActivityLine && (
              <div className="mb-3 pb-3 border-b">{renderActivityLine}</div>
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
        {logButton}
      </div>
    );
  }

  // Thinking / loading state — show live run activity
  return (
    <div
      data-role="assistant"
      className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        {avatar}
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          {renderActivityLine ?? (
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
      {logButton}
    </div>
  );
}
