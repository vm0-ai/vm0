import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconX,
  IconLoader2,
  IconSend,
  IconAlertCircle,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui/components/ui/button";
import { detach, Reason } from "../../signals/utils.ts";
import {
  collaborateMessages$,
  collaborateSending$,
  collaborateActiveRunId$,
  collaborateRunStatus$,
  allCollaborateRunEvents$,
  closeCollaboratePanel$,
  sendCollaborateMessage$,
  collaborateChatInput$,
  setCollaborateChatInput$,
  clearCollaborateChatInput$,
  type ChatMessage,
} from "../../signals/agent-detail/collaborate.ts";
import { isTerminalStatus } from "../../signals/agent-detail/polling.ts";
import { FormattedEventsView } from "../logs-page/log-detail/components/formatted-events-view.tsx";

function noop() {
  // intentional no-op for search interface
}

// ---------------------------------------------------------------------------
// CollaboratePanel
// ---------------------------------------------------------------------------

export function CollaboratePanel() {
  const messages = useGet(collaborateMessages$);
  const sending = useGet(collaborateSending$);
  const close = useSet(closeCollaboratePanel$);
  const send = useSet(sendCollaborateMessage$);
  const input = useGet(collaborateChatInput$);
  const setInputValue = useSet(setCollaborateChatInput$);
  const clearInput = useSet(clearCollaborateChatInput$);

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
    <div className="rounded-lg border border-border overflow-hidden flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border bg-card shrink-0">
        <span className="text-sm font-medium text-foreground">Collaborate</span>
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground"
          onClick={() => close()}
          aria-label="Close collaborate panel"
        >
          <IconX size={16} />
        </Button>
      </div>

      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 bg-muted/50">
        {messages.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <p className="text-sm text-muted-foreground">
              Send a message to start collaborating
            </p>
          </div>
        ) : (
          messages.map((msg, i) => (
            <ChatBubble
              key={msg.runId ?? `${msg.role}-${msg.content.slice(0, 32)}`}
              message={msg}
              isLast={i === messages.length - 1}
            />
          ))
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-border bg-card p-3 shrink-0">
        <div className="flex items-end gap-2">
          <textarea
            className="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            rows={2}
            placeholder="Type a message..."
            value={input}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
          />
          <Button
            size="sm"
            onClick={handleSend}
            disabled={!input.trim() || sending}
            className="shrink-0"
          >
            {sending ? (
              <IconLoader2 size={16} className="animate-spin" />
            ) : (
              <IconSend size={16} />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatBubble — renders a single user or assistant message
// ---------------------------------------------------------------------------

function ChatBubble({
  message,
  isLast,
}: {
  message: ChatMessage;
  isLast: boolean;
}) {
  if (message.role === "user") {
    return <UserBubble content={message.content} />;
  }
  return <AssistantBubble message={message} isLast={isLast} />;
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground whitespace-pre-wrap">
        {content}
      </div>
    </div>
  );
}

function AssistantBubble({
  message,
  isLast,
}: {
  message: ChatMessage;
  isLast: boolean;
}) {
  const activeRunId = useGet(collaborateActiveRunId$);
  const runStatus = useGet(collaborateRunStatus$);
  const eventsLoadable = useLastLoadable(allCollaborateRunEvents$);

  const events = eventsLoadable.state === "hasData" ? eventsLoadable.data : [];
  const isActiveRun = isLast && activeRunId !== null;
  const terminal = isTerminalStatus(runStatus);

  if (message.error) {
    return (
      <div className="flex items-start gap-2 text-sm text-destructive">
        <IconAlertCircle size={16} className="shrink-0 mt-0.5" />
        <span>{message.error}</span>
      </div>
    );
  }

  // Active run — show live events
  if (isActiveRun) {
    return (
      <div className="space-y-1">
        {!terminal && events.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <IconLoader2 size={14} className="animate-spin" />
            Thinking...
          </div>
        ) : (
          <FormattedEventsView
            events={events}
            searchTerm=""
            currentMatchIndex={-1}
            setTotalMatches={noop}
          />
        )}
        {message.status && <StatusLabel status={message.status} />}
      </div>
    );
  }

  // Completed run — show status only (events are no longer loaded for past turns)
  if (message.status) {
    return (
      <div className="space-y-1">
        <StatusLabel status={message.status} />
      </div>
    );
  }

  // Placeholder with no events yet
  if (message.content === "" && !message.runId) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <IconLoader2 size={14} className="animate-spin" />
        Starting...
      </div>
    );
  }

  return null;
}

function StatusLabel({ status }: { status: string }) {
  const colorClass = isTerminalStatus(status)
    ? status === "completed"
      ? "text-green-600"
      : "text-destructive"
    : "text-primary";

  return (
    <span className={`text-xs font-medium capitalize ${colorClass}`}>
      {status}
    </span>
  );
}
