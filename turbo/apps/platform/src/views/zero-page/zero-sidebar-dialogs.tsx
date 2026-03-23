import { useState } from "react";
import { useGet, useSet } from "ccstate-react";
import {
  IconSearch,
  IconX,
  IconGripVertical,
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
  DialogHeader,
  DialogTitle,
  Button,
} from "@vm0/ui";
import {
  draftPinnedIds$,
  setDraftPinnedIds$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import { type SubagentInfo, AgentAvatarImg } from "./zero-sidebar-shared.tsx";

function SortablePinnedAgent({
  agent,
  onUnpin,
}: {
  agent: SubagentInfo;
  onUnpin: () => void;
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
      <button
        type="button"
        className="shrink-0 flex items-center justify-center cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground transition-colors touch-none"
        {...attributes}
        {...listeners}
      >
        <IconGripVertical size={14} />
      </button>
      <AgentAvatarImg
        name={agent.name}
        alt={agent.displayName ?? agent.name}
        className="h-8 w-8 shrink-0 rounded-lg object-cover object-top"
      />
      <span className="text-sm text-foreground flex-1 truncate">
        {agent.displayName ?? agent.name}
      </span>
      <button
        type="button"
        className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors p-1"
        onClick={onUnpin}
        aria-label={`Unpin ${agent.displayName ?? agent.name}`}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

export function ManagePinnedAgentsDialog({
  open,
  onOpenChange,
  zeroAvatarSrc,
  displayName,
  subagents,
  onPinnedIdsChange,
  saving = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saving?: boolean;
  zeroAvatarSrc: string;
  displayName: string;
  subagents: SubagentInfo[];
  onPinnedIdsChange: (ids: string[]) => void;
}) {
  const draftIds = useGet(draftPinnedIds$);
  const setDraftIds = useSet(setDraftPinnedIds$);

  const orderedPinned = draftIds
    .map((id) => subagents.find((a) => a.id === id))
    .filter((a): a is SubagentInfo => a !== undefined);

  const unpinned = subagents.filter((a) => !draftIds.includes(a.id));

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
      setDraftIds(draftIds.filter((id) => id !== agentId));
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
          <p className="text-sm text-muted-foreground mt-1">
            Reorder or add agents to your sidebar.
          </p>
        </DialogHeader>

        <div className="px-5 pb-1">
          <div className="flex items-center gap-2 px-1 py-2.5 rounded-lg">
            <img
              src={zeroAvatarSrc}
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
                items={orderedPinned.map((a) => a.id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="flex flex-col mt-1">
                  {orderedPinned.map((agent) => (
                    <SortablePinnedAgent
                      key={agent.id}
                      agent={agent}
                      onUnpin={() => togglePin(agent.id)}
                    />
                  ))}
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
              {unpinned.map((agent) => (
                <div
                  key={agent.id}
                  className="flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-accent transition-colors"
                >
                  <AgentAvatarImg
                    name={agent.name}
                    alt={agent.displayName ?? agent.name}
                    className="h-8 w-8 shrink-0 rounded-lg object-cover object-top opacity-60"
                  />
                  <span className="text-sm text-muted-foreground flex-1 truncate">
                    {agent.displayName ?? agent.name}
                  </span>
                  <button
                    type="button"
                    className="transition-colors px-2 py-0.5 rounded-md text-xs font-medium text-primary hover:text-primary/80 hover:bg-primary/10"
                    onClick={() => togglePin(agent.id)}
                  >
                    Pin
                  </button>
                </div>
              ))}
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
            onClick={() => onOpenChange(false)}
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

export function ChatListDialog({
  open,
  onOpenChange,
  zeroAvatarSrc,
  displayName,
  subagents,
  pinnedIds,
  onPinnedIdsChange,
  onNewChat,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  zeroAvatarSrc: string;
  displayName: string;
  subagents: SubagentInfo[];
  pinnedIds: string[];
  onPinnedIdsChange: (ids: string[]) => void;
  onNewChat?: (agent: { id: string; name: string } | null) => void;
}) {
  const [query, setQuery] = useState("");

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const pinned = pinnedIds
    .map((id) => subagents.find((a) => a.id === id))
    .filter((a): a is SubagentInfo => a !== undefined);

  const unpinned = subagents.filter((a) => !pinnedIds.includes(a.id));

  const trimmedQuery = query.trim().toLowerCase();
  const filteredPinned = trimmedQuery
    ? pinned.filter(
        (a) =>
          a.name.toLowerCase().includes(trimmedQuery) ||
          (a.displayName ?? "").toLowerCase().includes(trimmedQuery),
      )
    : pinned;
  const filteredUnpinned = trimmedQuery
    ? unpinned.filter(
        (a) =>
          a.name.toLowerCase().includes(trimmedQuery) ||
          (a.displayName ?? "").toLowerCase().includes(trimmedQuery),
      )
    : unpinned;
  const showLead =
    !trimmedQuery || displayName.toLowerCase().includes(trimmedQuery);

  const togglePin = (agentId: string) => {
    if (pinnedIds.includes(agentId)) {
      onPinnedIdsChange(pinnedIds.filter((id) => id !== agentId));
    } else {
      onPinnedIdsChange([...pinnedIds, agentId]);
    }
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
    onPinnedIdsChange(next);
  };

  const handleChat = (agent: { id: string; name: string } | null) => {
    onOpenChange(false);
    setQuery("");
    onNewChat?.(agent);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-base font-semibold">Talk to</DialogTitle>
          <p className="text-sm text-muted-foreground mt-1">
            Pick an agent to start a conversation.
          </p>
        </DialogHeader>

        {/* Search */}
        <div className="px-5 pb-3">
          <div
            className="flex items-center gap-2 h-8 rounded-lg pl-2 pr-1 bg-sidebar-accent/60"
            style={{ border: "0.7px solid hsl(var(--gray-400))" }}
          >
            <IconSearch
              size={15}
              stroke={2.5}
              className="shrink-0 text-muted-foreground/50"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents..."
              className="flex-1 min-w-0 bg-transparent text-sm leading-5 text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="shrink-0 flex h-5 w-5 items-center justify-center rounded text-muted-foreground/50 hover:text-foreground transition-colors"
              >
                <IconX size={12} stroke={2} />
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[400px] overflow-y-auto">
          {/* Lead agent */}
          {showLead && (
            <div className="px-5 pb-2">
              <span className="text-xs font-medium text-muted-foreground px-1">
                Lead
              </span>
              <button
                type="button"
                onClick={() => handleChat(null)}
                className="flex w-full items-center gap-2 px-1 py-2 rounded-lg hover:bg-accent transition-colors"
              >
                <img
                  src={zeroAvatarSrc}
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
                  items={filteredPinned.map((a) => a.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col mt-1">
                    {filteredPinned.map((agent) => (
                      <SortablePinnedAgent
                        key={agent.id}
                        agent={agent}
                        onUnpin={() => togglePin(agent.id)}
                      />
                    ))}
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
                {filteredUnpinned.map((agent) => (
                  <div
                    key={agent.id}
                    className="flex items-center gap-2 px-1 py-2 rounded-lg hover:bg-accent transition-colors group"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        handleChat({ id: agent.id, name: agent.name })
                      }
                      className="flex items-center gap-2 flex-1 min-w-0"
                    >
                      <AgentAvatarImg
                        name={agent.name}
                        alt={agent.displayName ?? agent.name}
                        className="h-8 w-8 shrink-0 rounded-lg object-cover object-top opacity-60"
                      />
                      <span className="text-sm text-muted-foreground truncate">
                        {agent.displayName ?? agent.name}
                      </span>
                    </button>
                    <TooltipProvider delayDuration={200}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="opacity-0 group-hover:opacity-100 transition-opacity duration-150 px-2 py-0.5 rounded-md text-xs font-medium text-primary hover:text-primary/80 hover:bg-primary/10"
                            onClick={() => togglePin(agent.id)}
                          >
                            Pin to sidebar
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="right">
                          <p className="text-xs">Pin to sidebar</p>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                ))}
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
