// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconSearch,
  IconX,
  IconArrowsMove,
  IconPin,
  IconLoader2,
  IconCrown,
} from "@tabler/icons-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Button,
} from "@vm0/ui";
import {
  chatListQuery$,
  draftPinnedIds$,
  setChatListQuery$,
  setDraftPinnedIds$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { leadAgentAvatarUrl$, type SubagentInfo } from "../../signals/agent.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg, AvatarFromUrl } from "./zero-sidebar-shared.tsx";

function SortablePinnedAgent({
  agent,
  onUnpin,
  onChat,
  disabled,
}: {
  agent: SubagentInfo;
  onUnpin: () => void;
  onChat?: () => void;
  disabled?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: agent.id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-accent transition-colors group"
    >
      {onChat ? (
        <button
          type="button"
          onClick={onChat}
          className="flex items-center gap-2 flex-1 min-w-0"
        >
          <AgentAvatarImg
            name={agent.id}
            alt={agent.displayName ?? agent.id}
            className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
          />
          <span className="text-sm text-foreground truncate">
            {agent.displayName ?? agent.id}
          </span>
        </button>
      ) : (
        <>
          <AgentAvatarImg
            name={agent.id}
            alt={agent.displayName ?? agent.id}
            className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
          />
          <span className="text-sm text-foreground min-w-0 flex-1 truncate">
            {agent.displayName ?? agent.id}
          </span>
        </>
      )}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          className="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg cursor-grab active:cursor-grabbing touch-none text-muted-foreground transition-colors hover:bg-muted-foreground/12 hover:text-foreground dark:hover:bg-muted-foreground/18 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={`Reorder ${agent.displayName ?? agent.id}`}
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <IconArrowsMove size={16} stroke={2} />
        </button>
        <button
          type="button"
          className="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted-foreground/12 hover:text-foreground dark:hover:bg-muted-foreground/18 disabled:cursor-not-allowed disabled:opacity-50"
          onClick={onUnpin}
          aria-label={`Unpin ${agent.displayName ?? agent.id}`}
          disabled={disabled}
        >
          <IconX size={16} stroke={2} />
        </button>
      </div>
    </div>
  );
}

export function ManagePinnedAgentsDialog({
  open,
  onOpenChange,
  displayName,
  subagents,
  onPinnedIdsChange,
  saving = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saving?: boolean;
  displayName: string;
  subagents: SubagentInfo[];
  onPinnedIdsChange: (ids: string[]) => void;
}) {
  const zeroAvatarUrl = useLastResolved(leadAgentAvatarUrl$) ?? null;
  const draftIds = useGet(draftPinnedIds$);
  const setDraftIds = useSet(setDraftPinnedIds$);

  const orderedPinned = draftIds
    .map((id) => {
      return subagents.find((a) => {
        return a.id === id;
      });
    })
    .filter((a): a is SubagentInfo => {
      return a !== undefined;
    });

  const unpinned = subagents.filter((a) => {
    return !draftIds.includes(a.id);
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const oldIndex = draftIds.indexOf(String(active.id));
    const newIndex = draftIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }
    const next = [...draftIds];
    next.splice(oldIndex, 1);
    next.splice(newIndex, 0, draftIds[oldIndex]!);
    setDraftIds(next);
  };

  const togglePin = (agentId: string) => {
    if (draftIds.includes(agentId)) {
      setDraftIds(
        draftIds.filter((id) => {
          return id !== agentId;
        }),
      );
    } else {
      setDraftIds([...draftIds, agentId]);
    }
  };

  const handleSave = () => {
    onPinnedIdsChange(draftIds);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2">
            <DialogTitle className="text-base font-semibold">
              Manage pinned agents
            </DialogTitle>
            {saving && (
              <IconLoader2
                size={14}
                className="animate-spin text-muted-foreground"
              />
            )}
          </div>
          <DialogDescription className="text-sm text-muted-foreground mt-1">
            Reorder or add agents to your sidebar.
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 pb-1">
          <div className="flex items-center gap-2 px-1 py-2.5 rounded-lg">
            <AvatarFromUrl
              avatarUrl={zeroAvatarUrl}
              alt={displayName}
              className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
            />
            <span className="text-sm font-medium text-foreground flex-1 truncate">
              {displayName}
            </span>
            <span className="zero-pill inline-flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-xs font-medium bg-background">
              <IconCrown
                size={12}
                stroke={1.8}
                className="shrink-0 text-amber-500 dark:text-amber-400"
              />
              Lead
            </span>
          </div>
        </div>

        {orderedPinned.length > 0 && (
          <div className="px-5 pb-1">
            <span className="text-xs font-medium text-muted-foreground px-1">
              Pinned
            </span>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={orderedPinned.map((a) => {
                  return a.id;
                })}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col mt-1">
                  {orderedPinned.map((agent) => {
                    return (
                      <SortablePinnedAgent
                        key={agent.id}
                        agent={agent}
                        onUnpin={() => {
                          return togglePin(agent.id);
                        }}
                      />
                    );
                  })}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}

        {unpinned.length > 0 && (
          <div className="px-5 pb-5">
            <span className="text-xs font-medium text-muted-foreground px-1">
              Available agents
            </span>
            <div className="flex flex-col mt-1">
              {unpinned.map((agent) => {
                return (
                  <div
                    key={agent.id}
                    className="group flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-accent transition-colors"
                  >
                    <AgentAvatarImg
                      name={agent.id}
                      alt={agent.displayName ?? agent.id}
                      className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
                    />
                    <span className="text-sm text-foreground flex-1 truncate">
                      {agent.displayName ?? agent.id}
                    </span>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-muted-foreground/12 hover:text-foreground dark:hover:bg-muted-foreground/18"
                            onClick={() => {
                              return togglePin(agent.id);
                            }}
                            aria-label="Pin to sidebar"
                          >
                            <IconPin size={16} stroke={2} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p className="text-xs">Pin to sidebar</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {subagents.length === 0 && (
          <div className="px-5 pb-5">
            <p className="text-xs text-muted-foreground px-1 py-2">
              No sub-agents available yet.
            </p>
          </div>
        )}

        <div className="px-5 pb-5 pt-2 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="zero-btn-morandi"
            onClick={() => {
              return onOpenChange(false);
            }}
          >
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving\u2026" : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function AgentListDialog({
  open,
  onOpenChange,
  displayName,
  subagents,
  onNewChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  subagents: SubagentInfo[];
  onNewChat?: (agentId: string | null) => void;
}) {
  const zeroAvatarUrl = useLastResolved(leadAgentAvatarUrl$) ?? null;
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const pageSignal = useGet(pageSignal$);
  const [pinLoadable, savePinnedIds] = useLoadableSet(updatePinnedAgentIds$);
  const saving = pinLoadable.state === "loading";

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const pinned = pinnedIds
    .map((id) => {
      return subagents.find((a) => {
        return a.id === id;
      });
    })
    .filter((a): a is SubagentInfo => {
      return a !== undefined;
    });

  const unpinned = subagents.filter((a) => {
    return !pinnedIds.includes(a.id);
  });

  const trimmedQuery = query.trim().toLowerCase();
  const filteredPinned = trimmedQuery
    ? pinned.filter((a) => {
        return (
          a.id.toLowerCase().includes(trimmedQuery) ||
          (a.displayName ?? "").toLowerCase().includes(trimmedQuery)
        );
      })
    : pinned;
  const filteredUnpinned = trimmedQuery
    ? unpinned.filter((a) => {
        return (
          a.id.toLowerCase().includes(trimmedQuery) ||
          (a.displayName ?? "").toLowerCase().includes(trimmedQuery)
        );
      })
    : unpinned;
  const showLead =
    !trimmedQuery || displayName.toLowerCase().includes(trimmedQuery);

  const togglePin = (agentId: string) => {
    const next = pinnedIds.includes(agentId)
      ? pinnedIds.filter((id) => {
          return id !== agentId;
        })
      : [...pinnedIds, agentId];
    detach(savePinnedIds(next, pageSignal), Reason.DomCallback);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const oldIndex = pinnedIds.indexOf(String(active.id));
    const newIndex = pinnedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) {
      return;
    }
    const next = [...pinnedIds];
    next.splice(oldIndex, 1);
    next.splice(newIndex, 0, pinnedIds[oldIndex]!);
    detach(savePinnedIds(next, pageSignal), Reason.DomCallback);
  };

  const handleChat = (agentId: string | null) => {
    onOpenChange(false);
    setQuery("");
    onNewChat?.(agentId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="zero-app sm:max-w-xl w-[calc(100vw-2rem)] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base font-semibold">Talk to</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground mt-1">
            Pick an agent to start a conversation.
          </DialogDescription>
        </DialogHeader>

        {/* Search */}
        <div className="px-5 pb-3">
          <div className="relative w-full">
            <IconSearch
              size={16}
              stroke={2}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="text"
              value={query}
              onChange={(e) => {
                return setQuery(e.target.value);
              }}
              placeholder="Search agents..."
              className={`pl-9 ${query ? "pr-9" : ""}`}
            />
            {query && (
              <button
                type="button"
                onClick={() => {
                  return setQuery("");
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label="Clear search"
              >
                <IconX size={14} stroke={2} />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[min(520px,65vh)] overflow-y-auto">
          {/* Lead agent */}
          {showLead && (
            <div className="px-5 pb-2">
              <span className="text-xs font-medium text-muted-foreground px-1">
                Lead
              </span>
              <button
                type="button"
                onClick={() => {
                  return handleChat(null);
                }}
                className="flex w-full items-center gap-2 px-1 py-2 rounded-lg hover:bg-accent transition-colors"
              >
                <AvatarFromUrl
                  avatarUrl={zeroAvatarUrl}
                  alt={displayName}
                  className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
                />
                <div className="flex-1 min-w-0 text-left">
                  <span className="text-sm font-medium text-foreground truncate block">
                    {displayName}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    Your lead assistant, always here for you
                  </span>
                </div>
              </button>
            </div>
          )}

          {/* Pinned agents */}
          {filteredPinned.length > 0 && (
            <div className="px-5 pb-2">
              <span className="text-xs font-medium text-muted-foreground px-1">
                Pinned
              </span>
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={filteredPinned.map((a) => {
                    return a.id;
                  })}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col mt-1">
                    {filteredPinned.map((agent) => {
                      return (
                        <SortablePinnedAgent
                          key={agent.id}
                          agent={agent}
                          onUnpin={() => {
                            return togglePin(agent.id);
                          }}
                          onChat={() => {
                            return handleChat(agent.id);
                          }}
                          disabled={saving}
                        />
                      );
                    })}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          )}

          {/* Unpinned agents */}
          {filteredUnpinned.length > 0 && (
            <div className="px-5 pb-3">
              <span className="text-xs font-medium text-muted-foreground px-1">
                Others
              </span>
              <div className="flex flex-col mt-1">
                {filteredUnpinned.map((agent) => {
                  return (
                    <div
                      key={agent.id}
                      className="flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-accent transition-colors group"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          return handleChat(agent.id);
                        }}
                        className="flex items-center gap-2 flex-1 min-w-0"
                      >
                        <AgentAvatarImg
                          name={agent.id}
                          alt={agent.displayName ?? agent.id}
                          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
                        />
                        <span className="text-sm text-foreground truncate">
                          {agent.displayName ?? agent.id}
                        </span>
                      </button>
                      <TooltipProvider delayDuration={200}>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-all duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-muted-foreground/12 hover:text-foreground dark:hover:bg-muted-foreground/18 disabled:cursor-not-allowed disabled:opacity-50"
                              onClick={() => {
                                return togglePin(agent.id);
                              }}
                              aria-label="Pin to sidebar"
                              disabled={saving}
                            >
                              <IconPin size={16} stroke={2} />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            <p className="text-xs">Pin to sidebar</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {subagents.length === 0 && (
            <div className="px-5 pb-5">
              <p className="text-xs text-muted-foreground px-1 py-2">
                No sub-agents available yet.
              </p>
            </div>
          )}

          {trimmedQuery &&
            !showLead &&
            filteredPinned.length === 0 &&
            filteredUnpinned.length === 0 && (
              <div className="px-5 pb-5">
                <p className="text-xs text-muted-foreground px-1 py-2">
                  No agents found
                </p>
              </div>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
