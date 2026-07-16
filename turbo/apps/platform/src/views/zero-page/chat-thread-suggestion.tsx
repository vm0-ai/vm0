import { cn, PopoverContent } from "@vm0/ui";
import type { ComposerChatThreadSuggestion } from "../../signals/zero-page/chat-thread-suggestion-domain.ts";
import { composerSuggestionCollisionPadding } from "./slash-workflow.tsx";

function chatThreadSuggestionOptionId(threadId: string): string {
  return `chat-thread-suggestion-option-${threadId}`;
}

export function scrollChatThreadSuggestionIntoView(
  chatThread: ComposerChatThreadSuggestion | undefined,
): void {
  if (!chatThread) {
    return;
  }

  window.requestAnimationFrame(() => {
    const option = document.getElementById(
      chatThreadSuggestionOptionId(chatThread.id),
    );
    if (option && typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

export function ChatThreadSuggestionMenu({
  chatThreads,
  selectedIndex,
  onSelect,
}: {
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
  readonly selectedIndex: number;
  readonly onSelect: (chatThread: ComposerChatThreadSuggestion) => void;
}) {
  return (
    <PopoverContent
      side="top"
      align="start"
      sideOffset={8}
      collisionPadding={composerSuggestionCollisionPadding()}
      updatePositionStrategy="always"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
      }}
      className="flex h-[min(16rem,var(--radix-popover-content-available-height))] w-[260px] max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden p-0 md:h-[min(20rem,var(--radix-popover-content-available-height))]"
      data-testid="chat-thread-suggestion-menu"
    >
      <div className="px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground">
        Chat threads
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {chatThreads.map((chatThread, index) => {
          const selected = index === selectedIndex;
          return (
            <button
              id={chatThreadSuggestionOptionId(chatThread.id)}
              key={chatThread.id}
              type="button"
              className={cn(
                "flex w-full items-center rounded px-2 py-1.5 text-left transition-colors",
                selected ? "bg-accent" : "hover:bg-accent/60",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(chatThread);
              }}
            >
              <span className="truncate text-sm text-popover-foreground">
                {chatThread.title}
              </span>
            </button>
          );
        })}
      </div>
    </PopoverContent>
  );
}
