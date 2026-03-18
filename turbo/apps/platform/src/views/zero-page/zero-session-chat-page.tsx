import type { ChangeEvent, MouseEvent } from "react";
import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable, useLastLoadable } from "ccstate-react";
import {
  IconSend,
  IconPaperclip,
  IconAlertCircle,
  IconLoader2,
  IconArrowLeft,
  IconUsers,
  IconCalendar,
  IconX,
  IconPhoto,
  IconChartLine,
  IconPlayerStop,
} from "@tabler/icons-react";
import {
  Button,
  Card,
  CardContent,
  Skeleton,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@vm0/ui";
import { Markdown } from "../components/markdown.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  FileAttachmentChip,
  AttachmentChip,
} from "./zero-attachment-chips.tsx";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroChatMessages$,
  zeroChatSending$,
  zeroChatInput$,
  zeroChatAttachments$,
  zeroSessionError$,
  zeroSessionSwitching$,
  setZeroChatInput$,
  clearZeroChatInput$,
  sendZeroChatMessage$,
  uploadZeroAttachment$,
  removeZeroAttachment$,
  type ZeroChatMessage,
  zeroChatRunSummaries$,
  zeroChatRunStatus$,
  zeroChatQueuePosition$,
  cancelActiveRun$,
} from "../../signals/zero-page/zero-chat.ts";
import { useModelSelection } from "./zero-model-preference.ts";
import { useSendKeyHandler } from "./zero-send-key.ts";
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
  const attachments = useGet(zeroChatAttachments$);
  const uploadAttachment = useSet(uploadZeroAttachment$);
  const removeAttachment = useSet(removeZeroAttachment$);
  const fileInputEl$ = useCCState<HTMLInputElement | null>(null);
  const fileInputEl = useGet(fileInputEl$);
  const setFileInputEl = useSet(fileInputEl$);

  // Model provider selector (shared logic)
  const { modelOptions, selectedModel, setSelectedModel, persistSelection } =
    useModelSelection(agentName);

  const messagesEndEl$ = useCCState<HTMLDivElement | null>(null);
  const messagesEndEl = useGet(messagesEndEl$);
  const setMessagesEndEl = useSet(messagesEndEl$);

  // Auto-scroll when messages change (deferred to avoid side effect during render)
  if (messagesEndEl && messages.length > 0) {
    queueMicrotask(() => {
      messagesEndEl.scrollIntoView({ behavior: "smooth" });
    });
  }

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || sending) {
      return;
    }
    clearInput();
    persistSelection();
    const opts =
      selectedModel !== "default"
        ? { modelProvider: selectedModel }
        : undefined;
    detach(send(trimmed, opts), Reason.DomCallback);
  };

  const handleKeyDown = useSendKeyHandler(handleSend);

  const handleFileSelect = () => {
    fileInputEl?.click();
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) {
      return;
    }
    for (const file of files) {
      detach(uploadAttachment(file), Reason.DomCallback);
    }
    // Reset so same file can be selected again
    e.target.value = "";
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

      {/* Message list */}
      <main className="flex-1 overflow-auto px-4 sm:px-6 py-4">
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

      {/* Composer */}
      <footer className="shrink-0 bg-transparent px-4 sm:px-6 pt-4 pb-8">
        <div className="mx-auto max-w-[900px] grid grid-cols-[48px_1fr] gap-3">
          <div className="w-9 shrink-0" />
          <Card className="zero-composer w-full min-w-0 overflow-hidden transition-colors duration-200">
            <CardContent className="p-0">
              <div className="flex flex-col">
                {attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2 px-5 pt-3">
                    {attachments.map((a) => (
                      <AttachmentChip
                        key={a.id}
                        attachment={a}
                        onRemove={() => removeAttachment(a.id)}
                      />
                    ))}
                  </div>
                )}
                <textarea
                  className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
                  rows={3}
                  placeholder="Ask me to automate workflows, manage tasks..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                />
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                  <div className="flex items-center gap-1 text-muted-foreground">
                    <input
                      ref={setFileInputEl}
                      type="file"
                      className="hidden"
                      accept="image/*,.pdf,.txt,.csv,.md,.json"
                      multiple
                      onChange={handleFileChange}
                    />
                    <button
                      type="button"
                      className="p-2 rounded-lg hover:bg-muted/60 hover:text-foreground transition-colors duration-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      aria-label="Attach file"
                      onClick={handleFileSelect}
                    >
                      <IconPaperclip size={18} stroke={1.5} />
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedModel}
                      onValueChange={setSelectedModel}
                    >
                      <SelectTrigger className="h-9 min-w-[140px] rounded-lg border-border bg-transparent text-sm text-foreground">
                        <SelectValue placeholder="Model" />
                      </SelectTrigger>
                      <SelectContent>
                        {modelOptions.map((opt) => (
                          <SelectItem
                            key={opt.value}
                            value={opt.value}
                            className="text-sm"
                          >
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {sending ? (
                      <Button
                        size="sm"
                        variant="destructive"
                        className="rounded-lg h-9 w-9 p-0 shrink-0"
                        onClick={() => void cancelRun()}
                        aria-label="Stop"
                      >
                        <IconPlayerStop size={16} />
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        className="rounded-lg h-9 w-9 p-0 shrink-0"
                        onClick={handleSend}
                        disabled={!input.trim()}
                        aria-label="Send"
                      >
                        <IconSend size={16} stroke={2} />
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </footer>
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
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        <div className="w-9 h-9 shrink-0" />
        <div className="flex min-w-0 justify-end">
          <Skeleton className="h-10 w-[60%] rounded-xl" />
        </div>
      </div>
      {/* Assistant bubble skeleton */}
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        <Skeleton className="h-9 w-9 rounded-xl" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-[90%] rounded-lg" />
          <Skeleton className="h-4 w-[75%] rounded-lg" />
          <Skeleton className="h-4 w-[40%] rounded-lg" />
        </div>
      </div>
      {/* User bubble skeleton */}
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        <div className="w-9 h-9 shrink-0" />
        <div className="flex min-w-0 justify-end">
          <Skeleton className="h-10 w-[45%] rounded-xl" />
        </div>
      </div>
      {/* Assistant bubble skeleton */}
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
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
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start animate-in fade-in slide-in-from-bottom-2 duration-300">
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

function RunActivityLine() {
  const summariesLoadable = useLastLoadable(zeroChatRunSummaries$);
  const summaries =
    summariesLoadable.state === "hasData" ? summariesLoadable.data : [];
  const latest = summaries.length > 0 ? summaries[summaries.length - 1] : null;
  const runStatus = useGet(zeroChatRunStatus$);
  const queuePosition = useGet(zeroChatQueuePosition$);
  const isQueued = runStatus === "queued" || runStatus === "pending";

  const label = isQueued
    ? queueLabel(queuePosition)
    : (latest ?? "Thinking...");

  return (
    <div className="flex items-center gap-2 min-w-0">
      <IconLoader2
        size={14}
        className="animate-spin text-muted-foreground shrink-0"
      />
      <div className="min-w-0 flex-1 overflow-hidden">
        <p
          key={label}
          className="text-muted-foreground truncate animate-in fade-in slide-in-from-bottom-1 duration-300"
        >
          {isQueued ? (
            <>
              {label}{" "}
              <SimpleLink
                href="/queue"
                className="underline hover:text-foreground transition-colors"
              >
                View queue
              </SimpleLink>
            </>
          ) : (
            label
          )}
        </p>
      </div>
    </div>
  );
}

function queueLabel(position: number): string {
  if (position <= 1) {
    return "In queue, waiting to start...";
  }
  return `In queue, ${position - 1} task${position - 1 === 1 ? "" : "s"} ahead...`;
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

  const logButton = message.runId ? (
    <div className="grid grid-cols-[48px_1fr] gap-3">
      <div />
      <div className="flex">
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
      </div>
    </div>
  ) : null;

  if (message.error) {
    return (
      <div className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
          {avatar}
          <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0 break-words overflow-hidden">
            <div className="flex items-start gap-2 text-destructive">
              <IconAlertCircle size={16} className="shrink-0 mt-[3px]" />
              <span>{message.error}</span>
            </div>
          </div>
        </div>
        {logButton}
      </div>
    );
  }

  if (message.content) {
    return (
      <div className="flex flex-col gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
          {avatar}
          <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0 break-words overflow-hidden">
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
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start">
        {avatar}
        <div className="zero-chat-bubble-assistant rounded-xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0 overflow-hidden">
          <RunActivityLine />
        </div>
      </div>
      {logButton}
    </div>
  );
}
