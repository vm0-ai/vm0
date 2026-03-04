import { useGet, useSet } from "ccstate-react";
import {
  IconX,
  IconLoader2,
  IconAlertCircle,
  IconChevronDown,
  IconPlus,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverClose,
} from "@vm0/ui/components/ui/popover";
import { Markdown } from "../components/markdown.tsx";
import { StatusDot } from "../logs-page/components/status-dot.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import {
  chatMessages$,
  chatSending$,
  closeChatPanel$,
  sendChatMessage$,
  chatInput$,
  setChatInput$,
  clearChatInput$,
  sessionList$,
  sessionListLoading$,
  switchSession$,
  startNewSession$,
  currentSessionId$,
  type ChatMessage,
  type SessionListItem,
} from "../../signals/agent-detail/chat.ts";
import { agentName$ } from "../../signals/agent-detail/agent-detail.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) {
    return "Just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(dateStr).toLocaleDateString();
}

// ---------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------

export function ChatPanel() {
  const messages = useGet(chatMessages$);
  const sending = useGet(chatSending$);
  const close = useSet(closeChatPanel$);
  const send = useSet(sendChatMessage$);
  const input = useGet(chatInput$);
  const setInputValue = useSet(setChatInput$);
  const clearInput = useSet(clearChatInput$);
  const agentName = useGet(agentName$);
  const sessions = useGet(sessionList$);
  const sessionsLoading = useGet(sessionListLoading$);
  const switchTo = useSet(switchSession$);
  const newSession = useSet(startNewSession$);
  const activeSessionId = useGet(currentSessionId$);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || sending) {
      return;
    }
    clearInput();
    detach(send(trimmed), Reason.DomCallback);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="rounded-lg border border-border overflow-hidden flex flex-col h-full bg-sidebar">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border shrink-0 bg-card">
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Session history"
            >
              Chat
              <IconChevronDown size={14} />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-1">
            <SessionDropdown
              sessions={sessions}
              loading={sessionsLoading}
              activeSessionId={activeSessionId}
              onSelect={(id) => detach(switchTo(id), Reason.DomCallback)}
              onNew={() => newSession()}
            />
          </PopoverContent>
        </Popover>
        <span className="text-xs text-muted-foreground truncate">
          {agentName}
        </span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => newSession()}
          aria-label="New chat"
        >
          <IconPlus size={16} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => close()}
          aria-label="Close chat panel"
        >
          <IconX size={16} />
        </Button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-3 md:p-4">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-muted-foreground">
              Send a message to start chatting
            </p>
          </div>
        ) : (
          messages.map((msg) => <ChatMessageRow key={msg.id} message={msg} />)
        )}
      </div>

      {/* Input area */}
      <div className="px-3 pb-3 md:px-4 md:pb-4 shrink-0">
        <div className="flex items-end gap-2 md:gap-2.5 rounded-md border border-border bg-background p-3 md:p-4">
          <textarea
            className="flex-1 resize-none bg-transparent text-sm text-secondary-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            rows={2}
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <Button
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="shrink-0 rounded-lg px-4 py-2 h-9"
          >
            {sending ? (
              <IconLoader2 size={16} className="mr-1 animate-spin" />
            ) : null}
            Chat
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatMessage — renders a single user or assistant message (logs-detail style)
// ---------------------------------------------------------------------------

function ChatMessageRow({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return <UserMessage content={message.content} />;
  }
  return <AssistantMessage message={message} />;
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="py-2">
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 [&_*]:!text-primary-foreground">
          <Markdown source={content} />
        </div>
      </div>
    </div>
  );
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  if (message.error) {
    return (
      <div className="py-2">
        <div className="flex gap-2 items-start">
          <StatusDot variant="error" className="mt-1.5" />
          <div className="flex-1 min-w-0">
            <div className="flex items-start gap-1.5 text-sm text-destructive">
              <IconAlertCircle size={14} className="shrink-0 mt-0.5" />
              <span>{message.error}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (message.content) {
    return (
      <div className="py-2">
        <div className="flex gap-2 items-start">
          <StatusDot variant="success" className="mt-1.5" />
          <div className="flex-1 min-w-0">
            <Markdown source={message.content} />
          </div>
        </div>
      </div>
    );
  }

  // Waiting: run in progress or output still loading
  return (
    <div className="py-2">
      <div className="flex gap-2 items-center">
        <StatusDot variant="pending" className="animate-pulse" />
        <span className="text-sm text-muted-foreground">Thinking...</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SessionDropdown — session list inside popover
// ---------------------------------------------------------------------------

function SessionDropdown({
  sessions,
  loading,
  activeSessionId,
  onSelect,
  onNew,
}: {
  sessions: SessionListItem[];
  loading: boolean;
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  return (
    <div className="flex flex-col">
      <PopoverClose asChild>
        <button
          type="button"
          className="flex items-center gap-2 px-3 py-2 text-sm text-foreground hover:bg-accent rounded-md transition-colors"
          onClick={onNew}
        >
          <IconPlus size={14} />
          New Chat
        </button>
      </PopoverClose>
      {sessions.length > 0 && <div className="border-t border-border my-1" />}
      {loading ? (
        <div className="flex items-center justify-center py-3">
          <IconLoader2
            size={14}
            className="animate-spin text-muted-foreground"
          />
        </div>
      ) : sessions.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          No previous sessions
        </p>
      ) : (
        <div className="max-h-48 overflow-y-auto">
          {sessions.map((s) => (
            <PopoverClose key={s.id} asChild>
              <button
                type="button"
                className={`w-full text-left px-3 py-2 rounded-md transition-colors ${
                  s.id === activeSessionId
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-accent/50"
                }`}
                onClick={() => onSelect(s.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground truncate">
                    {formatRelativeTime(s.updatedAt)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {s.messageCount} msgs
                  </span>
                </div>
                {s.preview ? (
                  <p className="text-sm truncate mt-0.5">{s.preview}</p>
                ) : (
                  <p className="text-sm text-muted-foreground italic mt-0.5">
                    Empty session
                  </p>
                )}
              </button>
            </PopoverClose>
          ))}
        </div>
      )}
    </div>
  );
}
