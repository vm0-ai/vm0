import type { MouseEvent } from "react";
import { useCCState, useCommand } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  IconAlertCircle,
  IconLoader2,
  IconArrowLeft,
  IconUsers,
  IconCalendar,
  IconX,
  IconPhoto,
  IconChartLine,
  IconPlayerStop,
  IconChevronDown,
  IconCopy,
  IconCheck,
  IconSettings,
} from "@tabler/icons-react";
import {
  Button,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { Markdown } from "../components/markdown.tsx";
import { detach, onRef, Reason } from "../../signals/utils.ts";
import { FileAttachmentChip } from "./zero-attachment-chips.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroChatMessages$,
  zeroChatSending$,
  zeroChatInput$,
  zeroSessionError$,
  zeroSessionSwitching$,
  setZeroChatInput$,
  clearZeroChatInput$,
  sendZeroChatMessage$,
  type ZeroChatMessage,
  zeroChatRunSummaries$,
  zeroChatRunStatus$,
  zeroChatQueuePosition$,
  cancelActiveRun$,
} from "../../signals/zero-page/zero-chat.ts";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { Link, SimpleLink } from "../router/link.tsx";
import zeroAvatarImg from "./assets/zero-avatar.png";

// ---------------------------------------------------------------------------
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

interface ZeroSessionChatPageProps {
  zeroAvatarSrc?: string;
  onBack?: () => void;
  onNavigateToSchedule?: () => void;
  onAvatarClick?: () => void;
  chatAgentName?: string;
}

