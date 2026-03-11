import { useCCState } from "ccstate-react/experimental";
import { useGet, useSet, useLoadable } from "ccstate-react";
import {
  IconSend,
  IconLoader2,
  IconAlertCircle,
  IconSparkles,
} from "@tabler/icons-react";
import { Button } from "@vm0/ui";
import { Markdown } from "../components/markdown.tsx";
import { StatusDot } from "../logs-page/components/status-dot.tsx";
import { detach, Reason } from "../../signals/utils.ts";
import { agentDisplayName$ } from "../../signals/zero-page/zero-agent-name.ts";
import {
  zeroChatMessages$,
  zeroChatSending$,
  zeroChatInput$,
  setZeroChatInput$,
  clearZeroChatInput$,
  sendZeroChatMessage$,
  type ZeroChatMessage,
} from "../../signals/zero-page/zero-chat.ts";

// ---------------------------------------------------------------------------
// Suggested prompts for welcome state
// ---------------------------------------------------------------------------

const SUGGESTED_PROMPTS = [
  "What can you help me with?",
  "Summarize my recent activity",
  "Set up a daily digest workflow",
  "Help me automate a task",
] as const;

// ---------------------------------------------------------------------------
// ZeroChatPage
// ---------------------------------------------------------------------------

interface ZeroChatPageProps {
  zeroAvatarSrc?: string;
  onAvatarClick?: () => void;
}

export function ZeroChatPage({
  zeroAvatarSrc = "/zero-avatar.png",
  onAvatarClick,
}: ZeroChatPageProps) {
  const agentNameLoadable = useLoadable(agentDisplayName$);
  const agentName =
    agentNameLoadable.state === "hasData" ? agentNameLoadable.data : "Zero";
  const messages = useGet(zeroChatMessages$);
  const sending = useGet(zeroChatSending$);
  const input = useGet(zeroChatInput$);
  const setInput = useSet(setZeroChatInput$);
  const clearInput = useSet(clearZeroChatInput$);
  const send = useSet(sendZeroChatMessage$);

  const messagesEndEl$ = useCCState<HTMLDivElement | null>(null);
  const messagesEndEl = useGet(messagesEndEl$);
  const setMessagesEndEl = useSet(messagesEndEl$);

  // Auto-scroll when messages change
  if (messagesEndEl && messages.length > 0) {
    messagesEndEl.scrollIntoView({ behavior: "smooth" });
  }

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

  const handleSuggestedPrompt = (prompt: string) => {
    clearInput();
    detach(send(prompt), Reason.DomCallback);
  };

  const hasMessages = messages.length > 0;

  return (
    <div className="flex flex-1 flex-col min-h-0">
      {hasMessages ? (
        /* Chat view — message list + input */
        <>
          <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4">
            <div className="mx-auto max-w-[720px] flex flex-col gap-1">
              {messages.map((msg) => (
                <ChatMessageRow key={msg.id} message={msg} />
              ))}
              <div ref={setMessagesEndEl} />
            </div>
          </div>
          <div className="shrink-0 px-4 sm:px-6 pb-4 sm:pb-6">
            <div className="mx-auto max-w-[720px]">
              <ChatInput
                input={input}
                sending={sending}
                onInputChange={setInput}
                onSend={handleSend}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${agentName}...`}
              />
            </div>
          </div>
        </>
      ) : (
        /* Welcome state — avatar, greeting, prompts, input */
        <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 pb-4">
          <div className="flex flex-col items-center gap-4 mb-8">
            <button
              type="button"
              onClick={onAvatarClick}
              className="rounded-full overflow-hidden h-16 w-16 transition-transform hover:scale-105"
            >
              <img
                src={zeroAvatarSrc}
                alt={agentName}
                className="h-full w-full object-cover"
              />
            </button>
            <div className="text-center">
              <h2 className="text-xl font-semibold text-foreground">
                {agentName}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Your AI assistant — ask me anything
              </p>
            </div>
          </div>

          <div className="w-full max-w-[720px] space-y-4">
            <ChatInput
              input={input}
              sending={sending}
              onInputChange={setInput}
              onSend={handleSend}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${agentName}...`}
            />

            <div className="flex flex-wrap gap-2 justify-center">
              {SUGGESTED_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => handleSuggestedPrompt(prompt)}
                  disabled={sending}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
                >
                  <IconSparkles size={12} />
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatInput
// ---------------------------------------------------------------------------

function ChatInput({
  input,
  sending,
  onInputChange,
  onSend,
  onKeyDown,
  placeholder,
}: {
  input: string;
  sending: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder: string;
}) {
  return (
    <div className="flex items-end gap-2 md:gap-2.5 rounded-xl border border-border bg-card p-3 md:p-4 shadow-sm">
      <textarea
        className="flex-1 resize-none bg-transparent text-sm text-secondary-foreground placeholder:text-muted-foreground focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        rows={2}
        placeholder={placeholder}
        value={input}
        onChange={(e) => onInputChange(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={sending}
      />
      <Button
        onClick={onSend}
        disabled={!input.trim() || sending}
        size="icon"
        className="shrink-0 rounded-lg h-9 w-9"
      >
        {sending ? (
          <IconLoader2 size={16} className="animate-spin" />
        ) : (
          <IconSend size={16} />
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat message components
// ---------------------------------------------------------------------------

function ChatMessageRow({ message }: { message: ZeroChatMessage }) {
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

function AssistantMessage({ message }: { message: ZeroChatMessage }) {
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

  return (
    <div className="py-2">
      <div className="flex gap-2 items-center">
        <StatusDot variant="pending" className="animate-pulse" />
        <span className="text-sm text-muted-foreground">Thinking...</span>
      </div>
    </div>
  );
}
