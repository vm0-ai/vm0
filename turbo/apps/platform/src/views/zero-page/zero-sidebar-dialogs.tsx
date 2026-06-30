// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import type { ReactNode } from "react";
import { useGet, useSet, useLastResolved } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  IconSearch,
  IconX,
  IconArrowsMove,
  IconPin,
  IconPinnedOff,
} from "@tabler/icons-react";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
} from "@vm0/ui";
import {
  chatListQuery$,
  setChatListQuery$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import {
  defaultAgentId$,
  leadAgentAvatarUrl$,
  type SubagentInfo,
} from "../../signals/agent.ts";
import {
  pinnedAgentIds$,
  updatePinnedAgentIds$,
} from "../../signals/zero-page/zero-pinned-agents.ts";
import { unreadAgentIds$ } from "../../signals/chat-page/sidebar-unread-threads.ts";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { AgentAvatarImg, AvatarFromUrl } from "./zero-sidebar-shared.tsx";
import { AgentRowSideActions } from "./zero-sidebar-agent-row-actions.tsx";

export interface AgentDialogItem {
  readonly id: string;
  readonly displayName?: string | null;
}

function agentDialogLabel(agent: AgentDialogItem): string {
  return agent.displayName ?? agent.id;
}

export function agentDialogMatchesQuery(
  agent: AgentDialogItem,
  trimmedQuery: string,
): boolean {
  return (
    agent.id.toLowerCase().includes(trimmedQuery) ||
    (agent.displayName ?? "").toLowerCase().includes(trimmedQuery)
  );
}

export function AgentDialogSearch({
  query,
  setQuery,
}: {
  readonly query: string;
  readonly setQuery: (query: string) => void;
}) {
  return (
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
            className="absolute right-1.5 top-1/2 flex h-7 w-7 shrink-0 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Clear search"
          >
            <IconX size={14} stroke={2} />
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentDialogSection({
  label,
  children,
  className = "pb-2",
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <div className={`px-5 ${className}`}>
      <span className="px-1 text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="mt-1 flex flex-col">{children}</div>
    </div>
  );
}

export function AgentDialogAgentButton({
  agent,
  onSelect,
  avatar,
  subtitle,
}: {
  readonly agent: AgentDialogItem;
  readonly onSelect: () => void;
  readonly avatar?: ReactNode;
  readonly subtitle?: ReactNode;
}) {
  const label = agentDialogLabel(agent);
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex min-w-0 flex-1 items-center gap-2 text-left"
    >
      {avatar ?? (
        <AgentAvatarImg
          name={agent.id}
          alt={label}
          className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{label}</span>
        {subtitle ? (
          <span className="block truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function SortablePinnedAgent({
  agent,
  onUnpin,
  onChat,
  disabled,
  unreadIndicatorsEnabled,
  hasUnread,
}: {
  agent: SubagentInfo;
  onUnpin: () => void;
  onChat?: () => void;
  disabled?: boolean;
  unreadIndicatorsEnabled: boolean;
  hasUnread: boolean;
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
      className="group flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-accent"
    >
      {onChat ? (
        <AgentDialogAgentButton agent={agent} onSelect={onChat} />
      ) : (
        <>
          <AgentAvatarImg
            name={agent.id}
            alt={agent.displayName ?? agent.id}
            className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
          />
          <span className="min-w-0 flex-1 truncate text-sm text-foreground">
            {agent.displayName ?? agent.id}
          </span>
        </>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className="flex h-8 w-8 shrink-0 cursor-grab touch-none items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-colors duration-150 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-muted-foreground/12 hover:text-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-muted-foreground/18"
          aria-label={`Reorder ${agent.displayName ?? agent.id}`}
          disabled={disabled}
          {...attributes}
          {...listeners}
        >
          <IconArrowsMove size={16} stroke={2} />
        </button>
        <AgentRowSideActions
          hasUnread={unreadIndicatorsEnabled && hasUnread}
          action={{
            label: "Unpin",
            disabled,
            icon: <IconPinnedOff size={16} stroke={2} />,
            onSelect: onUnpin,
          }}
        />
      </div>
    </div>
  );
}

export function AgentListDialog({
  open,
  onOpenChange,
  displayName,
  subagents,
  onSelectChatAgent,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayName: string;
  subagents: SubagentInfo[];
  onSelectChatAgent?: (agentId: string | null) => void;
}) {
  const zeroAvatarUrl = useLastResolved(leadAgentAvatarUrl$) ?? null;
  const defaultAgentId = useLastResolved(defaultAgentId$);
  const query = useGet(chatListQuery$);
  const setQuery = useSet(setChatListQuery$);
  const pinnedIds = useLastResolved(pinnedAgentIds$) ?? [];
  const features = useGet(featureSwitch$);
  const unreadIndicatorsEnabled =
    features[FeatureSwitchKey.AgentUnreadIndicators] ?? false;
  const unreadAgentIds = useLastResolved(unreadAgentIds$);
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
        return agentDialogMatchesQuery(a, trimmedQuery);
      })
    : pinned;
  const filteredUnpinned = trimmedQuery
    ? unpinned.filter((a) => {
        return agentDialogMatchesQuery(a, trimmedQuery);
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
    onSelectChatAgent?.(agentId);
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

        <AgentDialogSearch query={query} setQuery={setQuery} />

        <div className="max-h-[min(520px,65vh)] overflow-y-auto">
          {/* Lead agent */}
          {showLead && (
            <AgentDialogSection label="Lead">
              <div className="flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-accent">
                <AgentDialogAgentButton
                  agent={{ id: "lead", displayName }}
                  onSelect={() => {
                    return handleChat(null);
                  }}
                  avatar={
                    <AvatarFromUrl
                      avatarUrl={zeroAvatarUrl}
                      alt={displayName}
                      className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
                    />
                  }
                  subtitle="Your lead assistant, always here for you"
                />
                {unreadIndicatorsEnabled && (
                  <AgentRowSideActions
                    hasUnread={
                      defaultAgentId
                        ? (unreadAgentIds?.has(defaultAgentId) ?? false)
                        : false
                    }
                  />
                )}
              </div>
            </AgentDialogSection>
          )}

          {/* Pinned agents */}
          {filteredPinned.length > 0 && (
            <AgentDialogSection label="Pinned">
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
                  <>
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
                          unreadIndicatorsEnabled={unreadIndicatorsEnabled}
                          hasUnread={unreadAgentIds?.has(agent.id) ?? false}
                        />
                      );
                    })}
                  </>
                </SortableContext>
              </DndContext>
            </AgentDialogSection>
          )}

          {/* Unpinned agents */}
          {filteredUnpinned.length > 0 && (
            <AgentDialogSection label="Others" className="pb-3">
              {filteredUnpinned.map((agent) => {
                return (
                  <div
                    key={agent.id}
                    className="group flex items-center gap-2 rounded-lg px-1 py-2 transition-colors hover:bg-accent"
                  >
                    <AgentDialogAgentButton
                      agent={agent}
                      onSelect={() => {
                        return handleChat(agent.id);
                      }}
                    />
                    <AgentRowSideActions
                      hasUnread={
                        unreadIndicatorsEnabled
                          ? (unreadAgentIds?.has(agent.id) ?? false)
                          : false
                      }
                      action={{
                        label: "Pin to sidebar",
                        disabled: saving,
                        icon: <IconPin size={16} stroke={2} />,
                        onSelect: () => {
                          return togglePin(agent.id);
                        },
                      }}
                    />
                  </div>
                );
              })}
            </AgentDialogSection>
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
