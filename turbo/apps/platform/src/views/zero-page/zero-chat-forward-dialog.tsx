import { ArrowLeft, Loader2 } from "lucide-react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui";
import type { ComposerSignals } from "../../signals/zero-page/composer-signals.ts";
import type {
  ChatForwardComposerState,
  ChatForwardContext,
  ChatForwardSelection,
  ChatForwardTarget,
} from "../../signals/chat-page/chat-forward.ts";
import { createChatForwardComposerState$ } from "../../signals/chat-page/chat-forward-composer.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  subagents$,
} from "../../signals/agent.ts";
import {
  agentListDialogChatThreads$,
  rankAgentListDialogAgents,
} from "../../signals/zero-page/agent-list-dialog-chat-threads.ts";
import {
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { toast } from "@okouai/ui/components/ui/sonner";
import { ZeroChatComposer } from "./zero-chat-composer.tsx";
import { AgentAvatarImg } from "./zero-sidebar-shared.tsx";

function ForwardContent({ text }: { readonly text: string }) {
  const { t } = useTranslation();
  return (
    <div className="border-y border-border/60 bg-gray-50 px-5 py-4">
      <div className="mb-2 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.chat.forward.content;
        })}
      </div>
      <blockquote className="max-h-48 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-3 text-sm leading-6 text-foreground">
        {text}
      </blockquote>
    </div>
  );
}

function ForwardTargetContent({
  target,
}: {
  readonly target: ChatForwardTarget;
}) {
  const avatarAgentId = target.kind === "agent" ? target.id : target.agentId;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentAvatarImg
        name={avatarAgentId}
        alt=""
        className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
      />
      <span className="truncate text-sm text-foreground">{target.title}</span>
    </span>
  );
}