export function ZeroSessionChatPage({
  zeroAvatarSrc = zeroAvatarImg,
  onBack,
  onNavigateToSchedule,
  onAvatarClick,
  chatAgentName,
}: ZeroSessionChatPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const defaultAgentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const agentName = chatAgentName ?? defaultAgentName;
  const messages = useGet(zeroChatMessages$);
  const sending = useGet(zeroChatSending$);
  const sessionError = useGet(zeroSessionError$);
  const sessionSwitching = useGet(zeroSessionSwitching$);
  const input = useGet(zeroChatInput$);
  const setInput = useSet(setZeroChatInput$);
  const clearInput = useSet(clearZeroChatInput$);
  const send = useSet(sendZeroChatMessage$);
  const cancelRun = useSet(cancelActiveRun$);
  const messagesEndEl$ = useCCState<HTMLDivElement | null>(null);
  const messagesEndEl = useGet(messagesEndEl$);
  const setMessagesEndEl = useSet(messagesEndEl$);

  // Auto-scroll when messages change (deferred to avoid side effect during render)
  if (messagesEndEl && messages.length > 0) {
    queueMicrotask(() => {
      messagesEndEl.scrollIntoView({ behavior: "smooth" });
    });
  }

  const handleSend = (text: string, opts?: { modelProvider: string }) => {
    clearInput();
    detach(send(text, opts), Reason.DomCallback);
  };

  return (
    <div className="flex flex-1 flex-col min-h-0 bg-transparent">
      {/* Header */}
      <header className="shrink-0 bg-transparent px-4 sm:px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 -ml-2"
            onClick={onBack}
            aria-label="Back to chat home"
          >
            <IconArrowLeft size={20} stroke={1.5} />
          </Button>
          <button
            type="button"
            onClick={onAvatarClick}
            className="h-8 w-8 shrink-0 overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="View agent profile"
          >
            <img
              src={zeroAvatarSrc}
              alt=""
              role="presentation"
              className="h-8 w-8 rounded-full object-cover object-top"
            />
          </button>
          <span className="font-semibold text-foreground">{agentName}</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Link
            pathname="/:tab"
            options={{ pathParams: { tab: "team" } }}
            className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent"
            aria-label="Sub-agents"
          >
            <IconUsers size={18} stroke={1.5} />
          </Link>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onNavigateToSchedule}
            aria-label="Scheduled"
          >
            <IconCalendar size={18} stroke={1.5} />
          </Button>
        </div>
      </header>

      {/* Scrollable area — messages + sticky composer share the same scroll context */}
      <div className="flex-1 overflow-auto flex flex-col min-h-0">
        <main className="flex-1 px-4 sm:px-6 py-4">
          <div className="mx-auto max-w-[900px] flex flex-col gap-6 pb-4">
            {sessionError && (
              <div className="flex-1 flex items-center justify-center py-16">
                <div className="flex items-center gap-2 text-destructive">
                  <IconAlertCircle size={16} />
                  <p className="text-sm">{sessionError}</p>
                </div>
              </div>
            )}
            {!sessionError && messages.length === 0 && sessionSwitching && (
              <ChatSkeleton />
            )}
            {!sessionError && messages.length === 0 && !sessionSwitching && (
              <div className="flex-1 flex items-center justify-center py-16">
                <p className="text-sm text-muted-foreground">
                  Send a message to start the conversation
                </p>
              </div>
            )}
            {messages.map((msg) => (
              <ChatMessageRow
                key={msg.id}
                message={msg}
                zeroAvatarSrc={zeroAvatarSrc}
              />
            ))}
            <div ref={setMessagesEndEl} />
          </div>
        </main>

        {/* Composer — sticky inside the scroll container so it aligns with messages */}
        <footer className="relative sticky bottom-0 shrink-0 px-4 sm:px-6 pt-3 pb-8 bg-[hsl(var(--background))]">
          <div className="pointer-events-none absolute inset-x-0 -top-5 h-5 bg-gradient-to-t from-[hsl(var(--background))] to-transparent" />
          <div className="mx-auto max-w-[900px] grid grid-cols-[36px_1fr] gap-2.5">
            <div className="w-9 shrink-0" />
            <ZeroChatComposer
              className="w-full min-w-0"
              input={input}
              onInputChange={setInput}
              onSend={handleSend}
              sending={sending}
              onCancel={() => void cancelRun()}
              agentName={agentName}
            />
          </div>
        </footer>
      </div>
    </div>
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
      <div className="grid grid-cols-[36px_1fr] gap-2.5 items-start">
        <Skeleton className="h-9 w-9 rounded-xl" />
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
      <div className="grid grid-cols-[36px_1fr] gap-2.5 items-start">
        <Skeleton className="h-9 w-9 rounded-xl" />
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

interface ChatMessageRowProps {
  message: ZeroChatMessage;
  zeroAvatarSrc: string;
}

function ChatMessageRow({ message, zeroAvatarSrc }: ChatMessageRowProps) {
  if (message.role === "user") {
    return <UserMessage message={message} />;
  }
  return <AssistantMessage message={message} zeroAvatarSrc={zeroAvatarSrc} />;
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

function UserMessage({ message }: { message: ZeroChatMessage }) {
  const { cleanContent, parsed } = parseInlineAttachments(message.content);
  // Preserve user-entered line breaks: CommonMark collapses single newlines
  // into spaces, so convert each \n to a hard line break (two trailing spaces + \n).
  const displayContent = cleanContent.replace(/\n/g, "  \n");
  const lightboxUrl$ = useCCState<string | null>(null);
  const lightboxUrl = useGet(lightboxUrl$);
  const setLightboxUrl = useSet(lightboxUrl$);

  // Merge explicit attachments with those parsed from content
  const allAttachments = [
    ...(message.attachments ?? []).map((a) => ({
      filename: a.filename,
      url: a.url,
      isImage: a.contentType.startsWith("image/"),
    })),
    ...parsed
      .filter(
        (p) =>
          !(message.attachments ?? []).some((a) => a.filename === p.filename),
      )
      .map((p) => ({
        filename: p.filename,
        url: p.url,
        isImage: isImageFilename(p.filename),
      })),
  ];

  return (
    <>
      <div className="grid grid-cols-[36px_1fr] gap-2.5 items-start animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="w-9 h-9 shrink-0" />
        <div className="flex flex-col items-end min-w-0">
          <div className="zero-chat-bubble-user rounded-xl max-w-[85%] text-sm leading-relaxed break-words overflow-hidden">
            <div className="px-4 py-3">
              <Markdown source={displayContent} />
            </div>
            {allAttachments.length > 0 && (
              <div className="border-t border-foreground/10 px-3 py-2.5 flex flex-wrap gap-2">
                {allAttachments.map((a) =>
                  a.isImage ? (
                    <button
                      key={a.url}
                      type="button"
                      onClick={() => setLightboxUrl(a.url)}
                      className="group relative rounded-lg overflow-hidden border border-foreground/10 hover:border-foreground/25 transition-colors"
                    >
                      <img
                        src={a.url}
                        alt={a.filename}
                        className="h-7 max-w-[56px] object-cover"
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
                  ),
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {lightboxUrl && (
        <ImageLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />
      )}
    </>
  );
}

function ImageLightbox({ url, onClose }: { url: string; onClose: () => void }) {
  const handleBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-in fade-in duration-200"
      onClick={handleBackdropClick}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        onClick={onClose}
        className="absolute top-4 right-4 p-2 rounded-full bg-black/50 text-white hover:bg-black/70 transition-colors"
        aria-label="Close"
      >
        <IconX size={20} stroke={2} />
      </button>
      <img
        src={url}
        alt=""
        className="max-h-[85vh] max-w-[90vw] rounded-lg shadow-2xl object-contain animate-in zoom-in-95 duration-200"
      />
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

const THINKING_MESSAGES = [
  "On it, grab a coffee",
  "Thinking hard...",
  "Cooking up something good...",
  "Give me a sec...",
  "Working my magic...",
  "Hang tight...",
  "Let me figure this out...",
  "Brewing ideas...",
  "Crunching the numbers...",
  "Just a moment...",
] as const;

function RunActivityLine() {
  const summariesLoadable = useLastLoadable(zeroChatRunSummaries$);
  const rawSummaries =
    summariesLoadable.state === "hasData" ? summariesLoadable.data : [];
  const runStatus = useGet(zeroChatRunStatus$);
  const queuePosition = useGet(zeroChatQueuePosition$);
  const isQueued = runStatus === "queued" || runStatus === "pending";

  const thinkingIndex$ = useCCState(
    Math.floor(Math.random() * THINKING_MESSAGES.length),
  );
  const thinkingIndex = useGet(thinkingIndex$);
  const thinkingMsg = THINKING_MESSAGES[thinkingIndex]!;

  const cycleThinking$ = useCommand(
    ({ set }, _el: HTMLDivElement, signal: AbortSignal) => {
      const id = window.setInterval(() => {
        set(thinkingIndex$, (prev) => (prev + 1) % THINKING_MESSAGES.length);
      }, 3000);
      signal.addEventListener("abort", () => {
        window.clearInterval(id);
      });
    },
  );
  const cycleRef$ = onRef(cycleThinking$);
  const cycleRef = useSet(cycleRef$);

  if (isQueued) {
    return (
      <div ref={cycleRef} className="flex items-center gap-2 min-w-0">
        <IconLoader2
          size={14}
          className="animate-spin text-muted-foreground shrink-0"
        />
        <p className="text-muted-foreground text-xs truncate">
          {queueLabel(queuePosition)}{" "}
          <SimpleLink
            href="/queue"
            className="underline hover:text-foreground transition-colors"
          >
            View queue
          </SimpleLink>
        </p>
      </div>
    );
  }

  if (rawSummaries.length === 0) {
    return (
      <div ref={cycleRef} className="flex items-center gap-2 min-w-0">
        <IconLoader2
          size={14}
          className="animate-spin text-foreground/50 shrink-0"
        />
        <p className="zero-shimmer-text text-xs truncate">{thinkingMsg}</p>
      </div>
    );
  }

  const items = deduplicateSummaries(rawSummaries);

  return (
    <div className="relative flex flex-col gap-3">
      {items.length > 1 && (
        <div
          className="absolute left-[5.5px] top-[6px] bottom-[6px] pointer-events-none"
          aria-hidden
        >
          <div
            className="w-px h-full bg-border/60"
            style={{
              backgroundImage:
                "repeating-linear-gradient(to bottom, transparent, transparent 2px, hsl(var(--border) / 0.6) 2px, hsl(var(--border) / 0.6) 5px)",
            }}
          />
        </div>
      )}
      {items.map((summary, idx) => {
        const isLast = idx === items.length - 1;
        return (
          <p
            key={`${idx}-${summary}`}
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
            <span className={`truncate ${isLast ? "zero-shimmer-text" : ""}`}>
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

function CollapsibleTimeline({ summaries }: { summaries: string[] }) {
  const expanded$ = useCCState(false);
  const expanded = useGet(expanded$);
  const setExpanded = useSet(expanded$);

  if (summaries.length === 0) {
    return null;
  }

  const items = deduplicateSummaries(summaries);

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
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
              <div
                className="w-px h-full"
                style={{
                  backgroundImage:
                    "repeating-linear-gradient(to bottom, transparent, transparent 2px, hsl(var(--border) / 0.6) 2px, hsl(var(--border) / 0.6) 5px)",
                }}
              />
            </div>
          )}
          {items.map((summary, idx) => (
            <p
              key={`${idx}-${summary}`}
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
          ))}
        </div>
      )}
    </div>
  );
}

interface AssistantMessageProps {
  message: ZeroChatMessage;
  zeroAvatarSrc: string;
}

function AssistantMessage({ message, zeroAvatarSrc }: AssistantMessageProps) {
  const avatar = (
    <div className="h-9 w-9 shrink-0 mt-0.5 overflow-hidden rounded-xl">
      <img
        src={zeroAvatarSrc}
        alt=""
        role="presentation"
        className="h-9 w-9 rounded-full object-cover object-top"
      />
    </div>
  );

  const hasSummaries = message.summaries && message.summaries.length > 0;

  const copied$ = useCCState(false);
  const copied = useGet(copied$);
  const setCopied = useSet(copied$);

  const handleCopy = () => {
    if (!message.content) {
      return;
    }
    navigator.clipboard.writeText(message.content).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const logButton = message.runId ? (
    <div className="grid grid-cols-[36px_1fr] gap-2.5">
      <div />
      <div className="flex py-2 gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150">
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <SimpleLink
                href={`/activity/${message.runId}`}
                className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
                aria-label="View run logs"
              >
                <IconChartLine size={18} stroke={1.5} />
              </SimpleLink>
            </TooltipTrigger>
            <TooltipContent side="bottom">View activity logs</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        {message.content && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="p-1 rounded-md text-muted-foreground/60 hover:text-foreground hover:bg-muted/50 transition-colors duration-150"
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
    const isNoModelProvider = message.error.includes(
      "No model provider configured",
    );
    return (
      <div className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="grid grid-cols-[36px_1fr] gap-2.5 items-start">
          {avatar}
          <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-0 pt-4 text-sm leading-relaxed min-w-0 break-words overflow-hidden">
            {hasSummaries && (
              <CollapsibleTimeline summaries={message.summaries!} />
            )}
            {isNoModelProvider ? (
              <div className="flex items-start gap-2 text-foreground">
                <IconAlertCircle
                  size={16}
                  className="shrink-0 mt-[3px] text-amber-500"
                />
                <span>
                  No model provider configured yet.{" "}
                  <Link
                    pathname="/:tab"
                    options={{ pathParams: { tab: "settings" } }}
                    className="inline-flex items-center gap-1 text-amber-500 underline underline-offset-2 hover:text-amber-400"
                  >
                    Set one up in Settings
                    <IconSettings size={13} />
                  </Link>{" "}
                  to get started.
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

  if (message.content) {
    return (
      <div className="group flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="grid grid-cols-[36px_1fr] gap-2.5 items-start">
          {avatar}
          <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-0 pt-4 text-sm leading-relaxed min-w-0 break-words overflow-hidden">
            {hasSummaries && (
              <CollapsibleTimeline summaries={message.summaries!} />
            )}
            <Markdown source={message.content} />
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
    <div className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="grid grid-cols-[36px_1fr] gap-2.5 items-start">
        {avatar}
        <div className="zero-chat-bubble-assistant rounded-xl backdrop-blur-sm py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          <RunActivityLine />
        </div>
      </div>
      {logButton}
    </div>
  );
}
