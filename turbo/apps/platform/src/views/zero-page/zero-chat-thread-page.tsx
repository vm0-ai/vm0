import {
  useGet,
  useSet,
  useLoadable,
  useLastLoadable,
  useLastResolved,
} from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { pageSignal$ } from "../../signals/page-signal.ts";
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
import { openQueueDrawer$ } from "../../signals/queue-page/queue-drawer-state.ts";
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
  ZeroChatMessage,
  UserChatMessage,
  AssistantChatMessage,
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
  const messagesLoadable = useLastLoadable(thread.messages$);
  const messages =
    messagesLoadable.state === "hasData" ? messagesLoadable.data : [];
  const sessionError =
    messagesLoadable.state === "hasError"
      ? messagesLoadable.error instanceof Error
        ? messagesLoadable.error.message
        : "Failed to load chat"
      : null;
  const messagesLoading = messagesLoadable.state === "loading";
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
            {groupMessagesByRun(messages).map((entry) => {
              if (Array.isArray(entry)) {
                return (
                  <AssistantMessageGroup
                    key={entry[0].id}
                    messages={entry}
                    thread={thread}
                  />
                );
              }
              return (
                <ChatMessageRow
                  key={entry.id}
                  message={entry}
                  thread={thread}
                />
              );
            })}
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
  const messagesLoadable = useLastLoadable(thread.messages$);
  const hasMessages =
    messagesLoadable.state === "hasData" && messagesLoadable.data.length > 0;
  const displayName = useLastResolved(thread.agentDisplayName$) ?? "Zero";
  const allFinishedLoadable = useLoadable(thread.allFinished$);
  const sending =
    allFinishedLoadable.state === "hasData" ? !allFinishedLoadable.data : true;
  const input = useGet(thread.draft.input$);
  const setInput = useSet(thread.draft.setInput$);
  const send = useSet(thread.sendMessage$);
  const cancelRun = useSet(thread.cancelRun$);
  const setInputRef = useSet(thread.setInputRef$);
  const scheduleDraftSync = useSet(thread.scheduleDraftSync$);
  const pageSignal = useGet(pageSignal$);

  const handleInputChange = (text: string) => {
    setInput(text);
    scheduleDraftSync(pageSignal);
  };

  const handleDraftChange = () => {
    scheduleDraftSync(pageSignal);
  };

  const handleSend = (text: string) => {
    setInput("");
    detach(send(text, pageSignal), Reason.DomCallback);
  };

  return (
    <footer
      data-chat-composer
      className="relative shrink-0 px-4 sm:px-6 pt-3 pb-8 bg-[hsl(var(--background))]"
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
// Message grouping — consecutive assistant messages with the same runId
// are rendered inside a single block that shares one avatar and hover state.
// ---------------------------------------------------------------------------

function groupMessagesByRun(
  messages: ZeroChatMessage[],
): (ZeroChatMessage | AssistantChatMessage[])[] {
  const result: (ZeroChatMessage | AssistantChatMessage[])[] = [];
  let currentGroup: AssistantChatMessage[] = [];

  function flushGroup() {
    if (currentGroup.length === 0) {
      return;
    }
    if (currentGroup.length === 1) {
      result.push(currentGroup[0]);
    } else {
      result.push([...currentGroup]);
    }
    currentGroup = [];
  }

  for (const msg of messages) {
    if (msg.role === "assistant" && msg.legacyRunId) {
      if (
        currentGroup.length > 0 &&
        currentGroup[0].legacyRunId === msg.legacyRunId
      ) {
        currentGroup.push(msg);
      } else {
        flushGroup();
        currentGroup = [msg];
      }
    } else {
      flushGroup();
      result.push(msg);
    }
  }
  flushGroup();
  return result;
}

// ---------------------------------------------------------------------------
// Chat message components
// ---------------------------------------------------------------------------

function ChatMessageRow({
  message,
  thread,
}: {
  message: ZeroChatMessage;
  thread: ChatThreadSignals;
}) {
  return (
    <div data-role={message.role}>
      {message.role === "user" ? (
        <UserMessage message={message} />
      ) : (
        <AssistantMessage message={message} thread={thread} />
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
            {displayContent && (
              <div className="px-4 py-3">
                <Markdown source={displayContent} />
              </div>
            )}
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
  thread,
}: {
  message: AssistantChatMessage;
  thread: ChatThreadSignals;
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
  const thinkingMsg = useGet(thread.thinkingMessage$);
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

function AssistantMessage({
  message,
  thread,
}: {
  message: AssistantChatMessage;
  thread: ChatThreadSignals;
}) {
  // Delegate to reactive variant when the message carries its own runLoop signals
  if (message.runLoop) {
    return <ReactiveAssistantMessage message={message} thread={thread} />;
  }
  return <StaticAssistantMessage message={message} thread={thread} />;
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
  thread,
}: {
  message: AssistantChatMessage;
  thread: ChatThreadSignals;
}) {
  const detailLoadable = useLastLoadable(message.runLoop!.detail$);
  const detail =
    detailLoadable.state === "hasData" ? detailLoadable.data : null;
  const isFailed =
    detail?.status === "failed" ||
    detail?.status === "timeout" ||
    detail?.status === "cancelled";

  // Only fall back to static rendering for failures — show error UI
  if (isFailed) {
    const enrichedMessage: AssistantChatMessage = {
      ...message,
      status: detail?.status ?? undefined,
      error: failedRunErrorMessage(detail?.status, detail?.error),
    };
    return <StaticAssistantMessage message={enrichedMessage} thread={thread} />;
  }

  // Active or just-completed: render from the event stream.
  // On completion the texts$ stay stable until reloadThread$ replaces with
  // server-side grouped messages, avoiding the flash of a single result$.
  const active = detail?.status !== "completed";
  return (
    <ReactiveRunContent message={message} thread={thread} active={active} />
  );
}

/**
 * Renders all intermediate text outputs from the event stream.
 * When `active` is true, an activity line is appended at the bottom.
 */
function ReactiveRunContent({
  message,
  thread,
  active,
}: {
  message: AssistantChatMessage;
  thread: ChatThreadSignals;
  active: boolean;
}) {
  const texts = useLastResolved(message.texts$!) ?? [];
  const lastContent = texts[texts.length - 1] ?? "";

  return (
    <div className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="flex flex-col gap-3">
          {texts.map((text) => {
            return (
              <div
                key={text}
                className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words animate-in fade-in slide-in-from-bottom-1 duration-300"
              >
                <Markdown source={text} />
              </div>
            );
          })}
          {active && (
            <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
              <MessageRunActivityLine message={message} thread={thread} />
            </div>
          )}
        </div>
      </div>
      <AssistantMessageActions
        message={message}
        content={lastContent}
        thread={thread}
      />
    </div>
  );
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
  thread,
}: {
  message: AssistantChatMessage;
  content: string;
  thread: ChatThreadSignals;
}) {
  const pageSignal = useGet(pageSignal$);
  const copiedId = useGet(thread.copiedMessageId$);
  const copied = copiedId === message.id;
  const copyMessage = useSet(thread.copyMessage$);

  const features = useLastResolved(featureSwitch$);
  const audioIOEnabled = features?.[FeatureSwitchKey.AudioIO] ?? false;
  const playingRunId = useGet(ttsPlayingRunId$);
  const isPlayingThis = playingRunId === message.legacyRunId;
  const playTts = useSet(playTts$);
  const stopTts = useSet(stopTts$);

  if (!message.legacyRunId || isRunActive(message)) {
    return null;
  }

  const handleCopy = () => {
    if (!content) {
      return;
    }
    detach(copyMessage(message.id, content, pageSignal), Reason.DomCallback);
  };

  const handleTts = () => {
    if (isPlayingThis) {
      detach(stopTts(), Reason.DomCallback);
    } else {
      detach(
        playTts(message.legacyRunId!, content, pageSignal),
        Reason.DomCallback,
      );
    }
  };

  return (
    <div className="@[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px]">
      <div className="hidden @[900px]:block" />
      <div className="flex items-center py-2 gap-1 -ml-1 opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 transition-opacity duration-150">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                pathname="/activities/:activityRunId"
                options={{ pathParams: { activityRunId: message.legacyRunId } }}
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
        {content && audioIOEnabled && (
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

function StaticAssistantMessage({
  message,
  thread,
}: {
  message: AssistantChatMessage;
  thread: ChatThreadSignals;
}) {
  const content = useLastResolved(message.result$) ?? "";

  const showActivityLine = isRunActive(message);

  if (message.error) {
    return (
      <div
        data-role="assistant"
        className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
      >
        <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
          <AssistantBubbleAvatar thread={thread} />
          <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
            <AssistantErrorContent error={message.error} />
          </div>
        </div>
        <AssistantMessageActions
          message={message}
          content={content}
          thread={thread}
        />
      </div>
    );
  }

  if (content && !showActivityLine) {
    return (
      <div className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
          <AssistantBubbleAvatar thread={thread} />
          <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
            <Markdown source={content} />
            {message.cancelled && (
              <div className="mt-3 pt-3 border-t flex items-center gap-1.5 text-xs text-muted-foreground">
                <IconPlayerStop size={12} />
                <span>Cancelled</span>
              </div>
            )}
          </div>
        </div>
        <AssistantMessageActions
          message={message}
          content={content}
          thread={thread}
        />
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
        <AssistantBubbleAvatar thread={thread} />
        <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          {showActivityLine ? (
            <MessageRunActivityLine message={message} thread={thread} />
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
      <AssistantMessageActions
        message={message}
        content={content}
        thread={thread}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grouped assistant messages — multiple messages from the same run rendered
// inside a single block with one avatar and shared hover state.
// ---------------------------------------------------------------------------

function AssistantMessageGroupItem({
  message,
  thread,
}: {
  message: AssistantChatMessage;
  thread: ChatThreadSignals;
}) {
  const content = useLastResolved(message.result$) ?? "";
  const showActivityLine = isRunActive(message);

  if (message.error) {
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
        <AssistantErrorContent error={message.error} />
      </div>
    );
  }

  if (content && !showActivityLine) {
    return (
      <div className="zero-chat-bubble-assistant px-0 @[900px]:pt-2.5 text-sm leading-relaxed min-w-0 break-words">
        <Markdown source={content} />
      </div>
    );
  }

  return (
    <div className="zero-chat-bubble-assistant rounded-xl py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
      {showActivityLine ? (
        <MessageRunActivityLine message={message} thread={thread} />
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
  );
}

function AssistantMessageGroup({
  messages,
  thread,
}: {
  messages: AssistantChatMessage[];
  thread: ChatThreadSignals;
}) {
  // Use the last message for action buttons (view logs link, copy, TTS).
  // The last message's result$ is used as action content; when the group has
  // multiple completed texts the user can copy individually via selection.
  const lastMessage = messages[messages.length - 1];
  const lastContent = useLastResolved(lastMessage.result$) ?? "";

  return (
    <div className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="flex flex-col gap-2 @[900px]:grid @[900px]:grid-cols-[36px_1fr] @[900px]:gap-2.5 @[900px]:-ml-[46px] @[900px]:items-start">
        <AssistantBubbleAvatar thread={thread} />
        <div className="flex flex-col gap-3">
          {messages.map((msg) => {
            return (
              <AssistantMessageGroupItem
                key={msg.id}
                message={msg}
                thread={thread}
              />
            );
          })}
        </div>
      </div>
      <AssistantMessageActions
        message={lastMessage}
        content={lastContent}
        thread={thread}
      />
    </div>
  );
}
