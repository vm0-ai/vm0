import type { KeyboardEvent } from "react";
import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSend,
  IconAlertCircle,
  IconLoader2,
  IconArrowLeft,
  IconUsers,
  IconCalendar,
} from "@tabler/icons-react";
import { Button, Card, CardContent } from "@vm0/ui";
import { Markdown } from "../components/markdown.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroChatMessages$,
  zeroChatSending$,
  zeroChatInput$,
  zeroSessionError$,
  setZeroChatInput$,
  clearZeroChatInput$,
  sendZeroChatMessage$,
  type ZeroChatMessage,
} from "../../signals/zero-page/zero-chat.ts";

// ---------------------------------------------------------------------------
// ZeroSessionChatPage — real conversation backed by agent runs
// ---------------------------------------------------------------------------

interface ZeroSessionChatPageProps {
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
  onBack?: () => void;
  onNavigateToJob?: () => void;
  onNavigateToSchedule?: () => void;
}

export function ZeroSessionChatPage({
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
  onBack,
  onNavigateToJob,
  onNavigateToSchedule,
}: ZeroSessionChatPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const messages = useGet(zeroChatMessages$);
  const sending = useGet(zeroChatSending$);
  const sessionError = useGet(zeroSessionError$);
  const input = useGet(zeroChatInput$);
  const setInput = useSet(setZeroChatInput$);
  const clearInput = useSet(clearZeroChatInput$);
  const send = useSet(sendZeroChatMessage$);

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
    detach(send(trimmed), Reason.DomCallback);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
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
            className="h-8 w-8 shrink-0 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            aria-label="Switch Zero avatar"
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
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onNavigateToJob}
            aria-label="Sub-agents"
          >
            <IconUsers size={18} stroke={1.5} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={onNavigateToSchedule}
            aria-label="Schedule"
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
          {!sessionError && messages.length === 0 && (
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
              onAvatarClick={onAvatarClick}
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
                <textarea
                  className="w-full resize-none bg-transparent px-5 pt-4 pb-2 text-sm text-foreground placeholder:text-muted-foreground border-0 min-h-[88px] focus:outline-none focus:ring-0"
                  rows={3}
                  placeholder="Ask me to automate workflows, manage tasks..."
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  disabled={sending}
                />
                <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border/50">
                  <Button
                    size="sm"
                    className="rounded-lg h-9 w-9 p-0 shrink-0"
                    onClick={handleSend}
                    disabled={!input.trim() || sending}
                    aria-label="Send"
                  >
                    {sending ? (
                      <IconLoader2 size={16} className="animate-spin" />
                    ) : (
                      <IconSend size={16} stroke={2} />
                    )}
                  </Button>
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
// Chat message components
// ---------------------------------------------------------------------------

interface ChatMessageRowProps {
  message: ZeroChatMessage;
  zeroAvatarSrc: string;
  onAvatarClick?: () => void;
}

function ChatMessageRow({
  message,
  zeroAvatarSrc,
  onAvatarClick,
}: ChatMessageRowProps) {
  if (message.role === "user") {
    return <UserMessage content={message.content} />;
  }
  return (
    <AssistantMessage
      message={message}
      zeroAvatarSrc={zeroAvatarSrc}
      onAvatarClick={onAvatarClick}
    />
  );
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="grid grid-cols-[48px_1fr] gap-3 items-start animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="w-9 h-9 shrink-0" />
      <div className="flex min-w-0 justify-end">
        <div className="zero-chat-bubble-user rounded-2xl px-4 py-3 max-w-[85%] text-sm leading-relaxed">
          {content}
        </div>
      </div>
    </div>
  );
}

interface AssistantMessageProps {
  message: ZeroChatMessage;
  zeroAvatarSrc: string;
  onAvatarClick?: () => void;
}

function AssistantMessage({
  message,
  zeroAvatarSrc,
  onAvatarClick,
}: AssistantMessageProps) {
  const avatarButton = (
    <button
      type="button"
      onClick={onAvatarClick}
      className="h-9 w-9 shrink-0 mt-0.5 flex items-center justify-center overflow-hidden rounded-xl transition-colors duration-150 hover:bg-muted/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      aria-label="Switch Zero avatar"
    >
      <img
        src={zeroAvatarSrc}
        alt=""
        role="presentation"
        className="h-9 w-9 rounded-full object-cover object-top"
      />
    </button>
  );

  if (message.error) {
    return (
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start animate-in fade-in slide-in-from-bottom-2 duration-300">
        {avatarButton}
        <div className="zero-chat-bubble-assistant rounded-2xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0">
          <div className="flex items-start gap-1.5 text-destructive">
            <IconAlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{message.error}</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.content) {
    return (
      <div className="grid grid-cols-[48px_1fr] gap-3 items-start animate-in fade-in slide-in-from-bottom-2 duration-300">
        {avatarButton}
        <div className="zero-chat-bubble-assistant rounded-2xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0">
          <Markdown source={message.content} />
        </div>
      </div>
    );
  }

  // Thinking / loading state
  return (
    <div className="grid grid-cols-[48px_1fr] gap-3 items-start animate-in fade-in slide-in-from-bottom-2 duration-300">
      {avatarButton}
      <div className="zero-chat-bubble-assistant rounded-2xl border backdrop-blur-sm px-4 py-4 text-sm leading-relaxed min-w-0">
        <div className="flex items-center gap-2">
          <IconLoader2
            size={14}
            className="animate-spin text-muted-foreground"
          />
          <span className="text-muted-foreground">Thinking...</span>
        </div>
      </div>
    </div>
  );
}
