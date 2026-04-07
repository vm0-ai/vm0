import { useGet, useSet, useLastLoadable } from "ccstate-react";
import {
  IconSearch,
  IconX,
  IconPlus,
  IconChevronRight,
  IconTrash,
} from "@tabler/icons-react";
import type { ChatThreadListItem } from "@vm0/core";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  Button,
} from "@vm0/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@vm0/ui/components/ui/dialog";
import { Skeleton } from "@vm0/ui/components/ui/skeleton";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  chatThreads$,
  deleteChatThread$,
} from "../../signals/zero-page/zero-chat.ts";
import {
  sidebarSearchOpen$,
  sidebarSearchTerm$,
  setSidebarSearchOpen$,
  setSidebarSearchTerm$,
  pendingDeleteThreadId$,
  setPendingDeleteThreadId$,
  sessionListCollapsed$,
  setSessionListCollapsed$,
} from "../../signals/zero-page/zero-sidebar-state.ts";
import type { SubagentInfo } from "./zero-sidebar-shared.tsx";
import { Link } from "../router/link.tsx";

function ChatThreadItem({
  session,
  isSelected,
  onSelect,
}: {
  session: ChatThreadListItem;
  isSelected: boolean;
  onSelect?: (id: string) => void;
}) {
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);

  function handleDeleteClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPendingDeleteThreadId(session.id);
  }

  return (
    <div className="group relative">
      <Link
        pathname="/chats/:id"
        options={{ pathParams: { id: session.id } }}
        onPointerDown={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey) {
            return;
          }
          e.preventDefault();
          onSelect?.(session.id);
        }}
        className={`flex h-8 items-center gap-2 rounded-lg p-2 text-left text-sm leading-5 transition-colors ${
          isSelected
            ? "bg-gray-200 text-gray-900 font-medium"
            : "text-sidebar-foreground hover:bg-sidebar-accent"
        }`}
      >
        <span className="truncate min-w-0 flex-1">
          {session.title ?? "New chat"}
        </span>
      </Link>
      <div className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center">
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onPointerDown={handleDeleteClick}
                className={`flex h-6 w-6 cursor-pointer items-center justify-center rounded-md invisible group-hover:visible transition-opacity duration-150 ${
                  isSelected
                    ? "text-slate-500 hover:text-slate-900 hover:bg-slate-300"
                    : "text-sidebar-foreground/80 hover:text-foreground hover:bg-sidebar-foreground/10"
                }`}
                aria-label="Delete chat"
              >
                <IconTrash size={12} stroke={2} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p className="text-xs">Delete chat</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

