import { cn, PopoverContent } from "@vm0/ui";
import type { ComposerAgentSuggestion } from "../../signals/zero-page/composer-agent-suggestion-domain.ts";
import type { ComposerChatThreadSuggestion } from "../../signals/zero-page/chat-thread-suggestion-domain.ts";
import { composerSuggestionCollisionPadding } from "./slash-workflow.tsx";
import { AvatarFromUrl } from "./zero-sidebar-shared.tsx";

function scrollSelectedSuggestionIntoView(
  option: HTMLButtonElement | null,
): void {
  if (!option) {
    return;
  }
  window.requestAnimationFrame(() => {
    if (typeof option.scrollIntoView === "function") {
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

export function ComposerMentionSuggestionMenu({
  agents,
  chatThreads,
  selectedIndex,
  onSelectAgent,
  onSelectChatThread,
}: {
  readonly agents: readonly ComposerAgentSuggestion[];
  readonly chatThreads: readonly ComposerChatThreadSuggestion[];
  readonly selectedIndex: number;
  readonly onSelectAgent: (agent: ComposerAgentSuggestion) => void;
  readonly onSelectChatThread: (
    chatThread: ComposerChatThreadSuggestion,
  ) => void;
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
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {agents.length > 0 && (
          <>
            <div className="px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
              Agents
            </div>
            {agents.map((agent, index) => {
              const selected = index === selectedIndex;
              return (
                <button
                  key={agent.id}
                  ref={selected ? scrollSelectedSuggestionIntoView : undefined}
                  type="button"
                  className={cn(
                    "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left transition-colors",
                    selected ? "bg-accent" : "hover:bg-accent/60",
                  )}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelectAgent(agent);
                  }}
                >
                  <AvatarFromUrl
                    avatarUrl={agent.avatarUrl}
                    alt=""
                    className="h-5 w-5 shrink-0 rounded-full bg-muted"
                    size={20}
                  />
                  <span className="truncate text-sm text-popover-foreground">
                    {agent.name}
                  </span>
                </button>
              );
            })}
          </>
        )}
        {chatThreads.length > 0 && (
          <div className="px-1 pt-2 pb-1 text-xs font-medium text-muted-foreground">
            Chat threads
          </div>
        )}
        {chatThreads.map((chatThread, index) => {
          const selected = agents.length + index === selectedIndex;
          return (
            <button
              key={chatThread.id}
              ref={selected ? scrollSelectedSuggestionIntoView : undefined}
              type="button"
              className={cn(
                "flex w-full items-center rounded px-2 py-1.5 text-left transition-colors",
                selected ? "bg-accent" : "hover:bg-accent/60",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelectChatThread(chatThread);
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