function ForwardTargetPicker({
  onSelect,
}: {
  readonly onSelect: (target: ChatForwardTarget) => void;
}) {
  const { t } = useTranslation();
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const defaultAgentName = useLastResolved(defaultAgentName$) ?? "Zero";
  const subagents = useLastResolved(subagents$) ?? [];
  const threadResult = useGet(agentListDialogChatThreads$);
  const normalizedQuery = query.trim().toLowerCase();
  const matchingAgents = rankAgentListDialogAgents(
    [
      ...(defaultAgentId
        ? [{ id: defaultAgentId, displayName: defaultAgentName }]
        : []),
      ...subagents,
    ],
    normalizedQuery,
  );
  const threads =
    threadResult.query === normalizedQuery ? threadResult.chatThreads : [];
  return (
    <Command shouldFilter={false} loop className="min-h-0">
      <div className="relative px-5 py-3">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          autoFocus
          placeholder={t(($) => {
            return $.chat.forward.search;
          })}
        />
      </div>
      <CommandList className="max-h-[min(40vh,320px)] px-5 pb-3">
        {matchingAgents.length > 0 ? (
          <CommandGroup
            heading={t(($) => {
              return $.chat.forward.agents;
            })}
          >
            {matchingAgents.map((agent) => {
              const title = agent.displayName ?? agent.id;
              return (
                <CommandItem
                  key={`agent-${agent.id}`}
                  value={`agent-${agent.id}`}
                  onSelect={() => {
                    onSelect({ kind: "agent", id: agent.id, title });
                  }}
                  className="px-1 py-2"
                >
                  <ForwardTargetContent
                    target={{ kind: "agent", id: agent.id, title }}
                  />
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {threads.length > 0 ? (
          <CommandGroup
            heading={t(($) => {
              return $.chat.forward.threads;
            })}
          >
            {threads.map((thread) => {
              const target: ChatForwardTarget = {
                kind: "thread",
                id: thread.id,
                agentId: thread.agentId,
                title: thread.title,
              };
              return (
                <CommandItem
                  key={`thread-${thread.id}`}
                  value={`thread-${thread.id}`}
                  onSelect={() => {
                    onSelect(target);
                  }}
                  className="px-1 py-2"
                >
                  <ForwardTargetContent target={target} />
                </CommandItem>
              );
            })}
          </CommandGroup>
        ) : null}
        {matchingAgents.length === 0 && threads.length === 0 ? (
          <p className="px-1 py-3 text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.forward.noResults;
            })}
          </p>
        ) : null}
      </CommandList>
    </Command>
  );
}

function createForwardContext(
  selection: ChatForwardSelection,
  sourceAgentId: string,
  sourceThreadTitle: string,
): ChatForwardContext {
  return {
    ...selection,
    agentId: sourceAgentId,
    titleSnapshot: sourceThreadTitle,
  };
}

function ForwardComposerSurface({
  composer,
}: {
  readonly composer: ComposerSignals;
}) {
  return (
    <div className="w-full min-w-0 px-5 pb-5 pt-4" data-chat-composer>
      <ZeroChatComposer signals={composer} showPendingItems={false} />
    </div>
  );
}

function ForwardComposer({
  state,
}: {
  readonly state: ChatForwardComposerState;
}) {
  const ready = useGet(state.ready$);
  const setLifecycleRef = useSet(state.setLifecycleRef$);
  return (
    <div ref={setLifecycleRef} className="min-w-0">
      {ready ? (
        <ForwardComposerSurface composer={state.composer} />
      ) : (
        <div className="flex min-h-40 items-center justify-center text-muted-foreground">
          <Loader2 size={16} className="animate-spin" aria-hidden />
        </div>
      )}
    </div>
  );
}

export function ChatForwardDialog({
  selection,
  composerState,
  sourceAgentId,
  sourceThreadTitle,
  onComposerStateChange,
  onDismiss,
}: {
  readonly selection: ChatForwardSelection;
  readonly composerState: ChatForwardComposerState | null;
  readonly sourceAgentId: string;
  readonly sourceThreadTitle: string;
  readonly onComposerStateChange: (
    composerState: ChatForwardComposerState | null,
  ) => void;
  readonly onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const createForwardComposerState = useSet(createChatForwardComposerState$);
  const target = composerState?.target ?? null;
  const handleTargetSelect = (nextTarget: ChatForwardTarget) => {
    const forward = createForwardContext(
      selection,
      sourceAgentId,
      sourceThreadTitle,
    );
    const onOptimisticSend = () => {
      onDismiss();
      toast.success(
        t(($) => {
          return $.chat.forward.sent;
        }),
      );
    };
    onComposerStateChange(
      createForwardComposerState(nextTarget, forward, onOptimisticSend),
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss();
        }
      }}
    >
      <DialogContent className="zero-app w-[calc(100vw-2rem)] gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogHeader className="px-5 pb-3 pt-5">
          <div className="flex items-center gap-2">
            {target ? (
              <button
                type="button"
                onClick={() => {
                  onComposerStateChange(null);
                }}
                className="-ml-2 inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-gray-50 hover:text-foreground"
                aria-label={t(($) => {
                  return $.chat.forward.back;
                })}
              >
                <ArrowLeft size={16} />
              </button>
            ) : null}
            <DialogTitle className="text-base font-semibold">
              {t(($) => {
                return $.chat.forward.title;
              })}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            {t(($) => {
              return $.chat.forward.description;
            })}
          </DialogDescription>
        </DialogHeader>
        {target ? null : <ForwardContent text={selection.quote} />}
        {target && composerState ? (
          <>
            <div className="flex items-center gap-2 px-5 pt-4 text-sm text-muted-foreground">
              <span>
                {t(($) => {
                  return $.chat.forward.to;
                })}
              </span>
              <ForwardTargetContent target={target} />
            </div>
            <ForwardComposer state={composerState} />
          </>
        ) : (
          <ForwardTargetPicker onSelect={handleTargetSelect} />
        )}
      </DialogContent>
    </Dialog>
  );
}