function RecentChatList({
  loading,
  error,
  sessions,
  searchTerm,
  selectedRecentId,
  onRecentSelect,
}: {
  loading: boolean;
  error: string | null;
  sessions: ChatThreadListItem[];
  searchTerm: string;
  selectedRecentId: string | null;
  onRecentSelect?: (id: string) => void;
}) {
  const pendingDeleteThreadId = useGet(pendingDeleteThreadId$);
  const setPendingDeleteThreadId = useSet(setPendingDeleteThreadId$);
  const setDelete = useSet(deleteChatThread$);
  const pageSignal = useGet(pageSignal$);

  function confirmDelete() {
    if (!pendingDeleteThreadId) {
      return;
    }
    const threadId = pendingDeleteThreadId;
    setPendingDeleteThreadId(null);
    detach(setDelete(threadId, pageSignal), Reason.DomCallback);
  }

  if (loading && sessions.length === 0) {
    return (
      <>
        {["w-3/4", "w-1/2", "w-2/3"].map((w) => {
          return (
            <div
              key={w}
              data-testid="sidebar-skeleton"
              className="flex h-8 items-center rounded-lg p-2"
            >
              <Skeleton className={`h-4 ${w}`} />
            </div>
          );
        })}
      </>
    );
  }
  if (error) {
    return (
      <p
        data-testid="chat-threads-error"
        className="px-2 py-2 text-xs text-destructive"
      >
        {error}
      </p>
    );
  }
  if (sessions.length === 0) {
    return (
      <p className="px-2 py-2 text-xs text-muted-foreground/70 leading-relaxed">
        {searchTerm.trim()
          ? "No chats match your search"
          : "Start a conversation and it'll show up here"}
      </p>
    );
  }
  return (
    <>
      {sessions.map((session) => {
        return (
          <ChatThreadItem
            key={session.id}
            session={session}
            isSelected={selectedRecentId === session.id}
            onSelect={onRecentSelect}
          />
        );
      })}
      <Dialog
        open={pendingDeleteThreadId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDeleteThreadId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              This will permanently delete this chat. This action cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onPointerDown={() => {
                setPendingDeleteThreadId(null);
              }}
            >
              Cancel
            </Button>
            <Button variant="destructive" onPointerDown={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function RecentChatSection({
  currentChatAgentId,
  displayName,
  subagents,
  selectedRecentId,
  onRecentSelect,
  onNewChat,
  newChatDisabled,
}: {
  currentChatAgentId: string | null;
  displayName: string;
  subagents: SubagentInfo[];
  selectedRecentId: string | null;
  onRecentSelect?: (id: string) => void;
  onNewChat?: (agentId: string | null) => void;
  newChatDisabled?: boolean;
}) {
  const recentSessionsLoadable = useLastLoadable(chatThreads$);
  const recentSessions =
    recentSessionsLoadable.state === "hasData"
      ? recentSessionsLoadable.data
      : [];
  const recentSessionsLoading = recentSessionsLoadable.state === "loading";
  const recentSessionsError =
    recentSessionsLoadable.state === "hasError"
      ? recentSessionsLoadable.error instanceof Error
        ? recentSessionsLoadable.error.message
        : "Failed to load chats"
      : null;
  const searchOpen = useGet(sidebarSearchOpen$);
  const setSearchOpen = useSet(setSidebarSearchOpen$);
  const searchTerm = useGet(sidebarSearchTerm$);
  const setSearchTerm = useSet(setSidebarSearchTerm$);
  const collapsed = useGet(sessionListCollapsed$);
  const setCollapsed = useSet(setSessionListCollapsed$);

  // Filter sessions by current agent
  const subagentIds = new Set(
    subagents.map((a) => {
      return a.id;
    }),
  );
  const agentSessions = currentChatAgentId
    ? recentSessions.filter((s) => {
        return s.agentId === currentChatAgentId;
      })
    : recentSessions.filter((s) => {
        return !subagentIds.has(s.agentId);
      });

  const matchedAgent = subagents.find((a) => {
    return a.id === currentChatAgentId;
  });
  const agentLabel = currentChatAgentId
    ? (matchedAgent?.displayName ?? matchedAgent?.id ?? displayName)
    : displayName;

  const trimmedTerm = searchTerm.trim().toLowerCase();
  const filteredSessions = trimmedTerm
    ? agentSessions.filter((s) => {
        return (s.title ?? "").toLowerCase().includes(trimmedTerm);
      })
    : agentSessions;

  const handleNewChat = onNewChat
    ? () => {
        onNewChat(currentChatAgentId ?? null);
      }
    : undefined;

  return (
    <div className="mt-4 flex flex-col">
      {searchOpen ? (
        <div
          className="shrink-0 flex h-8 items-center gap-2 rounded-lg bg-sidebar-accent/60 pl-2 pr-2 zero-border"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setSearchOpen(false);
            }
          }}
        >
          <IconSearch
            size={15}
            stroke={2.5}
            className="shrink-0 text-sidebar-foreground/50"
          />
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => {
              return setSearchTerm(e.target.value);
            }}
            placeholder={`Search chat with ${agentLabel}`}
            autoFocus
            className="flex-1 min-w-0 bg-transparent text-sm leading-5 text-sidebar-foreground placeholder:text-sidebar-foreground/50 focus:outline-none"
          />
          <div className="flex h-8 w-8 shrink-0 items-center justify-center">
            <button
              type="button"
              onPointerDown={() => {
                setSearchOpen(false);
              }}
              className="shrink-0 flex items-center justify-center h-5 w-5 rounded text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
              aria-label="Close search"
            >
              <IconX size={12} stroke={2} />
            </button>
          </div>
        </div>
      ) : (
        <div
          className="zero-nav-recent-label group flex h-8 shrink-0 cursor-pointer items-center justify-between rounded-lg pl-2 pr-0 hover:bg-sidebar-accent/50 transition-colors"
          onPointerDown={() => {
            return setCollapsed(!collapsed);
          }}
        >
          <span className="flex flex-1 items-center gap-1 truncate text-[13px] font-medium leading-4 text-sidebar-foreground/50 group-hover:text-sidebar-foreground transition-colors">
            Chats with {agentLabel}
            <span className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
              <IconChevronRight
                size={12}
                stroke={2}
                className={collapsed ? "" : "rotate-90"}
              />
            </span>
          </span>
          <div className="flex items-center gap-0.5">
            <TooltipProvider delayDuration={200}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSearchOpen(true);
                    }}
                    className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors"
                    aria-label="Search chats"
                  >
                    <IconSearch size={15} stroke={2.5} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <p className="text-xs">Search chats</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
            {handleNewChat && (
              <TooltipProvider delayDuration={200}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onPointerDown={(e) => {
                        e.stopPropagation();
                        handleNewChat();
                      }}
                      disabled={newChatDisabled}
                      className="relative z-10 flex h-8 w-8 items-center justify-center rounded-lg text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent transition-colors disabled:opacity-50 disabled:pointer-events-none"
                      aria-label={`New chat with ${agentLabel}`}
                    >
                      <IconPlus size={15} stroke={2.5} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    <p className="text-xs">New chat</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </div>
        </div>
      )}
      {!collapsed && (
        <div className="mt-1">
          <div className="flex flex-col gap-1">
            <RecentChatList
              loading={recentSessionsLoading}
              error={recentSessionsError}
              sessions={filteredSessions}
              searchTerm={searchTerm}
              selectedRecentId={selectedRecentId}
              onRecentSelect={onRecentSelect}
            />
          </div>
        </div>
      )}
    </div>
  );
}
